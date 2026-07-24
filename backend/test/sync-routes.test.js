'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');
const { createSyncRouter } = require('../routes/sync');

async function withServer(service, callback) {
    const requireToken = (req, res, next) => {
        if (req.get('x-sync-token') !== 'valid-token') {
            return res.status(401).json({ success: false, code: 'sync_auth_failed' });
        }
        return next();
    };
    const upload = { single: () => (req, res, next) => next() };
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.requestId = 'request-sync-0001';
        next();
    });
    app.use('/api/sync', createSyncRouter({ service, requireToken, upload }));
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

test('同步 Router 不回传节点凭据且只读取一次同步状态', async () => {
    let stateReads = 0;
    const service = {
        loadNodes: () => [{ name: 'node-a', url: 'https://node-a.internal', authToken: 'secret' }],
        loadSyncState: () => {
            stateReads += 1;
            return { 'node-a': { lastPushAt: '2026-07-10T00:00:00.000Z' } };
        },
        checkNodeHealth: async () => ({ healthy: true }),
    };
    await withServer(service, async baseUrl => {
        const response = await fetch(`${baseUrl}/api/sync/nodes`);
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(stateReads, 1);
        assert.equal(body.data[0].authToken, undefined);
        assert.equal(body.data[0].lastSyncAt, '2026-07-10T00:00:00.000Z');
    });
});

test('同步接收 Router 强制机器凭据并校验报告负载', async () => {
    let received = null;
    const service = {
        receiveReport: (reportId, reportData, source) => {
            received = { reportId, reportData, source };
            return { stored: true };
        },
    };
    await withServer(service, async baseUrl => {
        assert.equal((await fetch(`${baseUrl}/api/sync/receive/report`, { method: 'POST' })).status, 401);

        const invalid = await fetch(`${baseUrl}/api/sync/receive/report`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-sync-token': 'valid-token' },
            body: '{}',
        });
        assert.equal(invalid.status, 400);
        const invalidBody = await invalid.json();
        assert.equal(invalidBody.code, 'sync_payload_invalid');
        assert.equal(invalidBody.requestId, 'request-sync-0001');

        const valid = await fetch(`${baseUrl}/api/sync/receive/report`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-sync-token': 'valid-token' },
            body: JSON.stringify({ reportId: 'r-1', reportData: { status: 'done' }, source: 'node-a' }),
        });
        assert.equal(valid.status, 200);
        assert.deepEqual(received, {
            reportId: 'r-1', reportData: { status: 'done' }, source: 'node-a',
        });
    });
});
