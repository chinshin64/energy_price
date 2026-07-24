'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    REDACTED,
    isSensitiveKey,
    redactObject,
    redactText,
    serializeRedacted
} = require('../services/sensitive-redactor');

test('识别常见驼峰和请求头敏感字段', () => {
    assert.equal(isSensitiveKey('authToken'), true);
    assert.equal(isSensitiveKey('clientSecret'), true);
    assert.equal(isSensitiveKey('Set-Cookie'), true);
    assert.equal(isSensitiveKey('stationId'), false);

    const safe = redactObject({
        authToken: 'auth-secret',
        stationId: 'station-1',
        headers: [
            { name: 'Authorization', value: 'Bearer header-secret' },
            { name: 'X-Request-Id', value: 'request-1' }
        ],
        request_url: 'https://example.test/stations?access_token=url-secret&city=xian',
        request_body: JSON.stringify({ sessionKey: 'body-secret', city: 'xian' })
    });

    assert.equal(safe.authToken, REDACTED);
    assert.equal(safe.stationId, 'station-1');
    assert.equal(safe.headers[0].value, REDACTED);
    assert.equal(safe.headers[1].value, 'request-1');
    assert.equal(new URL(safe.request_url).searchParams.get('access_token'), REDACTED);
    assert.equal(JSON.parse(safe.request_body).sessionKey, REDACTED);
});

test('日志文本会清理 Bearer、键值凭据和嵌入式 PII', () => {
    const safe = redactText(
        'Authorization: Bearer abc.def token=secret phone=13812345678 url=https://example.test/a?access_token=url-secret'
    );
    assert.equal(safe.includes('abc.def'), false);
    assert.equal(safe.includes('token=secret'), false);
    assert.equal(safe.includes('13812345678'), false);
    assert.equal(safe.includes('url-secret'), false);
});

test('持久化序列化会脱敏并对超大原始报文降级为摘要', () => {
    const regular = JSON.parse(serializeRedacted({
        platform: 'didi',
        token: 'do-not-store',
        price: 0.88
    }));
    assert.equal(regular.token, REDACTED);
    assert.equal(regular.price, 0.88);

    const oversized = JSON.parse(serializeRedacted({
        platform: 'didi',
        sourceType: 'har',
        payload: { content: 'x'.repeat(4096) }
    }, { maxBytes: 300 }));
    assert.equal(oversized._storagePolicy.redacted, true);
    assert.equal(oversized._storagePolicy.truncated, true);
    assert.equal(oversized._storagePolicy.maxBytes, 300);
    assert.equal(oversized.preview.platform, 'didi');
    assert.equal(oversized.preview.sourceType, 'har');
    assert.equal(JSON.stringify(oversized).includes('x'.repeat(100)), false);
});
