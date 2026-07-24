'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const SelfHealApplicationService = require('../services/self-heal-application-service');
const RuntimeOverviewService = require('../services/runtime-overview-service');
const { GeocodeService, loadGeocodePresets } = require('../services/geocode-service');
const PlatformDiagnosticsService = require('../services/platform-diagnostics-service');

function selfHealDependencies() {
    const savedRuns = [];
    const appSettingModel = {
        getSelfHealSettings: () => ({ enabled: true, maxAttempts: 2 }),
        saveSelfHealSettings: () => {},
        getSelfHealRuns: limit => [{ limit }],
        getProxySettings: () => ({ enabled: false }),
        recordSelfHealRun: payload => {
            savedRuns.push(payload);
            return { id: savedRuns.length, createdAt: '2026-07-10T00:00:00Z', ...payload };
        },
        getScheduleRecovery: () => null,
    };
    const diagnosticService = {
        buildSummary: settings => `attempts=${settings.maxAttempts}`,
        getScenarioOptions: () => ['template_missing'],
        getChainLabels: () => ({ api: '小规模访问验证' }),
        diagnose: payload => ({
            currentChain: payload.currentChain || 'api',
            currentChainLabel: '小规模访问验证',
            nextChain: 'har',
            nextChainLabel: '请求采集',
            scenario: payload.scenario || 'template_missing',
            title: '诊断',
            status: 'recoverable',
            summary: '可恢复',
            execution: { targetChainLabel: '小规模访问验证' },
            repairPlan: ['刷新材料'],
        }),
    };
    return { appSettingModel, diagnosticService, savedRuns };
}

test('自愈应用服务统一诊断、记录、应用和采集失败降级', () => {
    const dependencies = selfHealDependencies();
    const service = new SelfHealApplicationService({
        ...dependencies,
        enabled: true,
    });

    assert.equal(service.getSettings().summary, 'attempts=2');
    const diagnosed = service.diagnoseAndRecord({ platforms: ['didi-charging'] });
    assert.equal(diagnosed.run.platform, 'didi-charging');
    assert.equal(dependencies.savedRuns.length, 1);

    const applied = service.apply({ diagnosis: diagnosed.diagnosis, platforms: ['didi-charging'] });
    assert.equal(applied.run.status, 'applied');
    assert.match(applied.run.summary, /小规模访问验证/);

    const apiFailure = service.buildApiFailure('didi-charging', 'no_active_template');
    assert.equal(apiFailure.diagnosis.scenario, 'template_missing');
    assert.equal(service.enrichSchedule({ id: 5 }).self_heal_summary, 'attempts=2');

    const disabled = new SelfHealApplicationService({ ...dependencies, enabled: false });
    assert.deepEqual(disabled.buildApiFailure('didi-charging', '501').reason, 'ai_feature_planned');
});

test('运行概览按链路降级且单项探针异常不导致整体失败', async () => {
    const warnings = [];
    const selfHealService = {
        getAiFeatureStatus: () => ({ enabled: false }),
        getRuntimeMetadata: () => ({ enabled: false, status: 'planned' }),
    };
    const service = new RuntimeOverviewService({
        config: { automation: { enabled: true }, rateLimit: { max: 5 } },
        getMiniPrograms: () => [{ id: 'didi-charging' }],
        method1Service: { getWindowStatus: async () => ({ hasWechatWindow: true, hasTargetWindow: false, reason: 'target_window_missing' }) },
        captureRecorderService: { getStatus: () => ({ available: true, activeSession: null }) },
        apiTemplateModel: { getPlatformCoverage: () => [{ platform: 'didi-charging', activeListTemplates: 1, activeDetailTemplates: 2 }] },
        selfHealService,
        logger: { warn: message => warnings.push(message) },
    });

    const overview = await service.getOverview();
    assert.equal(overview.chainStatus.page.available, true);
    assert.equal(overview.chainStatus.page.blockingReason, 'target_window_missing');
    assert.deepEqual(overview.chainStatus.har.notes, ['ready']);
    assert.deepEqual(overview.chainStatus.api.notes, ['list=1', 'detail=2']);

    service.method1Service.getWindowStatus = async () => { throw new Error('probe failed'); };
    service.captureRecorderService.getStatus = () => { throw new Error('recorder failed'); };
    service.apiTemplateModel.getPlatformCoverage = () => { throw new Error('database failed'); };
    const degraded = await service.getOverview();
    assert.equal(degraded.chainStatus.page.blockingReason, 'wechat_status_unavailable');
    assert.equal(degraded.chainStatus.har.blockingReason, 'capture_recorder_unavailable');
    assert.equal(degraded.chainStatus.api.blockingReason, 'template_status_unavailable');
    assert.equal(warnings.length, 3);
});

