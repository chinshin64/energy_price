const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

// 加载配置
const config = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../config/settings.json'), 'utf8')
);

// 初始化数据库
const db = require('./database/init');
const StationModel = require('./models/station');
const ApiTemplateModel = require('./models/api-template');
const AppSettingModel = require('./models/app-setting');
const RunHistoryModel = require('./models/run-history');
const PriceScheduleModel = require('./models/price-schedule');
const AuditEventModel = require('./models/audit-event');
const ScheduleModel = require('./models/schedule');

// 服务类
const SmartCollectionController = require('./automation/smart-controller');
const HarParser = require('./parser/har-parser');
// CharlesRealtimeCapture removed — replaced by capture-recorder
const SchedulerManager = require('./scheduler/manager');
const SmartCrawler = require('./crawler/smart-crawler');
const TeldRuntimeParser = require('./parser/teld-runtime-parser');
const TeldOCRParser = require('./parser/teld-ocr-parser');
const GenericMiniAppOCRParser = require('./parser/generic-miniapp-ocr-parser');
const DidiOcrParser = require('./parser/didi-ocr-parser');
const AmapOcrParser = require('./parser/amap-ocr-parser');
const WechatLiveOCRService = require('./services/wechat-live-ocr');
const TaskSelfHealService = require('./services/task-self-heal');
const MobileSyncService = require('./services/mobile-sync');
const MobileSupervisorService = require('./services/mobile-supervisor');
const MobileCommandService = require('./services/mobile-command');
const OutboundClient = require('./services/outbound-client');
const CaptureRecorderService = require('./services/capture-recorder');
const SyncService = require('./services/sync-service');
const { RemoteMobileSourceSync } = require('./services/remote-mobile-source-sync');
const BlueTeamReportService = require('./services/blue-team-report-service');
const SignatureHealthMonitor = require('./services/signature-health-monitor');
const SignatureRefreshService = require('./services/signature-refresh-service');
const ExtractSignerUnified = require('./services/extract-signer-unified');
const LocationSimulator = require('./services/location-simulator');
const Method1Service = require('./services/method1-service');
const Method2Service = require('./services/method2-service');
const Method3Service = require('./services/method3-service');
const DidiSignatureProvider = require('./services/didi-signature-provider');
const BrowserSigner = require('./services/browser-signer');
const { EdgeGeoResolver } = require('./services/edge-geo-resolver');
const { EdgeAgentService } = require('./services/edge-agent-service');
const TestChainOrchestrator = require('./services/test-chain-orchestrator');
const GlobalAgentService = require('./services/global-agent-service');
const SelfHealApplicationService = require('./services/self-heal-application-service');
const RuntimeOverviewService = require('./services/runtime-overview-service');
const { GeocodeService } = require('./services/geocode-service');
const PlatformDiagnosticsService = require('./services/platform-diagnostics-service');
const ScheduledValidationExecutor = require('./services/scheduled-validation-executor');
const ScheduleApplicationService = require('./services/schedule-application-service');
const TemplateApplicationService = require('./services/template-application-service');
const { StationExportService } = require('./services/station-export-service');
const { AI_AGENT_MODEL_PRESETS, buildAiAgentConfig, publicConfig } = require('./services/ai-agent-client');
const { createSyncAuthMiddleware } = require('./middleware/sync-auth');
const { createAccessControl, readAuthConfig } = require('./middleware/access-control');
const { createCorsOptions, createOriginGuard, readCorsPolicy } = require('./middleware/cors-policy');
const { createMobileAccess } = require('./middleware/mobile-access');
const { redactObject, serializeRedacted } = require('./services/sensitive-redactor');
const { readRuntimeConfig } = require('./config/runtime');
const { createLocationRouter } = require('./routes/location');
const { createSystemRouter } = require('./routes/system');
const { createSignatureRouter } = require('./routes/signature');
const { createSettingsRouter } = require('./routes/settings');
const { createOutboundRouter } = require('./routes/outbound');
const { createCaptureRecorderRouter } = require('./routes/capture-recorder');
const { createBlueTeamReportsRouter } = require('./routes/blue-team-reports');
const { createTestChainsRouter } = require('./routes/test-chains');
const { createGlobalAgentRouter } = require('./routes/global-agent');
const { createAuditRouter } = require('./routes/audit');
const { createSyncRouter } = require('./routes/sync');
const { createMobileSourceSyncRouter } = require('./routes/mobile-source-sync');
const { createMobileSyncRouter } = require('./routes/mobile-sync');
const { createMobileControlRouter } = require('./routes/mobile-control');
const { createEdgeAgentRouter } = require('./routes/edge-agent');
const { createDataRouter } = require('./routes/data');
const { createOcrReviewRouter } = require('./routes/ocr-review');
const { createRuntimeOverviewRouter } = require('./routes/runtime-overview');
const { createSelfHealRouter } = require('./routes/self-heal');
const { createGeocodeRouter } = require('./routes/geocode');
const { createCrawlerSettingsRouter } = require('./routes/crawler-settings');
const { createPlatformDiagnosticsRouter } = require('./routes/platform-diagnostics');
const { createTemplatesRouter } = require('./routes/templates');
const { createSchedulesRouter } = require('./routes/schedules');
const { createExportRouter } = require('./routes/export');
const { createCollectRouter } = require('./routes/collect');
const { createMethod1Router } = require('./routes/method1');
const { createHarWorkflowRouter } = require('./routes/har-workflow');
const { createPageCaptureRouter } = require('./routes/page-capture');
const { createSmartCollectRouter } = require('./routes/smart-collect');
const {
    createCrawlerExecutionRouter,
    normalizeTargetLocation: normalizeCrawlerTargetLocation
} = require('./routes/crawler-execution');
const KuaidianCollector = require('./services/kuaidian-collector');
const { KuaidianCredentialProvider } = require('./services/kuaidian-credential-provider');
const TeldCollector = require('./services/teld-collector');
const TuanyouCollector = require('./services/tuanyou-collector');
const { TuanyouCredentialProvider } = require('./services/tuanyou-credential-provider');
const StarchargeCollector = require('./services/starcharge-collector');
const YkcCollector = require('./services/ykc-collector');
const XdtCollector = require('./services/xdt-collector');

