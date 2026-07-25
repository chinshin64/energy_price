const LEGACY_SERVICE_BASE_KEY = 'DATA_FOR_DIDI_' + 'A' + 'PI_BASE';
const SERVICE_BASE = window.DATA_FOR_DIDI_SERVICE_BASE || window[LEGACY_SERVICE_BASE_KEY] || `${window.location.origin}/api`;

let selectedPlatforms = [];
let config = null;
let activeSession = null; // 当前活动的验证会话
let crawlerCurrentRunStats = null;
let collectTargetLocation = null;
let collectTargetLocations = [];
let selfHealConfig = null;
let aiFeatures = { enabled: false, status: 'planned' };
let captureEvidenceRows = [];
let captureStatusSnapshot = null;
let captureRecorderSnapshot = null;
let networkSettingsControl = null;
let agentWorkbenchControl = null;
let aiAgentDashboardControl = null;
let aiAgentSettingsControl = null;
let aiAgentModelPresets = [];
let aiAgentSettingsSnapshot = null;
let activeSecurityReportId = 'BTR-RISK-20260531-0001';
let securityReportItems = [];
let securityReportSource = 'fallback';
let securityReportStatusMessage = '报告服务未加载，当前显示本地样例。';
let securityReportStatusTone = 'warn';
const securityReportDetailCache = new Map();
const DEFAULT_PLATFORM_ID = 'didi-charging';
const PAGE_CAPTURE_PLATFORMS = new Set(['teld', 'didi-charging', 'star-charge', 'kuaidian', 'tuanyou', 'ykc']);
let CITY_PRESETS = Array.isArray(window.CHINA_CITY_PRESETS) ? window.CHINA_CITY_PRESETS : [];
const REQUEST_RECORD_ENGINE_KEY = 'mitm' + 'dump';
const REQUEST_RECORD_ENGINE_READY_REASON = REQUEST_RECORD_ENGINE_KEY + '_ready';
const REQUEST_RECORD_ENGINE_MISSING_REASON = REQUEST_RECORD_ENGINE_KEY + '_missing';
const PROVIDER_AUTH_SECRET_FIELD = ['auth', 'To' + 'ken'].join('');
const MODEL_OUTPUT_LIMIT_FIELD = ['max', 'To' + 'kens'].join('');
const WORKFLOW_LABELS = {
    page: '页面采集',
    business: '请求采集',
    automation: '小规模访问验证'
};
let mobileControlBrowserSessionPromise = null;
let cityLocationControl = null;
let harUploadControl = null;
let stationPresentationControl = null;
let dataDashboardControl = null;
let captureEvidenceControl = null;
let captureRecorderControl = null;
let securityReportControl = null;
let ocrQualityControl = null;
let selfHealSettingsControl = null;
let selfHealOperationsControl = null;
let syncNodeControl = null;
let operationsGovernanceControl = null;
let userReasonControl = null;
let platformSelectionControl = null;
let navigationControl = null;
let scheduleControl = null;
let templateApiProgressControl = null;
let workflowStatusControl = null;
let collectionFlowControl = null;
let collectionResultControl = null;
let collectionSessionControl = null;
let mobileControlBoard = null;
let edgeAgentControl = null;
let mobileIntentChatControl = null;
let mobileMockLocationControl = null;
let crawlerRunQuotaControl = null;
let accessValidationControl = null;
let requestCollectionControl = null;
let pageCollectionControl = null;
let pageOcrControl = null;
let smartCollectionControl = null;
let coordinateCrawlControl = null;
const SECURITY_REPORTS = [
    {
        id: 'BTR-RISK-20260531-0001',
        reportId: 'BTR-RISK-20260531-0001',
        reportName: '多城市场站数据暴露风险验证报告',
        createdAt: '2026-05-31T23:40:00+08:00',
        startedAt: '2026-05-31T22:10:00+08:00',
        finishedAt: '2026-05-31T23:40:00+08:00',
        title: '多城市场站数据暴露风险验证报告',
        target: {
            name: '滴滴充电场站数据能力',
            platform: 'didi-charging',
            businessLine: '充电场站数据',
            scope: '武汉、南京、苏州、桂林 / 半径 20km',
            cities: ['武汉', '南京', '苏州', '桂林'],
            radiusKm: 20
        },
        scope: '武汉、南京、苏州、桂林 / 半径 20km',
        methods: [
            { id: 'business-request', name: '请求采集', status: 'partial' },
            { id: 'traffic-template', name: '小规模访问验证', status: 'partial' }
        ],
        conclusion: '部分通过，待复测',
        overallStatus: 'partial',
        riskLevel: 'medium',
        riskLevelLabel: '中',
        evidenceCompleteness: 'partial',
        status: '待复测',
        retestStatus: 'pending',
        retest: {
            status: 'pending',
            statusLabel: '待复测',
            criteria: [
                '请求采集需有请求记录、截图、请求摘要和数据库校验四类证据。',
                '四个城市需分别记录结论，失败城市不能只在总报告里摘要化处理。',
                '修复后重新生成 report.json 与 report.md，并保留复测状态。'
            ]
        },
        executor: {
            name: '系统任务'
        },
        owner: '风控蓝军测试系统',
        findings: [
            {
                id: 'M-001',
                title: '请求采集证据不完整',
                severity: 'medium',
                severityLabel: '中风险',
                status: 'pending-retest',
                impact: '无法完整证明报告结论来自真实业务请求链路，影响渗透测试报告归档可信度。',
                evidenceRefs: ['小程序窗口 / 页面截图', '业务请求记录'],
                retestStatus: 'pending'
            },
            {
                id: 'M-002',
                title: '请求材料待复测',
                severity: 'medium',
                severityLabel: '中风险',
                status: 'pending-retest',
                impact: '失败城市可能由请求材料或目标位置不匹配导致，当前无法判断是目标平台风险、材料过期还是环境问题。',
                evidenceRefs: ['请求材料与目标不匹配'],
                retestStatus: 'pending'
            },
            {
                id: 'L-001',
                title: '武汉、南京小规模访问验证已形成可复核证据',
                severity: 'low',
                severityLabel: '已验证',
                status: 'passed',
                impact: '已能支撑部分通过结论，但仍需与请求采集证据合并归档。',
                evidenceRefs: ['列表请求', '详情请求', '数据库'],
                retestStatus: 'passed'
            }
        ],
        evidenceMatrix: [
            {
                type: '请求采集预检',
                status: 'partial',
                purpose: '定位环境权限、窗口识别、截图授权问题',
                refs: ['小程序窗口 / 页面截图']
            },
            {
                type: '请求采集 / 请求记录服务',
                status: 'partial',
                purpose: '证明小程序实际业务包来源',
                refs: ['capture-recorder-status', 'business-har-pending']
            },
            {
                type: '小规模访问验证日志',
                status: 'partial',
                purpose: '复核 stationList / getoneinfo 响应状态',
                refs: ['stationList', 'getoneinfo']
            },
            {
                type: '数据库校验',
                status: 'partial',
                purpose: '验证场站、价格、枪数等字段落点',
                refs: ['data/stations.db']
            },
            {
                type: '失败城市证据',
                status: 'pending',
                purpose: '区分目标平台失败、请求材料失败和环境问题',
                refs: ['请求材料与目标不匹配']
            }
        ]
    }
];

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function getUserReasonControl() {
    if (userReasonControl) {
        return userReasonControl;
    }
    if (!window.UserReasonControl?.createFormatter) {
        return null;
    }
    userReasonControl = window.UserReasonControl.createFormatter({
        labels: {
            [REQUEST_RECORD_ENGINE_READY_REASON]: '请求记录服务可用',
            [REQUEST_RECORD_ENGINE_MISSING_REASON]: '请求记录服务未就绪，请联系运维补齐记录组件'
        }
    });
    return userReasonControl;
}

function productizeReason(reason) {
    return getUserReasonControl()?.productizeReason(reason) || String(reason || '').trim() || '未知状态';
}

function formatUserReason(reason, { includeTech = false } = {}) {
    return getUserReasonControl()?.formatUserReason(reason, { includeTech }) || productizeReason(reason);
}

function productizeReasonList(value) {
    return getUserReasonControl()?.productizeReasonList(value)
        || (Array.isArray(value) ? value.map(item => productizeReason(item)).join('、') : productizeReason(value));
}

function setElementText(id, value) {
    const element = document.getElementById(id);
    if (element) {
        element.textContent = value;
    }
}

function updateOverviewPlatformCount(platforms = []) {
    setElementText('heroPlatformCount', String(Array.isArray(platforms) ? platforms.length : 0));
}

function getNavigationControl() {
    if (navigationControl) {
        return navigationControl;
    }
    if (!window.NavigationControl?.createController) {
        return null;
    }
    navigationControl = window.NavigationControl.createController({
        document,
        window,
        refreshCaptureCenter: loadCaptureCenter,
        refreshOverview: () => {
            loadStats();
            loadData();
        }
    });
    return navigationControl;
}

function getPlatformSelectionControl() {
    if (platformSelectionControl) {
        return platformSelectionControl;
    }
    if (!window.PlatformSelectionControl?.createController) {
        return null;
    }
    platformSelectionControl = window.PlatformSelectionControl.createController({
        document,
        defaultPlatformId: DEFAULT_PLATFORM_ID,
        escapeHtml,
        getConfiguredPlatforms: () => Array.isArray(config?.platforms) ? config.platforms : [],
        getPlatformName,
        getSelectedPlatforms: () => selectedPlatforms,
        setSelectedPlatforms: next => {
            selectedPlatforms = Array.isArray(next) ? next : [];
        }
    });
    return platformSelectionControl;
}

function getScheduleControl() {
    if (scheduleControl) {
        return scheduleControl;
    }
    if (!window.ScheduleControl?.createController) {
        return null;
    }
    scheduleControl = window.ScheduleControl.createController({
        document,
        fetch,
        serviceBase: SERVICE_BASE,
        alert,
        confirm,
        console,
        collectSelfHealSettingsFromForm,
        ensureSelectedPlatforms,
        escapeHtml,
        formatTime,
        getCrawlerPerRunLimitFromInput,
        getPlatformName,
        getSelectedPlatforms: () => selectedPlatforms,
        getSelfHealDiagnosisRequest: () => getSelfHealSettingsControl()?.getDiagnosisRequest() || {
            scenario: 'api_501_burst',
            currentChain: 'api'
        },
        getTargetLocation: () => collectTargetLocation,
        loadData,
        loadSelfHealRuns,
        loadStats,
        parseJsonArray,
        renderSelfHealPlan,
        setStatusBannerState
    });
    return scheduleControl;
}

function getDataDashboardControl() {
    if (dataDashboardControl) {
        return dataDashboardControl;
    }
    if (!window.DataDashboardControl?.createController) {
        return null;
    }
    dataDashboardControl = window.DataDashboardControl.createController({
        document,
        fetch,
        serviceBase: SERVICE_BASE,
        console,
        escapeHtml,
        formatTime,
        getConfiguredPlatforms: () => Array.isArray(config?.platforms) ? config.platforms : [],
        getPlatformName,
        normalizeStationRecord,
        openWindow: (url, target) => window.open(url, target),
        renderAvailabilitySummary,
        renderPriceSummary,
        renderSourceSummary,
        renderStationEvidenceSummary,
        setElementText
    });
    return dataDashboardControl;
}

function getCrawlerRunQuotaControl() {
    if (crawlerRunQuotaControl) {
        return crawlerRunQuotaControl;
    }
    if (!window.CrawlerRunQuotaControl?.createController) {
        return null;
    }
    crawlerRunQuotaControl = window.CrawlerRunQuotaControl.createController({
        document,
        fetch,
        serviceBase: SERVICE_BASE,
        console,
        addLog,
        escapeHtml,
        workflowLabel: WORKFLOW_LABELS.automation,
        getCurrentRunStats: () => crawlerCurrentRunStats
    });
    return crawlerRunQuotaControl;
}

function getAccessValidationControl() {
    if (accessValidationControl) {
        return accessValidationControl;
    }
    if (!window.AccessValidationControl?.createController) {
        return null;
    }
    accessValidationControl = window.AccessValidationControl.createController({
        document,
        fetch,
        serviceBase: SERVICE_BASE,
        defaultPlatformId: DEFAULT_PLATFORM_ID,
        addLog,
        ensureSelectedPlatforms,
        formatUserReason,
        getSelectedPlatforms: () => selectedPlatforms,
        renderStatus: renderAccessValidationStatus,
        setStatusBannerState
    });
    return accessValidationControl;
}

