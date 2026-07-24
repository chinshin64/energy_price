'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');
const { createMobileAccess } = require('../middleware/mobile-access');

async function requestWithAccess({ config, env, path = '/api/mobile-sync/config', headers = {}, human = false }) {
    const app = express();
    app.use((req, res, next) => {
        req.requestId = 'request-mobile-auth-0001';
        if (human) req.auth = { subject: 'user-1', mode: 'oidc' };
        next();
    });
    app.use('/api/mobile-sync', createMobileAccess({ config, env }).middleware);
    app.use('/api/mobile-control', createMobileAccess({ config, env }).middleware);
    app.all('*', (req, res) => res.json({ success: true, auth: req.auth || null }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
    });
    try {
        return await fetch(`http://127.0.0.1:${server.address().port}${path}`, { headers });
    } finally {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
}

test('生产移动通道缺少机器凭据时失败关闭', async () => {
    const response = await requestWithAccess({
        config: { mobileSync: { enabled: true } },
        env: { NODE_ENV: 'production' },
    });
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.code, 'mobile_sync_auth_not_configured');
    assert.equal(body.requestId, 'request-mobile-auth-0001');
});

test('移动通道拒绝错误凭据并接受 Bearer 设备凭据', async () => {
    const config = { mobileSync: { enabled: true, tokenHeader: 'x-mobile-token' } };
    const env = { NODE_ENV: 'production', MOBILE_SYNC_TOKEN: 'device-secret' };
    const invalid = await requestWithAccess({ config, env, headers: { authorization: 'Bearer wrong' } });
    assert.equal(invalid.status, 401);
    assert.match(invalid.headers.get('www-authenticate'), /mobile-sync/);

    const valid = await requestWithAccess({
        config,
        env,
        headers: { authorization: 'Bearer device-secret' },
    });
    assert.equal(valid.status, 200);
    const validBody = await valid.json();
    assert.equal(validBody.auth.subject, 'mobile-device');
    assert.deepEqual(validBody.auth.roles, ['device']);
});

test('已认证用户可访问人工控制端但不能冒充设备同步端', async () => {
    const config = { mobileSync: { enabled: true } };
    const env = { NODE_ENV: 'production', MOBILE_SYNC_TOKEN: 'device-secret' };
    const control = await requestWithAccess({
        config,
        env,
        path: '/api/mobile-control/status',
        human: true,
    });
    assert.equal(control.status, 200);
    assert.equal((await control.json()).auth.subject, 'user-1');

    const sync = await requestWithAccess({ config, env, human: true });
    assert.equal(sync.status, 401);
});
