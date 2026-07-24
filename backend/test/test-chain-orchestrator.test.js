'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const TestChainOrchestrator = require('../services/test-chain-orchestrator');

test('method3 编排保留目标坐标系和调用方请求预算', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blue-team-chain-policy-'));
    const calls = [];
    const unavailable = { success: false, available: false, reason: 'not_configured' };
    const orchestrator = new TestChainOrchestrator({
        dataDir,
        method1Service: { getStatus: async () => unavailable },
        method2Service: { getStatus: async () => unavailable },
        method3Service: {
            getStatus: async () => ({ success: true, available: true, reason: 'ready' }),
            runBasicCheck: async input => {
                calls.push(input);
                return {
                    success: true,
                    status: 'request_sent',
                    result: {
                        success: true,
                        totalAttempts: 2,
                        successCount: 2,
                        results: [],
                    },
                };
            },
        },
    });

    try {
        const result = await orchestrator.run({
            chain: 'method3',
            mode: 'detail',
            maxPages: 1,
            maxRequestCount: 2,
            maxQps: 0.5,
            target: {
                platform: 'didi-charging',
                city: '西安',
                lat: 34.3416,
                lng: 108.9398,
                coordinateSystem: 'GCJ02',
            },
        });

        assert.equal(result.success, true);
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0], {
            platform: 'didi-charging',
            city: '西安',
            lat: 34.3416,
            lng: 108.9398,
            coordinateSystem: 'GCJ02',
            radiusKm: 20,
            maxPages: 1,
            maxRequestCount: 2,
            maxQps: 0.5,
            mode: 'detail',
        });
        assert.equal(result.run.target.maxRequestCount, 2);
        assert.equal(result.run.target.maxQps, 0.5);
    } finally {
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
});
