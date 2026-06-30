const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execSync } = require('child_process');
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

// 服务类
const AutomationController = require('./automation/controller');
const SmartCollectionController = require('./automation/smart-controller');
const HarParser = require('./parser/har-parser');
// CharlesRealtimeCapture removed — replaced by capture-recorder
const SchedulerManager = require('./scheduler/manager');
const SmartCrawler = require('./crawler/smart-crawler');
const TeldRuntimeParser = require('./parser/teld-runtime-parser');
const TeldOCRParser = require('./parser/teld-ocr-parser');
const GenericMiniAppOCRParser = require('./parser/generic-miniapp-ocr-parser');
const DidiOcrParser = require('./parser/didi-ocr-parser');
const WechatLiveOCRService = require('./services/wechat-live-ocr');
const TaskSelfHealService = require('./services/task-self-heal');
const MobileSyncService = require('./services/mobile-sync');
const MobileSupervisorService = require('./services/mobile-supervisor');
const MobileCommandService = require('./services/mobile-command');
const OutboundClient = require('./services/outbound-client');
const CaptureRecorderService = require('./services/capture-recorder');
const SyncService = require('./services/sync-service');
const BlueTeamReportService = require('./services/blue-team-report-service');
const SignatureHealthMonitor = require('./services/signature-health-monitor');
const SignatureRefreshService = require('./services/signature-refresh-service');
const ExtractSignerUnified = require('./services/extract-signer-unified');
const Method1Service = require('./services/method1-service');

// 创建 Express 应用
const app = express();
app.locals.config = config;
const PORT = Number(process.env.PORT || config.server.port || 3000);
const AI_FEATURES_ENABLED = /^(1|true|yes|on)$/i.test(String(process.env.AI_FEATURES_ENABLED || ''));
// LEGACY_CHARLES_WATCH removed — capture-recorder is the only engine

// 中间件
// T4 安全止血：CORS收窄，仅允许本地和内网访问
app.use(cors({
    origin: ['http://localhost:3000', 'http://172.23.32.250:50080'],
    credentials: true
}));
app.use(express.json({ limit: '50mb' })); // 增加请求体大小限制，支持大型 HAR 文件
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(morgan('dev'));

// 访问鉴权已移除：当前部署环境通过网络边界控制访问权限。
// 注意：这里仅取消 API token 校验；业务侧的脱敏、范围限制、签名匹配和请求上限仍然保留。
app.use((req, res, next) => next());

