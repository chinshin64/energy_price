const API_BASE = window.DATA_FOR_DIDI_API_BASE || `${window.location.origin}/api`;

let selectedPlatforms = [];
let config = null;
let activeSession = null; // 当前活动的验证会话
let sessionPollTimer = null;
let crawlerCurrentRunStats = null;
let collectTargetLocation = null;
let collectTargetLocations = [];
let selfHealConfig = null;
let latestSelfHealDiagnosis = null;
let aiFeatures = { enabled: false, status: 'planned' };
let captureEvidenceRows = [];
let captureStatusSnapshot = null;
let captureRecorderSnapshot = null;
let activeSecurityReportId = 'BTR-RISK-20260531-0001';
let securityReportItems = [];
let securityReportSource = 'fallback';
let securityReportStatusMessage = '报告接口未加载，当前显示本地样例。';
let securityReportStatusTone = 'warn';
const securityReportDetailCache = new Map();
const templateApiProgressTimers = new Map();
const templateApiRenderedFinalRuns = new Set();
const DEFAULT_PLATFORM_ID = 'didi-charging';
const PAGE_CAPTURE_PLATFORMS = new Set(['teld', 'didi-charging', 'star-charge', 'kuaidian', 'tuanyou', 'ykc']);
const CITY_PRESETS = Array.isArray(window.CHINA_CITY_PRESETS) ? window.CHINA_CITY_PRESETS : [];
const MOBILE_CONTROL_TOKEN_KEY = 'dataForDidiMobileControlToken';
const MOBILE_CONTROL_CHAT_SESSION_KEY = 'dataForDidiMobileChatSessionId';
const TOPBAR_EXPAND_BEFORE_Y = 24;
const TOPBAR_COLLAPSE_AFTER_Y = 96;
const TOPBAR_LAYOUT_SETTLE_MS = 360;
const WORKFLOW_LABELS = {
    page: '页面验证',
    business: '请求验证',
    automation: '接口验证'
};
let mobileChatSessionId = localStorage.getItem(MOBILE_CONTROL_CHAT_SESSION_KEY) || '';
let mobileControlBrowserSessionPromise = null;
let keepTopbarCollapsedAfterNavClick = false;
let topbarCollapsedAfterScroll = false;
let topbarNavCollapseLockAt = 0;
let scheduleTopbarAutoCollapseState = null;
const cityPresetLookup = new Map();
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
            { id: 'business-request', name: '请求验证', status: 'partial' },
            { id: 'traffic-template', name: '接口验证', status: 'partial' }
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
                '请求验证需有 请求记录、截图、请求摘要和数据库校验四类证据。',
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
                title: '请求验证证据不完整',
                severity: 'medium',
                severityLabel: '中风险',
                status: 'pending-retest',
                impact: '无法完整证明报告结论来自真实业务请求链路，影响渗透测试报告归档可信度。',
                evidenceRefs: ['小程序窗口 / 页面截图', '业务 请求记录'],
                retestStatus: 'pending'
            },
            {
                id: 'M-002',
                title: '签名模板待复测',
                severity: 'medium',
                severityLabel: '中风险',
                status: 'pending-retest',
                impact: '失败城市可能由模板签名或目标参数不匹配导致，当前无法判断是目标平台风险、模板过期还是环境问题。',
                evidenceRefs: ['请求材料与目标不匹配'],
                retestStatus: 'pending'
            },
            {
                id: 'L-001',
                title: '武汉、南京接口验证已形成可复核证据',
                severity: 'low',
                severityLabel: '已验证',
                status: 'passed',
                impact: '已能支撑部分通过结论，但仍需与请求验证证据合并归档。',
                evidenceRefs: ['stationList', 'getoneinfo', 'SQLite'],
                retestStatus: 'passed'
            }
        ],
        evidenceMatrix: [
            {
                type: '请求验证预检',
                status: 'partial',
                purpose: '定位环境权限、窗口识别、截图授权问题',
                refs: ['小程序窗口 / 页面截图']
            },
            {
                type: '请求记录 / 请求记录服务',
                status: 'partial',
                purpose: '证明小程序实际业务包来源',
                refs: ['capture-recorder-status', 'business-har-pending']
            },
            {
                type: '接口验证接口日志',
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
                purpose: '区分目标平台失败、签名模板失败和环境问题',
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


const USER_REASON_LABELS = {
    ready: '已准备好',
    success: '执行完成',
    unknown_error: '出现未知问题',
    wechat_not_running: '未检测到电脑端微信，请先打开微信',
    wechat_window_found: '已检测到微信窗口',
    target_window_found: '已检测到目标小程序页面',
    target_window_missing: '未找到目标小程序页面，请先打开目标页面',
    screenshot_ready: '截图能力可用',
    screenshot_failed: '截图失败，请检查屏幕录制权限',
    permission_denied: '系统权限不足，请检查屏幕录制和辅助功能权限',
    ocr_ready: '页面识别能力可用',
    ocr_unavailable: '页面识别不可用，请检查识别组件或系统权限',
    scroll_script_ready: '下滑脚本可用',
    scroll_script_missing: '缺少下滑脚本',
    scroll_failed: '下滑失败，请确认微信窗口在前台',
    page_not_recognized: '未能识别当前页面，请确认页面已打开且无遮挡',
    city_selector_not_found: '未找到城市入口，请确认当前页面支持切换城市',
    city_input_failed: '城市输入失败，请手动确认输入框是否可用',
    city_result_not_found: '未找到目标城市结果',
    city_switch_verify_failed: '城市切换后未能确认结果，请人工核对页面',
    mitmdump_ready: '请求记录服务可用',
    mitmdump_missing: '请求记录服务未安装，请先安装 mitmproxy',
    recorder_ready: '请求记录服务可用',
    recorder_running: '正在记录请求',
    recorder_start_failed: '请求记录启动失败',
    recorder_stop_failed: '请求记录停止失败',
    proxy_not_checked: '代理状态未检查',
    proxy_configured: '代理已配置',
    proxy_not_configured: '代理未配置，请确认网络代理设置',
    har_output_ready: '请求记录文件可写入',
    har_output_unwritable: '请求记录文件不可写入',
    har_not_found: '未找到请求记录文件',
    har_parse_failed: '请求记录解析失败',
    no_request_captured: '没有记录到请求，请确认操作期间有网络请求',
    no_target_request_detected: '没有发现目标业务请求，请确认操作是否触发了目标页面',
    certificate_not_trusted: '证书未被信任，可能无法解析加密请求',
    tls_not_decryptable: '加密请求无法解析',
    template_missing: '请求材料缺失，需要先验证或导入材料',
    signature_corpus_missing: '历史请求材料缺失',
    signed_template_target_mismatch: '请求材料与当前目标不匹配，需要重新验证当前目标材料',
    live_request_material_missing: '缺少当前目标的实时请求材料',
    request_limit_exceeded: '请求次数超过安全限制',
    target_scope_required: '缺少验证范围，请先选择目标城市或坐标',
    target_scope_violation: '目标超出授权验证范围',
    request_failed: '请求失败',
    response_parse_failed: '响应解析失败',
    no_data_returned: '未返回有效数据',
    ai_agent_disabled: '智能诊断未启用',
    ai_agent_not_configured: '智能诊断未配置，请在后台配置模型地址、密钥和模型 ID',
    ai_agent_configured: '智能诊断已配置',
    ai_agent_request_failed: '智能诊断请求失败',
    ai_agent_timeout: '智能诊断超时',
    ai_agent_invalid_json: '智能诊断返回格式异常',
    ai_agent_empty_response: '智能诊断未返回结果',
    ai_agent_type_unsupported: '智能诊断类型不支持',
    bottom_reached: '已到达列表底部',
    max_scrolls_reached: '已达到最大下滑次数',
    max_steps_reached: '已达到最大操作步数',
    login_prompt_detected: '检测到登录提示，需要人工处理',
    network_error: '检测到网络异常'
};

function productizeReason(reason) {
    const key = String(reason || '').trim();
    return USER_REASON_LABELS[key] || key || '未知状态';
}

function formatUserReason(reason, { includeTech = false } = {}) {
    const friendly = productizeReason(reason);
    const tech = String(reason || '').trim();
    if (!includeTech || !tech || friendly === tech) return friendly;
    return `${friendly}（技术详情：${tech}）`;
}

function productizeReasonList(value) {
    if (Array.isArray(value)) return value.map(item => productizeReason(item)).join('、');
    return productizeReason(value);
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

function updateSelectedPlatformSummary() {
    const selectedNames = selectedPlatforms.length > 0
        ? selectedPlatforms.map(getPlatformName).join('、')
        : '未选择';

    document.querySelectorAll('[data-selected-platform-summary]').forEach(element => {
        element.textContent = selectedNames;
    });
    document.querySelectorAll('[data-selected-platform-count]').forEach(element => {
        element.textContent = String(selectedPlatforms.length);
    });
}

function updateOverviewDataMetrics(stats = []) {
    const totalStations = stats.reduce((sum, item) => sum + (Number(item?.unique_stations) || 0), 0);
    const totalRecords = stats.reduce((sum, item) => sum + (Number(item?.total_records) || 0), 0);

    setElementText('heroStationCount', String(totalStations));
    setElementText('heroRecordCount', String(totalRecords));
}

function normalizePlatformStats(stats = []) {
    const rawStats = Array.isArray(stats) ? stats : [];
    const configuredPlatforms = Array.isArray(config?.platforms) ? config.platforms : [];
    if (configuredPlatforms.length === 0) {
        return rawStats;
    }

    const statsByPlatform = new Map(rawStats.map(item => [item.platform, item]));
    const configuredIds = new Set(configuredPlatforms.map(platform => platform.id));
    const normalized = configuredPlatforms.map(platform => {
        const item = statsByPlatform.get(platform.id) || {};
        return {
            platform: platform.id,
            total_records: Number(item.total_records) || 0,
            unique_stations: Number(item.unique_stations) || 0,
            last_collected: item.last_collected || null
        };
    });

    return normalized.concat(rawStats.filter(item => item?.platform && !configuredIds.has(item.platform)));
}

// 初始化
document.addEventListener('DOMContentLoaded', async () => {
    initTabs();
    initTopbarAutoCollapse();
    await loadConfig();
    await loadNetworkSettings();
    await loadCaptureCenter();
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
    
    setupEventListeners();
});

function scrollActiveNavIntoView(targetNav) {
    const navList = targetNav.closest('.top-nav');
    if (!navList) {
        return;
    }

    const navRect = navList.getBoundingClientRect();
    const targetRect = targetNav.getBoundingClientRect();
    let nextScrollLeft = navList.scrollLeft;

    if (targetRect.left < navRect.left) {
        nextScrollLeft -= navRect.left - targetRect.left;
    } else if (targetRect.right > navRect.right) {
        nextScrollLeft += targetRect.right - navRect.right;
    }

    if (Math.round(nextScrollLeft) === Math.round(navList.scrollLeft)) {
        return;
    }

    if (typeof navList.scrollTo === 'function') {
        navList.scrollTo({
            left: nextScrollLeft,
            behavior: 'smooth'
        });
    } else {
        navList.scrollLeft = nextScrollLeft;
    }
}

function preserveCollapsedTopbarForNavClick() {
    const topbar = document.querySelector('.topbar');
    const isCurrentlyCollapsed = keepTopbarCollapsedAfterNavClick
        || document.body.classList.contains('topbar-collapsed')
        || topbar?.dataset.collapsed === 'true';
    const scrollY = Math.max(0, window.scrollY || window.pageYOffset || 0);

    const shouldKeepCollapsedFromPriorScroll = topbarCollapsedAfterScroll && scrollY <= TOPBAR_EXPAND_BEFORE_Y;

    if (!isCurrentlyCollapsed && scrollY <= TOPBAR_EXPAND_BEFORE_Y && !shouldKeepCollapsedFromPriorScroll) {
        return;
    }

    keepTopbarCollapsedAfterNavClick = true;
    topbarNavCollapseLockAt = Date.now();
    document.body.classList.add('topbar-collapsed');

    if (topbar) {
        topbar.dataset.collapsed = 'true';
    }

    if (typeof scheduleTopbarAutoCollapseState === 'function') {
        scheduleTopbarAutoCollapseState();
    }
}

function setActiveTab(targetId, options = {}) {
    const shouldRefreshData = options.refreshData === true;
    const shouldPreserveCollapsedTopbar = options.preserveCollapsedTopbar === true;
    const normalizedTargetId = targetId === 'data' ? 'overview' : targetId;
    const targetSection = document.getElementById(normalizedTargetId);
    const targetNav = document.querySelector(`.nav-item[data-tab="${normalizedTargetId}"]`);

    if (!targetSection || !targetNav) {
        return;
    }

    if (shouldPreserveCollapsedTopbar) {
        preserveCollapsedTopbarForNavClick();
    }

    document.querySelectorAll('.nav-item').forEach(tab => tab.classList.remove('active'));
    document.querySelectorAll('.section').forEach(section => section.classList.remove('active'));

    targetNav.classList.add('active');
    targetSection.classList.add('active');

    scrollActiveNavIntoView(targetNav);

    if (window.location.hash !== `#${normalizedTargetId}`) {
        history.replaceState(null, '', `#${normalizedTargetId}`);
    }

    if (shouldRefreshData && normalizedTargetId === 'overview') {
        loadStats();
        loadData();
    }
    if (shouldRefreshData && normalizedTargetId === 'capture-center') {
        loadCaptureCenter();
    }
}

// 标签切换 - 左侧导航
function initTabs() {
    document.querySelectorAll('.nav-item').forEach(tab => {
        tab.addEventListener('pointerdown', preserveCollapsedTopbarForNavClick, { passive: true });
        tab.addEventListener('click', () => {
            const targetId = tab.dataset.tab;
            setActiveTab(targetId, {
                refreshData: true,
                preserveCollapsedTopbar: true
            });
        });
    });

    const initialTab = window.location.hash ? window.location.hash.slice(1) : 'overview';
    setActiveTab(initialTab, { refreshData: false });
}

function initTopbarAutoCollapse() {
    const topbar = document.querySelector('.topbar');
    if (!topbar) {
        return;
    }

    let framePending = false;
    let userTopReturnIntent = false;
    let lastScrollY = Math.max(0, window.scrollY || window.pageYOffset || 0);
    let lastCollapseStateChangeAt = 0;
    let lastTouchY = null;
    let scrollCollapseActive = document.body.classList.contains('topbar-collapsed') || topbar.dataset.collapsed === 'true';

    const getScrollY = () => Math.max(0, window.scrollY || window.pageYOffset || 0);

    const shouldCollapseForScroll = () => {
        const scrollY = getScrollY();
        if (!scrollCollapseActive) {
            return scrollY >= TOPBAR_COLLAPSE_AFTER_Y;
        }
        if (scrollY > TOPBAR_EXPAND_BEFORE_Y) {
            return true;
        }
        return !userTopReturnIntent;
    };

    const scheduleApplyState = () => {
        if (framePending) {
            return;
        }
        framePending = true;
        window.requestAnimationFrame(applyState);
    };

    const releaseNavClickCollapseLock = () => {
        if (!keepTopbarCollapsedAfterNavClick) {
            scheduleApplyState();
            return;
        }

        keepTopbarCollapsedAfterNavClick = false;
        topbarCollapsedAfterScroll = false;
        topbarNavCollapseLockAt = 0;
        scrollCollapseActive = false;
        scheduleApplyState();
    };

    const markUserTopReturnIntent = () => {
        userTopReturnIntent = true;
        if (getScrollY() <= TOPBAR_EXPAND_BEFORE_Y) {
            releaseNavClickCollapseLock();
            return;
        }
        scheduleApplyState();
    };

    const applyState = () => {
        framePending = false;
        const scrollY = getScrollY();
        const isAtTop = scrollY <= TOPBAR_EXPAND_BEFORE_Y;

        if (isAtTop && userTopReturnIntent && !keepTopbarCollapsedAfterNavClick) {
            keepTopbarCollapsedAfterNavClick = false;
            topbarCollapsedAfterScroll = false;
            topbarNavCollapseLockAt = 0;
            scrollCollapseActive = false;
        }

        const wasScrollCollapseActive = scrollCollapseActive;
        const scrollCollapsed = keepTopbarCollapsedAfterNavClick || shouldCollapseForScroll();
        if (scrollCollapsed !== wasScrollCollapseActive) {
            lastCollapseStateChangeAt = Date.now();
        }
        scrollCollapseActive = scrollCollapsed;

        if (scrollCollapsed && scrollY > TOPBAR_EXPAND_BEFORE_Y) {
            topbarCollapsedAfterScroll = true;
        } else if (!scrollCollapsed && isAtTop) {
            topbarCollapsedAfterScroll = false;
        }

        document.body.classList.toggle('topbar-collapsed', scrollCollapsed);
        topbar.dataset.collapsed = scrollCollapsed ? 'true' : 'false';

        if (isAtTop && userTopReturnIntent) {
            userTopReturnIntent = false;
        }
    };

    scheduleTopbarAutoCollapseState = scheduleApplyState;

    window.addEventListener('scroll', () => {
        const scrollY = getScrollY();
        const now = Date.now();
        const canInferUserScrollUp = now - lastCollapseStateChangeAt > TOPBAR_LAYOUT_SETTLE_MS
            && now - topbarNavCollapseLockAt > TOPBAR_LAYOUT_SETTLE_MS;

        if (scrollY < lastScrollY && canInferUserScrollUp && !keepTopbarCollapsedAfterNavClick) {
            userTopReturnIntent = true;
        }

        lastScrollY = scrollY;
        scheduleTopbarAutoCollapseState();
    }, { passive: true });
    window.addEventListener('resize', scheduleTopbarAutoCollapseState, { passive: true });
    window.addEventListener('wheel', event => {
        if (event.deltaY < 0) {
            markUserTopReturnIntent();
        }
    }, { passive: true });
    window.addEventListener('keydown', event => {
        if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) {
            markUserTopReturnIntent();
        }
    });
    window.addEventListener('touchstart', event => {
        lastTouchY = event.touches?.[0]?.clientY ?? null;
    }, { passive: true });
    window.addEventListener('touchmove', event => {
        const nextTouchY = event.touches?.[0]?.clientY ?? null;
        const isPullingDown = lastTouchY !== null
            && nextTouchY !== null
            && nextTouchY > lastTouchY;
        lastTouchY = nextTouchY;

        if (isPullingDown) {
            markUserTopReturnIntent();
        }
    }, { passive: true });

    applyState();
}

// 加载配置
async function loadConfig() {
    try {
        const res = await fetch(`${API_BASE}/config`);
        config = await res.json();
        aiFeatures = config.aiFeatures || { enabled: false, status: 'planned' };

        updateOverviewPlatformCount(config.platforms || []);
        renderRuntimeMode(config.runtimeSummary || {}, config.runtimeMode || 'unknown');
        renderChainStatus(config.chainStatus || {});
        renderPageCollectionModes(config.collectionModes?.page || []);
        applyAiFeatureState(aiFeatures);
        
        renderPlatforms(config.platforms);
        renderPlatformFilter(config.platforms);
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
    ['saveSelfHealSettingsBtn', 'runSelfHealDiagnosisBtn'].forEach(id => {
        const node = document.getElementById(id);
        if (node) {
            node.disabled = true;
        }
    });
    renderProductReadinessPanel();
}

async function loadNetworkSettings() {
    try {
        const res = await fetch(`${API_BASE}/settings/network`);
        const result = await res.json();
        if (!result.success) {
            return;
        }

        renderNetworkSettings(result.data || {});
    } catch (error) {
        console.error('Failed to load network settings:', error);
    }
}

async function saveNetworkSettings() {
    const payload = collectNetworkSettingsFromForm();

    const res = await fetch(`${API_BASE}/settings/network`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    const result = await res.json();

    if (!result.success) {
        throw new Error(result.error || '保存代理设置失败');
    }

    renderNetworkSettings(result.data || payload);

    addLog(
        result.data.enabled
            ? '代理设置已保存'
            : '🌐 代理已关闭，恢复直连请求',
        'info'
    );
}

async function loadSelfHealSettings() {
    try {
        const res = await fetch(`${API_BASE}/self-heal/settings`);
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

function populateSelfHealScenarioOptions(options = []) {
    const select = document.getElementById('selfHealScenario');
    if (!select) {
        return;
    }

    const currentValue = select.value;
    const items = Array.isArray(options) ? options : [];
    if (items.length === 0) {
        select.innerHTML = '<option value="api_501_burst">流量自动化识别被拦截</option>';
        return;
    }

    select.innerHTML = items.map(item => `
        <option value="${escapeHtml(item.value || '')}">${escapeHtml(item.label || item.value || '')}</option>
    `).join('');

    if (currentValue && items.some(item => item.value === currentValue)) {
        select.value = currentValue;
    }
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

function renderRuntimeMode(summary = {}, mode = 'unknown') {
    const banner = document.getElementById('runtimeModeBanner');
    if (!banner) {
        return;
    }

    const normalizedMode = String(mode || '').toLowerCase();
    const isPreview = normalizedMode === 'preview';
    document.body.classList.toggle('runtime-preview', isPreview);
    document.body.classList.toggle('runtime-full', normalizedMode === 'full');

    const modeLabel = isPreview ? '预览' : (normalizedMode === 'full' ? '完整' : mode);
    banner.innerHTML = `
        <strong>${escapeHtml(summary.title || `当前模式：${mode}`)}</strong>
        <span class="runtime-preview-notice">${escapeHtml(modeLabel)}</span>
    `;
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
                <div class="mini-note">${item.blockingReason ? `原因：${escapeHtml(item.blockingReason)}` : '正常'}</div>
            </article>
        `;
    }).join('');
}

async function loadGlobalAgentDashboard() {
    const banner = document.getElementById('globalAgentStatusBanner');
    if (banner) setStatusBannerState(banner, '正在刷新三链路和全局 Agent 状态...', 'info');
    try {
        const [agentResp, chainsResp] = await Promise.all([
            fetch(`${API_BASE}/global-agent/status`),
            fetch(`${API_BASE}/test-chains/status`)
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
    if (!banner) return;
    const modeLabel = ({ enabled: '已启用', dry_run: '预演模式', disabled: '未启用' }[agent.mode]) || agent.mode || '未知';
    const availableCount = chains.summary?.availableCount ?? Object.values(chains.chains || {}).filter(item => item.available).length;
    const best = chains.bestChain ? `，推荐链路：${chains.chains?.[chains.bestChain]?.label || chains.bestChain}` : '';
    const tone = agent.mode === 'enabled' ? 'success' : (agent.mode === 'dry_run' ? 'warn' : 'warn');
    setStatusBannerState(banner, `全局 Agent：${modeLabel}；可用链路 ${availableCount || 0} 条${best}`, tone);
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
        || '检查三条链路，选择当前最合适的链路做一次小规模验证';
    if (out) out.value = '正在生成计划...';
    const res = await fetch(`${API_BASE}/global-agent/actions/plan`, {
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
    const res = await fetch(`${API_BASE}/global-agent/actions/execute`, {
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
    const container = document.getElementById('pageCollectionModes');
    if (!container) {
        return;
    }

    container.innerHTML = modes.map((mode) => `
        <div class="mode-option ${mode.recommended ? 'recommended' : ''}">
            <strong>${escapeHtml(mode.name)}${mode.recommended ? '（推荐）' : ''}</strong>
        </div>
    `).join('');
}

function updatePageCollectionModeHint() {
    const select = document.getElementById('pageCollectionMode');
    const banner = document.getElementById('pageModeStatus');
    if (!select || !banner) {
        return;
    }

    if (select.value === 'page-assisted') {
        setStatusBannerState(banner, '人工辅助', 'warn');
    } else {
        setStatusBannerState(banner, '自动下滑识别', 'success');
    }
}

function renderSelfHealSettings(data = {}) {
    selfHealConfig = data || {};
    const signals = data.failureSignals || {};

    const setChecked = (id, value) => {
        const el = document.getElementById(id);
        if (el) el.checked = Boolean(value);
    };
    const setValue = (id, value, fallback = '') => {
        const el = document.getElementById(id);
        if (el) el.value = value ?? fallback;
    };

    setChecked('selfHealEnabled', data.enabled);
    setChecked('autoFallbackEnabled', data.autoFallbackEnabled);
    setChecked('autoTemplateSwitch', data.autoTemplateSwitch);
    setChecked('autoProxyRotate', data.autoProxyRotate);
    setChecked('autoUaRotate', data.autoUaRotate);
    setChecked('autoRefreshLearning', data.autoRefreshLearning);
    setChecked('resumeFromBreakpoint', data.resumeFromBreakpoint);
    setValue('maxAttemptsPerRun', data.maxAttemptsPerRun, 3);
    setValue('manualEscalationThreshold', data.manualEscalationThreshold, 3);
    setValue('stallMinutes', signals.stallMinutes, 8);
    setValue('fail501Threshold', signals.fail501Threshold, 2);
    setValue('emptyResponseThreshold', signals.emptyResponseThreshold, 1);
    setValue('parseEmptyThreshold', signals.parseEmptyThreshold, 1);

    populateSelfHealScenarioOptions(data.scenarios || config?.selfHeal?.scenarios || []);
    setStatusBannerState(
        document.getElementById('selfHealStatus'),
        `${data.summary || '排查策略已更新'}${data.updatedAt ? ` ｜ 最近保存：${data.updatedAt}` : ''}`,
        data.enabled ? 'success' : 'warn'
    );
}

function collectSelfHealSettingsFromForm() {
    return {
        enabled: Boolean(document.getElementById('selfHealEnabled')?.checked),
        autoFallbackEnabled: Boolean(document.getElementById('autoFallbackEnabled')?.checked),
        autoTemplateSwitch: Boolean(document.getElementById('autoTemplateSwitch')?.checked),
        autoProxyRotate: Boolean(document.getElementById('autoProxyRotate')?.checked),
        autoUaRotate: Boolean(document.getElementById('autoUaRotate')?.checked),
        autoRefreshLearning: Boolean(document.getElementById('autoRefreshLearning')?.checked),
        resumeFromBreakpoint: Boolean(document.getElementById('resumeFromBreakpoint')?.checked),
        maxAttemptsPerRun: Math.max(1, Math.floor(Number(document.getElementById('maxAttemptsPerRun')?.value) || 3)),
        manualEscalationThreshold: Math.max(1, Math.floor(Number(document.getElementById('manualEscalationThreshold')?.value) || 3)),
        failureSignals: {
            fail501Threshold: Math.max(1, Math.floor(Number(document.getElementById('fail501Threshold')?.value) || 2)),
            emptyResponseThreshold: Math.max(1, Math.floor(Number(document.getElementById('emptyResponseThreshold')?.value) || 1)),
            parseEmptyThreshold: Math.max(1, Math.floor(Number(document.getElementById('parseEmptyThreshold')?.value) || 1)),
            stallMinutes: Math.max(1, Math.floor(Number(document.getElementById('stallMinutes')?.value) || 8))
        }
    };
}

async function saveSelfHealSettings() {
    const payload = collectSelfHealSettingsFromForm();
    const res = await fetch(`${API_BASE}/self-heal/settings`, {
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
        const res = await fetch(`${API_BASE}/self-heal/runs`);
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
    const container = document.getElementById('selfHealLog');
    if (!container) {
        return;
    }

    if (!Array.isArray(runs) || runs.length === 0) {
        container.innerHTML = '';
        return;
    }

    container.innerHTML = runs.map(run => {
        const tone = run.status === 'recoverable'
            ? 'success'
            : run.status === 'manual_required'
                ? 'error'
                : 'info';
        const scope = run.scheduleName
            ? `${escapeHtml(run.scheduleName)}`
            : `${escapeHtml(getPlatformName(run.platform || DEFAULT_PLATFORM_ID))}`;

        return `
            <div class="log-entry ${tone}">
                <div class="timestamp">${escapeHtml(run.createdAt || '')}</div>
                <div><strong>${escapeHtml(run.title || '排查演练')}</strong> · ${scope}</div>
                <div>${escapeHtml(run.summary || '')}</div>
            </div>
        `;
    }).join('');
}

function renderSelfHealPlan(diagnosis = null) {
    const container = document.getElementById('selfHealPlan');
    if (!container) {
        return;
    }

    latestSelfHealDiagnosis = diagnosis || null;
    if (!diagnosis) {
        container.innerHTML = '';
        return;
    }

    const header = `
        <div class="self-heal-step">
            <strong>${escapeHtml(diagnosis.title || '当前能力排查建议')}</strong>
            <span>${escapeHtml(diagnosis.summary || diagnosis.message || '')}${diagnosis.execution?.message ? ` ${escapeHtml(diagnosis.execution.message)}` : ''}</span>
        </div>
        <div class="action-row" style="margin-top:0;">
            <button class="btn btn-primary" type="button" onclick="applyLatestSelfHealPlan()">执行当前能力修复</button>
            <button class="btn btn-secondary" type="button" onclick="clearSelfHealPlan()">清空方案</button>
        </div>
    `;

    const steps = Array.isArray(diagnosis.repairPlan) ? diagnosis.repairPlan : [];
    const diagnostics = Array.isArray(diagnosis.capabilityDiagnostics)
        ? diagnosis.capabilityDiagnostics
        : [];
    const diagnosticHtml = diagnostics.map((item, index) => `
        <div class="self-heal-step">
            <strong>检查 ${index + 1} · ${escapeHtml(item.label || item.fixCode || '能力检查')}</strong>
            <span>${escapeHtml(item.message || '')}${item.status ? `（${escapeHtml(item.status)}）` : ''}</span>
        </div>
    `).join('');
    container.innerHTML = header + diagnosticHtml + steps.map((item, index) => `
        <div class="self-heal-step">
            <strong>步骤 ${index + 1} · ${escapeHtml(item.title || item.code || '恢复动作')}</strong>
            <span>${escapeHtml(item.description || '')}${item.automatic === false ? '（需人工处理）' : ''}</span>
        </div>
    `).join('');
}

function renderNetworkSettings(data = {}) {
    const provider = data.providerProxy || {};
    const enabledEl = document.getElementById('networkProxyEnabled');
    const autoCityEl = document.getElementById('autoCityProxyEnabled');
    const defaultProxyEl = document.getElementById('networkDefaultProxyUrl');
    const providerEnabledEl = document.getElementById('providerProxyEnabled');
    const providerApiEl = document.getElementById('providerProxyApiUrl');
    const providerTtlEl = document.getElementById('providerProxyTtl');
    const providerAuthHeaderEl = document.getElementById('providerProxyAuthHeader');
    const providerAuthTokenEl = document.getElementById('providerProxyAuthToken');
    const statusEl = document.getElementById('networkProxyStatus');

    if (enabledEl) enabledEl.checked = Boolean(data.enabled);
    if (autoCityEl) autoCityEl.checked = Boolean(data.autoCityProxyEnabled);
    if (defaultProxyEl) defaultProxyEl.value = data.defaultProxyUrl || data.proxyUrl || '';
    renderCityProxyPool(data.cityProxyPool || []);
    if (providerEnabledEl) providerEnabledEl.checked = Boolean(provider.enabled);
    if (providerApiEl) providerApiEl.value = provider.apiUrl || '';
    if (providerTtlEl) providerTtlEl.value = String(Math.max(1, Math.floor(Number(provider.ttlMinutes) || 10)));
    if (providerAuthHeaderEl) providerAuthHeaderEl.value = provider.authHeader || '';
    if (providerAuthTokenEl) providerAuthTokenEl.value = provider.authToken || '';

    if (statusEl) {
        if (!data.enabled) {
            statusEl.textContent = '当前未启用代理';
            return;
        }

        const cityCount = Array.isArray(data.cityProxyPool)
            ? data.cityProxyPool.filter(item => item?.enabled !== false && item?.proxyUrl).length
            : 0;
        const defaultProxyUrl = data.defaultProxyUrl || data.proxyUrl || '';
        const parts = [
            '代理已启用',
            data.autoCityProxyEnabled ? `城市代理 ${cityCount} 条` : '城市自动匹配关闭',
            defaultProxyUrl ? `默认 ${maskProxyUrl(defaultProxyUrl)}` : '默认直连',
            provider.enabled ? '代理商 API 已启用' : '代理商 API 关闭'
        ];
        statusEl.textContent = parts.join(' ｜ ');
    }
}

function collectNetworkSettingsFromForm() {
    return {
        enabled: Boolean(document.getElementById('networkProxyEnabled')?.checked),
        defaultProxyUrl: document.getElementById('networkDefaultProxyUrl')?.value?.trim() || '',
        autoCityProxyEnabled: Boolean(document.getElementById('autoCityProxyEnabled')?.checked),
        cityProxyPool: collectCityProxyPoolFromRows(),
        providerProxy: {
            enabled: Boolean(document.getElementById('providerProxyEnabled')?.checked),
            apiUrl: document.getElementById('providerProxyApiUrl')?.value?.trim() || '',
            authHeader: document.getElementById('providerProxyAuthHeader')?.value?.trim() || '',
            authToken: document.getElementById('providerProxyAuthToken')?.value?.trim() || '',
            ttlMinutes: Math.max(1, Math.floor(Number(document.getElementById('providerProxyTtl')?.value) || 10))
        }
    };
}

function renderCityProxyPool(pool = []) {
    const container = document.getElementById('cityProxyPoolRows');
    if (!container) {
        return;
    }

    container.innerHTML = '';
    const rows = Array.isArray(pool) && pool.length > 0
        ? pool
        : [{ enabled: true, province: '', city: '', proxyUrl: '' }];
    rows.forEach(item => appendCityProxyRow(item));
}

function appendCityProxyRow(item = {}) {
    const container = document.getElementById('cityProxyPoolRows');
    if (!container) {
        return;
    }

    const row = document.createElement('div');
    row.className = 'proxy-pool-row';
    row.innerHTML = `
        <input class="city-proxy-province" type="text" placeholder="省份" value="${escapeHtml(item.province || '')}">
        <input class="city-proxy-city" type="text" placeholder="城市" value="${escapeHtml(item.city || '')}">
        <input class="city-proxy-url" type="password" autocomplete="off" placeholder="http://user:pass@host:port" value="${escapeHtml(item.proxyUrl || '')}">
        <label class="inline-field" style="padding:8px 10px;">
            <input class="city-proxy-enabled" type="checkbox" ${item.enabled === false ? '' : 'checked'}>
            <span>启用</span>
        </label>
        <button class="btn btn-secondary city-proxy-remove" type="button">删除</button>
    `;
    row.querySelector('.city-proxy-remove')?.addEventListener('click', () => {
        row.remove();
        const remaining = container.querySelectorAll('.proxy-pool-row');
        if (remaining.length === 0) {
            appendCityProxyRow();
        }
    });
    container.appendChild(row);
}

function collectCityProxyPoolFromRows() {
    return Array.from(document.querySelectorAll('#cityProxyPoolRows .proxy-pool-row'))
        .map(row => ({
            enabled: Boolean(row.querySelector('.city-proxy-enabled')?.checked),
            province: row.querySelector('.city-proxy-province')?.value?.trim() || '',
            city: row.querySelector('.city-proxy-city')?.value?.trim() || '',
            proxyUrl: row.querySelector('.city-proxy-url')?.value?.trim() || ''
        }))
        .filter(item => item.province || item.city || item.proxyUrl);
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
        const res = await fetch(`${API_BASE}/outbound/status?limit=${encodeURIComponent(limit)}`);
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
        const res = await fetch(`${API_BASE}/outbound/evidence/recent?limit=${encodeURIComponent(limit)}`);
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

function getCaptureEvidenceLimit() {
    const raw = Number(document.getElementById('captureEvidenceLimit')?.value || 100);
    if (!Number.isFinite(raw) || raw <= 0) {
        return 100;
    }
    return Math.max(1, Math.min(1000, Math.floor(raw)));
}

function renderCaptureStatus(data = {}) {
    captureStatusSnapshot = data;
    setElementText('captureProxyEnabled', data.proxyEnabled ? '开启' : '关闭');
    setElementText('captureDefaultProxy', data.defaultProxyUrl || '直连');
    setElementText('captureCityProxyCount', String(Number(data.cityProxyPoolCount) || 0));

    const evidenceDirEl = document.getElementById('captureEvidenceDir');
    if (evidenceDirEl) {
        evidenceDirEl.textContent = data.evidenceDir ? '证据已保存' : '';
    }

    const scopeText = [
        data.proxyEnabled ? '代理配置已启用' : '代理配置未启用',
        data.defaultProxyUrl ? `默认代理 ${data.defaultProxyUrl}` : '默认直连',
        data.autoCityProxyEnabled ? `城市代理 ${Number(data.cityProxyPoolCount) || 0} 条` : '城市匹配关闭',
        data.providerProxyEnabled ? '代理商 API 开启' : '代理商 API 关闭',
        '仅场站/油站模板 API 使用配置代理'
    ].join(' ｜ ');
    setStatusBannerState(
        document.getElementById('captureScopeStatus'),
        scopeText,
        data.proxyEnabled ? 'success' : 'warn'
    );

    if (Array.isArray(data.recentEvidence) && data.recentEvidence.length > 0 && captureEvidenceRows.length === 0) {
        updateCaptureLatestEvidence(data.recentEvidence);
    }
    renderProductReadinessPanel();
}

function updateCaptureLatestEvidence(rows = []) {
    const latest = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
    setElementText('captureLatestEvidenceAt', latest?.createdAt ? formatTime(latest.createdAt) : '-');
}

function normalizeSecurityReportStatus(value) {
    const key = String(value || '').trim().toLowerCase();
    const labels = {
        partial: '部分通过',
        passed: '已通过',
        success: '已通过',
        failed: '失败',
        pending: '待处理',
        'pending-retest': '待复测',
        draft: '草稿',
        complete: '完整',
        incomplete: '不完整',
        unknown: '未知'
    };
    return labels[key] || String(value || '').trim();
}

function normalizeRiskLevelLabel(value) {
    const key = String(value || '').trim().toLowerCase();
    const labels = {
        critical: '严重',
        high: '高',
        medium: '中',
        low: '低',
        none: '无',
        unknown: '未知'
    };
    return labels[key] || String(value || '未知').trim();
}

function normalizeEvidenceCompletenessLabel(value) {
    const key = String(value || '').trim().toLowerCase();
    const labels = {
        complete: '完整',
        full: '完整',
        partial: '部分完整',
        incomplete: '不完整',
        pending: '待补齐',
        unknown: '未知'
    };
    return labels[key] || String(value || '未知').trim();
}

function getSecurityReportId(report = {}) {
    return String(report.reportId || report.id || '').trim();
}

function getSecurityReportTargetName(report = {}) {
    if (report.target && typeof report.target === 'object') {
        return report.target.name || report.targetName || '';
    }
    return report.target || report.targetName || '';
}

function getSecurityReportScope(report = {}) {
    if (report.scope) {
        return report.scope;
    }
    if (report.target && typeof report.target === 'object') {
        return report.target.scope || '';
    }
    return '';
}

function getSecurityReportMethods(report = {}) {
    const methods = Array.isArray(report.methods) ? report.methods : [];
    return methods.map(item => {
        if (typeof item === 'string') {
            return item;
        }
        return item?.name || item?.id || '';
    }).filter(Boolean);
}

function getSecurityReportCities(report = {}) {
    const target = report.target && typeof report.target === 'object' ? report.target : {};
    const cities = Array.isArray(target.cities) ? target.cities : [];
    return cities.join('、') || getSecurityReportScope(report);
}

function getSecurityReportExecutor(report = {}) {
    const executor = report.executor;
    if (!executor) {
        return report.owner || '-';
    }
    if (typeof executor === 'string') {
        return executor;
    }
    return executor.name || executor.role || '-';
}

function getSecurityReportDownloadUrl(report = {}, format = 'markdown') {
    const id = getSecurityReportId(report);
    const downloads = report.downloads || {};
    const directUrl = downloads[format] || (format === 'markdown' ? downloads.md : '');
    if (directUrl) {
        const withSanitize = directUrl.includes('sanitize=')
            ? directUrl
            : `${directUrl}${directUrl.includes('?') ? '&' : '?'}sanitize=true`;
        if (/^https?:\/\//i.test(directUrl)) {
            return withSanitize;
        }
        if (directUrl.startsWith('/')) {
            const apiBaseUrl = new URL(API_BASE, window.location.origin);
            return apiBaseUrl.origin === window.location.origin
                ? withSanitize
                : `${apiBaseUrl.origin}${withSanitize}`;
        }
        return withSanitize;
    }
    return `${API_BASE}/blue-team/reports/${encodeURIComponent(id)}/download?format=${encodeURIComponent(format)}&sanitize=true`;
}

function normalizeSecurityReport(rawReport = {}, source = securityReportSource) {
    const id = getSecurityReportId(rawReport);
    const title = rawReport.title || rawReport.reportName || id || '未命名报告';
    const targetName = getSecurityReportTargetName(rawReport) || '-';
    const scope = getSecurityReportScope(rawReport) || '-';
    const riskLevelLabel = rawReport.riskLevelLabel || normalizeRiskLevelLabel(rawReport.riskLevel);
    const statusText = rawReport.status
        || rawReport.retest?.statusLabel
        || normalizeSecurityReportStatus(rawReport.retestStatus || rawReport.overallStatus)
        || '-';
    const evidenceCompletenessLabel = normalizeEvidenceCompletenessLabel(rawReport.evidenceCompleteness);
    const methodNames = getSecurityReportMethods(rawReport);

    return {
        ...rawReport,
        id,
        reportId: id,
        title,
        reportName: rawReport.reportName || title,
        targetName,
        scope,
        riskLevelLabel,
        statusText,
        evidenceCompletenessLabel,
        methodText: methodNames.join(' / ') || rawReport.method || '-',
        cityText: getSecurityReportCities(rawReport) || '-',
        executorText: getSecurityReportExecutor(rawReport),
        source
    };
}

function getFallbackSecurityReports() {
    return SECURITY_REPORTS.map(report => normalizeSecurityReport(report, 'fallback')).filter(report => report.id);
}

function getSecurityReportItems() {
    return securityReportItems.length > 0 ? securityReportItems : getFallbackSecurityReports();
}

function setSecurityReportStatus(message, tone = 'warn') {
    securityReportStatusMessage = message;
    securityReportStatusTone = tone;
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
        throw new Error(`${fallbackMessage}：接口返回非 JSON`);
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
        const response = await fetch(`${API_BASE}/blue-team/reports`);
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
    const response = await fetch(`${API_BASE}/blue-team/reports/${encodeURIComponent(id)}`);
    const data = await readSecurityReportApiResponse(response, '报告详情读取失败');
    const report = normalizeSecurityReport(data, 'api');
    securityReportDetailCache.set(report.id, report);
    return report;
}

function getSecurityReportById(reportId) {
    const reports = getSecurityReportItems();
    return securityReportDetailCache.get(reportId)
        || reports.find(report => report.id === reportId)
        || reports[0]
        || normalizeSecurityReport(SECURITY_REPORTS[0], 'fallback');
}

function getSecurityReportEvidenceStats() {
    const rows = Array.isArray(captureEvidenceRows) ? captureEvidenceRows : [];
    const successCount = rows.filter(row => row?.success).length;
    const failedCount = rows.filter(row => row && !row.success).length;
    const latest = rows.find(row => row?.createdAt) || null;
    const chains = new Set(rows.map(row => row?.chain || row?.evidenceType).filter(Boolean));
    return {
        total: rows.length,
        successCount,
        failedCount,
        latestAt: latest?.createdAt || '',
        chainCount: chains.size
    };
}

function renderSecurityReportList() {
    const listEl = document.getElementById('securityReportList');
    if (!listEl) {
        return;
    }

    const stats = getSecurityReportEvidenceStats();
    setStatusBannerState(
        document.getElementById('securityReportsSourceStatus'),
        securityReportStatusMessage,
        securityReportStatusTone
    );
    listEl.innerHTML = getSecurityReportItems().map(report => {
        const latestText = stats.latestAt ? `最近证据：${formatTime(stats.latestAt)}` : '最近证据：暂无';
        return `
            <button class="security-report-row" type="button" data-report-id="${escapeHtml(report.id)}">
                <span>${escapeHtml(formatTime(report.createdAt))}</span>
                <span class="report-row-title">
                    <strong>${escapeHtml(report.title)}</strong>
                    <small>${escapeHtml(report.targetName)} / ${escapeHtml(report.scope)}</small>
                </span>
                <span>风险等级：${escapeHtml(report.riskLevelLabel)}</span>
                <span>${escapeHtml(report.statusText)}<br><small>${escapeHtml(latestText)}</small></span>
                <span class="report-row-action">查看详情</span>
            </button>
        `;
    }).join('');
    renderProductReadinessPanel();
}

function renderReportField(label, value, hint = '') {
    return `
        <div class="report-field">
            <span>${escapeHtml(label)}</span>
            <strong>${escapeHtml(value || '-')}</strong>
            <small>${escapeHtml(hint || '-')}</small>
        </div>
    `;
}

function getRuntimeEnvironmentLabel() {
    const host = String(window.location.hostname || '').trim();
    if (!host || host === 'localhost' || host === '127.0.0.1' || host === '::1') {
        return '本地环境';
    }
    return '部署环境';
}

function renderReadinessCheckRow(label, value, hint = '', tone = '') {
    const badgeClass = tone ? ` ${tone}` : '';
    return `
        <div class="readiness-check-row">
            <strong>${escapeHtml(label)}</strong>
            <small>${escapeHtml(hint || '-')}</small>
            <span class="report-badge${badgeClass}">${escapeHtml(value || '-')}</span>
        </div>
    `;
}

function isPendingStatus(value) {
    const text = String(value || '').toLowerCase();
    return Boolean(text.includes('待') || text.includes('partial') || text.includes('pending') || text.includes('部分'));
}

function renderProductReadinessPanel() {
    const statusEl = document.getElementById('productReadinessStatus');
    const gridEl = document.getElementById('productReadinessGrid');
    const checklistEl = document.getElementById('productReadinessChecklist');
    if (!statusEl || !gridEl || !checklistEl) {
        return;
    }

    const reports = getSecurityReportItems();
    const report = getSecurityReportById(activeSecurityReportId);
    const stats = getSecurityReportEvidenceStats();
    const apiConnected = securityReportSource === 'api';
    const recorderKnown = captureRecorderSnapshot !== null;
    const recorderAvailable = Boolean(captureRecorderSnapshot?.available);
    const retestText = report.retest?.statusLabel || normalizeSecurityReportStatus(report.retestStatus);
    const retestPending = isPendingStatus(retestText || report.conclusion || report.overallStatus);
    const envLabel = getRuntimeEnvironmentLabel();
    const aiEnabled = isAiFeaturesEnabled();
    const currentHost = String(window.location.host || '-');
    const reportCountText = `${reports.length} 份报告`;
    const evidenceText = stats.total > 0
        ? `${stats.total} 条请求证据，成功 ${stats.successCount}，失败 ${stats.failedCount}`
        : '暂无请求证据';
    const recorderText = recorderKnown
        ? (recorderAvailable ? '请求记录服务可用' : '请求记录服务不可用')
        : '请求记录状态待加载';
    const summaryTone = !apiConnected || retestPending || !recorderAvailable ? 'warn' : 'success';
    const summaryText = apiConnected
        ? `当前报告来自后端接口，${evidenceText}。${retestPending ? '仍需完成复测闭环。' : '复测闭环已满足。'}`
        : `当前使用本地样例兜底，${evidenceText}。需接入后端报告接口后再验收。`;

    setStatusBannerState(statusEl, summaryText, summaryTone);
    gridEl.innerHTML = [
        renderReportField(
            '产品视角',
            apiConnected ? '报告流可用' : '样例兜底',
            `${reportCountText} / ${report.evidenceCompletenessLabel || '-'}`
        ),
        renderReportField(
            '用户视角',
            stats.total > 0 ? '可查证据' : '待补证据',
            `列表、详情、下载${apiConnected ? '已接后端' : '使用样例'}`
        ),
        renderReportField(
            '研发视角',
            `${envLabel} / ${apiConnected ? 'API 已通' : 'API 未通'}`,
            `${recorderText} / AI ${aiEnabled ? '已启用' : '计划态'}`
        )
    ].join('');

    checklistEl.innerHTML = [
        renderReadinessCheckRow(
            '报告归档',
            apiConnected ? '已接入' : '待接入',
            `${report.title || '-'} / ${reportCountText}`,
            apiConnected ? 'success' : 'warn'
        ),
        renderReadinessCheckRow(
            '证据链',
            stats.total > 0 ? '有数据' : '待补齐',
            evidenceText,
            stats.total > 0 ? 'success' : 'warn'
        ),
        renderReadinessCheckRow(
            '复测闭环',
            retestText || '-',
            report.conclusion || normalizeSecurityReportStatus(report.overallStatus) || '-',
            retestPending ? 'warn' : 'success'
        ),
        renderReadinessCheckRow(
            '部署环境',
            envLabel,
            envLabel === '本地环境'
                ? '当前为本地验收'
                : `当前访问 ${currentHost}`,
            envLabel === '本地环境' ? 'warn' : 'success'
        ),
        renderReadinessCheckRow(
            'AI / 手机指令',
            aiEnabled ? 'AI 已启用' : '规则解析',
            aiEnabled ? 'DCC/AI 可参与解析' : 'AI 未启用，手机指令走内置规则解析',
            aiEnabled ? 'success' : 'warn'
        )
    ].join('');
}

function getReportBadgeTone(value) {
    const text = String(value || '').toLowerCase();
    if (text.includes('fail') || text.includes('error') || text.includes('不完整') || text.includes('失败')) {
        return 'error';
    }
    if (text.includes('partial') || text.includes('pending') || text.includes('待') || text.includes('部分')) {
        return 'warn';
    }
    return '';
}

function renderSecurityReportSummary(report) {
    const grid = document.getElementById('securityReportSummaryGrid');
    if (!grid) {
        return;
    }
    const target = report.target && typeof report.target === 'object' ? report.target : {};
    const retestText = report.retest?.statusLabel || normalizeSecurityReportStatus(report.retestStatus);
    const methodHint = Array.isArray(report.methods)
        ? report.methods.map(item => normalizeSecurityReportStatus(item?.status)).filter(Boolean).join(' / ')
        : '-';
    grid.innerHTML = [
        renderReportField('报告编号', report.id, report.source === 'api' ? '后端接口' : '本地样例'),
        renderReportField('测试对象', report.targetName, target.businessLine || target.platform || '-'),
        renderReportField('测试方式', report.methodText, methodHint || '-'),
        renderReportField('城市范围', report.cityText, target.radiusKm ? `${target.radiusKm}km` : report.scope),
        renderReportField('测试结论', report.conclusion || normalizeSecurityReportStatus(report.overallStatus), retestText || '-'),
        renderReportField('风险等级', report.riskLevelLabel, report.riskLevel || '-'),
        renderReportField('证据完整性', report.evidenceCompletenessLabel, report.evidenceCompleteness || '-'),
        renderReportField('任务来源', report.executorText, report.owner || '-')
    ].join('');
}

function renderSecurityReportStatusRow(report) {
    const row = document.getElementById('securityReportStatusRow');
    if (!row) {
        return;
    }
    const badges = [
        `结论：${report.conclusion || normalizeSecurityReportStatus(report.overallStatus) || '-'}`,
        `证据：${report.evidenceCompletenessLabel}`,
        `范围：${report.scope || '-'}`,
        `复测：${report.retest?.statusLabel || normalizeSecurityReportStatus(report.retestStatus) || '-'}`
    ];
    row.innerHTML = badges.map(label => {
        const tone = getReportBadgeTone(label);
        return `<span class="report-badge${tone ? ` ${tone}` : ''}">${escapeHtml(label)}</span>`;
    }).join('');
}

function getFindingEvidenceText(finding = {}) {
    if (Array.isArray(finding.evidenceRefs) && finding.evidenceRefs.length > 0) {
        return finding.evidenceRefs.map(item => {
            if (typeof item === 'string') {
                return item;
            }
            return item?.label || item?.type || '';
        }).filter(Boolean).join(' / ');
    }
    const reproductionRefs = Array.isArray(finding.reproduction?.evidenceRefs) ? finding.reproduction.evidenceRefs : [];
    return reproductionRefs.map(item => item?.label || item?.type || '').filter(Boolean).join(' / ') || '-';
}

function renderSecurityReportFindings(report) {
    const list = document.getElementById('securityReportFindingsList');
    if (!list) {
        return;
    }
    const findings = Array.isArray(report.findings) ? report.findings : [];
    if (findings.length === 0) {
        list.innerHTML = '<div class="finding-card"><p>暂无风险发现。</p></div>';
        return;
    }
    list.innerHTML = findings.map(finding => {
        const severity = String(finding.severity || '').toLowerCase();
        const severityClass = ['high', 'medium', 'low'].includes(severity) ? severity : 'medium';
        const title = [finding.id, finding.title].filter(Boolean).join(' ');
        const status = finding.retestStatus || finding.status || '-';
        const statusLabel = status === 'pending' ? '待复测' : normalizeSecurityReportStatus(status) || status;
        const evidence = getFindingEvidenceText(finding);
        return `
            <div class="finding-card">
                <header>
                    <span class="severity-chip ${escapeHtml(severityClass)}">${escapeHtml(finding.severityLabel || normalizeRiskLevelLabel(finding.severity))}</span>
                    <h3>${escapeHtml(title || '未命名发现')}</h3>
                </header>
                <p><strong>状态：</strong>${escapeHtml(statusLabel)}。<strong>证据：</strong>${escapeHtml(evidence)}。</p>
            </div>
        `;
    }).join('');
}

function renderSecurityReportEvidenceMatrix(report) {
    const body = document.getElementById('securityReportEvidenceMatrixBody');
    if (!body) {
        return;
    }
    const rows = Array.isArray(report.evidenceMatrix) ? report.evidenceMatrix : [];
    if (rows.length === 0) {
        body.innerHTML = '<tr><td colspan="3" style="text-align:center; padding:32px;">暂无证据矩阵。</td></tr>';
        return;
    }
    body.innerHTML = rows.map(row => `
        <tr>
            <td>${escapeHtml(row.type || row.evidenceType || '-')}</td>
            <td>${escapeHtml(normalizeEvidenceCompletenessLabel(row.status) || normalizeSecurityReportStatus(row.status) || row.status || '-')}</td>
            <td>${escapeHtml(row.purpose || (Array.isArray(row.refs) ? row.refs.join(' / ') : row.refs) || '-')}</td>
        </tr>
    `).join('');
}

function renderSecurityReportRetest(report) {
    const grid = document.getElementById('securityReportRetestGrid');
    if (!grid) {
        return;
    }
    const criteria = Array.isArray(report.retest?.criteria) ? report.retest.criteria : [];
    const methods = Array.isArray(report.methods) ? report.methods : [];
    const fields = [
        renderReportField('复测状态', report.retest?.statusLabel || normalizeSecurityReportStatus(report.retestStatus), report.retest?.status || '-'),
        renderReportField('测试方式', report.methodText, methods.map(item => normalizeSecurityReportStatus(item?.status)).filter(Boolean).join(' / ') || '-'),
        renderReportField('入库 / 归档', report.files?.json || 'report.json', report.files?.markdown || 'report.md'),
        renderReportField('复测标准', criteria[0] || '可复核', criteria.slice(1).join('；') || '待确认')
    ];
    grid.innerHTML = fields.join('');
}

function renderSecurityReportDownloads(report) {
    const markdownBtn = document.getElementById('downloadSecurityReportMarkdownBtn');
    const jsonBtn = document.getElementById('downloadSecurityReportJsonBtn');
    if (markdownBtn) {
        markdownBtn.href = getSecurityReportDownloadUrl(report, 'markdown');
    }
    if (jsonBtn) {
        jsonBtn.href = getSecurityReportDownloadUrl(report, 'json');
    }
}

function renderSecurityReportDetailHeader(reportId = activeSecurityReportId, detailStatusMessage = '', detailStatusTone = '') {
    const report = getSecurityReportById(reportId);
    const stats = getSecurityReportEvidenceStats();
    const evidenceText = stats.total > 0
        ? `原始请求证据 ${stats.total} 条，成功 ${stats.successCount} 条，失败 ${stats.failedCount} 条，链路 ${stats.chainCount} 类`
        : '原始请求证据暂无数据';
    setElementText('securityReportDetailTitle', report.title);
    setElementText(
        'securityReportDetailMeta',
        `${formatTime(report.createdAt)} ｜ ${report.targetName} ｜ ${report.scope} ｜ ${evidenceText}`
    );
    renderSecurityReportSummary(report);
    renderSecurityReportStatusRow(report);
    renderSecurityReportFindings(report);
    renderSecurityReportEvidenceMatrix(report);
    renderSecurityReportRetest(report);
    renderSecurityReportDownloads(report);
    setStatusBannerState(
        document.getElementById('securityReportDetailStatus'),
        detailStatusMessage || (report.source === 'api' ? '报告详情已加载' : '报告详情使用本地样例。'),
        detailStatusTone || (report.source === 'api' ? 'success' : 'warn')
    );
    renderProductReadinessPanel();
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
    renderSecurityReportList();
    const listView = document.getElementById('securityReportListView');
    const detailView = document.getElementById('securityReportDetailView');
    if (detailView) detailView.hidden = true;
    if (listView) listView.hidden = false;
}

async function loadCaptureRecorderStatus() {
    const statusEl = document.getElementById('captureRecorderStatus');
    if (!statusEl) {
        return;
    }
    try {
        const res = await fetch(`${API_BASE}/capture-recorder/status`);
        const result = await res.json();
        if (!result.success) {
            throw new Error(result.error || '请求记录服务状态读取失败');
        }
        renderCaptureRecorderStatus(result.data || {});
    } catch (error) {
        captureRecorderSnapshot = null;
        setStatusBannerState(statusEl, `请求记录服务状态读取失败：${error.message}`, 'error');
        renderProductReadinessPanel();
    }
}

function renderCaptureRecorderStatus(data = {}) {
    captureRecorderSnapshot = data;
    const active = data.activeSession || null;
    const latestSession = active || data.recentSessions?.[0] || null;
    const stats = latestSession?.stats || null;
    const diagnostics = latestSession?.logDiagnostics || null;
    setElementText('captureRecorderAvailable', data.available ? '可用' : '未安装');
    setElementText('captureRecorderEndpoint', data.available ? '就绪' : '未启动');
    setElementText('captureRecorderSession', active ? '运行中' : '未运行');
    setElementText('captureRecorderOutput', latestSession?.harPath ? '已生成记录' : '无记录');
    setElementText('captureRecorderRequestCount', formatCaptureStatCount(stats?.requestCount));
    setElementText('captureRecorderRecordedCount', formatCaptureStatCount(stats?.recordedCount));
    setElementText('captureRecorderFilteredCount', formatCaptureStatCount(stats?.filteredCount));
    setElementText('captureRecorderBlockedCount', formatCaptureStatCount(stats?.blockedCount));
    setElementText('captureRecorderErrorCount', formatCaptureStatCount(stats?.errorCount));
    const filters = active?.filters || data.defaultFilters || {};
    const filterText = formatCaptureFilters(filters);
    const statsText = formatCaptureStats(stats, Boolean(active), diagnostics);
    const tone = resolveCaptureRecorderTone(data, active, stats, diagnostics);

    const text = active
        ? `请求记录中 ${active.listenHost}:${active.listenPort} ${filterText} ${statsText}`
        : data.available
            ? `可启动 ${filterText} ${statsText}`
            : '未检测到 请求记录服务，请安装 mitmproxy 或配置 CAPTURE_RECORDER_BIN。';
    setStatusBannerState(
        document.getElementById('captureRecorderStatus'),
        text,
        tone
    );
    renderProductReadinessPanel();
}

function formatCaptureStatCount(value) {
    return Number.isFinite(Number(value)) ? String(Number(value)) : '-';
}

function formatCaptureStats(stats = null, active = false, diagnostics = null) {
    const tlsErrorCount = Number(diagnostics?.tlsHandshakeErrorCount) || 0;
    const proxyConnectCount = Number(diagnostics?.clientConnectCount) || 0;
    const diagnosticText = diagnostics?.proxyTrafficSeen
        ? `代理连接 ${proxyConnectCount}，TLS失败 ${tlsErrorCount}。`
        : '';

    if (tlsErrorCount > 0) {
        return `${diagnosticText}客户端未信任请求记录证书，最近目标 ${diagnostics?.lastServerHost || '-'}。`;
    }

    if (!stats || typeof stats !== 'object') {
        return active ? '尚未收到请求记录统计。' : '最近会话暂无请求记录统计。';
    }

    const requestCount = Number(stats.requestCount) || 0;
    const recordedCount = Number(stats.recordedCount) || 0;
    const filteredCount = Number(stats.filteredCount) || 0;
    const blockedCount = Number(stats.blockedCount) || 0;
    const errorCount = Number(stats.errorCount) || 0;
    const baseText = `统计：接收 ${requestCount}，记录 ${recordedCount}，过滤 ${filteredCount}，拦截 ${blockedCount}，错误 ${errorCount}。${diagnosticText}`;

    if (requestCount <= 0) {
        return diagnostics?.proxyTrafficSeen
            ? `${baseText}代理有连接但未形成可解密 flow。`
            : `${baseText}当前代理入口还没有收到请求。`;
    }
    if (recordedCount <= 0 && filteredCount > 0) {
        return `${baseText}已有请求进入代理，但都被过滤项排除。`;
    }
    if (blockedCount > 0 && recordedCount <= 0 && blockedCount >= requestCount) {
        return `${baseText}请求已被访问策略拦截，不写入 请求记录。`;
    }
    if (blockedCount > 0 && recordedCount > 0) {
        return `${baseText}已拦截部分干扰流量。`;
    }
    if (recordedCount <= 0 && errorCount > 0) {
        return `${baseText}已有请求进入代理，但存在连接或证书错误。`;
    }
    if (recordedCount <= 0) {
        return `${baseText}已有请求进入代理，但尚未形成可写入 请求记录 的响应。`;
    }
    return baseText;
}

function resolveCaptureRecorderTone(data = {}, active = null, stats = null, diagnostics = null) {
    if (!data.available) {
        return 'error';
    }
    if (Number(diagnostics?.tlsHandshakeErrorCount) > 0) {
        return 'error';
    }
    if (!stats || typeof stats !== 'object') {
        return active ? 'warn' : 'warn';
    }
    const requestCount = Number(stats.requestCount) || 0;
    const recordedCount = Number(stats.recordedCount) || 0;
    const errorCount = Number(stats.errorCount) || 0;
    if (requestCount <= 0 || recordedCount <= 0 || errorCount > 0) {
        return 'warn';
    }
    return 'success';
}

function formatCaptureFilters(filters = {}) {
    const hosts = Array.isArray(filters.hosts) ? filters.hosts : [];
    const ips = Array.isArray(filters.ips) ? filters.ips : [];
    if (hosts.length === 0 && ips.length === 0) {
        return ' 当前未设置过滤项，将记录全部可解密流量。';
    }
    return ` 当前过滤：域名 ${hosts.join(', ') || '-'}；IP ${ips.join(', ') || '-'}。`;
}

function splitCaptureFilterInput(value) {
    return Array.from(new Set(
        String(value || '')
            .split(/[\n,，;；|\s]+/)
            .map(item => item.trim())
            .filter(Boolean)
    ));
}

function getCaptureFilters(hostInputId, ipInputId) {
    return {
        hosts: splitCaptureFilterInput(document.getElementById(hostInputId)?.value || ''),
        ips: splitCaptureFilterInput(document.getElementById(ipInputId)?.value || '')
    };
}

function getMethod2CaptureFilters() {
    return getCaptureFilters('method2CaptureHostFilter', 'method2CaptureIpFilter');
}

function getManualCaptureRecorderFilters() {
    return getCaptureFilters('captureRecorderHostFilter', 'captureRecorderIpFilter');
}

async function startCaptureRecorder() {
    const filters = getManualCaptureRecorderFilters();
    const res = await fetch(`${API_BASE}/capture-recorder/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'manual-capture-center', filters })
    });
    const result = await res.json();
    if (!result.success) {
        throw new Error(result.error || '请求记录服务启动失败');
    }
    renderCaptureRecorderStatus({
        available: true,
        listenHost: result.data.listenHost,
        listenPort: result.data.listenPort,
        activeSession: result.data,
        recentSessions: []
    });
}

async function stopCaptureRecorder() {
    const res = await fetch(`${API_BASE}/capture-recorder/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    });
    const result = await res.json();
    if (!result.success) {
        throw new Error(result.error || '请求记录服务停止失败');
    }
    await loadCaptureRecorderStatus();
}

function getFilteredCaptureEvidenceRows() {
    const proxyFilter = document.getElementById('captureProxyFilter')?.value || '';
    const statusFilter = document.getElementById('captureStatusFilter')?.value || '';

    return captureEvidenceRows.filter(row => {
        if (proxyFilter === 'proxied' && !row?.proxy?.used) {
            return false;
        }
        if (proxyFilter === 'direct' && row?.proxy?.used) {
            return false;
        }
        if (statusFilter === 'success' && !row?.success) {
            return false;
        }
        if (statusFilter === 'failed' && row?.success) {
            return false;
        }
        return true;
    });
}

function renderCaptureEvidenceTable() {
    const tableBody = document.getElementById('captureEvidenceTableBody');
    if (!tableBody) {
        return;
    }

    const rows = getFilteredCaptureEvidenceRows();
    if (rows.length === 0) {
        tableBody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:32px;">暂无匹配证据</td></tr>';
        return;
    }

    tableBody.innerHTML = rows.map(row => {
        const statusTone = row.success ? 'success' : 'error';
        const statusText = row.success ? '成功' : '失败';
        const statusCode = row.statusCode ? ` ${row.statusCode}` : '';
        const errorText = row.error?.message || row.error?.code || '-';
        return `
            <tr>
                <td><span class="time-text">${escapeHtml(formatTime(row.createdAt))}</span></td>
                <td>
                    <div class="source-stack">
                        <span class="source-chip">${escapeHtml(row.chain || row.evidenceType || '-')}</span>
                        <span class="source-stage">${escapeHtml(row.platform || '-')} / ${escapeHtml(row.reason || '-')}</span>
                    </div>
                </td>
                <td>${renderCaptureTarget(row)}</td>
                <td>${renderCaptureProxy(row.proxy || {})}</td>
                <td><span class="chain-badge ${statusTone}">${statusText}${escapeHtml(statusCode)}</span></td>
                <td>${escapeHtml(row.durationMs ?? '-')} ms</td>
                <td><span class="source-stage">${escapeHtml(errorText)}</span></td>
            </tr>
        `;
    }).join('');
}

function renderCaptureTarget(row = {}) {
    const location = row.targetLocation || {};
    const locationText = [
        location.province,
        location.city,
        location.district,
        location.keyword
    ].filter(Boolean).join(' / ');
    const hostPath = [row.targetHost || '', row.targetPath || ''].filter(Boolean).join('');
    const method = row.method || 'GET';
    return `
        <div class="capture-target">
            <strong>${escapeHtml(method)} ${escapeHtml(hostPath || row.url || '-')}</strong>
            <span>${escapeHtml(locationText || '-')}</span>
        </div>
    `;
}

function renderCaptureProxy(proxy = {}) {
    const used = Boolean(proxy.used);
    const label = used ? (proxy.label || proxy.type || '代理') : '直连';
    const tone = used ? 'success' : 'warn';
    return `
        <div class="capture-proxy">
            <span class="chain-badge ${tone}">${escapeHtml(label)}</span>
            <code>${escapeHtml(proxy.proxyUrl || '-')}</code>
        </div>
    `;
}

function exportCaptureEvidence() {
    const rows = getFilteredCaptureEvidenceRows();
    const blob = new Blob([JSON.stringify(rows, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `outbound-evidence-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
}

function maskProxyUrl(proxyUrl) {
    const raw = String(proxyUrl || '').trim();
    if (!raw) {
        return '';
    }

    try {
        const url = new URL(raw);
        if (url.username) url.username = '***';
        if (url.password) url.password = '***';
        return url.toString();
    } catch (error) {
        return raw.replace(/\/\/([^:@/]+):([^@/]+)@/, '//***:***@');
    }
}

function normalizeRunQuotaStats(data = null) {
    if (!data || typeof data !== 'object') {
        return null;
    }

    const unlimited = Boolean(data.unlimited) || data.limit === null;
    const limit = unlimited ? null : Math.max(0, Number(data.limit) || 0);
    return {
        limit,
        unlimited,
        used: Math.max(0, Number(data.used) || 0),
        success: Math.max(0, Number(data.success) || 0),
        fail501: Math.max(0, Number(data.fail501) || 0),
        remaining: data.remaining === null || data.remaining === undefined
            ? null
            : Math.max(0, Number(data.remaining) || 0),
        quotaMode: data.quotaMode || '',
        targetCount: Math.max(0, Number(data.targetCount) || 0),
        perTargetLimit: data.perTargetLimit === null || data.perTargetLimit === undefined
            ? null
            : Math.max(0, Number(data.perTargetLimit) || 0)
    };
}

function formatRunQuotaLimit(limit, unlimited = false) {
    return unlimited || limit === null ? '无上限' : String(limit);
}

function formatRunQuotaUsage(runQuota = {}) {
    const used = Math.max(0, Number(runQuota.used) || 0);
    return `${used}/${formatRunQuotaLimit(runQuota.limit, runQuota.unlimited)}`;
}

function getCrawlerPerRunLimitFromInput() {
    if (document.getElementById('crawlerUnlimitedRunInput')?.checked) {
        return null;
    }

    const rawValue = document.getElementById('crawlerRunLimitInput')?.value?.trim() || '';
    if (!rawValue) {
        return null;
    }

    const raw = Number(rawValue);
    if (!Number.isFinite(raw) || raw <= 0) {
        return undefined;
    }
    return Math.floor(raw);
}

function renderCrawlerRunQuotaStats(data = {}, runQuota = null) {
    const limitInput = document.getElementById('crawlerRunLimitInput');
    const unlimitedInput = document.getElementById('crawlerUnlimitedRunInput');
    const statsEl = document.getElementById('crawlerRunQuotaStats');
    const perRunUnlimited = Boolean(data.perRunUnlimited) || data.perRunLimit === null;
    const perRunLimit = perRunUnlimited ? null : Math.max(1, Math.floor(Number(data.perRunLimit ?? data.limit) || 100));
    const normalizedRunQuota = normalizeRunQuotaStats(runQuota || crawlerCurrentRunStats) || {
        limit: perRunLimit,
        unlimited: perRunUnlimited,
        used: 0,
        success: 0,
        fail501: 0
    };

    if (limitInput) {
        limitInput.value = perRunUnlimited ? '' : String(perRunLimit);
        limitInput.disabled = perRunUnlimited;
    }
    if (unlimitedInput) {
        unlimitedInput.checked = perRunUnlimited;
    }

    if (statsEl) {
        const total = Math.max(0, Number(data.totalRequests) || 0);
        const success = Math.max(0, Number(data.successRequests) || 0);
        const fail501 = Math.max(0, Number(data.fail501Requests) || 0);
        const date = data.date ? `（${data.date}）` : '';
        statsEl.innerHTML = `
            <div class="quota-chip"><strong>${total}</strong><span>今日请求${escapeHtml(date)}</span></div>
            <div class="quota-chip"><strong>${success}</strong><span>今日成功</span></div>
            <div class="quota-chip"><strong>${fail501}</strong><span>签名验证失败</span></div>
            <div class="quota-chip"><strong>${escapeHtml(formatRunQuotaUsage(normalizedRunQuota))}</strong><span>当次上限</span></div>
        `;
    }
}

async function loadCrawlerRunQuota() {
    try {
        const res = await fetch(`${API_BASE}/crawler/run-quota`);
        const result = await res.json();
        if (!result.success) {
            return;
        }

        renderCrawlerRunQuotaStats(result.data || {}, crawlerCurrentRunStats);
    } catch (error) {
        console.error('Failed to load crawler run quota:', error);
    }
}

async function saveCrawlerRunQuota() {
    const limitInput = document.getElementById('crawlerRunLimitInput');
    const unlimited = Boolean(document.getElementById('crawlerUnlimitedRunInput')?.checked);
    const rawValue = limitInput?.value?.trim() || '';
    const rawLimit = Number(rawValue);
    if (unlimited || !rawValue) {
        const res = await fetch(`${API_BASE}/crawler/run-quota`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ unlimited: true, perRunLimit: null })
        });
        const result = await res.json();
        if (!result.success) {
            throw new Error(result.error || '保存当次最大请求次数失败');
        }

        renderCrawlerRunQuotaStats(result.data || {}, crawlerCurrentRunStats);
        addLog(`🧮 ${WORKFLOW_LABELS.automation}当次请求上限已更新为无上限`, 'info');
        return;
    }

    if (!Number.isFinite(rawLimit) || rawLimit <= 0) {
        alert('当次请求上限必须是大于 0 的数字');
        return;
    }

    const res = await fetch(`${API_BASE}/crawler/run-quota`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ perRunLimit: Math.floor(rawLimit) })
    });
    const result = await res.json();
    if (!result.success) {
        throw new Error(result.error || '保存当次最大请求次数失败');
    }

    renderCrawlerRunQuotaStats(result.data || {}, crawlerCurrentRunStats);
    addLog(`🧮 ${WORKFLOW_LABELS.automation}当次请求上限已更新为 ${result.data?.perRunLimit || Math.floor(rawLimit)}`, 'info');
}