// 创建 Express 应用
const app = express();
app.disable('x-powered-by');
app.locals.config = config;
const runtimeConfig = readRuntimeConfig({ server: config.server });
const PROJECT_ROOT = runtimeConfig.projectRoot;
const DATA_ROOT = runtimeConfig.dataRoot;
const PORT = runtimeConfig.port;
const trustedProxyIps = String(process.env.EDGE_TRUST_PROXY_IPS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
if (trustedProxyIps.length > 0) app.set('trust proxy', trustedProxyIps);
const HOST = runtimeConfig.host;
const AI_FEATURES_ENABLED = runtimeConfig.aiFeaturesEnabled;
const SIGNATURE_HEALTH_MONITOR_ENABLED = runtimeConfig.signatureHealthMonitorEnabled;
const requireSyncToken = createSyncAuthMiddleware();
const mobileAccess = createMobileAccess({ config });
const requireMobileSyncAccess = mobileAccess.middleware;
const getMobileSyncSettings = mobileAccess.getSettings;
const authConfig = readAuthConfig();
const accessControl = createAccessControl({
    config: authConfig,
    auditRecorder: event => AuditEventModel.record(event)
});
const corsPolicy = readCorsPolicy({ port: PORT });

function getEffectiveConfig() {
    return {
        ...config,
        aiAgent: AppSettingModel.getAiAgentSettings(config.aiAgent || {})
    };
}

function getAiAgentSettingsResponse() {
    const saved = AppSettingModel.getAiAgentSettings(config.aiAgent || {});
    const effective = buildAiAgentConfig({ aiAgent: saved });
    return {
        ...AppSettingModel.publicAiAgentSettings(saved),
        modelPresets: AI_AGENT_MODEL_PRESETS,
        effective: publicConfig(effective),
        envOverride: {
            mode: Boolean(process.env.AI_AGENT_MODE),
            type: Boolean(process.env.AI_AGENT_TYPE),
            baseUrl: Boolean(process.env.AI_AGENT_BASE_URL),
            apiKey: Boolean(process.env.AI_AGENT_API_KEY),
            modelId: Boolean(process.env.AI_AGENT_MODEL_ID)
        }
    };
}

app.locals.getEffectiveConfig = getEffectiveConfig;
// LEGACY_CHARLES_WATCH removed — capture-recorder is the only engine

// 中间件：先建立请求上下文、完成来源和身份校验，再解析请求体。
app.use((req, res, next) => {
    if (String(req.path || '').startsWith('/api/')) {
        const supplied = String(req.headers['x-request-id'] || '').trim();
        req.requestId = /^[a-zA-Z0-9._:-]{8,128}$/.test(supplied) ? supplied : crypto.randomUUID();
        res.setHeader('x-request-id', req.requestId);
        res.setHeader('Cache-Control', 'no-store');
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'; object-src 'none'; base-uri 'self'");
    next();
});
app.use(cors(createCorsOptions(corsPolicy)));
app.use(createOriginGuard(corsPolicy));
if (process.env.NODE_ENV !== 'test') {
    app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
}
app.use(accessControl);
// 机器通道在解析大请求体前完成凭据校验，路由层仍保留二次校验。
app.use('/api/sync/receive', requireSyncToken);
app.use('/api/mobile-sync', requireMobileSyncAccess);
app.use('/api/mobile-control', requireMobileSyncAccess);

const standardJsonParser = express.json({ limit: process.env.JSON_BODY_LIMIT || '2mb' });
const largeJsonParser = express.json({ limit: process.env.LARGE_JSON_BODY_LIMIT || '25mb' });
const largeJsonRoutes = [
    '/api/parse-har-upload',
    '/api/crawler/learn-upload',
    '/api/teld/runtime-capture',
    '/api/mobile-sync/ocr',
    '/api/mobile-sync/stations',
    '/api/sync/receive/report'
];
app.use((req, res, next) => {
    const requestPath = String(req.path || '');
    const parser = largeJsonRoutes.some(route => requestPath === route) ? largeJsonParser : standardJsonParser;
    return parser(req, res, next);
});
app.use(express.urlencoded({ limit: process.env.URLENCODED_BODY_LIMIT || '1mb', extended: true }));

app.use('/api', createSystemRouter({
    db,
    authConfig,
    version: process.env.APP_VERSION || 'development'
}));

// 静态文件服务（前端）
app.use(express.static(path.join(__dirname, '../frontend/public')));

// 方式二：电脑端微信小程序录包链路
const method2Router = require('./routes/method2');
app.use('/api/method2', method2Router);

// 方式三：后端直接发包验证
const method3Router = require('./routes/method3');
app.use('/api/method3', method3Router);

// AI Agent：OpenAI-compatible 请求失败诊断与策略建议
const aiAgentRouter = require('./routes/ai-agent');
app.use('/api/ai-agent', aiAgentRouter);

// 初始化服务
const harParser = new HarParser(config);
// realtimeCapture removed — capture-recorder is the only capture engine
const outboundClient = new OutboundClient({
    getProxySettings: () => AppSettingModel.getProxySettings(),
    evidenceDir: path.join(DATA_ROOT, 'outbound-evidence')
});
const browserSigner = new BrowserSigner();
const kuaidianCredentialProvider = KuaidianCredentialProvider.fromEnvironment(process.env);
const tuanyouCredentialProvider = TuanyouCredentialProvider.fromEnvironment(process.env);
const didiSignatureProvider = new DidiSignatureProvider({
    ...(config.didiSignatureProvider || {}),
    corpusPath: path.join(DATA_ROOT, 'didi-signature-corpus.json'),
    browserSigner
});
const smartCrawler = new SmartCrawler(harParser, {
    outboundClient,
    didiSignatureProvider,
    kuaidianCredentialProvider,
    tuanyouCredentialProvider,
    getProxySettings: () => AppSettingModel.getProxySettings(),
    getTestRequestLimit: () => AppSettingModel.getCrawlerTestRequestLimit(),
    getQuotaStatsStatus: () => AppSettingModel.getCrawlerRunQuotaStatus(),
    getPerRunLimit: () => AppSettingModel.getCrawlerPerRunLimit(),
    recordDailyRequest: (payload) => AppSettingModel.recordCrawlerDailyRequest(payload)
});
const teldRuntimeParser = new TeldRuntimeParser();
const teldOCRParser = new TeldOCRParser();
const genericMiniAppOCRParser = new GenericMiniAppOCRParser();
const didiOcrParser = new DidiOcrParser();
const amapOcrParser = new AmapOcrParser();
const wechatLiveOCRService = new WechatLiveOCRService({
    projectRoot: path.join(__dirname, '..'),
    parsers: {
        teld: teldOCRParser,
        'didi-charging': didiOcrParser,
        'amap-charging': amapOcrParser,
        'star-charge': genericMiniAppOCRParser,
        kuaidian: genericMiniAppOCRParser,
        tuanyou: genericMiniAppOCRParser,
        ykc: genericMiniAppOCRParser
    },
    defaultParser: genericMiniAppOCRParser
});
const smartController = new SmartCollectionController(config, null, harParser, {
    pageReaders: {
        teld: wechatLiveOCRService,
        'didi-charging': wechatLiveOCRService,
        'star-charge': wechatLiveOCRService,
        kuaidian: wechatLiveOCRService,
        tuanyou: wechatLiveOCRService,
        ykc: wechatLiveOCRService
    }
});
const method1Service = new Method1Service({
    projectRoot: path.join(__dirname, '..'),
    smartController,
    reader: wechatLiveOCRService,
    getMiniProgram: platformId => findRuntimeMiniProgram(platformId)
});
const SUPPORTED_PLATFORMS = ['didi-charging', 'amap-charging', 'teld', 'star-charge', 'kuaidian', 'tuanyou', 'ykc', 'xdt'];
const PLATFORM_SCOPE = String(process.env.PLATFORM_SCOPE || '').trim().toLowerCase();

function getRuntimeMiniPrograms() {
    const miniPrograms = Array.isArray(config.wechat?.miniPrograms) ? config.wechat.miniPrograms : [];
    if (['didi', 'didi-only', 'didi-charging'].includes(PLATFORM_SCOPE)) {
        return miniPrograms.filter(item => item.id === 'didi-charging');
    }
    return miniPrograms;
}

function getRuntimePlatformIds() {
    return getRuntimeMiniPrograms().map(item => item.id);
}

function findRuntimeMiniProgram(platformId) {
    return getRuntimeMiniPrograms().find(item => item.id === platformId);
}

function findMissingRuntimePlatform(platformList = []) {
    const runtimePlatformIds = new Set(getRuntimePlatformIds());
    return platformList.find(platformId => !runtimePlatformIds.has(platformId));
}

const mobileSyncService = new MobileSyncService({
    parsers: {
        teld: teldOCRParser,
        'didi-charging': didiOcrParser,
        'amap-charging': amapOcrParser,
        'star-charge': genericMiniAppOCRParser,
        kuaidian: genericMiniAppOCRParser,
        tuanyou: genericMiniAppOCRParser,
        ykc: genericMiniAppOCRParser
    },
    defaultParser: genericMiniAppOCRParser,
    supportedPlatforms: SUPPORTED_PLATFORMS,
    insertStations: (stations) => StationModel.insertBatch(stations)
});
const mobileSupervisorService = new MobileSupervisorService({
    dataDir: path.join(DATA_ROOT, 'mobile-supervisor'),
    enabled: AI_FEATURES_ENABLED
});
const mobileCommandService = new MobileCommandService({
    dataDir: path.join(DATA_ROOT, 'mobile-commands'),
    countCityStats: countMobileCityStats,
    aiFeaturesEnabled: AI_FEATURES_ENABLED,
    dcc: {
        enabled: AI_FEATURES_ENABLED && (
            String(process.env.MOBILE_INTENT_DCC_ENABLED || '').toLowerCase() === 'true'
            || Boolean(process.env.MOBILE_INTENT_DCC_URL || process.env.DCC_URL || process.env.MOBILE_INTENT_DCC_COMMAND)
        ),
        url: process.env.MOBILE_INTENT_DCC_URL || process.env.DCC_URL || '',
        command: process.env.MOBILE_INTENT_DCC_COMMAND || '',
        cwd: process.env.MOBILE_INTENT_DCC_CWD || path.join(__dirname, '..'),
        timeoutMs: Number(process.env.MOBILE_INTENT_DCC_TIMEOUT_MS || 8000),
        maxTimeoutMs: Number(process.env.MOBILE_INTENT_DCC_MAX_TIMEOUT_MS || 12000),
        authHeader: process.env.MOBILE_INTENT_DCC_AUTH_HEADER || '',
        authToken: process.env.MOBILE_INTENT_DCC_AUTH_TOKEN || ''
    }
});
const edgeGeoResolver = new EdgeGeoResolver({
    rulesPath: process.env.EDGE_GEO_RULES_PATH
        || path.join(PROJECT_ROOT, 'config', 'edge-geo-rules.json'),
    providerUrl: process.env.EDGE_GEO_PROVIDER_URL || ''
});
const edgeAgentService = new EdgeAgentService({
    statePath: path.join(DATA_ROOT, 'edge-agents', 'state.json'),
    geoResolver: edgeGeoResolver,
    enrollmentToken: process.env.EDGE_AGENT_ENROLLMENT_TOKEN || '',
    production: runtimeConfig.nodeEnv === 'production'
});
const captureRecorderService = new CaptureRecorderService({
    projectRoot: path.join(__dirname, '..'),
    dataDir: path.join(DATA_ROOT, 'capture-sessions'),
    scriptPath: path.join(__dirname, '../scripts/mitm-har-dump.py'),
    bin: process.env.CAPTURE_RECORDER_BIN || '',
    listenHost: process.env.CAPTURE_RECORDER_HOST || '0.0.0.0',
    listenPort: Number(process.env.CAPTURE_RECORDER_PORT || 8899),
    filterHosts: process.env.CAPTURE_RECORDER_FILTER_HOSTS || '',
    filterIps: process.env.CAPTURE_RECORDER_FILTER_IPS || ''
});
const blueTeamReportService = new BlueTeamReportService({
    rootDir: path.join(DATA_ROOT, 'blue-team-reports')
});
const signatureHealthMonitor = new SignatureHealthMonitor({
    corpusPath: path.join(DATA_ROOT, 'didi-signature-corpus.json')
});
const locationSimulator = new LocationSimulator({ projectRoot: PROJECT_ROOT });
const extractSignerUnified = new ExtractSignerUnified();
const signatureRefreshService = new SignatureRefreshService({
    captureRecorder: captureRecorderService,
    mobileCommandService: mobileCommandService,
    extractSigner: extractSignerUnified,
    corpusPath: path.join(DATA_ROOT, 'didi-signature-corpus.json')
});
const chainSignatureProvider = didiSignatureProvider;
const method2ServiceForOrchestrator = new Method2Service({
    recorder: captureRecorderService,
    harParser,
    stationModel: StationModel,
    pageAutomation: method1Service,
    aiAgentConfig: getEffectiveConfig()
});
app.locals.method2Service = method2ServiceForOrchestrator;
const method3ServiceForOrchestrator = new Method3Service({
    signatureProvider: chainSignatureProvider,
    aiAgentConfig: getEffectiveConfig(),
    templateDir: DATA_ROOT
});
app.locals.method3Service = method3ServiceForOrchestrator;
const testChainOrchestrator = new TestChainOrchestrator({
    projectRoot: path.join(__dirname, '..'),
    method1Service,
    method2Service: method2ServiceForOrchestrator,
    method3Service: method3ServiceForOrchestrator,
    reportService: blueTeamReportService
});
const scheduledValidationExecutor = new ScheduledValidationExecutor({
    orchestrator: testChainOrchestrator,
    runHistoryModel: RunHistoryModel,
});
const scheduler = new SchedulerManager({
    repository: ScheduleModel,
    executor: scheduledValidationExecutor,
    restoreOnStart: false,
});
const globalAgentService = new GlobalAgentService({
    orchestrator: testChainOrchestrator,
    reportService: blueTeamReportService,
    mobileCommandService,
    config: getEffectiveConfig()
});
function refreshAiAgentRuntimeConfig() {
    const effectiveConfig = getEffectiveConfig();
    app.locals.config = effectiveConfig;
    app.locals.getEffectiveConfig = getEffectiveConfig;
    globalAgentService.setConfig(effectiveConfig);
    method2ServiceForOrchestrator.setAiAgentConfig(effectiveConfig);
    method3ServiceForOrchestrator.setAiAgentConfig(effectiveConfig);
    return effectiveConfig;
}
const syncUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: Math.max(1024, Number(process.env.SYNC_EVIDENCE_MAX_BYTES) || 10 * 1024 * 1024) }
});
const syncService = new SyncService({
    nodesPath: path.join(__dirname, '../config/sync-nodes.json'),
    blueTeamReportService,
    statePath: path.join(DATA_ROOT, 'sync-state.json'),
    localNodeUrl: `http://127.0.0.1:${PORT}`,
});
const remoteMobileSourceSync = new RemoteMobileSourceSync({
    stationModel: StationModel,
    statePath: path.join(DATA_ROOT, 'mobile-source-sync-state.json'),
});
app.locals.remoteMobileSourceSync = remoteMobileSourceSync;
const selfHealApplicationService = new SelfHealApplicationService({
    appSettingModel: AppSettingModel,
    diagnosticService: TaskSelfHealService,
    enabled: AI_FEATURES_ENABLED,
});
const runtimeOverviewService = new RuntimeOverviewService({
    config,
    getMiniPrograms: getRuntimeMiniPrograms,
    method1Service,
    captureRecorderService,
    apiTemplateModel: ApiTemplateModel,
    selfHealService: selfHealApplicationService,
    testChainOrchestrator,
});
const geocodeService = new GeocodeService({
    presetsPath: path.join(PROJECT_ROOT, 'frontend/public/china-city-presets.json'),
    outboundClient,
    getApiKey: () => process.env.AMAP_WEB_SERVICE_KEY || process.env.AMAP_KEY || '',
});
const platformDiagnosticsService = new PlatformDiagnosticsService({
    apiTemplateModel: ApiTemplateModel,
    runHistoryModel: RunHistoryModel,
    getPlatformIds: getRuntimePlatformIds,
});
const templateApplicationService = new TemplateApplicationService({
    templateModel: ApiTemplateModel,
    stationModel: StationModel,
    smartCrawler,
    getPlatformIds: getRuntimePlatformIds,
    normalizeTargetLocation: normalizeCrawlerTargetLocation,
});
const scheduleApplicationService = new ScheduleApplicationService({
    scheduler,
    selfHealService: selfHealApplicationService,
    appSettingModel: AppSettingModel,
    getPlatformIds: getRuntimePlatformIds,
    defaultTimezone: process.env.SCHEDULE_TIMEZONE || 'Asia/Shanghai',
});
const stationExportService = new StationExportService({
    stationModel: StationModel,
    maxRows: process.env.EXPORT_MAX_ROWS || 50000,
});
const buildAiFeatureStatus = () => selfHealApplicationService.getAiFeatureStatus();
const recoveredRunResult = RunHistoryModel.markInterruptedRuns();
if (recoveredRunResult.changes > 0) {
    console.log(`Recovered ${recoveredRunResult.changes} stale running crawl runs`);
}
const smartCollectRoutes = createSmartCollectRouter({
    smartController,
    captureRecorderService,
    harParser,
    stationModel: StationModel,
    smartCrawler,
    apiTemplateModel: ApiTemplateModel,
    appSettingModel: AppSettingModel,
    taskSelfHealService: TaskSelfHealService,
    aiFeaturesEnabled: AI_FEATURES_ENABLED,
    buildAiFeatureStatus,
    findMissingRuntimePlatform,
    logger: console,
});
const crawlerExecutionRoutes = createCrawlerExecutionRouter({
    smartCrawler,
    stationModel: StationModel,
    apiTemplateModel: ApiTemplateModel,
    runHistoryModel: RunHistoryModel,
    harParser,
    selfHealService: selfHealApplicationService,
    templateApplicationService,
    SmartCrawlerClass: SmartCrawler,
    logger: console,
});

