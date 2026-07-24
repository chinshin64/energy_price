'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { EdgeAgentService } = require('../services/edge-agent-service');
const { EdgeGeoResolver, matchesCidr, normalizeIp } = require('../services/edge-geo-resolver');

function withService(callback, options = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-agent-service-'));
    const nowRef = { value: Date.parse('2026-07-16T10:00:00.000Z') };
    const geoByIp = {
        '10.10.1.10': { country: '中国', province: '陕西省', city: '西安市', verified: true, source: 'test' },
        '10.20.1.10': { country: '中国', province: '上海市', city: '上海市', verified: true, source: 'test' }
    };
    const service = new EdgeAgentService({
        statePath: path.join(root, 'state.json'),
        enrollmentToken: 'enroll-test',
        geoResolver: { resolve: async ip => ({ ip, ...(geoByIp[ip] || { verified: false, source: 'test-unresolved' }) }) },
        now: () => nowRef.value,
        leaseMs: 10000,
        onlineTtlMs: 30000,
        ...options
    });
    return Promise.resolve(callback(service, nowRef)).finally(() => fs.rmSync(root, { recursive: true, force: true }));
}

async function register(service, input, ip) {
    return service.registerNode(input, { enrollmentToken: 'enroll-test', observedIp: ip });
}

test('IP 规范化、CIDR 和静态属地规则可用于内网节点', async () => {
    assert.equal(normalizeIp('::ffff:172.23.25.54'), '172.23.25.54');
    assert.equal(matchesCidr('172.23.25.54', '172.23.25.0/24'), true);
    assert.equal(matchesCidr('172.23.26.54', '172.23.25.0/24'), false);
    const resolver = new EdgeGeoResolver({
        rules: [{
            cidr: '172.23.25.0/24',
            geo: { country: '中国', province: '陕西省', city: '西安市', verified: true, source: 'test' }
        }]
    });
    const result = await resolver.resolve('172.23.25.54');
    assert.equal(result.city, '西安市');
    assert.equal(result.verified, true);
});

test('主服务器按能力和严格城市属地选择真实执行节点', () => withService(async service => {
    await register(service, {
        nodeId: 'android-xian-01', nodeType: 'worker', platform: 'android',
        capabilities: ['android.wechat.collect']
    }, '10.10.1.10');
    await register(service, {
        nodeId: 'android-shanghai-01', nodeType: 'worker', platform: 'android',
        capabilities: ['android.wechat.collect']
    }, '10.20.1.10');

    const task = service.createTask({
        capability: 'android.wechat.collect',
        type: 'collect_landmark',
        requiredGeo: { country: '中国', province: '陕西省', city: '西安市' },
        payload: { city: '西安', targetStations: 100 }
    });
    assert.equal(task.targetNodeId, 'android-xian-01');
    assert.match(task.assignmentReason, /geo:exact/);
}));

test('子 Agent 只能向下级节点下发委派地区与能力范围内的任务', () => withService(async service => {
    const controller = await register(service, {
        nodeId: 'controller-xian-01', nodeType: 'controller', platform: 'darwin',
        capabilities: ['edge.controller'],
        delegatedCapabilities: ['android.wechat.collect'],
        delegatedRegions: [{ country: '中国', province: '陕西省', city: '西安市' }],
        canDelegate: true
    }, '10.10.1.10');
    const worker = await register(service, {
        nodeId: 'android-xian-child-01', parentNodeId: 'controller-xian-01',
        nodeType: 'worker', platform: 'android', capabilities: ['android.wechat.collect']
    }, '10.10.1.10');

    const childTask = service.createTask({
        targetNodeId: 'android-xian-child-01',
        capability: 'android.wechat.collect', type: 'collect_landmark',
        requiredGeo: { province: '陕西省', city: '西安市' }, payload: { city: '西安' }
    }, { type: 'node', nodeId: 'controller-xian-01', sessionToken: controller.sessionToken });
    assert.equal(childTask.origin, 'child-agent');

    assert.throws(() => service.createTask({
        targetNodeId: 'android-xian-child-01',
        capability: 'android.wechat.collect', type: 'collect_landmark',
        requiredGeo: { province: '广东省', city: '广州市' }, payload: { city: '广州' }
    }, { type: 'node', nodeId: 'controller-xian-01', sessionToken: controller.sessionToken }), /outside delegated scope/);

    const leased = service.pollTask('android-xian-child-01', worker.sessionToken);
    assert.equal(leased.id, childTask.id);
    assert.equal(leased.status, 'running');
    const completed = service.completeTask('android-xian-child-01', worker.sessionToken, leased.id, {
        success: true, result: { stationCount: 105 }
    });
    assert.equal(completed.status, 'succeeded');
    assert.equal(completed.result.stationCount, 105);
}));

