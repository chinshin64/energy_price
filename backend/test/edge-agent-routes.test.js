'use strict';

const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createEdgeAgentRouter } = require('../routes/edge-agent');
const { EdgeAgentService } = require('../services/edge-agent-service');

async function withServer(callback) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-agent-routes-'));
    const service = new EdgeAgentService({
        statePath: path.join(root, 'state.json'),
        enrollmentToken: 'route-enrollment',
        geoResolver: {
            resolve: async ip => ({
                ip, country: '中国', province: '陕西省', city: '西安市',
                verified: true, source: 'route-test'
            })
        }
    });
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.requestId = 'edge-route-request-01';
        req.auth = { subject: 'admin-1', roles: ['admin'] };
        next();
    });
    app.use('/api/edge', createEdgeAgentRouter({ service }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
    });
    try {
        await callback(`http://127.0.0.1:${server.address().port}`);
    } finally {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        fs.rmSync(root, { recursive: true, force: true });
    }
}

test('Edge 路由完成注册、主端下发、租约和结果回传', () => withServer(async baseUrl => {
    const registrationResponse = await fetch(`${baseUrl}/api/edge/v1/nodes/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-edge-enrollment-token': 'route-enrollment' },
        body: JSON.stringify({
            nodeId: 'android-route-01', platform: 'android',
            capabilities: ['android.wechat.collect']
        })
    });
    assert.equal(registrationResponse.status, 201);
    const registration = (await registrationResponse.json()).data;

    const taskResponse = await fetch(`${baseUrl}/api/edge/tasks`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            capability: 'android.wechat.collect', type: 'collect_landmark',
            requiredGeo: { province: '陕西省', city: '西安市' }, payload: { city: '西安' }
        })
    });
    assert.equal(taskResponse.status, 201);
    const created = (await taskResponse.json()).data;
    assert.equal(created.targetNodeId, 'android-route-01');

    const nodeHeaders = {
        'content-type': 'application/json',
        'x-edge-node-id': 'android-route-01',
        authorization: `Bearer ${registration.sessionToken}`
    };
    const leased = (await (await fetch(`${baseUrl}/api/edge/v1/tasks/poll`, { headers: nodeHeaders })).json()).data;
    assert.equal(leased.id, created.id);

    const resultResponse = await fetch(`${baseUrl}/api/edge/v1/tasks/${leased.id}/result`, {
        method: 'POST', headers: nodeHeaders,
        body: JSON.stringify({ success: true, result: { stationCount: 101 } })
    });
    assert.equal(resultResponse.status, 200);
    const result = (await resultResponse.json()).data;
    assert.equal(result.status, 'succeeded');

    const nodes = (await (await fetch(`${baseUrl}/api/edge/nodes?includeIp=true`)).json()).data;
    assert.equal(nodes[0].geo.city, '西安市');
    assert.equal(nodes[0].egressIp, '127.0.0.1');
}));

test('Edge 机器接口拒绝错误 enrollment 和节点会话密钥', () => withServer(async baseUrl => {
    const denied = await fetch(`${baseUrl}/api/edge/v1/nodes/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-edge-enrollment-token': 'wrong' },
        body: JSON.stringify({ nodeId: 'android-route-02', platform: 'android' })
    });
    assert.equal(denied.status, 401);

    const poll = await fetch(`${baseUrl}/api/edge/v1/tasks/poll`, {
        headers: { 'x-edge-node-id': 'android-route-02', authorization: 'Bearer wrong' }
    });
    assert.equal(poll.status, 401);
}));