function countMobileCityStats(city) {
    const row = db.prepare(`
        SELECT COUNT(*) AS total,
               COUNT(DISTINCT station_name) AS distinct_names
        FROM stations
        WHERE platform = 'didi-charging'
          AND source_type = 'mobile-ocr'
          AND json_extract(raw_data, '$.mobileSync.meta.city') = ?
          AND station_name NOT LIKE '%可用券%'
          AND station_name NOT LIKE '%余额%'
          AND station_name NOT LIKE '%余額%'
          AND station_name NOT LIKE '%余领%'
          AND station_name NOT LIKE '%余颌%'
          AND station_name NOT LIKE '%即插即充%'
          AND station_name NOT LIKE '%可用充电%'
          AND station_name NOT LIKE '%场站专属%'
          AND station_name NOT LIKE '%停车减免%'
    `).get(city);
    return {
        city,
        total: Number(row?.total) || 0,
        distinct: Number(row?.distinct_names) || 0
    };
}

// 监听智能控制器事件
smartController.on('status', (status) => {
    console.log(`📊 状态更新:`, status);
    // 可以通过 WebSocket 推送到前端
});

smartController.on('complete', (result) => {
    console.log(`✅ 采集完成:`, result);
    const captureResult = smartCollectRoutes.stopCaptureSession(result.sessionId, result.cancelled ? 'cancelled' : 'complete');
    if (captureResult) {
        console.log('📦 内置录包会话已停止:', captureResult);
        smartCollectRoutes.analyzeCaptureSession(result.sessionId, captureResult, result.cancelled ? 'cancelled' : 'complete')
            .then(analysis => console.log('🧪 HAR 自动分析完成:', analysis))
            .catch(error => console.warn('HAR 自动分析失败:', error.message));
    }
    // 保存到数据库
    if (result.stationCount > 0) {
        // 数据已由 capture-recorder 处理
    }
});

