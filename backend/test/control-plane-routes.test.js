'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');
const { createRuntimeOverviewRouter } = require('../routes/runtime-overview');
const { createSelfHealRouter } = require('../routes/self-heal');
const { createGeocodeRouter } = require('../routes/geocode');
const { createCrawlerSettingsRouter } = require('../routes/crawler-settings');
const { createPlatformDiagnosticsRouter } = require('../routes/platform-diagnostics');

async function withApp(configure, callback) {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.requestId = 'request-control-plane-0001';
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

test('运行概览、地理编码和平台诊断 Router 保持原路径与错误契约', async () => {
    const runtimeRouter = createRuntimeOverviewRouter({
        service: { getOverview: async () => ({ runtimeMode: 'full' }) },
    });
    const geocodeRouter = createGeocodeRouter({
        service: { search: async keyword => keyword === '西安' ? [{ name: '西安' }] : [] },
    });
    const diagnosticsRouter = createPlatformDiagnosticsRouter({
        service: { list: () => [{ platform: 'didi-charging' }] },
    });

    await withApp(app => {
        app.use('/api', runtimeRouter);
        app.use('/api/geocode', geocodeRouter);
        app.use('/api/diagnostics', diagnosticsRouter);
    }, async baseUrl => {
        assert.equal((await (await fetch(`${baseUrl}/api/config`)).json()).runtimeMode, 'full');

        const missingQuery = await fetch(`${baseUrl}/api/geocode/search`);
        assert.equal(missingQuery.status, 400);
        assert.equal((await missingQuery.json()).code, 'geocode_query_required');
        assert.equal((await fetch(`${baseUrl}/api/geocode/search?q=a&q=b`)).status, 400);

        const found = await (await fetch(`${baseUrl}/api/geocode/search?q=${encodeURIComponent('西安')}`)).json();
        assert.equal(found.success, true);
        assert.equal((await (await fetch(`${baseUrl}/api/diagnostics/platforms`)).json()).data[0].platform, 'didi-charging');
    });
});

test('自愈 Router 在禁用态只读降级且所有执行入口失败关闭', async () => {
    const service = {
        enabled: false,
        getDisabledSettings: () => ({ enabled: false, status: 'planned' }),
        getDisabledResponse: () => ({ success: false, code: 'ai_feature_planned' }),
    };
    await withApp(app => app.use('/api/self-heal', createSelfHealRouter({ service })), async baseUrl => {
        assert.equal((await fetch(`${baseUrl}/api/self-heal/settings`)).status, 200);
        assert.equal((await fetch(`${baseUrl}/api/self-heal/runs`)).status, 200);
        assert.equal((await fetch(`${baseUrl}/api/self-heal/settings`, { method: 'PUT' })).status, 503);
        assert.equal((await fetch(`${baseUrl}/api/self-heal/diagnose`, { method: 'POST' })).status, 503);
        assert.equal((await fetch(`${baseUrl}/api/self-heal/apply`, { method: 'POST' })).status, 503);
    });
});

test('自愈 Router 限制分页并统一诊断和应用响应', async () => {
    const calls = [];
    const service = {
        enabled: true,
        getSettings: () => ({ enabled: true }),
        saveSettings: body => body,
        listRuns: limit => {
            calls.push(limit);
            return [];
        },
        diagnoseAndRecord: body => ({ diagnosis: body, run: { id: 1 } }),
        apply: () => ({ run: { id: 2 } }),
    };
    await withApp(app => app.use('/api/self-heal', createSelfHealRouter({ service })), async baseUrl => {
        assert.equal((await fetch(`${baseUrl}/api/self-heal/runs?limit=9999`)).status, 200);
        assert.deepEqual(calls, [200]);
        assert.equal((await fetch(`${baseUrl}/api/self-heal/diagnose`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scenario: 'x' }),
        })).status, 200);
        assert.equal((await fetch(`${baseUrl}/api/self-heal/apply`, { method: 'POST' })).status, 200);
        service.diagnoseAndRecord = () => { throw new Error('database unavailable'); };
        const failed = await fetch(`${baseUrl}/api/self-heal/diagnose`, { method: 'POST' });
        assert.equal(failed.status, 500);
        assert.equal((await failed.json()).code, 'self_heal_diagnosis_failed');
    });
});

test('爬虫配额 Router 支持正数和显式不限量并拒绝非法值', async () => {
    const saved = [];
    const router = createCrawlerSettingsRouter({
        appSettingModel: {
            getCrawlerRunQuotaStatus: () => ({ perRunLimit: 5 }),
            saveCrawlerPerRunLimit: value => {
                if (value === 13) throw new Error('database unavailable');
                saved.push(value);
                return { perRunLimit: value };
            },
        },
    });
    await withApp(app => app.use('/api/crawler', router), async baseUrl => {
        assert.equal((await fetch(`${baseUrl}/api/crawler/run-quota`)).status, 200);
        assert.equal((await fetch(`${baseUrl}/api/crawler/run-quota`, {
            method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ perRunLimit: 12 }),
        })).status, 200);
        assert.equal((await fetch(`${baseUrl}/api/crawler/run-quota`, {
            method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ unlimited: true }),
        })).status, 200);
        const invalid = await fetch(`${baseUrl}/api/crawler/run-quota`, {
            method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ perRunLimit: 0 }),
        });
        assert.equal(invalid.status, 400);
        assert.equal((await invalid.json()).code, 'crawler_run_quota_invalid');
        const failed = await fetch(`${baseUrl}/api/crawler/run-quota`, {
            method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ perRunLimit: 13 }),
        });
        assert.equal(failed.status, 500);
        assert.equal((await failed.json()).code, 'crawler_run_quota_update_failed');
        assert.deepEqual(saved, [12, 'unlimited']);
    });
});
