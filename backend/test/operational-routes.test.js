'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');
const { createCaptureRecorderRouter } = require('../routes/capture-recorder');
const { createOutboundRouter } = require('../routes/outbound');
const { createSettingsRouter } = require('../routes/settings');

async function withApp(configure, callback) {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.requestId = 'request-test-0002';
        next();
    });
    configure(app);
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
    });
    try {
        await callback(`http://127.0.0.1:${server.address().port}`);
    } finally {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
}

test('系统设置 Router 校验网络协议并刷新 Agent 运行时配置', async () => {
    let savedProxy = null;
    let savedAgent = null;
    let refreshCount = 0;
    const appSettingModel = {
        getProxySettings: () => ({ enabled: false }),
        publicProxySettings: value => value,
        saveProxySettings: value => {
            savedProxy = value;
            return value;
        },
        saveAiAgentSettings: value => {
            savedAgent = value;
        },
    };
    const router = createSettingsRouter({
        appSettingModel,
        getAiAgentSettingsResponse: () => ({ modelId: 'glm-5.1' }),
        refreshAiAgentRuntimeConfig: () => { refreshCount += 1; },
        modelPresets: [{ id: 'glm-5.1' }],
    });

    await withApp(app => app.use('/api/settings', router), async baseUrl => {
        const invalid = await fetch(`${baseUrl}/api/settings/network`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ enabled: true, defaultProxyUrl: 'file:///tmp/proxy' }),
        });
        assert.equal(invalid.status, 400);
        assert.deepEqual(
            (({ code, requestId }) => ({ code, requestId }))(await invalid.json()),
            { code: 'network_settings_invalid', requestId: 'request-test-0002' }
        );

        const valid = await fetch(`${baseUrl}/api/settings/network`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ enabled: true, defaultProxyUrl: 'socks5://127.0.0.1:1080' }),
        });
        assert.equal(valid.status, 200);
        assert.equal(savedProxy.defaultProxyUrl, 'socks5://127.0.0.1:1080');

        const agent = await fetch(`${baseUrl}/api/settings/ai-agent`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ modelId: 'glm-5.1' }),
        });
        assert.equal(agent.status, 200);
        assert.deepEqual(savedAgent, { modelId: 'glm-5.1' });
        assert.equal(refreshCount, 1);
    });
});

test('出口与请求记录 Router 对查询上限和服务错误保持稳定契约', async () => {
    const limits = [];
    const outboundRouter = createOutboundRouter({
        client: {
            getStatus: limit => {
                limits.push(limit);
                return { limit };
            },
            getRecentEvidence: limit => {
                limits.push(limit);
                return [];
            },
        },
    });
    const busy = new Error('capture already running');
    busy.statusCode = 409;
    busy.code = 'capture_busy';
    const captureRouter = createCaptureRecorderRouter({
        service: {
            getStatus: () => ({ running: false }),
            startSession: () => { throw busy; },
            stopSession: () => ({ stopped: true }),
        },
    });

    await withApp(app => {
        app.use('/api/outbound', outboundRouter);
        app.use('/api/capture-recorder', captureRouter);
    }, async baseUrl => {
        assert.equal((await fetch(`${baseUrl}/api/outbound/status?limit=9999`)).status, 200);
        assert.equal((await fetch(`${baseUrl}/api/outbound/evidence/recent?limit=-5`)).status, 200);
        assert.deepEqual(limits, [200, 1]);

        const response = await fetch(`${baseUrl}/api/capture-recorder/start`, { method: 'POST' });
        assert.equal(response.status, 409);
        const body = await response.json();
        assert.equal(body.code, 'capture_busy');
        assert.equal(body.requestId, 'request-test-0002');
    });
});