// ============ API 路由 ============

app.use('/api', createRuntimeOverviewRouter({ service: runtimeOverviewService }));
app.use('/api/self-heal', createSelfHealRouter({ service: selfHealApplicationService }));
app.use('/api/geocode', createGeocodeRouter({ service: geocodeService }));
app.use('/api/crawler', createCrawlerSettingsRouter({ appSettingModel: AppSettingModel }));
app.use('/api/diagnostics', createPlatformDiagnosticsRouter({ service: platformDiagnosticsService }));
app.use('/api/templates', createTemplatesRouter({ service: templateApplicationService }));
app.use('/api/schedules', createSchedulesRouter({ service: scheduleApplicationService }));
app.use('/api/export', createExportRouter({ service: stationExportService }));
app.use('/api/method1', createMethod1Router({ service: method1Service }));
app.use('/api', createHarWorkflowRouter({
    dataRoot: DATA_ROOT,
    harParser,
    stationModel: StationModel,
    smartCrawler,
    runHistoryModel: RunHistoryModel,
    apiTemplateModel: ApiTemplateModel,
    redactObject,
    logger: console
}));
app.use('/api', createPageCaptureRouter({
    dataRoot: DATA_ROOT,
    teldRuntimeParser,
    stationModel: StationModel,
    wechatLiveOcrService: wechatLiveOCRService,
    getMiniProgram: findRuntimeMiniProgram,
    serializeRedacted,
    logger: console
}));
app.use('/api', smartCollectRoutes.router);

