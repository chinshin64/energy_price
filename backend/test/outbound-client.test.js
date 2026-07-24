'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.UNIFIED_OUTBOUND_PROXY_URL = '';
delete process.env.METHOD3_UPSTREAM_PROXY;
delete process.env.ALLOW_DIRECT_OUTBOUND;

const OutboundClient = require('../services/outbound-client');

test.afterEach(() => {
    delete process.env.ALLOW_DIRECT_OUTBOUND;
});

test('未配置出口且未显式允许直连时失败关闭', async () => {
    const client = new OutboundClient({
        getProxySettings: () => ({ enabled: false, defaultProxyUrl: '' })
    });
    await assert.rejects(
        () => client.resolveProxyMatch(),
        error => error.code === 'outbound_proxy_required' && error.statusCode === 503
    );
});

test('仅在显式开关开启时返回直连策略', async () => {
    process.env.ALLOW_DIRECT_OUTBOUND = '1';
    const client = new OutboundClient({
        getProxySettings: () => ({ enabled: false, defaultProxyUrl: '' })
    });
    assert.deepEqual(await client.resolveProxyMatch(), {
        type: 'direct',
        label: '直连',
        proxyUrl: ''
    });
});

test('业务配置中的代理优先于部署兜底策略', async () => {
    const client = new OutboundClient({
        getProxySettings: () => ({
            enabled: true,
            defaultProxyUrl: 'http://proxy.example.test:8080'
        })
    });
    const match = await client.resolveProxyMatch();
    assert.equal(match.type, 'default');
    assert.equal(match.proxyUrl, 'http://proxy.example.test:8080');
});

test('供应商代理没有受控引导出口时不会静默直连', async () => {
    const client = new OutboundClient();
    const result = await client.fetchProviderProxy({
        enabled: true,
        apiUrl: 'https://provider.example.test/proxy'
    });
    assert.equal(result, null);
});