test('运行概览优先使用目标感知的统一链路状态', async () => {
    const service = new RuntimeOverviewService({
        config: { automation: { enabled: true } },
        getMiniPrograms: () => [{ id: 'didi-charging' }],
        testChainOrchestrator: {
            getStatus: async () => ({
                chains: {
                    method1: { available: false, blockingReason: 'wechat_not_running', status: 'blocked', recommendedAction: '打开微信' },
                    method2: { available: true, blockingReason: '', status: 'ready', recommendedAction: '开始记录' },
                    method3: { available: false, blockingReason: 'template_missing', status: 'blocked', recommendedAction: '补充请求材料' },
                },
            }),
        },
        method1Service: { getWindowStatus: async () => ({ hasWechatWindow: true, hasTargetWindow: true }) },
        captureRecorderService: { getStatus: () => ({ available: false }) },
        apiTemplateModel: { getPlatformCoverage: () => [{ platform: 'didi-charging', activeListTemplates: 3 }] },
        selfHealService: {
            getAiFeatureStatus: () => ({ enabled: false }),
            getRuntimeMetadata: () => ({ enabled: false, status: 'planned' }),
        },
        logger: { warn: () => {} },
    });

    const overview = await service.getOverview();
    assert.equal(overview.chainStatus.page.available, false);
    assert.equal(overview.chainStatus.page.blockingReason, 'wechat_not_running');
    assert.equal(overview.chainStatus.har.available, true);
    assert.equal(overview.chainStatus.har.lastStatus, 'ready');
    assert.equal(overview.chainStatus.api.available, false);
    assert.equal(overview.chainStatus.api.blockingReason, 'template_missing');
    assert.deepEqual(overview.chainStatus.api.notes, ['补充请求材料']);
});

test('地理编码读取结构化预设并明确本地与高德坐标系', async () => {
    const presetsPath = path.join(__dirname, '../../frontend/public/china-city-presets.json');
    const presets = loadGeocodePresets(presetsPath);
    assert.ok(presets.length >= 80);
    let remoteCall = null;
    const service = new GeocodeService({
        presets,
        getApiKey: () => 'test-key',
        outboundClient: {
            fetchJson: async (url, options) => {
                remoteCall = { url, options };
                return {
                    status: '1',
                    geocodes: [{
                        location: '113.1234,23.5678',
                        formatted_address: '测试地址',
                        province: '广东',
                        city: '广州',
                        district: '海珠区',
                    }],
                };
            },
        },
    });

    const local = await service.search('虹桥站');
    assert.equal(local[0].name, '上海虹桥站');
    assert.equal(local[0].coordinateSystem, 'WGS84');
    assert.equal(remoteCall, null);

    const remote = await service.search('不存在于本地的测试地址');
    assert.equal(remote[0].coordinateSystem, 'GCJ02');
    assert.equal(new URL(remoteCall.url).hostname, 'restapi.amap.com');
    assert.equal(remoteCall.options.chain, 'geocode');
});

test('平台诊断关联最近一次平台结果并保留从未运行状态', () => {
    const service = new PlatformDiagnosticsService({
        apiTemplateModel: {
            getPlatformCoverage: () => [{
                platform: 'didi-charging', totalTemplates: 3, activeTemplates: 2,
                activeListTemplates: 1, activeDetailTemplates: 1,
            }],
        },
        runHistoryModel: {
            getRuns: limit => {
                assert.equal(limit, 100);
                return [{
                    runType: 'crawl-platforms-with-coordinates',
                    resultSummary: { summary: [{ platform: 'didi-charging', success: false, reason: 'template_expired' }] },
                }];
            },
        },
        getPlatformIds: () => ['didi-charging', 'teld'],
    });

    const result = service.list();
    assert.equal(result[0].latestRunStatus, 'failed');
    assert.equal(result[0].latestRunReason, 'template_expired');
    assert.equal(result[1].latestRunStatus, 'never_run');
});

test('服务入口不再执行临时目录 shell 或运行时 Function 解析城市数据', () => {
    const indexSource = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
    const legacyControllerName = ['Automation', 'Controller'].join('');
    const legacyCollectRoute = ["app.post('/api/", "collect'"].join('');
    assert.equal(indexSource.includes('/tmp/list-wx'), false);
    assert.equal(indexSource.includes('execSync('), false);
    assert.equal(indexSource.includes('Function(`"use strict"'), false);
    assert.equal(indexSource.includes(legacyControllerName), false);
    assert.equal(indexSource.includes(legacyCollectRoute), false);
});