function initMobileControlPanel() {
    renderMobileIntentExamples([
        '查看手机状态',
        '读取当前页面',
        '停止验证',
        '查询上海、北京、广州，每个城市新增100条价格/枪数快照'
    ]);
    setStatusBannerState(
        document.getElementById('mobileDccStatus'),
        '访问鉴权已关闭，正在读取指令配置...',
        'warn'
    );
    loadMobileInteractionConfig().catch(setMobileInteractionConfigError);
    loadMobileChatSession().catch(() => {});
    refreshMobileControl().catch(() => {});
}

function getMobileControlToken() {
    return '';
}

function persistMobileControlToken() {
    // 访问鉴权已关闭，不再保存控制凭证。
}

function getMobileControlHeaders() {
    return { 'Content-Type': 'application/json' };
}

async function ensureMobileControlBrowserSession() {
    return { authMode: 'disabled' };
}

async function requestMobileControl(path, options = {}) {
    persistMobileControlToken();
    await ensureMobileControlBrowserSession();
    const res = await fetch(`${API_BASE}${path}`, {
        ...options,
        credentials: 'same-origin',
        headers: {
            ...getMobileControlHeaders({ allowBrowserSession: true }),
            ...(options.headers || {})
        }
    });
    const result = await res.json();
    if (!result.success) {
        throw new Error(result.error || '手机控制请求失败');
    }
    return result.data;
}

