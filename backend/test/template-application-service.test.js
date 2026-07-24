'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const TemplateApplicationService = require('../services/template-application-service');

function createService(overrides = {}) {
    const calls = [];
    const template = {
        id: 7,
        name: '列表模板',
        platform: 'didi-charging',
        method: 'POST',
        baseUrl: 'https://api.example.test/stations',
        templateScope: 'list',
    };
    const templateModel = {
        saveSmart: value => {
            calls.push(['save', value]);
            return { templateId: 7, created: true };
        },
        saveBatch: values => ({ successCount: values.length, createdCount: values.length, mergedCount: 0, skipCount: 0 }),
        getAll: () => [template, { ...template, id: 8, platform: 'outside-scope' }],
        getByPlatform: () => [template],
        getById: id => id === 7 ? template : null,
        publicTemplate: value => ({ ...value, public: true }),
        publicTemplates: values => values.map(value => ({ ...value, public: true })),
        update: id => ({ changes: id === 7 ? 1 : 0 }),
        delete: id => ({ changes: id === 7 ? 1 : 0 }),
        deduplicateExactTemplates: ({ dryRun }) => ({ dryRun, removedCount: 0, duplicateGroupCount: 0 }),
        updateLastUsed: id => calls.push(['used', id]),
        ...(overrides.templateModel || {}),
    };
    const smartCrawler = {
        createRunRequestQuota: () => ({ limit: 5 }),
        createTestRequestBudget: () => ({ max: 2 }),
        crawl: async () => [{ stationName: 'A' }],
        crawlDetail: async () => [{ stationName: 'B' }],
        isRunRequestLimitExceeded: error => error.code === 'run_request_limit_exceeded',
        getRunRequestQuotaSummary: () => ({ used: 1 }),
        getTestRequestBudgetSummary: value => value,
        getQuotaStatsSummary: () => ({ total: 1 }),
        getSignedTemplateTargetMismatch: () => null,
        ...(overrides.smartCrawler || {}),
    };
    const service = new TemplateApplicationService({
        templateModel,
        stationModel: { insertBatch: rows => ({ successCount: rows.length, skipCount: 0 }) },
        smartCrawler,
        getPlatformIds: () => ['didi-charging'],
        normalizeTargetLocation: value => value || {},
    });
    return { service, calls, templateModel, smartCrawler };
}

test('模板服务校验结构、过滤运行范围并返回真实保存结果', () => {
    const { service, calls } = createService();
    const result = service.create({
        name: '列表模板',
        pattern: {
            platform: 'didi-charging', method: 'post', baseUrl: 'https://api.example.test/stations',
            queryParams: {}, bodyParams: {}, variableParams: {}, headers: {},
        },
    });
    assert.equal(result.templateId, 7);
    assert.equal(calls[0][1].method, 'POST');
    assert.equal(service.list().length, 1);
    assert.throws(() => service.create({
        name: '坏模板',
        pattern: { platform: 'didi-charging', method: 'GET', baseUrl: 'https://user:pass@example.test/path' },
    }), error => error.code === 'template_url_invalid');
    assert.throws(() => service.createBatch({ patterns: Array.from({ length: 101 }, () => ({})) }),
        error => error.code === 'template_batch_too_large');
});

test('模板执行统一预算、入库和最后使用时间', async () => {
    const { service, calls } = createService();
    const result = await service.use(7, {
        coordinates: [{ lat: 31.2, lng: 121.4 }],
        pageSize: 20,
        maxPages: 3,
        testMode: true,
    });
    assert.equal(result.stationCount, 1);
    assert.equal(result.insertedCount, 1);
    assert.equal(result.testMode, true);
    assert.deepEqual(calls.at(-1), ['used', 7]);

    await assert.rejects(service.use(99, {}), error => error.code === 'template_not_found');
});

test('详情模板必须提供受限 seedStations，配额异常保留 429 证据', async () => {
    const detail = {
        id: 7, name: '详情', platform: 'didi-charging', method: 'POST',
        baseUrl: 'https://api.example.test/detail', templateScope: 'detail',
    };
    const { service, smartCrawler } = createService({
        templateModel: { getById: () => detail },
    });
    await assert.rejects(service.use(7, {}), error => error.code === 'template_seed_stations_invalid');

    smartCrawler.crawlDetail = async () => {
        const error = new Error('quota exhausted');
        error.code = 'run_request_limit_exceeded';
        throw error;
    };
    await assert.rejects(
        service.use(7, { seedStations: [{ id: 1 }] }),
        error => error.statusCode === 429 && error.runQuota.used === 1
    );
});