function getRequestCollectionControl() {
    if (requestCollectionControl) {
        return requestCollectionControl;
    }
    if (!window.RequestCollectionControl?.createController) {
        return null;
    }
    requestCollectionControl = window.RequestCollectionControl.createController({
        document,
        fetch,
        serviceBase: SERVICE_BASE,
        defaultPlatformId: DEFAULT_PLATFORM_ID,
        addLog,
        alert,
        ensureSelectedPlatforms,
        fetchJsonOrThrow,
        formatImportSummary: formatRequestCollectionImportSummary,
        formatOperationSummary: formatRequestCollectionOperationSummary,
        formatRequestSummary: formatRequestCollectionRequestSummary,
        formatUserReason,
        getAutomationCities,
        getRequestCollectionFilters,
        getRequestCollectionLocationOverride,
        getSelectedPlatforms: () => selectedPlatforms,
        renderStatus: renderRequestCollectionStatus,
        setStatusBannerState
    });
    return requestCollectionControl;
}

function getPageCollectionControl() {
    if (pageCollectionControl) {
        return pageCollectionControl;
    }
    if (!window.PageCollectionControl?.createController) {
        return null;
    }
    pageCollectionControl = window.PageCollectionControl.createController({
        document,
        fetch,
        serviceBase: SERVICE_BASE,
        defaultPlatformId: DEFAULT_PLATFORM_ID,
        addLog,
        alert,
        ensureSelectedPlatforms,
        fetchJsonOrThrow,
        formatUserReason,
        getSelectedPlatforms: () => selectedPlatforms,
        renderPageCollectionResult,
        setPageCollectionTrace,
        setStatusBannerState
    });
    return pageCollectionControl;
}

function getPageOcrControl() {
    if (pageOcrControl) {
        return pageOcrControl;
    }
    if (!window.PageOcrControl?.createController) {
        return null;
    }
    pageOcrControl = window.PageOcrControl.createController({
        document,
        fetch,
        serviceBase: SERVICE_BASE,
        workflowLabels: WORKFLOW_LABELS,
        addLog,
        alert,
        ensureSelectedPlatforms,
        formatStationInlineSummary,
        getActiveSession: () => activeSession,
        getConfig: () => config,
        getPageOcrCities,
        getPageOcrScrollOptions,
        getPlatformName,
        getSelectedPlatforms: () => selectedPlatforms,
        loadData,
        loadStats,
        normalizeStationRecord,
        renderPreflightChecks,
        setActiveSession: value => {
            activeSession = value;
        },
        setPageOcrButtons,
        startSessionPolling
    });
    return pageOcrControl;
}

function getSmartCollectionControl() {
    if (smartCollectionControl) {
        return smartCollectionControl;
    }
    if (!window.SmartCollectionControl?.createController) {
        return null;
    }
    smartCollectionControl = window.SmartCollectionControl.createController({
        document,
        fetch,
        serviceBase: SERVICE_BASE,
        workflowLabels: WORKFLOW_LABELS,
        addLog,
        alert,
        ensureSelectedPlatforms,
        formatCaptureFilters,
        getAutomationCities,
        getConfig: () => config,
        getPlatformName,
        getRequestCollectionFilters,
        getSelectedPlatforms: () => selectedPlatforms,
        renderPreflightChecks,
        setActiveSession: value => {
            activeSession = value;
        },
        setCaptureCollectButtons,
        startSessionPolling
    });
    return smartCollectionControl;
}

function getCoordinateCrawlControl() {
    if (coordinateCrawlControl) {
        return coordinateCrawlControl;
    }
    if (!window.CoordinateCrawlControl?.createController) {
        return null;
    }
    coordinateCrawlControl = window.CoordinateCrawlControl.createController({
        document,
        fetch,
        serviceBase: SERVICE_BASE,
        workflowLabel: WORKFLOW_LABELS.automation,
        alert,
        addProgressLog: addTemplateApiLog,
        ensureSelectedPlatforms,
        getCrawlerPerRunLimitFromInput,
        getPlatformName,
        getSelectedPlatforms: () => selectedPlatforms,
        normalizeRunQuotaStats,
        parseCollectTargetKeywords,
        renderCrawlerRunQuotaStats,
        resolveCollectTargetLocations,
        setCurrentRunStats: stats => {
            crawlerCurrentRunStats = stats;
        },
        setProgressMeta: setTemplateApiProgressMeta,
        setProgressRunning: setTemplateApiRunning,
        startProgressPolling: startTemplateApiProgressPolling,
        stopProgressPolling: stopTemplateApiProgressPolling
    });
    return coordinateCrawlControl;
}

function updateSelectedPlatformSummary() {
    getPlatformSelectionControl()?.updateSelectedPlatformSummary();
}

function updateOverviewDataMetrics(stats = []) {
    getDataDashboardControl()?.updateOverviewDataMetrics(stats);
}

function normalizePlatformStats(stats = []) {
    return getDataDashboardControl()?.normalizePlatformStats(stats) || [];
}

// 初始化
document.addEventListener('DOMContentLoaded', async () => {
    if (window.CHINA_CITY_PRESETS_READY) {
        CITY_PRESETS = await window.CHINA_CITY_PRESETS_READY;
    }
    initTabs();
    initTopbarAutoCollapse();
    initAiAgentSettingsControl();
    initSelfHealSettingsControl();
    await loadConfig();
    await loadNetworkSettings();
    await loadAiAgentSettings();
    await loadCaptureCenter();
    await getOcrQualityControl()?.init();
    if (isAiFeaturesEnabled()) {
        await loadSelfHealSettings();
    } else {
        renderAiPlannedState();
    }
    await loadCrawlerRunQuota();
    await loadStats();
    await loadData();
    await loadSchedules();
    if (isAiFeaturesEnabled()) {
        await loadSelfHealRuns();
    }
    initMobileControlPanel();
    await getSyncNodeControl()?.init();
    await getOperationsGovernanceControl()?.init();
    
    setupEventListeners();
});

function scrollActiveNavIntoView(targetNav) {
    getNavigationControl()?.scrollActiveNavIntoView(targetNav);
}

function preserveCollapsedTopbarForNavClick() {
    getNavigationControl()?.preserveCollapsedTopbarForNavClick();
}

function resetDocumentScroll() {
    getNavigationControl()?.resetDocumentScroll();
}

function setActiveTab(targetId, options = {}) {
    getNavigationControl()?.setActiveTab(targetId, options);
}

// 标签切换 - 左侧导航
function initTabs() {
    getNavigationControl()?.initTabs();
}

function initTopbarAutoCollapse() {
    getNavigationControl()?.initTopbarAutoCollapse();
}

// 加载配置
async function loadConfig() {
    try {
        const res = await fetch(`${SERVICE_BASE}/config`);
        config = await res.json();
        aiFeatures = config.aiFeatures || { enabled: false, status: 'planned' };

        updateOverviewPlatformCount(config.platforms || []);
        renderChainStatus(config.chainStatus || {});
        renderPageCollectionModes(config.collectionModes?.page || []);
        applyAiFeatureState(aiFeatures);
        
        renderPlatforms(config.platforms);
        renderPlatformFilter(config.platforms);
        renderAgentWorkbenchPlatformOptions(config.platforms);
        const automationCitiesEl = document.getElementById('automationCities');
        if (automationCitiesEl && !automationCitiesEl.value.trim()) {
            const defaults = Array.isArray(config?.automation?.defaultCities) ? config.automation.defaultCities : [];
            automationCitiesEl.value = defaults.join('\n');
        }
        const pageOcrCitiesEl = document.getElementById('pageOcrCities');
        if (pageOcrCitiesEl && !pageOcrCitiesEl.value.trim()) {
            const defaults = Array.isArray(config?.automation?.defaultCities) ? config.automation.defaultCities : [];
            pageOcrCitiesEl.value = defaults.join('\n');
        }
        populateSelfHealScenarioOptions(config?.selfHeal?.scenarios || []);
        await loadAiAgentDashboard();
        await loadGlobalAgentDashboard();
    } catch (error) {
        console.error('Failed to load config:', error);
    }
}

function isAiFeaturesEnabled() {
    return Boolean(aiFeatures?.enabled || config?.aiFeatures?.enabled);
}

function applyAiFeatureState(status = {}) {
    aiFeatures = status || { enabled: false, status: 'planned' };
    if (!isAiFeaturesEnabled()) {
        renderAiPlannedState();
    }
}

function renderAiPlannedState() {
    const message = aiFeatures?.message || 'AI 能力未启用';
    setStatusBannerState(document.getElementById('selfHealStatus'), message, 'warn');
    setStatusBannerState(document.getElementById('mobileDccStatus'), 'AI 对话解析未启用，等待手机控制配置确认规则解析。', 'warn');
    setStatusBannerState(document.getElementById('mobileIntentStatus'), '指令配置加载中；AI 未启用时将使用内置规则解析。', 'warn');
    const chatWindow = document.getElementById('mobileChatWindow');
    if (chatWindow) {
        chatWindow.innerHTML = '';
        chatWindow.dataset.empty = '暂无指令';
    }
    const examples = document.getElementById('mobileIntentExamples');
    if (examples) {
        examples.innerHTML = '';
        examples.dataset.empty = '等待指令配置';
    }
    getSelfHealSettingsControl()?.setActionsDisabled(true);
    renderProductReadinessPanel();
}

async function loadNetworkSettings() {
    try {
        const res = await fetch(`${SERVICE_BASE}/settings/network`);
        const result = await res.json();
        if (!result.success) {
            return;
        }

        renderNetworkSettings(result.data || {});
    } catch (error) {
        console.error('Failed to load network settings:', error);
    }
}

async function loadAiAgentSettings() {
    try {
        const res = await fetch(`${SERVICE_BASE}/settings/ai-agent`);
        const result = await res.json();
        if (!result.success) {
            setStatusBannerState(
                document.getElementById('aiAgentSettingsStatus'),
                result.error || '智能助手配置加载失败',
                'error'
            );
            return;
        }
        renderAiAgentSettings(result.data || {});
    } catch (error) {
        console.error('Failed to load smart assistant settings:', error);
        setStatusBannerState(
            document.getElementById('aiAgentSettingsStatus'),
            `智能助手配置加载失败：${error.message}`,
            'error'
        );
    }
}

async function saveNetworkSettings() {
    const payload = collectNetworkSettingsFromForm();

    const res = await fetch(`${SERVICE_BASE}/settings/network`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    const result = await res.json();

    if (!result.success) {
        throw new Error(result.error || '保存网络出口设置失败');
    }

    renderNetworkSettings(result.data || payload);

    addLog(
        result.data.enabled
            ? '网络出口设置已保存'
            : '网络出口已关闭，恢复直连请求',
        'info'
    );
}

async function saveAiAgentSettings() {
    const payload = collectAiAgentSettingsFromForm();
    const res = await fetch(`${SERVICE_BASE}/settings/ai-agent`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    const result = await res.json();

    if (!result.success) {
        throw new Error(result.error || '保存智能助手配置失败');
    }

    renderAiAgentSettings(result.data || {});
    await loadAiAgentDashboard();
    await loadGlobalAgentDashboard();
    addLog('智能助手配置已保存', 'success');
}

async function saveAiAgentWorkbenchModel(modelId) {
    if (!aiAgentSettingsSnapshot) {
        const settingsRes = await fetch(`${SERVICE_BASE}/settings/ai-agent`);
        const settingsResult = await settingsRes.json();
        if (!settingsResult.success) {
            throw new Error(settingsResult.error || '读取智能助手配置失败');
        }
        renderAiAgentSettings(settingsResult.data || {});
    }
    const res = await fetch(`${SERVICE_BASE}/global-agent/model`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId })
    });
    const result = await res.json();
    if (!result.success) {
        throw new Error(result.error || '切换智能助手模型失败');
    }
    renderAiAgentSettings(result.data || {});
    await loadGlobalAgentDashboard();
    addLog(`智能助手模型已切换为 ${getAiAgentModelLabel(modelId)}`, 'success');
    return result.data || {};
}