async function loadMobileInteractionConfig() {
    const data = await requestMobileControl('/mobile-control/interaction/config');
    renderMobileIntentExamples(data.examples || []);
    renderMobileDccStatus(data.intentParser || {});
    return data;
}

function setMobileInteractionConfigError(error) {
    setStatusBannerState(
        document.getElementById('mobileDccStatus'),
        `指令解析配置读取失败：${error.message}`,
        'error'
    );
    setMobileIntentStatus(`控制配置读取失败：${error.message}`, 'error');
}

function renderMobileDccStatus(intentParser = {}) {
    const planned = Boolean(intentParser.planned || intentParser.aiFeaturesEnabled === false);
    const mode = intentParser.dccMode || (intentParser.dccConfigured ? 'dcc' : 'disabled');
    const timeoutNote = intentParser.timeoutCapped
        ? ` · 超时已限制 ${Math.round(Number(intentParser.timeoutMs || 0) / 1000)}s`
        : '';
    const label = planned
        ? (intentParser.message || 'AI 对话解析未启用，当前使用内置规则解析。')
        : intentParser.dccConfigured
        ? `DCC 已启用 · ${mode === 'cli' ? 'CLI 服务' : mode === 'http' ? 'HTTP 服务' : mode}${timeoutNote}`
        : 'DCC 未启用 · 使用内置规则解析';
    setStatusBannerState(
        document.getElementById('mobileDccStatus'),
        label,
        intentParser.dccConfigured ? 'success' : 'warn'
    );
    setMobileIntentStatus(planned ? 'AI 未启用，手机指令将走内置规则解析。' : '等待下发任务。', planned ? 'warn' : '');
    renderProductReadinessPanel();
}