app.use('/api/mobile-sync', createMobileSyncRouter({
    syncService: mobileSyncService,
    supervisorService: mobileSupervisorService,
    commandService: mobileCommandService,
    getSettings: getMobileSyncSettings,
    aiFeaturesEnabled: AI_FEATURES_ENABLED,
    buildAiFeatureStatus,
}));
app.use('/api/mobile-control', createMobileControlRouter({
    commandService: mobileCommandService,
    getSettings: getMobileSyncSettings,
    authMode: authConfig.mode,
}));
app.use('/api/edge', createEdgeAgentRouter({ service: edgeAgentService }));
app.use('/api', createDataRouter({
    stationModel: StationModel,
    priceScheduleModel: PriceScheduleModel,
    runHistoryModel: RunHistoryModel,
}));
app.use('/api', createOcrReviewRouter({ stationModel: StationModel }));

app.use('/api/collect', createCollectRouter({
    stationModel: StationModel,
    KuaidianCollector,
    TeldCollector,
    TuanyouCollector,
    StarchargeCollector,
    YkcCollector,
    XdtCollector,
    browserSigner,
    kuaidianCredentialProvider,
    tuanyouCredentialProvider,
    logger: typeof console !== 'undefined' ? (msg, level) => console[level === 'error' ? 'error' : 'log'](msg) : null
}));

