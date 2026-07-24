'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');
const { createAuditRouter } = require('../routes/audit');
const { createGlobalAgentRouter } = require('../routes/global-agent');
const { createTestChainsRouter } = require('../routes/test-chains');

async function withApp(configure, callback) {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.requestId = 'request-agent-0001';
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

test('三链路 Router 保留状态、运行查询与稳定错误原因', async () => {
    const orchestrator = {
        getStatus: async query => ({ success: true, query }),
        run: async () => { throw new Error('runner failed'); },
        getRun: id => id === 'known' ? { id } : null,
        stopRun: id => ({ success: id === 'known' }),
        diagnose: async () => ({ success: true }),
    };
    await withApp(app => app.use('/api/test-chains', createTestChainsRouter({ orchestrator })), async baseUrl => {
        assert.equal((await fetch(`${baseUrl}/api/test-chains/status?city=西安`)).status, 200);
        const missing = await fetch(`${baseUrl}/api/test-chains/runs/missing`);
        assert.equal(missing.status, 404);
        assert.equal((await missing.json()).code, 'run_not_found');

        const failed = await fetch(`${baseUrl}/api/test-chains/run`, { method: 'POST' });
        assert.equal(failed.status, 500);
        const failedBody = await failed.json();
        assert.equal(failedBody.reason, 'test_chain_run_failed');
        assert.equal(failedBody.requestId, 'request-agent-0001');
    });
});

test('全局 Agent Router 只允许预设模型并刷新运行时配置', async () => {
    let saved = null;
    let refreshed = 0;
    const service = {
        getStatus: () => ({ success: true, mode: 'dry_run' }),
        chat: async () => ({ success: false, reason: 'model_not_configured' }),
        plan: async () => ({ success: true }),
        execute: async () => ({ success: true }),
    };
    const router = createGlobalAgentRouter({
        service,
        modelPresets: [{ id: 'glm-5.1' }],
        appSettingModel: {
            saveAiAgentSettings: value => { saved = value; },
        },
        refreshRuntimeConfig: () => { refreshed += 1; },
        getSettingsResponse: () => ({ modelId: 'glm-5.1' }),
    });
    await withApp(app => app.use('/api/global-agent', router), async baseUrl => {
        const invalid = await fetch(`${baseUrl}/api/global-agent/model`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ modelId: 'unknown' }),
        });
        assert.equal(invalid.status, 400);
        assert.equal((await invalid.json()).code, 'invalid_agent_model');

        const valid = await fetch(`${baseUrl}/api/global-agent/model`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ modelId: 'glm-5.1' }),
        });
        assert.equal(valid.status, 200);
        assert.deepEqual(saved, { modelId: 'glm-5.1', keepApiKey: true });
        assert.equal(refreshed, 1);

        assert.equal((await fetch(`${baseUrl}/api/global-agent/chat`, { method: 'POST' })).status, 400);
    });
});

test('审计 Router 透传受控筛选字段', async () => {
    let filters = null;
    const router = createAuditRouter({
        model: {
            list: value => {
                filters = value;
                return [];
            },
        },
    });
    await withApp(app => app.use('/api/audit', router), async baseUrl => {
        const response = await fetch(`${baseUrl}/api/audit/events?actorId=user-1&resource=report&limit=20`);
        assert.equal(response.status, 200);
        assert.equal(filters.actorId, 'user-1');
        assert.equal(filters.resource, 'report');
        assert.equal(filters.limit, '20');
    });
});