function renderMobileIntentExamples(examples = []) {
    const container = document.getElementById('mobileIntentExamples');
    if (!container) {
        return;
    }
    container.innerHTML = (Array.isArray(examples) ? examples : []).map(text => `
        <button class="intent-example-chip" type="button" data-mobile-intent-example="${escapeHtml(text)}">${escapeHtml(text)}</button>
    `).join('');
    container.querySelectorAll('[data-mobile-intent-example]').forEach(button => {
        button.addEventListener('click', () => {
            const input = document.getElementById('mobileIntentInput');
            if (input) {
                input.value = button.dataset.mobileIntentExample || '';
                input.focus();
            }
        });
    });
}

function setMobileIntentStatus(message, tone = '') {
    setStatusBannerState(document.getElementById('mobileIntentStatus'), message, tone);
}

function formatMobileParseSource(value) {
    const key = String(value || '').trim().toLowerCase();
    const labels = {
        dcc: 'DCC',
        rule: '内置规则',
        'rule-ai-disabled': '内置规则',
        'rule-deterministic': '固定命令',
        'rule-fallback': '规则兜底',
        unknown: '未知'
    };
    return labels[key] || value || '未知';
}

async function submitMobileIntent(instruction) {
    const text = String(instruction || document.getElementById('mobileIntentInput')?.value || '').trim();
    if (!text) {
        alert('请输入需要下发给手机的需求');
        return;
    }
    appendMobileChatMessage({ role: 'user', content: text, createdAt: new Date().toISOString() });
    setMobileIntentStatus(`正在发送给${isAiFeaturesEnabled() ? '指令解析服务' : '内置规则解析'}...`, 'warn');
    const data = await requestMobileControl('/mobile-control/chat', {
        method: 'POST',
        body: JSON.stringify({ sessionId: mobileChatSessionId, message: text })
    });
    if (data.session?.id) {
        mobileChatSessionId = data.session.id;
        localStorage.setItem(MOBILE_CONTROL_CHAT_SESSION_KEY, mobileChatSessionId);
        renderMobileChat(data.session.messages || []);
    }
    const result = data.result || {};
    const parseSource = result.parsed?.parseSource || data.assistantMessage?.meta?.parseSource || 'unknown';
    setMobileIntentStatus(`${result.message || '需求已下发'}（解析：${formatMobileParseSource(parseSource)}）`, 'success');
    const input = document.getElementById('mobileIntentInput');
    if (!instruction && input) {
        input.value = '';
    }
    await refreshMobileControl();
}

function renderMobileChat(messages = []) {
    const container = document.getElementById('mobileChatWindow');
    if (!container) {
        return;
    }
    container.innerHTML = '';
    (Array.isArray(messages) ? messages : []).slice(-30).forEach(message => {
        appendMobileChatMessage(message, false);
    });
    container.scrollTop = container.scrollHeight;
}

function appendMobileChatMessage(message = {}, scroll = true) {
    const container = document.getElementById('mobileChatWindow');
    if (!container || !message.content) {
        return;
    }
    const role = message.role === 'user' ? 'user' : 'assistant';
    const node = document.createElement('div');
    node.className = `mobile-chat-message ${role}`;
    const meta = message.meta || {};
    const metaText = [
        meta.parseSource ? `解析 ${formatMobileParseSource(meta.parseSource)}` : '',
        meta.workflowId ? `工作流 ${meta.workflowId}` : '',
        meta.commandId ? `命令 ${meta.commandId}` : ''
    ].filter(Boolean).join(' · ');
    node.innerHTML = `
        <strong>${role === 'user' ? '你' : '指令解析'}</strong>
        <p>${escapeHtml(message.content)}</p>
        <small>${escapeHtml(metaText || message.createdAt || '')}</small>
    `;
    container.appendChild(node);
    if (scroll) {
        container.scrollTop = container.scrollHeight;
    }
}

async function loadMobileChatSession() {
    if (!mobileChatSessionId) {
        renderMobileChat([]);
        return;
    }
    try {
        const session = await requestMobileControl(`/mobile-control/chat/sessions/${encodeURIComponent(mobileChatSessionId)}`);
        renderMobileChat(session.messages || []);
    } catch (error) {
        mobileChatSessionId = '';
        localStorage.removeItem(MOBILE_CONTROL_CHAT_SESSION_KEY);
        renderMobileChat([]);
    }
}

async function refreshMobileControl() {
    const [workflows, commands, devices] = await Promise.all([
        requestMobileControl('/mobile-control/workflows'),
        requestMobileControl('/mobile-control/commands?limit=12'),
        requestMobileControl('/mobile-control/devices?limit=10').catch(() => [])
    ]);
    renderMobileWorkflows(workflows || []);
    renderMobileCommands(commands || []);
    renderMobileOverview(workflows || [], commands || [], devices || []);
}

function renderMobileOverview(workflows = [], commands = [], devices = []) {
    const container = document.getElementById('mobileOverviewTiles');
    if (!container) {
        return;
    }
    const safeWorkflows = Array.isArray(workflows) ? workflows : [];
    const safeCommands = Array.isArray(commands) ? commands : [];
    const runningWorkflow = safeWorkflows.find(workflow => workflow.status === 'running');
    const activeCommand = safeCommands.find(command => ['pending', 'running'].includes(command.status));
    const latestCommand = safeCommands[0] || null;
    const latestDevice = Array.isArray(devices) ? devices[0] : null;
    const deviceStatus = findLatestDeviceStatus(safeCommands) || latestDevice;
    const deviceOnline = Boolean(deviceStatus?.commandServiceRunning);

    const tiles = [
        {
            label: '设备状态',
            value: deviceStatus ? (deviceOnline ? '在线' : '已连接') : '待刷新',
            detail: deviceStatus
                ? `${deviceStatus.currentPackageName || '-'} · 可见文本 ${deviceStatus.visibleTextRowCount ?? 0}`
                : '点击“刷新设备状态”获取手机端状态'
        },
        {
            label: '当前任务',
            value: runningWorkflow ? `新增 ${runningWorkflow.progress?.completed || 0}/${runningWorkflow.progress?.total || 0}` : (activeCommand ? formatCommandType(activeCommand.type) : '空闲'),
            detail: runningWorkflow
                ? `城市 ${runningWorkflow.cities?.join('、') || '-'} · 剩余 ${runningWorkflow.progress?.remaining ?? 0}`
                : (activeCommand ? formatMobileStatus(activeCommand.status) : '暂无执行中的任务')
        },
        {
            label: '同步通道',
            value: deviceStatus?.deviceSessionId ? '已认证' : (deviceStatus?.serverUrl ? '已配置' : '待确认'),
            detail: deviceStatus?.serverUrl
                ? `${deviceStatus.serverUrl}${deviceStatus.relayNode ? ` · ${deviceStatus.relayNode}` : ''}`
                : '手机端未建立认证会话'
        },
        {
            label: '最近动作',
            value: latestCommand ? formatCommandType(latestCommand.type) : '暂无',
            detail: latestCommand ? `${formatMobileStatus(latestCommand.status)} · ${latestCommand.updatedAt || latestCommand.createdAt || '-'}` : '暂无手机指令'
        }
    ];

    container.innerHTML = tiles.map(tile => `
        <div class="mobile-overview-tile">
            <span>${escapeHtml(tile.label)}</span>
            <strong>${escapeHtml(tile.value)}</strong>
            <small>${escapeHtml(tile.detail)}</small>
        </div>
    `).join('');
}

function findLatestDeviceStatus(commands = []) {
    for (const command of commands) {
        const result = command?.result && typeof command.result === 'object' ? command.result : null;
        if (!result) {
            continue;
        }
        if (result.deviceStatus && typeof result.deviceStatus === 'object') {
            return result.deviceStatus;
        }
        if (result.deviceId || result.serverUrl || result.commandServiceRunning !== undefined) {
            return result;
        }
    }
    return null;
}

function renderMobileWorkflows(workflows = []) {
    const container = document.getElementById('mobileWorkflowList');
    if (!container) {
        return;
    }
    container.innerHTML = '';
    (Array.isArray(workflows) ? workflows : []).slice(0, 8).forEach(workflow => {
        const card = document.createElement('div');
        card.className = 'task-progress-card';
        const cities = Array.isArray(workflow.cities) ? workflow.cities : [];
        const cityIndex = Number(workflow.currentCityIndex) || 0;
        const currentCity = cities[cityIndex] || '';
        const targetText = cities.map(city => {
            const stats = workflow.currentStats?.[city] || {};
            const baseline = Number(stats.baselineRecords ?? workflow.baselines?.[city]?.total ?? 0);
            const added = Number(stats.addedSnapshots ?? stats.addedRecords ?? 0);
            const targetIncrement = Number(stats.targetIncrement ?? workflow.targetIncrement ?? 0);
            const distinct = Number(stats.distinct ?? workflow.baselines?.[city]?.distinct ?? 0);
            return `${city} 新增 ${added}/${targetIncrement}（当前快照 ${baseline + added}，去重场站 ${distinct}）`;
        }).join(' ｜ ');
        const progress = workflow.progress || {};
        const percent = Math.max(0, Math.min(100, Number(progress.percent) || 0));
        card.innerHTML = `
            <div class="task-progress-head">
                <div class="task-progress-title">${escapeHtml(cities.join('、') || workflow.id || '-')}</div>
                <div class="task-progress-status ${escapeHtml(workflow.status || '')}">${escapeHtml(formatMobileStatus(workflow.status))}</div>
            </div>
            <div class="task-progress-bar">
                <span class="task-progress-seg success" style="width:${percent}%;"></span>
            </div>
            <div class="task-progress-metrics">
                <div class="task-progress-metric"><strong>${escapeHtml(progress.completed ?? 0)}</strong><span>已新增快照</span></div>
                <div class="task-progress-metric"><strong>${escapeHtml(progress.remaining ?? 0)}</strong><span>剩余</span></div>
                <div class="task-progress-metric"><strong>${escapeHtml(currentCity || '完成')}</strong><span>当前城市</span></div>
                <div class="task-progress-metric"><strong>${escapeHtml(formatLandmarkCursor(workflow.landmarkCursor || {}))}</strong><span>地标游标</span></div>
            </div>
            <div class="task-progress-meta">
                <span>每城新增快照 ${escapeHtml(workflow.targetIncrement || 0)}</span>
                <span>${escapeHtml(targetText || '暂无目标')}</span>
            </div>
            ${workflow.error ? `<div class="meta-hint" style="color:var(--danger);">${escapeHtml(workflow.error)}</div>` : ''}
        `;
        container.appendChild(card);
    });
}

function renderMobileCommands(commands = []) {
    const container = document.getElementById('mobileCommandList');
    if (!container) {
        return;
    }
    container.innerHTML = '';
    (Array.isArray(commands) ? commands : []).slice(0, 12).forEach(command => {
        const entry = document.createElement('div');
        const tone = command.status === 'succeeded'
            ? 'success'
            : command.status === 'failed' || command.status === 'aborted'
                ? 'error'
                : command.status === 'running'
                    ? 'warn'
                    : 'info';
        entry.className = `mobile-command-card ${tone}`;
        const payload = command.payload && typeof command.payload === 'object' ? command.payload : {};
        const summary = [payload.city, payload.keyword, payload.instruction].filter(Boolean).join(' ｜ ');
        const resultSummary = summarizeCommandResult(command);
        entry.innerHTML = `
            <div class="mobile-command-title">
                <span>${escapeHtml(formatCommandType(command.type))}</span>
                <span class="mobile-status-chip ${escapeHtml(command.status || '')}">${escapeHtml(formatMobileStatus(command.status))}</span>
            </div>
            <div class="meta-hint">${escapeHtml(command.updatedAt || command.createdAt || '')}</div>
            ${summary ? `<div class="meta-hint">${escapeHtml(summary)}</div>` : ''}
            ${resultSummary ? `<div class="meta-hint">${escapeHtml(resultSummary)}</div>` : ''}
            ${command.error ? `<div class="meta-hint" style="color:var(--danger);">${escapeHtml(command.error)}</div>` : ''}
        `;
        container.appendChild(entry);
    });
}

function summarizeCommandResult(command = {}) {
    const result = command.result && typeof command.result === 'object' ? command.result : null;
    if (!result) {
        return '';
    }
    if (result.message) {
        return result.message;
    }
    if (result.rowCount !== undefined) {
        return `识别 ${result.rowCount} 行可见文本`;
    }
    if (result.city || result.keyword) {
        return [result.city, result.keyword, result.timedOut ? '已超时停止' : '执行完成'].filter(Boolean).join(' ｜ ');
    }
    const status = result.deviceStatus || result;
    if (status.currentPackageName || status.visibleTextRowCount !== undefined) {
        return `${status.currentPackageName || '-'} · 可见文本 ${status.visibleTextRowCount ?? 0}`;
    }
    return '';
}

function formatCommandType(type) {
    return {
        status: '设备状态',
        collect_visible_text: '读取页面',
        collect_landmark: '验证地标',
        stop_collection: '停止验证',
        start_text_collection: '启动验证',
        open_app: '打开应用',
        back: '返回',
        scroll: '下滑',
        tap: '点击',
        click_text: '点击文字',
        set_text: '输入文本',
        ime_replace_text: '输入文本'
    }[String(type || '')] || String(type || '未知动作');
}

function formatMobileStatus(status) {
    return {
        pending: '待执行',
        running: '执行中',
        succeeded: '已完成',
        success: '已完成',
        failed: '失败',
        aborted: '已中止'
    }[String(status || '')] || String(status || '未知');
}

function formatLandmarkCursor(cursor = {}) {
    const entries = Object.entries(cursor || {});
    if (entries.length === 0) {
        return '-';
    }
    return entries.map(([city, value]) => `${city}:${value}`).join(' ');
}

function getAvailablePlatformIds(platforms = null) {
    const source = Array.isArray(platforms)
        ? platforms
        : (Array.isArray(config?.platforms) ? config.platforms : []);
    const ids = source.map(item => item?.id).filter(Boolean);
    if (ids.length > 0) {
        return ids;
    }
    return Array.from(document.querySelectorAll('.platform-card[data-id]'))
        .map(card => card.dataset.id)
        .filter(Boolean);
}

function ensureSelectedPlatforms(options = {}) {
    const availableIds = getAvailablePlatformIds(options.platforms);
    const validIds = new Set(availableIds);
    const selectedCardIds = Array.from(document.querySelectorAll('.platform-card.selected[data-id]'))
        .map(card => card.dataset.id)
        .filter(Boolean);
    const merged = []
        .concat(Array.isArray(selectedPlatforms) ? selectedPlatforms : [])
        .concat(selectedCardIds)
        .filter(Boolean)
        .filter(id => validIds.size === 0 || validIds.has(id));

    selectedPlatforms = Array.from(new Set(merged));

    if (selectedPlatforms.length === 0) {
        if (validIds.has(DEFAULT_PLATFORM_ID)) {
            selectedPlatforms = [DEFAULT_PLATFORM_ID];
        } else if (availableIds.length > 0) {
            selectedPlatforms = [availableIds[0]];
        } else {
            selectedPlatforms = [DEFAULT_PLATFORM_ID];
        }
    }

    if (options.sync !== false) {
        syncPlatformCardSelection();
    } else {
        updateSelectedPlatformSummary();
    }

    return selectedPlatforms;
}

// 渲染平台列表
function renderPlatforms(platforms) {
    const list = Array.isArray(platforms) ? platforms : [];
    ensureSelectedPlatforms({ platforms: list, sync: false });

    const containers = Array.from(document.querySelectorAll('[data-platform-list], #platformList'));
    containers.forEach(container => {
        container.innerHTML = list.map(p => `
            <div class="platform-card ${selectedPlatforms.includes(p.id) ? 'selected' : ''}" data-id="${p.id}">
                <h3>${p.name}</h3>
                <div class="status">${selectedPlatforms.includes(p.id) ? '已选中' : '点击选择'}</div>
            </div>
        `).join('');
    });

    document.querySelectorAll('.platform-card').forEach(card => {
        card.addEventListener('click', () => {
            const id = card.dataset.id;

            if (selectedPlatforms.includes(id)) {
                selectedPlatforms = selectedPlatforms.filter(p => p !== id);
            } else {
                selectedPlatforms.push(id);
            }

            syncPlatformCardSelection();
        });
    });

    syncPlatformCardSelection();
}

function syncPlatformCardSelection() {
    document.querySelectorAll('.platform-card').forEach(card => {
        const id = card.dataset.id;
        const selected = selectedPlatforms.includes(id);
        card.classList.toggle('selected', selected);
        const statusEl = card.querySelector('.status');
        if (statusEl) {
            statusEl.textContent = selected ? '已选中' : '点击选择';
        }
    });

    updateSelectedPlatformSummary();
}

// 渲染平台筛选器
function renderPlatformFilter(platforms) {
    const select = document.getElementById('platformFilter');
    select.innerHTML = '<option value="">所有平台</option>' +
        platforms.map(p => `<option value="${p.id}">${p.name}</option>`).join('');
}

// 加载统计数据
async function loadStats() {
    try {
        const res = await fetch(`${API_BASE}/stats`);
        const { data } = await res.json();
        const platformStats = normalizePlatformStats(data || []);
        updateOverviewDataMetrics(platformStats);
        
        const statsHtml = platformStats.map(stat => `
            <div class="stat-card">
                <h4>${getPlatformName(stat.platform)}</h4>
                <div class="value">${stat.unique_stations}</div>
                <div style="font-size: 12px; opacity: 0.8; margin-top: 5px;">
                    ${stat.total_records} 条记录
                </div>
            </div>
        `).join('');
        
        document.getElementById('statsContainer').innerHTML = statsHtml || 
            '<div style="text-align: center; padding: 40px;">暂无数据</div>';
    } catch (error) {
        console.error('Failed to load stats:', error);
    }
}

// 加载数据
async function loadData() {
    try {
        const platform = document.getElementById('platformFilter')?.value || '';
        const url = platform 
            ? `${API_BASE}/stations/recent?platform=${platform}&limit=300`
            : `${API_BASE}/stations/recent?limit=300`;
        
        const res = await fetch(url);
        const { data } = await res.json();
        
        const tbody = document.getElementById('dataTableBody');
        
        if (data.length === 0) {
            tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; padding: 40px;">暂无数据</td></tr>';
            return;
        }
        
        tbody.innerHTML = data.map(rawRow => {
            const row = normalizeStationRecord(rawRow);
            return `
                <tr>
                    <td><span class="platform-chip">${escapeHtml(getPlatformName(row.platform))}</span></td>
                    <td><div class="station-name">${escapeHtml(row.station_name || '-')}</div></td>
                    <td><div class="station-address">${escapeHtml(row.address || '-')}</div></td>
                    <td>${renderPriceSummary(row)}</td>
                    <td>${renderAvailabilitySummary(row)}</td>
                    <td>${renderSourceSummary(row)}</td>
                    <td><span class="time-text">${escapeHtml(formatTime(row.price_gun_snapshot_at || row.snapshot_at || row.collected_at))}</span></td>
                </tr>
            `;
        }).join('');
    } catch (error) {
        console.error('Failed to load data:', error);
    }
}