app.use('/api/settings', createSettingsRouter({
    appSettingModel: AppSettingModel,
    getAiAgentSettingsResponse,
    refreshAiAgentRuntimeConfig,
    modelPresets: AI_AGENT_MODEL_PRESETS,
    aiAgentDefaults: config.aiAgent || {},
}));
app.use('/api/outbound', createOutboundRouter({ client: outboundClient }));
app.use('/api/capture-recorder', createCaptureRecorderRouter({ service: captureRecorderService }));
app.use('/api/blue-team/reports', createBlueTeamReportsRouter({ service: blueTeamReportService }));
app.use('/api/test-chains', createTestChainsRouter({ orchestrator: testChainOrchestrator }));
app.use('/api/global-agent', createGlobalAgentRouter({
    service: globalAgentService,
    modelPresets: AI_AGENT_MODEL_PRESETS,
    appSettingModel: AppSettingModel,
    aiAgentDefaults: config.aiAgent || {},
    refreshRuntimeConfig: refreshAiAgentRuntimeConfig,
    getSettingsResponse: getAiAgentSettingsResponse,
}));
app.use('/api/audit', createAuditRouter({ model: AuditEventModel }));
app.use('/api/sync', createSyncRouter({
    service: syncService,
    requireToken: requireSyncToken,
    upload: syncUpload,
}));
app.use('/api/mobile-source-sync', createMobileSourceSyncRouter({ service: remoteMobileSourceSync }));
app.use('/api', crawlerExecutionRoutes.router);

