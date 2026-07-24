'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const SmartCrawler = require('../crawler/smart-crawler');
const { KuaidianCredentialProvider } = require('../services/kuaidian-credential-provider');
const { TuanyouCredentialProvider } = require('../services/tuanyou-credential-provider');

const TUANYOU = Object.freeze({
    appKey: 'unit-test-tuanyou-key',
    appSecret: 'unit-test-tuanyou-secret',
    host: 'https://tuanyou.example.invalid',
    userAgent: 'unit-test-tuanyou-agent',
    referer: 'https://client.example.invalid/tuanyou/',
    mpVersion: '0.0-test',
    shumeiID: 'unit-test-tuanyou-device',
    token: '',
    fromScanCode: '',
});

const KUAIDIAN = Object.freeze({
    appKey: 'unit-test-kuaidian-key',
    appSecret: 'unit-test-kuaidian-secret',
    appTerminal: 'unit-test-terminal',
    appName: 'unit-test-app',
    platformType: 'unit-test-platform',
    terminalType: 'unit-test-terminal-type',
    host: 'https://kuaidian.example.invalid',
    userAgent: 'unit-test-kuaidian-agent',
    referer: 'https://client.example.invalid/kuaidian/',
    token: '',
    sensorId: '',
    deviceId: '',
    saDistinctId: '',
    saAnonymousId: '',
});

function wrappedSignature(params, secret) {
    const payload = { ...params };
    delete payload.sign;
    const serialized = Object.keys(payload)
        .sort()
        .map(key => `${key}${payload[key] ?? ''}`)
        .join('');
    return crypto.createHash('md5')
        .update(`${secret}${serialized}${secret}`, 'utf8')
        .digest('hex');
}

function crawler(options = {}) {
    const outboundClient = options.outboundClient || {
        async request() { return { status: 200, data: {} }; },
    };
    if (typeof outboundClient.resolveProxyMatch !== 'function') {
        outboundClient.resolveProxyMatch = async () => null;
    }
    return new SmartCrawler({}, {
        outboundClient,
        kuaidianCredentialProvider: options.kuaidianCredentialProvider,
        tuanyouCredentialProvider: options.tuanyouCredentialProvider,
        env: {},
    });
}

test('platform credential providers fail closed and serialize only configuration state', () => {
    for (const Provider of [KuaidianCredentialProvider, TuanyouCredentialProvider]) {
        const provider = new Provider();
        assert.throws(() => provider.requireCredentials(), /configuration is unavailable/);
        assert.deepEqual(JSON.parse(JSON.stringify(provider)), { configured: false });
    }
    const tuanyou = new TuanyouCredentialProvider(TUANYOU);
    const kuaidian = new KuaidianCredentialProvider(KUAIDIAN);
    const serialized = JSON.stringify({ tuanyou, kuaidian });
    assert.equal(serialized.includes(TUANYOU.appSecret), false);
    assert.equal(serialized.includes(TUANYOU.shumeiID), false);
    assert.equal(serialized.includes(KUAIDIAN.appSecret), false);
    assert.deepEqual(JSON.parse(serialized), {
        tuanyou: { configured: true },
        kuaidian: { configured: true },
    });
});

test('smart crawler rejects missing platform credentials before outbound request without leaking values', async () => {
    let outboundCalls = 0;
    const instance = crawler({
        outboundClient: {
            async request() {
                outboundCalls += 1;
                throw new Error('outbound should not run');
            },
        },
        kuaidianCredentialProvider: new KuaidianCredentialProvider(),
        tuanyouCredentialProvider: new TuanyouCredentialProvider(),
    });
    for (const platform of ['kuaidian', 'tuanyou']) {
        let error;
        await assert.rejects(() => instance.sendRequest({
            platform,
            method: 'POST',
            baseUrl: `https://${platform}.example.invalid/services/v3/test`,
            headers: {},
        }, { query: {}, body: {} }), value => {
            error = value;
            return true;
        });
        const serialized = JSON.stringify(error);
        assert.equal(serialized.includes('secret'), false);
        assert.equal(serialized.includes('device'), false);
    }
    assert.equal(outboundCalls, 0);
});

test('smart crawler signs Tuanyou and Kuaidian with explicit fake provider values', async () => {
    const calls = [];
    const instance = crawler({
        outboundClient: {
            async request(config) {
                calls.push(config);
                return { status: 200, data: {} };
            },
        },
        kuaidianCredentialProvider: new KuaidianCredentialProvider(KUAIDIAN),
        tuanyouCredentialProvider: new TuanyouCredentialProvider(TUANYOU),
    });

    await instance.sendRequest({
        platform: 'tuanyou',
        method: 'POST',
        baseUrl: `${TUANYOU.host}/services/v3/test`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
    }, { query: {}, body: { oilNo: '95' } });
    await instance.sendRequest({
        platform: 'kuaidian',
        method: 'POST',
        baseUrl: `${KUAIDIAN.host}/services/v3/test`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
    }, { query: {}, body: { pageIndex: 1 } });

    assert.equal(calls.length, 2);
    const tuanyouBody = Object.fromEntries(new URLSearchParams(calls[0].data));
    const kuaidianBody = Object.fromEntries(new URLSearchParams(calls[1].data));
    assert.equal(tuanyouBody.sign, wrappedSignature(tuanyouBody, TUANYOU.appSecret));
    assert.equal(kuaidianBody.sign, wrappedSignature(kuaidianBody, KUAIDIAN.appSecret));
    assert.equal(calls[0].headers['User-Agent'], TUANYOU.userAgent);
    assert.equal(calls[0].headers.Referer, TUANYOU.referer);
    assert.equal(calls[1].headers['User-Agent'], KUAIDIAN.userAgent);
    assert.equal(calls[1].headers.Referer, KUAIDIAN.referer);
});

test('provider target mismatch error contains no configured secret or device signal', () => {
    const providers = [
        [new TuanyouCredentialProvider(TUANYOU), TUANYOU],
        [new KuaidianCredentialProvider(KUAIDIAN), KUAIDIAN],
    ];
    for (const [provider, values] of providers) {
        let error;
        assert.throws(
            () => provider.assertRequestUrl('https://other.example.invalid/path'),
            value => {
                error = value;
                return true;
            }
        );
        const text = `${error.message} ${JSON.stringify(error)}`;
        assert.equal(text.includes(values.appSecret), false);
        for (const sensitive of [values.shumeiID, values.deviceId].filter(Boolean)) {
            assert.equal(text.includes(sensitive), false);
        }
    }
});