// 加载定时任务
async function loadSchedules() {
    try {
        const res = await fetch(`${API_BASE}/schedules`);
        const { data } = await res.json();
        
        const tbody = document.getElementById('scheduleList');
        
        if (data.length === 0) {
            tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; padding: 20px;">暂无任务</td></tr>';
            return;
        }
        
        tbody.innerHTML = data.map(schedule => {
            const platforms = parseJsonArray(schedule.platforms);
            const selfHealEnabled = Boolean(schedule.self_heal_enabled);
            return `
                <tr>
                    <td>${escapeHtml(schedule.name || '')}</td>
                    <td><code>${escapeHtml(schedule.cron_expression || '')}</code></td>
                    <td>${escapeHtml(platforms.map(getPlatformName).join(', '))}</td>
                    <td>
                        <span class="self-heal-chip ${selfHealEnabled ? '' : 'off'}">${selfHealEnabled ? '自动排查已启用' : '自动排查已关闭'}</span>
                        <div class="recovery-text">${escapeHtml(schedule.self_heal_summary || '-')}</div>
                    </td>
                    <td>
                        <div>${escapeHtml(schedule.last_recovery_status || '未执行')}</div>
                        <div class="recovery-text">${escapeHtml(schedule.last_recovery_summary || '尚未生成恢复记录')}</div>
                        ${schedule.last_recovery_at ? `<div class="recovery-text">${escapeHtml(schedule.last_recovery_at)}</div>` : ''}
                    </td>
                    <td>${schedule.enabled ? '✅ 启用' : '⏸️ 暂停'}</td>
                    <td>
                        <button class="btn btn-secondary" onclick="toggleSchedule(${schedule.id}, ${!schedule.enabled})">
                            ${schedule.enabled ? '暂停' : '启用'}
                        </button>
                        <button class="btn btn-secondary" onclick="drillSchedule(${schedule.id})">演练</button>
                        <button class="btn btn-danger" onclick="deleteSchedule(${schedule.id})">删除</button>
                    </td>
                </tr>
            `;
        }).join('');
    } catch (error) {
        console.error('Failed to load schedules:', error);
        const tbody = document.getElementById('scheduleList');
        if (tbody) {
            tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; padding: 20px;">定时任务加载失败：${escapeHtml(error.message)}</td></tr>`;
        }
    }
}

function getAutomationCities() {
    const raw = [
        document.getElementById('automationCities')?.value || '',
        document.getElementById('collectPresetCity')?.value || ''
    ]
        .filter(Boolean)
        .join('\n');

    return Array.from(new Set(
        raw
            .split(/[\n,，;；|]/)
            .map(item => item.trim())
            .filter(Boolean)
    ));
}

function getPageOcrCities() {
    const raw = [
        document.getElementById('pageOcrCities')?.value || '',
        document.getElementById('collectPresetCity')?.value || ''
    ]
        .filter(Boolean)
        .join('\n');

    return Array.from(new Set(
        raw
            .split(/[\n,，;；|]/)
            .map(item => item.trim())
            .filter(Boolean)
    ));
}

function getPageOcrScrollOptions() {
    return {
        scrollMode: 'count',
        scrollCount: parseInt(document.getElementById('pageOcrScrollCount')?.value, 10) || 10,
        scrollIntervalMin: parseInt(document.getElementById('pageOcrIntervalMin')?.value, 10) || 3000,
        scrollIntervalMax: parseInt(document.getElementById('pageOcrIntervalMax')?.value, 10) || 5000,
        pageCaptureBatchSize: 1
    };
}

function setPageOcrButtons(running) {
    const startButton = document.getElementById('startPageOcrCollect');
    const finishButton = document.getElementById('finishPageOcrCollect');
    const cancelButton = document.getElementById('cancelPageOcrCollect');

    if (startButton) startButton.style.display = running ? 'none' : 'inline-block';
    if (finishButton) finishButton.style.display = running ? 'inline-block' : 'none';
    if (cancelButton) cancelButton.style.display = running ? 'inline-block' : 'none';
}

function setCaptureCollectButtons(running) {
    const startButton = document.getElementById('startCollect');
    const finishButton = document.getElementById('finishCollect');
    const cancelButton = document.getElementById('cancelCollect');

    if (startButton) startButton.style.display = running ? 'none' : 'inline-block';
    if (finishButton) finishButton.style.display = running ? 'inline-block' : 'none';
    if (cancelButton) cancelButton.style.display = running ? 'inline-block' : 'none';
}


function formatRuntimeCheck(check = {}) {
    if (!check || typeof check !== 'object') return '未检测';
    const statusMap = {
        ready: '可用',
        running: '运行中',
        configured: '已配置',
        unknown: '未知',
        unavailable: '不可用',
        failed: '失败'
    };
    const status = statusMap[check.status] || (check.available === true ? '可用' : check.available === false ? '不可用' : '未知');
    return check.reason ? `${status} / ${formatUserReason(check.reason, { includeTech: false })}` : status;
}

function safeJson(value) {
    try {
        return JSON.stringify(value ?? {}, null, 2);
    } catch {
        return String(value ?? '');
    }
}

function renderMethod2Status(result = {}) {
    const checks = result.checks || {};
    setElementText('method2MitmdumpStatus', formatRuntimeCheck(checks.mitmdump || result.mitmdump));
    setElementText('method2RecorderStatus', formatRuntimeCheck(checks.recorder || result.recorder));
    setElementText('method2ProxyStatus', formatRuntimeCheck(checks.proxy || result.proxy));
    setElementText('method2HarStatus', formatRuntimeCheck(checks.harOutput || result.harOutput));
    const banner = document.getElementById('method2ReasonBanner');
    if (banner) {
        const tone = result.available ? 'success' : 'warn';
        setStatusBannerState(banner, `请求验证状态：${formatUserReason(result.reason || 'unknown_error', { includeTech: false })}`, tone);
    }
}

async function refreshMethod2Status() {
    const banner = document.getElementById('method2ReasonBanner');
    if (banner) setStatusBannerState(banner, '正在检查请求记录环境...', 'info');
    try {
        const res = await fetch(`${API_BASE}/method2/status`);
        const result = await res.json();
        renderMethod2Status(result);
        return result;
    } catch (error) {
        const fallback = { success: false, available: false, reason: 'unknown_error', error: error.message, checks: {} };
        renderMethod2Status(fallback);
        return fallback;
    }
}

async function startMethod2Capture() {
    const filters = getMethod2CaptureFilters();
    const banner = document.getElementById('method2ReasonBanner');
    if (banner) setStatusBannerState(banner, '正在启动请求记录...', 'info');
    const res = await fetch(`${API_BASE}/method2/start-capture`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            label: 'method2-desktop-capture',
            filterHosts: (filters.hosts || []).join(','),
            filterIps: (filters.ips || []).join(',')
        })
    });
    const result = await res.json();
    const summary = document.getElementById('method2CaptureSummary');
    if (summary) summary.value = result.success ? `状态：已启动\n请求数：${result.summary?.totalRequests || 0}` : `状态：启动失败\n原因：${formatUserReason(result.reason || 'unknown_error', { includeTech: false })}`;
    if (banner) setStatusBannerState(banner, result.success ? '请求记录已启动' : `请求记录启动失败：${formatUserReason(result.reason || 'unknown_error', { includeTech: false })}`, result.success ? 'success' : 'error');
    addLog(result.success ? '✅ 请求记录已开始' : `❌ 请求记录启动失败：${formatUserReason(result.reason || 'unknown_error', { includeTech: false })}`, result.success ? 'success' : 'error');
    await refreshMethod2Status();
    return result;
}

async function stopAnalyzeMethod2Capture() {
    const banner = document.getElementById('method2ReasonBanner');
    if (banner) setStatusBannerState(banner, '正在停止记录并分析请求...', 'info');
    const res = await fetch(`${API_BASE}/method2/stop-and-analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
    });
    const result = await res.json();
    const summary = document.getElementById('method2CaptureSummary');
    const requests = document.getElementById('method2RequestSummary');
    if (summary) summary.value = result.success ? `状态：分析完成\n目标请求数：${result.summary?.targetRequests || 0}\n总请求数：${result.summary?.totalRequests || 0}` : `状态：分析未通过\n原因：${formatUserReason(result.reason || 'unknown_error', { includeTech: false })}`;
    if (requests) requests.value = `已捕获请求数：${(result.requests || []).length}，仅展示前 20 条`;
    if (banner) setStatusBannerState(banner, result.success ? `请求分析完成：发现目标接口 ${result.summary?.targetRequests || 0} 个` : `请求分析未通过：${formatUserReason(result.reason || 'unknown_error', { includeTech: false })}`, result.success ? 'success' : 'warn');
    addLog(result.success ? '✅ 请求分析完成' : `⚠️ 请求分析未通过：${formatUserReason(result.reason || 'unknown_error', { includeTech: false })}`, result.success ? 'success' : 'warn');
    await refreshMethod2Status();
    return result;
}

function renderMethod3Status(result = {}) {
    const checks = result.checks || {};
    setElementText('method3TemplateStatus', formatRuntimeCheck(checks.templates));
    setElementText('method3CorpusStatus', formatRuntimeCheck(checks.corpus));
    setElementText('method3ProxyStatus', formatRuntimeCheck(checks.outboundProxy));
    const limits = result.limits || {};
    setElementText('method3LimitStatus', `页=${limits.maxPages ?? '-'} / 请求=${limits.maxRequestCount ?? '-'} / QPS=${limits.maxQps ?? '-'}`);
    const banner = document.getElementById('method3ReasonBanner');
    if (banner) setStatusBannerState(banner, `接口验证状态：${formatUserReason(result.reason || 'unknown_error', { includeTech: false })}`, result.available ? 'success' : 'warn');
}

function getMethod3Input() {
    ensureSelectedPlatforms();
    return {
        platform: selectedPlatforms[0] || DEFAULT_PLATFORM_ID,
        city: document.getElementById('method3City')?.value?.trim() || '上海',
        lat: Number(document.getElementById('method3Lat')?.value || 31.2304),
        lng: Number(document.getElementById('method3Lng')?.value || 121.4737),
        mode: 'list',
        maxPages: 1,
        maxRequestCount: 5,
        maxQps: 1
    };
}

async function refreshMethod3Status() {
    const banner = document.getElementById('method3ReasonBanner');
    if (banner) setStatusBannerState(banner, '正在检查接口验证环境...', 'info');
    try {
        const res = await fetch(`${API_BASE}/method3/status`);
        const result = await res.json();
        renderMethod3Status(result);
        return result;
    } catch (error) {
        const fallback = { success: false, available: false, reason: 'unknown_error', error: error.message, checks: {} };
        renderMethod3Status(fallback);
        return fallback;
    }
}

async function runMethod3Preflight() {
    const banner = document.getElementById('method3ReasonBanner');
    if (banner) setStatusBannerState(banner, '正在做运行前检查...', 'info');
    const res = await fetch(`${API_BASE}/method3/preflight`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(getMethod3Input())
    });
    const result = await res.json();
    const out = document.getElementById('method3PreflightSummary');
    if (out) out.value = result.status === 'matched' ? `状态：检查通过\n匹配请求数：${result.matchedCount || 0}` : `状态：检查未通过\n原因：${formatUserReason(result.diagnostics?.[0]?.code || result.status || 'unknown_error', { includeTech: false })}`;
    if (banner) setStatusBannerState(banner, result.status === 'matched' ? '运行前检查通过：请求材料可用' : `运行前检查未通过：${formatUserReason(result.diagnostics?.[0]?.code || result.status || 'unknown_error', { includeTech: false })}`, result.status === 'matched' ? 'success' : 'warn');
    addLog(result.status === 'matched' ? '✅ 运行前检查通过' : `⚠️ 运行前检查未通过：${formatUserReason(result.diagnostics?.[0]?.code || result.status || 'unknown_error', { includeTech: false })}`, result.status === 'matched' ? 'success' : 'warn');
    return result;
}

async function runMethod3BasicCheck() {
    const banner = document.getElementById('method3ReasonBanner');
    if (banner) setStatusBannerState(banner, '正在执行小规模接口验证...', 'info');
    const res = await fetch(`${API_BASE}/method3/run-basic-check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(getMethod3Input())
    });
    const result = await res.json();
    const out = document.getElementById('method3RunSummary');
    if (out) out.value = result.success ? `状态：验证通过\n验证数：${result.checkedCount || result.summary?.totalChecked || 0}` : `状态：验证未通过\n原因：${formatUserReason(result.reason || 'unknown_error', { includeTech: false })}`;
    if (banner) setStatusBannerState(banner, result.success ? '小规模接口验证完成' : `小规模接口验证未通过：${formatUserReason(result.reason || 'unknown_error', { includeTech: false })}`, result.success ? 'success' : 'warn');
    addLog(result.success ? '✅ 小规模接口验证完成' : `⚠️ 小规模接口验证未通过：${formatUserReason(result.reason || 'unknown_error', { includeTech: false })}`, result.success ? 'success' : 'warn');
    return result;
}

function formatMethod1Check(check = {}) {
    const status = check.status === 'ready' ? '可用' : '不可用';
    return check.reason ? `${status} / ${formatUserReason(check.reason, { includeTech: false })}` : status;
}

function renderMethod1Result(result = {}) {
    const checks = result.checks || {};
    setElementText('method1WechatWindowStatus', formatMethod1Check(checks.wechatWindow));
    setElementText('method1TargetWindowStatus', formatMethod1Check(checks.targetWindow));
    setElementText('method1ScreenshotStatus', formatMethod1Check(checks.screenshot));
    setElementText('method1OcrStatus', formatMethod1Check(checks.ocr));
    setElementText('method1ScrollStatus', result.scroll ? formatMethod1Check(result.scroll) : '未执行');

    const banner = document.getElementById('method1ReasonBanner');
    if (banner) {
        const tone = result.available ? 'success' : 'error';
        const message = result.available
            ? `页面验证可用：${formatUserReason(result.reason || 'ready', { includeTech: false })}`
            : `页面验证不可用：${formatUserReason(result.reason || 'unknown_error', { includeTech: false })}${result.error ? `；${result.error}` : ''}`;
        setStatusBannerState(banner, message, tone);
    }

    const beforeText = document.getElementById('method1BeforeText');
    const afterText = document.getElementById('method1AfterText');
    if (beforeText && result.before) {
        beforeText.value = result.before.text || (Array.isArray(result.before.textLines) ? result.before.textLines.join('\n') : '');
    } else if (beforeText && !result.before) {
        beforeText.value = '';
    }
    if (afterText && result.after) {
        afterText.value = result.after.text || (Array.isArray(result.after.textLines) ? result.after.textLines.join('\n') : '');
    } else if (afterText && !result.after) {
        afterText.value = '';
    }
}

async function refreshMethod1Status() {
    ensureSelectedPlatforms();
    const platform = selectedPlatforms[0] || DEFAULT_PLATFORM_ID;
    const banner = document.getElementById('method1ReasonBanner');
    if (banner) {
        setStatusBannerState(banner, '正在检查页面验证环境...', 'info');
    }

    try {
        const res = await fetch(`${API_BASE}/method1/status?platform=${encodeURIComponent(platform)}`);
        const result = await res.json();
        renderMethod1Result(result);
        return result;
    } catch (error) {
        const fallback = {
            success: true,
            available: false,
            reason: 'unknown_error',
            error: error.message,
            checks: {}
        };
        renderMethod1Result(fallback);
        return fallback;
    }
}

async function runMethod1BasicCheck() {
    ensureSelectedPlatforms();
    const platform = selectedPlatforms[0] || DEFAULT_PLATFORM_ID;
    const banner = document.getElementById('method1ReasonBanner');
    if (banner) {
        setStatusBannerState(banner, '正在快速验证页面能力...', 'info');
    }

    try {
        const res = await fetch(`${API_BASE}/method1/run-basic-check`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ platform })
        });
        const result = await res.json();
        renderMethod1Result(result);
        if (result.available) {
            addLog('✅ 页面快速验证完成', 'success');
        } else {
            addLog(`❌ 页面快速验证未通过：${formatUserReason(result.reason || 'unknown_error', { includeTech: false })}`, 'error');
        }
        return result;
    } catch (error) {
        const fallback = {
            success: true,
            available: false,
            reason: 'unknown_error',
            error: error.message,
            checks: {}
        };
        renderMethod1Result(fallback);
        addLog(`❌ 页面快速验证请求失败：${error.message}`, 'error');
        return fallback;
    }
}

function getMethod1Platform() {
    ensureSelectedPlatforms();
    return selectedPlatforms[0] || DEFAULT_PLATFORM_ID;
}

function setMethod1Trace(result) {
    const trace = document.getElementById('method1ActionTrace');
    if (trace) trace.value = result.success ? `状态：完成\n动作：${result.action || result.path || ''}\n结果：${formatUserReason(result.reason || 'success', { includeTech: false })}` : `状态：失败\n原因：${formatUserReason(result.reason || 'unknown_error', { includeTech: false })}`;
}