app.use('/api/signature', createSignatureRouter({
    healthMonitor: signatureHealthMonitor,
    refreshService: signatureRefreshService,
}));
app.use('/api/location', createLocationRouter({ simulator: locationSimulator }));

app.use('/api', (req, res) => {
    res.status(404).json({
        success: false,
        error: 'API route not found',
        code: 'route_not_found',
        requestId: req.requestId
    });
});

app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const tooLarge = error?.type === 'entity.too.large' || error?.code === 'LIMIT_FILE_SIZE';
    const statusCode = tooLarge ? 413 : (error.statusCode || error.status || 500);
    if (statusCode >= 500) {
        console.error('请求处理失败:', error.message);
    }
    return res.status(statusCode).json({
        success: false,
        error: tooLarge ? 'Request payload is too large' : (error.message || 'Internal server error'),
        code: tooLarge ? 'payload_too_large' : (error.code || 'internal_error'),
        requestId: req.requestId
    });
});

let server = null;

function startServer() {
    if (server) return server;
    scheduler.restore();
    remoteMobileSourceSync.start();
    if (SIGNATURE_HEALTH_MONITOR_ENABLED) {
        signatureHealthMonitor.startPeriodicCheck();
    }
    browserSigner.init()
        .then(status => {
            const available = Object.values(status.platforms || {}).filter(item => item.available).length;
            console.log(`Browser signer ready: ${available}/${BrowserSigner.SUPPORTED_PLATFORMS.length} platforms`);
        })
        .catch(error => {
            console.warn(`Browser signer unavailable, collectors will use fallback: ${error.message}`);
        });
    server = app.listen(PORT, HOST, () => {
        const address = server.address();
        const boundPort = typeof address === 'object' && address ? address.port : PORT;
        console.log(`Blue Team service listening on http://${HOST}:${boundPort}`);
        console.log(`Authentication mode: ${authConfig.mode}`);
        console.log(`Scheduled tasks: ${scheduler.tasks.size}`);
    });
    return server;
}

async function stopServer() {
    remoteMobileSourceSync.stop();
    signatureHealthMonitor.stopPeriodicCheck();
    scheduler.shutdown();
    try {
        await browserSigner.close();
    } catch (error) {
        console.warn(`Browser signer shutdown failed: ${error.message}`);
    }
    if (!server) return;
    await new Promise((resolve, reject) => {
        server.close(error => {
            server = null;
            if (error) reject(error);
            else resolve();
        });
    });
}

if (require.main === module) {
    startServer();
    const shutdown = signal => {
        console.log(`Received ${signal}, stopping service`);
        stopServer()
            .then(() => db.close())
            .then(() => process.exit(0))
            .catch(error => {
                console.error('Service shutdown failed:', error.message);
                process.exit(1);
            });
    };
    process.once('SIGTERM', () => shutdown('SIGTERM'));
    process.once('SIGINT', () => shutdown('SIGINT'));
}

module.exports = {
    app,
    authConfig,
    startServer,
    stopServer
};
