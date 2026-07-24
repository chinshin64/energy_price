'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');
const {
    createCrawlerExecutionRouter,
    normalizeTargetLocation,
    normalizeTargetRequestParams,
    normalizeTestMode
} = require('../routes/crawler-execution');

async function withApp(dependencies, callback) {
    const app = express();
    app.use(express.json({ limit: '2mb' }));
    app.use((req, res, next) => {
        req.requestId = 'request-crawler-exec-0001';
        next();
    });
    const routes = createCrawlerExecutionRouter(dependencies);
    app.use('/api', routes.router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
    });
    try {
        await callback(`http://127.0.0.1:${server.address().port}`, routes);
    } finally {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
}

function createDependencies(overrides = {}) {
    const calls = {
        crawl: [],
        crawlDetail: [],
        inserted: [],
        templatesByScope: [],
        updatedTemplates: [],
        runs: [],
        logs: [],
        summaries: [],
        finished: [],
        selfHeal: [],
        preflight: [],
        scheduled: []
    };
    const listTemplate = { id: 11, platform: 'didi-charging', templateScope: 'list', baseUrl: 'https://example.test/list' };
    const detailTemplate = { id: 12, platform: 'didi-charging', templateScope: 'detail', baseUrl: 'https://example.test/detail' };
    const makeQuota = (limit) => {
        if (limit === null || limit === undefined || limit === '') {
            return { unlimited: true, limit: null, used: 0, success: 0, fail501: 0, requestCount: 0 };
        }
        return { unlimited: false, limit: Math.max(1, Number(limit) || 5), used: 0, success: 0, fail501: 0, requestCount: 0 };
    };
    const summarizeQuota = quota => quota ? {
        limit: quota.limit,
        unlimited: Boolean(quota.unlimited),
        used: Number(quota.used) || 0,
        success: Number(quota.success) || 0,
        fail501: Number(quota.fail501) || 0,
        requestCount: Number(quota.requestCount) || 0,
        remaining: quota.unlimited ? null : Math.max(0, quota.limit - (Number(quota.used) || 0)),
        exhausted: !quota.unlimited && (Number(quota.used) || 0) >= quota.limit,
        perTargetLimit: quota.perTargetLimit,
        quotaMode: quota.quotaMode,
        targetCount: quota.targetCount
    } : null;

    const dependencies = {
        SmartCrawlerClass: {
            generateGridCoordinates: (lat, lng) => [
                { lat, lng },
                { lat: lat + 0.001, lng: lng + 0.001 }
            ]
        },
        smartCrawler: {
            createRunRequestQuota: makeQuota,
            createTestRequestBudget: platform => ({ platform, limit: 5, used: 0 }),
            getTestRequestBudgetSummary: budget => budget || null,
            getQuotaStatsSummary: () => ({ daily: 1 }),
            getRunRequestQuotaSummary: summarizeQuota,
            hasRunRequestQuotaRemaining: quota => !quota || quota.unlimited || quota.used < quota.limit,
            hasTestRequestBudgetRemaining: () => true,
            formatRunRequestQuota: quota => `used=${quota?.used || 0}`,
            formatTestRequestBudget: budget => `used=${budget?.used || 0}`,
            isRunRequestLimitExceeded: error => error?.code === 'run_request_limit_exceeded',
            isTestRequestBudgetExceeded: error => error?.code === 'test_request_limit_exceeded',
            getSignedTemplateTargetMismatch: () => '',
            crawl: async (template, options) => {
                calls.crawl.push({ template, options });
                if (options.runQuota && !options.runQuota.unlimited) {
                    options.runQuota.used += 1;
                    options.runQuota.success += 1;
                    options.runQuota.requestCount += 1;
                }
                options.progressReporter?.();
                return [{
                    platform: template.platform,
                    station_id: 'station-1',
                    station_name: '测试场站',
                    latitude: options.coordinates?.[0]?.lat,
                    longitude: options.coordinates?.[0]?.lng
                }];
            },
            crawlDetail: async (template, options) => {
                calls.crawlDetail.push({ template, options });
                return [{ platform: template.platform, station_id: 'detail-1', station_name: '详情场站' }];
            }
        },
        stationModel: {
            insertBatch: stations => {
                calls.inserted.push(stations);
                return { successCount: stations.length, skipCount: 0 };
            },
            getNearbySeeds: () => []
        },
        apiTemplateModel: {
            getByPlatformAndScope: (platform, scope) => {
                calls.templatesByScope.push({ platform, scope });
                if (scope === 'list') return [listTemplate];
                if (scope === 'detail') return [detailTemplate];
                return [];
            },
            updateLastUsed: id => calls.updatedTemplates.push(id)
        },
        runHistoryModel: {
            startRun: (type, payload) => {
                calls.runs.push({ type, payload });
                return 101;
            },
            appendLog: (runId, message, level = 'info') => calls.logs.push({ runId, message, level }),
            updateRunSummary: (runId, summary) => calls.summaries.push({ runId, summary }),
            finishRun: (runId, status, summary, error = null) => calls.finished.push({ runId, status, summary, error })
        },
        harParser: {
            deduplicateStations: stations => stations
        },
        selfHealService: {
            buildApiFailure: (platform, reason, quota) => {
                calls.selfHeal.push({ platform, reason, quota });
                return { platform, reason };
            }
        },
        templateApplicationService: {
            buildPreflightDiagnostics: (pattern, proxyContext) => {
                calls.preflight.push({ pattern, proxyContext });
                return { ok: true, city: proxyContext.city };
            }
        },
        scheduleImmediate: callback => calls.scheduled.push(callback),
        logger: { error: () => {} },
        ...overrides
    };
    return { calls, dependencies, listTemplate, detailTemplate };
}