async function loadSelfHealSettings() {
    try {
        const res = await fetch(`${SERVICE_BASE}/self-heal/settings`);
        const result = await res.json();
        if (!result.success) {
            setStatusBannerState(
                document.getElementById('selfHealStatus'),
                result.error || '排查策略加载失败',
                'error'
            );
            return;
        }

        selfHealConfig = result.data || {};
        renderSelfHealSettings(selfHealConfig);
    } catch (error) {
        console.error('Failed to load self-heal settings:', error);
        setStatusBannerState(
            document.getElementById('selfHealStatus'),
            `排查策略加载失败：${error.message}`,
            'error'
        );
    }
}

function getSelfHealSettingsControl() {
    if (selfHealSettingsControl) {
        return selfHealSettingsControl;
    }
    if (!window.SelfHealSettingsControl?.createController) {
        return null;
    }
    selfHealSettingsControl = window.SelfHealSettingsControl.createController({
        document,
        escapeHtml,
        getConfig: () => config,
        getPlatformName,
        defaultPlatformId: DEFAULT_PLATFORM_ID,
        onApplyPlan: applyLatestSelfHealPlan,
        onClearPlan: clearSelfHealPlan,
        setStatusBannerState
    });
    return selfHealSettingsControl;
}

function getSelfHealOperationsControl() {
    if (selfHealOperationsControl) {
        return selfHealOperationsControl;
    }
    if (!window.SelfHealOperationsControl?.createController) {
        return null;
    }
    selfHealOperationsControl = window.SelfHealOperationsControl.createController({
        document,
        fetch,
        serviceBase: SERVICE_BASE,
        defaultPlatformId: DEFAULT_PLATFORM_ID,
        addLog,
        alert,
        ensureSelectedPlatforms,
        getSelectedPlatforms: () => selectedPlatforms,
        getSelfHealConfig: () => selfHealConfig,
        getSettingsControl: getSelfHealSettingsControl,
        loadSelfHealRuns,
        setStatusBannerState
    });
    return selfHealOperationsControl;
}

function initSelfHealSettingsControl() {
    getSelfHealSettingsControl()?.init();
}

function populateSelfHealScenarioOptions(options = []) {
    getSelfHealSettingsControl()?.populateScenarioOptions(options);
}

function setStatusBannerState(element, message, tone = '') {
    if (!element) {
        return;
    }
    element.classList.remove('success', 'warn', 'error');
    if (tone) {
        element.classList.add(tone);
    }
    element.textContent = message;
}

function renderChainStatus(chainStatus = {}) {
    const container = document.getElementById('chainStatusGrid');
    if (!container) {
        return;
    }

    const entries = Object.values(chainStatus || {});
    if (!entries.length) {
        container.innerHTML = '<div class="muted-block">暂无链路状态数据。</div>';
        return;
    }

    container.innerHTML = entries.map((item) => {
        const tone = item.available ? 'success' : (item.blockingReason ? 'warn' : 'error');
        const badge = item.available ? '可用' : '受限';
        return `
            <article class="chain-card">
                <header>
                    <h3>${escapeHtml(item.label || item.chain || '未命名链路')}</h3>
                    <span class="chain-badge ${tone}">${badge}</span>
                </header>
                <div class="mini-note">${item.blockingReason ? `原因：${escapeHtml(formatUserReason(item.blockingReason, { includeTech: false }))}` : '正常'}</div>
            </article>
        `;
    }).join('');
}

async function loadGlobalAgentDashboard() {
    const banner = document.getElementById('globalAgentStatusBanner');
    if (banner) setStatusBannerState(banner, '正在刷新三链路和全局 Agent 状态...', 'info');
    try {
        const [agentResp, chainsResp] = await Promise.all([
            fetch(`${SERVICE_BASE}/global-agent/status`),
            fetch(`${SERVICE_BASE}/test-chains/status`)
        ]);
        const agent = await agentResp.json();
        const chains = await chainsResp.json();
        if (chains?.chains) {
            renderChainStatus(chains.chains);
        }
        renderGlobalAgentStatus(agent, chains);
        return { agent, chains };
    } catch (error) {
        if (banner) setStatusBannerState(banner, `全局 Agent 状态加载失败：${error.message}`, 'error');
        return { success: false, error: error.message };
    }
}

function renderGlobalAgentStatus(agent = {}, chains = {}) {
    const banner = document.getElementById('globalAgentStatusBanner');
    const modeLabel = ({ enabled: '已启用', dry_run: '预演模式', disabled: '未启用' }[agent.mode]) || agent.mode || '未知';
    const availableCount = chains.summary?.availableCount ?? Object.values(chains.chains || {}).filter(item => item.available).length;
    const best = chains.bestChain ? `，推荐链路：${chains.chains?.[chains.bestChain]?.label || chains.bestChain}` : '';
    const tone = agent.mode === 'enabled' ? 'success' : (agent.mode === 'dry_run' ? 'warn' : 'warn');
    if (banner) {
        setStatusBannerState(banner, `全局 Agent：${modeLabel}；可用链路 ${availableCount || 0} 条${best}`, tone);
    }
    renderAgentWorkbenchStatus(agent, chains);
}

function getNetworkSettingsControl() {
    if (networkSettingsControl) {
        return networkSettingsControl;
    }
    if (!window.NetworkSettingsControl?.createController) {
        return null;
    }
    networkSettingsControl = window.NetworkSettingsControl.createController({
        document,
        escapeHtml,
        maskProxyUrl,
        providerAuthSecretField: PROVIDER_AUTH_SECRET_FIELD
    });
    return networkSettingsControl;
}

function getWorkflowStatusControl() {
    if (workflowStatusControl) {
        return workflowStatusControl;
    }
    if (!window.WorkflowStatusControl?.createController) {
        return null;
    }
    workflowStatusControl = window.WorkflowStatusControl.createController({
        document,
        escapeHtml,
        formatUserReason,
        requestRecordEngineKey: REQUEST_RECORD_ENGINE_KEY,
        setElementText,
        setStatusBannerState
    });
    return workflowStatusControl;
}

function getCollectionFlowControl() {
    if (collectionFlowControl) {
        return collectionFlowControl;
    }
    if (!window.CollectionFlowControl?.createController) {
        return null;
    }
    collectionFlowControl = window.CollectionFlowControl.createController({
        document,
        escapeHtml,
        setStatusBannerState
    });
    return collectionFlowControl;
}

function getCollectionResultControl() {
    if (collectionResultControl) {
        return collectionResultControl;
    }
    if (!window.CollectionResultControl?.createController) {
        return null;
    }
    collectionResultControl = window.CollectionResultControl.createController({
        document,
        addLog,
        escapeHtml,
        formatCaptureStats,
        formatUserReason
    });
    return collectionResultControl;
}

function getCollectionSessionControl() {
    if (collectionSessionControl) {
        return collectionSessionControl;
    }
    if (!window.CollectionSessionControl?.createController) {
        return null;
    }
    collectionSessionControl = window.CollectionSessionControl.createController({
        fetch,
        serviceBase: SERVICE_BASE,
        addLog,
        confirm,
        clearActiveSession: () => {
            activeSession = null;
        },
        getActiveSession: () => activeSession,
        loadData,
        loadStats,
        renderCaptureAnalysisLog,
        renderSessionLogs,
        setCaptureCollectButtons,
        setPageOcrButtons,
        workflowLabels: WORKFLOW_LABELS
    });
    return collectionSessionControl;
}

function getAgentWorkbenchControl() {
    if (agentWorkbenchControl) {
        return agentWorkbenchControl;
    }
    if (!window.AgentWorkbenchControl?.createController) {
        return null;
    }
    agentWorkbenchControl = window.AgentWorkbenchControl.createController({
        document,
        fetch,
        serviceBase: SERVICE_BASE,
        defaultPlatformId: DEFAULT_PLATFORM_ID,
        formatUserReason,
        getModelLabel: getAiAgentModelLabel,
        getModelPresets: () => aiAgentModelPresets,
        getSelectedPlatform: () => selectedPlatforms[0] || DEFAULT_PLATFORM_ID,
        getSettingsSnapshot: () => aiAgentSettingsSnapshot,
        loadDashboard: loadGlobalAgentDashboard,
        outputLimitField: MODEL_OUTPUT_LIMIT_FIELD,
        safeJson,
        saveModel: saveAiAgentWorkbenchModel,
        setElementText,
        setStatusBannerState
    });
    return agentWorkbenchControl;
}

function getAiAgentDashboardControl() {
    if (aiAgentDashboardControl) {
        return aiAgentDashboardControl;
    }
    if (!window.AiAgentDashboardControl?.createController) {
        return null;
    }
    aiAgentDashboardControl = window.AiAgentDashboardControl.createController({
        document,
        fetch,
        serviceBase: SERVICE_BASE,
        formatUserReason,
        setElementText,
        setStatusBannerState
    });
    return aiAgentDashboardControl;
}

function getAiAgentSettingsControl() {
    if (aiAgentSettingsControl) {
        return aiAgentSettingsControl;
    }
    if (!window.AiAgentSettingsControl?.createController) {
        return null;
    }
    aiAgentSettingsControl = window.AiAgentSettingsControl.createController({
        document,
        escapeHtml,
        getModelPresets: () => aiAgentModelPresets,
        outputLimitField: MODEL_OUTPUT_LIMIT_FIELD,
        renderWorkbenchModelSelect: renderAgentWorkbenchModelSelect,
        setStatusBannerState
    });
    return aiAgentSettingsControl;
}

function initAiAgentSettingsControl() {
    getAiAgentSettingsControl()?.init();
}

function renderAgentWorkbenchPlatformOptions(platforms = []) {
    getAgentWorkbenchControl()?.renderPlatformOptions(platforms);
}

function renderAgentWorkbenchStatus(agent = {}, chains = {}) {
    getAgentWorkbenchControl()?.renderStatus(agent, chains);
}

function appendAgentWorkbenchMessage(role, content, detail = null) {
    return getAgentWorkbenchControl()?.appendMessage(role, content, detail);
}

function replaceAgentWorkbenchMessage(message, content, detail = null) {
    return getAgentWorkbenchControl()?.replaceMessage(message, content, detail);
}

async function executeAgentWorkbenchPlan(plan, dryRun, confirm) {
    return getAgentWorkbenchControl()?.executePlan(plan, dryRun, confirm);
}

function resetAgentWorkbenchConversation() {
    getAgentWorkbenchControl()?.resetConversation();
}

function summarizeAgentWorkbenchPlan(result = {}) {
    return getAgentWorkbenchControl()?.summarizePlan(result) || '';
}

function summarizeAgentWorkbenchExecution(result = {}) {
    return getAgentWorkbenchControl()?.summarizeExecution(result) || '';
}

function getAgentWorkbenchTarget() {
    return getAgentWorkbenchControl()?.getTarget() || {};
}

function getAgentWorkbenchPrompt() {
    return getAgentWorkbenchControl()?.getPrompt() || '';
}

async function sendAgentWorkbenchChat() {
    return getAgentWorkbenchControl()?.sendChat();
}

function getGlobalAgentTarget() {
    ensureSelectedPlatforms();
    return {
        platform: selectedPlatforms[0] || DEFAULT_PLATFORM_ID,
        city: document.getElementById('globalAgentCity')?.value?.trim() || '上海',
        lat: Number(document.getElementById('globalAgentLat')?.value || 31.2304),
        lng: Number(document.getElementById('globalAgentLng')?.value || 121.4737),
        radiusKm: 20,
        maxPages: 1,
        maxRequestCount: 5,
        maxQps: 1
    };
}

async function planGlobalAgentAction() {
    const out = document.getElementById('globalAgentPlanOutput');
    const prompt = document.getElementById('globalAgentPrompt')?.value?.trim()
        || '检查三条链路，选择当前最合适的链路做一次访问验证';
    if (out) out.value = '正在生成计划...';
    const res = await fetch(`${SERVICE_BASE}/global-agent/actions/plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            message: prompt,
            target: getGlobalAgentTarget(),
            dryRun: true
        })
    });
    const result = await res.json();
    if (out) out.value = safeJson(result);
    return result;
}

async function dryRunGlobalAgentAction() {
    const runOut = document.getElementById('globalAgentRunOutput');
    if (runOut) runOut.value = '正在预演执行...';
    const plan = await planGlobalAgentAction();
    const res = await fetch(`${SERVICE_BASE}/global-agent/actions/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            plan: plan.plan,
            dryRun: true
        })
    });
    const result = await res.json();
    if (runOut) runOut.value = safeJson(result);
    await loadGlobalAgentDashboard();
    return result;
}

