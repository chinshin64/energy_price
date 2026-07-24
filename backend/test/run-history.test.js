'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blue-team-run-history-test-'));
process.env.DATABASE_PATH = path.join(tempDir, 'runs.db');

const db = require('../database/init');
const RunHistoryModel = require('../models/run-history');

test.after(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
});

test('运行参数、结果和日志在落库前统一脱敏', () => {
    const runId = RunHistoryModel.startRun('unit-test', {
        token: 'payload-secret',
        target: 'station-list'
    });
    RunHistoryModel.appendLog(runId, 'Authorization: Bearer log-secret');
    RunHistoryModel.finishRun(runId, 'failed', {
        apiKey: 'summary-secret',
        count: 1
    }, 'token=error-secret');

    const raw = db.prepare('SELECT * FROM crawl_runs WHERE id = ?').get(runId);
    const log = db.prepare('SELECT * FROM crawl_run_logs WHERE run_id = ?').get(runId);
    const stored = JSON.stringify({ raw, log });
    for (const secret of ['payload-secret', 'log-secret', 'summary-secret', 'error-secret']) {
        assert.equal(stored.includes(secret), false, `运行历史泄露 ${secret}`);
    }
    assert.equal(JSON.parse(raw.request_payload).token, '**redacted**');
    assert.equal(JSON.parse(raw.result_summary).apiKey, '**redacted**');
});
