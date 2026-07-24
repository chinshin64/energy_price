'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { parsePort, readRuntimeConfig, resolveDataRoot } = require('../config/runtime');

test('运行时数据目录始终相对项目根目录解析', () => {
    const projectRoot = path.resolve('/tmp/blue-team-project');
    assert.equal(resolveDataRoot(projectRoot, ''), path.join(projectRoot, 'data'));
    assert.equal(resolveDataRoot(projectRoot, 'runtime/data'), path.join(projectRoot, 'runtime/data'));
    assert.equal(resolveDataRoot(projectRoot, '/srv/blue-team/data'), '/srv/blue-team/data');
});

test('测试环境默认关闭后台签名监控且允许随机端口', () => {
    const config = readRuntimeConfig({
        projectRoot: '/tmp/blue-team-project',
        env: { NODE_ENV: 'test', PORT: '0', DATA_ROOT: 'isolated' },
        server: { port: 3000, host: '0.0.0.0' },
    });
    assert.equal(config.port, 0);
    assert.equal(config.host, '0.0.0.0');
    assert.equal(config.dataRoot, path.resolve('/tmp/blue-team-project/isolated'));
    assert.equal(config.signatureHealthMonitorEnabled, false);
});

test('生产默认开启监控并拒绝非法端口', () => {
    const config = readRuntimeConfig({
        projectRoot: '/tmp/blue-team-project',
        env: { NODE_ENV: 'production' },
        server: { port: 8080 },
    });
    assert.equal(config.port, 8080);
    assert.equal(config.signatureHealthMonitorEnabled, true);
    assert.throws(() => parsePort('65536', 3000), error => error.code === 'runtime_port_invalid');
    assert.throws(() => parsePort('not-a-port', 3000), error => error.code === 'runtime_port_invalid');
});
