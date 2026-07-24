'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const express = require('express');
const {
    createHarWorkflowRouter,
    sanitizeFilename,
    validateHarUpload
} = require('../routes/har-workflow');

async function withApp(dependencies, callback) {
    const app = express();
    app.use(express.json({ limit: '2mb' }));
    app.use((req, res, next) => {
        req.requestId = 'request-har-route-0001';
        next();
    });
    app.use('/api', createHarWorkflowRouter(dependencies));
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
        parsedFiles: [],
        inserted: [],
        learnedFiles: [],
        runs: [],
        logs: [],
        finished: []
    };
    const patterns = [{ platform: 'didi-charging', method: 'POST', baseUrl: 'https://example.test/list', variableParams: { lat: '31.2' } }];
    const dependencies = {
        dataRoot,
        harParser: {
            parseSessionFile: async filePath => {
                calls.parsedFiles.push(filePath);
                return [{ stationName: '测试场站', platform: 'didi-charging', raw: { token: 'secret' } }];
            }
        },
        stationModel: {
            insertBatch: stations => {
                calls.inserted.push(stations);
                return { successCount: stations.length, skipCount: 0 };
            }
        },
        smartCrawler: {
            learnFromHAR: async filePath => {
                calls.learnedFiles.push(filePath);
                return patterns;
            }
        },
        runHistoryModel: {
            startRun: (type, payload) => {
                calls.runs.push({ type, payload });
                return 9;
            },
            appendLog: (runId, message, level = 'info') => calls.logs.push({ runId, message, level }),
            finishRun: (runId, status, summary, error = null) => calls.finished.push({ runId, status, summary, error })
        },
        apiTemplateModel: {
            publicTemplates: value => value.map(item => ({ platform: item.platform, method: item.method }))
        },
        redactObject: value => value.map(item => ({ stationName: item.stationName, redacted: true })),
        logger: { error: () => {} },
        ...overrides
    };
    return { calls, dependencies };
}

test('HAR 工作流工具函数拒绝危险文件名和空内容', () => {
    assert.equal(sanitizeFilename('../x.har'), null);
    assert.equal(sanitizeFilename('x.har'), 'x.har');
    assert.throws(() => validateHarUpload('x.txt', '{}'), /HAR upload filename/);
    assert.throws(() => validateHarUpload('x.har', ''), /non-empty string/);
    assert.equal(validateHarUpload('x.json', '{}'), 'x.json');
});

test('HAR 解析 Router 限制 data 目录并保持入库契约', async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'har-route-data-'));
    const harFile = path.join(dataRoot, 'capture.har');
    fs.writeFileSync(harFile, '{"log":{"entries":[]}}');
    const { calls, dependencies } = createDependencies(dataRoot);

    await withApp(dependencies, async baseUrl => {
        const outside = await fetch(`${baseUrl}/api/parse-har`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ filePath: path.join(os.tmpdir(), 'outside.har') })
        });
        assert.equal(outside.status, 403);
        assert.equal((await outside.json()).error, 'filePath must be under data/ directory');

        const parsed = await (await fetch(`${baseUrl}/api/parse-har`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ filePath: harFile })
        })).json();
        assert.equal(parsed.success, true);
        assert.equal(parsed.message, 'Parsed 1 stations');
        assert.equal(calls.parsedFiles[0], harFile);
        assert.equal(calls.inserted[0][0].stationName, '测试场站');
    });
});

test('HAR 上传解析使用受限临时文件并清理结果', async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'har-upload-data-'));
    const { calls, dependencies } = createDependencies(dataRoot);

    await withApp(dependencies, async baseUrl => {
        const invalid = await fetch(`${baseUrl}/api/parse-har-upload`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ filename: '../x.har', content: '{}' })
        });
        assert.equal(invalid.status, 400);
        assert.equal((await invalid.json()).code, 'invalid_har_filename');

        const parsed = await (await fetch(`${baseUrl}/api/parse-har-upload`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ filename: 'upload.har', content: '{"log":{"entries":[]}}' })
        })).json();
        assert.equal(parsed.success, true);
        assert.equal(parsed.stationCount, 1);
        assert.deepEqual(parsed.data, [{ stationName: '测试场站', redacted: true }]);
        assert.equal(path.dirname(calls.parsedFiles[0]), path.join(dataRoot, 'temp'));
        assert.equal(fs.existsSync(calls.parsedFiles[0]), false);
    });
});

test('HAR 学习 Router 保留路径边界、运行记录和公开模板响应', async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'har-learn-data-'));
    const harFile = path.join(dataRoot, 'learn.har');
    fs.writeFileSync(harFile, '{"log":{"entries":[]}}');
    const { calls, dependencies } = createDependencies(dataRoot);

    await withApp(dependencies, async baseUrl => {
        const learned = await (await fetch(`${baseUrl}/api/crawler/learn`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ harFilePath: harFile })
        })).json();
        assert.equal(learned.success, true);
        assert.equal(learned.patterns[0].templateScope, 'list');
        assert.deepEqual(learned.patterns[0].variableParams, ['lat']);

        const uploaded = await (await fetch(`${baseUrl}/api/crawler/learn-upload`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ filename: 'learn.har', content: '{"log":{"entries":[]}}' })
        })).json();
        assert.equal(uploaded.success, true);
        assert.deepEqual(uploaded.patterns, [{ platform: 'didi-charging', method: 'POST' }]);
        assert.deepEqual(calls.runs[0], { type: 'learn-upload', payload: { filename: 'learn.har', contentLength: 22 } });
        assert.equal(calls.finished[0].status, 'success');
        assert.equal(fs.existsSync(calls.learnedFiles.at(-1)), false);
    });
});
