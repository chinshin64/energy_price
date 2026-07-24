'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');
const { createMobileControlRouter } = require('../routes/mobile-control');
const { createMobileSyncRouter } = require('../routes/mobile-sync');

async function withApp(configure, callback) {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.requestId = 'request-mobile-route-0001';
        req.auth = { subject: 'operator-1', mode: 'oidc' };
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

test('移动同步 Router 返回公开配置并在数据回传后推进工作流', async () => {
    let advances = 0;
    let supervisorCalls = 0;
    const receivedPayloads = [];
    const syncService = {
        getClientConfig: () => ({ enabled: true }),
        ingestOcrPayload: payload => { receivedPayloads.push(payload); return { stationCount: 3 }; },
        ingestStationPayload: payload => { receivedPayloads.push(payload); return { insertedCount: 2 }; },
    };
    const supervisorService = {
        getClientConfig: () => ({ enabled: false }),
        getRecent: () => [],
        ingestEvent: () => { supervisorCalls += 1; },
    };
    const commandService = {
        getClientConfig: () => ({ polling: true }),
        advanceWorkflows: () => { advances += 1; },
        pollCommand: () => null,
        completeCommand: () => ({ completed: true }),
        registerDevice: value => value,
    };
    const router = createMobileSyncRouter({
        syncService,
        supervisorService,
        commandService,
        getSettings: () => ({ authRequired: true, tokenHeader: 'x-mobile-sync-token' }),
        aiFeaturesEnabled: false,
        buildAiFeatureStatus: () => ({ enabled: false }),
    });
    await withApp(app => app.use('/api/mobile-sync', router), async baseUrl => {
        const config = await (await fetch(`${baseUrl}/api/mobile-sync/config`)).json();
        assert.deepEqual(config.data.auth, {
            authRequired: true,
            authMode: 'bearer',
            tokenHeader: 'x-mobile-sync-token',
        });

        assert.equal((await fetch(`${baseUrl}/api/mobile-sync/ocr`, {
            method: 'POST', headers: {
                'content-type': 'application/json',
                'x-mobile-agent': 'android-agent',
                'x-relay-node': '47-relay',
            }, body: '{}',
        })).status, 200);
        assert.equal((await fetch(`${baseUrl}/api/mobile-sync/stations`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
        })).status, 200);
        assert.equal(advances, 2);
        assert.equal(receivedPayloads[0]._transport.mobileAgent, 'android-agent');
        assert.equal(receivedPayloads[0]._transport.relayNode, '47-relay');

        const supervisor = await (await fetch(`${baseUrl}/api/mobile-sync/supervisor`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
        })).json();
        assert.equal(supervisor.data.accepted, false);
        assert.equal(supervisorCalls, 0);
    });
});

test('移动控制 Router 保留人工身份、指令和会话 404 契约', async () => {
    let enqueued = null;
    const service = {
        listCommands: () => [],
        listDevices: () => [],
        getControlStatus: () => ({ available: true }),
        enqueueCommand: value => {
            enqueued = value;
            return { id: 'cmd-1' };
        },
        advanceWorkflows: () => {},
        listWorkflows: () => [],
        startCityIncrementWorkflow: () => ({ id: 'workflow-1' }),
        getInteractionConfig: () => ({ actions: [] }),
        submitIntent: async () => ({ accepted: true }),
        listChatSessions: () => [],
        getChatSession: () => null,
        submitChatMessage: async () => ({ reply: 'ok' }),
    };
    const router = createMobileControlRouter({
        commandService: service,
        getSettings: () => ({ enabled: true }),
        authMode: 'trusted_proxy',
    });
    await withApp(app => app.use('/api/mobile-control', router), async baseUrl => {
        const browserSession = await (await fetch(`${baseUrl}/api/mobile-control/browser-session`, { method: 'POST' })).json();
        assert.equal(browserSession.data.authMode, 'oidc');

        const command = await fetch(`${baseUrl}/api/mobile-control/commands`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'SCROLL' }),
        });
        assert.equal(command.status, 200);
        assert.deepEqual(enqueued, { action: 'SCROLL' });

        const missing = await fetch(`${baseUrl}/api/mobile-control/chat/sessions/missing`);
        assert.equal(missing.status, 404);
        const missingBody = await missing.json();
        assert.equal(missingBody.code, 'mobile_chat_session_not_found');
        assert.equal(missingBody.requestId, 'request-mobile-route-0001');
    });
});
