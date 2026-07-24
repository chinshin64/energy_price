'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createCorsOptions, normalizeOrigin, readCorsPolicy } = require('../middleware/cors-policy');

function checkOrigin(options, origin) {
    return new Promise(resolve => {
        options.origin(origin, (error, allowed) => resolve({ error, allowed }));
    });
}

test('开发默认仅允许当前本地端口，生产默认不开放跨域来源', async () => {
    const development = readCorsPolicy({ env: { NODE_ENV: 'development' }, port: 3000 });
    assert.equal(development.allowedOrigins.has('http://localhost:3000'), true);

    const production = readCorsPolicy({ env: { NODE_ENV: 'production' }, port: 3000 });
    assert.equal(production.allowedOrigins.size, 0);
    const result = await checkOrigin(createCorsOptions(production), 'https://attacker.example');
    assert.equal(result.allowed, undefined);
    assert.equal(result.error.code, 'cors_origin_denied');
});

test('显式来源执行精确 origin 匹配', async () => {
    const policy = readCorsPolicy({
        env: {
            NODE_ENV: 'production',
            CORS_ALLOWED_ORIGINS: 'https://blue.example.test,http://blue-node.example.test'
        },
        port: 80
    });
    const options = createCorsOptions(policy);
    assert.equal((await checkOrigin(options, 'https://blue.example.test')).allowed, true);
    assert.equal((await checkOrigin(options, 'https://blue.example.test.evil')).error.code, 'cors_origin_denied');
    assert.equal((await checkOrigin(options, undefined)).allowed, true);
});

test('拒绝带路径、凭据或非 HTTP 协议的伪 origin', () => {
    assert.throws(() => normalizeOrigin('https://example.test/path'), /Invalid CORS origin/);
    assert.throws(() => normalizeOrigin('https://user:pass@example.test'), /Invalid CORS origin/);
    assert.throws(() => normalizeOrigin('file:///tmp/index.html'), /Invalid CORS origin/);
});