async function postMethod1Action(path, payload = {}, runningMessage = '') {
    const platform = getMethod1Platform();
    const banner = document.getElementById('method1ReasonBanner');
    if (banner && runningMessage) setStatusBannerState(banner, runningMessage, 'info');
    const res = await fetch(`${API_BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform, ...payload })
    });
    const result = await res.json();
    setMethod1Trace(result);
    if (result.capture || result.observation || result.before || result.after || result.status) {
        renderMethod1Result(result.status || result);
    }
    if (banner) {
        const ok = result.success && result.available !== false;
        setStatusBannerState(banner, ok ? `页面动作完成：${formatUserReason(result.reason || 'success', { includeTech: false })}` : `页面动作失败：${formatUserReason(result.reason || 'unknown_error', { includeTech: false })}`, ok ? 'success' : 'warn');
    }
    addLog((result.success && result.available !== false) ? `✅ 页面动作完成：${path}` : `⚠️ 页面动作失败：${formatUserReason(result.reason || 'unknown_error', { includeTech: false })}`, (result.success && result.available !== false) ? 'success' : 'warn');
    return result;
}

async function openMethod1Miniapp() {
    return postMethod1Action('/method1/open-miniapp', {}, '正在尝试打开电脑端微信小程序...');
}

async function observeMethod1Page() {
    return postMethod1Action('/method1/actions/observe', {}, '正在观察当前页面...');
}

async function scrollMethod1Once() {
    return postMethod1Action('/method1/actions/scroll', {}, '正在执行下滑...');
}

async function backMethod1Once() {
    return postMethod1Action('/method1/actions/back', {}, '正在执行返回...');
}

async function switchMethod1City() {
    const city = String(document.getElementById('method1CityInput')?.value || '').trim();
    if (!city) {
        alert('请输入目标城市');
        return null;
    }
    return postMethod1Action('/method1/actions/switch-city', { city }, `正在通过 UI 切换城市：${city}`);
}

async function tapMethod1ByText() {
    const text = String(document.getElementById('method1TapTextInput')?.value || '').trim();
    if (!text) {
        alert('请输入要点击的文字');
        return null;
    }
    return postMethod1Action('/method1/actions/tap-by-text', { text }, `正在按文字点击：${text}`);
}

async function runMethod1Adaptive() {
    return postMethod1Action('/method1/actions/run-adaptive', {
        goal: 'station_list_scroll',
        limits: { maxSteps: 20, maxScrolls: 5, maxDurationSeconds: 180 }
    }, '正在智能浏览并判断下一步操作...');
}


function summarizeFailureEvent(item = {}) {
    const event = item.failureEvent || item;
    const sourceMap = { method2: '请求验证', method3: '接口验证' };
    const source = sourceMap[event.source] || event.source || '-';
    const reason = event.error?.reason || item.reason || event.reason || 'unknown_error';
    const status = event.response?.httpStatus ? `HTTP ${event.response.httpStatus}` : '';
    const path = event.request?.path || '';
    return `${source}｜${formatUserReason(reason, { includeTech: false })}${status ? `｜${status}` : ''}${path ? `｜${path}` : ''}`;
}

function summarizeAgentAnalysis(item = {}) {
    const analysis = item.analysis || item.agentAnalysis || item;
    const diagnosis = analysis.diagnosis || {};
    const nextAction = analysis.nextAction || {};
    return `${diagnosis.category || 'unknown'}｜置信度 ${Math.round((Number(diagnosis.confidence) || 0) * 100)}%｜${diagnosis.reason || '-'}｜建议：${nextAction.reason || nextAction.action || '-'}`;
}

function summarizeStrategyPatch(item = {}) {
    const patch = item.patch || item.strategyPatch || item;
    const status = item.status || patch.status || '待处理';
    return `${patch.patchType || 'no_auto_change'}｜风险：${patch.riskLevel || '-'}｜处理方式：${patch.applyMode || 'manual_review'}｜状态：${status}`;
}

function renderAiAgentDashboard(status = {}, events = [], analyses = [], patches = []) {
    const cfg = status.config || {};
    const modeLabel = ({enabled:'已启用', dry_run:'预演模式', disabled:'未启用'}[cfg.mode]) || '未配置';
    setElementText('aiAgentMode', modeLabel);
    setElementText('aiAgentModel', cfg.configured ? '已配置' : '未配置');
    setElementText('aiAgentBaseUrl', cfg.configured ? '已配置' : '未配置');
    setElementText('aiAgentKeyStatus', cfg.configured ? '已配置' : '未配置');
    const banner = document.getElementById('aiAgentStatusBanner');
    if (banner) {
        const message = status.available
            ? `智能诊断助手已可用：${modeLabel}，失败后会生成诊断建议。`
            : `智能诊断助手不可用：${formatUserReason(status.reason || 'ai_agent_not_configured', { includeTech: false })}`;
        setStatusBannerState(banner, message, status.available ? 'success' : 'warn');
    }
    const failureEl = document.getElementById('aiAgentFailureEvents');
    if (failureEl) failureEl.value = events.length ? events.map(summarizeFailureEvent).join('\n') : '暂无失败记录。';
    const analysesEl = document.getElementById('aiAgentAnalyses');
    if (analysesEl) analysesEl.value = analyses.length ? analyses.map(summarizeAgentAnalysis).join('\n\n') : '暂无诊断结果。';
    const patchesEl = document.getElementById('aiAgentPatches');
    if (patchesEl) patchesEl.value = patches.length ? patches.map(summarizeStrategyPatch).join('\n') : '暂无待处理建议。';
}

async function loadAiAgentDashboard() {
    try {
        const [statusRes, eventsRes, analysesRes, patchesRes] = await Promise.all([
            fetch(`${API_BASE}/ai-agent/status`),
            fetch(`${API_BASE}/ai-agent/failure-events?limit=5`),
            fetch(`${API_BASE}/ai-agent/analyses?limit=5`),
            fetch(`${API_BASE}/ai-agent/patches?limit=5`)
        ]);
        const status = await statusRes.json().catch(() => ({}));
        const events = await eventsRes.json().catch(() => ({}));
        const analyses = await analysesRes.json().catch(() => ({}));
        const patches = await patchesRes.json().catch(() => ({}));
        renderAiAgentDashboard(status, events.items || [], analyses.items || [], patches.items || []);
        return status;
    } catch (error) {
        renderAiAgentDashboard({ available: false, reason: 'ai_agent_request_failed', error: error.message }, [], [], []);
        return { success: false, reason: 'ai_agent_request_failed', error: error.message };
    }
}

async function runPageOcrPreflight() {
    ensureSelectedPlatforms();
    if (selectedPlatforms.length === 0) {
        alert('请至少选择一个平台');
        return null;
    }
    const maxPlatforms = Number(config?.automation?.maxPlatformsPerSession) || 1;
    if (selectedPlatforms.length > maxPlatforms) {
        alert(`当前自动化链路一次只支持 ${maxPlatforms} 个平台，请分开执行`);
        return null;
    }

    const cities = getPageOcrCities();
    const pageCollectionMode = document.getElementById('pageCollectionMode')?.value || 'page-assisted';
    if (cities.length === 0) {
        alert('请至少配置 1 个查询城市或地标');
        return null;
    }

    addLog(`🔎 开始${WORKFLOW_LABELS.page} 页面识别检查...`, 'info');

    try {
        const res = await fetch(`${API_BASE}/page-collect/preflight`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                platforms: selectedPlatforms,
                cities,
                pageCollectionMode
            })
        });
        const result = await res.json();

        if (!result.success) {
            addLog(`❌ 页面识别检查失败: ${result.error}`, 'error');
            return null;
        }

        const data = result.data || {};
        renderPreflightChecks(data.checks || []);
        addLog(data.canStart ? `✅ 页面识别检查通过，可以启动${WORKFLOW_LABELS.page}` : '❌ 页面识别检查未通过，请先处理失败项', data.canStart ? 'success' : 'error');
        return data;
    } catch (error) {
        addLog(`❌ 页面识别检查请求失败: ${error.message}`, 'error');
        return null;
    }
}

async function startPageOcrCollection() {
    ensureSelectedPlatforms();
    if (selectedPlatforms.length === 0) {
        alert('请至少选择一个平台');
        return;
    }

    const cities = getPageOcrCities();
    const pageCollectionMode = document.getElementById('pageCollectionMode')?.value || 'page-assisted';
    if (cities.length === 0) {
        alert('请至少配置 1 个查询城市或地标');
        return;
    }

    const logContainer = document.getElementById('collectionLog');
    if (logContainer) {
        logContainer.innerHTML = '';
    }

    const preflight = await runPageOcrPreflight();
    if (!preflight || !preflight.canStart) {
        addLog(`❌ ${WORKFLOW_LABELS.page}预检未通过，已取消启动。`, 'error');
        return;
    }

    const scrollOptions = getPageOcrScrollOptions();
    addLog(`🚀 启动${WORKFLOW_LABELS.page}：${pageCollectionMode === 'page-assisted' ? '人工辅助 + 页面增量识别' : '自动下滑 + 页面识别入库'}`, 'info');
    addLog(`📦 本次平台: ${selectedPlatforms.map(getPlatformName).join('、')}`, 'info');
    addLog(`🏙️ 查询城市/地标: ${cities.join('、')}`, 'info');
    if (pageCollectionMode === 'page-assisted') {
        addLog('🤝 人工辅助模式：请在微信小程序内手动下滑，系统后台将周期截图并执行页面增量识别。', 'info');
    }
    addLog(`🔄 下滑参数: 次数=${scrollOptions.scrollCount}, 间隔=${scrollOptions.scrollIntervalMin}~${scrollOptions.scrollIntervalMax}ms，每次下滑后识别页面`, 'info');

    try {
        const res = await fetch(`${API_BASE}/page-collect/start`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                platforms: selectedPlatforms,
                cities,
                pageCollectionMode,
                ...scrollOptions
            })
        });
        const result = await res.json();

        if (result.success) {
            activeSession = {
                sessionId: result.sessionId,
                mode: 'page-ocr'
            };
            addLog(`✅ ${WORKFLOW_LABELS.page}任务已启动`, 'success');
            addLog('任务已启动', 'info');
            setPageOcrButtons(true);
            startSessionPolling();
        } else {
            addLog(`❌ ${WORKFLOW_LABELS.page}启动失败: ${result.error}`, 'error');
        }
    } catch (error) {
        addLog(`❌ ${WORKFLOW_LABELS.page}请求失败: ${error.message}`, 'error');
    }
}

// 开始验证（智能模式）
async function startCollection() {
    ensureSelectedPlatforms();
    if (selectedPlatforms.length === 0) {
        alert('请至少选择一个平台');
        return;
    }
    const maxPlatforms = Number(config?.automation?.maxPlatformsPerSession) || 1;
    if (selectedPlatforms.length > maxPlatforms) {
        alert(`当前自动化链路一次只支持 ${maxPlatforms} 个平台，请分开执行`);
        return;
    }

    const automationCities = getAutomationCities();
    if (automationCities.length === 0) {
        alert('请至少配置 1 个查询目标');
        return;
    }

    const logContainer = document.getElementById('collectionLog');
    logContainer.innerHTML = '';

    const preflight = await runCollectPreflight();
    if (!preflight || !preflight.canStart) {
        addLog('❌ 自动化预检未通过，已取消启动。请先处理失败项后再重试。', 'error');
        return;
    }

    addLog(`🚀 启动自动验证任务`, 'info');
    addLog(`📦 本次平台: ${selectedPlatforms.map(getPlatformName).join('、')}`, 'info');
    addLog(`📍 查询目标: ${automationCities.join('、')}`, 'info');
    addLog(`📡 ${WORKFLOW_LABELS.business}启动`, 'info');
    addLog('📼 请求记录启动', 'info');
    const captureFilters = getMethod2CaptureFilters();
    addLog(`🔎 请求记录过滤: ${formatCaptureFilters(captureFilters).trim()}`, 'info');

    const scrollMode = document.querySelector('input[name="scrollMode"]:checked')?.value || 'count';
    const scrollIntervalMin = parseInt(document.getElementById('scrollIntervalMin')?.value, 10) || 4000;
    const scrollIntervalMax = parseInt(document.getElementById('scrollIntervalMax')?.value, 10) || 8000;

    let scrollCount = null;
    let scrollDurationMs = null;

    if (scrollMode === 'count') {
        scrollCount = parseInt(document.getElementById('scrollCount')?.value, 10) || 10;
        addLog(`🔄 滑动参数: 模式=按次数, 次数=${scrollCount}, 间隔=${scrollIntervalMin}~${scrollIntervalMax}ms`, 'info');
    } else {
        const durationMin = parseInt(document.getElementById('scrollDurationMin')?.value, 10) || 2;
        const durationSec = parseInt(document.getElementById('scrollDurationSec')?.value, 10) || 0;
        scrollDurationMs = (durationMin * 60 + durationSec) * 1000;
        addLog(`🔄 滑动参数: 模式=按时间, 时长=${durationMin}分${durationSec}秒, 间隔=${scrollIntervalMin}~${scrollIntervalMax}ms`, 'info');
    }

    try {
        const res = await fetch(`${API_BASE}/smart-collect/start`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                platforms: selectedPlatforms,
                targets: automationCities,
                cities: automationCities,
                captureFilters,
                scrollMode,
                scrollCount,
                scrollDurationMs,
                scrollIntervalMin,
                scrollIntervalMax
            })
        });
        
        const result = await res.json();
        
        if (result.success) {
            activeSession = {
                sessionId: result.sessionId,
                mode: 'mitm'
            };
            
            addLog(`✅ 自动验证任务已启动`, 'success');
            addLog('任务已启动', 'info');



            addLog(`💡 后续将自动完成：按目标切换/搜索、点击列表并连续下滑；系统请求记录服务会自动生成并分析 请求记录`, 'success');
            
            setCaptureCollectButtons(true);
            startSessionPolling();
        } else {
            addLog(`❌ 启动失败: ${result.error}`, 'error');
        }
        
    } catch (error) {
        addLog(`❌ 请求失败: ${error.message}`, 'error');
    }
}

async function runCollectPreflight() {
    ensureSelectedPlatforms();
    if (selectedPlatforms.length === 0) {
        alert('请至少选择一个平台');
        return null;
    }
    const maxPlatforms = Number(config?.automation?.maxPlatformsPerSession) || 1;
    if (selectedPlatforms.length > maxPlatforms) {
        alert(`当前自动化链路一次只支持 ${maxPlatforms} 个平台，请分开执行`);
        return null;
    }

    const automationCities = getAutomationCities();
    if (automationCities.length === 0) {
        alert('请至少配置 1 个查询目标');
        return null;
    }

    addLog('🔎 开始自动化预检...', 'info');

    try {
        const res = await fetch(`${API_BASE}/smart-collect/preflight`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                platforms: selectedPlatforms,
                targets: automationCities,
                cities: automationCities,
                captureFilters: getMethod2CaptureFilters()
            })
        });
        const result = await res.json();

        if (!result.success) {
            addLog(`❌ 自动化预检失败: ${result.error}`, 'error');
            return null;
        }

        const data = result.data || {};
        renderPreflightChecks(data.checks || []);

        if (data.canStart) {
            addLog('✅ 自动化预检通过，可以开始验证', 'success');
        } else {
            addLog('❌ 自动化预检未通过，请先处理失败项', 'error');
        }

        return data;
    } catch (error) {
        addLog(`❌ 自动化预检请求失败: ${error.message}`, 'error');
        return null;
    }
}

function renderPreflightChecks(checks) {
    checks.forEach(check => {
        const status = String(check.status || 'info');
        const icon = status === 'pass'
            ? '✅'
            : status === 'warn'
                ? '⚠️'
                : status === 'fail'
                    ? '❌'
                    : 'ℹ️';
        const logType = status === 'pass'
            ? 'success'
            : status === 'warn'
                ? 'warn'
                : status === 'fail'
                    ? 'error'
                    : 'info';

        addLog(`${icon} ${check.label}: ${check.message}`, logType);
    });
}

async function finishCollection() {
    if (!activeSession) {
        return;
    }

    const isPageOcrMode = activeSession.mode === 'page-ocr';
    const confirmMessage = isPageOcrMode
        ? '结束识别后会停止当前自动点击/下滑，并保留已入库的 页面识别结果。确定继续吗？'
        : '结束验证后会停止当前自动点击/下滑，并由后端停止内置请求记录服务、保留 请求记录。确定继续吗？';
    if (!confirm(confirmMessage)) {
        return;
    }

    try {
        const res = await fetch(`${API_BASE}/smart-collect/finish`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: activeSession.sessionId })
        });
        const result = await res.json();
        if (result.success) {
            addLog(
                isPageOcrMode
                    ? '✅ 已发送结束识别请求，正在停止当前动作'
                    : '✅ 已发送结束验证请求，正在停止当前动作；后端正在停止内置请求记录并保留 请求记录',
                'success'
            );
            if (result.captureSession?.harPath) {
                addLog('请求记录已保存', 'info');
            }
            renderCaptureAnalysisLog(result.captureAnalysis);
        } else {
            addLog(`❌ 结束验证失败: ${result.error}`, 'error');
        }
    } catch (error) {
        addLog(`❌ 结束验证请求失败: ${error.message}`, 'error');
    }
}

// 取消验证
async function cancelCollection() {
    if (!activeSession) {
        return;
    }
    
    if (!confirm(`停止验证会立即取消本次任务，并停止当前滑动；${WORKFLOW_LABELS.business}会同步停止内置请求记录服务。确定继续吗？`)) {
        return;
    }
    
    try {
        const res = await fetch(`${API_BASE}/smart-collect/cancel`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: activeSession.sessionId })
        });
        const result = await res.json();
        
        addLog(`❌ 已发送停止验证请求，正在终止当前滑动并停止内置请求记录`, 'error');
        if (result.captureSession?.harPath) {
            addLog('请求记录已保存', 'info');
        }
        renderCaptureAnalysisLog(result.captureAnalysis);
        
    } catch (error) {
        console.error('取消失败:', error);
    }
}

function renderCaptureAnalysisLog(analysis) {
    if (!analysis) {
        return;
    }
    const fatalStatuses = new Set(['failed', 'missing-business-flow', 'parser-missed-business-flow']);
    const tone = analysis.status === 'success'
        ? 'success'
        : fatalStatuses.has(analysis.status)
            ? 'error'
            : 'warn';
    addLog(`🧪 自动请求分析: ${analysis.message || analysis.status}`, tone);
    addLog(
        `📊 流量 ${analysis.entryCount || 0} 条，场站 ${analysis.stationCount || 0} 个，入库 ${analysis.insertedCount || 0} 条，模板 ${analysis.learnedPatternCount || 0}/${analysis.savedTemplateCount || 0}`,
        tone
    );
    if (analysis.businessSignals) {
        const signals = analysis.businessSignals;
        addLog(
            `🎯 滴滴业务包: stationList ${signals.didiStationListUrlCount || 0} 条，getoneinfo ${signals.didiGetOneInfoUrlCount || 0} 条，业务响应 ${signals.didiStationBusinessBodyCount || 0} 条`,
            tone
        );
    }
    if (analysis.captureStats) {
        addLog(`📡 请求记录统计: ${formatCaptureStats(analysis.captureStats, false, analysis.captureDiagnostics)}`, tone);
    }
    if (analysis.captureHealth?.message) {
        addLog(`🩺 请求记录诊断: ${analysis.captureHealth.message}`, tone);
    }
}

function resolveManualCapturePlatform() {
    ensureSelectedPlatforms();
    if (activeSession?.currentPlatform) {
        return activeSession.currentPlatform;
    }

    if (selectedPlatforms.length === 1) {
        return selectedPlatforms[0];
    }

    if (selectedPlatforms.length === 0) {
        throw new Error('请先选择一个平台后再执行当前页面识别');
    }

    throw new Error('当前页面识别一次只支持一个平台，请只保留一个选中平台');
}

async function captureCurrentPage() {
    const platform = resolveManualCapturePlatform();
    addLog(`👀 正在识别当前 ${getPlatformName(platform)} 页面...`, 'info');
    addLog('🖼️ 后端将自动截图、识别页面并把识别结果写入数据库', 'info');

    try {
        const res = await fetch(`${API_BASE}/page-capture`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ platform, stage: 'manual' })
        });

        const result = await res.json();
        if (!result.success) {
            addLog(`❌ ${getPlatformName(platform)} 页面识别失败: ${result.error}`, 'error');
            return;
        }

        // 显示页面状态信息
        if (result.meta?.window) {
            const win = result.meta.window;
            addLog(`🪟 窗口: ${win.ownerName || '未知'} - ${win.name || '无标题'}`, 'info');
        }

        addLog(`✅ ${getPlatformName(platform)} 页面识别完成，识别 ${result.stationCount} 个场站`, 'success');

        if (Array.isArray(result.data)) {
            result.data.forEach(rawStation => {
                const station = normalizeStationRecord(rawStation);
                addLog(`📍 ${station.station_name || '未命名场站'}，${formatStationInlineSummary(station)}`, 'success');

                // 显示分时价格信息
                if (rawStation.raw?.priceSchedules && rawStation.raw.priceSchedules.length > 0) {
                    const scheduleInfo = rawStation.raw.priceSchedules.map(s =>
                        `${s.start_time}-${s.end_time}: ¥${s.price}`
                    ).join(', ');
                    addLog(`   ⏰ 分时价格: ${scheduleInfo}`, 'info');
                }
            });
        }

        loadStats();
        loadData();
    } catch (error) {
        addLog(`❌ ${getPlatformName(platform)} 页面识别请求失败: ${error.message}`, 'error');
    }
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
    const meta = document.getElementById('crawlerProgressMeta');
    if (meta) {
        meta.textContent = text;
    }
}

function clearTemplateApiProgress() {
    stopTemplateApiProgressPolling();
    const container = document.getElementById('crawlerProgressList');
    if (container) {
        container.innerHTML = '';
    }
    templateApiRenderedFinalRuns.clear();
}

function addTemplateApiLog(message, type = 'info', mirrorToCollectionLog = true) {
    if (mirrorToCollectionLog) {
        addLog(message, type);
    }
    setTemplateApiProgressMeta(String(message || ''));
}

function setTemplateApiRunning(isRunning) {
    const button = document.getElementById('crawlByCoordinatesBtn');
    if (!button) {
        return;
    }

    button.disabled = false;
    button.textContent = isRunning ? '继续新增任务' : '按坐标开始验证';
}

function stopTemplateApiProgressPolling(runId = null) {
    if (runId !== null) {
        const timer = templateApiProgressTimers.get(Number(runId));
        if (timer) {
            clearInterval(timer);
            templateApiProgressTimers.delete(Number(runId));
        }
        return;
    }

    templateApiProgressTimers.forEach(timer => clearInterval(timer));
    templateApiProgressTimers.clear();
}

function renderTemplateApiProgressCard(run) {
    if (!run) {
        return;
    }

    const container = document.getElementById('crawlerProgressList');
    if (!container) {
        return;
    }

    const result = run.resultSummary || {};
    const progress = result.progress || {};
    const quota = normalizeRunQuotaStats(result.runQuota || progress) || normalizeRunQuotaStats(crawlerCurrentRunStats) || {
        limit: progress.limit ?? null,
        unlimited: Boolean(progress.unlimited),
        used: Number(progress.used) || 0,
        success: Number(progress.success) || 0,
        fail501: Number(progress.fail501) || 0
    };
    const used = Math.max(0, Number(quota.used) || 0);
    const success = Math.max(0, Number(quota.success) || 0);
    const fail501 = Math.max(0, Number(quota.fail501) || 0);
    const other = Math.max(0, used - success - fail501);
    const limit = quota.unlimited ? null : Math.max(0, Number(quota.limit) || 0);
    const remaining = quota.unlimited ? '无上限' : String(Math.max(0, Number(quota.remaining ?? (limit - used)) || 0));
    const totalForBar = quota.unlimited ? Math.max(used, 1) : Math.max(limit, used, 1);
    const percent = value => `${Math.max(0, Math.min(100, (value / totalForBar) * 100)).toFixed(2)}%`;
    const targets = Array.isArray(result.targetLocations) ? result.targetLocations : [];
    const activeTarget = result.activeTarget || progress.activeTarget || null;
    const targetQuotaHint = quota.quotaMode === 'per-target'
        ? ` · 每目标上限 ${formatRunQuotaLimit(quota.perTargetLimit, quota.unlimited)}`
        : '';
    const targetText = activeTarget
        ? `当前：${[activeTarget.province, activeTarget.city, activeTarget.district, activeTarget.keyword || activeTarget.name].filter(Boolean).join(' / ')}`
        : targets.length > 0
            ? `目标 ${progress.completedTargetCount || 0}/${targets.length}`
            : '目标待确认';
    const status = String(run.status || progress.status || 'running');
    const statusLabel = {
        running: '执行中',
        success: '已完成',
        failed: '失败',
        aborted: '已中断'
    }[status] || status;
    const title = `Run #${run.id} · ${targetText}`;

    let card = container.querySelector(`[data-run-id="${run.id}"]`);
    if (!card) {
        card = document.createElement('div');
        card.className = 'task-progress-card';
        card.dataset.runId = run.id;
        container.prepend(card);
    }

    card.innerHTML = `
        <div class="task-progress-head">
            <div class="task-progress-title">${escapeHtml(title)}</div>
            <div class="task-progress-status ${escapeHtml(status)}">${escapeHtml(statusLabel)}</div>
        </div>
        <div class="task-progress-bar" aria-label="${WORKFLOW_LABELS.automation}执行进度">
            <div class="task-progress-seg success" style="width:${percent(success)}"></div>
            <div class="task-progress-seg fail501" style="width:${percent(fail501)}"></div>
            <div class="task-progress-seg other" style="width:${percent(other)}"></div>
        </div>
        <div class="task-progress-metrics">
            <div class="task-progress-metric"><strong>${success}</strong><span>成功请求</span></div>
            <div class="task-progress-metric"><strong>${fail501}</strong><span>签名验证失败</span></div>
            <div class="task-progress-metric"><strong>${remaining}</strong><span>还剩请求</span></div>
            <div class="task-progress-metric"><strong>${used}/${formatRunQuotaLimit(quota.limit, quota.unlimited)}</strong><span>当次请求</span></div>
        </div>
        <div class="task-progress-meta">
            <span>目标 ${progress.completedTargetCount || 0}/${progress.targetCount || targets.length || 0}${targetQuotaHint} · 场站 ${result.totalStations || 0} · 入库 ${result.totalInserted || 0} · 跳过 ${result.totalSkipped || 0}</span>
            <span>${escapeHtml(run.createdAt || '')}</span>
        </div>
    `;
}

async function pollTemplateApiRunProgress(runId) {
    if (!runId) {
        return null;
    }

    const runRes = await fetch(`${API_BASE}/runs/${runId}`);
    const runResult = await runRes.json();

    if (!runResult.success) {
        throw new Error(runResult.error || `读取${WORKFLOW_LABELS.automation}任务状态失败`);
    }

    const run = runResult.data;
    renderTemplateApiProgressCard(run);
    const result = run.resultSummary || {};
    const progress = result.progress || {};
    setTemplateApiProgressMeta(`运行任务 ${templateApiProgressTimers.size} 个 ｜ Run #${run.id} ｜ ${run.status} ｜ 成功 ${progress.success || 0} ｜ 签名验证失败 ${progress.fail501 || 0} ｜ 还剩 ${progress.unlimited ? '无上限' : (progress.remaining ?? '-')}`);
    if (run.status !== 'running') {
        stopTemplateApiProgressPolling(runId);
        renderTemplateApiRunResult(run);
    }

    return run;
}

function startTemplateApiProgressPolling(runId) {
    if (templateApiProgressTimers.has(Number(runId))) {
        return;
    }

    const timer = setInterval(() => {
        pollTemplateApiRunProgress(runId).catch(error => {
            addTemplateApiLog(`❌ 读取执行进度失败: ${error.message}`, 'error', false);
        });
    }, 1500);
    templateApiProgressTimers.set(Number(runId), timer);
    pollTemplateApiRunProgress(runId).catch(error => {
        addTemplateApiLog(`❌ 读取执行进度失败: ${error.message}`, 'error', false);
    });
}

function renderTemplateApiRunResult(run) {
    if (templateApiRenderedFinalRuns.has(Number(run?.id))) {
        return;
    }
    templateApiRenderedFinalRuns.add(Number(run?.id));
    setTemplateApiRunning(false);
    renderTemplateApiProgressCard(run);

    const result = run?.resultSummary || {};
    if (run?.status === 'success') {
        setTemplateApiProgressMeta(`Run #${run.id} 完成：识别 ${result.totalStations || 0}，入库 ${result.totalInserted || 0}，跳过 ${result.totalSkipped || 0}`);
    } else {
        setTemplateApiProgressMeta(`Run #${run?.id || '-'} 失败：${run?.errorMessage || '任务异常结束'}`);
    }

    crawlerCurrentRunStats = normalizeRunQuotaStats(result.runQuota);
    if (result.quotaStats) {
        renderCrawlerRunQuotaStats(result.quotaStats, crawlerCurrentRunStats);
    } else {
        loadCrawlerRunQuota();
    }
    loadStats();
    loadData();
}

async function crawlByCoordinatesForSelectedPlatforms() {
    ensureSelectedPlatforms();
    if (selectedPlatforms.length === 0) {
        alert('请先选择至少一个平台');
        return;
    }

    const centerLatRaw = document.getElementById('collectCenterLat').value?.trim() || '';
    const centerLngRaw = document.getElementById('collectCenterLng').value?.trim() || '';
    const centerLat = centerLatRaw ? Number(centerLatRaw) : NaN;
    const centerLng = centerLngRaw ? Number(centerLngRaw) : NaN;
    const radius = Number(document.getElementById('collectRadius').value || 20);
    const gridSize = Number(document.getElementById('collectGridSize').value || 2);
    const crawlMode = document.getElementById('collectCrawlMode')?.value || 'both';
    const perRunLimit = getCrawlerPerRunLimitFromInput();

    if ((!Number.isFinite(centerLat) || !Number.isFinite(centerLng)) && parseCollectTargetKeywords().length === 0) {
        alert('请输入有效的中心经纬度或目标位置');
        return;
    }
    if (perRunLimit === undefined) {
        alert('请输入有效的当次请求上限');
        return;
    }

    let targetLocations = [];
    try {
        targetLocations = await resolveCollectTargetLocations(centerLat, centerLng);
    } catch (error) {
        alert(error.message);
        return;
    }

    setTemplateApiRunning(true);
    setTemplateApiProgressMeta(`正在提交${WORKFLOW_LABELS.automation}后台任务...`);
    addTemplateApiLog(`🧭 启动按坐标验证，目标 ${targetLocations.length} 个`, 'info');
    if (targetLocations.length > 1) {
        addTemplateApiLog('🧩 本次按单任务多目标下发，每个城市/地标独立请求预算和代理上下文。', 'info');
    }
    addTemplateApiLog(`📦 平台: ${selectedPlatforms.map(getPlatformName).join('、')}`, 'info');
    addTemplateApiLog(`🧩 检索模式: ${crawlMode}`, 'info');
    addTemplateApiLog(
        `🧮 当次请求上限: ${formatRunQuotaLimit(perRunLimit, perRunLimit === null)}`,
        perRunLimit === null ? 'warn' : 'info'
    );
    if (selectedPlatforms.includes('didi-charging')) {
        addTemplateApiLog('⚠️ 滴滴模板含签名参数时会按目标坐标真实请求；若接口返回签名错误，需要重新学习目标城市 请求记录 或补齐签名算法。', 'warn');
    }
    crawlerCurrentRunStats = {
        limit: perRunLimit === null ? null : perRunLimit * Math.max(1, targetLocations.length),
        unlimited: perRunLimit === null,
        used: 0,
        success: 0,
        fail501: 0,
        quotaMode: 'per-target',
        perTargetLimit: perRunLimit,
        targetCount: targetLocations.length
    };

    try {
        const requestCenterLat = Number.isFinite(centerLat) ? centerLat : targetLocations[0].lat;
        const requestCenterLng = Number.isFinite(centerLng) ? centerLng : targetLocations[0].lng;
        const res = await fetch(`${API_BASE}/crawler/crawl-platforms-with-coordinates/start`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                platforms: selectedPlatforms,
                centerLat: requestCenterLat,
                centerLng: requestCenterLng,
                radius,
                gridSize,
                crawlMode,
                perRunLimit,
                perRunUnlimited: perRunLimit === null,
                targetLocation: targetLocations[0],
                targetLocations
            })
        });

        const result = await res.json();
        if (!result.success) {
            addTemplateApiLog(`❌ 坐标验证启动失败: ${result.error}`, 'error');
            crawlerCurrentRunStats = normalizeRunQuotaStats(result.runQuota);
            if (result.quotaStats) {
                renderCrawlerRunQuotaStats(result.quotaStats, crawlerCurrentRunStats);
            }
            setTemplateApiRunning(false);
            setTemplateApiProgressMeta('启动失败');
            return;
        }

        addTemplateApiLog(`✅ ${WORKFLOW_LABELS.automation}后台任务已启动: Run #${result.runId}`, 'success');
        setTemplateApiProgressMeta(`Run #${result.runId} ｜ running`);
        crawlerCurrentRunStats = normalizeRunQuotaStats(result.runQuota);
        if (result.quotaStats) {
            renderCrawlerRunQuotaStats(result.quotaStats, crawlerCurrentRunStats);
        }
        startTemplateApiProgressPolling(result.runId);
    } catch (error) {
        stopTemplateApiProgressPolling();
        setTemplateApiRunning(false);
        setTemplateApiProgressMeta('请求失败');
        addTemplateApiLog(`❌ 坐标验证请求失败: ${error.message}`, 'error');
    }
}

