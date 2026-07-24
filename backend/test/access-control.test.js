'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const {
    addressMatchesRule,
    createAccessControl,
    readAuthConfig,
    requiredRoleForRequest
} = require('../middleware/access-control');

function createResponse() {
    const res = new EventEmitter();
    res.statusCode = 200;
    res.headers = {};
    res.setHeader = (name, value) => { res.headers[String(name).toLowerCase()] = value; };
    res.status = code => { res.statusCode = code; return res; };
    res.json = body => { res.body = body; res.emit('finish'); return res; };
    return res;
}

async function invoke(middleware, request) {
    const req = {
        method: 'GET',
        headers: {},
        socket: { remoteAddress: '127.0.0.1' },
        ...request
    };
    const res = createResponse();
    let nextCalled = false;
    await middleware(req, res, () => { nextCalled = true; });
    return { req, res, nextCalled };
}

test('生产环境拒绝关闭鉴权，可信代理必须配置来源地址', () => {
    assert.throws(
        () => readAuthConfig({ NODE_ENV: 'production', AUTH_MODE: 'disabled' }),
        error => error.code === 'auth_required_in_production'
    );
    assert.throws(
        () => readAuthConfig({ NODE_ENV: 'production', AUTH_MODE: 'trusted_proxy' }),
        error => error.code === 'auth_trusted_proxy_not_configured'
    );
});

test('可信代理地址支持精确匹配与 IPv4 CIDR', () => {
    assert.equal(addressMatchesRule('::ffff:127.0.0.1', '127.0.0.1'), true);
    assert.equal(addressMatchesRule('10.20.30.40', '10.20.0.0/16'), true);
    assert.equal(addressMatchesRule('10.21.30.40', '10.20.0.0/16'), false);
});

test('角色策略区分只读、复核、执行和管理操作', () => {
    assert.equal(requiredRoleForRequest('GET', '/api/stats'), 'viewer');
    assert.equal(requiredRoleForRequest('GET', '/api/export/csv'), 'reviewer');
    assert.equal(requiredRoleForRequest('POST', '/api/ocr-review/approve/1'), 'reviewer');
    assert.equal(requiredRoleForRequest('POST', '/api/stations/deduplicate'), 'admin');
    assert.equal(requiredRoleForRequest('POST', '/api/price-schedules/backfill'), 'admin');
    assert.equal(requiredRoleForRequest('PUT', '/api/crawler/run-quota'), 'admin');
    assert.equal(requiredRoleForRequest('PUT', '/api/self-heal/settings'), 'admin');
    assert.equal(requiredRoleForRequest('POST', '/api/global-agent/actions/execute'), 'operator');
    assert.equal(requiredRoleForRequest('PUT', '/api/global-agent/model'), 'operator');
    assert.equal(requiredRoleForRequest('PUT', '/api/settings/network'), 'admin');
    assert.equal(requiredRoleForRequest('PUT', '/api/settings/ai-agent'), 'admin');
});

test('可信代理身份可访问授权资源并拒绝越权管理操作', async () => {
    const config = readAuthConfig({
        NODE_ENV: 'production',
        AUTH_MODE: 'trusted_proxy',
        AUTH_TRUSTED_PROXY_IPS: '127.0.0.1',
        AUTH_DEFAULT_ROLE: 'viewer'
    });
    const middleware = createAccessControl({ config });
    const operatorHeaders = {
        'x-auth-request-user': 'operator-1',
        'x-auth-request-roles': 'operator'
    };

    const read = await invoke(middleware, {
        originalUrl: '/api/stats',
        headers: operatorHeaders
    });
    assert.equal(read.nextCalled, true);
    assert.equal(read.req.auth.subject, 'operator-1');

    const denied = await invoke(middleware, {
        method: 'PUT',
        originalUrl: '/api/settings/network',
        headers: operatorHeaders
    });
    assert.equal(denied.nextCalled, false);
    assert.equal(denied.res.statusCode, 403);
    assert.equal(denied.res.body.code, 'auth_role_forbidden');
});

test('可信身份头不能从非受信地址直接伪造', async () => {
    const config = readAuthConfig({
        NODE_ENV: 'production',
        AUTH_MODE: 'trusted_proxy',
        AUTH_TRUSTED_PROXY_IPS: '10.0.0.0/8'
    });
    const middleware = createAccessControl({ config });
    const result = await invoke(middleware, {
        originalUrl: '/api/stats',
        headers: { 'x-auth-request-user': 'forged', 'x-auth-request-roles': 'admin' },
        socket: { remoteAddress: '127.0.0.1' }
    });
    assert.equal(result.res.statusCode, 401);
    assert.equal(result.res.body.code, 'auth_untrusted_proxy');
});
