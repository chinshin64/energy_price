'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');
const { createLocationRouter } = require('../routes/location');
const { createSignatureRouter } = require('../routes/signature');

async function withServer(routerPath, router, callback) {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.requestId = 'request-test-0001';
        next();
    });
    app.use(routerPath, router);
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

test('定位 Router 保持状态、写入和错误契约', async () => {
    const calls = [];
    const simulator = {
        setSimulatedLocation(input) {
            calls.push(input);
            if (!input.city) throw new Error('city is required');
            return { success: true, mode: 'desktop-city-search', city: input.city };
        },
        clickAuthorizeButton(input) {
            return { success: true, windowId: input };
        },
        getStatus() {
            return { available: true };
        },
    };
    await withServer('/api/location', createLocationRouter({ simulator }), async baseUrl => {
        const response = await fetch(`${baseUrl}/api/location/simulate`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ city: '西安', lat: 34.34, lng: 108.94 }),
        });
        assert.equal(response.status, 200);
        assert.equal((await response.json()).data.city, '西安');
        assert.deepEqual(calls[0], {
            city: '西安', lat: 34.34, lng: 108.94, windowId: undefined, windowBounds: undefined,
        });

        const invalid = await fetch(`${baseUrl}/api/location/simulate`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
        });
        assert.equal(invalid.status, 400);
        assert.equal((await invalid.json()).requestId, 'request-test-0001');
    });
});

test('签名 Router 提供汇总、404 与刷新限流状态', async () => {
    const healthMonitor = {
        checkAllPlatforms: () => [{ id: 'a', status: 'green' }, { id: 'b', status: 'red' }],
        getPlatformStatus: platform => platform === 'a' ? { id: 'a', status: 'green' } : null,
        cleanupExpiredEntries: () => ({ removed: 2 }),
        markExpiredEntries: () => ({ marked: 1 }),
    };
    const refreshService = {
        refresh: async () => ({ success: false, code: 'rate_limited' }),
        getStatus: () => ({ running: false }),
    };
    const router = createSignatureRouter({ healthMonitor, refreshService });
    await withServer('/api/signature', router, async baseUrl => {
        const health = await fetch(`${baseUrl}/api/signature/health`);
        const healthBody = await health.json();
        assert.deepEqual(healthBody.summary, { green: 1, yellow: 0, red: 1 });

        assert.equal((await fetch(`${baseUrl}/api/signature/status/missing`)).status, 404);
        assert.equal((await fetch(`${baseUrl}/api/signature/refresh/a`, { method: 'POST' })).status, 429);
    });
});