function renderInlineSelfHealLogs(selfHeal, logger = addLog) {
    const diagnosis = selfHeal?.diagnosis || null;
    if (!diagnosis) {
        return;
    }

    renderSelfHealPlan(diagnosis);
    logger(`  自动诊断: ${diagnosis.title}，${diagnosis.summary}`, diagnosis.status === 'recoverable' ? 'warn' : 'error');
    const steps = Array.isArray(diagnosis.repairPlan) ? diagnosis.repairPlan : [];
    steps.slice(0, 4).forEach((step, index) => {
        logger(`    修复动作 ${index + 1}: ${step.title}`, step.automatic === false ? 'error' : 'info');
    });
}

function clearSelfHealPlan() {
    latestSelfHealDiagnosis = null;
    renderSelfHealPlan(null);
    setStatusBannerState(
        document.getElementById('selfHealStatus'),
        selfHealConfig?.summary || '排查方案已清空',
        selfHealConfig?.enabled ? 'success' : 'warn'
    );
}

async function applyLatestSelfHealPlan() {
    const diagnosis = latestSelfHealDiagnosis;
    if (!diagnosis) {
        alert('当前没有可执行的排查方案');
        return;
    }

    if (diagnosis.status === 'manual_required') {
        alert('当前诊断已达到人工介入阈值，请先处理失败原因后再继续');
        return;
    }

    const targetChain = diagnosis.currentChain || diagnosis.execution?.targetChain || diagnosis.nextChain;
    const targetChainLabel = diagnosis.currentChainLabel
        || diagnosis.execution?.targetChainLabel
        || diagnosis.nextChainLabel
        || targetChain;
    setStatusBannerState(
        document.getElementById('selfHealStatus'),
        `正在执行当前能力修复：${targetChainLabel}`,
        'warn'
    );
    await recordSelfHealApplication(diagnosis);

    addLog(`已按方案执行 ${targetChainLabel} 的当前能力修复检查，修复后继续使用当前能力。`, 'warn');
}

async function recordSelfHealApplication(diagnosis) {
    try {
        const res = await fetch(`${API_BASE}/self-heal/apply`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                platforms: selectedPlatforms.length > 0 ? selectedPlatforms : [DEFAULT_PLATFORM_ID],
                diagnosis
            })
        });
        const result = await res.json();
        if (result.success) {
            await loadSelfHealRuns();
        }
    } catch (error) {
        console.warn('Failed to record self-heal application:', error);
    }
}

function startSessionPolling() {
    stopSessionPolling();
    sessionPollTimer = setInterval(syncActiveSession, 5000);
    syncActiveSession();
}

function stopSessionPolling() {
    if (sessionPollTimer) {
        clearInterval(sessionPollTimer);
        sessionPollTimer = null;
    }
}

async function syncActiveSession() {
    if (!activeSession) return;

    try {
        const res = await fetch(`${API_BASE}/smart-collect/status/${activeSession.sessionId}`);
        const result = await res.json();
        if (!result.success) {
            return;
        }

        const session = result.data;
        renderSessionLogs(session.logs || []);

        if (session.status === 'completed' || session.status === 'cancelled' || session.status === 'failed') {
            const isPageOcrMode = activeSession.mode === 'page-ocr' || session.options?.collectionMode === 'page-ocr';
            const isFailed = session.status === 'failed';
            stopSessionPolling();
            addLog(
                isFailed
                    ? `❌ 本次目标自动检索未达成：${session.error || '请求记录 未通过业务包校验'}`
                    : isPageOcrMode
                    ? `📊 本次完成 ${Array.isArray(session.results) ? session.results.length : 0} 组目标 页面识别 检索，识别结果已自动入库`
                    : `📊 本次完成 ${Array.isArray(session.results) ? session.results.length : 0} 组目标自动检索；内置请求记录已自动分析`,
                isFailed ? 'error' : 'success'
            );
            renderCaptureAnalysisLog(session.captureAnalysis);
            activeSession = null;
            setCaptureCollectButtons(false);
            setPageOcrButtons(false);
            loadStats();
            loadData();
        }
    } catch (error) {
        console.error('同步会话状态失败:', error);
    }
}

function renderSessionLogs(logs) {
    const logContainer = document.getElementById('collectionLog');
    if (!Array.isArray(logs) || logs.length === 0) return;

    logContainer.innerHTML = logs.slice().reverse().map(log => `
        <div class="log-entry ${log.type || 'info'}">
            <div class="timestamp">${new Date(log.timestamp).toLocaleTimeString()}</div>
            <div>${log.message}</div>
        </div>
    `).join('');
}

// 创建定时任务
async function createSchedule() {
    ensureSelectedPlatforms();
    const name = document.getElementById('scheduleName').value.trim();
    const cron = document.getElementById('scheduleCron').value.trim();
    
    if (!name || !cron) {
        alert('请填写任务名称和 Cron 表达式');
        return;
    }
    
    if (selectedPlatforms.length === 0) {
        alert('请选择至少一个平台');
        return;
    }
    
    try {
        const res = await fetch(`${API_BASE}/schedules`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name,
                platforms: selectedPlatforms,
                cronExpression: cron,
                selfHealSettings: collectSelfHealSettingsFromForm()
            })
        });
        
        const result = await res.json();
        
        if (result.success) {
            alert('定时任务创建成功！');
            loadSchedules();
        } else {
            alert('创建失败：' + result.error);
        }
    } catch (error) {
        alert('请求失败：' + error.message);
    }
}

async function drillSchedule(id) {
    try {
        const scenario = document.getElementById('selfHealScenario')?.value || 'api_501_burst';
        const currentChain = document.getElementById('selfHealCurrentChain')?.value || 'api';
        const res = await fetch(`${API_BASE}/schedules/${id}/drill`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ scenario, currentChain })
        });
        const result = await res.json();
        if (!result.success) {
            throw new Error(result.error || '排查演练失败');
        }

        renderSelfHealPlan(result.data?.diagnosis || null);
        await loadSelfHealRuns();
        await loadSchedules();
        setStatusBannerState(
            document.getElementById('selfHealStatus'),
            `${result.data?.schedule?.name || '任务'} 已生成当前能力排查方案`,
            result.data?.diagnosis?.status === 'recoverable' ? 'success' : 'error'
        );
    } catch (error) {
        alert(`排查演练失败：${error.message}`);
    }
}

// 切换定时任务状态
async function toggleSchedule(id, enabled) {
    try {
        const res = await fetch(`${API_BASE}/schedules/${id}/toggle`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled })
        });
        
        if ((await res.json()).success) {
            loadSchedules();
        }
    } catch (error) {
        alert('操作失败：' + error.message);
    }
}

// 删除定时任务
async function deleteSchedule(id) {
    if (!confirm('确定要删除这个任务吗？')) return;
    
    try {
        const res = await fetch(`${API_BASE}/schedules/${id}`, {
            method: 'DELETE'
        });
        
        if ((await res.json()).success) {
            loadSchedules();
        }
    } catch (error) {
        alert('删除失败：' + error.message);
    }
}

async function runSelfHealDiagnosis() {
    ensureSelectedPlatforms();
    const scenario = document.getElementById('selfHealScenario')?.value || 'api_501_burst';
    const currentChain = document.getElementById('selfHealCurrentChain')?.value || 'api';
    const platformsForDiagnosis = selectedPlatforms.length > 0 ? selectedPlatforms : [DEFAULT_PLATFORM_ID];

    try {
        const res = await fetch(`${API_BASE}/self-heal/diagnose`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                platforms: platformsForDiagnosis,
                scenario,
                currentChain
            })
        });
        const result = await res.json();
        if (!result.success) {
            throw new Error(result.error || '排查演练失败');
        }

        renderSelfHealPlan(result.data?.diagnosis || null);
        await loadSelfHealRuns();
        setStatusBannerState(
            document.getElementById('selfHealStatus'),
            result.data?.diagnosis?.summary || '排查演练已完成',
            result.data?.diagnosis?.status === 'recoverable' ? 'success' : 'error'
        );
    } catch (error) {
        alert(`排查演练失败：${error.message}`);
    }
}

// 导出 CSV
function exportCSV() {
    const platform = document.getElementById('platformFilter')?.value || '';
    const url = platform 
        ? `${API_BASE}/export/csv?platform=${platform}`
        : `${API_BASE}/export/csv`;
    
    window.open(url, '_blank');
}

function normalizeCityPresetKeyword(value = '') {
    return String(value || '')
        .trim()
        .replace(/\s+/g, '')
        .replace(/(特别行政区|自治州|地区|盟|市)$/u, '');
}

function formatPresetCoordinate(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) {
        return '';
    }

    return num.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}

function buildCityPresetLookup() {
    if (cityPresetLookup.size > 0 || CITY_PRESETS.length === 0) {
        return;
    }

    CITY_PRESETS.forEach(city => {
        const keys = new Set([
            city.name,
            city.city,
            city.province,
            ...(Array.isArray(city.aliases) ? city.aliases : [])
        ].map(normalizeCityPresetKeyword).filter(Boolean));

        keys.forEach(key => {
            if (!cityPresetLookup.has(key)) {
                cityPresetLookup.set(key, city);
            }
        });
    });
}

function findCityPreset(keyword) {
    const normalized = normalizeCityPresetKeyword(keyword);
    if (!normalized) {
        return null;
    }

    buildCityPresetLookup();
    return cityPresetLookup.get(normalized) || null;
}

function populateCityPresetOptions(datalistId) {
    const datalist = document.getElementById(datalistId);
    if (!datalist) {
        return;
    }

    datalist.innerHTML = '';
    CITY_PRESETS.forEach(city => {
        const option = document.createElement('option');
        option.value = city.name;
        option.label = `${city.province}${city.city && city.city !== city.name ? ` · ${city.city}` : ''} · ${formatPresetCoordinate(city.lat)}, ${formatPresetCoordinate(city.lng)}`;
        datalist.appendChild(option);
    });
}

function updateCityPresetMeta(metaEl, city, fallbackText = '') {
    if (!metaEl) {
        return;
    }

    if (!city) {
        metaEl.textContent = fallbackText;
        return;
    }

    metaEl.textContent = `${city.province} · 纬度 ${formatPresetCoordinate(city.lat)} · 经度 ${formatPresetCoordinate(city.lng)}`;
}

function applyLocationToCollectForm(location) {
    if (!location) {
        return false;
    }

    const lat = Number(location.lat);
    const lng = Number(location.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return false;
    }

    const inputEl = document.getElementById('collectPresetCity');
    const latEl = document.getElementById('collectCenterLat');
    const lngEl = document.getElementById('collectCenterLng');
    const metaEl = document.getElementById('collectPresetCityMeta');

    if (inputEl && location.name) {
        inputEl.value = location.name;
    }
    if (latEl) latEl.value = formatPresetCoordinate(lat);
    if (lngEl) lngEl.value = formatPresetCoordinate(lng);
    collectTargetLocation = {
        keyword: inputEl?.value?.trim() || location.keyword || location.name || '',
        name: location.name || inputEl?.value?.trim() || '',
        province: location.province || '',
        city: location.city || '',
        district: location.district || '',
        lat,
        lng,
        source: location.source || ''
    };
    collectTargetLocations = [collectTargetLocation];
    if (metaEl) {
        const source = location.source ? ` · ${location.source}` : '';
        metaEl.textContent = `${location.province || location.city || '目标'} · 纬度 ${formatPresetCoordinate(lat)} · 经度 ${formatPresetCoordinate(lng)}${source}`;
    }
    return true;
}

function buildCollectTargetLocation(centerLat, centerLng) {
    const keyword = document.getElementById('collectPresetCity')?.value?.trim() || '';
    const preset = findCityPreset(keyword);
    const base = collectTargetLocation || preset || {};

    return {
        keyword,
        name: base.name || keyword,
        province: base.province || '',
        city: base.city || '',
        district: base.district || '',
        lat: Number.isFinite(centerLat) ? centerLat : Number(base.lat) || null,
        lng: Number.isFinite(centerLng) ? centerLng : Number(base.lng) || null,
        source: base.source || (preset ? '城市预设' : '')
    };
}

function parseCollectTargetKeywords() {
    const raw = document.getElementById('collectPresetCity')?.value || '';
    return raw
        .split(/[,，;；\n\r]+/u)
        .map(item => item.trim())
        .filter(Boolean);
}

function parseCoordinateKeyword(keyword) {
    const match = String(keyword || '').match(/(-?\d+(?:\.\d+)?)\s*[,，\s]\s*(-?\d+(?:\.\d+)?)/);
    if (!match) {
        return null;
    }

    const first = Number(match[1]);
    const second = Number(match[2]);
    if (!Number.isFinite(first) || !Number.isFinite(second)) {
        return null;
    }

    const lat = Math.abs(first) <= 90 ? first : second;
    const lng = Math.abs(first) <= 90 ? second : first;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) {
        return null;
    }

    return {
        keyword,
        name: keyword,
        province: '',
        city: '',
        district: '',
        lat,
        lng,
        source: '经纬度'
    };
}

async function resolveLocationKeyword(keyword) {
    const coordinate = parseCoordinateKeyword(keyword);
    if (coordinate) {
        return coordinate;
    }

    const preset = findCityPreset(keyword);
    if (preset) {
        return { ...preset, keyword, source: '城市预设' };
    }

    const res = await fetch(`${API_BASE}/geocode/search?q=${encodeURIComponent(keyword)}`);
    const result = await res.json();
    const first = Array.isArray(result.data) ? result.data[0] : null;
    if (!result.success || !first) {
        throw new Error(`${keyword} 未定位`);
    }
    return { ...first, keyword, source: first.source || '地理编码' };
}

function summarizeTargetLocations(locations = []) {
    return locations
        .map(item => item.name || item.keyword || item.city || `${formatPresetCoordinate(item.lat)},${formatPresetCoordinate(item.lng)}`)
        .join('、');
}

function applyTargetLocationsToCollectForm(locations = []) {
    const validLocations = locations
        .map(item => {
            const lat = Number(item.lat);
            const lng = Number(item.lng);
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
                return null;
            }
            return {
                keyword: item.keyword || item.name || item.city || '',
                name: item.name || item.keyword || item.city || '',
                province: item.province || '',
                city: item.city || item.name || '',
                district: item.district || '',
                lat,
                lng,
                source: item.source || ''
            };
        })
        .filter(Boolean);

    if (validLocations.length === 0) {
        return false;
    }

    collectTargetLocations = validLocations;
    collectTargetLocation = validLocations[0];

    const inputEl = document.getElementById('collectPresetCity');
    const latEl = document.getElementById('collectCenterLat');
    const lngEl = document.getElementById('collectCenterLng');
    const metaEl = document.getElementById('collectPresetCityMeta');

    if (inputEl && validLocations.length === 1) {
        inputEl.value = validLocations[0].keyword || validLocations[0].name || inputEl.value;
    }
    if (latEl) latEl.value = formatPresetCoordinate(validLocations[0].lat);
    if (lngEl) lngEl.value = formatPresetCoordinate(validLocations[0].lng);
    if (metaEl) {
        metaEl.textContent = validLocations.length === 1
            ? `${validLocations[0].province || validLocations[0].city || '目标'} · 纬度 ${formatPresetCoordinate(validLocations[0].lat)} · 经度 ${formatPresetCoordinate(validLocations[0].lng)}${validLocations[0].source ? ` · ${validLocations[0].source}` : ''}`
            : `已选择 ${validLocations.length} 个目标：${summarizeTargetLocations(validLocations)}`;
    }
    return true;
}

async function resolveCollectTargetLocations(centerLat = null, centerLng = null) {
    const keywords = parseCollectTargetKeywords();
    if (keywords.length === 0) {
        const fallback = buildCollectTargetLocation(centerLat, centerLng);
        if (Number.isFinite(Number(fallback.lat)) && Number.isFinite(Number(fallback.lng))) {
            return [fallback];
        }
        throw new Error('请输入目标位置或中心经纬度');
    }

    const resolved = [];
    for (const keyword of keywords) {
        if (keywords.length === 1 && collectTargetLocation && normalizeCityPresetKeyword(collectTargetLocation.keyword || collectTargetLocation.name) === normalizeCityPresetKeyword(keyword)) {
            resolved.push(buildCollectTargetLocation(centerLat, centerLng));
            continue;
        }
        resolved.push(await resolveLocationKeyword(keyword));
    }

    applyTargetLocationsToCollectForm(resolved);
    return collectTargetLocations.length > 0 ? collectTargetLocations : resolved;
}

async function resolveCollectLocation() {
    const keyword = document.getElementById('collectPresetCity')?.value?.trim() || '';
    const metaEl = document.getElementById('collectPresetCityMeta');
    if (!keyword) {
        alert('请输入目标位置');
        return;
    }

    if (metaEl) {
        metaEl.textContent = '定位中...';
    }

    try {
        const locations = [];
        for (const item of parseCollectTargetKeywords()) {
            locations.push(await resolveLocationKeyword(item));
        }
        if (!applyTargetLocationsToCollectForm(locations)) {
            throw new Error('未找到可用位置');
        }
    } catch (error) {
        if (metaEl) metaEl.textContent = '定位失败';
        alert(`定位失败：${error.message}`);
    }
}