test('未验证属地不执行严格地区任务，过期租约重新进入调度', () => withService(async (service, nowRef) => {
    const registration = await register(service, {
        nodeId: 'android-unknown-01', platform: 'android', capabilities: ['android.wechat.collect']
    }, '10.99.1.10');
    const waiting = service.createTask({
        capability: 'android.wechat.collect', type: 'collect_landmark',
        requiredGeo: { city: '西安市' }
    });
    assert.equal(waiting.targetNodeId, null);
    assert.equal(service.pollTask('android-unknown-01', registration.sessionToken), null);

    const localTask = service.createTask({
        targetNodeId: 'android-unknown-01', capability: 'android.wechat.collect',
        type: 'status', geoPolicy: 'strict'
    });
    assert.equal(service.pollTask('android-unknown-01', registration.sessionToken).id, localTask.id);
    nowRef.value += 11000;
    service.recoverExpiredLeases();
    const recovered = service.listTasks().find(task => task.id === localTask.id);
    assert.equal(recovered.status, 'pending');
    assert.equal(recovered.targetNodeId, null);
}));

test('注册会话密钥仅返回一次且服务端持久化哈希', () => withService(async service => {
    const registration = await register(service, {
        nodeId: 'desktop-xian-01', platform: 'darwin', capabilities: ['desktop.wechat.status'],
        fingerprintHash: 'a'.repeat(64),
        deviceProfile: { hostnameHash: 'b'.repeat(64), serialNumber: 'must-not-be-stored' }
    }, '10.10.1.10');
    assert.ok(registration.sessionToken.length > 30);
    assert.equal(service.state.nodes[0].sessionTokenHash.length, 64);
    assert.equal(service.state.nodes[0].deviceProfile.serialNumber, undefined);
    assert.throws(() => service.pollTask('desktop-xian-01', 'wrong-token'), /authentication failed/);
}));

test('设备可请求重试失败任务，达到最大次数后终止', () => withService(async service => {
    const registration = await register(service, {
        nodeId: 'desktop-retry-01', platform: 'darwin', capabilities: ['system.status']
    }, '10.10.1.10');
    const task = service.createTask({
        targetNodeId: 'desktop-retry-01', capability: 'system.status', type: 'status', maxAttempts: 2
    });
    const firstLease = service.pollTask('desktop-retry-01', registration.sessionToken);
    const retry = service.completeTask('desktop-retry-01', registration.sessionToken, firstLease.id, {
        success: false, retryable: true, error: 'temporary failure'
    });
    assert.equal(retry.status, 'pending');
    assert.equal(retry.attemptCount, 1);

    const secondLease = service.pollTask('desktop-retry-01', registration.sessionToken);
    const failed = service.completeTask('desktop-retry-01', registration.sessionToken, secondLease.id, {
        success: false, retryable: true, error: 'still failing'
    });
    assert.equal(failed.status, 'failed');
    assert.equal(failed.attemptCount, 2);
    assert.equal(task.id, failed.id);
}));
