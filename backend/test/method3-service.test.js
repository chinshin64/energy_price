'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const Method3Service = require('../services/method3-service');

function createService(options = {}) {
    const templateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blue-team-method3-'));
    const service = new Method3Service({
        templateDir,
        signatureProvider: {},
        failureAnalyzer: {
            analyzeFailure: async () => ({
                failureEventId: null,
                agentAnalysis: null,
                agentError: null,
                strategyPatch: null,
            }),
        },
        ...options,
    });
    return { service, templateDir };
}

test('method3 拒绝无效或超限的请求预算', async () => {
    const { service, templateDir } = createService();
    service.preflight = () => ({ status: 'matched' });
    try {
        for (const limits of [
            { maxPages: 0 },
            { maxPages: 1.5 },
            { maxRequestCount: 0 },
            { maxRequestCount: 6 },
            { maxQps: 0 },
            { maxQps: 2 },
            { maxQps: 'invalid' },
        ]) {
            const result = await service.runBasicCheck({
                platform: 'didi-charging',
                city: '西安',
                lat: 34.3416,
                lng: 108.9398,
                maxPages: 1,
                maxRequestCount: 2,
                maxQps: 1,
                ...limits,
            });
            assert.equal(result.success, false);
            assert.equal(result.reason, 'request_limit_exceeded');
        }
    } finally {
        fs.rmSync(templateDir, { recursive: true, force: true });
    }
});

test('method3 在请求异常时仍按 maxQps 等待', async () => {
    const waits = [];
    let attempts = 0;
    const { service, templateDir } = createService({
        upstreamProxy: 'http://127.0.0.1:8888',
        proxyAgentFactory: () => ({}),
        httpClient: async () => {
            attempts += 1;
            const error = new Error('network failed');
            error.code = 'ECONNRESET';
            throw error;
        },
        sleep: async milliseconds => { waits.push(milliseconds); },
    });
    try {
        const result = await service._executeBoundedRequest({
            entry: { method: 'POST', baseUrl: 'https://example.invalid/stations' },
            targetLat: 34.3416,
            targetLng: 108.9398,
            city: '西安',
            radiusKm: 20,
            nearestDistance: 0,
            mode: 'list',
            maxRequestCount: 3,
            maxQps: 0.5,
        });

        assert.equal(result.success, false);
        assert.equal(result.totalAttempts, 3);
        assert.equal(attempts, 3);
        assert.deepEqual(waits, [2000, 2000]);
    } finally {
        fs.rmSync(templateDir, { recursive: true, force: true });
    }
});