function setupCityPresetInput({ inputId, datalistId, latId, lngId, metaId, defaultCityName = '' }) {
    const inputEl = document.getElementById(inputId);
    const latEl = document.getElementById(latId);
    const lngEl = document.getElementById(lngId);
    const metaEl = document.getElementById(metaId);

    if (!inputEl || !latEl || !lngEl) {
        return;
    }

    populateCityPresetOptions(datalistId);

    const applyPreset = (city, shouldUpdateInput = true) => {
        if (!city) {
            return false;
        }

        if (shouldUpdateInput) {
            inputEl.value = city.name;
        }
        latEl.value = formatPresetCoordinate(city.lat);
        lngEl.value = formatPresetCoordinate(city.lng);
        collectTargetLocation = {
            keyword: inputEl.value.trim() || city.name,
            name: city.name,
            province: city.province || '',
            city: city.city || city.name || '',
            district: city.district || '',
            lat: Number(city.lat),
            lng: Number(city.lng),
            source: '城市预设'
        };
        collectTargetLocations = [collectTargetLocation];
        updateCityPresetMeta(metaEl, city);
        return true;
    };

    const syncFromInput = () => {
        const city = findCityPreset(inputEl.value);
        if (!inputEl.value.trim()) {
            collectTargetLocation = null;
            collectTargetLocations = [];
            updateCityPresetMeta(metaEl, null);
            return false;
        }

        if (!city) {
            collectTargetLocation = null;
            collectTargetLocations = [];
            if (metaEl) {
                metaEl.textContent = '待定位';
            }
            return false;
        }

        return applyPreset(city, false);
    };

    inputEl.addEventListener('change', syncFromInput);
    inputEl.addEventListener('blur', syncFromInput);
    inputEl.addEventListener('input', () => {
        if (!inputEl.value.trim()) {
            collectTargetLocation = null;
            collectTargetLocations = [];
            updateCityPresetMeta(metaEl, null);
            return;
        }

        const city = findCityPreset(inputEl.value);
        if (city) {
            applyPreset(city, false);
        }
    });

    if (defaultCityName && !inputEl.value.trim() && !latEl.value && !lngEl.value) {
        applyPreset(findCityPreset(defaultCityName));
        return;
    }

    if (inputEl.value.trim()) {
        syncFromInput();
        return;
    }

    updateCityPresetMeta(metaEl, null);
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

    // 滑动模式切换 - 默认显示按时间，隐藏按次数
    function initScrollMode() {
        const checkedMode = document.querySelector('input[name="scrollMode"]:checked')?.value || 'duration';
        const isCountMode = checkedMode === 'count';
        document.getElementById('scrollCountSection').style.display = isCountMode ? 'flex' : 'none';
        document.getElementById('scrollDurationSection').style.display = isCountMode ? 'none' : 'flex';
        updateScrollModeStyle(checkedMode);
    }

    function updateScrollModeStyle(mode) {
        const labels = document.querySelectorAll('input[name="scrollMode"]');
        labels.forEach((radio, index) => {
            const label = radio.closest('label');
            if (radio.value === mode) {
                label.style.background = '#e8f4fd';
                label.style.border = '2px solid #3b82f6';
                label.querySelector('span').style.color = '#1d4ed8';
            } else {
                label.style.background = '#f8fafc';
                label.style.border = '2px solid transparent';
                label.querySelector('span').style.color = '';
            }
        });
    }

    initScrollMode();

    document.querySelectorAll('input[name="scrollMode"]').forEach(radio => {
        radio.addEventListener('change', (e) => {
            const isCountMode = e.target.value === 'count';
            document.getElementById('scrollCountSection').style.display = isCountMode ? 'flex' : 'none';
            document.getElementById('scrollDurationSection').style.display = isCountMode ? 'none' : 'flex';
            updateScrollModeStyle(e.target.value);
        });
    });

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
        await refreshMethod1Status();
    });
    document.getElementById('method1RunBasicCheck')?.addEventListener('click', async () => {
        await runMethod1BasicCheck();
    });
    document.getElementById('method1OpenMiniapp')?.addEventListener('click', async () => {
        try { await openMethod1Miniapp(); } catch (error) { addLog(`❌ 打开小程序异常: ${error.message}`, 'error'); }
    });
    document.getElementById('method1Observe')?.addEventListener('click', async () => {
        try { await observeMethod1Page(); } catch (error) { addLog(`❌ 页面观察异常: ${error.message}`, 'error'); }
    });
    document.getElementById('method1ScrollOnce')?.addEventListener('click', async () => {
        try { await scrollMethod1Once(); } catch (error) { addLog(`❌ 下滑异常: ${error.message}`, 'error'); }
    });
    document.getElementById('method1BackOnce')?.addEventListener('click', async () => {
        try { await backMethod1Once(); } catch (error) { addLog(`❌ 返回异常: ${error.message}`, 'error'); }
    });
    document.getElementById('method1RunAdaptive')?.addEventListener('click', async () => {
        try { await runMethod1Adaptive(); } catch (error) { addLog(`❌ 动态决策异常: ${error.message}`, 'error'); }
    });
    document.getElementById('method1SwitchCity')?.addEventListener('click', async () => {
        try { await switchMethod1City(); } catch (error) { addLog(`❌ 切城市异常: ${error.message}`, 'error'); }
    });
    document.getElementById('method1TapByText')?.addEventListener('click', async () => {
        try { await tapMethod1ByText(); } catch (error) { addLog(`❌ 点击异常: ${error.message}`, 'error'); }
    });
    updatePageCollectionModeHint();

    document.getElementById('method2RefreshStatus')?.addEventListener('click', async () => {
        await refreshMethod2Status();
    });
    document.getElementById('method2StartCapture')?.addEventListener('click', async () => {
        try { await startMethod2Capture(); } catch (error) { addLog(`❌ 请求验证异常: ${error.message}`, 'error'); }
    });
    document.getElementById('method2StopAnalyze')?.addEventListener('click', async () => {
        try { await stopAnalyzeMethod2Capture(); } catch (error) { addLog(`❌ 请求分析异常: ${error.message}`, 'error'); }
    });
    document.getElementById('method3RefreshStatus')?.addEventListener('click', async () => {
        await refreshMethod3Status();
    });
    document.getElementById('method3Preflight')?.addEventListener('click', async () => {
        try { await runMethod3Preflight(); } catch (error) { addLog(`❌ 接口运行前检查异常: ${error.message}`, 'error'); }
    });
    document.getElementById('method3RunBasic')?.addEventListener('click', async () => {
        try { await runMethod3BasicCheck(); } catch (error) { addLog(`❌ 接口小规模验证异常: ${error.message}`, 'error'); }
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
        const limitInput = document.getElementById('crawlerRunLimitInput');
        if (limitInput) {
            limitInput.disabled = Boolean(event.target.checked);
            if (event.target.checked) {
                limitInput.value = '';
            }
        }
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
    document.getElementById('mobileStopBtn')?.addEventListener('click', async () => {
        try {
            await submitMobileIntent('停止验证');
        } catch (error) {
            setMobileIntentStatus(`停止指令失败：${error.message}`, 'error');
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
    const date = new Date(timestamp);
    return date.toLocaleString('zh-CN');
}

function formatPriceCell(value) {
    if (value === null || value === undefined || value === '') {
        return '-';
    }

    return `<span class="price-text">¥${escapeHtml(value)}</span>`;
}

function normalizeStationRecord(record = {}) {
    const sourceTypes = getArrayField(record, ['source_types', 'sourceTypes']);
    const sourceStages = getArrayField(record, ['source_stages', 'sourceStages']);
    return {
        ...record,
        platform: getFirstField(record, ['platform']) || null,
        station_id: getFirstField(record, ['station_id', 'stationId']) || null,
        station_name: getFirstField(record, ['station_name', 'stationName']) || null,
        address: getFirstField(record, ['address']) || null,
        price_fast: getNumericField(record, ['price_fast', 'priceFast']),
        price_slow: getNumericField(record, ['price_slow', 'priceSlow']),
        price_super: getNumericField(record, ['price_super', 'priceSuper']),
        price_service: getNumericField(record, ['price_service', 'priceService']),
        fast_idle_ports: getNumericField(record, ['fast_idle_ports', 'fastIdlePorts']),
        fast_total_ports: getNumericField(record, ['fast_total_ports', 'fastTotalPorts']),
        slow_idle_ports: getNumericField(record, ['slow_idle_ports', 'slowIdlePorts']),
        slow_total_ports: getNumericField(record, ['slow_total_ports', 'slowTotalPorts']),
        super_idle_ports: getNumericField(record, ['super_idle_ports', 'superIdlePorts']),
        super_total_ports: getNumericField(record, ['super_total_ports', 'superTotalPorts']),
        online_fast_ports: getNumericField(record, ['online_fast_ports', 'onlineFastPorts']),
        online_slow_ports: getNumericField(record, ['online_slow_ports', 'onlineSlowPorts']),
        fuel_92_price: getNumericField(record, ['fuel_92_price', 'fuel92Price']),
        fuel_95_price: getNumericField(record, ['fuel_95_price', 'fuel95Price']),
        fuel_98_price: getNumericField(record, ['fuel_98_price', 'fuel98Price']),
        fuel_diesel_price: getNumericField(record, ['fuel_diesel_price', 'fuelDieselPrice']),
        fuel_92_count: getNumericField(record, ['fuel_92_count', 'fuel92Count']),
        fuel_95_count: getNumericField(record, ['fuel_95_count', 'fuel95Count']),
        fuel_98_count: getNumericField(record, ['fuel_98_count', 'fuel98Count']),
        fuel_diesel_count: getNumericField(record, ['fuel_diesel_count', 'fuelDieselCount']),
        source_type: getFirstField(record, ['source_type', 'sourceType']) || null,
        source_stage: getFirstField(record, ['source_stage', 'sourceStage']) || null,
        source_types: uniqueStrings([
            ...sourceTypes,
            getFirstField(record, ['source_type', 'sourceType']) || null
        ]),
        source_stages: uniqueStrings([
            ...sourceStages,
            getFirstField(record, ['source_stage', 'sourceStage']) || null
        ]),
        has_price_schedule: Boolean(getFirstField(record, ['has_price_schedule', 'hasPriceSchedule'])),
        price_schedule_types: getArrayField(record, ['price_schedule_types', 'priceScheduleTypes']),
        price_schedule_count: getNumericField(record, ['price_schedule_count', 'priceScheduleCount']),
        collected_at: getFirstField(record, ['collected_at', 'collectedAt']) || null,
        snapshot_at: getFirstField(record, ['snapshot_at', 'snapshotAt']) || null,
        price_gun_snapshot_at: getFirstField(record, ['price_gun_snapshot_at', 'priceGunSnapshotAt']) || null
    };
}

function getFirstField(record, keys) {
    for (const key of keys) {
        const value = record?.[key];
        if (value !== null && value !== undefined && value !== '') {
            return value;
        }
    }
    return null;
}

function getNumericField(record, keys) {
    const value = getFirstField(record, keys);
    if (value === null) {
        return null;
    }

    const num = Number(value);
    return Number.isFinite(num) ? num : null;
}

function getArrayField(record, keys) {
    for (const key of keys) {
        const value = record?.[key];
        if (Array.isArray(value)) {
            return uniqueStrings(value);
        }
        if (typeof value === 'string' && value.trim()) {
            return uniqueStrings(value.split(','));
        }
    }

    return [];
}

function uniqueStrings(values = []) {
    return Array.from(new Set(
        values
            .map(value => String(value || '').trim())
            .filter(Boolean)
    ));
}

function parseJsonArray(value) {
    if (Array.isArray(value)) {
        return value;
    }
    if (typeof value !== 'string' || !value.trim()) {
        return [];
    }
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
        return [];
    }
}

function hasPositiveNumber(value) {
    return Number.isFinite(Number(value)) && Number(value) > 0;
}

function isFuelPlatform(row) {
    return row.platform === 'tuanyou'
        || hasPositiveNumber(row.fuel_92_price)
        || hasPositiveNumber(row.fuel_95_price)
        || hasPositiveNumber(row.fuel_98_price)
        || hasPositiveNumber(row.fuel_diesel_price)
        || hasPositiveNumber(row.fuel_92_count)
        || hasPositiveNumber(row.fuel_95_count)
        || hasPositiveNumber(row.fuel_98_count)
        || hasPositiveNumber(row.fuel_diesel_count);
}

function formatNumericPrice(value) {
    if (!hasPositiveNumber(value)) {
        return '';
    }

    const num = Number(value);
    return num.toFixed(num % 1 === 0 ? 2 : 4).replace(/0+$/, '').replace(/\.$/, '');
}

function buildPriceItems(row) {
    if (isFuelPlatform(row)) {
        return [
            buildPriceItem('fuel92', '92#', row.fuel_92_price),
            buildPriceItem('fuel95', '95#', row.fuel_95_price),
            buildPriceItem('fuel98', '98#', row.fuel_98_price),
            buildPriceItem('fuelDiesel', '柴油', row.fuel_diesel_price)
        ].filter(Boolean);
    }

    return [
        buildPriceItem('fast', '快充', row.price_fast),
        buildPriceItem('slow', '慢充', row.price_slow),
        buildPriceItem('super', '超充', row.price_super),
        buildPriceItem('service', '服务费', row.price_service)
    ].filter(Boolean);
}

function buildPriceItem(kind, label, value) {
    if (!hasPositiveNumber(value)) {
        return null;
    }

    return {
        kind,
        label,
        primary: `¥${formatNumericPrice(value)}`
    };
}

function buildFuelCountItems(row) {
    return [
        buildCountItem('fuel92', '92#', row.fuel_92_count),
        buildCountItem('fuel95', '95#', row.fuel_95_count),
        buildCountItem('fuel98', '98#', row.fuel_98_count),
        buildCountItem('fuelDiesel', '柴油', row.fuel_diesel_count)
    ].filter(Boolean);
}

function buildFuelTypeItems(row) {
    const items = [];
    const definitions = [
        { kind: 'fuel92', label: '92#', count: row.fuel_92_count, price: row.fuel_92_price },
        { kind: 'fuel95', label: '95#', count: row.fuel_95_count, price: row.fuel_95_price },
        { kind: 'fuel98', label: '98#', count: row.fuel_98_count, price: row.fuel_98_price },
        { kind: 'fuelDiesel', label: '柴油', count: row.fuel_diesel_count, price: row.fuel_diesel_price }
    ];

    definitions.forEach(definition => {
        const normalizedCount = normalizeInt(definition.count);
        const normalizedPrice = Number(definition.price);
        const hasValidPrice = Number.isFinite(normalizedPrice) && normalizedPrice > 0;
        const hasValidCount = normalizedCount > 0;

        // 价格为0或无数据时不展示
        if (!hasValidPrice && !hasValidCount) {
            return;
        }

        if (hasValidCount) {
            items.push({
                kind: definition.kind,
                label: definition.label,
                primary: `${normalizedCount} 枪`,
                secondary: hasValidPrice ? `¥${normalizedPrice.toFixed(2)}` : null
            });
            return;
        }

        if (hasValidPrice) {
            items.push({
                kind: definition.kind,
                label: definition.label,
                primary: `¥${normalizedPrice.toFixed(2)}`,
                secondary: null
            });
        }
    });

    return items;
}

function buildCountItem(kind, label, count) {
    const normalized = normalizeInt(count);
    if (normalized <= 0) {
        return null;
    }

    return {
        kind,
        label,
        primary: `${normalized} 枪`
    };
}

function buildGunItems(row) {
    const items = [];
    const pushItem = (kind, label, idleValue, totalValue) => {
        const idle = normalizeInt(idleValue);
        const total = normalizeInt(totalValue);
        if (idle === 0 && total === 0) {
            return;
        }

        items.push({
            kind,
            label,
            idle,
            total,
            totalLabel: String(total),
            busy: Math.max(0, total - idle),
            hasBusy: true
        });
    };

    pushItem('fast', '快充', row.fast_idle_ports, row.fast_total_ports);
    pushItem('slow', '慢充', row.slow_idle_ports, row.slow_total_ports);
    pushItem('super', '超充', row.super_idle_ports, row.super_total_ports);

    if (items.length > 0) {
        return items;
    }

    const fallbackFast = normalizeInt(row.online_fast_ports);
    const fallbackSlow = normalizeInt(row.online_slow_ports);

    if (fallbackFast > 0) {
        items.push({
            kind: 'fast',
            label: '快充',
            idle: fallbackFast,
            total: null,
            totalLabel: '-',
            busy: null,
            hasBusy: false
        });
    }

    if (fallbackSlow > 0) {
        items.push({
            kind: 'slow',
            label: '慢充',
            idle: fallbackSlow,
            total: null,
            totalLabel: '-',
            busy: null,
            hasBusy: false
        });
    }

    return items;
}

function formatGunTypeSummary(row) {
    const items = buildGunItems(row);
    if (items.length === 0) {
        return '枪口数据缺失';
    }

    return items.map(item => {
        const busyText = item.hasBusy ? ` 忙${item.busy}` : '';
        return `${item.label} 空闲${item.idle}/${item.totalLabel}${busyText}`;
    }).join(' | ');
}

function formatGunPart(label, idleValue, totalValue) {
    const idle = normalizeInt(idleValue);
    const total = normalizeInt(totalValue);
    const busy = Math.max(0, total - idle);
    if (idle === 0 && total === 0) {
        return '';
    }
    return `${label} 空闲${idle}/${total} 忙${busy}`;
}

function normalizeInt(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) {
        return 0;
    }
    return Math.max(0, Math.round(num));
}

function renderGunTypeSummary(row) {
    const items = buildGunItems(row);
    if (items.length === 0) {
        return '<span class="gun-empty">枪口数据缺失</span>';
    }

    return `
        <div class="gun-summary">
            ${items.map(item => `
                <div class="gun-line gun-${item.kind}">
                    <span class="gun-type">${escapeHtml(item.label)}</span>
                    <span class="gun-meta">空闲${item.idle}/${item.totalLabel}</span>
                    ${item.hasBusy ? `<span class="gun-busy">忙${item.busy}</span>` : ''}
                </div>
            `).join('')}
        </div>
    `;
}

function renderSummaryItems(items, emptyText) {
    if (!Array.isArray(items) || items.length === 0) {
        return `<span class="summary-empty">${escapeHtml(emptyText)}</span>`;
    }

    return `
        <div class="summary-stack">
            ${items.map(item => `
                <div class="summary-row summary-${escapeHtml(item.kind || 'unknown').toLowerCase()}">
                    <span class="summary-label">${escapeHtml(item.label)}</span>
                    <span class="summary-value">${escapeHtml(item.primary)}</span>
                    ${item.secondary ? `<span class="summary-muted">${escapeHtml(item.secondary)}</span>` : ''}
                </div>
            `).join('')}
        </div>
    `;
}

function renderAvailabilityItems(items, emptyText) {
    if (!Array.isArray(items) || items.length === 0) {
        return `<span class="summary-empty">${escapeHtml(emptyText)}</span>`;
    }

    return `
        <div class="availability-stack">
            ${items.map(item => `
                <div class="availability-row availability-${escapeHtml(item.kind || 'unknown').toLowerCase()}">
                    <span class="availability-label">${escapeHtml(item.label)}</span>
                    <span class="availability-value">${escapeHtml(item.primary)}</span>
                    ${item.secondary ? `<span class="availability-muted">${escapeHtml(item.secondary)}</span>` : ''}
                </div>
            `).join('')}
        </div>
    `;
}

function renderPriceSummary(row) {
    const base = renderSummaryItems(buildPriceItems(row), '价格数据缺失');
    if (!row.has_price_schedule) {
        return base;
    }

    const detailText = row.price_schedule_count
        ? `已保留分时价 ${row.price_schedule_count} 段`
        : '已保留分时价';
    const scheduleTypes = row.price_schedule_types
        .map(formatScheduleType)
        .filter(Boolean);
    const typeText = scheduleTypes.length > 0
        ? ` · ${escapeHtml(scheduleTypes.join(' / '))}`
        : '';

    return `${base}<div class="summary-muted price-schedule-note">${detailText}${typeText}</div>`;
}

function renderAvailabilitySummary(rawRow) {
    const row = normalizeStationRecord(rawRow);
    if (isFuelPlatform(row)) {
        return renderAvailabilityItems(buildFuelTypeItems(row), '油号数据缺失');
    }

    const items = buildGunItems(row).map(item => ({
        kind: item.kind,
        label: item.label,
        primary: `空闲${item.idle}/${item.totalLabel}`,
        secondary: item.hasBusy ? `忙${item.busy}` : null
    }));
    return renderAvailabilityItems(items, '枪口数据缺失');
}

function getSourceMeta(sourceType) {
    const normalized = String(sourceType || '').trim() || 'unknown';
    const map = {
        'page-ocr': { label: '页面识别', className: 'page-ocr' },
        'mitm-har': { label: '请求记录解析', className: 'mitm-har' },
        'api-crawl': { label: 'API检索', className: 'api-crawl' },
        'runtime-capture': { label: '运行时识别', className: 'runtime-capture' },
        'teld-runtime': { label: '运行时识别', className: 'runtime-capture' }
    };

    return map[normalized] || { label: normalized, className: 'unknown' };
}

function renderSourceSummary(rawRow) {
    const row = normalizeStationRecord(rawRow);
    const sourceTypes = row.source_types.length > 0
        ? row.source_types
        : (row.source_type ? [row.source_type] : []);
    const sourceStages = row.source_stages.length > 0
        ? row.source_stages
        : (row.source_stage ? [row.source_stage] : []);
    const stageLabel = sourceStages.length > 0
        ? sourceStages.map(item => item.replace(/_/g, ' ')).join(' / ')
        : '未标记阶段';

    return `
        <div class="source-stack">
            ${(sourceTypes.length > 0 ? sourceTypes : ['unknown']).map(type => {
                const sourceMeta = getSourceMeta(type);
                return `<span class="source-chip ${escapeHtml(sourceMeta.className)}">${escapeHtml(sourceMeta.label)}</span>`;
            }).join('')}
            <div class="source-stage">${escapeHtml(stageLabel)}</div>
        </div>
    `;
}

function formatStationInlineSummary(rawRow) {
    const row = normalizeStationRecord(rawRow);
    const priceItems = buildPriceItems(row);
    const availabilityItems = isFuelPlatform(row)
        ? buildFuelTypeItems(row)
        : buildGunItems(row).map(item => ({
            label: item.label,
            text: `空闲${item.idle}/${item.totalLabel}${item.hasBusy ? ` 忙${item.busy}` : ''}`
        }));

    const parts = [];
    if (priceItems.length > 0) {
        parts.push(priceItems.map(item => `${item.label} ${item.primary}`).join(' / '));
    }

    if (isFuelPlatform(row)) {
        if (availabilityItems.length > 0) {
            parts.push(availabilityItems.map(item => `${item.label} ${item.primary}${item.secondary ? ` ${item.secondary}` : ''}`).join(' / '));
        }
    } else if (availabilityItems.length > 0) {
        parts.push(availabilityItems.map(item => `${item.label} ${item.text}`).join(' / '));
    }

    if (row.has_price_schedule) {
        parts.push(`分时价已保留${row.price_schedule_count ? `(${row.price_schedule_count}段)` : ''}`);
    }

    return parts.length > 0 ? parts.join('，') : '未识别到价格或枪口信息';
}

function formatScheduleType(value) {
    const normalized = String(value || '');
    if (/chargingPrices/i.test(normalized)) return '星星充电分时价';
    if (/aggregatedPrices/i.test(normalized)) return '聚合分时价';
    if (/dpolicyPriceList/i.test(normalized)) return '滴滴分时价';
    if (/stubGroupDetailFeeInfos/i.test(normalized)) return '费率明细';
    return normalized.split('.').pop().replace(/\[\d+\]/g, '');
}

function addLog(message, type = 'info') {
    appendLogEntry('collectionLog', message, type);
}

function addParseLog(message, type = 'info') {
    appendLogEntry('parseLog', message, type);
}

// ============ 文件上传和解析功能 ============

let selectedFiles = [];

function handleFileSelect(event) {
    const files = Array.from(event.target.files);
    
    if (files.length === 0) return;
    
    // 添加到选中文件列表
    selectedFiles = files;
    
    // 显示文件列表
    renderFileList();
    
    // 显示解析按钮
    document.getElementById('parseHarBtn').style.display = 'inline-block';
    
    addParseLog(`已选择 ${files.length} 个文件`, 'success');
}

function renderFileList() {
    const container = document.getElementById('uploadFileList');
    
    if (selectedFiles.length === 0) {
        container.innerHTML = '';
        return;
    }
    
    container.innerHTML = selectedFiles.map((file, index) => `
        <div class="file-item">
            <div>
                <div class="file-name">📄 ${file.name}</div>
                <div class="file-size">${formatFileSize(file.size)}</div>
            </div>
            <button class="remove-btn" onclick="removeFile(${index})">移除</button>
        </div>
    `).join('');
}

function removeFile(index) {
    selectedFiles.splice(index, 1);
    renderFileList();
    
    if (selectedFiles.length === 0) {
        document.getElementById('parseHarBtn').style.display = 'none';
    }
    
    addParseLog(`已移除文件`, 'info');
}

function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
    return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

async function parseHarFiles() {
    if (selectedFiles.length === 0) {
        alert('请先选择文件');
        return;
    }
    
    const parseBtn = document.getElementById('parseHarBtn');
    parseBtn.disabled = true;
    parseBtn.textContent = '⏳ 解析中...';
    
    addParseLog(`开始解析 ${selectedFiles.length} 个文件...`, 'info');
    
    let totalStations = 0;
    let successCount = 0;
    let failCount = 0;
    
    for (let i = 0; i < selectedFiles.length; i++) {
        const file = selectedFiles[i];
        
        try {
            addParseLog(`[${i + 1}/${selectedFiles.length}] 正在解析: ${file.name}`, 'info');
            
            // 读取文件内容
            const content = await readFileAsText(file);
            
            // 发送到后端解析
            const res = await fetch(`${API_BASE}/parse-har-upload`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    filename: file.name,
                    content: content
                })
            });
            
            const result = await res.json();
            
            if (result.success) {
                successCount++;
                totalStations += result.stationCount || 0;
                addParseLog(`✅ ${file.name}: 解析成功，找到 ${result.stationCount} 个场站`, 'success');
            } else {
                failCount++;
                addParseLog(`❌ ${file.name}: ${result.error}`, 'error');
            }
        } catch (error) {
            failCount++;
            addParseLog(`❌ ${file.name}: ${error.message}`, 'error');
        }
    }
    
    addParseLog(`\n解析完成！成功: ${successCount}, 失败: ${failCount}, 总计场站: ${totalStations}`, 'success');
    
    parseBtn.disabled = false;
    parseBtn.textContent = '🚀 开始解析';
    
    // 清空选择
    selectedFiles = [];
    renderFileList();
    document.getElementById('harFileInput').value = '';
    document.getElementById('parseHarBtn').style.display = 'none';
    
    // 刷新数据列表
    loadStats();
    loadData();
}

function readFileAsText(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result);
        reader.onerror = (e) => reject(new Error('文件读取失败'));
        reader.readAsText(file);
    });
}


function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
