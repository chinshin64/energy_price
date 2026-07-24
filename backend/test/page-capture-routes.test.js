'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const express = require('express');
const { createPageCaptureRouter } = require('../routes/page-capture');

async function withApp(dependencies, callback) {
    const app = express();
    app.use(express.json({ limit: '2mb' }));
    app.use((req, res, next) => {
        req.requestId = 'request-page-capture-0001';
        next();
    });
    app.use('/api', createPageCaptureRouter(dependencies));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
    });
    try {
        await callback(`http://127.0.0.1:${server.address().port}`);
    } finally {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
}

function createDependencies(dataRoot, overrides = {}) {
    const calls = {
        extracted: [],
        inserted: [],
        captures: [],
        miniPrograms: []
    };
    const dependencies = {
        dataRoot,
        randomUUID: () => 'capture-test-id',
        teldRuntimeParser: {
            extractStations: (payload, meta) => {
                calls.extracted.push({ payload, meta });
                return [{ stationName: '特来电测试站', platform: 'teld' }];
            }
        },
        stationModel: {
            insertBatch: stations => {
                calls.inserted.push(stations);
                return { successCount: stations.length, yellowCount: 1, redCount: 0, skipCount: 2 };
            }
        },
        wechatLiveOcrService: {
            captureCurrentWindow: payload => {
                calls.captures.push(payload);
                return {
                    stations: [{ stationName: '页面测试站', platform: payload.platform }],
                    screenshotPath: '/data/screen.png',
                    capturePath: '/data/capture.json',
                    ocrPath: '/data/ocr.txt'
                };
            }
        },
        getMiniProgram: platform => {
            calls.miniPrograms.push(platform);
            return platform === 'didi-charging'
                ? { name: '滴滴充电', searchKeyword: '滴滴' }
                : null;
        },
        serializeRedacted: value => JSON.stringify({ redacted: true, keys: Object.keys(value).sort() }),
        logger: { error: () => {} },
        ...overrides
    };
    return { calls, dependencies };
}

test('页面捕获 Router 校验运行时 payload 并写入脱敏捕获文件', async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'page-capture-data-'));
    const { calls, dependencies } = createDependencies(dataRoot);

    await withApp(dependencies, async baseUrl => {
        const missing = await fetch(`${baseUrl}/api/teld/runtime-capture`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}'
        });
        assert.equal(missing.status, 400);
        assert.equal((await missing.json()).error, 'payload required');

        const captured = await (await fetch(`${baseUrl}/api/teld/runtime-capture`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ payload: { token: 'secret', list: [1] }, meta: { city: '西安' } })
        })).json();
        assert.equal(captured.success, true);
        assert.equal(captured.captureId, 'capture-test-id');
        assert.equal(captured.stationCount, 1);
        assert.equal(captured.insertedCount, 1);
        assert.equal(captured.skippedCount, 2);
    });

    assert.deepEqual(calls.extracted, [{ payload: { token: 'secret', list: [1] }, meta: { city: '西安' } }]);
    assert.equal(calls.inserted[0][0].stationName, '特来电测试站');
    const captureFile = path.join(dataRoot, 'teld-runtime', 'capture-capture-test-id.json');
    assert.equal(fs.existsSync(captureFile), true);
    assert.equal(fs.readFileSync(captureFile, 'utf8'), '{"redacted":true,"keys":["meta","payload"]}\n');
});

test('页面 OCR 捕获 Router 使用平台默认 titleKeywords 并保持入库响应契约', async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'page-ocr-data-'));
    const { calls, dependencies } = createDependencies(dataRoot);

    await withApp(dependencies, async baseUrl => {
        const missing = await fetch(`${baseUrl}/api/page-capture`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}'
        });
        assert.equal(missing.status, 400);
        assert.equal((await missing.json()).error, 'platform required');

        const captured = await (await fetch(`${baseUrl}/api/page-capture`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                platform: 'didi-charging',
                stage: 'list',
                city: '西安',
                landmark: '钟楼',
                operator: 'qa'
            })
        })).json();

        assert.equal(captured.success, true);
        assert.equal(captured.platform, 'didi-charging');
        assert.equal(captured.stationCount, 1);
        assert.equal(captured.insertedCount, 1);
        assert.equal(captured.reviewInsertedCount, 1);
        assert.equal(captured.redCount, 0);
        assert.equal(captured.skippedCount, 2);
        assert.equal(captured.screenshotPath, '/data/screen.png');
        assert.deepEqual(captured.data, [{ stationName: '页面测试站', platform: 'didi-charging' }]);
    });

    assert.deepEqual(calls.miniPrograms, ['didi-charging']);
    assert.deepEqual(calls.captures[0], {
        platform: 'didi-charging',
        titleKeywords: ['滴滴充电', '滴滴'],
        stage: 'list',
        sourceType: 'page-ocr',
        sourceStage: 'list',
        runId: '',
        city: '西安',
        landmark: '钟楼',
        operator: 'qa'
    });
});

test('特来电旧 OCR 接口强制平台且显式 titleKeywords 优先', async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'teld-ocr-data-'));
    const { calls, dependencies } = createDependencies(dataRoot);

    await withApp(dependencies, async baseUrl => {
        const captured = await (await fetch(`${baseUrl}/api/teld/ocr-capture`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                platform: 'didi-charging',
                titleKeywords: ['自定义窗口'],
                sourceType: 'manual-ocr',
                sourceStage: 'runtime-check',
                runId: 'run-1'
            })
        })).json();

        assert.equal(captured.success, true);
        assert.equal(captured.platform, 'teld');
        assert.equal(captured.data[0].platform, 'teld');
    });

    assert.deepEqual(calls.miniPrograms, []);
    assert.deepEqual(calls.captures[0], {
        platform: 'teld',
        titleKeywords: ['自定义窗口'],
        stage: 'manual',
        sourceType: 'manual-ocr',
        sourceStage: 'runtime-check',
        runId: 'run-1',
        city: '',
        landmark: '',
        operator: ''
    });
});
