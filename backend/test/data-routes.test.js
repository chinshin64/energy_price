'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const express = require('express');
const { createDataRouter } = require('../routes/data');
const { createOcrReviewRouter } = require('../routes/ocr-review');

async function withApp(configure, callback) {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.requestId = 'request-data-route-0001';
        next();
    });
    configure(app);
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

function dataDependencies(overrides = {}) {
    return {
        stationModel: {
            getStatistics: () => [],
            deduplicateExisting: () => ({ removed: 0 }),
            getEvidenceAssets: () => [],
            getEvidenceAssetFilePath: () => null,
            getRecent: () => [],
            getByDateRange: () => [],
            ...(overrides.stationModel || {}),
        },
        priceScheduleModel: {
            getStatistics: () => ({}),
            getByStationId: () => [],
            getByPlatform: () => [],
            backfillFromStations: () => ({}),
            ...(overrides.priceScheduleModel || {}),
        },
        runHistoryModel: {
            getRuns: () => [],
            getRun: () => null,
            getLogs: () => [],
            startRun: () => 1,
            appendLog: () => {},
            finishRun: () => {},
            ...(overrides.runHistoryModel || {}),
        },
    };
}

test('数据 Router 保持统计和分时价格契约并拒绝非法标识', async () => {
    const calls = [];
    const dependencies = dataDependencies({
        stationModel: {
            getStatistics: () => [{ platform: 'didi-charging', total_records: 2 }],
        },
        priceScheduleModel: {
            getStatistics: () => ({ total: 3 }),
            getByStationId: stationId => {
                calls.push(['station', stationId]);
                return [{ stationId }];
            },
            getByPlatform: (platform, limit) => {
                calls.push(['platform', platform, limit]);
                return [];
            },
            backfillFromStations: options => {
                calls.push(['backfill', options]);
                return { scheduleCount: 4 };
            },
        },
    });

    await withApp(app => app.use('/api', createDataRouter(dependencies)), async baseUrl => {
        const stats = await (await fetch(`${baseUrl}/api/stats`)).json();
        assert.equal(stats.data[0].total_records, 2);

        const station = await fetch(`${baseUrl}/api/price-schedules/station/9`);
        assert.equal(station.status, 200);
        const invalidStation = await fetch(`${baseUrl}/api/price-schedules/station/not-a-number`);
        assert.equal(invalidStation.status, 400);
        assert.deepEqual(
            (({ code, requestId }) => ({ code, requestId }))(await invalidStation.json()),
            { code: 'invalid_station_id', requestId: 'request-data-route-0001' }
        );

        assert.equal((await fetch(`${baseUrl}/api/price-schedules/platform/didi-charging?limit=99999`)).status, 200);
        const backfill = await fetch(`${baseUrl}/api/price-schedules/backfill`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ platform: ' didi-charging ', limit: 12, resetExisting: false }),
        });
        assert.equal(backfill.status, 200);
        assert.deepEqual(calls, [
            ['station', 9],
            ['platform', 'didi-charging', 5000],
            ['backfill', { platform: 'didi-charging', limit: 12, resetExisting: false }],
        ]);

        const invalidBackfill = await fetch(`${baseUrl}/api/price-schedules/backfill`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ limit: 0 }),
        });
        assert.equal(invalidBackfill.status, 400);
    });
});

test('运行记录与去重 Router 记录完整生命周期且不吞掉非法 runId', async () => {
    const events = [];
    const dependencies = dataDependencies({
        stationModel: { deduplicateExisting: () => ({ removed: 3 }) },
        runHistoryModel: {
            getRun: runId => runId === 8 ? { id: 8 } : null,
            getLogs: (limit, runId) => [{ limit, runId }],
            startRun: (type, payload) => {
                events.push(['start', type, payload]);
                return 17;
            },
            appendLog: (runId, message, level = 'info') => events.push(['log', runId, message, level]),
            finishRun: (runId, status, summary) => events.push(['finish', runId, status, summary]),
        },
    });

    await withApp(app => app.use('/api', createDataRouter(dependencies)), async baseUrl => {
        assert.equal((await fetch(`${baseUrl}/api/runs/8`)).status, 200);
        const missing = await fetch(`${baseUrl}/api/runs/9`);
        assert.equal(missing.status, 404);
        assert.equal((await missing.json()).code, 'run_not_found');
        assert.equal((await fetch(`${baseUrl}/api/runs/0`)).status, 400);
        assert.equal((await fetch(`${baseUrl}/api/run-logs?runId=bad`)).status, 400);

        const logs = await (await fetch(`${baseUrl}/api/run-logs?runId=8&limit=9999`)).json();
        assert.deepEqual(logs.data, [{ limit: 500, runId: 8 }]);

        const deduplicate = await (await fetch(`${baseUrl}/api/stations/deduplicate`, { method: 'POST' })).json();
        assert.equal(deduplicate.removed, 3);
        assert.deepEqual(events[0], ['start', 'deduplicate', {}]);
        assert.deepEqual(events.at(-1), ['finish', 17, 'success', { removed: 3 }]);
    });
});