test('方式三执行工具函数规范化目标位置和请求材料', () => {
    assert.equal(normalizeTestMode('true'), true);
    assert.equal(normalizeTestMode('0'), false);
    assert.deepEqual(normalizeTargetRequestParams({
        query: { lat: 31.2, nested: { nope: true } },
        body: { city: '上海' },
        headers: { token: 't' },
        method: 'POST',
        ignoredObject: { nested: true }
    }), {
        queryParams: { lat: 31.2 },
        bodyParams: { city: '上海' },
        headers: { token: 't' },
        method: 'POST'
    });
    assert.deepEqual(normalizeTargetLocation({
        city: '西安',
        coordinateSystem: 'gcj02',
        requestParams: { list: { queryParams: { lat: 34.2 }, method: 'POST' } }
    }, 34.3416, 108.9398), {
        keyword: '',
        name: '',
        province: '',
        city: '西安',
        district: '',
        coordinateSystem: 'GCJ02',
        lat: 34.3416,
        lng: 108.9398,
        requestParams: {
            list: {
                queryParams: { lat: 34.2 },
                bodyParams: {},
                headers: {},
                method: 'POST'
            }
        }
    });
});

test('单模板爬取 Router 保留列表、详情、预算和诊断契约', async () => {
    const { calls, dependencies, listTemplate, detailTemplate } = createDependencies();

    await withApp(dependencies, async baseUrl => {
        const missing = await fetch(`${baseUrl}/api/crawler/crawl`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}'
        });
        assert.equal(missing.status, 400);
        assert.equal((await missing.json()).error, 'pattern required');

        const listResult = await (await fetch(`${baseUrl}/api/crawler/crawl`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                pattern: listTemplate,
                coordinates: [{ lat: 31.2, lng: 121.4 }],
                targetLocation: { city: '上海' },
                testMode: true,
                perRunLimit: 3
            })
        })).json();
        assert.equal(listResult.success, true);
        assert.equal(listResult.stationCount, 1);
        assert.equal(listResult.insertedCount, 1);
        assert.equal(listResult.testMode, true);
        assert.equal(listResult.preflightDiagnostics.city, '上海');
        assert.equal(listResult.runQuota.used, 1);

        const detailMissing = await fetch(`${baseUrl}/api/crawler/crawl`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ pattern: detailTemplate })
        });
        assert.equal(detailMissing.status, 400);
        assert.equal((await detailMissing.json()).error, 'detail template requires seedStations');

        const detailResult = await (await fetch(`${baseUrl}/api/crawler/crawl`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ pattern: detailTemplate, seedStations: [{ station_id: 's1' }] })
        })).json();
        assert.equal(detailResult.success, true);
        assert.equal(detailResult.stationCount, 1);
    });

    assert.equal(calls.crawl.length, 1);
    assert.equal(calls.crawlDetail.length, 1);
    assert.equal(calls.preflight[0].proxyContext.city, '上海');
});

test('多坐标同步执行会创建运行记录、生成网格、入库并写入完成摘要', async () => {
    const { calls, dependencies } = createDependencies();

    await withApp(dependencies, async baseUrl => {
        const invalid = await fetch(`${baseUrl}/api/crawler/crawl-platforms-with-coordinates`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ platforms: [] })
        });
        assert.equal(invalid.status, 400);
        assert.equal((await invalid.json()).error, 'platforms required');

        const result = await (await fetch(`${baseUrl}/api/crawler/crawl-platforms-with-coordinates`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                platforms: ['didi-charging'],
                centerLat: 34.3416,
                centerLng: 108.9398,
                targetLocations: [{ city: '西安', keyword: '钟楼', lat: 34.261, lng: 108.9425 }],
                crawlMode: 'list',
                perRunLimit: 2
            })
        })).json();

        assert.equal(result.success, true);
        assert.equal(result.status, 'success');
        assert.equal(result.coordinateCount, 2);
        assert.equal(result.totalStations, 1);
        assert.equal(result.totalInserted, 1);
        assert.equal(result.summary[0].platform, 'didi-charging');
    });

    assert.equal(calls.runs[0].type, 'crawl-platforms-with-coordinates');
    assert.equal(calls.runs[0].payload.targetLocations[0].city, '西安');
    assert.equal(calls.templatesByScope.some(item => item.scope === 'list'), true);
    assert.equal(calls.inserted[0][0].station_name, '测试场站');
    assert.equal(calls.finished[0].status, 'success');
    assert.equal(calls.finished[0].summary.totalStations, 1);
});

test('后台启动与网格生成 Router 保留响应契约', async () => {
    const { calls, dependencies } = createDependencies();

    await withApp(dependencies, async baseUrl => {
        const started = await (await fetch(`${baseUrl}/api/crawler/crawl-platforms-with-coordinates/start`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                platforms: ['didi-charging'],
                centerLat: 31.2,
                centerLng: 121.4,
                crawlMode: 'list'
            })
        })).json();
        assert.equal(started.success, true);
        assert.equal(started.runId, 101);
        assert.equal(started.status, 'running');
        assert.equal(calls.scheduled.length, 1);

        const missing = await fetch(`${baseUrl}/api/crawler/generate-grid`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}'
        });
        assert.equal(missing.status, 400);

        const grid = await (await fetch(`${baseUrl}/api/crawler/generate-grid`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ centerLat: 31.2, centerLng: 121.4, radius: 5, gridSize: 2 })
        })).json();
        assert.equal(grid.success, true);
        assert.equal(grid.count, 2);
        assert.deepEqual(grid.coordinates[0], { lat: 31.2, lng: 121.4 });
    });

    assert.equal(calls.logs.some(item => item.message === '方式三任务已进入后台执行队列'), true);
});
