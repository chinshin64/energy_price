'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const express = require('express');
const { createEdgeAgentRouter } = require('../routes/edge-agent');
const { EdgeAgentService } = require('../services/edge-agent-service');
const { EdgeClient } = require('../../edge-agent/desktop/src/edge-client');
const { buildDeviceProfile, capabilities } = require('../../edge-agent/desktop/src/device-profile');
const { createExecutors, executeTask } = require('../../edge-agent/desktop/src/executors');
const { StateStore } = require('../../edge-agent/desktop/src/state-store');

test('主端与桌面 Agent 通过真实 HTTP 完成注册、属地租约、执行和回传', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-cross-platform-'));
    const service = new EdgeAgentService({
        statePath: path.join(root, 'server-state.json'),
        enrollmentToken: 'cross-platform-enrollment',
        geoResolver: {
            resolve: async ip => ({
                ip,
                country: '中国',
                province: '陕西省',
                city: '西安市',
                verified: true,
                source: 'cross-platform-test'
            })
        }
    });
    const app = express();
    app.use(express.json());
    app.use('/api/edge', createEdgeAgentRouter({ service }));
    const server = await new Promise(resolve => {
        const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });

    try {
        const address = server.address();
        const stateStore = new StateStore(path.join(root, 'desktop-state.json'));
        const config = {
            serverUrl: `http://127.0.0.1:${address.port}`,
            enrollmentToken: 'cross-platform-enrollment',
            requestTimeoutMs: 5000,
            localBlueTeamUrl: 'http://127.0.0.1:9',
            localBlueTeamToken: ''
        };
        const client = new EdgeClient({ config, stateStore });
        const profile = buildDeviceProfile(stateStore.state.installationSecret, {
            appVersion: 'cross-platform-test'
        });
        await client.register({
            nodeId: 'desktop-cross-platform-01',
            nodeType: 'worker',
            platform: process.platform,
            version: 'cross-platform-test',
            capabilities: capabilities(process.platform, false),
            fingerprintHash: profile.fingerprintHash,
            deviceProfile: profile.profile,
            commandServiceRunning: true
        });

        const task = service.createTask({
            capability: 'system.status',
            type: 'status',
            requiredGeo: { country: '中国', province: '陕西省', city: '西安市' },
            payload: {},
            idempotencyKey: 'cross-platform-status-01'
        });
        assert.equal(task.targetNodeId, 'desktop-cross-platform-01');

        const leased = await client.pollTask();
        assert.equal(leased.id, task.id);
        const result = await executeTask(createExecutors({ config, stateStore }), leased);
        const completed = await client.completeTask(leased.id, { success: true, result });
        assert.equal(completed.status, 'succeeded');
        assert.equal(completed.result.nodeId, 'desktop-cross-platform-01');
        assert.match(completed.result.installationIdHash, /^[a-f0-9]{64}$/);
    } finally {
        await new Promise(resolve => server.close(resolve));
        fs.rmSync(root, { recursive: true, force: true });
    }
});