// 健康检查端点
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

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
const automation = new AutomationController(config);
const harParser = new HarParser(config);
// realtimeCapture removed — capture-recorder is the only capture engine
const scheduler = new SchedulerManager();
const outboundClient = new OutboundClient({
    getProxySettings: () => AppSettingModel.getProxySettings(),
    evidenceDir: path.join(__dirname, '../data/outbound-evidence')
});
const smartCrawler = new SmartCrawler(harParser, {
    outboundClient,
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
const wechatLiveOCRService = new WechatLiveOCRService({
    projectRoot: path.join(__dirname, '..'),
    parsers: {
        teld: teldOCRParser,
        'didi-charging': didiOcrParser,
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
const SUPPORTED_PLATFORMS = ['didi-charging', 'teld', 'star-charge', 'kuaidian', 'tuanyou', 'ykc'];
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
    dataDir: path.join(__dirname, '../data/mobile-supervisor'),
    enabled: AI_FEATURES_ENABLED
});
const mobileCommandService = new MobileCommandService({
    dataDir: path.join(__dirname, '../data/mobile-commands'),
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
const captureRecorderService = new CaptureRecorderService({
    projectRoot: path.join(__dirname, '..'),
    dataDir: path.join(__dirname, '../data/capture-sessions'),
    scriptPath: path.join(__dirname, '../scripts/mitm-har-dump.py'),
    bin: process.env.CAPTURE_RECORDER_BIN || '',
    listenHost: process.env.CAPTURE_RECORDER_HOST || '0.0.0.0',
    listenPort: Number(process.env.CAPTURE_RECORDER_PORT || 8899),
    filterHosts: process.env.CAPTURE_RECORDER_FILTER_HOSTS || '',
    filterIps: process.env.CAPTURE_RECORDER_FILTER_IPS || ''
});
const blueTeamReportService = new BlueTeamReportService({
    rootDir: path.join(__dirname, '../data/blue-team-reports')
});
const signatureHealthMonitor = new SignatureHealthMonitor({
    corpusPath: path.join(__dirname, '../data/didi-signature-corpus.json')
});
const extractSignerUnified = new ExtractSignerUnified();
const signatureRefreshService = new SignatureRefreshService({
    captureRecorder: captureRecorderService,
    mobileCommandService: mobileCommandService,
    extractSigner: extractSignerUnified,
    corpusPath: path.join(__dirname, '../data/didi-signature-corpus.json')
});
const syncUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
const syncService = new SyncService({
    nodesPath: path.join(__dirname, '../config/sync-nodes.json'),
    blueTeamReportService,
    statePath: path.join(__dirname, '../data/sync-state.json'),
});
const LOCAL_GEOCODE_LOCATIONS = loadLocalCityPresets();
const recoveredRunResult = RunHistoryModel.markInterruptedRuns();
if (recoveredRunResult.changes > 0) {
    console.log(`Recovered ${recoveredRunResult.changes} stale running crawl runs`);
}

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

function buildRuntimeModeSummary(mode) {
    const isPreview = mode === 'preview';
    return {
        mode,
        title: isPreview ? '本地预览模式' : '完整执行模式',
        description: isPreview ? '预览' : '完整',
        restrictions: []
    };
}

function buildCollectionModes() {
    return {
        page: [
            {
                id: 'page-auto',
                name: '自动下滑 OCR',
                recommended: false,
                description: '由系统尝试控制页面下滑并执行 OCR 识别，适合可稳定自动滚动的平台。'
            },
            {
                id: 'page-assisted',
                name: '人工辅助模式',
                recommended: true,
                description: '用户手动在微信小程序中下滑，系统后台周期截图并做 OCR 增量识别。适合 macOS 微信小程序场景。'
            }
        ]
    };
}

function buildAiFeatureStatus() {
    return {
        enabled: AI_FEATURES_ENABLED,
        status: AI_FEATURES_ENABLED ? 'enabled' : 'planned',
        message: AI_FEATURES_ENABLED ? '已启用' : '未接入',
        plannedItems: [
            '手机控制自然语言指令解析',
            '移动端监督与页面决策',
            '自动排查与自愈诊断'
        ]
    };
}

function buildAiDisabledResponse(featureName = '智能能力') {
    return {
        success: false,
        code: 'ai_feature_planned',
        error: `${featureName}已暂时下线，标记为后续版本更新项。`,
        aiFeatures: buildAiFeatureStatus()
    };
}

function buildChainStatus(mode = 'full') {
    return {
        page: {
            chain: 'page',
            label: '页面自动化识别',
            enabled: true,
            available: true,
            blockingReason: '',
            capabilities: ['窗口截图', 'OCR 识别', '单页识别', '人工辅助增量采集'],
            lastStatus: 'idle',
            recommendedMode: 'page-assisted',
            notes: ['人工辅助优先']
        },
        har: {
            chain: 'har',
            label: '后台自动化识别',
            enabled: true,
            available: true,
            blockingReason: '',
            capabilities: ['自动化流程编排', '内置录包服务', 'HAR 自动分析', '模板学习'],
            lastStatus: 'idle',
            notes: ['录包/HAR']
        },
        api: {
            chain: 'api',
            label: '流量自动化识别',
            enabled: true,
            available: true,
            blockingReason: '',
            capabilities: ['模板请求', '坐标爬取', '详情补齐', '配额控制'],
            lastStatus: 'idle',
            notes: ['模板/签名']
        }
    };
}

function detectWechatWindowStatus() {
    try {
        const output = execSync('/tmp/list-wx 2>/dev/null || true', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        const hasDidiWindow = /\|\s*滴滴充电\s*\|/.test(output);
        const hasWechatWindow = /\|\s*微信\s*\|/.test(output) || /微信/.test(output);
        return {
            hasWechatWindow,
            hasTargetWindow: hasDidiWindow,
            raw: output.trim()
        };
    } catch (error) {
        return {
            hasWechatWindow: false,
            hasTargetWindow: false,
            raw: ''
        };
    }
}

function detectCaptureRecorderStatus() {
    try {
        const output = execSync("ps aux | grep -i mitmdump | grep -v grep || true", { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        return {
            running: output.trim().length > 0,
            raw: output.trim()
        };
    } catch (error) {
        return { running: false, raw: '' };
    }
}

function buildDynamicChainStatus(mode = 'full') {
    const status = buildChainStatus(mode);
    const wechatWindow = detectWechatWindowStatus();
    const recorder = captureRecorderService.getStatus();
    const coverageList = ApiTemplateModel.getPlatformCoverage();
    const coverageMap = new Map(coverageList.map(item => [item.platform, item]));

    if (!wechatWindow.hasWechatWindow) {
        status.page.available = false;
        status.page.blockingReason = 'wechat_not_running';
        status.page.notes = ['微信未就绪'];
    } else if (!wechatWindow.hasTargetWindow) {
        status.page.available = true;
        status.page.blockingReason = 'target_window_missing';
        status.page.notes = ['target_missing'];
    }

    if (!recorder.available) {
        status.har.available = false;
        status.har.blockingReason = 'capture_recorder_unavailable';
        status.har.notes = ['mitmdump_missing'];
    } else if (recorder.activeSession) {
        status.har.notes = [`recording:${recorder.activeSession.listenHost}:${recorder.activeSession.listenPort}`];
    } else {
        status.har.notes = ['ready'];
    }

    const didiCoverage = coverageMap.get('didi-charging');
    if (!didiCoverage || !didiCoverage.activeListTemplates) {
        status.api.available = false;
        status.api.blockingReason = 'template_missing';
        status.api.notes = ['template_missing'];
    } else {
        status.api.notes = [
            `list=${didiCoverage.activeListTemplates || 0}`,
            `detail=${didiCoverage.activeDetailTemplates || 0}`
        ];
    }

    return status;
}

function normalizeCrawlMode(value) {
    const mode = String(value || 'both').toLowerCase();
    return ['list', 'detail', 'both'].includes(mode) ? mode : null;
}

function normalizeTestMode(value) {
    return value === true || value === 'true' || value === 1 || value === '1';
}

function isSupportedProxyUrl(value) {
    return /^(http|https|socks4|socks5):\/\//i.test(String(value || '').trim());
}

function normalizeNetworkSettingsPayload(body = {}) {
    const defaultProxyUrl = String(body.defaultProxyUrl || body.proxyUrl || '').trim();
    if (defaultProxyUrl && !isSupportedProxyUrl(defaultProxyUrl)) {
        throw new Error('defaultProxyUrl must start with http://, https://, socks4:// or socks5://');
    }

    const cityProxyPool = Array.isArray(body.cityProxyPool)
        ? body.cityProxyPool.map((item = {}, index) => {
            const proxyUrl = String(item.proxyUrl || '').trim();
            if (proxyUrl && !isSupportedProxyUrl(proxyUrl)) {
                throw new Error(`cityProxyPool[${index}].proxyUrl must start with http://, https://, socks4:// or socks5://`);
            }

            return {
                enabled: item.enabled !== false,
                province: String(item.province || '').trim(),
                city: String(item.city || '').trim(),
                proxyUrl
            };
        }).filter(item => item.province || item.city || item.proxyUrl)
        : [];

    const provider = body.providerProxy && typeof body.providerProxy === 'object'
        ? body.providerProxy
        : {};
    const providerApiUrl = String(provider.apiUrl || '').trim();
    if (providerApiUrl && !/^https?:\/\//i.test(providerApiUrl)) {
        throw new Error('providerProxy.apiUrl must start with http:// or https://');
    }

    return {
        enabled: Boolean(body.enabled),
        defaultProxyUrl,
        autoCityProxyEnabled: Boolean(body.autoCityProxyEnabled),
        cityProxyPool,
        providerProxy: {
            enabled: Boolean(provider.enabled),
            apiUrl: providerApiUrl,
            authHeader: String(provider.authHeader || '').trim(),
            authToken: String(provider.authToken || '').trim(),
            ttlMinutes: Math.max(1, Math.floor(Number(provider.ttlMinutes) || 10))
        }
    };
}

function normalizeTargetLocation(raw = {}, centerLat = null, centerLng = null) {
    const input = raw && typeof raw === 'object' ? raw : {};
    const lat = Number(input.lat ?? centerLat);
    const lng = Number(input.lng ?? centerLng);

    return {
        keyword: String(input.keyword || input.name || '').trim(),
        name: String(input.name || input.keyword || '').trim(),
        province: String(input.province || '').trim(),
        city: String(input.city || '').trim(),
        district: String(input.district || '').trim(),
        lat: Number.isFinite(lat) ? lat : null,
        lng: Number.isFinite(lng) ? lng : null,
        requestParams: normalizeTargetRequestParams(
            input.requestParams
            || input.actualRequestParams
            || input.didiRequestParams
            || null
        )
    };
}

function normalizeTargetRequestParams(raw = null) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return null;
    }

    const normalizeObject = (value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return {};
        }

        return Object.entries(value).reduce((result, [key, entryValue]) => {
            if (!key || entryValue === undefined || entryValue === null) {
                return result;
            }
            if (typeof entryValue === 'object') {
                return result;
            }
            result[String(key)] = entryValue;
            return result;
        }, {});
    };

    const normalizeMaterial = (value = {}) => {
        const material = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
        const normalized = {
            queryParams: normalizeObject(material.queryParams || material.query || {}),
            bodyParams: normalizeObject(material.bodyParams || material.body || {}),
            headers: normalizeObject(material.headers || {})
        };
        for (const key of ['method', 'baseUrl', 'url', 'lat', 'lng', 'pageNo', 'city', 'keyword', 'capturedAt', 'createdAt', 'stationId', 'fullStationId']) {
            const entryValue = material[key];
            if (entryValue !== undefined && entryValue !== null && typeof entryValue !== 'object') {
                normalized[key] = entryValue;
            }
        }
        return normalized;
    };

    const direct = normalizeMaterial(raw);
    const scoped = {};
    for (const scope of ['list', 'detail']) {
        if (raw[scope] && typeof raw[scope] === 'object' && !Array.isArray(raw[scope])) {
            scoped[scope] = normalizeMaterial(raw[scope]);
        }
    }

    const hasDirect = Object.keys(direct.queryParams).length > 0
        || Object.keys(direct.bodyParams).length > 0
        || Object.keys(direct.headers).length > 0;

    return {
        ...(hasDirect ? direct : {}),
        ...scoped
    };
}

function loadLocalCityPresets() {
    const fallback = [
        { name: '北京', province: '北京', city: '北京', lat: 39.9042, lng: 116.4074 },
        { name: '上海', province: '上海', city: '上海', lat: 31.2304, lng: 121.4737 },
        { name: '上海虹桥站', province: '上海', city: '上海', district: '闵行区', lat: 31.1942, lng: 121.3184 },
        { name: '虹桥火车站', province: '上海', city: '上海', district: '闵行区', lat: 31.1942, lng: 121.3184 },
        { name: '深圳', province: '广东', city: '深圳', lat: 22.5431, lng: 114.0579 },
        { name: '广州', province: '广东', city: '广州', lat: 23.1291, lng: 113.2644 },
        { name: '杭州', province: '浙江', city: '杭州', lat: 30.2741, lng: 120.1551 }
    ];

    try {
        const cityPresetPath = path.join(__dirname, '../frontend/public/china-cities.js');
        const content = fs.readFileSync(cityPresetPath, 'utf8');
        const match = content.match(/window\.CHINA_CITY_PRESETS\s*=\s*(\[[\s\S]*?\]);/);
        if (!match) {
            return fallback;
        }

        const presets = Function(`"use strict"; return (${match[1]});`)();
        if (!Array.isArray(presets)) {
            return fallback;
        }

        return presets
            .map(item => ({
                name: String(item.name || '').trim(),
                province: String(item.province || '').trim(),
                city: String(item.city || item.name || '').trim(),
                district: String(item.district || '').trim(),
                lat: Number(item.lat),
                lng: Number(item.lng),
                aliases: Array.isArray(item.aliases) ? item.aliases : []
            }))
            .filter(item => item.name && Number.isFinite(item.lat) && Number.isFinite(item.lng));
    } catch (error) {
        console.warn(`Failed to load local city presets: ${error.message}`);
        return fallback;
    }
}

function normalizeGeocodeKeyword(value) {
    return String(value || '').trim().toLowerCase().replace(/\s+/g, '');
}

function searchLocalGeocode(keyword) {
    const normalized = normalizeGeocodeKeyword(keyword);
    if (!normalized) {
        return [];
    }

    return LOCAL_GEOCODE_LOCATIONS
        .map(item => {
            const nameKeys = [
                item.name,
                ...(Array.isArray(item.aliases) ? item.aliases : [])
            ].map(normalizeGeocodeKeyword).filter(Boolean);
            const areaKeys = [item.city, item.province].map(normalizeGeocodeKeyword).filter(Boolean);
            let score = 0;

            for (const key of nameKeys) {
                if (key === normalized) {
                    score = Math.max(score, 100);
                } else if (key.includes(normalized)) {
                    score = Math.max(score, 80);
                } else if (normalized.includes(key) && key.length >= 3) {
                    score = Math.max(score, 60);
                }
            }

            for (const key of areaKeys) {
                if (key === normalized) {
                    score = Math.max(score, 50);
                } else if (key.includes(normalized)) {
                    score = Math.max(score, 30);
                }
            }

            return score > 0 ? { item, score } : null;
        })
        .filter(Boolean)
        .sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            const aName = normalizeGeocodeKeyword(a.item.name);
            const bName = normalizeGeocodeKeyword(b.item.name);
            return bName.length - aName.length;
        })
        .map(({ item }) => ({ ...item, source: '本地预设' }));
}

async function searchAmapGeocode(keyword) {
    const key = process.env.AMAP_WEB_SERVICE_KEY || process.env.AMAP_KEY || '';
    if (!key) {
        return [];
    }

    const url = new URL('https://restapi.amap.com/v3/geocode/geo');
    url.searchParams.set('key', key);
    url.searchParams.set('address', keyword);
    url.searchParams.set('output', 'JSON');

    const payload = await outboundClient.fetchJson(url.toString(), {
        reason: 'geocode-search',
        platform: 'amap',
        chain: 'geocode',
        evidenceType: 'geocode',
        proxyContext: { keyword },
        skipProxy: true
    });
    if (payload.status !== '1' || !Array.isArray(payload.geocodes)) {
        return [];
    }

    return payload.geocodes.map(item => {
        const [lng, lat] = String(item.location || '').split(',').map(Number);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
            return null;
        }

        return {
            name: item.formatted_address || keyword,
            province: item.province || '',
            city: Array.isArray(item.city) ? '' : (item.city || ''),
            district: Array.isArray(item.district) ? '' : (item.district || ''),
            lat,
            lng,
            source: '高德'
        };
    }).filter(Boolean);
}

function dedupeSeedStations(stations = []) {
    const bestByKey = new Map();

    for (const station of stations) {
        const key = [
            station.platform || '',
            station.station_id || station.stationId || '',
            station.station_name || station.stationName || '',
            station.latitude || '',
            station.longitude || ''
        ].join('|');

        if (!bestByKey.has(key)) {
            bestByKey.set(key, station);
        }
    }

    return Array.from(bestByKey.values());
}

function getStationCoordinate(station) {
    const lat = Number(station.latitude ?? station.lat);
    const lng = Number(station.longitude ?? station.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return null;
    }
    return { lat, lng };
}

function calculateDistanceKm(lat1, lng1, lat2, lng2) {
    const toRad = (value) => value * Math.PI / 180;
    const earthRadiusKm = 6371;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
        Math.sin(dLat / 2) ** 2
        + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return earthRadiusKm * c;
}

function filterStationsByRadius(stations = [], centerLat, centerLng, radiusKm) {
    const lat = Number(centerLat);
    const lng = Number(centerLng);
    const radius = Math.max(0.1, Number(radiusKm) || 10);

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return stations;
    }

    return stations.filter((station) => {
        const coord = getStationCoordinate(station);
        if (!coord) {
            return false;
        }
        return calculateDistanceKm(lat, lng, coord.lat, coord.lng) <= radius;
    });
}

function getSelfHealSettingsWithMeta() {
    const settings = AppSettingModel.getSelfHealSettings();
    return {
        ...settings,
        summary: TaskSelfHealService.buildSummary(settings),
        scenarios: TaskSelfHealService.getScenarioOptions(),
        chainLabels: TaskSelfHealService.getChainLabels()
    };
}

function recordSelfHealDiagnosis(diagnosis, payload = {}) {
    return AppSettingModel.recordSelfHealRun({
        scheduleId: payload.scheduleId || null,
        scheduleName: payload.scheduleName || '',
        platform: payload.platform || '',
        currentChain: diagnosis.currentChain,
        currentChainLabel: diagnosis.currentChainLabel,
        nextChain: diagnosis.nextChain,
        nextChainLabel: diagnosis.nextChainLabel,
        fallbackChain: diagnosis.fallbackChain || null,
        fallbackChainLabel: diagnosis.fallbackChainLabel || null,
        scenario: diagnosis.scenario,
        title: diagnosis.title,
        status: diagnosis.status,
        summary: diagnosis.summary,
        capabilityDiagnostics: diagnosis.capabilityDiagnostics || [],
        execution: diagnosis.execution,
        repairPlan: diagnosis.repairPlan
    });
}

function buildSelfHealDiagnosis(payload = {}) {
    return TaskSelfHealService.diagnose({
        ...payload,
        settings: AppSettingModel.getSelfHealSettings(),
        networkSettings: AppSettingModel.getProxySettings()
    });
}

function inferApiFailureScenario(reason, runQuota = null) {
    const text = String(reason || '').toLowerCase();
    if (text.includes('no_active_template') || text.includes('无可用模板')) {
        return 'template_missing';
    }
    if (text.includes('signed_template_target_mismatch') || text.includes('签名')) {
        return 'api_501_burst';
    }
    if (text.includes('501') || Number(runQuota?.fail501) > 0) {
        return 'api_501_burst';
    }
    if (text.includes('empty') || text.includes('unexpected end') || text.includes('json')) {
        return 'api_empty_payload';
    }
    if (text.includes('proxy')) {
        return 'proxy_blocked';
    }
    return 'api_empty_payload';
}

function buildApiFailureSelfHeal(platform, reason, runQuota = null) {
    if (!AI_FEATURES_ENABLED) {
        return {
            skipped: true,
            reason: 'ai_feature_planned',
            aiFeatures: buildAiFeatureStatus()
        };
    }
    const diagnosis = buildSelfHealDiagnosis({
        scenario: inferApiFailureScenario(reason, runQuota),
        currentChain: 'api',
        platforms: [platform],
        attempt: 1
    });
    const run = recordSelfHealDiagnosis(diagnosis, { platform });
    return { diagnosis, run };
}

function enrichScheduleWithSelfHeal(schedule) {
    const settings = AppSettingModel.getSelfHealSettings();
    const recovery = AppSettingModel.getScheduleRecovery(schedule.id);
    return {
        ...schedule,
        self_heal_enabled: settings.enabled,
        self_heal_summary: TaskSelfHealService.buildSummary(settings),
        last_recovery_status: recovery?.status || schedule.last_recovery_status || '未执行',
        last_recovery_summary: recovery?.summary || schedule.last_recovery_summary || '尚未演练自动修复',
        last_recovery_at: recovery?.at || schedule.last_recovery_at || null
    };
}

function findScheduleById(scheduleId) {
    const schedules = scheduler.listSchedules();
    return schedules.find(item => Number(item.id) === Number(scheduleId)) || null;
}

function getTemplatesByMode(platform, crawlMode) {
    const listTemplates = crawlMode === 'detail' ? [] : ApiTemplateModel.getByPlatformAndScope(platform, 'list');
    const detailTemplates = crawlMode === 'list' ? [] : ApiTemplateModel.getByPlatformAndScope(platform, 'detail');
    return { listTemplates, detailTemplates };
}

async function runPlatformCrawl({
    platform,
    crawlMode,
    coordinates,
    centerLat,
    centerLng,
    radius,
    pageSize,
    maxPages,
    runId,
    testMode = false,
    runQuota = null,
    proxyContext = null,
    progressReporter = null
}) {
    const { listTemplates, detailTemplates } = getTemplatesByMode(platform, crawlMode);
    const maxListTemplatesToTry = platform === 'didi-charging' ? 3 : 1;
    const executedListTemplates = listTemplates.slice(0, maxListTemplatesToTry);
    const executedDetailTemplates = platform === 'didi-charging'
        ? detailTemplates.slice(0, 1)
        : detailTemplates;
    const log = (message, level = 'info') => RunHistoryModel.appendLog(runId, `[${platform}] ${message}`, level);
    const requestBudget = testMode ? smartCrawler.createTestRequestBudget(platform) : null;

    if (executedListTemplates.length === 0 && executedDetailTemplates.length === 0) {
        log('无可用模板', 'warn');
        return { success: false, reason: 'no_active_template' };
    }

    if (requestBudget) {
        log(`调试请求保护开启：平台请求上限 ${requestBudget.limit} 次`);
    }

    if (listTemplates.length > executedListTemplates.length && executedListTemplates[0]) {
        log(`列表模板共 ${listTemplates.length} 条，按优先级执行前 ${executedListTemplates.length} 条候选模板`);
    }
    if (platform === 'didi-charging' && executedListTemplates.length > 1) {
        log('滴滴列表模板启用候选校验：若当前模板无数据将在 API 能力内复测下一个候选模板', 'warn');
    }
    if (platform === 'didi-charging' && detailTemplates.length > executedDetailTemplates.length) {
        log(`滴滴详情模板共 ${detailTemplates.length} 条，当前只执行 1 条 getoneinfo 模板，避免重复详情请求触发 501`, 'warn');
    }

    const listStations = [];
    const detailStations = [];
    let attemptedListTemplateCount = 0;
    let signedTemplateMismatchCount = 0;
    const signedTemplateMismatchMessages = [];

    for (const template of executedListTemplates) {
        attemptedListTemplateCount += 1;
        log(`执行列表模板 #${template.id}: ${template.baseUrl}`);
        const signedTargetMismatch = smartCrawler.getSignedTemplateTargetMismatch(template, proxyContext);
        if (signedTargetMismatch) {
            signedTemplateMismatchCount += 1;
            signedTemplateMismatchMessages.push(signedTargetMismatch);
            log(signedTargetMismatch, 'warn');
            continue;
        }

        let stations = [];
        try {
            stations = await smartCrawler.crawl(template, {
                coordinates,
                radiusKm: radius,
                pageSize,
                maxPages,
                logger: log,
                requestBudget,
                runQuota,
                proxyContext,
                progressReporter
            });
        } catch (error) {
            log(`列表模板 #${template.id} 执行失败: ${error.message}`, 'error');
            if (
                smartCrawler.isRunRequestLimitExceeded(error)
                || smartCrawler.isTestRequestBudgetExceeded(error)
                || platform !== 'didi-charging'
            ) {
                throw error;
            }
            stations = [];
        }

        listStations.push(...stations);

        if (stations.length > 0) {
            ApiTemplateModel.updateLastUsed(template.id);
            log(`列表模板 #${template.id} 完成，解析 ${stations.length} 条`);
            if (platform === 'didi-charging') {
                log(`滴滴列表模板 #${template.id} 命中可用数据，停止后续模板切换`);
                break;
            }
        } else {
            log(`列表模板 #${template.id} 未解析到数据`, 'warn');
        }

        if (requestBudget && !smartCrawler.hasTestRequestBudgetRemaining(requestBudget)) {
            log(`调试请求保护已达上限，停止后续模板: ${smartCrawler.formatTestRequestBudget(requestBudget)}`, 'warn');
            break;
        }
        if (runQuota && !smartCrawler.hasRunRequestQuotaRemaining(runQuota)) {
            log(`当次请求已达上限，停止后续模板: ${smartCrawler.formatRunRequestQuota(runQuota)}`, 'warn');
            break;
        }
    }

    let detailSeeds = [];
    if (executedDetailTemplates.length > 0) {
        const nearbyStoredSeeds = dedupeSeedStations(
            StationModel.getNearbySeeds(platform, centerLat, centerLng, radius, 1000)
        );
        const currentRunSeedsInRadius = dedupeSeedStations(
            filterStationsByRadius(listStations, centerLat, centerLng, radius)
        );
        const currentRunSeeds = currentRunSeedsInRadius.length > 0
            ? currentRunSeedsInRadius
            : dedupeSeedStations(listStations);

        detailSeeds = currentRunSeeds.length > 0 ? currentRunSeeds : nearbyStoredSeeds;

        if (currentRunSeedsInRadius.length === 0 && currentRunSeeds.length > 0) {
            log('列表结果未命中半径过滤，回退使用当前批次列表场站作为详情种子', 'warn');
        } else if (currentRunSeeds.length === 0 && nearbyStoredSeeds.length > 0) {
            log('当前批次列表无可用详情种子，回退使用历史半径内场站', 'warn');
        }

        log(`详情种子场站 ${detailSeeds.length} 条`);

        if (detailSeeds.length === 0) {
            log('没有可用的详情种子场站，跳过详情模板', 'warn');
        }
    }

    for (const template of executedDetailTemplates) {
        if (detailSeeds.length === 0) {
            break;
        }

        if (requestBudget && !smartCrawler.hasTestRequestBudgetRemaining(requestBudget)) {
            log(`调试请求保护已达上限，跳过后续详情模板: ${smartCrawler.formatTestRequestBudget(requestBudget)}`, 'warn');
            break;
        }
        if (runQuota && !smartCrawler.hasRunRequestQuotaRemaining(runQuota)) {
            log(`当次请求已达上限，跳过后续详情模板: ${smartCrawler.formatRunRequestQuota(runQuota)}`, 'warn');
            break;
        }

        log(`执行详情模板 #${template.id}: ${template.baseUrl}`);
        const stations = await smartCrawler.crawlDetail(template, {
            seedStations: detailSeeds,
            logger: log,
            requestBudget,
            runQuota,
            proxyContext,
            progressReporter
        });
        ApiTemplateModel.updateLastUsed(template.id);
        detailStations.push(...stations);
        log(`详情模板 #${template.id} 完成，解析 ${stations.length} 条`);
    }

    const stations = harParser.deduplicateStations([...listStations, ...detailStations]);
    const radiusFilteredStations = platform === 'didi-charging'
        ? filterStationsByRadius(stations, centerLat, centerLng, radius)
        : stations;
    const stationsForInsert = radiusFilteredStations.length > 0 ? radiusFilteredStations : stations;
    if (platform === 'didi-charging' && radiusFilteredStations.length > 0 && radiusFilteredStations.length < stations.length) {
        log(`半径过滤: ${stations.length} -> ${radiusFilteredStations.length} 条`);
    }
    const insertResult = stationsForInsert.length > 0
        ? StationModel.insertBatch(stationsForInsert)
        : { successCount: 0, skipCount: 0 };
    const allListTemplatesSkippedBySignature = attemptedListTemplateCount > 0
        && signedTemplateMismatchCount === attemptedListTemplateCount
        && listStations.length === 0
        && detailStations.length === 0;

    return {
        success: !allListTemplatesSkippedBySignature,
        reason: allListTemplatesSkippedBySignature ? 'signed_template_target_mismatch' : undefined,
        diagnostics: signedTemplateMismatchMessages.length > 0
            ? {
                signedTemplateTargetMismatch: signedTemplateMismatchMessages
            }
            : undefined,
        crawlMode,
        listTemplateCount: attemptedListTemplateCount,
        listTemplateCandidateCount: listTemplates.length,
        detailTemplateCount: executedDetailTemplates.length,
        detailTemplateCandidateCount: detailTemplates.length,
        listStationCount: listStations.length,
        detailStationCount: detailStations.length,
        stationCount: stationsForInsert.length,
        insertedCount: insertResult.successCount || 0,
        skippedCount: insertResult.skipCount || 0,
        testMode: Boolean(requestBudget),
        requestBudget: smartCrawler.getTestRequestBudgetSummary(requestBudget),
        quotaStats: smartCrawler.getQuotaStatsSummary(),
        runQuota: smartCrawler.getRunRequestQuotaSummary(runQuota, { includeRequests: false })
    };
}

function getMobileSyncSettings() {
    const settings = config.mobileSync || {};
    const tokenHeader = String(settings.tokenHeader || 'x-mobile-sync-token').toLowerCase();
    return {
        enabled: settings.enabled !== false,
        authRequired: false,
        tokenHeader,
        token: '',
        authConfigured: false
    };
}

function getMobileSyncTokenFromRequest(req, tokenHeader) {
    const authHeader = String(req.headers.authorization || '').trim();
    if (authHeader.toLowerCase().startsWith('bearer ')) {
        return authHeader.slice(7).trim();
    }
    return String(req.headers[tokenHeader] || '').trim();
}

const MOBILE_CONTROL_SESSION_COOKIE = 'dfd_mobile_control_session';
const MOBILE_CONTROL_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function isMobileControlRoute(req) {
    return String(req.path || '').startsWith('/api/mobile-control/');
}

function parseCookies(cookieHeader = '') {
    return String(cookieHeader || '')
        .split(';')
        .map(item => item.trim())
        .filter(Boolean)
        .reduce((result, item) => {
            const index = item.indexOf('=');
            if (index > 0) {
                result[decodeURIComponent(item.slice(0, index))] = decodeURIComponent(item.slice(index + 1));
            }
            return result;
        }, {});
}

function signMobileControlSession(payload, secret) {
    return crypto
        .createHmac('sha256', secret)
        .update(payload)
        .digest('base64url');
}

function createMobileControlSession(settings) {
    const now = Date.now();
    const payload = Buffer.from(JSON.stringify({
        iat: now,
        exp: now + MOBILE_CONTROL_SESSION_TTL_MS,
        scope: 'mobile-control'
    }), 'utf8').toString('base64url');
    return {
        value: `${payload}.${signMobileControlSession(payload, settings.token)}`,
        expiresAt: new Date(now + MOBILE_CONTROL_SESSION_TTL_MS).toISOString(),
        maxAgeMs: MOBILE_CONTROL_SESSION_TTL_MS
    };
}

function verifyMobileControlSession(req, settings) {
    if (!settings.authConfigured || !isMobileControlRoute(req)) {
        return false;
    }
    const value = parseCookies(req.headers.cookie)[MOBILE_CONTROL_SESSION_COOKIE];
    const [payload, signature] = String(value || '').split('.');
    if (!payload || !signature) {
        return false;
    }
    const expected = signMobileControlSession(payload, settings.token);
    const expectedBuffer = Buffer.from(expected);
    const actualBuffer = Buffer.from(signature);
    if (expectedBuffer.length !== actualBuffer.length || !crypto.timingSafeEqual(expectedBuffer, actualBuffer)) {
        return false;
    }
    try {
        const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        return data.scope === 'mobile-control' && Number(data.exp) > Date.now();
    } catch (error) {
        return false;
    }
}

function requireMobileSyncAccess(req, res, next) {
    const settings = getMobileSyncSettings();
    if (!settings.enabled) {
        return res.status(404).json({ success: false, error: 'mobile sync disabled' });
    }
    return next();
}

// 监听智能控制器事件
smartController.on('status', (status) => {
    console.log(`📊 状态更新:`, status);
    // 可以通过 WebSocket 推送到前端
});

smartController.on('complete', (result) => {
    console.log(`✅ 采集完成:`, result);
    const captureResult = stopSmartCollectCaptureSession(result.sessionId, result.cancelled ? 'cancelled' : 'complete');
    if (captureResult) {
        console.log('📦 内置录包会话已停止:', captureResult);
        analyzeSmartCollectCaptureSession(result.sessionId, captureResult, result.cancelled ? 'cancelled' : 'complete')
            .then(analysis => console.log('🧪 HAR 自动分析完成:', analysis))
            .catch(error => console.warn('HAR 自动分析失败:', error.message));
    }
    // 保存到数据库
    if (result.stationCount > 0) {
        // 数据已由 capture-recorder 处理
    }
});

// ============ API 路由 ============

// 获取配置信息
app.get('/api/config', (req, res) => {
    const runtimeMode = 'full';
    res.json({
        runtimeMode,
        runtimeSummary: buildRuntimeModeSummary(runtimeMode),
        chainStatus: buildDynamicChainStatus(runtimeMode),
        collectionModes: buildCollectionModes(),
        platforms: getRuntimeMiniPrograms(),
        automation: config.automation,
        rateLimit: config.rateLimit,
        aiFeatures: buildAiFeatureStatus(),
        selfHeal: {
            enabled: AI_FEATURES_ENABLED,
            status: AI_FEATURES_ENABLED ? 'enabled' : 'planned',
            chainLabels: AI_FEATURES_ENABLED ? TaskSelfHealService.getChainLabels() : {},
            scenarios: AI_FEATURES_ENABLED ? TaskSelfHealService.getScenarioOptions() : []
        }
    });
});

app.get('/api/mobile-sync/config', requireMobileSyncAccess, (req, res) => {
    try {
        res.json({
            success: true,
            data: {
                ...mobileSyncService.getClientConfig(),
                supervisor: mobileSupervisorService.getClientConfig(),
                command: mobileCommandService.getClientConfig(),
                auth: {
                    authRequired: false,
                    authMode: 'disabled'
                }
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/mobile-sync/devices/register', requireMobileSyncAccess, (req, res) => {
    try {
        const device = mobileCommandService.registerDevice({
            ...(req.body || {}),
            remoteAddress: req.ip,
            relayNode: req.headers['x-relay-node'] || ''
        });
        res.json({
            success: true,
            message: '手机端已注册，已建立控制会话',
            data: device
        });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

app.post('/api/mobile-sync/ocr', requireMobileSyncAccess, (req, res) => {
    try {
        const result = mobileSyncService.ingestOcrPayload(req.body || {});
        mobileCommandService.advanceWorkflows();
        res.json({
            success: true,
            message: `手机 OCR 同步完成，识别 ${result.stationCount} 个场站`,
            data: result
        });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

app.post('/api/mobile-sync/stations', requireMobileSyncAccess, (req, res) => {
    try {
        const result = mobileSyncService.ingestStationPayload(req.body || {});
        mobileCommandService.advanceWorkflows();
        res.json({
            success: true,
            message: `手机场站同步完成，写入 ${result.insertedCount} 条`,
            data: result
        });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

app.post('/api/mobile-sync/supervisor', requireMobileSyncAccess, (req, res) => {
    if (!AI_FEATURES_ENABLED) {
        return res.json({
            success: true,
            message: '移动端监督已暂时下线，事件未进入自动决策链路',
            data: {
                accepted: false,
                action: 'NONE',
                pageType: 'UNKNOWN',
                reason: '移动端监督已暂时下线，后续版本恢复。',
                aiFeatures: buildAiFeatureStatus()
            }
        });
    }
    try {
        const result = mobileSupervisorService.ingestEvent(req.body || {});
        res.json({
            success: true,
            message: `移动端监督事件已记录: ${result.pageType} -> ${result.action}`,
            data: result
        });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

app.get('/api/mobile-sync/supervisor/recent', requireMobileSyncAccess, (req, res) => {
    try {
        res.json({
            success: true,
            data: mobileSupervisorService.getRecent(req.query.limit || 100)
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/mobile-sync/commands/poll', requireMobileSyncAccess, (req, res) => {
    try {
        const command = mobileCommandService.pollCommand(
            req.query.deviceId || req.query.device_id || 'unknown',
            {
                deviceSessionId: req.query.deviceSessionId || req.query.device_session_id || req.headers['x-mobile-device-session'] || '',
                remoteAddress: req.ip,
                relayNode: req.headers['x-relay-node'] || ''
            }
        );
        res.json({ success: true, data: command });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/mobile-sync/commands/:id/result', requireMobileSyncAccess, (req, res) => {
    try {
        const command = mobileCommandService.completeCommand(req.params.id, req.body || {});
        res.json({ success: true, data: command });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

app.get('/api/mobile-control/commands', requireMobileSyncAccess, (req, res) => {
    try {
        res.json({ success: true, data: mobileCommandService.listCommands(req.query.limit || 100) });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/mobile-control/devices', requireMobileSyncAccess, (req, res) => {
    try {
        res.json({ success: true, data: mobileCommandService.listDevices(req.query.limit || 50) });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/mobile-control/browser-session', (req, res) => {
    try {
        const settings = getMobileSyncSettings();
        if (!settings.enabled) {
            return res.status(404).json({ success: false, error: 'mobile sync disabled' });
        }
        res.json({ success: true, data: { authMode: 'disabled' } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/mobile-control/status', requireMobileSyncAccess, (req, res) => {
    try {
        res.json({ success: true, data: mobileCommandService.getControlStatus() });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/mobile-control/commands', requireMobileSyncAccess, (req, res) => {
    try {
        const command = mobileCommandService.enqueueCommand(req.body || {});
        res.json({ success: true, data: command });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

app.get('/api/mobile-control/workflows', requireMobileSyncAccess, (req, res) => {
    try {
        mobileCommandService.advanceWorkflows();
        res.json({ success: true, data: mobileCommandService.listWorkflows() });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/mobile-control/workflows/city-increment/start', requireMobileSyncAccess, (req, res) => {
    try {
        const workflow = mobileCommandService.startCityIncrementWorkflow(req.body || {});
        res.json({ success: true, data: workflow });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

app.get('/api/mobile-control/interaction/config', requireMobileSyncAccess, (req, res) => {
    try {
        res.json({ success: true, data: mobileCommandService.getInteractionConfig() });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/mobile-control/intent', requireMobileSyncAccess, async (req, res) => {
    try {
        const result = await mobileCommandService.submitIntent(req.body || {});
        res.json({ success: true, data: result });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

app.get('/api/mobile-control/chat/sessions', requireMobileSyncAccess, (req, res) => {
    try {
        res.json({ success: true, data: mobileCommandService.listChatSessions(req.query.limit || 20) });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/mobile-control/chat/sessions/:id', requireMobileSyncAccess, (req, res) => {
    try {
        const session = mobileCommandService.getChatSession(req.params.id);
        if (!session) {
            return res.status(404).json({ success: false, error: 'chat session not found' });
        }
        res.json({ success: true, data: session });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/mobile-control/chat', requireMobileSyncAccess, async (req, res) => {
    try {
        const result = await mobileCommandService.submitChatMessage(req.body || {});
        res.json({ success: true, data: result });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

// 获取统计数据
app.get('/api/stats', (req, res) => {
    try {
        const stats = StationModel.getStatistics();
        res.json({ success: true, data: stats });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 分时价格相关 API
app.get('/api/price-schedules/statistics', (req, res) => {
    try {
        const stats = PriceScheduleModel.getStatistics();
        res.json({ success: true, data: stats });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/price-schedules/station/:stationId', (req, res) => {
    try {
        const schedules = PriceScheduleModel.getByStationId(parseInt(req.params.stationId));
        res.json({ success: true, data: schedules });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/price-schedules/platform/:platform', (req, res) => {
    try {
        const limit = Math.max(1, Math.min(5000, parseInt(req.query.limit) || 1000));
        const schedules = PriceScheduleModel.getByPlatform(req.params.platform, limit);
        res.json({ success: true, data: schedules });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/price-schedules/backfill', (req, res) => {
    try {
        const platform = req.body?.platform ? String(req.body.platform).trim() : null;
        const limit = Number(req.body?.limit);
        const resetExisting = req.body?.resetExisting !== false;
        const result = PriceScheduleModel.backfillFromStations({
            platform: platform || null,
            limit: Number.isInteger(limit) && limit > 0 ? limit : null,
            resetExisting
        });
        res.json({ success: true, data: result });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/settings/network', (req, res) => {
    try {
        res.json({ success: true, data: AppSettingModel.getProxySettings() });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.put('/api/settings/network', (req, res) => {
    try {
        const settings = normalizeNetworkSettingsPayload(req.body || {});
        const data = AppSettingModel.saveProxySettings(settings);
        res.json({ success: true, data });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

app.get('/api/outbound/status', (req, res) => {
    try {
        const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 20));
        res.json({ success: true, data: outboundClient.getStatus(limit) });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/outbound/evidence/recent', (req, res) => {
    try {
        const limit = Math.max(1, Math.min(1000, parseInt(req.query.limit, 10) || 100));
        res.json({ success: true, data: outboundClient.getRecentEvidence(limit) });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/capture-recorder/status', (req, res) => {
    try {
        res.json({ success: true, data: captureRecorderService.getStatus() });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/capture-recorder/start', (req, res) => {
    try {
        res.json({ success: true, data: captureRecorderService.startSession(req.body || {}) });
    } catch (error) {
        const statusCode = error.statusCode || 400;
        res.status(statusCode).json({ success: false, error: error.message });
    }
});

app.post('/api/capture-recorder/stop', (req, res) => {
    try {
        res.json({ success: true, data: captureRecorderService.stopSession() });
    } catch (error) {
        const statusCode = error.statusCode || 400;
        res.status(statusCode).json({ success: false, error: error.message });
    }
});

function sendBlueTeamReportError(res, error) {
    const statusCode = error.statusCode || 500;
    res.status(statusCode).json({
        success: false,
        error: error.message,
        code: error.code || 'blue_team_report_error'
    });
}

app.get('/api/blue-team/reports', (req, res) => {
    try {
        const reports = blueTeamReportService.listReports({ limit: req.query.limit });
        res.json({ success: true, data: reports });
    } catch (error) {
        sendBlueTeamReportError(res, error);
    }
});

app.post('/api/blue-team/reports/seed', (req, res) => {
    try {
        const result = blueTeamReportService.ensureSeedReport({
            overwrite: req.body?.overwrite === true
        });
        res.status(result.created ? 201 : 200).json({
            success: true,
            message: result.created ? 'blue-team sample report seeded' : 'blue-team sample report already exists',
            data: result.report,
            meta: {
                created: result.created,
                files: result.files
            }
        });
    } catch (error) {
        sendBlueTeamReportError(res, error);
    }
});

app.get('/api/blue-team/reports/:reportId/download', (req, res) => {
    try {
        const download = blueTeamReportService.getDownload(req.params.reportId, req.query.format || 'json');
        res.setHeader('Content-Type', download.contentType);
        res.setHeader('Content-Disposition', `attachment; filename="${download.filename}"`);
        res.send(download.content);
    } catch (error) {
        sendBlueTeamReportError(res, error);
    }
});

app.get('/api/blue-team/reports/:reportId', (req, res) => {
    try {
        res.json({ success: true, data: blueTeamReportService.readReport(req.params.reportId) });
    } catch (error) {
        sendBlueTeamReportError(res, error);
    }
});

// ============ 证据中心同步 API ============

// 同步 receive 端点专用 token 校验中间件
function requireSyncToken(req, res, next) {
    return next();
}

app.get('/api/sync/nodes', async (req, res) => {
    try {
        const nodes = syncService.loadNodes();
        const result = await Promise.all(nodes.map(async (node) => {
            const status = await syncService.checkNodeHealth(node.url);
            const syncState = syncService.loadSyncState();
            const nodeState = syncState[node.name] || {};
            return {
                name: node.name,
                url: node.url,
                status,
                direction: node.direction || 'push-only',
                enabled: node.enabled !== false,
                lastSyncAt: nodeState.lastPushAt || null,
                lastPushAt: nodeState.lastPushAt || null,
            };
        }));
        res.json({ success: true, data: result });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/sync/nodes', (req, res) => {
    try {
        const node = syncService.addNode(req.body || {});
        res.json({ success: true, data: node });
    } catch (error) {
        const statusCode = error.statusCode || 500;
        res.status(statusCode).json({ success: false, error: error.message, code: error.code });
    }
});

app.delete('/api/sync/nodes/:name', (req, res) => {
    try {
        const removed = syncService.removeNode(req.params.name);
        res.json({ success: true, data: removed });
    } catch (error) {
        const statusCode = error.statusCode || 500;
        res.status(statusCode).json({ success: false, error: error.message, code: error.code });
    }
});

app.get('/api/sync/status', async (req, res) => {
    try {
        const nodeName = req.query.node || '172-server';
        const status = await syncService.getSyncStatus(nodeName);
        res.json({ success: true, data: status });
    } catch (error) {
        const statusCode = error.statusCode || 500;
        res.status(statusCode).json({ success: false, error: error.message, code: error.code });
    }
});

app.post('/api/sync/push', async (req, res) => {
    try {
        const nodeName = (req.body || {}).node || '172-server';
        const reportIds = (req.body || {}).reportIds || null;
        const result = await syncService.push(nodeName, { reportIds });
        res.json({ success: true, data: result });
    } catch (error) {
        const statusCode = error.statusCode || 500;
        res.status(statusCode).json({ success: false, error: error.message, code: error.code });
    }
});

// ---- 远端接收 API（需 sync 专用 token） ----

app.post('/api/sync/receive/report', requireSyncToken, (req, res) => {
    try {
        const { reportId, reportData, source } = req.body || {};
        if (!reportId || !reportData) {
            return res.status(400).json({ success: false, error: 'reportId and reportData are required' });
        }
        const result = syncService.receiveReport(reportId, reportData, source);
        res.json({ success: true, data: result });
    } catch (error) {
        const statusCode = error.statusCode || 500;
        res.status(statusCode).json({ success: false, error: error.message, code: error.code });
    }
});

app.post('/api/sync/receive/evidence', requireSyncToken, syncUpload.single('file'), (req, res) => {
    try {
        const { reportId, type, filePath } = req.body || {};
        const file = req.file || (req.files && req.files[0]);
        if (!reportId || !type || !file) {
            return res.status(400).json({ success: false, error: 'reportId, type and file are required' });
        }
        const fileBuffer = file.buffer || fs.readFileSync(file.path);
        const result = syncService.receiveEvidence(reportId, type, filePath || file.originalname, fileBuffer);
        res.json({ success: true, data: result });
    } catch (error) {
        const statusCode = error.statusCode || 500;
        res.status(statusCode).json({ success: false, error: error.message, code: error.code });
    }
});

app.get('/api/sync/receive/check', requireSyncToken, (req, res) => {
    try {
        const reportIds = req.query.reportIds || '';
        const existing = syncService.checkExistingReports(reportIds);
        res.json({ success: true, data: { existing } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/blue-team/reports/:reportId/evidence-list', (req, res) => {
    try {
        const files = blueTeamReportService.getRelativeFiles(req.params.reportId);
        res.json({ success: true, data: { files: files.evidence || {} } });
    } catch (error) {
        sendBlueTeamReportError(res, error);
    }
});

app.get('/api/self-heal/settings', (req, res) => {
    if (!AI_FEATURES_ENABLED) {
        return res.json({
            success: true,
            data: {
                enabled: false,
                status: 'planned',
                summary: '自动排查与自愈已暂时下线，后续版本恢复。',
                scenarios: [],
                chainLabels: {},
                aiFeatures: buildAiFeatureStatus()
            }
        });
    }
    try {
        res.json({ success: true, data: getSelfHealSettingsWithMeta() });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.put('/api/self-heal/settings', (req, res) => {
    if (!AI_FEATURES_ENABLED) {
        return res.status(503).json(buildAiDisabledResponse('自动排查与自愈'));
    }
    try {
        AppSettingModel.saveSelfHealSettings(req.body || {});
        res.json({ success: true, data: getSelfHealSettingsWithMeta() });
    } catch (error) {
        res.status(400).json({ success: false, error: error.message });
    }
});

app.get('/api/self-heal/runs', (req, res) => {
    if (!AI_FEATURES_ENABLED) {
        return res.json({ success: true, data: [] });
    }
    try {
        const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 40));
        res.json({ success: true, data: AppSettingModel.getSelfHealRuns(limit) });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/self-heal/diagnose', (req, res) => {
    if (!AI_FEATURES_ENABLED) {
        return res.status(503).json(buildAiDisabledResponse('自动排查诊断'));
    }
    try {
        const body = req.body || {};
        const diagnosis = buildSelfHealDiagnosis(body);
        const run = recordSelfHealDiagnosis(diagnosis, {
            platform: Array.isArray(body.platforms) && body.platforms[0] ? body.platforms[0] : '',
            scheduleId: body.scheduleId || null,
            scheduleName: body.scheduleName || ''
        });

        res.json({
            success: true,
            data: {
                diagnosis,
                run
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/self-heal/apply', (req, res) => {
    if (!AI_FEATURES_ENABLED) {
        return res.status(503).json(buildAiDisabledResponse('自动排查修复'));
    }
    try {
        const body = req.body || {};
        const diagnosis = body.diagnosis && typeof body.diagnosis === 'object'
            ? body.diagnosis
            : buildSelfHealDiagnosis(body);
        const targetChainLabel = diagnosis.currentChainLabel
            || diagnosis.execution?.targetChainLabel
            || diagnosis.nextChainLabel
            || diagnosis.currentChainLabel
            || '';
        const run = AppSettingModel.recordSelfHealRun({
            scheduleId: body.scheduleId || null,
            scheduleName: body.scheduleName || '',
            platform: Array.isArray(body.platforms) && body.platforms[0] ? body.platforms[0] : '',
            currentChain: diagnosis.currentChain,
            currentChainLabel: diagnosis.currentChainLabel,
            nextChain: diagnosis.nextChain || null,
            nextChainLabel: diagnosis.nextChainLabel || null,
            fallbackChain: diagnosis.fallbackChain || diagnosis.execution?.fallbackChain || null,
            fallbackChainLabel: diagnosis.fallbackChainLabel || diagnosis.execution?.fallbackChainLabel || null,
            scenario: diagnosis.scenario,
            title: '已执行当前能力修复',
            status: 'applied',
            summary: targetChainLabel ? `已按方案执行 ${targetChainLabel} 当前能力修复` : '已按方案继续当前能力',
            capabilityDiagnostics: diagnosis.capabilityDiagnostics || [],
            execution: diagnosis.execution || null,
            repairPlan: diagnosis.repairPlan || []
        });

        res.json({ success: true, data: { run } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/geocode/search', async (req, res) => {
    const keyword = String(req.query.q || '').trim();
    if (!keyword) {
        return res.status(400).json({ success: false, error: 'q required', data: [] });
    }

    try {
        const localResults = searchLocalGeocode(keyword);
        const remoteResults = localResults.length > 0 ? [] : await searchAmapGeocode(keyword);
        const data = localResults.length > 0 ? localResults : remoteResults;
        res.json({
            success: data.length > 0,
            data,
            error: data.length > 0 ? null : '未找到位置；如需全国街道级检索，请配置 AMAP_WEB_SERVICE_KEY'
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message, data: [] });
    }
});

app.get('/api/crawler/run-quota', (req, res) => {
    try {
        res.json({ success: true, data: AppSettingModel.getCrawlerRunQuotaStatus() });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.put('/api/crawler/run-quota', (req, res) => {
    try {
        const rawLimit = req.body.perRunLimit;
        const isUnlimited = req.body.unlimited === true
            || req.body.perRunUnlimited === true
            || rawLimit === null
            || ['unlimited', 'none', 'no-limit', 'infinity', '∞'].includes(String(rawLimit || '').trim().toLowerCase());

        if (isUnlimited) {
            const data = AppSettingModel.saveCrawlerPerRunLimit('unlimited');
            return res.json({ success: true, data });
        }

        const perRunLimit = Number(rawLimit);
        if (!Number.isFinite(perRunLimit) || perRunLimit <= 0) {
            return res.status(400).json({ success: false, error: 'perRunLimit must be a positive number' });
        }

        const data = AppSettingModel.saveCrawlerPerRunLimit(perRunLimit);
        res.json({ success: true, data });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/diagnostics/platforms', (req, res) => {
    try {
        const templateCoverage = ApiTemplateModel.getPlatformCoverage();
        const coverageMap = new Map(templateCoverage.map(item => [item.platform, item]));
        const recentRuns = RunHistoryModel.getRuns(100);

        const data = getRuntimePlatformIds().map(platform => {
            const coverage = coverageMap.get(platform) || null;
            const latestRun = recentRuns.find(run =>
                run.runType === 'crawl-platforms-with-coordinates'
                && run.resultSummary
                && Array.isArray(run.resultSummary.summary)
                && run.resultSummary.summary.some(item => item.platform === platform)
            );

            let latestStatus = 'never_run';
            let latestReason = null;
            if (latestRun) {
                const item = latestRun.resultSummary.summary.find(v => v.platform === platform);
                latestStatus = item?.success ? 'success' : 'failed';
                latestReason = item?.reason || null;
            }

            return {
                platform,
                hasActiveTemplate: Boolean(coverage && coverage.activeTemplates > 0),
                totalTemplates: coverage ? coverage.totalTemplates : 0,
                activeTemplates: coverage ? coverage.activeTemplates : 0,
                activeListTemplates: coverage ? coverage.activeListTemplates : 0,
                activeDetailTemplates: coverage ? coverage.activeDetailTemplates : 0,
                latestTemplateCreatedAt: coverage ? coverage.latestCreatedAt : null,
                latestTemplateUsedAt: coverage ? coverage.latestUsedAt : null,
                latestRunStatus: latestStatus,
                latestRunReason: latestReason
            };
        });

        res.json({ success: true, data });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/runs', (req, res) => {
    try {
        const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 30));
        const runs = RunHistoryModel.getRuns(limit);
        res.json({ success: true, data: runs });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/runs/:id', (req, res) => {
    try {
        const runId = Number(req.params.id);
        if (!Number.isFinite(runId)) {
            return res.status(400).json({ success: false, error: 'invalid run id' });
        }

        const run = RunHistoryModel.getRun(runId);
        if (!run) {
            return res.status(404).json({ success: false, error: 'run not found' });
        }

        res.json({ success: true, data: run });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/run-logs', (req, res) => {
    try {
        const limit = Math.max(1, Math.min(500, parseInt(req.query.limit, 10) || 200));
        const runId = req.query.runId ? Number(req.query.runId) : null;
        const logs = RunHistoryModel.getLogs(limit, Number.isFinite(runId) ? runId : null);
        res.json({ success: true, data: logs });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 去重已导入的数据
app.post('/api/stations/deduplicate', (req, res) => {
    const runId = RunHistoryModel.startRun('deduplicate', {});

    try {
        RunHistoryModel.appendLog(runId, '开始执行去重');
        const result = StationModel.deduplicateExisting();
        RunHistoryModel.appendLog(runId, `去重完成，删除 ${result.removed} 条重复数据`);
        RunHistoryModel.finishRun(runId, 'success', { removed: result.removed });
        res.json({
            success: true,
            message: `去重完成，删除 ${result.removed} 条重复数据`,
            removed: result.removed
        });
    } catch (error) {
        RunHistoryModel.appendLog(runId, `去重失败: ${error.message}`, 'error');
        RunHistoryModel.finishRun(runId, 'failed', null, error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 获取最近采集的数据
app.get('/api/stations/recent', (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 100;
        const platform = req.query.platform || null;

        const stations = StationModel.getRecent(limit, platform);
        res.json({ success: true, data: stations });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 按日期范围查询
app.get('/api/stations/range', (req, res) => {
    try {
        const { start, end, platform } = req.query;

        if (!start || !end) {
            return res.status(400).json({ success: false, error: 'start and end required' });
        }

        const stations = StationModel.getByDateRange(start, end, platform);
        res.json({ success: true, data: stations });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 手动触发采集（旧方式）
app.post('/api/collect', async (req, res) => {
    const { platform } = req.body;

    if (!platform) {
        return res.status(400).json({ success: false, error: 'platform required' });
    }

    const miniProgram = findRuntimeMiniProgram(platform);

    if (!miniProgram) {
        return res.status(404).json({ success: false, error: 'Platform not found' });
    }

    try {
        // 记录任务开始
        const taskResult = db.prepare(`
            INSERT INTO collection_tasks (platform, status, started_at)
            VALUES (?, 'running', CURRENT_TIMESTAMP)
        `).run(platform);

        const taskId = taskResult.lastInsertRowid;

        // 异步执行采集流程
        automation.runCollectionWorkflow(miniProgram)
            .then(result => {
                db.prepare(`
                    UPDATE collection_tasks
                    SET status = 'completed', completed_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                `).run(taskId);

                console.log('Collection completed:', result);
            })
            .catch(error => {
                db.prepare(`
                    UPDATE collection_tasks
                    SET status = 'failed', error_message = ?, completed_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                `).run(error.message, taskId);

                console.error('Collection failed:', error);
            });

        res.json({
            success: true,
            message: 'Collection started',
            taskId: taskId
        });

    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ 智能采集 API ============

function resolveCollectPlatformsAndTargets(body = {}) {
    const {
        platform,
        platforms,
        cities,
        city,
        targetCities,
        targets,
        target,
        targetLocations,
        landmarks,
        keywords
    } = body || {};
    const rawTargets = targets
        || targetLocations
        || landmarks
        || keywords
        || targetCities
        || cities
        || target
        || city
        || [];
    return {
        platformList: platforms || (platform ? [platform] : []),
        targetList: normalizeSmartCollectTargets(rawTargets)
    };
}

function resolveCollectPlatformsAndCities(body = {}) {
    const { platformList, targetList } = resolveCollectPlatformsAndTargets(body);
    return { platformList, cityList: targetList };
}

function normalizeSmartCollectTargets(rawTargets = []) {
    const source = Array.isArray(rawTargets) ? rawTargets : [rawTargets];
    const seen = new Set();
    const result = [];

    source.forEach(item => {
        const rawValue = item && typeof item === 'object'
            ? (item.keyword || item.name || item.label || [item.city, item.landmark || item.address].filter(Boolean).join(''))
            : item;
        String(rawValue || '')
            .split(/[\n,，;；|]/)
            .map(value => value.trim())
            .filter(Boolean)
            .forEach(value => {
                if (!seen.has(value)) {
                    seen.add(value);
                    result.push(value);
                }
            });
    });

    return result;
}

function normalizeCaptureFilters(input = {}) {
    const raw = input && typeof input === 'object' ? input : {};
    return {
        hosts: normalizeFilterList(raw.hosts || raw.host || raw.domains || raw.domain || ''),
        ips: normalizeFilterList(raw.ips || raw.ip || '')
    };
}

const DIDI_METHOD2_TRAFFIC_POLICY = {
    // 这些是已实测会把滴滴充电带入营销活动页的静态入口，不属于场站列表业务流量。
    blockUrlKeywords: [
        'amoperation-fe/boss/power-marketing',
        '/boss/power-marketing/',
        'power-marketing',
        'mixc-banner',
        'mixc-rule',
        'mixc-epower-station',
        'box_xpub/1173745',
        'box_xpub/373846',
        'alimamashuheiti',
        'alibaba-puhuiti',
        'barlowsemicondensed',
        'mfyuanhei'
    ]
};

function buildSmartCollectTrafficPolicy(platformList = [], captureFilters = {}) {
    const rawPolicy = normalizeTrafficPolicyInput(captureFilters?.trafficPolicy || captureFilters?.policy || {});
    const shouldApplyDidiDefaults = platformList.includes('didi-charging')
        && captureFilters?.disableDefaultTrafficPolicy !== true;

    if (!shouldApplyDidiDefaults) {
        return rawPolicy;
    }

    return {
        blockHosts: mergeUniqueLists(
            DIDI_METHOD2_TRAFFIC_POLICY.blockHosts || [],
            rawPolicy.blockHosts || []
        ),
        blockUrlKeywords: mergeUniqueLists(
            DIDI_METHOD2_TRAFFIC_POLICY.blockUrlKeywords,
            rawPolicy.blockUrlKeywords || []
        ),
        allowUrlKeywords: mergeUniqueLists(
            DIDI_METHOD2_TRAFFIC_POLICY.allowUrlKeywords,
            rawPolicy.allowUrlKeywords || []
        )
    };
}

function normalizeTrafficPolicyInput(input = {}) {
    const raw = input && typeof input === 'object' ? input : {};
    return {
        blockHosts: normalizeFilterList(raw.blockHosts || raw.blockHost || raw.hosts || ''),
        blockUrlKeywords: normalizeFilterList(
            raw.blockUrlKeywords
            || raw.blockUrlKeyword
            || raw.blockUrls
            || raw.blockUrl
            || raw.urls
            || ''
        ),
        allowUrlKeywords: normalizeFilterList(
            raw.allowUrlKeywords
            || raw.allowUrlKeyword
            || raw.allowUrls
            || raw.allowUrl
            || ''
        )
    };
}

function normalizeFilterList(value) {
    const source = Array.isArray(value) ? value : String(value || '').split(/[\n,，;；|\s]+/);
    const seen = new Set();
    const result = [];
    source
        .map(item => String(item || '').trim().toLowerCase())
        .filter(Boolean)
        .forEach(item => {
            if (!seen.has(item)) {
                seen.add(item);
                result.push(item);
            }
        });
    return result;
}

function mergeUniqueLists(...lists) {
    return normalizeFilterList(lists.flat());
}

function buildCaptureRecorderPreflight() {
    const status = captureRecorderService.getStatus();
    const check = status.available
        ? {
            status: 'pass',
            label: '内置录包服务',
            message: status.activeSession
                ? `录包服务运行中：${status.activeSession.listenHost}:${status.activeSession.listenPort}`
                : `录包服务可用：${status.binary}`
        }
        : {
            status: 'fail',
            label: '内置录包服务',
            message: '未检测到 mitmdump，需安装 mitmproxy 或配置 CAPTURE_RECORDER_BIN'
        };
    return { status, check, canStart: check.status !== 'fail' };
}

function createCaptureRecorderUnavailableError(status) {
    const error = new Error('系统录包服务不可用：未检测到 mitmdump，需安装 mitmproxy 或配置 CAPTURE_RECORDER_BIN');
    error.statusCode = 503;
    error.code = 'capture_recorder_unavailable';
    error.recorderStatus = status;
    return error;
}

function startSmartCollectCaptureSession(platformList = [], targetList = [], captureFilters = {}) {
    const status = captureRecorderService.getStatus();
    if (!status.available) {
        throw createCaptureRecorderUnavailableError(status);
    }

    return captureRecorderService.startSession({
        label: `method2-smart-collect-${platformList.join('-') || 'unknown'}`,
        scope: 'method2-smart-collect',
        platforms: platformList,
        cities: Array.isArray(targetList) ? targetList : [targetList].filter(Boolean),
        targets: Array.isArray(targetList) ? targetList : [targetList].filter(Boolean),
        filters: normalizeCaptureFilters(captureFilters),
        trafficPolicy: buildSmartCollectTrafficPolicy(platformList, captureFilters),
        manageSystemProxy: true
    });
}

function stopSmartCollectCaptureSession(sessionId, reason = 'finish') {
    const session = smartController.getSession(sessionId);
    const captureSession = session?.captureSession;
    if (!captureSession?.id) {
        return null;
    }

    const activeSession = captureRecorderService.getStatus().activeSession;
    let result;
    if (activeSession?.id === captureSession.id) {
        result = {
            ...captureRecorderService.stopSession(),
            stopReason: reason
        };
    } else {
        result = {
            running: false,
            message: 'capture recorder is already stopped or has been replaced',
            captureSessionId: captureSession.id,
            activeSessionId: activeSession?.id || null,
            stopReason: reason
        };
    }
    smartController.finalizeCaptureSession(sessionId, result);
    return result;
}

const captureAnalysisPromises = new Map();

async function analyzeSmartCollectCaptureSession(sessionId, captureSession, reason = 'finish') {
    const captureSessionId = captureSession?.captureSessionId || captureSession?.id;
    if (!captureSessionId) {
        return null;
    }

    const existing = smartController.getSession(sessionId)?.captureAnalysis;
    if (existing?.captureSessionId === captureSessionId && ['success', 'empty', 'failed'].includes(existing.status)) {
        return existing;
    }

    if (captureAnalysisPromises.has(captureSessionId)) {
        return captureAnalysisPromises.get(captureSessionId);
    }

    const promise = runCaptureAnalysis(sessionId, captureSessionId, captureSession, reason);
    captureAnalysisPromises.set(captureSessionId, promise);
    try {
        return await promise;
    } finally {
        captureAnalysisPromises.delete(captureSessionId);
    }
}

async function runCaptureAnalysis(sessionId, captureSessionId, captureSession, reason) {
    const analyzedAt = new Date().toISOString();
    const settledSession = await captureRecorderService.waitForSession(captureSessionId, {
        timeoutMs: Number(process.env.CAPTURE_ANALYSIS_WAIT_MS || 6000),
        intervalMs: 200
    });
    const finalCaptureSession = settledSession || captureSession || {};
    const harPath = finalCaptureSession.harPath || captureSession?.harPath || '';
    const captureStats = finalCaptureSession.stats || captureSession?.stats || null;
    const captureDiagnostics = finalCaptureSession.logDiagnostics || captureSession?.logDiagnostics || null;
    const captureHealth = buildCaptureHealth(captureStats, captureDiagnostics);
    const base = {
        status: 'empty',
        reason,
        captureSessionId,
        harPath,
        analyzedAt,
        entryCount: 0,
        stationCount: 0,
        insertedCount: 0,
        skippedCount: 0,
        learnedPatternCount: 0,
        savedTemplateCount: 0,
        captureStats,
        captureDiagnostics,
        captureHealth,
        captureSession: finalCaptureSession
    };

    try {
        if (!harPath || !fs.existsSync(harPath) || fs.statSync(harPath).size <= 0) {
            const analysis = {
                ...base,
                status: 'empty',
                message: buildEmptyCaptureMessage(captureStats, captureDiagnostics, '内置录包已停止，但未产出有效 HAR 内容。')
            };
            smartController.recordCaptureAnalysis(sessionId, analysis);
            return analysis;
        }

        base.entryCount = countHarEntries(harPath);
        if (base.entryCount <= 0) {
            const analysis = {
                ...base,
                status: 'empty',
                message: buildEmptyCaptureMessage(captureStats, captureDiagnostics, 'HAR 已生成，但没有记录到可分析的流量条目。')
            };
            smartController.recordCaptureAnalysis(sessionId, analysis);
            return analysis;
        }

        const businessSignals = inspectHarBusinessSignals(harPath);
        const requiresDidiBusinessFlow = captureRequiresDidiBusinessFlow(finalCaptureSession);
        if (requiresDidiBusinessFlow && !businessSignals.hasDidiStationBusinessFlow) {
            const analysis = {
                ...base,
                status: 'missing-business-flow',
                businessSignals,
                message: buildCaptureAnalysisMessage(
                    base.entryCount,
                    0,
                    0,
                    captureHealth,
                    businessSignals,
                    { requiresDidiBusinessFlow }
                )
            };
            smartController.recordCaptureAnalysis(sessionId, analysis);
            return analysis;
        }

        const stations = await harParser.parseSessionFile(harPath);
        const insertResult = stations.length > 0
            ? StationModel.insertBatch(stations)
            : { successCount: 0, skipCount: 0 };
        const patterns = await smartCrawler.learnFromHAR(harPath);
        const saveResult = saveLearnedPatternsAsTemplates(patterns, '方式二自动录包');
        const didiStations = stations.filter(station => station.platform === 'didi-charging');
        if (requiresDidiBusinessFlow && didiStations.length === 0) {
            const analysis = {
                ...base,
                status: 'parser-missed-business-flow',
                learnedPatternCount: patterns.length,
                savedTemplateCount: saveResult.successCount || 0,
                businessSignals,
                message: buildCaptureAnalysisMessage(
                    base.entryCount,
                    0,
                    patterns.length,
                    captureHealth,
                    businessSignals,
                    { requiresDidiBusinessFlow, parserMissedBusinessFlow: true }
                )
            };
            smartController.recordCaptureAnalysis(sessionId, analysis);
            return analysis;
        }

        const analysis = {
            ...base,
            status: 'success',
            stationCount: stations.length,
            insertedCount: insertResult.successCount || 0,
            skippedCount: insertResult.skipCount || 0,
            learnedPatternCount: patterns.length,
            savedTemplateCount: saveResult.successCount || 0,
            businessSignals,
            message: buildCaptureAnalysisMessage(
                base.entryCount,
                stations.length,
                patterns.length,
                captureHealth,
                businessSignals,
                { requiresDidiBusinessFlow }
            )
        };
        smartController.recordCaptureAnalysis(sessionId, analysis);
        return analysis;
    } catch (error) {
        const analysis = {
            ...base,
            status: 'failed',
            error: error.message,
            message: `HAR 自动分析失败：${error.message}`
        };
        smartController.recordCaptureAnalysis(sessionId, analysis);
        return analysis;
    }
}

function countHarEntries(harPath) {
    try {
        const payload = JSON.parse(fs.readFileSync(harPath, 'utf8'));
        return Array.isArray(payload?.log?.entries) ? payload.log.entries.length : 0;
    } catch (error) {
        return 0;
    }
}

function captureRequiresDidiBusinessFlow(captureSession = {}) {
    const platforms = Array.isArray(captureSession.platforms) ? captureSession.platforms : [];
    if (platforms.includes('didi-charging')) {
        return true;
    }

    const text = [
        captureSession.label,
        captureSession.scope,
        ...(Array.isArray(captureSession.targets) ? captureSession.targets : []),
        ...(Array.isArray(captureSession.cities) ? captureSession.cities : [])
    ].filter(Boolean).join(' ');

    return /didi-charging|滴滴充电/i.test(text);
}

function inspectHarBusinessSignals(harPath) {
    const empty = {
        stationApiUrlCount: 0,
        didiStationListUrlCount: 0,
        didiGetOneInfoUrlCount: 0,
        didiStationBusinessBodyCount: 0,
        hasDidiStationBusinessFlow: false,
        didiHostCount: 0,
        staticAssetCount: 0,
        sampledBusinessUrls: []
    };

    try {
        const payload = JSON.parse(fs.readFileSync(harPath, 'utf8'));
        const entries = Array.isArray(payload?.log?.entries) ? payload.log.entries : [];
        const sampledBusinessUrls = [];
        let stationApiUrlCount = 0;
        let didiStationListUrlCount = 0;
        let didiGetOneInfoUrlCount = 0;
        let didiStationBusinessBodyCount = 0;
        let didiHostCount = 0;
        let staticAssetCount = 0;

        for (const entry of entries) {
            const url = String(entry?.request?.url || '');
            if (!url) {
                continue;
            }

            const pathname = (() => {
                try {
                    return new URL(url).pathname;
                } catch (error) {
                    return url;
                }
            })();

            if (/\.(?:js|css|png|jpe?g|gif|webp|svg|ttf|otf|woff2?|map)(?:$|\?)/i.test(pathname)) {
                staticAssetCount += 1;
            }

            if (/(?:xiaojuke|udache|diditaxi|didistatic|didi|servicewechat)/i.test(url)) {
                didiHostCount += 1;
            }

            const isDidiStationList = /energy\.xiaojukeji\.com\/station-api\/homepage\/stationlist/i.test(url);
            const isDidiGetOneInfo = /energy\.xiaojukeji\.com\/station-api\/station\/getoneinfo/i.test(url);
            const isStationApiUrl = isDidiStationList
                || isDidiGetOneInfo
                || /(?:stationlist|station\/getoneinfo|stationdetail|querystationroadbook|charge\/app\/station|homepage\/stationlist|price|gun|pile|port)/i.test(url);

            if (isDidiStationList) {
                didiStationListUrlCount += 1;
            }
            if (isDidiGetOneInfo) {
                didiGetOneInfoUrlCount += 1;
            }
            if (isStationApiUrl) {
                stationApiUrlCount += 1;
                if (sampledBusinessUrls.length < 8) {
                    sampledBusinessUrls.push(url);
                }
            }

            if (isDidiStationList || isDidiGetOneInfo) {
                const responseText = decodeHarContentText(entry?.response?.content || {});
                if (/(?:stationName|stationId|totalSalePrice|fastChargeNum|fastChargeIdleNum|businessSituation|fastUsableNum|fastTotalNum)/.test(responseText)) {
                    didiStationBusinessBodyCount += 1;
                }
            }
        }

        return {
            stationApiUrlCount,
            didiStationListUrlCount,
            didiGetOneInfoUrlCount,
            didiStationBusinessBodyCount,
            hasDidiStationBusinessFlow: didiStationListUrlCount + didiGetOneInfoUrlCount > 0,
            didiHostCount,
            staticAssetCount,
            sampledBusinessUrls
        };
    } catch (error) {
        return empty;
    }
}

function decodeHarContentText(content = {}) {
    const rawText = String(content.text || '');
    if (!rawText) {
        return '';
    }
    if (content.encoding === 'base64') {
        try {
            return Buffer.from(rawText, 'base64').toString('utf8');
        } catch (error) {
            return rawText;
        }
    }
    return rawText;
}

function buildCaptureAnalysisMessage(entryCount, stationCount, patternCount, captureHealth, businessSignals = {}, options = {}) {
    const baseMessage = `HAR 自动分析完成：流量 ${entryCount} 条，识别场站 ${stationCount} 个，学习模板 ${patternCount} 个。`;
    if (options.parserMissedBusinessFlow) {
        return `${baseMessage} 已抓到滴滴业务接口 ${Number(businessSignals.didiStationListUrlCount) || 0} 条列表、${Number(businessSignals.didiGetOneInfoUrlCount) || 0} 条详情，但解析器没有抽取出滴滴场站价格/枪数字段，需要补解析规则。`;
    }

    if (stationCount > 0 || patternCount > 0) {
        return baseMessage;
    }

    const stationApiUrlCount = Number(businessSignals.stationApiUrlCount) || 0;
    const didiStationListUrlCount = Number(businessSignals.didiStationListUrlCount) || 0;
    const didiGetOneInfoUrlCount = Number(businessSignals.didiGetOneInfoUrlCount) || 0;
    const staticAssetCount = Number(businessSignals.staticAssetCount) || 0;
    let flowHint = stationApiUrlCount > 0
        ? `已发现 ${stationApiUrlCount} 条场站候选 URL，但解析器未识别出价格/枪口字段，需要补模板。`
        : `未发现 stationlist/价格/枪口类业务 URL；当前 HAR 更像启动、营销或静态资源流量，其中静态资源 ${staticAssetCount} 条。`;
    if (options.requiresDidiBusinessFlow && didiStationListUrlCount + didiGetOneInfoUrlCount <= 0) {
        flowHint = `方式二未抓到滴滴充电业务包：缺少 energy.xiaojukeji.com/station-api/homepage/stationList 或 station/getoneinfo。当前 HAR 不能证明已获取场站价格/枪数。`;
    }
    const healthHint = captureHealth?.message ? ` ${captureHealth.message}` : '';
    return `${baseMessage} ${flowHint}${healthHint}`;
}

function buildCaptureHealth(stats = null, diagnostics = null) {
    const tlsHandshakeErrorCount = Number(diagnostics?.tlsHandshakeErrorCount) || 0;
    const proxyTrafficSeen = Boolean(diagnostics?.proxyTrafficSeen);

    if (tlsHandshakeErrorCount > 0) {
        return {
            status: 'tls-untrusted',
            message: `录包服务已收到代理连接，但 HTTPS 握手失败 ${tlsHandshakeErrorCount} 次；客户端不信任 mitmproxy 证书，最近目标：${diagnostics?.lastServerHost || '未知'}。`
        };
    }

    if (proxyTrafficSeen && (!stats || Number(stats.requestCount) <= 0)) {
        return {
            status: 'connect-only',
            message: `录包服务已收到代理连接，但未进入可解密 HTTP flow；最近目标：${diagnostics?.lastServerHost || '未知'}。`
        };
    }

    if (!stats || typeof stats !== 'object') {
        return {
            status: 'unknown',
            message: '未读取到录包统计文件，无法判断代理是否收到流量。'
        };
    }

    const requestCount = Number(stats.requestCount) || 0;
    const recordedCount = Number(stats.recordedCount) || 0;
    const filteredCount = Number(stats.filteredCount) || 0;
    const blockedCount = Number(stats.blockedCount) || 0;
    const errorCount = Number(stats.errorCount) || 0;

    if (requestCount <= 0) {
        return {
            status: 'no-traffic',
            message: '录包服务未收到代理请求，请确认被测端代理已指向当前录包端口。'
        };
    }

    if (blockedCount > 0 && recordedCount <= 0 && blockedCount >= requestCount) {
        return {
            status: 'blocked-only',
            message: `录包服务收到 ${requestCount} 个请求，全部被访问策略拦截；这些干扰页不会写入 HAR。`
        };
    }

    if (blockedCount > 0 && recordedCount > 0) {
        return {
            status: 'ok-with-blocks',
            message: `录包服务已记录 ${recordedCount} 条流量，并拦截 ${blockedCount} 条干扰流量。`
        };
    }

    if (recordedCount <= 0 && filteredCount > 0) {
        return {
            status: 'filtered',
            message: '录包服务收到请求，但全部被过滤项排除，请检查域名/IP 过滤配置。'
        };
    }

    if (recordedCount <= 0 && errorCount > 0) {
        return {
            status: 'error',
            message: `录包服务收到请求但未形成 HAR，最近错误：${stats.lastError || '未知错误'}。`
        };
    }

    if (recordedCount <= 0) {
        return {
            status: 'unrecorded',
            message: '录包服务收到请求，但未形成可分析响应，需检查 HTTPS 证书信任或目标流量是否经过代理。'
        };
    }

    if (errorCount > 0) {
        return {
            status: 'partial-error',
            message: `录包服务已记录 ${recordedCount} 条流量，同时存在 ${errorCount} 个错误。`
        };
    }

    return {
        status: 'ok',
        message: `录包服务已收到 ${requestCount} 个请求，记录 ${recordedCount} 条流量。`
    };
}

function buildEmptyCaptureMessage(stats = null, diagnostics = null, fallback = 'HAR 没有记录到可分析的流量。') {
    const health = buildCaptureHealth(stats, diagnostics);
    if (health.status === 'unknown') {
        return `${fallback} ${health.message}`;
    }
    return `${fallback} ${health.message}`;
}

function saveLearnedPatternsAsTemplates(patterns = [], sourceLabel = '自动学习') {
    const safePatterns = Array.isArray(patterns) ? patterns : [];
    if (safePatterns.length === 0) {
        return { successCount: 0 };
    }

    const templates = safePatterns.map((pattern, index) => ({
        name: `${pattern.platform} [${pattern.templateScope || 'list'}] - ${sourceLabel} #${index + 1}`,
        platform: pattern.platform,
        method: pattern.method,
        baseUrl: pattern.baseUrl,
        templateScope: pattern.templateScope || 'list',
        queryParams: pattern.queryParams,
        bodyParams: pattern.bodyParams,
        variableParams: pattern.variableParams,
        headers: pattern.headers
    }));
    return ApiTemplateModel.saveBatch(templates);
}

app.post('/api/smart-collect/preflight', async (req, res) => {
    const { platformList, targetList } = resolveCollectPlatformsAndTargets(req.body);

    try {
        const result = await smartController.runAutomationPreflight(platformList, {
            cities: targetList,
            collectionMode: 'har'
        });
        const capturePreflight = buildCaptureRecorderPreflight();
        const selfHealPreflight = AI_FEATURES_ENABLED
            ? TaskSelfHealService.buildPreflight({
                platforms: platformList,
                cities: targetList,
                settings: AppSettingModel.getSelfHealSettings(),
                networkSettings: AppSettingModel.getProxySettings()
            })
            : {
                canStart: true,
                canRecover: false,
                summary: '自动排查已暂时下线，跳过自愈预检。',
                checks: [
                    {
                        status: 'info',
                        label: '后续更新项',
                        message: '自动排查与自愈已暂时下线，不影响方式二录包与自动分析。'
                    }
                ]
            };
        res.json({
            success: true,
            data: {
                ...result,
                canStart: Boolean(result.canStart) && capturePreflight.canStart && selfHealPreflight.canStart,
                checks: [
                    ...(Array.isArray(result.checks) ? result.checks : []),
                    capturePreflight.check,
                    ...selfHealPreflight.checks
                ],
                captureRecorder: capturePreflight.status,
                aiFeatures: buildAiFeatureStatus(),
                selfHeal: {
                    summary: selfHealPreflight.summary,
                    canRecover: selfHealPreflight.canStart
                }
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/page-collect/preflight', async (req, res) => {
    const { platformList, cityList } = resolveCollectPlatformsAndCities(req.body);
    const pageCollectionMode = String(req.body?.pageCollectionMode || 'page-assisted').trim();

    try {
        const result = await smartController.runAutomationPreflight(platformList, {
            cities: cityList,
            collectionMode: 'page-ocr',
            pageCollectionMode
        });
        result.pageCollectionMode = pageCollectionMode;
        res.json({ success: true, data: result });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/method1/status', async (req, res) => {
    try {
        const result = await method1Service.getStatus({
            platform: req.query.platform || req.query.platformId || 'didi-charging'
        });
        res.json(result);
    } catch (error) {
        res.json({
            success: true,
            available: false,
            reason: error.reason || 'unknown_error',
            checks: {},
            error: error.message
        });
    }
});

app.post('/api/method1/run-basic-check', async (req, res) => {
    try {
        const result = await method1Service.runBasicCheck({
            platform: req.body?.platform || req.body?.platformId || 'didi-charging',
            city: req.body?.city || '',
            targetCity: req.body?.targetCity || '',
            maxScrolls: req.body?.maxScrolls
        });
        res.json(result);
    } catch (error) {
        res.json({
            success: true,
            available: false,
            reason: error.reason || 'unknown_error',
            checks: {},
            before: null,
            after: null,
            scroll: {
                status: 'unavailable',
                reason: error.reason || 'unknown_error'
            },
            error: error.message
        });
    }
});


app.post('/api/method1/open-miniapp', async (req, res) => {
    try {
        const result = await method1Service.openMiniApp({
            platform: req.body?.platform || req.body?.platformId || 'didi-charging',
            waitMs: req.body?.waitMs
        });
        res.json(result);
    } catch (error) {
        res.json({ success: false, available: false, reason: error.reason || 'miniapp_open_failed', error: error.message });
    }
});

app.post('/api/method1/actions/screenshot', async (req, res) => {
    try {
        const result = await method1Service.screenshotAction({
            ...req.body,
            platform: req.body?.platform || req.body?.platformId || 'didi-charging'
        });
        res.json(result);
    } catch (error) {
        res.json({ success: false, available: false, reason: error.reason || 'screenshot_failed', error: error.message });
    }
});

app.post('/api/method1/actions/observe', async (req, res) => {
    try {
        const result = await method1Service.observeAction({
            ...req.body,
            platform: req.body?.platform || req.body?.platformId || 'didi-charging'
        });
        res.json(result);
    } catch (error) {
        res.json({ success: false, available: false, reason: error.reason || 'page_not_recognized', error: error.message });
    }
});

app.post('/api/method1/actions/scroll', async (req, res) => {
    try {
        const result = await method1Service.scrollAction({
            ...req.body,
            platform: req.body?.platform || req.body?.platformId || 'didi-charging'
        });
        res.json(result);
    } catch (error) {
        res.json({ success: false, available: false, reason: error.reason || 'scroll_failed', error: error.message });
    }
});

app.post('/api/method1/actions/back', async (req, res) => {
    try {
        const result = await method1Service.backAction({
            ...req.body,
            platform: req.body?.platform || req.body?.platformId || 'didi-charging'
        });
        res.json(result);
    } catch (error) {
        res.json({ success: false, available: false, reason: error.reason || 'back_failed', error: error.message });
    }
});

app.post('/api/method1/actions/tap', async (req, res) => {
    try {
        const result = await method1Service.tapAction({
            ...req.body,
            platform: req.body?.platform || req.body?.platformId || 'didi-charging'
        });
        res.json(result);
    } catch (error) {
        res.json({ success: false, available: false, reason: error.reason || 'tap_failed', error: error.message });
    }
});

app.post('/api/method1/actions/tap-by-text', async (req, res) => {
    try {
        const result = await method1Service.tapByTextAction({
            ...req.body,
            platform: req.body?.platform || req.body?.platformId || 'didi-charging'
        });
        res.json(result);
    } catch (error) {
        res.json({ success: false, available: false, reason: error.reason || 'tap_failed', error: error.message });
    }
});

app.post('/api/method1/actions/switch-city', async (req, res) => {
    try {
        const result = await method1Service.switchCityAction({
            ...req.body,
            platform: req.body?.platform || req.body?.platformId || 'didi-charging',
            city: req.body?.city || req.body?.targetCity || ''
        });
        res.json(result);
    } catch (error) {
        res.json({ success: false, available: false, reason: error.reason || 'city_switch_verify_failed', error: error.message });
    }
});

app.post('/api/method1/actions/run-adaptive', async (req, res) => {
    try {
        const result = await method1Service.runAdaptive({
            ...req.body,
            platform: req.body?.platform || req.body?.platformId || 'didi-charging'
        });
        res.json(result);
    } catch (error) {
        res.json({ success: false, available: false, reason: error.reason || 'unknown_error', error: error.message, summary: {}, actionTrace: [] });
    }
});

// 开始智能采集会话
app.post('/api/smart-collect/start', async (req, res) => {
    const {
        platform,
        platforms,
        autoScroll,
        minDurationMs,
        maxDurationMs,
        scrollIntervalSeconds,
        scrollMode,
        scrollCount,
        scrollDurationMs,
        scrollIntervalMin,
        scrollIntervalMax,
        cities,
        city,
        targetCities,
        targets,
        targetLocations,
        landmarks,
        keywords,
        pageCaptureBatchSize,
        captureFilters
    } = req.body;
    const platformList = platforms || (platform ? [platform] : []);

    if (!Array.isArray(platformList) || platformList.length === 0) {
        return res.status(400).json({ success: false, error: 'platforms required' });
    }

    const missingPlatform = findMissingRuntimePlatform(platformList);
    if (missingPlatform) {
        return res.status(404).json({ success: false, error: `Platform not found: ${missingPlatform}` });
    }

    const targetList = normalizeSmartCollectTargets(
        targets || targetLocations || landmarks || keywords || targetCities || cities || city || []
    );
    if (targetList.length === 0) {
        return res.status(400).json({ success: false, error: 'targets required' });
    }
    let captureSession = null;
    try {
        captureSession = startSmartCollectCaptureSession(platformList, targetList, captureFilters || {});
        const result = await smartController.startSmartSession(platformList, {
            autoScroll,
            minDurationMs,
            maxDurationMs,
            scrollIntervalSeconds,
            scrollMode: scrollMode || 'count',
            scrollCount: scrollCount || 10,
            scrollDurationMs: scrollDurationMs || null,
            scrollIntervalMin: scrollIntervalMin || 4000,
            scrollIntervalMax: scrollIntervalMax || 8000,
            cities: targetList,
            captureDuringScroll: true,
            pageCaptureBatchSize: pageCaptureBatchSize || 1,
            captureSession
        });
        if (result?.sessionId) {
            smartController.attachCaptureSession(result.sessionId, captureSession);
        }
        res.json({ ...result, captureSession });
    } catch (error) {
        if (captureSession) {
            try {
                captureRecorderService.stopSession();
            } catch (stopError) {
                console.warn('启动方式二失败后停止内置录包失败:', stopError.message);
            }
        }
        res.status(error.statusCode || 500).json({
            success: false,
            code: error.code || 'smart_collect_start_failed',
            error: error.message,
            recorderStatus: error.recorderStatus
        });
    }
});

app.post('/api/page-collect/start', async (req, res) => {
    const {
        platform,
        platforms,
        scrollIntervalSeconds,
        scrollMode,
        scrollCount,
        scrollDurationMs,
        scrollIntervalMin,
        scrollIntervalMax,
        pageCaptureBatchSize,
        pageCollectionMode,
        cities,
        city,
        targetCities
    } = req.body;
    const platformList = platforms || (platform ? [platform] : []);

    if (!Array.isArray(platformList) || platformList.length === 0) {
        return res.status(400).json({ success: false, error: 'platforms required' });
    }

    const missingPlatform = findMissingRuntimePlatform(platformList);
    if (missingPlatform) {
        return res.status(404).json({ success: false, error: `Platform not found: ${missingPlatform}` });
    }

    try {
        const result = await smartController.startPageOcrSession(platformList, {
            scrollIntervalSeconds,
            scrollMode: scrollMode || 'count',
            scrollCount: scrollCount || 10,
            scrollDurationMs: scrollDurationMs || null,
            scrollIntervalMin: scrollIntervalMin || 4000,
            scrollIntervalMax: scrollIntervalMax || 8000,
            pageCaptureBatchSize: pageCaptureBatchSize || 1,
            pageCollectionMode: pageCollectionMode || 'page-assisted',
            cities: cities || targetCities || city || []
        });
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 执行自动滑动
app.post('/api/smart-collect/scroll', async (req, res) => {
    const { sessionId, scrollCount, scrollInterval } = req.body;
    
    if (!sessionId) {
        return res.status(400).json({ success: false, error: 'sessionId required' });
    }
    
    try {
        const result = await smartController.performAutoScroll(
            sessionId,
            scrollCount || 10,
            scrollInterval || 2
        );
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 获取单个采集会话状态
app.get('/api/smart-collect/status/:sessionId', (req, res) => {
    try {
        const session = smartController.getSession(req.params.sessionId);
        if (!session) {
            return res.status(404).json({ success: false, error: 'Session not found' });
        }
        res.json({ success: true, data: session });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 完成智能采集会话
app.post('/api/smart-collect/finish', async (req, res) => {
    const { sessionId } = req.body;
    
    if (!sessionId) {
        return res.status(400).json({ success: false, error: 'sessionId required' });
    }
    
    try {
        const result = smartController.requestFinishSession(sessionId);
        const captureSession = result.success ? stopSmartCollectCaptureSession(sessionId, 'finish') : null;
        const captureAnalysis = captureSession
            ? await analyzeSmartCollectCaptureSession(sessionId, captureSession, 'finish')
            : null;
        res.json({ ...result, captureSession: captureAnalysis?.captureSession || captureSession, captureAnalysis });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 获取活动会话
app.get('/api/smart-collect/sessions', (req, res) => {
    try {
        const sessions = smartController.getActiveSessions();
        res.json({ success: true, data: sessions });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 取消会话
app.post('/api/smart-collect/cancel', async (req, res) => {
    const { sessionId } = req.body;
    
    if (!sessionId) {
        return res.status(400).json({ success: false, error: 'sessionId required' });
    }
    
    try {
        const result = smartController.cancelSession(sessionId);
        const captureSession = result.success ? stopSmartCollectCaptureSession(sessionId, 'cancel') : null;
        const captureAnalysis = captureSession
            ? await analyzeSmartCollectCaptureSession(sessionId, captureSession, 'cancel')
            : null;
        res.json({ ...result, captureSession: captureAnalysis?.captureSession || captureSession, captureAnalysis });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 解析 HAR 会话文件
// T3 安全止血：文件路径校验
const ALLOWED_DATA_DIR = path.resolve(path.join(__dirname, '../data'));

function isPathUnderDataDir(inputPath) {
    const resolved = path.resolve(inputPath);
    return resolved.startsWith(ALLOWED_DATA_DIR + path.sep) || resolved === ALLOWED_DATA_DIR;
}

function sanitizeFilename(name) {
    const cleaned = String(name || '').replace(/\.\./g, '').replace(/[\/\\]/g, '');
    if (!cleaned || cleaned !== String(name || '').replace(/\.\./g, '').replace(/[\/\\]/g, '')) {
        return null; // 包含无法清除的路径遍历字符
    }
    return cleaned;
}

app.post('/api/parse-har', async (req, res) => {
    const { filePath } = req.body;
    
    if (!filePath) {
        return res.status(400).json({ success: false, error: 'filePath required' });
    }
    if (!isPathUnderDataDir(filePath)) {
        return res.status(403).json({ success: false, error: 'filePath must be under data/ directory' });
    }
    
    try {
        const stations = await harParser.parseSessionFile(filePath);
        
        if (stations.length > 0) {
            StationModel.insertBatch(stations);
        }
        
        res.json({ 
            success: true, 
            message: `Parsed ${stations.length} stations`,
            data: stations
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 解析上传的 HAR 文件内容（新增）
app.post('/api/parse-har-upload', async (req, res) => {
    const { filename, content } = req.body;
    
    if (!filename || !content) {
        return res.status(400).json({ success: false, error: 'filename and content required' });
    }
    const safeFilename = sanitizeFilename(filename);
    if (!safeFilename) {
        return res.status(403).json({ success: false, error: 'filename contains invalid path characters' });
    }
    
    try {
        // 将内容写入临时文件
        const tempDir = path.join(__dirname, '../data/temp');
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }
        
        const tempFile = path.join(tempDir, `upload-${Date.now()}-${safeFilename}`);
        fs.writeFileSync(tempFile, content, 'utf8');
        
        console.log(`\n📤 处理上传的文件: ${filename}`);
        
        // 解析文件
        const stations = await harParser.parseSessionFile(tempFile);
        
        // 保存到数据库
        if (stations.length > 0) {
            StationModel.insertBatch(stations);
            console.log(`✅ 已保存 ${stations.length} 个场站到数据库`);
        }
        
        // 删除临时文件
        fs.unlinkSync(tempFile);
        
        res.json({ 
            success: true, 
            message: `解析成功，找到 ${stations.length} 个场站`,
            stationCount: stations.length,
            data: stations
        });
    } catch (error) {
        console.error('解析上传文件失败:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 特来电运行时数据捕获
app.post('/api/teld/runtime-capture', (req, res) => {
    const { payload, meta } = req.body;

    if (payload === undefined) {
        return res.status(400).json({ success: false, error: 'payload required' });
    }

    try {
        const captureDir = path.join(__dirname, '../data/teld-runtime');
        if (!fs.existsSync(captureDir)) {
            fs.mkdirSync(captureDir, { recursive: true });
        }

        const captureFile = path.join(captureDir, `capture-${Date.now()}.json`);
        fs.writeFileSync(captureFile, JSON.stringify({ meta, payload }, null, 2), 'utf8');

        const stations = teldRuntimeParser.extractStations(payload, meta);
        const insertResult = stations.length > 0
            ? StationModel.insertBatch(stations)
            : { successCount: 0, skipCount: 0 };

        res.json({
            success: true,
            message: `特来电运行时数据已接收，识别 ${stations.length} 个场站`,
            captureFile,
            stationCount: stations.length,
            insertedCount: insertResult.successCount || 0,
            skippedCount: insertResult.skipCount || 0
        });
    } catch (error) {
        console.error('特来电运行时数据处理失败:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

function resolvePageCaptureTitleKeywords(platformId) {
    const miniProgram = findRuntimeMiniProgram(platformId);
    if (!miniProgram) {
        return [];
    }
    return [miniProgram.name, miniProgram.searchKeyword].filter(Boolean);
}

function handlePageCapture(req, res, forcedPlatform = null) {
    try {
        const platform = String(forcedPlatform || req.body?.platform || '').trim();
        if (!platform) {
            return res.status(400).json({ success: false, error: 'platform required' });
        }

        const titleKeywords = Array.isArray(req.body?.titleKeywords) && req.body.titleKeywords.length > 0
            ? req.body.titleKeywords
            : resolvePageCaptureTitleKeywords(platform);
        const result = wechatLiveOCRService.captureCurrentWindow({
            platform,
            titleKeywords,
            stage: req.body?.stage || 'manual'
        });
        const insertResult = result.stations.length > 0
            ? StationModel.insertBatch(result.stations)
            : { successCount: 0, skipCount: 0 };

        res.json({
            success: true,
            message: `${platform} 页面 OCR 识别 ${result.stations.length} 个场站`,
            platform,
            stationCount: result.stations.length,
            insertedCount: insertResult.successCount || 0,
            skippedCount: insertResult.skipCount || 0,
            screenshotPath: result.screenshotPath,
            capturePath: result.capturePath,
            ocrPath: result.ocrPath,
            data: result.stations
        });
    } catch (error) {
        console.error('页面 OCR 捕获失败:', error);
        res.status(500).json({ success: false, error: error.message });
    }
}

// 当前小程序页面截图 OCR 捕获
app.post('/api/page-capture', (req, res) => handlePageCapture(req, res));

// 兼容旧接口：特来电页面 OCR
app.post('/api/teld/ocr-capture', (req, res) => handlePageCapture(req, res, 'teld'));

// ============ 智能爬虫 API ============

// 学习 API 模式
app.post('/api/crawler/learn', async (req, res) => {
    const { harFilePath } = req.body;
    
    if (!harFilePath) {
        return res.status(400).json({ success: false, error: 'harFilePath required' });
    }
    if (!isPathUnderDataDir(harFilePath)) {
        return res.status(403).json({ success: false, error: 'harFilePath must be under data/ directory' });
    }
    
    try {
        const patterns = await smartCrawler.learnFromHAR(harFilePath);
        res.json({ 
            success: true, 
            message: `学习到 ${patterns.length} 个 API 模式`,
            patterns: patterns.map(p => ({
                platform: p.platform,
                method: p.method,
                baseUrl: p.baseUrl,
                templateScope: p.templateScope || 'list',
                variableParams: Object.keys(p.variableParams)
            }))
        });
    } catch (error) {
        console.error('学习失败:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 从上传的 HAR 学习
app.post('/api/crawler/learn-upload', async (req, res) => {
    const { filename, content } = req.body;
    
    if (!filename || !content) {
        return res.status(400).json({ success: false, error: 'filename and content required' });
    }
    const safeFilename = sanitizeFilename(filename);
    if (!safeFilename) {
        return res.status(403).json({ success: false, error: 'filename contains invalid path characters' });
    }

    const runId = RunHistoryModel.startRun('learn-upload', {
        filename: safeFilename,
        contentLength: typeof content === 'string' ? content.length : 0
    });
    
    try {
        RunHistoryModel.appendLog(runId, `开始学习 HAR: ${safeFilename}`);
        // 写入临时文件
        const tempDir = path.join(__dirname, '../data/temp');
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }
        
        const tempFile = path.join(tempDir, `learn-${Date.now()}-${safeFilename}`);
        fs.writeFileSync(tempFile, content, 'utf8');
        
        // 学习 API 模式
        const patterns = await smartCrawler.learnFromHAR(tempFile);
        
        // 删除临时文件
        fs.unlinkSync(tempFile);

        RunHistoryModel.appendLog(runId, `学习完成，识别模板 ${patterns.length} 条`);
        RunHistoryModel.finishRun(runId, 'success', { patternCount: patterns.length });
        
        res.json({ 
            success: true, 
            message: `学习到 ${patterns.length} 个 API 模式`,
            patterns: patterns
        });
    } catch (error) {
        console.error('学习失败:', error);
        RunHistoryModel.appendLog(runId, `HAR 学习失败: ${error.message}`, 'error');
        RunHistoryModel.finishRun(runId, 'failed', null, error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 执行智能爬取
app.post('/api/crawler/crawl', async (req, res) => {
    const { pattern, coordinates, pageSize, maxPages, seedStations = [], testMode, targetLocation } = req.body;

    if (!pattern) {
        return res.status(400).json({ success: false, error: 'pattern required' });
    }

    try {
        const templateScope = pattern.templateScope || 'list';
        let stations = [];
        const requestedRunLimit = req.body.perRunUnlimited === true ? null : req.body.perRunLimit;
        const runQuota = smartCrawler.createRunRequestQuota(requestedRunLimit);
        const requestBudget = normalizeTestMode(testMode)
            ? smartCrawler.createTestRequestBudget(pattern.platform)
            : null;
        const firstCoord = Array.isArray(coordinates) ? coordinates[0] : null;
        const proxyContext = normalizeTargetLocation(targetLocation, firstCoord?.lat, firstCoord?.lng);
        const preflightDiagnostics = buildTemplatePreflightDiagnostics(pattern, proxyContext);

        if (templateScope === 'detail') {
            if (!Array.isArray(seedStations) || seedStations.length === 0) {
                return res.status(400).json({ success: false, error: 'detail template requires seedStations' });
            }
            stations = await smartCrawler.crawlDetail(pattern, { seedStations, requestBudget, runQuota, proxyContext });
        } else {
            if (!Array.isArray(coordinates) || coordinates.length === 0) {
                return res.status(400).json({ success: false, error: 'list template requires coordinates' });
            }
            stations = await smartCrawler.crawl(pattern, {
                coordinates,
                pageSize: pageSize || 20,
                maxPages: maxPages || 5,
                requestBudget,
                runQuota,
                proxyContext
            });
        }

        const insertResult = stations.length > 0
            ? StationModel.insertBatch(stations)
            : { successCount: 0, skipCount: 0 };

        res.json({
            success: true,
            stationCount: stations.length,
            insertedCount: insertResult.successCount || 0,
            skippedCount: insertResult.skipCount || 0,
            data: stations,
            testMode: Boolean(requestBudget),
            preflightDiagnostics,
            requestBudget: smartCrawler.getTestRequestBudgetSummary(requestBudget),
            quotaStats: smartCrawler.getQuotaStatsSummary(),
            runQuota: smartCrawler.getRunRequestQuotaSummary(runQuota, { includeRequests: false })
        });
    } catch (error) {
        console.error('爬取失败:', error);
        if (smartCrawler.isRunRequestLimitExceeded(error)) {
            return res.status(429).json({
                success: false,
                error: error.message,
                code: error.code,
                runQuota: error.runQuota || null,
                quotaStats: smartCrawler.getQuotaStatsSummary()
            });
        }
        res.status(500).json({ success: false, error: error.message });
    }
});

function createCoordinateCrawlJob(body = {}) {
    const {
        platforms,
        centerLat,
        centerLng,
        radius = 10,
        gridSize = 2,
        pageSize = 20,
        maxPages = 5,
        crawlMode: rawCrawlMode = 'both',
        testMode,
        targetLocation
    } = body;

    if (!Array.isArray(platforms) || platforms.length === 0) {
        const error = new Error('platforms required');
        error.statusCode = 400;
        throw error;
    }

    const rawTargetLocations = Array.isArray(body.targetLocations) ? body.targetLocations : [];
    let lat = centerLat === null || centerLat === undefined || centerLat === '' ? NaN : Number(centerLat);
    let lng = centerLng === null || centerLng === undefined || centerLng === '' ? NaN : Number(centerLng);
    if (!Number.isFinite(lat) && rawTargetLocations.length > 0) {
        lat = Number(rawTargetLocations[0]?.lat);
    }
    if (!Number.isFinite(lng) && rawTargetLocations.length > 0) {
        lng = Number(rawTargetLocations[0]?.lng);
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        const error = new Error('invalid centerLat or centerLng');
        error.statusCode = 400;
        throw error;
    }

    const crawlMode = normalizeCrawlMode(rawCrawlMode);
    if (!crawlMode) {
        const error = new Error('crawlMode must be list, detail, or both');
        error.statusCode = 400;
        throw error;
    }

    const targetLocations = normalizeCoordinateTargetLocations(rawTargetLocations, targetLocation, lat, lng);
    if (targetLocations.length === 0) {
        const error = new Error('targetLocations required');
        error.statusCode = 400;
        throw error;
    }

    const proxyContext = targetLocations[0];
    const radiusValue = Number(radius) || 10;
    const gridSizeValue = Number(gridSize) || 2;
    const pageSizeValue = Number(pageSize) || 20;
    const maxPagesValue = Number(maxPages) || 5;
    const normalizedTestMode = normalizeTestMode(testMode);

    const runId = RunHistoryModel.startRun('crawl-platforms-with-coordinates', {
        platforms,
        centerLat: lat,
        centerLng: lng,
        radius: radiusValue,
        gridSize: gridSizeValue,
        pageSize: pageSizeValue,
        maxPages: maxPagesValue,
        crawlMode,
        testMode: normalizedTestMode,
        targetLocation: proxyContext,
        targetLocations
    });
    const requestedRunLimit = body.perRunUnlimited === true ? null : body.perRunLimit;
    const runQuota = createAggregateRunQuota(requestedRunLimit, targetLocations.length);

    return {
        runId,
        platforms,
        lat,
        lng,
        radius: radiusValue,
        gridSize: gridSizeValue,
        pageSize: pageSizeValue,
        maxPages: maxPagesValue,
        crawlMode,
        testMode: normalizedTestMode,
        proxyContext,
        targetLocations,
        requestedRunLimit,
        runQuota
    };
}

function createAggregateRunQuota(requestedRunLimit, targetCount = 1) {
    const perTargetQuota = smartCrawler.createRunRequestQuota(requestedRunLimit);
    if (perTargetQuota.unlimited) {
        return smartCrawler.createRunRequestQuota(null);
    }
    const aggregateQuota = smartCrawler.createRunRequestQuota(perTargetQuota.limit * Math.max(1, Number(targetCount) || 1));
    aggregateQuota.perTargetLimit = perTargetQuota.limit;
    aggregateQuota.targetCount = Math.max(1, Number(targetCount) || 1);
    aggregateQuota.quotaMode = 'per-target';
    return aggregateQuota;
}

function normalizeCoordinateTargetLocations(rawTargetLocations = [], fallbackLocation = null, centerLat = null, centerLng = null) {
    const source = rawTargetLocations.length > 0
        ? rawTargetLocations
        : [fallbackLocation || { lat: centerLat, lng: centerLng }];

    return source
        .map((item, index) => {
            const normalized = normalizeTargetLocation(item, item?.lat ?? centerLat, item?.lng ?? centerLng);
            const lat = Number(normalized.lat);
            const lng = Number(normalized.lng);
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
                return null;
            }

            const label = normalized.keyword || normalized.name || normalized.city || `目标${index + 1}`;
            return {
                ...normalized,
                keyword: normalized.keyword || label,
                name: normalized.name || label,
                lat,
                lng,
                index: index + 1
            };
        })
        .filter(Boolean);
}

async function executeCoordinateCrawlJob(job) {
    const {
        runId,
        platforms,
        radius,
        gridSize,
        pageSize,
        maxPages,
        crawlMode,
        testMode,
        targetLocations,
        requestedRunLimit
    } = job;

    const state = {
        coordinateCount: 0,
        totalStations: 0,
        totalInserted: 0,
        totalSkipped: 0,
        failureCount: 0,
        targetSummaries: [],
        activeTarget: null
    };
    const updateProgress = (status = 'running') => {
        RunHistoryModel.updateRunSummary(runId, buildCoordinateRunSummary(job, state, status));
    };

    try {
        RunHistoryModel.appendLog(runId, `本次目标位置 ${targetLocations.length} 个`);
        RunHistoryModel.appendLog(runId, `检索模式: ${crawlMode}`);
        updateProgress();

        for (const target of targetLocations) {
            const targetLabel = formatTargetLocationLabel(target);
            const targetRunQuota = smartCrawler.createRunRequestQuota(requestedRunLimit);

            state.activeTarget = target;
            const coordinates = SmartCrawler.generateGridCoordinates(
                target.lat,
                target.lng,
                radius,
                gridSize
            );
            state.coordinateCount += coordinates.length;
            RunHistoryModel.appendLog(runId, `目标位置 ${target.index}/${targetLocations.length}: ${targetLabel}`);
            RunHistoryModel.appendLog(runId, `生成坐标网格 ${coordinates.length} 个点`);

            const targetSummary = {
                targetLocation: target,
                targetLabel,
                coordinateCount: coordinates.length,
                status: 'running',
                totalStations: 0,
                totalInserted: 0,
                totalSkipped: 0,
                runQuota: smartCrawler.getRunRequestQuotaSummary(targetRunQuota, { includeRequests: false }),
                summary: []
            };
            state.targetSummaries.push(targetSummary);
            updateProgress();

            for (const platform of platforms) {
                if (!smartCrawler.hasRunRequestQuotaRemaining(targetRunQuota)) {
                    RunHistoryModel.appendLog(
                        runId,
                        `目标位置 ${targetLabel} 当次请求已达上限，停止后续平台: ${smartCrawler.formatRunRequestQuota(targetRunQuota)}`,
                        'warn'
                    );
                    targetSummary.runQuota = smartCrawler.getRunRequestQuotaSummary(targetRunQuota, { includeRequests: false });
                    targetSummary.summary.push({
                        platform,
                        success: false,
                        reason: 'run_request_limit_exceeded',
                        runQuota: targetSummary.runQuota
                    });
                    break;
                }

                RunHistoryModel.appendLog(runId, `开始平台爬取: ${platform}`);
                const { listTemplates, detailTemplates } = getTemplatesByMode(platform, crawlMode);
                if (listTemplates.length === 0 && detailTemplates.length === 0) {
                    RunHistoryModel.appendLog(runId, `平台 ${platform} 无可用模板`, 'warn');
                    state.failureCount += 1;
                    targetSummary.summary.push({
                        platform,
                        success: false,
                        reason: 'no_active_template',
                        selfHeal: buildApiFailureSelfHeal(platform, 'no_active_template', targetRunQuota)
                    });
                    updateProgress();
                    continue;
                }

                try {
                    const result = await runPlatformCrawl({
                        platform,
                        crawlMode,
                        coordinates,
                        centerLat: target.lat,
                        centerLng: target.lng,
                        radius,
                        pageSize,
                        maxPages,
                        runId,
                        testMode,
                        runQuota: targetRunQuota,
                        proxyContext: target,
                        progressReporter: () => {
                            targetSummary.runQuota = smartCrawler.getRunRequestQuotaSummary(targetRunQuota, { includeRequests: false });
                            updateProgress();
                        }
                    });
                    targetSummary.runQuota = smartCrawler.getRunRequestQuotaSummary(targetRunQuota, { includeRequests: false });

                    if (!result.success) {
                        state.failureCount += 1;
                        targetSummary.summary.push({
                            platform,
                            success: false,
                            reason: result.reason,
                            diagnostics: result.diagnostics,
                            stationCount: result.stationCount || 0,
                            insertedCount: result.insertedCount || 0,
                            skippedCount: result.skippedCount || 0,
                            runQuota: result.runQuota,
                            selfHeal: buildApiFailureSelfHeal(platform, result.reason, result.runQuota)
                        });
                        updateProgress();
                        continue;
                    }

                    state.totalStations += result.stationCount || 0;
                    state.totalInserted += result.insertedCount || 0;
                    state.totalSkipped += result.skippedCount || 0;
                    targetSummary.totalStations += result.stationCount || 0;
                    targetSummary.totalInserted += result.insertedCount || 0;
                    targetSummary.totalSkipped += result.skippedCount || 0;

                    targetSummary.summary.push({
                        platform,
                        success: true,
                        crawlMode,
                        coordinateCount: coordinates.length,
                        listTemplateCount: result.listTemplateCount,
                        detailTemplateCount: result.detailTemplateCount,
                        listStationCount: result.listStationCount,
                        detailStationCount: result.detailStationCount,
                        stationCount: result.stationCount,
                        insertedCount: result.insertedCount,
                        skippedCount: result.skippedCount,
                        testMode: result.testMode,
                        requestBudget: result.requestBudget,
                        quotaStats: result.quotaStats,
                        runQuota: result.runQuota
                    });
                    RunHistoryModel.appendLog(
                        runId,
                        `平台 ${platform} 完成: 列表 ${result.listStationCount}，详情 ${result.detailStationCount}，合并 ${result.stationCount}，入库 ${result.insertedCount}，跳过 ${result.skippedCount}`
                    );
                    updateProgress();
                } catch (error) {
                    RunHistoryModel.appendLog(runId, `平台 ${platform} 失败: ${error.message}`, 'error');
                    state.failureCount += 1;
                    if (smartCrawler.isRunRequestLimitExceeded(error)) {
                        const selfHeal = buildApiFailureSelfHeal(
                            platform,
                            error.message,
                            error.runQuota || smartCrawler.getRunRequestQuotaSummary(targetRunQuota, { includeRequests: false })
                        );
                        targetSummary.runQuota = error.runQuota || smartCrawler.getRunRequestQuotaSummary(targetRunQuota, { includeRequests: false });
                        targetSummary.summary.push({
                            platform,
                            success: false,
                            reason: 'run_request_limit_exceeded',
                            runQuota: targetSummary.runQuota,
                            selfHeal
                        });
                        updateProgress();
                        break;
                    }
                    targetSummary.summary.push({
                        platform,
                        success: false,
                        reason: error.message,
                        selfHeal: buildApiFailureSelfHeal(
                            platform,
                            error.message,
                            smartCrawler.getRunRequestQuotaSummary(targetRunQuota, { includeRequests: false })
                        )
                    });
                    updateProgress();
                }
            }

            targetSummary.status = targetSummary.totalStations > 0
                ? 'success'
                : (targetSummary.summary.some(item => item.success === false) ? 'failed' : 'success');
            targetSummary.runQuota = smartCrawler.getRunRequestQuotaSummary(targetRunQuota, { includeRequests: false });
            state.activeTarget = null;
            updateProgress();
        }

        const finalStatus = state.totalStations > 0
            ? (state.failureCount > 0 ? 'partial' : 'success')
            : (state.failureCount > 0 ? 'failed' : 'success');
        const finalSummary = buildCoordinateRunSummary(job, state, finalStatus);
        RunHistoryModel.finishRun(
            runId,
            finalStatus === 'failed' ? 'failed' : 'success',
            finalSummary,
            finalStatus === 'failed' ? '方式三未获取到可用场站数据' : null
        );

        return {
            success: finalStatus !== 'failed',
            message: `多平台坐标爬取完成，共识别 ${state.totalStations} 个场站`,
            center: {
                lat: targetLocations[0]?.lat,
                lng: targetLocations[0]?.lng
            },
            status: finalStatus,
            coordinateCount: state.coordinateCount,
            crawlMode,
            targetLocation: targetLocations[0] || null,
            targetLocations,
            totalStations: state.totalStations,
            totalInserted: state.totalInserted,
            totalSkipped: state.totalSkipped,
            summary: finalSummary.summary,
            targetSummaries: state.targetSummaries,
            testMode,
            quotaStats: smartCrawler.getQuotaStatsSummary(),
            runQuota: finalSummary.runQuota
        };
    } catch (error) {
        console.error('多平台坐标爬取失败:', error);
        if (runId) {
            RunHistoryModel.appendLog(runId, `任务失败: ${error.message}`, 'error');
            RunHistoryModel.finishRun(runId, 'failed', null, error.message);
        }
        throw error;
    }
}

function formatTargetLocationLabel(target = {}) {
    return [target.province, target.city, target.district, target.keyword || target.name]
        .filter(Boolean)
        .join(' / ') || `${target.lat},${target.lng}`;
}

function buildCoordinateRunSummary(job, state, status = 'running') {
    const runQuota = buildAggregateRunQuotaSummary(job, state);
    const completedTargetCount = state.targetSummaries.filter(item => item.status !== 'running').length;
    const flattenedSummary = state.targetSummaries.flatMap(targetSummary =>
        (targetSummary.summary || []).map(item => ({
            ...item,
            targetLocation: targetSummary.targetLocation,
            targetLabel: targetSummary.targetLabel
        }))
    );

    return {
        status,
        coordinateCount: state.coordinateCount,
        totalStations: state.totalStations,
        totalInserted: state.totalInserted,
        totalSkipped: state.totalSkipped,
        failureCount: state.failureCount || 0,
        summary: flattenedSummary,
        targetLocation: job.targetLocations[0] || null,
        targetLocations: job.targetLocations,
        targetSummaries: state.targetSummaries,
        activeTarget: state.activeTarget,
        quotaStats: smartCrawler.getQuotaStatsSummary(),
        runQuota,
        progress: {
            status,
            targetCount: job.targetLocations.length,
            completedTargetCount,
            activeTarget: state.activeTarget,
            used: runQuota?.used || 0,
            success: runQuota?.success || 0,
            fail501: runQuota?.fail501 || 0,
            remaining: runQuota?.remaining ?? null,
            limit: runQuota?.limit ?? null,
            unlimited: Boolean(runQuota?.unlimited),
            exhausted: Boolean(runQuota?.exhausted)
        }
    };
}

function buildAggregateRunQuotaSummary(job, state) {
    const summaries = (state.targetSummaries || [])
        .map(item => item.runQuota)
        .filter(Boolean);
    if (summaries.length === 0) {
        return smartCrawler.getRunRequestQuotaSummary(job.runQuota, { includeRequests: false });
    }

    const unlimited = summaries.some(item => item.unlimited);
    const limit = unlimited ? null : summaries.reduce((sum, item) => sum + (Number(item.limit) || 0), 0);
    const used = summaries.reduce((sum, item) => sum + (Number(item.used) || 0), 0);
    const success = summaries.reduce((sum, item) => sum + (Number(item.success) || 0), 0);
    const fail501 = summaries.reduce((sum, item) => sum + (Number(item.fail501) || 0), 0);
    const requestCount = summaries.reduce((sum, item) => sum + (Number(item.requestCount) || 0), 0);
    return {
        limit,
        unlimited,
        used,
        success,
        fail501,
        remaining: unlimited ? null : Math.max(0, limit - used),
        exhausted: !unlimited && limit !== null && used >= limit,
        requestCount,
        quotaMode: 'per-target',
        targetCount: job.targetLocations.length,
        perTargetLimit: summaries.find(item => item.limit !== null && item.limit !== undefined)?.limit ?? null
    };
}

function sendCoordinateCrawlError(res, error, runQuota = null) {
    const statusCode = error.statusCode || (smartCrawler.isRunRequestLimitExceeded(error) ? 429 : 500);
    const payload = {
        success: false,
        error: error.message
    };

    if (smartCrawler.isRunRequestLimitExceeded(error)) {
        payload.code = error.code;
        payload.runQuota = error.runQuota || smartCrawler.getRunRequestQuotaSummary(runQuota, { includeRequests: false });
        payload.quotaStats = smartCrawler.getQuotaStatsSummary();
    }

    return res.status(statusCode).json(payload);
}

function buildTemplatePreflightDiagnostics(pattern, proxyContext = null) {
    const diagnostics = [];
    const signedTargetMismatch = smartCrawler.getSignedTemplateTargetMismatch(pattern, proxyContext);
    if (signedTargetMismatch) {
        diagnostics.push({
            code: 'signed_template_target_mismatch',
            severity: 'warn',
            message: signedTargetMismatch,
            action: '补齐目标城市的实际请求参数，或接入可审计的签名参数修复能力后再执行。'
        });
    }
    return diagnostics;
}

// 按多个平台 + 指定中心经纬度统一爬取
app.post('/api/crawler/crawl-platforms-with-coordinates', async (req, res) => {
    let job = null;
    try {
        job = createCoordinateCrawlJob(req.body);
        const result = await executeCoordinateCrawlJob(job);
        res.json(result);
    } catch (error) {
        sendCoordinateCrawlError(res, error, job?.runQuota || null);
    }
});

// 后台启动方式三任务，前端通过 /api/runs/:id 轮询进度
app.post('/api/crawler/crawl-platforms-with-coordinates/start', (req, res) => {
    let job = null;
    try {
        job = createCoordinateCrawlJob(req.body);
        RunHistoryModel.appendLog(job.runId, '方式三任务已进入后台执行队列');
        setImmediate(() => {
            executeCoordinateCrawlJob(job).catch(error => {
                console.error(`后台方式三任务失败 runId=${job.runId}:`, error);
            });
        });

        res.json({
            success: true,
            runId: job.runId,
            status: 'running',
            message: '方式三任务已启动，可在执行进度中查看进度条',
            runQuota: smartCrawler.getRunRequestQuotaSummary(job.runQuota, { includeRequests: false }),
            quotaStats: smartCrawler.getQuotaStatsSummary()
        });
    } catch (error) {
        sendCoordinateCrawlError(res, error, job?.runQuota || null);
    }
});

// 生成网格坐标
app.post('/api/crawler/generate-grid', (req, res) => {
    const { centerLat, centerLng, radius, gridSize } = req.body;
    
    if (!centerLat || !centerLng) {
        return res.status(400).json({ 
            success: false, 
            error: 'centerLat and centerLng required' 
        });
    }
    
    try {
        const coordinates = SmartCrawler.generateGridCoordinates(
            parseFloat(centerLat),
            parseFloat(centerLng),
            parseFloat(radius) || 10,
            parseFloat(gridSize) || 2
        );
        
        res.json({ 
            success: true, 
            count: coordinates.length,
            coordinates 
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ API 模板管理 ============

// 保存 API 模板
app.post('/api/templates', (req, res) => {
    const { name, pattern } = req.body;
    
    if (!name || !pattern) {
        return res.status(400).json({ 
            success: false, 
            error: 'name and pattern required' 
        });
    }
    
    try {
        const template = {
            name,
            platform: pattern.platform,
            method: pattern.method,
            baseUrl: pattern.baseUrl,
            templateScope: pattern.templateScope || 'list',
            queryParams: pattern.queryParams,
            bodyParams: pattern.bodyParams,
            variableParams: pattern.variableParams,
            headers: pattern.headers
        };
        
        const result = ApiTemplateModel.saveSmart(template);
        
        res.json({ 
            success: true, 
            message: '模板保存成功',
            templateId: result.lastInsertRowid
        });
    } catch (error) {
        console.error('保存模板失败:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 批量保存模板（学习后保存所有）
app.post('/api/templates/batch', (req, res) => {
    const { patterns } = req.body;
    
    if (!patterns || !Array.isArray(patterns)) {
        return res.status(400).json({ 
            success: false, 
            error: 'patterns array required' 
        });
    }
    
    try {
        // 为每个 pattern 生成默认名称
        const templates = patterns.map((p, index) => ({
            name: `${p.platform} [${p.templateScope || 'list'}] - ${new Date().toLocaleDateString()} #${index + 1}`,
            platform: p.platform,
            method: p.method,
            baseUrl: p.baseUrl,
            templateScope: p.templateScope || 'list',
            queryParams: p.queryParams,
            bodyParams: p.bodyParams,
            variableParams: p.variableParams,
            headers: p.headers
        }));
        
        const result = ApiTemplateModel.saveBatch(templates);
        
        res.json({ 
            success: true, 
            message: `成功保存 ${result.successCount} 个模板`,
            count: result.successCount
        });
    } catch (error) {
        console.error('批量保存模板失败:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 获取所有模板
app.get('/api/templates', (req, res) => {
    try {
        const templates = ApiTemplateModel.getAll();
        res.json({ success: true, data: templates });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 清理重复模板：保留重复样本中的最新入库记录
app.post('/api/templates/deduplicate', (req, res) => {
    try {
        const dryRun = req.body?.dryRun === true || req.body?.dryRun === 'true' || req.query?.dryRun === '1';
        const result = ApiTemplateModel.deduplicateExactTemplates({ dryRun });
        const actionText = dryRun ? '预览' : '清理';
        res.json({
            success: true,
            message: `${actionText}完成：共删除 ${result.removedCount} 条重复模板，重复组 ${result.duplicateGroupCount} 个`,
            data: result
        });
    } catch (error) {
        console.error('清理重复模板失败:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 获取单个模板
app.get('/api/templates/:id', (req, res) => {
    try {
        const template = ApiTemplateModel.getById(parseInt(req.params.id));
        
        if (!template) {
            return res.status(404).json({ 
                success: false, 
                error: 'Template not found' 
            });
        }
        
        res.json({ success: true, data: template });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 根据平台获取模板
app.get('/api/templates/platform/:platform', (req, res) => {
    try {
        const templates = ApiTemplateModel.getByPlatform(req.params.platform);
        res.json({ success: true, data: templates });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 更新模板
app.put('/api/templates/:id', (req, res) => {
    try {
        const result = ApiTemplateModel.update(parseInt(req.params.id), req.body);
        res.json({ 
            success: true, 
            message: '模板更新成功',
            changes: result.changes
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 删除模板
app.delete('/api/templates/:id', (req, res) => {
    try {
        ApiTemplateModel.delete(parseInt(req.params.id));
        res.json({ success: true, message: '模板删除成功' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 使用模板爬取（更新最后使用时间）
app.post('/api/templates/:id/use', async (req, res) => {
    const { coordinates, pageSize, maxPages, testMode, targetLocation } = req.body;
    
    try {
        const template = ApiTemplateModel.getById(parseInt(req.params.id));
        
        if (!template) {
            return res.status(404).json({ 
                success: false, 
                error: 'Template not found' 
            });
        }
        
        let stations = [];
        const requestedRunLimit = req.body.perRunUnlimited === true ? null : req.body.perRunLimit;
        const runQuota = smartCrawler.createRunRequestQuota(requestedRunLimit);
        const requestBudget = normalizeTestMode(testMode)
            ? smartCrawler.createTestRequestBudget(template.platform)
            : null;
        const firstCoord = Array.isArray(coordinates) ? coordinates[0] : null;
        const proxyContext = normalizeTargetLocation(targetLocation, firstCoord?.lat, firstCoord?.lng);
        const preflightDiagnostics = buildTemplatePreflightDiagnostics(template, proxyContext);

        if ((template.templateScope || 'list') === 'detail') {
            const seedStations = Array.isArray(req.body.seedStations) ? req.body.seedStations : [];
            if (seedStations.length === 0) {
                return res.status(400).json({
                    success: false,
                    error: 'detail template requires seedStations'
                });
            }
            stations = await smartCrawler.crawlDetail(template, { seedStations, requestBudget, runQuota, proxyContext });
        } else {
            stations = await smartCrawler.crawl(template, {
                coordinates,
                pageSize: pageSize || 20,
                maxPages: maxPages || 5,
                requestBudget,
                runQuota,
                proxyContext
            });
        }

        const insertResult = stations.length > 0
            ? StationModel.insertBatch(stations)
            : { successCount: 0, skipCount: 0 };

        ApiTemplateModel.updateLastUsed(template.id);
        
        res.json({ 
            success: true, 
            message: `爬取成功，获取 ${stations.length} 个场站`,
            stationCount: stations.length,
            insertedCount: insertResult.successCount || 0,
            skippedCount: insertResult.skipCount || 0,
            testMode: Boolean(requestBudget),
            preflightDiagnostics,
            requestBudget: smartCrawler.getTestRequestBudgetSummary(requestBudget),
            quotaStats: smartCrawler.getQuotaStatsSummary(),
            runQuota: smartCrawler.getRunRequestQuotaSummary(runQuota, { includeRequests: false })
        });
    } catch (error) {
        console.error('使用模板爬取失败:', error);
        if (smartCrawler.isRunRequestLimitExceeded(error)) {
            return res.status(429).json({
                success: false,
                error: error.message,
                code: error.code,
                runQuota: error.runQuota || null,
                quotaStats: smartCrawler.getQuotaStatsSummary()
            });
        }
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ 定时任务管理 ============

app.get('/api/schedules', (req, res) => {
    try {
        const schedules = scheduler.listSchedules().map(enrichScheduleWithSelfHeal);
        res.json({ success: true, data: schedules });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/schedules', (req, res) => {
    try {
        const { name, platforms, cronExpression, selfHealSettings } = req.body;
        
        if (!name || !platforms || !cronExpression) {
            return res.status(400).json({ 
                success: false, 
                error: 'name, platforms, cronExpression required' 
            });
        }

        if (selfHealSettings && typeof selfHealSettings === 'object') {
            AppSettingModel.saveSelfHealSettings(selfHealSettings);
        }

        const schedule = enrichScheduleWithSelfHeal(
            scheduler.createSchedule(name, platforms, cronExpression)
        );
        res.json({ success: true, data: schedule });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/schedules/:id/drill', (req, res) => {
    try {
        const scheduleId = parseInt(req.params.id, 10);
        const schedule = findScheduleById(scheduleId);
        if (!schedule) {
            return res.status(404).json({ success: false, error: 'Schedule not found' });
        }

        let platforms = [];
        if (Array.isArray(schedule.platforms)) {
            platforms = schedule.platforms;
        } else {
            try {
                platforms = JSON.parse(schedule.platforms || '[]');
            } catch (error) {
                platforms = [];
            }
        }

        const diagnosis = buildSelfHealDiagnosis({
            ...req.body,
            platforms,
            scheduleId
        });
        const run = recordSelfHealDiagnosis(diagnosis, {
            scheduleId,
            scheduleName: schedule.name || '',
            platform: platforms[0] || ''
        });
        const recovery = AppSettingModel.saveScheduleRecovery(scheduleId, {
            status: diagnosis.status === 'recoverable' ? '已生成排查方案' : '需人工介入',
            summary: diagnosis.status === 'recoverable'
                ? `当前 ${diagnosis.currentChainLabel}，将先修复当前能力`
                : `当前 ${diagnosis.currentChainLabel}，等待人工处理`,
            at: run.createdAt
        });

        res.json({
            success: true,
            data: {
                schedule: {
                    ...enrichScheduleWithSelfHeal(schedule),
                    last_recovery_status: recovery.status,
                    last_recovery_summary: recovery.summary,
                    last_recovery_at: recovery.at
                },
                diagnosis,
                run
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.delete('/api/schedules/:id', (req, res) => {
    try {
        scheduler.deleteSchedule(parseInt(req.params.id));
        res.json({ success: true, message: 'Schedule deleted' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.patch('/api/schedules/:id/toggle', (req, res) => {
    try {
        const { enabled } = req.body;
        scheduler.toggleSchedule(parseInt(req.params.id), enabled);
        res.json({ success: true, message: 'Schedule updated' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ 导出功能 ============

app.get('/api/export/csv', (req, res) => {
    try {
        const { platform } = req.query;
        const stations = StationModel.getRecent(10000, platform);
        
        // 生成 CSV
        const csv = ['Platform,Station ID,Station Name,Address,Price Fast,Price Slow,Price Super,Price Service,Online Fast Ports,Online Slow Ports,Fast Idle,Fast Total,Slow Idle,Slow Total,Super Idle,Super Total,Fuel92 Price,Fuel95 Price,Fuel98 Price,FuelDiesel Price,Fuel92 Count,Fuel95 Count,Fuel98 Count,FuelDiesel Count,Source Type,Source Stage,Price/Gun Snapshot At,Collected At'];
        
        for (const s of stations) {
            csv.push([
                s.platform,
                s.station_id,
                `"${s.station_name}"`,
                `"${s.address || ''}"`,
                s.price_fast || '',
                s.price_slow || '',
                s.price_super || '',
                s.price_service || '',
                s.online_fast_ports ?? '',
                s.online_slow_ports ?? '',
                s.fast_idle_ports ?? '',
                s.fast_total_ports ?? '',
                s.slow_idle_ports ?? '',
                s.slow_total_ports ?? '',
                s.super_idle_ports ?? '',
                s.super_total_ports ?? '',
                s.fuel_92_price ?? '',
                s.fuel_95_price ?? '',
                s.fuel_98_price ?? '',
                s.fuel_diesel_price ?? '',
                s.fuel_92_count ?? '',
                s.fuel_95_count ?? '',
                s.fuel_98_count ?? '',
                s.fuel_diesel_count ?? '',
                s.source_type || '',
                s.source_stage || '',
                s.price_gun_snapshot_at || s.snapshot_at || s.collected_at || '',
                s.collected_at
            ].join(','));
        }
        
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="stations-${Date.now()}.csv"`);
        res.send(csv.join('\n'));
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ OCR 置信度审核 API ============

app.get('/api/ocr-quality/dashboard', (req, res) => {
    try {
        const dashboard = StationModel.getOcrQualityDashboard();
        res.json({ success: true, data: dashboard });
    } catch (error) {
        console.error('获取OCR质量仪表盘失败:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/ocr-review/pending', (req, res) => {
    try {
        const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 100));
        const offset = Math.max(0, Number(req.query.offset) || 0);
        const rows = StationModel.getPendingReview(limit, offset);
        const total = StationModel.getPendingReviewCount();
        res.json({ success: true, data: rows, total, limit, offset });
    } catch (error) {
        console.error('获取待审核列表失败:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/ocr-review/approve/:id', (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!id || id <= 0) {
            return res.status(400).json({ success: false, error: 'invalid id' });
        }
        const result = StationModel.approveStation(id);
        if (result.changes === 0) {
            return res.status(404).json({ success: false, error: 'not found or already approved' });
        }
        res.json({ success: true, message: '审核通过', changes: result.changes });
    } catch (error) {
        console.error('审核通过失败:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/ocr-review/reject/:id', (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!id || id <= 0) {
            return res.status(400).json({ success: false, error: 'invalid id' });
        }
        const result = StationModel.rejectStation(id);
        if (result.changes === 0) {
            return res.status(404).json({ success: false, error: 'not found or already processed' });
        }
        res.json({ success: true, message: '已拒绝并移入异常池', changes: result.changes });
    } catch (error) {
        console.error('审核拒绝失败:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});


// ============ 签名健康度 & 自动刷新（Phase 3） ============

// GET /api/signature/health - 返回6个平台的签名状态
app.get('/api/signature/health', (req, res) => {
    try {
        const results = signatureHealthMonitor.checkAllPlatforms();
        const summary = {
            green: results.filter(r => r.status === 'green').length,
            yellow: results.filter(r => r.status === 'yellow').length,
            red: results.filter(r => r.status === 'red').length
        };
        res.json({ success: true, summary, platforms: results, checkedAt: new Date().toISOString() });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /api/signature/status/:platform - 返回单平台详情
app.get('/api/signature/status/:platform', (req, res) => {
    try {
        const result = signatureHealthMonitor.getPlatformStatus(req.params.platform);
        if (!result) {
            return res.status(404).json({ success: false, error: `Unknown platform: ${req.params.platform}` });
        }
        res.json({ success: true, data: result });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/signature/refresh/:platform - 手动触发签名刷新
app.post('/api/signature/refresh/:platform', async (req, res) => {
    try {
        const result = await signatureRefreshService.refresh(req.params.platform, req.body || {});
        const statusCode = result.success ? 200 : (result.code === 'rate_limited' ? 429 : 502);
        res.status(statusCode).json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /api/signature/refresh/status - 查看刷新状态
app.get('/api/signature/refresh/status', (req, res) => {
    try {
        res.json({ success: true, data: signatureRefreshService.getStatus() });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/signature/corpus/cleanup - 清理过期签名
app.post('/api/signature/corpus/cleanup', (req, res) => {
    try {
        const result = signatureHealthMonitor.cleanupExpiredEntries();
        res.json({ success: true, data: result });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/signature/corpus/mark-expired - 标记过期签名为不可用
app.post('/api/signature/corpus/mark-expired', (req, res) => {
    try {
        const result = signatureHealthMonitor.markExpiredEntries();
        res.json({ success: true, data: result });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 启动签名健康度定时检查
signatureHealthMonitor.startPeriodicCheck();

// ============ 启动服务器 ============

// LEGACY_CHARLES_WATCH removed — capture-recorder is the only capture engine

// mobileSync 访问鉴权已关闭：依赖部署网络边界控制访问权限。
const mobileSyncSettings = getMobileSyncSettings();

app.listen(PORT, () => {
    console.log(`\n🚀 Charging Station Collector Server`);
    console.log(`📡 Server running at http://localhost:${PORT}`);
    console.log(`📊 Database: ${config.database.path}`);
    console.log(`📼 Capture recorder dir: ${captureRecorderService.dataDir}`);
    console.log(`🧾 Capture recorder: active`);
    console.log(`⏰ Scheduled tasks: ${scheduler.tasks.size}`);
    console.log('\n✨ Ready to collect data!\n');
});

// 定位模拟服务
const LocationSimulator = require('./services/location-simulator');
const locationSimulator = new LocationSimulator({ projectRoot: path.join(__dirname, '..') });

app.post('/api/location/simulate', (req, res) => {
    try {
        const { city, lat, lng, windowId, windowBounds } = req.body || {};
        const result = locationSimulator.setSimulatedLocation({ city, lat, lng, windowId, windowBounds });
        res.json({ success: result.success, data: result });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

app.post('/api/location/authorize', (req, res) => {
    try {
        const { windowId, windowBounds } = req.body || {};
        const result = locationSimulator.clickAuthorizeButton(windowId, windowBounds);
        res.json({ success: result.success, data: result });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

app.get('/api/location/status', (req, res) => {
    res.json({ success: true, data: locationSimulator.getStatus() });
});
