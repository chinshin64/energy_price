'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { readConfig, validateUrl } = require('../src/config');
const { buildDeviceProfile, capabilities } = require('../src/device-profile');
const { executeTask } = require('../src/executors');
const { StateStore } = require('../src/state-store');

test('设备档案只包含公开信息和加盐哈希', () => {
    const result = buildDeviceProfile('test-secret', { appVersion: 'test' });
    assert.match(result.fingerprintHash, /^[a-f0-9]{64}$/);
    assert.match(result.profile.hostnameHash, /^[a-f0-9]{64}$/);
    assert.equal(result.profile.hostname, undefined);
    assert.equal(result.profile.serialNumber, undefined);
    assert.equal(result.profile.macAddress, undefined);
});

test('桌面能力按平台和委派角色生成', () => {
    assert.ok(capabilities('darwin', true).includes('desktop.wechat.workflow'));
    assert.ok(capabilities('win32', false).includes('desktop.wechat.basic-check'));
    assert.ok(capabilities('darwin', true).includes('edge.controller'));
    assert.ok(!capabilities('linux', false).includes('desktop.wechat.workflow'));
});

test('本地蓝军服务地址禁止非回环主机', () => {
    assert.throws(() => validateUrl('http://192.168.1.10:50080', 'test', { loopbackOnly: true }), /loopback/);
    assert.equal(validateUrl('http://127.0.0.1:50080/', 'test', { loopbackOnly: true }), 'http://127.0.0.1:50080');
});

test('状态文件生成独立安装密钥并持久化', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-edge-state-'));
    try {
        const filePath = path.join(root, 'state.json');
        const first = new StateStore(filePath);
        const second = new StateStore(filePath);
        assert.ok(first.state.installationSecret.length > 30);
        assert.equal(first.state.installationSecret, second.state.installationSecret);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('执行器拒绝未列入允许列表的任务能力', async () => {
    await assert.rejects(() => executeTask({}, { capability: 'shell.execute', payload: { command: 'whoami' } }), /unsupported/);
});

test('配置解析父节点、委派地区和数据目录', () => {
    const config = readConfig({
        EDGE_SERVER_URL: 'https://edge.example.com',
        EDGE_LOCAL_BLUE_TEAM_URL: 'http://localhost:50080',
        EDGE_DATA_DIR: path.join(os.tmpdir(), 'edge-config-test'),
        EDGE_CAN_DELEGATE: 'true',
        EDGE_DELEGATED_CAPABILITIES: 'android.wechat.collect,desktop.wechat.workflow',
        EDGE_DELEGATED_REGIONS_JSON: '[{"country":"中国","province":"陕西省","city":"西安市"}]'
    });
    assert.equal(config.canDelegate, true);
    assert.equal(config.delegatedCapabilities.length, 2);
    assert.equal(config.delegatedRegions[0].city, '西安市');
});