test('证据与场站查询 Router 限制输入并安全输出文件名', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blue-team-data-router-'));
    const evidencePath = path.join(tempDir, 'evidence.txt');
    fs.writeFileSync(evidencePath, 'evidence-body');
    let evidenceFilters = null;
    const dependencies = dataDependencies({
        stationModel: {
            getEvidenceAssets: filters => {
                evidenceFilters = filters;
                return [{ id: 7 }];
            },
            getEvidenceAssetFilePath: id => id === 7 ? {
                filePath: evidencePath,
                contentType: 'text/plain',
                filename: '证据"\r\nX-Injected: yes.txt',
            } : null,
            getRecent: (limit, platform) => [{ limit, platform }],
            getByDateRange: (start, end, platform) => [{ start, end, platform }],
        },
    });

    try {
        await withApp(app => app.use('/api', createDataRouter(dependencies)), async baseUrl => {
            const assets = await fetch(`${baseUrl}/api/stations/evidence-assets?stationId=4&platform=didi-charging&evidenceType=ocr-text`);
            assert.equal(assets.status, 200);
            assert.deepEqual(evidenceFilters, {
                limit: undefined,
                platform: 'didi-charging',
                stationId: 4,
                evidenceType: 'ocr-text',
            });

            const content = await fetch(`${baseUrl}/api/stations/evidence-assets/7/content`);
            assert.equal(content.status, 200);
            assert.equal(await content.text(), 'evidence-body');
            assert.equal(content.headers.get('x-injected'), null);
            assert.match(content.headers.get('content-disposition'), /^inline; filename=/);

            const missing = await fetch(`${baseUrl}/api/stations/evidence-assets/8/content`);
            assert.equal(missing.status, 404);
            assert.equal((await missing.json()).code, 'station_evidence_not_found');
            assert.equal((await fetch(`${baseUrl}/api/stations/evidence-assets?stationId=bad`)).status, 400);
            assert.equal((await fetch(`${baseUrl}/api/stations/range?start=2026-07-01`)).status, 400);

            const recent = await (await fetch(`${baseUrl}/api/stations/recent?limit=9999&platform=didi-charging`)).json();
            assert.deepEqual(recent.data, [{ limit: 1000, platform: 'didi-charging' }]);
        });
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('OCR 复核 Router 覆盖分页、非法 ID、非待审核与拒绝成功', async () => {
    const calls = [];
    const stationModel = {
        getOcrQualityDashboard: () => ({ total: 10, needsReview: 2 }),
        getPendingReview: (limit, offset) => {
            calls.push(['pending', limit, offset]);
            return [{ id: 1 }];
        },
        getPendingReviewCount: () => 2,
        approveStation: id => ({ changes: id === 1 ? 1 : 0 }),
        rejectStation: id => ({ changes: id === 2 ? 1 : 0 }),
    };

    await withApp(app => app.use('/api', createOcrReviewRouter({ stationModel })), async baseUrl => {
        const dashboard = await (await fetch(`${baseUrl}/api/ocr-quality/dashboard`)).json();
        assert.equal(dashboard.data.needsReview, 2);

        const pending = await (await fetch(`${baseUrl}/api/ocr-review/pending?limit=9999&offset=5`)).json();
        assert.equal(pending.limit, 500);
        assert.equal(pending.offset, 5);
        assert.deepEqual(calls, [['pending', 500, 5]]);

        const invalid = await fetch(`${baseUrl}/api/ocr-review/approve/1.5`, { method: 'POST' });
        assert.equal(invalid.status, 400);
        assert.equal((await invalid.json()).code, 'ocr_review_id_invalid');
        assert.equal((await fetch(`${baseUrl}/api/ocr-review/approve/3`, { method: 'POST' })).status, 404);
        assert.equal((await fetch(`${baseUrl}/api/ocr-review/approve/1`, { method: 'POST' })).status, 200);
        assert.equal((await fetch(`${baseUrl}/api/ocr-review/reject/2`, { method: 'POST' })).status, 200);
    });
});
