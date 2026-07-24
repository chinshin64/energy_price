'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');
const { createMethod1Router } = require('../routes/method1');

async function withApp(service, callback) {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.requestId = 'request-method1-route-0001';
        next();
    });
    app.use('/api/method1', createMethod1Router({ service }));
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

test('方式一 Router 保留状态、基础检查和动作参数契约', async () => {
    const calls = [];
    const service = {
        getStatus: async payload => {
            calls.push(['status', payload]);
            return { success: true, payload };
        },
        runBasicCheck: async payload => {
            calls.push(['basic', payload]);
            return { success: true, payload };
        },
        switchCityAction: async payload => {
            calls.push(['switch-city', payload]);
            return { success: true, payload };
        },
        tapByTextAction: async payload => {
            calls.push(['tap-by-text', payload]);
            return { success: true, payload };
        }
    };

    await withApp(service, async baseUrl => {
        const status = await (await fetch(`${baseUrl}/api/method1/status?platformId=amap-charging`)).json();
        assert.deepEqual(status.payload, { platform: 'amap-charging' });

        const basic = await (await fetch(`${baseUrl}/api/method1/run-basic-check`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ city: '西安', targetCity: '北京', maxScrolls: 3 })
        })).json();
        assert.deepEqual(basic.payload, {
            platform: 'didi-charging',
            city: '西安',
            targetCity: '北京',
            maxScrolls: 3
        });

        const switchCity = await (await fetch(`${baseUrl}/api/method1/actions/switch-city`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ platformId: 'teld', targetCity: '深圳' })
        })).json();
        assert.equal(switchCity.payload.platform, 'teld');
        assert.equal(switchCity.payload.city, '深圳');

        const tap = await (await fetch(`${baseUrl}/api/method1/actions/tap-by-text`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: '暂不登录' })
        })).json();
        assert.equal(tap.payload.platform, 'didi-charging');
        assert.equal(tap.payload.text, '暂不登录');
    });

    assert.deepEqual(calls.map(item => item[0]), ['status', 'basic', 'switch-city', 'tap-by-text']);
});

test('方式一 Router 保留能力受限时的稳定失败响应', async () => {
    const service = {
        getStatus: async () => {
            const error = new Error('WeChat is not running');
            error.reason = 'wechat_not_running';
            throw error;
        },
        getWorkflowReadiness: async () => {
            const error = new Error('window missing');
            error.reason = 'target_window_missing';
            throw error;
        },
        runBasicCheck: async () => {
            const error = new Error('input denied');
            error.reason = 'input_permission_denied';
            throw error;
        },
        runAdaptive: async () => {
            const error = new Error('unknown page');
            error.reason = 'page_not_recognized';
            throw error;
        }
    };

    await withApp(service, async baseUrl => {
        const statusResponse = await fetch(`${baseUrl}/api/method1/status`);
        assert.equal(statusResponse.status, 200);
        const status = await statusResponse.json();
        assert.equal(status.success, false);
        assert.equal(status.available, false);
        assert.equal(status.reason, 'wechat_not_running');
        assert.deepEqual(status.checks, {});

        const workflow = await (await fetch(`${baseUrl}/api/method1/workflow`)).json();
        assert.equal(workflow.stage, 'diagnose');
        assert.equal(workflow.diagnostics[0].component, 'method1');
        assert.equal(workflow.reason, 'target_window_missing');

        const basic = await (await fetch(`${baseUrl}/api/method1/run-basic-check`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}'
        })).json();
        assert.equal(basic.scroll.status, 'unavailable');
        assert.equal(basic.scroll.reason, 'input_permission_denied');

        const adaptive = await (await fetch(`${baseUrl}/api/method1/actions/run-adaptive`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}'
        })).json();
        assert.equal(adaptive.reason, 'page_not_recognized');
        assert.deepEqual(adaptive.summary, {});
        assert.deepEqual(adaptive.actionTrace, []);
    });
});