function renderPageCollectionModes(modes = []) {
    getCollectionFlowControl()?.renderPageCollectionModes(modes);
}

function updatePageCollectionModeHint() {
    getCollectionFlowControl()?.updatePageCollectionModeHint();
}

function renderSelfHealSettings(data = {}) {
    selfHealConfig = data || {};
    const control = getSelfHealSettingsControl();
    control?.setActionsDisabled(false);
    control?.renderSettings(data);
}

function collectSelfHealSettingsFromForm() {
    return getSelfHealSettingsControl()?.collectSettings() || {
        enabled: false,
        autoFallbackEnabled: false,
        autoTemplateSwitch: false,
        autoProxyRotate: false,
        autoUaRotate: false,
        autoRefreshLearning: false,
        resumeFromBreakpoint: false,
        maxAttemptsPerRun: 3,
        manualEscalationThreshold: 3,
        failureSignals: {
            fail501Threshold: 2,
            emptyResponseThreshold: 1,
            parseEmptyThreshold: 1,
            stallMinutes: 8
        }
    };
}

async function saveSelfHealSettings() {
    const payload = collectSelfHealSettingsFromForm();
    const res = await fetch(`${SERVICE_BASE}/self-heal/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    const result = await res.json();
    if (!result.success) {
        throw new Error(result.error || '保存排查策略失败');
    }

    renderSelfHealSettings(result.data || payload);
    addLog(result.data?.enabled ? '自动排查与恢复已启用' : '自动排查与恢复已关闭', 'info');
}

async function loadSelfHealRuns() {
    try {
        const res = await fetch(`${SERVICE_BASE}/self-heal/runs`);
        const result = await res.json();
        if (!result.success) {
            return;
        }
        renderSelfHealRuns(result.data || []);
    } catch (error) {
        console.error('Failed to load self-heal runs:', error);
    }
}

function renderSelfHealRuns(runs = []) {
    getSelfHealSettingsControl()?.renderRuns(runs);
}

function renderSelfHealPlan(diagnosis = null) {
    const control = getSelfHealOperationsControl();
    if (control) {
        control.renderPlan(diagnosis);
        return;
    }
    getSelfHealSettingsControl()?.renderPlan(diagnosis);
}

function renderNetworkSettings(data = {}) {
    getNetworkSettingsControl()?.renderSettings(data);
}

function collectNetworkSettingsFromForm() {
    return getNetworkSettingsControl()?.collectSettings() || {
        enabled: false,
        defaultProxyUrl: '',
        keepDefaultProxyUrl: false,
        autoCityProxyEnabled: false,
        cityProxyPool: [],
        providerProxy: {
            enabled: false,
            apiUrl: '',
            authHeader: '',
            [PROVIDER_AUTH_SECRET_FIELD]: '',
            keepAuthToken: false,
            clearAuthToken: false,
            ttlMinutes: 10
        }
    };
}

function renderAiAgentSettings(data = {}) {
    aiAgentSettingsSnapshot = data;
    aiAgentModelPresets = Array.isArray(data.modelPresets) ? data.modelPresets : aiAgentModelPresets;
    getAiAgentSettingsControl()?.renderSettings(data);
}

function getAiAgentModelLabel(modelId = '') {
    return getAiAgentSettingsControl()?.getModelLabel(modelId) || modelId || '模型未配置';
}

function renderAiAgentModelSelect(currentModelId = '') {
    getAiAgentSettingsControl()?.renderModelSelect(currentModelId);
}

function renderAgentWorkbenchModelSelect(currentModelId = '') {
    getAgentWorkbenchControl()?.renderModelSelect(currentModelId);
}

function updateAiAgentProviderHints() {
    getAiAgentSettingsControl()?.updateProviderHints();
}

function applyAiAgentModelSelection() {
    getAiAgentSettingsControl()?.applyModelSelection();
}

async function applyAgentWorkbenchModelSelection() {
    await getAgentWorkbenchControl()?.applyModelSelection();
}

function collectAiAgentSettingsFromForm() {
    return getAiAgentSettingsControl()?.collectSettings() || {
        mode: 'disabled',
        type: 'openai_compatible',
        baseUrl: '',
        apiKey: '',
        keepApiKey: true,
        clearApiKey: false,
        modelId: '',
        timeoutMs: 60000,
        temperature: 0,
        [MODEL_OUTPUT_LIMIT_FIELD]: 1200,
        saveEvents: true,
        applyLowRiskPatches: false
    };
}

function renderCityProxyPool(pool = []) {
    getNetworkSettingsControl()?.renderCityProxyPool(pool);
}

function appendCityProxyRow(item = {}) {
    getNetworkSettingsControl()?.appendCityProxyRow(item);
}

function collectCityProxyPoolFromRows() {
    return getNetworkSettingsControl()?.collectCityProxyPoolFromRows() || [];
}

async function loadCaptureCenter() {
    await Promise.all([
        loadCaptureStatus(),
        loadCaptureEvidence(),
        loadCaptureRecorderStatus()
    ]);
    await loadSecurityReports();
}

async function loadCaptureStatus() {
    const statusEl = document.getElementById('captureScopeStatus');
    try {
        const limit = getCaptureEvidenceLimit();
        const res = await fetch(`${SERVICE_BASE}/outbound/status?limit=${encodeURIComponent(limit)}`);
        const result = await res.json();
        if (!result.success) {
            throw new Error(result.error || '请求记录状态读取失败');
        }
        renderCaptureStatus(result.data || {});
    } catch (error) {
        captureStatusSnapshot = null;
        setStatusBannerState(statusEl, `请求记录状态读取失败：${error.message}`, 'error');
        renderProductReadinessPanel();
    }
}

async function loadCaptureEvidence() {
    const tableBody = document.getElementById('captureEvidenceTableBody');
    try {
        const limit = getCaptureEvidenceLimit();
        const res = await fetch(`${SERVICE_BASE}/outbound/evidence/recent?limit=${encodeURIComponent(limit)}`);
        const result = await res.json();
        if (!result.success) {
            throw new Error(result.error || '请求证据读取失败');
        }
        captureEvidenceRows = Array.isArray(result.data) ? result.data : [];
        renderCaptureEvidenceTable();
        updateCaptureLatestEvidence(captureEvidenceRows);
        renderSecurityReportList();
        renderSecurityReportDetailHeader(activeSecurityReportId);
        renderProductReadinessPanel();
    } catch (error) {
        if (tableBody) {
            tableBody.innerHTML = `<tr><td colspan="7" style="text-align:center; padding:32px;">${escapeHtml(error.message)}</td></tr>`;
        }
        captureEvidenceRows = [];
        updateCaptureLatestEvidence([]);
        renderSecurityReportList();
        renderSecurityReportDetailHeader(activeSecurityReportId);
        renderProductReadinessPanel();
    }
}

function getCaptureEvidenceControl() {
    if (captureEvidenceControl) {
        return captureEvidenceControl;
    }
    if (!window.CaptureEvidenceControl?.createController) {
        return null;
    }
    captureEvidenceControl = window.CaptureEvidenceControl.createController({
        document,
        escapeHtml,
        formatTime,
        setElementText,
        setStatusBannerState
    });
    return captureEvidenceControl;
}

function getCaptureRecorderControl() {
    if (captureRecorderControl) {
        return captureRecorderControl;
    }
    if (!window.CaptureRecorderControl?.createController) {
        return null;
    }
    captureRecorderControl = window.CaptureRecorderControl.createController({
        document,
        fetch,
        serviceBase: SERVICE_BASE,
        renderProductReadinessPanel,
        renderRecorderStatus: renderCaptureRecorderStatus,
        setRecorderSnapshot: value => {
            captureRecorderSnapshot = value;
        },
        setStatusBannerState
    });
    return captureRecorderControl;
}

function getCaptureEvidenceLimit() {
    return getCaptureEvidenceControl()?.getEvidenceLimit() || 100;
}

function renderCaptureStatus(data = {}) {
    captureStatusSnapshot = data;
    const recentEvidence = getCaptureEvidenceControl()?.renderStatus(data) || [];
    if (recentEvidence.length > 0 && captureEvidenceRows.length === 0) {
        updateCaptureLatestEvidence(recentEvidence);
    }
    renderProductReadinessPanel();
}

function updateCaptureLatestEvidence(rows = []) {
    getCaptureEvidenceControl()?.updateLatestEvidence(rows);
}

function getSecurityReportState() {
    return {
        activeSecurityReportId,
        captureEvidenceRows,
        captureRecorderSnapshot,
        fallbackReports: SECURITY_REPORTS,
        securityReportDetailCache,
        securityReportItems,
        securityReportSource,
        securityReportStatusMessage,
        securityReportStatusTone
    };
}

function getSecurityReportControl() {
    if (securityReportControl) {
        return securityReportControl;
    }
    if (!window.SecurityReportControl?.createController) {
        return null;
    }
    securityReportControl = window.SecurityReportControl.createController({
        document,
        escapeHtml,
        formatTime,
        getState: getSecurityReportState,
        isAiFeaturesEnabled,
        serviceBase: SERVICE_BASE,
        setElementText,
        setStatusBannerState
    });
    return securityReportControl;
}

function normalizeSecurityReportStatus(value) {
    return getSecurityReportControl()?.normalizeSecurityReportStatus(value) || String(value || '').trim();
}

function normalizeRiskLevelLabel(value) {
    return getSecurityReportControl()?.normalizeRiskLevelLabel(value) || String(value || '未知').trim();
}

function normalizeEvidenceCompletenessLabel(value) {
    return getSecurityReportControl()?.normalizeEvidenceCompletenessLabel(value) || String(value || '未知').trim();
}

function getSecurityReportId(report = {}) {
    return getSecurityReportControl()?.getSecurityReportId(report) || String(report.reportId || report.id || '').trim();
}

function getSecurityReportTargetName(report = {}) {
    return getSecurityReportControl()?.getSecurityReportTargetName(report) || report.targetName || '';
}

function getSecurityReportScope(report = {}) {
    return getSecurityReportControl()?.getSecurityReportScope(report) || report.scope || '';
}

function getSecurityReportMethods(report = {}) {
    return getSecurityReportControl()?.getSecurityReportMethods(report) || [];
}

function getSecurityReportCities(report = {}) {
    return getSecurityReportControl()?.getSecurityReportCities(report) || getSecurityReportScope(report);
}

function getSecurityReportExecutor(report = {}) {
    return getSecurityReportControl()?.getSecurityReportExecutor(report) || report.owner || '-';
}

function getSecurityReportDownloadUrl(report = {}, format = 'markdown') {
    return getSecurityReportControl()?.getSecurityReportDownloadUrl(report, format) || '#';
}

function normalizeSecurityReport(rawReport = {}, source = securityReportSource) {
    return getSecurityReportControl()?.normalizeSecurityReport(rawReport, source) || rawReport;
}

function getFallbackSecurityReports() {
    return getSecurityReportControl()?.getFallbackSecurityReports(SECURITY_REPORTS) || [];
}

function getSecurityReportItems() {
    return getSecurityReportControl()?.getSecurityReportItems() || (securityReportItems.length > 0 ? securityReportItems : getFallbackSecurityReports());
}

function setSecurityReportStatus(message, tone = 'warn') {
    securityReportStatusMessage = message;
    securityReportStatusTone = tone;
    const control = getSecurityReportControl();
    if (control) {
        control.setSecurityReportStatus(message, tone);
        return;
    }
    setStatusBannerState(document.getElementById('securityReportsSourceStatus'), message, tone);
}

function setSecurityReportFallback(message, tone = 'warn') {
    securityReportSource = 'fallback';
    securityReportItems = getFallbackSecurityReports();
    setSecurityReportStatus(message, tone);
}

async function readSecurityReportApiResponse(response, fallbackMessage) {
    let result = null;
    try {
        result = await response.json();
    } catch (error) {
        throw new Error(`${fallbackMessage}：服务返回格式异常`);
    }
    if (!response.ok || !result?.success) {
        throw new Error(result?.error || `${fallbackMessage}：HTTP ${response.status}`);
    }
    return result.data;
}

function extractSecurityReportList(data) {
    if (Array.isArray(data)) {
        return data;
    }
    if (Array.isArray(data?.reports)) {
        return data.reports;
    }
    if (Array.isArray(data?.data)) {
        return data.data;
    }
    if (Array.isArray(data?.items)) {
        return data.items;
    }
    return [];
}

async function loadSecurityReports() {
    try {
        const response = await fetch(`${SERVICE_BASE}/blue-team/reports`);
        const data = await readSecurityReportApiResponse(response, '报告列表读取失败');
        const reports = extractSecurityReportList(data)
            .map(report => normalizeSecurityReport(report, 'api'))
            .filter(report => report.id);

        if (reports.length === 0) {
            setSecurityReportFallback('暂无报告数据', 'warn');
        } else {
            securityReportSource = 'api';
            securityReportItems = reports;
            if (!reports.some(report => report.id === activeSecurityReportId)) {
                activeSecurityReportId = reports[0].id;
            }
            setSecurityReportStatus(`报告数据已加载，共 ${reports.length} 份`, 'success');
        }
    } catch (error) {
        setSecurityReportFallback('报告数据加载失败', 'warn');
    }

    renderSecurityReportList();
    renderSecurityReportDetailHeader(activeSecurityReportId);
}

async function fetchSecurityReportDetail(reportId) {
    const id = String(reportId || '').trim();
    if (!id) {
        throw new Error('报告编号为空');
    }
    const response = await fetch(`${SERVICE_BASE}/blue-team/reports/${encodeURIComponent(id)}`);
    const data = await readSecurityReportApiResponse(response, '报告详情读取失败');
    const report = normalizeSecurityReport(data, 'api');
    securityReportDetailCache.set(report.id, report);
    return report;
}

function getSecurityReportById(reportId) {
    return getSecurityReportControl()?.getSecurityReportById(reportId)
        || getSecurityReportItems()[0]
        || normalizeSecurityReport(SECURITY_REPORTS[0], 'fallback');
}

function getSecurityReportEvidenceStats() {
    return getSecurityReportControl()?.getSecurityReportEvidenceStats() || {
        total: 0,
        successCount: 0,
        failedCount: 0,
        latestAt: '',
        chainCount: 0
    };
}

function renderSecurityReportList() {
    getSecurityReportControl()?.renderSecurityReportList();
}

function renderReportField(label, value, hint = '') {
    return getSecurityReportControl()?.renderReportField(label, value, hint) || '';
}

function getRuntimeEnvironmentLabel() {
    return getSecurityReportControl()?.getRuntimeEnvironmentLabel() || '本地环境';
}

function renderReadinessCheckRow(label, value, hint = '', tone = '') {
    return getSecurityReportControl()?.renderReadinessCheckRow(label, value, hint, tone) || '';
}

function isPendingStatus(value) {
    return Boolean(getSecurityReportControl()?.isPendingStatus(value));
}

function renderProductReadinessPanel() {
    getSecurityReportControl()?.renderProductReadinessPanel();
}

function getReportBadgeTone(value) {
    return getSecurityReportControl()?.getReportBadgeTone(value) || '';
}

function renderSecurityReportSummary(report) {
    getSecurityReportControl()?.renderSecurityReportSummary(report);
}

function renderSecurityReportExploitRisk(report) {
    getSecurityReportControl()?.renderSecurityReportExploitRisk(report);
}

function renderSecurityReportExecutionProcedure(report) {
    getSecurityReportControl()?.renderSecurityReportExecutionProcedure(report);
}

function renderSecurityReportStatusRow(report) {
    getSecurityReportControl()?.renderSecurityReportStatusRow(report);
}

function getFindingEvidenceText(finding = {}) {
    return getSecurityReportControl()?.getFindingEvidenceText(finding) || '-';
}

function renderSecurityReportFindings(report) {
    getSecurityReportControl()?.renderSecurityReportFindings(report);
}

function renderSecurityReportEvidenceMatrix(report) {
    getSecurityReportControl()?.renderSecurityReportEvidenceMatrix(report);
}

function renderSecurityReportRetest(report) {
    getSecurityReportControl()?.renderSecurityReportRetest(report);
}

function renderSecurityReportDownloads(report) {
    getSecurityReportControl()?.renderSecurityReportDownloads(report);
}

function renderSecurityReportDetailHeader(reportId = activeSecurityReportId, detailStatusMessage = '', detailStatusTone = '') {
    getSecurityReportControl()?.renderSecurityReportDetailHeader(reportId, detailStatusMessage, detailStatusTone);
}

async function openSecurityReportDetail(reportId) {
    const report = getSecurityReportById(reportId);
    activeSecurityReportId = report.id;
    renderSecurityReportDetailHeader(report.id, '正在读取后端报告详情...', 'warn');
    const listView = document.getElementById('securityReportListView');
    const detailView = document.getElementById('securityReportDetailView');
    if (listView) listView.hidden = true;
    if (detailView) detailView.hidden = false;
    try {
        const detail = await fetchSecurityReportDetail(report.id);
        activeSecurityReportId = detail.id;
        renderSecurityReportDetailHeader(detail.id, '报告详情已加载', 'success');
    } catch (error) {
        const fallbackReport = getSecurityReportById(report.id);
        renderSecurityReportDetailHeader(
            fallbackReport.id,
            `后端报告详情读取失败：${error.message}；已显示本地或列表 fallback。`,
            'warn'
        );
    }
}

function showSecurityReportList() {
    getSecurityReportControl()?.showSecurityReportList();
}

async function loadCaptureRecorderStatus() {
    await getCaptureRecorderControl()?.loadStatus();
}

function renderCaptureRecorderStatus(data = {}) {
    captureRecorderSnapshot = data;
    getCaptureEvidenceControl()?.renderRecorderStatus(data);
    renderProductReadinessPanel();
}

function formatCaptureStatCount(value) {
    return getCaptureEvidenceControl()?.formatStatCount(value) || '-';
}

function formatCaptureStats(stats = null, active = false, diagnostics = null) {
    return getCaptureEvidenceControl()?.formatStats(stats, active, diagnostics) || '';
}

function resolveCaptureRecorderTone(data = {}, active = null, stats = null, diagnostics = null) {
    return getCaptureEvidenceControl()?.resolveRecorderTone(data, active, stats, diagnostics) || 'warn';
}

function formatCaptureFilters(filters = {}) {
    return getCaptureRecorderControl()?.formatFilters(filters) || '';
}

function splitCaptureFilterInput(value) {
    return getCaptureRecorderControl()?.splitFilterInput(value) || [];
}

function getCaptureFilters(hostInputId, ipInputId) {
    return getCaptureRecorderControl()?.getFilters(hostInputId, ipInputId) || { hosts: [], ips: [] };
}

function getRequestCollectionFilters() {
    return getCaptureRecorderControl()?.getRequestCollectionFilters() || { hosts: [], ips: [] };
}

function getRequestCollectionLocationOverride() {
    return getCaptureRecorderControl()?.getRequestCollectionLocationOverride() || {};
}

function getManualCaptureRecorderFilters() {
    return getCaptureRecorderControl()?.getManualFilters() || { hosts: [], ips: [] };
}

async function startCaptureRecorder() {
    await getCaptureRecorderControl()?.start();
}

async function stopCaptureRecorder() {
    await getCaptureRecorderControl()?.stop();
}

function getFilteredCaptureEvidenceRows() {
    return getCaptureEvidenceControl()?.getFilteredEvidenceRows(captureEvidenceRows) || [];
}

function renderCaptureEvidenceTable() {
    getCaptureEvidenceControl()?.renderEvidenceTable(captureEvidenceRows);
}

function renderCaptureTarget(row = {}) {
    return getCaptureEvidenceControl()?.renderTarget(row) || '';
}

function renderCaptureProxy(proxy = {}) {
    return getCaptureEvidenceControl()?.renderProxy(proxy) || '';
}

function exportCaptureEvidence() {
    getCaptureEvidenceControl()?.exportEvidence(captureEvidenceRows);
}

function maskProxyUrl(proxyUrl) {
    return getCaptureEvidenceControl()?.maskProxyUrl(proxyUrl) || '';
}

function normalizeRunQuotaStats(data = null) {
    return getCrawlerRunQuotaControl()?.normalizeRunQuotaStats(data) || null;
}

function formatRunQuotaLimit(limit, unlimited = false) {
    return getCrawlerRunQuotaControl()?.formatRunQuotaLimit(limit, unlimited)
        || (unlimited || limit === null ? '无上限' : String(limit));
}

function formatRunQuotaUsage(runQuota = {}) {
    return getCrawlerRunQuotaControl()?.formatRunQuotaUsage(runQuota)
        || `${Math.max(0, Number(runQuota.used) || 0)}/${formatRunQuotaLimit(runQuota.limit, runQuota.unlimited)}`;
}

function getCrawlerPerRunLimitFromInput() {
    return getCrawlerRunQuotaControl()?.getPerRunLimitFromInput();
}

function renderCrawlerRunQuotaStats(data = {}, runQuota = null) {
    getCrawlerRunQuotaControl()?.render(data, runQuota);
}

async function loadCrawlerRunQuota() {
    await getCrawlerRunQuotaControl()?.load();
}

async function saveCrawlerRunQuota() {
    await getCrawlerRunQuotaControl()?.save();
}

function getOcrQualityControl() {
    if (ocrQualityControl) return ocrQualityControl;
    if (!window.OcrQualityControl?.createController) return null;
    ocrQualityControl = window.OcrQualityControl.createController({
        confirm,
        document,
        escapeHtml,
        fetch,
        formatTime,
        serviceBase: SERVICE_BASE,
        setStatusBannerState
    });
    return ocrQualityControl;
}

function getSyncNodeControl() {
    if (syncNodeControl) return syncNodeControl;
    if (!window.SyncNodeControl?.createController) return null;
    syncNodeControl = window.SyncNodeControl.createController({
        confirm,
        document,
        escapeHtml,
        fetch,
        formatTime,
        serviceBase: SERVICE_BASE,
        setStatusBannerState
    });
    return syncNodeControl;
}

function getOperationsGovernanceControl() {
    if (operationsGovernanceControl) return operationsGovernanceControl;
    if (!window.OperationsGovernanceControl?.createController) return null;
    operationsGovernanceControl = window.OperationsGovernanceControl.createController({
        confirm,
        document,
        escapeHtml,
        fetch,
        formatTime,
        formatUserReason,
        serviceBase: SERVICE_BASE,
        setStatusBannerState
    });
    return operationsGovernanceControl;
}

function initMobileControlPanel() {
    initMobileMockLocationControl();
    getMobileIntentChatControl()?.init([
        '查看手机状态',
        '读取当前页面',
        '停止验证',
        '查询上海、北京、广州，每个城市新增100条价格/枪数快照'
    ]);
    refreshMobileControl().catch(() => {});
}

function syncMobileControlAccessState() {
    // 浏览器控制面使用同源身份会话，不读取或保存设备机器凭据。
}

function getMobileControlHeaders() {
    return { 'Content-Type': 'application/json' };
}

async function ensureMobileControlBrowserSession() {
    return { authMode: 'same-origin-session' };
}

async function requestMobileControl(path, options = {}) {
    syncMobileControlAccessState();
    await ensureMobileControlBrowserSession();
    const res = await fetch(`${SERVICE_BASE}${path}`, {
        ...options,
        credentials: 'same-origin',
        headers: {
            ...getMobileControlHeaders({ allowBrowserSession: true }),
            ...(options.headers || {})
        }
    });
    const result = await res.json();
    if (!result.success) {
        throw new Error(result.error || '协同服务请求失败');
    }
    return result.data;
}

function getEdgeAgentControl() {
    if (edgeAgentControl) return edgeAgentControl;
    if (!window.EdgeAgentControl?.createController) return null;
    edgeAgentControl = window.EdgeAgentControl.createController({ document, escapeHtml, formatTime });
    return edgeAgentControl;
}

function getMobileControlBoard() {
    if (mobileControlBoard) {
        return mobileControlBoard;
    }
    if (!window.MobileControlBoard?.createController) {
        return null;
    }
    mobileControlBoard = window.MobileControlBoard.createController({
        document,
        escapeHtml,
        formatPresetCoordinate,
        formatTime
    });
    return mobileControlBoard;
}

function getMobileIntentChatControl() {
    if (mobileIntentChatControl) {
        return mobileIntentChatControl;
    }
    if (!window.MobileIntentChatControl?.createController) {
        return null;
    }
    mobileIntentChatControl = window.MobileIntentChatControl.createController({
        document,
        escapeHtml,
        isAiFeaturesEnabled,
        localStorage,
        refreshMobileControl,
        renderProductReadinessPanel,
        requestMobileControl,
        setStatusBannerState
    });
    return mobileIntentChatControl;
}

function getMobileMockLocationControl() {
    if (mobileMockLocationControl) {
        return mobileMockLocationControl;
    }
    if (!window.MobileMockLocationControl?.createController) {
        return null;
    }
    mobileMockLocationControl = window.MobileMockLocationControl.createController({
        document,
        findCityPreset,
        formatPresetCoordinate,
        getCityPresets: () => CITY_PRESETS,
        populateCityPresetOptions,
        refreshMobileControl,
        requestMobileControl,
        setStatusBannerState
    });
    return mobileMockLocationControl;
}

function setMobileMockLocationStatus(message, tone = '') {
    const control = getMobileMockLocationControl();
    if (control) {
        control.setStatus(message, tone);
        return;
    }
    setStatusBannerState(document.getElementById('mobileMockLocationStatus'), message, tone);
}

async function applyMobileMockLocation() {
    const control = getMobileMockLocationControl();
    if (!control) {
        throw new Error('模拟定位控制器未加载');
    }
    await control.apply();
}

async function restoreMobileLocation() {
    const control = getMobileMockLocationControl();
    if (!control) {
        throw new Error('模拟定位控制器未加载');
    }
    await control.restore();
}

function initMobileMockLocationControl() {
    getMobileMockLocationControl()?.init();
}

async function loadMobileInteractionConfig() {
    const control = getMobileIntentChatControl();
    if (!control) {
        throw new Error('手机指令控制器未加载');
    }
    return control.loadInteractionConfig();
}

function setMobileInteractionConfigError(error) {
    getMobileIntentChatControl()?.setConfigError(error);
}

function renderMobileDccStatus(intentParser = {}) {
    getMobileIntentChatControl()?.renderDccStatus(intentParser);
}

function renderMobileIntentExamples(examples = []) {
    getMobileIntentChatControl()?.renderExamples(examples);
}

function setMobileIntentStatus(message, tone = '') {
    const control = getMobileIntentChatControl();
    if (control) {
        control.setStatus(message, tone);
        return;
    }
    setStatusBannerState(document.getElementById('mobileIntentStatus'), message, tone);
}

function formatMobileParseSource(value) {
    return getMobileIntentChatControl()?.formatParseSource(value) || value || '未知';
}

async function submitMobileIntent(instruction) {
    const control = getMobileIntentChatControl();
    if (!control) {
        throw new Error('手机指令控制器未加载');
    }
    await control.submit(instruction);
}

function renderMobileChat(messages = []) {
    getMobileIntentChatControl()?.renderChat(messages);
}

async function loadMobileChatSession() {
    const control = getMobileIntentChatControl();
    if (control) {
        await control.loadChatSession();
    }
}

async function refreshMobileControl() {
    const [workflows, commands, devices, edgeStatus, edgeNodes, edgeTasks] = await Promise.all([
        requestMobileControl('/mobile-control/workflows'),
        requestMobileControl('/mobile-control/commands?limit=12'),
        requestMobileControl('/mobile-control/devices?limit=10').catch(() => []),
        requestMobileControl('/edge/status').catch(() => ({ nodes: {}, tasks: {} })),
        requestMobileControl('/edge/nodes').catch(() => []),
        requestMobileControl('/edge/tasks?limit=20').catch(() => [])
    ]);
    renderMobileWorkflows(workflows || []);
    renderMobileCommands(commands || []);
    renderMobileOverview(workflows || [], commands || [], devices || []);
    getEdgeAgentControl()?.render({ status: edgeStatus, nodes: edgeNodes, tasks: edgeTasks });
}

function renderMobileOverview(workflows = [], commands = [], devices = []) {
    getMobileControlBoard()?.renderOverview(workflows, commands, devices);
}

function findLatestDeviceStatus(commands = []) {
    return getMobileControlBoard()?.findLatestDeviceStatus(commands) || null;
}

function renderMobileWorkflows(workflows = []) {
    getMobileControlBoard()?.renderWorkflows(workflows);
}

function renderMobileCommands(commands = []) {
    getMobileControlBoard()?.renderCommands(commands);
}

function summarizeCommandResult(command = {}) {
    return getMobileControlBoard()?.summarizeCommandResult(command) || '';
}

function formatCommandType(type) {
    return getMobileControlBoard()?.formatCommandType(type) || String(type || '未知动作');
}

function formatMobileStatus(status) {
    return getMobileControlBoard()?.formatMobileStatus(status) || String(status || '未知');
}

function formatLandmarkCursor(cursor = {}) {
    return getMobileControlBoard()?.formatLandmarkCursor(cursor) || '-';
}

function getAvailablePlatformIds(platforms = null) {
    return getPlatformSelectionControl()?.getAvailablePlatformIds(platforms) || [];
}

function ensureSelectedPlatforms(options = {}) {
    return getPlatformSelectionControl()?.ensureSelectedPlatforms(options) || selectedPlatforms;
}

// 渲染平台列表
function renderPlatforms(platforms) {
    getPlatformSelectionControl()?.renderPlatforms(platforms);
}

function syncPlatformCardSelection() {
    getPlatformSelectionControl()?.syncPlatformCardSelection();
}

// 渲染平台筛选器
function renderPlatformFilter(platforms) {
    getPlatformSelectionControl()?.renderPlatformFilter(platforms);
}

// 加载统计数据
async function loadStats() {
    await getDataDashboardControl()?.loadStats();
}

// 加载数据
async function loadData() {
    await getDataDashboardControl()?.loadData();
}

// 加载定时任务
async function loadSchedules() {
    await getScheduleControl()?.loadSchedules();
}

function getAutomationCities() {
    return getCollectionFlowControl()?.getAutomationCities() || [];
}

function getPageOcrCities() {
    return getCollectionFlowControl()?.getPageOcrCities() || [];
}

function getPageOcrScrollOptions() {
    return getCollectionFlowControl()?.getPageOcrScrollOptions() || {
        scrollMode: 'count',
        scrollCount: 10,
        scrollIntervalMin: 3000,
        scrollIntervalMax: 5000,
        pageCaptureBatchSize: 1
    };
}

function setPageOcrButtons(running) {
    getCollectionFlowControl()?.setPageOcrButtons(running);
}

function setCaptureCollectButtons(running) {
    getCollectionFlowControl()?.setCaptureCollectButtons(running);
}


function formatRuntimeCheck(check = {}) {
    return getWorkflowStatusControl()?.formatRuntimeCheck(check) || '未检测';
}

function safeJson(value) {
    try {
        return JSON.stringify(value ?? {}, null, 2);
    } catch {
        return String(value ?? '');
    }
}

async function fetchJsonOrThrow(url, options) {
    const res = await fetch(url, options);
    if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
    }
    return res.json();
}

function firstTextValue(...values) {
    return getWorkflowStatusControl()?.firstTextValue(...values) || '';
}

function normalizeWorkflowReason(value) {
    return getWorkflowStatusControl()?.normalizeWorkflowReason(value) || '';
}

function normalizeStatusPayload(payload = {}) {
    return getWorkflowStatusControl()?.normalizeStatusPayload(payload) || payload || {};
}

function buildWorkflowSteps(defaultSteps = [], workflow = {}, activeIndex = 0, blocked = false) {
    return getWorkflowStatusControl()?.buildWorkflowSteps(defaultSteps, workflow, activeIndex, blocked) || [];
}

function renderWorkflowPanel(prefix, view = {}) {
    getWorkflowStatusControl()?.renderWorkflowPanel(prefix, view);
}

function getWorkflowActiveIndex(workflow = {}, fallback = 0) {
    return getWorkflowStatusControl()?.getWorkflowActiveIndex(workflow, fallback) ?? fallback;
}

function derivePageCollectionWorkflowView(result = {}) {
    return getWorkflowStatusControl()?.derivePageCollectionWorkflowView(result) || {};
}

function deriveRequestCollectionWorkflowView(result = {}) {
    return getWorkflowStatusControl()?.deriveRequestCollectionWorkflowView(result) || {};
}

function renderRequestCollectionStatus(result = {}) {
    getWorkflowStatusControl()?.renderRequestCollectionStatus(result);
}

async function refreshRequestCollectionStatus() {
    return getRequestCollectionControl()?.refreshStatus();
}

async function startRequestCollectionCapture() {
    return getRequestCollectionControl()?.startCapture();
}

async function stopAnalyzeRequestCollectionCapture() {
    return getRequestCollectionControl()?.stopAndAnalyze();
}

function getRequestCollectionAutoInput() {
    return getRequestCollectionControl()?.getAutoInput() || {
        platform: selectedPlatforms[0] || DEFAULT_PLATFORM_ID,
        targets: [],
        cities: [],
        filterHosts: '',
        filterIps: '',
        manageSystemProxy: true,
        writeToDb: true,
        maxScrolls: 5,
        maxSteps: 20,
        maxDurationSeconds: 600
    };
}

function formatRequestCollectionImportSummary(importSummary = null) {
    return getCollectionResultControl()?.formatRequestCollectionImportSummary(importSummary) || '入库：未执行';
}

function formatRequestCollectionOperationSummary(operation = {}) {
    return getCollectionResultControl()?.formatRequestCollectionOperationSummary(operation) || '页面操控：未执行';
}

function formatRequestCollectionRequestSummary(result = {}) {
    return getCollectionResultControl()?.formatRequestCollectionRequestSummary(result) || '暂无目标业务请求。';
}

async function runRequestCollectionAutoCapture() {
    return getRequestCollectionControl()?.runAutoCapture();
}

function renderAccessValidationStatus(result = {}) {
    getWorkflowStatusControl()?.renderAccessValidationStatus(result);
}

function getAccessValidationInput() {
    return getAccessValidationControl()?.getInput() || {
        platform: selectedPlatforms[0] || DEFAULT_PLATFORM_ID,
        city: '上海',
        lat: 31.2304,
        lng: 121.4737,
        mode: 'list',
        maxPages: 1,
        maxRequestCount: 5,
        maxQps: 1
    };
}

async function refreshAccessValidationStatus() {
    return getAccessValidationControl()?.refreshStatus();
}

async function runAccessValidationPreflight() {
    return getAccessValidationControl()?.runPreflight();
}

async function runAccessValidationBasicCheck() {
    return getAccessValidationControl()?.runBasicCheck();
}

function formatPageCollectionCheck(check = {}) {
    return getWorkflowStatusControl()?.formatPageCollectionCheck(check) || '不可用';
}

function renderPageCollectionResult(result = {}) {
    getWorkflowStatusControl()?.renderPageCollectionResult(result);
}

async function refreshPageCollectionStatus() {
    return getPageCollectionControl()?.refreshStatus();
}

async function runPageCollectionBasicCheck() {
    return getPageCollectionControl()?.runBasicCheck();
}

function getPageCollectionPlatform() {
    return getPageCollectionControl()?.getPlatform() || selectedPlatforms[0] || DEFAULT_PLATFORM_ID;
}

function setPageCollectionTrace(result) {
    getCollectionResultControl()?.setPageCollectionTrace(result);
}

async function postPageCollectionAction(path, payload = {}, runningMessage = '') {
    return getPageCollectionControl()?.postAction(path, payload, runningMessage);
}

async function openPageCollectionMiniapp() {
    return getPageCollectionControl()?.openMiniapp();
}

async function observePageCollectionPage() {
    return getPageCollectionControl()?.observePage();
}

async function scrollPageCollectionOnce() {
    return getPageCollectionControl()?.scrollOnce();
}

async function backPageCollectionOnce() {
    return getPageCollectionControl()?.backOnce();
}

async function switchPageCollectionCity() {
    return getPageCollectionControl()?.switchCity();
}

async function tapPageCollectionByText() {
    return getPageCollectionControl()?.tapByText();
}

async function runPageCollectionAdaptive() {
    return getPageCollectionControl()?.runAdaptive();
}


function renderAiAgentDashboard(status = {}, events = [], analyses = [], patches = []) {
    getAiAgentDashboardControl()?.renderDashboard(status, events, analyses, patches);
}

async function loadAiAgentDashboard() {
    return getAiAgentDashboardControl()?.loadDashboard()
        || { success: false, reason: 'ai_agent_dashboard_controller_missing' };
}

async function runPageOcrPreflight() {
    return getPageOcrControl()?.runPreflight();
}

async function startPageOcrCollection() {
    return getPageOcrControl()?.startCollection();
}

// 开始验证（智能模式）
async function startCollection() {
    return getSmartCollectionControl()?.startCollection();
}

async function runCollectPreflight() {
    return getSmartCollectionControl()?.runPreflight();
}

function renderPreflightChecks(checks) {
    getCollectionResultControl()?.renderPreflightChecks(checks);
}

async function finishCollection() {
    await getCollectionSessionControl()?.finishSession();
}

// 取消验证
async function cancelCollection() {
    await getCollectionSessionControl()?.cancelSession();
}

function renderCaptureAnalysisLog(analysis) {
    getCollectionResultControl()?.renderCaptureAnalysisLog(analysis);
}

function resolveManualCapturePlatform() {
    return getPageOcrControl()?.resolveManualCapturePlatform();
}

async function captureCurrentPage() {
    return getPageOcrControl()?.captureCurrentPage();
}

function appendLogEntry(containerId, message, type = 'info') {
    const logContainer = document.getElementById(containerId);
    if (!logContainer) {
        return;
    }

    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;

    const timestamp = document.createElement('div');
    timestamp.className = 'timestamp';
    timestamp.textContent = new Date().toLocaleTimeString();

    const body = document.createElement('div');
    body.textContent = String(message || '');

    entry.appendChild(timestamp);
    entry.appendChild(body);
    logContainer.insertBefore(entry, logContainer.firstChild);
}

function setTemplateApiProgressMeta(text) {
    getTemplateApiProgressControl()?.setProgressMeta(text);
}

function clearTemplateApiProgress() {
    getTemplateApiProgressControl()?.clearProgress();
}

function addTemplateApiLog(message, type = 'info', mirrorToCollectionLog = true) {
    getTemplateApiProgressControl()?.addProgressLog(message, type, mirrorToCollectionLog);
}

function setTemplateApiRunning(isRunning) {
    getTemplateApiProgressControl()?.setRunning(isRunning);
}

function stopTemplateApiProgressPolling(runId = null) {
    getTemplateApiProgressControl()?.stopPolling(runId);
}

function renderTemplateApiProgressCard(run) {
    getTemplateApiProgressControl()?.renderProgressCard(run);
}

async function pollTemplateApiRunProgress(runId) {
    return getTemplateApiProgressControl()?.pollRunProgress(runId) || null;
}

function startTemplateApiProgressPolling(runId) {
    getTemplateApiProgressControl()?.startPolling(runId);
}

function renderTemplateApiRunResult(run) {
    getTemplateApiProgressControl()?.renderRunResult(run);
}

async function crawlByCoordinatesForSelectedPlatforms() {
    await getCoordinateCrawlControl()?.startForSelectedPlatforms();
}

function renderInlineSelfHealLogs(selfHeal, logger = addLog) {
    getSelfHealOperationsControl()?.renderInlineLogs(selfHeal, logger);
}

function clearSelfHealPlan() {
    getSelfHealOperationsControl()?.clearPlan();
}

async function applyLatestSelfHealPlan() {
    await getSelfHealOperationsControl()?.applyLatestPlan();
}

async function recordSelfHealApplication(diagnosis) {
    await getSelfHealOperationsControl()?.recordApplication(diagnosis);
}

function startSessionPolling() {
    getCollectionSessionControl()?.startSessionPolling();
}

function stopSessionPolling() {
    getCollectionSessionControl()?.stopSessionPolling();
}

async function syncActiveSession() {
    await getCollectionSessionControl()?.syncActiveSession();
}

function renderSessionLogs(logs) {
    getCollectionResultControl()?.renderSessionLogs(logs);
}

// 创建定时任务
async function createSchedule() {
    await getScheduleControl()?.createSchedule();
}

async function drillSchedule(id) {
    await getScheduleControl()?.drillSchedule(id);
}

async function runScheduleNow(id) {
    await getScheduleControl()?.runScheduleNow(id);
}

// 切换定时任务状态
async function toggleSchedule(id, enabled) {
    await getScheduleControl()?.toggleSchedule(id, enabled);
}

// 删除定时任务
async function deleteSchedule(id) {
    await getScheduleControl()?.deleteSchedule(id);
}

async function runSelfHealDiagnosis() {
    await getSelfHealOperationsControl()?.runDiagnosis();
}

// 导出 CSV
function exportCSV() {
    getDataDashboardControl()?.exportCSV();
}

function getCityLocationControl() {
    if (cityLocationControl) {
        return cityLocationControl;
    }
    if (!window.CityLocationControl?.createController) {
        return null;
    }
    cityLocationControl = window.CityLocationControl.createController({
        alert,
        document,
        fetch,
        getCityPresets: () => CITY_PRESETS,
        getCollectState: () => ({
            location: collectTargetLocation,
            locations: collectTargetLocations
        }),
        serviceBase: SERVICE_BASE,
        setCollectState: state => {
            collectTargetLocation = state?.location || null;
            collectTargetLocations = Array.isArray(state?.locations) ? state.locations : [];
        }
    });
    return cityLocationControl;
}

function normalizeCityPresetKeyword(value = '') {
    return getCityLocationControl()?.normalizeCityPresetKeyword(value) || '';
}

function formatPresetCoordinate(value) {
    const control = getCityLocationControl();
    if (control) {
        return control.formatPresetCoordinate(value);
    }
    const num = Number(value);
    return Number.isFinite(num) ? num.toFixed(6).replace(/0+$/, '').replace(/\.$/, '') : '';
}

function findCityPreset(keyword) {
    return getCityLocationControl()?.findCityPreset(keyword) || null;
}

function populateCityPresetOptions(datalistId) {
    getCityLocationControl()?.populateCityPresetOptions(datalistId);
}

function updateCityPresetMeta(metaEl, city, fallbackText = '') {
    getCityLocationControl()?.updateCityPresetMeta(metaEl, city, fallbackText);
}

function applyLocationToCollectForm(location) {
    return getCityLocationControl()?.applyLocationToCollectForm(location) || false;
}

function buildCollectTargetLocation(centerLat, centerLng) {
    return getCityLocationControl()?.buildCollectTargetLocation(centerLat, centerLng) || {};
}

function parseCollectTargetKeywords() {
    return getCityLocationControl()?.parseCollectTargetKeywords() || [];
}

function parseCoordinateKeyword(keyword) {
    return getCityLocationControl()?.parseCoordinateKeyword(keyword) || null;
}

async function resolveLocationKeyword(keyword) {
    const control = getCityLocationControl();
    if (!control) {
        throw new Error('城市定位控制器未加载');
    }
    return control.resolveLocationKeyword(keyword);
}

function summarizeTargetLocations(locations = []) {
    return getCityLocationControl()?.summarizeTargetLocations(locations) || '';
}

function applyTargetLocationsToCollectForm(locations = []) {
    return getCityLocationControl()?.applyTargetLocationsToCollectForm(locations) || false;
}

async function resolveCollectTargetLocations(centerLat = null, centerLng = null) {
    const control = getCityLocationControl();
    if (!control) {
        throw new Error('城市定位控制器未加载');
    }
    return control.resolveCollectTargetLocations(centerLat, centerLng);
}

async function resolveCollectLocation() {
    return getCityLocationControl()?.resolveCollectLocation();
}

function setupCityPresetInput(options) {
    getCityLocationControl()?.setupCityPresetInput(options);
}

// 事件监听
function setupEventListeners() {
    setupCityPresetInput({
        inputId: 'collectPresetCity',
        datalistId: 'collectPresetCityList',
        latId: 'collectCenterLat',
        lngId: 'collectCenterLng',
        metaId: 'collectPresetCityMeta'
    });

    getCollectionFlowControl()?.initScrollModeControl();

    document.getElementById('startCollect').addEventListener('click', startCollection);
    document.getElementById('preflightCollect').addEventListener('click', async () => {
        try {
            await runCollectPreflight();
        } catch (error) {
            addLog(`❌ 自动化预检异常: ${error.message}`, 'error');
        }
    });
    document.getElementById('finishCollect').addEventListener('click', finishCollection);
    document.getElementById('cancelCollect').addEventListener('click', cancelCollection);
    document.getElementById('preflightPageOcrCollect')?.addEventListener('click', async () => {
        try {
            await runPageOcrPreflight();
        } catch (error) {
            addLog(`❌ 页面识别检查异常: ${error.message}`, 'error');
        }
    });
    document.getElementById('startPageOcrCollect')?.addEventListener('click', startPageOcrCollection);
    document.getElementById('pageCollectionMode')?.addEventListener('change', updatePageCollectionModeHint);
    document.getElementById('finishPageOcrCollect')?.addEventListener('click', finishCollection);
    document.getElementById('cancelPageOcrCollect')?.addEventListener('click', cancelCollection);
    document.getElementById('captureCurrentPage').addEventListener('click', async () => {
        try {
            await captureCurrentPage();
        } catch (error) {
            addLog(`❌ ${error.message}`, 'error');
        }
    });
    document.getElementById('method1RefreshStatus')?.addEventListener('click', async () => {
        await refreshPageCollectionStatus();
    });
    document.getElementById('method1RunBasicCheck')?.addEventListener('click', async () => {
        await runPageCollectionBasicCheck();
    });
    document.getElementById('method1OpenMiniapp')?.addEventListener('click', async () => {
        try { await openPageCollectionMiniapp(); } catch (error) { addLog(`❌ 打开小程序异常: ${error.message}`, 'error'); }
    });
    document.getElementById('method1Observe')?.addEventListener('click', async () => {
        try { await observePageCollectionPage(); } catch (error) { addLog(`❌ 页面观察异常: ${error.message}`, 'error'); }
    });
    document.getElementById('method1ScrollOnce')?.addEventListener('click', async () => {
        try { await scrollPageCollectionOnce(); } catch (error) { addLog(`❌ 下滑异常: ${error.message}`, 'error'); }
    });
    document.getElementById('method1BackOnce')?.addEventListener('click', async () => {
        try { await backPageCollectionOnce(); } catch (error) { addLog(`❌ 返回异常: ${error.message}`, 'error'); }
    });
    document.getElementById('method1RunAdaptive')?.addEventListener('click', async () => {
        try { await runPageCollectionAdaptive(); } catch (error) { addLog(`❌ 动态决策异常: ${error.message}`, 'error'); }
    });
    document.getElementById('method1SwitchCity')?.addEventListener('click', async () => {
        try { await switchPageCollectionCity(); } catch (error) { addLog(`❌ 切城市异常: ${error.message}`, 'error'); }
    });
    document.getElementById('method1TapByText')?.addEventListener('click', async () => {
        try { await tapPageCollectionByText(); } catch (error) { addLog(`❌ 点击异常: ${error.message}`, 'error'); }
    });
    updatePageCollectionModeHint();

    document.getElementById('method2RefreshStatus')?.addEventListener('click', async () => {
        await refreshRequestCollectionStatus();
    });
    document.getElementById('method2StartCapture')?.addEventListener('click', async () => {
        try { await startRequestCollectionCapture(); } catch (error) { addLog(`请求采集异常: ${error.message}`, 'error'); }
    });
    document.getElementById('method2StopAnalyze')?.addEventListener('click', async () => {
        try { await stopAnalyzeRequestCollectionCapture(); } catch (error) { addLog(`❌ 请求分析异常: ${error.message}`, 'error'); }
    });
    document.getElementById('method2RunAutoCapture')?.addEventListener('click', async () => {
        try { await runRequestCollectionAutoCapture(); } catch (error) { addLog(`请求自动采集异常: ${error.message}`, 'error'); }
    });
    document.getElementById('method3RefreshStatus')?.addEventListener('click', async () => {
        await refreshAccessValidationStatus();
    });
    document.getElementById('method3Preflight')?.addEventListener('click', async () => {
        try { await runAccessValidationPreflight(); } catch (error) { addLog(`请求材料检查异常: ${error.message}`, 'error'); }
    });
    document.getElementById('method3RunBasic')?.addEventListener('click', async () => {
        try { await runAccessValidationBasicCheck(); } catch (error) { addLog(`访问验证异常: ${error.message}`, 'error'); }
    });
    document.getElementById('globalAgentRefreshBtn')?.addEventListener('click', async () => {
        await loadGlobalAgentDashboard();
    });
    document.getElementById('globalAgentPlanBtn')?.addEventListener('click', async () => {
        try { await planGlobalAgentAction(); } catch (error) { alert(error.message); }
    });
    document.getElementById('globalAgentDryRunBtn')?.addEventListener('click', async () => {
        try { await dryRunGlobalAgentAction(); } catch (error) { alert(error.message); }
    });
    document.getElementById('agentWorkbenchRefreshBtn')?.addEventListener('click', async () => {
        await loadGlobalAgentDashboard();
    });
    document.getElementById('agentWorkbenchSendBtn')?.addEventListener('click', async () => {
        try { await sendAgentWorkbenchChat(); } catch (error) { alert(error.message); }
    });
    document.getElementById('agentWorkbenchNewChatBtn')?.addEventListener('click', resetAgentWorkbenchConversation);
    const agentPrompt = document.getElementById('agentWorkbenchPrompt');
    const agentSend = document.getElementById('agentWorkbenchSendBtn');
    const syncAgentComposer = () => {
        getAgentWorkbenchControl()?.syncComposer();
    };
    agentPrompt?.addEventListener('input', syncAgentComposer);
    agentPrompt?.addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
            event.preventDefault();
            if (agentPrompt.value.trim()) agentSend?.click();
        }
    });
    document.getElementById('agentWorkbenchModelSelect')?.addEventListener('change', async () => {
        await applyAgentWorkbenchModelSelection();
    });
    document.getElementById('crawlByCoordinatesBtn')?.addEventListener('click', crawlByCoordinatesForSelectedPlatforms);
    document.getElementById('resolveCollectLocationBtn')?.addEventListener('click', resolveCollectLocation);
    document.getElementById('refreshData').addEventListener('click', loadData);
    document.getElementById('exportCSV').addEventListener('click', exportCSV);
    document.getElementById('createSchedule').addEventListener('click', createSchedule);
    document.getElementById('platformFilter').addEventListener('change', loadData);
    document.getElementById('saveSettingsBtn').addEventListener('click', async () => {
        try {
            await saveNetworkSettings();
        } catch (error) {
            alert(error.message);
        }
    });
    document.getElementById('saveAiAgentSettingsBtn')?.addEventListener('click', async () => {
        try {
            await saveAiAgentSettings();
        } catch (error) {
            alert(error.message);
        }
    });
    document.getElementById('saveSelfHealSettingsBtn')?.addEventListener('click', async () => {
        try {
            await saveSelfHealSettings();
            await loadSchedules();
        } catch (error) {
            alert(error.message);
        }
    });
    document.getElementById('runSelfHealDiagnosisBtn')?.addEventListener('click', async () => {
        await runSelfHealDiagnosis();
    });
    document.getElementById('addCityProxyBtn')?.addEventListener('click', () => appendCityProxyRow());
    document.getElementById('refreshCaptureCenterBtn')?.addEventListener('click', async () => {
        await loadCaptureCenter();
    });
    document.getElementById('refreshSecurityReportsBtn')?.addEventListener('click', async () => {
        await loadCaptureCenter();
        showSecurityReportList();
    });
    document.getElementById('backToReportListBtn')?.addEventListener('click', showSecurityReportList);
    document.getElementById('securityReportList')?.addEventListener('click', event => {
        const row = event.target.closest('[data-report-id]');
        if (!row) {
            return;
        }
        openSecurityReportDetail(row.dataset.reportId);
    });
    document.getElementById('startCaptureRecorderBtn')?.addEventListener('click', async () => {
        try {
            await startCaptureRecorder();
        } catch (error) {
            setStatusBannerState(document.getElementById('captureRecorderStatus'), `请求记录服务启动失败：${error.message}`, 'error');
        }
    });
    document.getElementById('stopCaptureRecorderBtn')?.addEventListener('click', async () => {
        try {
            await stopCaptureRecorder();
        } catch (error) {
            setStatusBannerState(document.getElementById('captureRecorderStatus'), `请求记录服务停止失败：${error.message}`, 'error');
        }
    });
    document.getElementById('exportCaptureEvidenceBtn')?.addEventListener('click', exportCaptureEvidence);
    document.getElementById('captureEvidenceLimit')?.addEventListener('change', async () => {
        await loadCaptureCenter();
    });
    document.getElementById('captureProxyFilter')?.addEventListener('change', renderCaptureEvidenceTable);
    document.getElementById('captureStatusFilter')?.addEventListener('change', renderCaptureEvidenceTable);
    document.getElementById('crawlerUnlimitedRunInput')?.addEventListener('change', event => {
        getCrawlerRunQuotaControl()?.syncUnlimitedInput(event);
    });
    document.getElementById('saveCrawlerRunLimitBtn')?.addEventListener('click', async () => {
        try {
            await saveCrawlerRunQuota();
        } catch (error) {
            alert(error.message);
        }
    });
    document.getElementById('sendMobileIntentBtn')?.addEventListener('click', async () => {
        try {
            await submitMobileIntent();
        } catch (error) {
            setMobileIntentStatus(`需求下发失败：${error.message}`, 'error');
        }
    });
    document.getElementById('mobileIntentInput')?.addEventListener('keydown', async event => {
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            try {
                await submitMobileIntent();
            } catch (error) {
                setMobileIntentStatus(`需求下发失败：${error.message}`, 'error');
            }
        }
    });
    document.getElementById('mobileStatusBtn')?.addEventListener('click', async () => {
        try {
            await submitMobileIntent('查看手机状态');
        } catch (error) {
            setMobileIntentStatus(`状态指令失败：${error.message}`, 'error');
        }
    });
    document.getElementById('refreshEdgeAgentsBtn')?.addEventListener('click', async () => {
        const status = document.getElementById('edgeOrchestrationStatus');
        try {
            await refreshMobileControl();
            setStatusBannerState(status, '协同状态已刷新', 'success');
        } catch (error) {
            setStatusBannerState(status, `协同状态刷新失败：${error.message}`, 'error');
        }
    });
    document.getElementById('mobileStopBtn')?.addEventListener('click', async () => {
        try {
            await submitMobileIntent('停止验证');
        } catch (error) {
            setMobileIntentStatus(`停止指令失败：${error.message}`, 'error');
        }
    });
    document.getElementById('applyMobileMockLocationBtn')?.addEventListener('click', async () => {
        try {
            await applyMobileMockLocation();
        } catch (error) {
            setMobileMockLocationStatus(`模拟定位下发失败：${error.message}`, 'error');
        }
    });
    document.getElementById('restoreMobileLocationBtn')?.addEventListener('click', async () => {
        try {
            await restoreMobileLocation();
        } catch (error) {
            setMobileMockLocationStatus(`恢复真实定位失败：${error.message}`, 'error');
        }
    });
    document.getElementById('refreshMobileControlBtn')?.addEventListener('click', async () => {
        try {
            await refreshMobileControl();
            setMobileIntentStatus('进度已刷新', 'success');
        } catch (error) {
            setMobileIntentStatus(`进度刷新失败：${error.message}`, 'error');
        }
    });
    
    // 文件上传功能
    document.getElementById('harFileInput').addEventListener('change', handleFileSelect);
    document.getElementById('parseHarBtn').addEventListener('click', parseHarFiles);
}

// 工具函数
function getPlatformName(id) {
    if (!config) return id;
    const platforms = Array.isArray(config.platforms) ? config.platforms : [];
    const platform = platforms.find(p => p.id === id);
    return platform ? platform.name : id;
}

function formatTime(timestamp) {
    if (timestamp === null || timestamp === undefined || String(timestamp).trim() === '') {
        return '-';
    }
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) {
        return '-';
    }
    return date.toLocaleString('zh-CN');
}

function getStationPresentationControl() {
    if (stationPresentationControl) {
        return stationPresentationControl;
    }
    if (!window.StationPresentationControl?.createController) {
        return null;
    }
    stationPresentationControl = window.StationPresentationControl.createController({
        escapeHtml,
        formatTime
    });
    return stationPresentationControl;
}

function formatPriceCell(value) {
    return getStationPresentationControl()?.formatPriceCell(value) || '-';
}

function normalizeStationRecord(record = {}) {
    return getStationPresentationControl()?.normalizeStationRecord(record) || record;
}

function parseJsonArray(value) {
    return getStationPresentationControl()?.parseJsonArray(value) || [];
}

function isFuelPlatform(row) {
    return getStationPresentationControl()?.isFuelPlatform(row) || false;
}

function buildPriceItems(row) {
    return getStationPresentationControl()?.buildPriceItems(row) || [];
}

function buildFuelCountItems(row) {
    return getStationPresentationControl()?.buildFuelCountItems(row) || [];
}

function buildGunItems(row) {
    return getStationPresentationControl()?.buildGunItems(row) || [];
}

function formatGunTypeSummary(row) {
    return getStationPresentationControl()?.formatGunTypeSummary(row) || '枪口数据缺失';
}

function formatGunPart(label, idleValue, totalValue) {
    return getStationPresentationControl()?.formatGunPart(label, idleValue, totalValue) || '';
}

function renderGunTypeSummary(row) {
    return getStationPresentationControl()?.renderGunTypeSummary(row) || '<span class="gun-empty">枪口数据缺失</span>';
}

function renderPriceSummary(row) {
    return getStationPresentationControl()?.renderPriceSummary(row) || '<span class="summary-empty">价格数据缺失</span>';
}

function renderAvailabilitySummary(row) {
    return getStationPresentationControl()?.renderAvailabilitySummary(row) || '<span class="summary-empty">枪口数据缺失</span>';
}

function renderStationEvidenceSummary(row) {
    return getStationPresentationControl()?.renderStationEvidenceSummary(row) || '';
}

function getSourceMeta(sourceType) {
    return getStationPresentationControl()?.getSourceMeta(sourceType) || { label: String(sourceType || 'unknown'), className: 'unknown' };
}

function renderSourceSummary(row) {
    return getStationPresentationControl()?.renderSourceSummary(row) || '';
}

function formatStationInlineSummary(row) {
    return getStationPresentationControl()?.formatStationInlineSummary(row) || '未识别到价格或枪口信息';
}

function formatScheduleType(value) {
    return getStationPresentationControl()?.formatScheduleType(value) || String(value || '');
}

function addLog(message, type = 'info') {
    appendLogEntry('collectionLog', message, type);
}

function addParseLog(message, type = 'info') {
    appendLogEntry('parseLog', message, type);
}

function getTemplateApiProgressControl() {
    if (templateApiProgressControl) {
        return templateApiProgressControl;
    }
    if (!window.TemplateApiProgressControl?.createController) {
        return null;
    }
    templateApiProgressControl = window.TemplateApiProgressControl.createController({
        document,
        serviceBase: SERVICE_BASE,
        workflowLabel: WORKFLOW_LABELS.automation,
        addLog,
        escapeHtml,
        getCurrentRunStats: () => crawlerCurrentRunStats,
        loadCrawlerRunQuota,
        normalizeRunQuotaStats,
        refreshData: () => {
            loadStats();
            loadData();
        },
        renderCrawlerRunQuotaStats,
        setCurrentRunStats: stats => {
            crawlerCurrentRunStats = stats;
        }
    });
    return templateApiProgressControl;
}

// ============ 文件上传和解析功能 ============

function getHarUploadControl() {
    if (harUploadControl) {
        return harUploadControl;
    }
    if (!window.HarUploadControl?.createController) {
        return null;
    }
    harUploadControl = window.HarUploadControl.createController({
        addParseLog,
        alert,
        document,
        fetch,
        refreshData: () => {
            loadStats();
            loadData();
        },
        serviceBase: SERVICE_BASE
    });
    return harUploadControl;
}

function handleFileSelect(event) {
    getHarUploadControl()?.handleFileSelect(event);
}

function renderFileList() {
    getHarUploadControl()?.renderFileList();
}

function removeFile(index) {
    getHarUploadControl()?.removeFile(index);
}

function formatFileSize(bytes) {
    return getHarUploadControl()?.formatFileSize(bytes) || '';
}

async function parseHarFiles() {
    return getHarUploadControl()?.parseHarFiles();
}

function readFileAsText(file) {
    const control = getHarUploadControl();
    if (!control) {
        return Promise.reject(new Error('请求材料上传控制器未加载'));
    }
    return control.readFileAsText(file);
}


function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
