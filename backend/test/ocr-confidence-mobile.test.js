'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const OcrConfidence = require('../services/ocr-confidence');
const { RemoteMobileSourceSync } = require('../services/remote-mobile-source-sync');

function mobile(overrides = {}) {
    return {
        stationName: '特来电西安无地址测试充电站',
        sourceType: 'mobile-ocr',
        sourceAgent: 'android-ocr-agent',
        confidence: 1,
        ...overrides,
    };
}

test('standalone Android complete price and ports stay green without address', () => {
    const result = OcrConfidence.evaluate(mobile({
        priceFast: 0.88,
        availablePorts: 3,
        totalPorts: 5,
    }));
    assert.equal(result.light, 'green');
    assert.equal(result.weightPolicy, 'standalone-android-no-address');
    assert.equal(result.dimensions.addressCompleteness, null);
    assert.equal(result.score, 100);
});

test('standalone Android price-only and ports-only are yellow while name-only remains red', () => {
    const priceOnly = OcrConfidence.evaluate(mobile({ priceFast: 0.88 }));
    const portsOnly = OcrConfidence.evaluate(mobile({ availablePorts: 3, totalPorts: 5 }));
    const nameOnly = OcrConfidence.evaluate(mobile());
    assert.equal(priceOnly.light, 'yellow');
    assert.equal(portsOnly.light, 'yellow');
    assert.equal(nameOnly.light, 'red');
    assert.ok(nameOnly.hardRules.includes('no_ports_no_price'));
});

test('address weight exception does not apply to other OCR agents or source types', () => {
    const otherAgent = OcrConfidence.evaluate(mobile({
        sourceAgent: 'ios-agent',
        priceFast: 0.88,
        availablePorts: 3,
        totalPorts: 5,
    }));
    const pageOcr = OcrConfidence.evaluate(mobile({
        sourceType: 'page-ocr',
        priceFast: 0.88,
        availablePorts: 3,
        totalPorts: 5,
    }));
    assert.equal(otherAgent.weightPolicy, 'default');
    assert.equal(pageOcr.weightPolicy, 'default');
    assert.equal(otherAgent.dimensions.addressCompleteness, 0);
    assert.equal(pageOcr.dimensions.addressCompleteness, 0);
});

test('47 adapter preserves standalone Android source agent for main-service confidence routing', () => {
    const service = new RemoteMobileSourceSync({
        stationModel: { insertBatch() {} },
        httpClient: { async get() { return { data: { success: true, data: { records: [] } } }; } },
        baseUrl: 'https://mobile-source.example.test',
        allowedHosts: ['mobile-source.example.test'],
        token: 'configured-in-test-only',
        statePath: '/tmp/not-used-mobile-confidence-state.json',
    });
    const mapped = service.toLocalStation({
        sourceRecordId: 1,
        ingestId: '00000000-0000-4000-8000-000000000001',
        sourceNode: '47-mysql',
        sourceAgent: 'android-ocr-agent',
        sourceStage: 'screen-ocr-manual-scroll',
        platform: 'didi-charging',
        city: '西安',
        stationName: '特来电西安无地址测试充电站',
        priceFast: 0.88,
        availablePorts: 3,
        totalPorts: 5,
        capturedAt: '2026-07-22T10:00:00.000Z',
        raw: {},
    });
    assert.equal(mapped.sourceType, 'mobile-ocr');
    assert.equal(mapped.sourceAgent, 'android-ocr-agent');
    assert.equal(OcrConfidence.evaluate(mapped).weightPolicy, 'standalone-android-no-address');
});
