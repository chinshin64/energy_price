const CHAIN_LABELS = {
    api: '流量自动化识别',
    har: '后台自动化识别',
    page: '页面自动化识别'
};

const DEFAULT_CHAIN_PRIORITY = ['api', 'har', 'page'];

const DEFAULT_SETTINGS = {
    enabled: true,
    autoFallbackEnabled: false,
    autoTemplateSwitch: true,
    autoProxyRotate: true,
    autoUaRotate: true,
    autoRefreshLearning: true,
    resumeFromBreakpoint: true,
    maxAttemptsPerRun: 3,
    manualEscalationThreshold: 3,
    failureSignals: {
        fail501Threshold: 2,
        emptyResponseThreshold: 1,
        parseEmptyThreshold: 1,
        stallMinutes: 8
    },
    chainPriority: DEFAULT_CHAIN_PRIORITY,
    updatedAt: null
};

const SCENARIO_MAP = {
    api_501_burst: {
        code: 'api_501_blocked',
        title: '流量自动化识别当前能力异常',
        message: '短时间内出现连续 501，优先检查模板样本、参数改写、UA、代理和解析器是否与当前请求匹配。',
        severity: 'high'
    },
    api_empty_payload: {
        code: 'api_empty_payload',
        title: '流量自动化识别返回空数据',
        message: '接口已响应但无有效场站，优先检查响应体、分页参数、模板范围和解析器命中情况。',
        severity: 'medium'
    },
    har_not_recording: {
        code: 'capture_recorder_not_recording',
        title: '内置录包服务未正常录制',
        message: '录制状态异常或导出链路中断，需要检查内置录包进程、代理监听、证书信任、目标域名过滤和 HAR 文件增长情况。',
        severity: 'high'
    },
    page_no_station_found: {
        code: 'page_no_station_found',
        title: '页面识别未找到场站',
        message: '当前页面识别不到列表或详情卡片，需要检查微信窗口、截图、OCR、滚动脚本和页面状态识别。',
        severity: 'medium'
    },
    session_stalled: {
        code: 'session_stalled',
        title: '任务长时间卡住',
        message: '超过阈值未推进，优先从断点恢复并重建当前窗口状态。',
        severity: 'high'
    },
    template_missing: {
        code: 'template_missing',
        title: '平台缺少可用模板',
        message: '当前平台没有可直接执行的模板，需要检查模板库存、启用状态、列表/详情覆盖和最近学习结果。',
        severity: 'high'
    },
    proxy_blocked: {
        code: 'proxy_blocked',
        title: '代理链路不可用',
        message: '代理出口异常或质量下降，需要检查代理格式、连通性、城市出口和请求侧代理注入是否生效。',
        severity: 'high'
    },
    wechat_window_lost: {
        code: 'wechat_window_lost',
        title: '微信窗口状态丢失',
        message: '目标小程序窗口不可操作，需要重新激活微信并回到指定列表页。',
        severity: 'medium'
    }
};

function normalizePositiveInt(value, fallback) {
    const num = Number(value);
    if (!Number.isFinite(num) || num <= 0) {
        return fallback;
    }
    return Math.max(1, Math.floor(num));
}

function normalizeBoolean(value, fallback) {
    if (value === undefined) {
        return fallback;
    }
    return Boolean(value);
}

function normalizeChainPriority(chainPriority = []) {
    const values = Array.isArray(chainPriority)
        ? chainPriority
        : String(chainPriority || '')
            .split(',')
            .map(item => item.trim());

    const normalized = values
        .map(item => String(item || '').trim().toLowerCase())
        .filter(item => CHAIN_LABELS[item]);

    const ordered = [];
    for (const chain of normalized) {
        if (!ordered.includes(chain)) {
            ordered.push(chain);
        }
    }

    DEFAULT_CHAIN_PRIORITY.forEach(chain => {
        if (!ordered.includes(chain)) {
            ordered.push(chain);
        }
    });

    return ordered;
}

class TaskSelfHealService {
    static getChainLabels() {
        return { ...CHAIN_LABELS };
    }

    static getScenarioOptions() {
        return Object.entries(SCENARIO_MAP).map(([value, item]) => ({
            value,
            label: item.title,
            description: item.message
        }));
    }

    static normalizeSettings(input = {}) {
        const signals = input.failureSignals && typeof input.failureSignals === 'object'
            ? input.failureSignals
            : {};

        return {
            enabled: normalizeBoolean(input.enabled, DEFAULT_SETTINGS.enabled),
            autoFallbackEnabled: normalizeBoolean(input.autoFallbackEnabled, DEFAULT_SETTINGS.autoFallbackEnabled),
            autoTemplateSwitch: normalizeBoolean(input.autoTemplateSwitch, DEFAULT_SETTINGS.autoTemplateSwitch),
            autoProxyRotate: normalizeBoolean(input.autoProxyRotate, DEFAULT_SETTINGS.autoProxyRotate),
            autoUaRotate: normalizeBoolean(input.autoUaRotate, DEFAULT_SETTINGS.autoUaRotate),
            autoRefreshLearning: normalizeBoolean(input.autoRefreshLearning, DEFAULT_SETTINGS.autoRefreshLearning),
            resumeFromBreakpoint: normalizeBoolean(input.resumeFromBreakpoint, DEFAULT_SETTINGS.resumeFromBreakpoint),
            maxAttemptsPerRun: normalizePositiveInt(input.maxAttemptsPerRun, DEFAULT_SETTINGS.maxAttemptsPerRun),
            manualEscalationThreshold: normalizePositiveInt(
                input.manualEscalationThreshold,
                DEFAULT_SETTINGS.manualEscalationThreshold
            ),
            failureSignals: {
                fail501Threshold: normalizePositiveInt(
                    signals.fail501Threshold,
                    DEFAULT_SETTINGS.failureSignals.fail501Threshold
                ),
                emptyResponseThreshold: normalizePositiveInt(
                    signals.emptyResponseThreshold,
                    DEFAULT_SETTINGS.failureSignals.emptyResponseThreshold
                ),
                parseEmptyThreshold: normalizePositiveInt(
                    signals.parseEmptyThreshold,
                    DEFAULT_SETTINGS.failureSignals.parseEmptyThreshold
                ),
                stallMinutes: normalizePositiveInt(
                    signals.stallMinutes,
                    DEFAULT_SETTINGS.failureSignals.stallMinutes
                )
            },
            chainPriority: normalizeChainPriority(input.chainPriority),
            updatedAt: input.updatedAt || null
        };
    }

    static buildSummary(settingsInput = {}) {
        const settings = this.normalizeSettings(settingsInput);
        const chainText = settings.chainPriority
            .map(chain => CHAIN_LABELS[chain])
            .join(' → ');

        if (!settings.enabled) {
            return '已关闭自动排查与恢复';
        }

        const fallbackText = settings.autoFallbackEnabled ? '允许失败后兜底' : '优先当前能力修复';
        return `已启用 · 最多 ${settings.maxAttemptsPerRun} 轮 · ${fallbackText} · ${chainText}`;
    }

    static buildPreflight(payload = {}) {
        const settings = this.normalizeSettings(payload.settings || payload.selfHealSettings || {});
        const platforms = Array.isArray(payload.platforms) ? payload.platforms.filter(Boolean) : [];
        const cities = Array.isArray(payload.cities) ? payload.cities.filter(Boolean) : [];
        const networkSettings = payload.networkSettings || {};
        const checks = [];

        checks.push({
            status: platforms.length > 0 ? 'pass' : 'fail',
            label: '目标平台',
            message: platforms.length > 0
                ? `已选择 ${platforms.length} 个平台`
                : '至少需要选择 1 个平台'
        });

        checks.push({
            status: cities.length > 0 ? 'pass' : 'fail',
            label: '目标位置',
            message: cities.length > 0
                ? `已配置 ${cities.length} 个城市或目标位置`
                : '至少需要配置 1 个城市或目标位置'
        });

        checks.push({
            status: settings.enabled ? 'pass' : 'warn',
            label: '任务自愈',
            message: settings.enabled
                ? '已开启自动排查与恢复，失败时会先定位当前能力自身问题'
                : '未开启自动排查与恢复，任务失败后只会停在原链路'
        });

        checks.push({
            status: settings.autoFallbackEnabled ? 'pass' : 'warn',
            label: '兜底策略',
            message: settings.autoFallbackEnabled
                ? '仅当当前能力修复失败后，才允许按优先级尝试其他链路'
                : '默认只修复当前能力，不自动改走其他链路'
        });

        checks.push({
            status: networkSettings.enabled ? 'pass' : 'warn',
            label: '代理出口',
            message: networkSettings.enabled
                ? '代理能力已配置，API 异常时会先检查代理是否真实生效'
                : '当前未启用代理，API 异常时会优先检查模板、参数、UA 和解析器'
        });

        if (payload.previewMode) {
            checks.push({
                status: 'warn',
                label: '当前副本',
                message: '本地副本以流程预演为主，真实自动化动作需要在完整工程恢复后接回执行层'
            });
        }

        const canStart = checks.every(check => check.status !== 'fail');
        return {
            canStart,
            checks,
            summary: this.buildSummary(settings)
        };
    }

    static findNextChain(chainPriority, currentChain) {
        const normalized = normalizeChainPriority(chainPriority);
        const index = normalized.indexOf(String(currentChain || '').trim().toLowerCase());
        if (index === -1) {
            return normalized[0] || null;
        }
        return normalized[index + 1] || null;
    }

    static buildCapabilityDiagnostics({ scenario, settings, currentChain, networkSettings, metrics = {} }) {
        const diagnostics = [];
        const add = (status, label, message, fixCode = null) => {
            diagnostics.push({ status, label, message, fixCode });
        };
        const hasMetric = key => Object.prototype.hasOwnProperty.call(metrics, key);
        const metricNumber = (key, fallback = null) => {
            const value = Number(metrics[key]);
            return Number.isFinite(value) ? value : fallback;
        };

        if (currentChain === 'api') {
            const activeTemplateCount = metricNumber('activeTemplateCount');
            const parseCount = metricNumber('parseCount');
            const status501Count = metricNumber('status501Count');
            const parserErrorCount = metricNumber('parserErrorCount');
            const emptyResponseCount = metricNumber('emptyResponseCount');
            const paramsMissing = Array.isArray(metrics.requiredParamsMissing)
                ? metrics.requiredParamsMissing.filter(Boolean)
                : [];

            add(
                scenario === 'template_missing' || activeTemplateCount === 0 ? 'fail' : 'pass',
                'API 模板库存',
                activeTemplateCount === 0
                    ? '当前平台没有启用中的列表或详情模板。'
                    : '检查当前平台是否存在启用模板、列表/详情覆盖和最近学习样本。',
                'validate_template_inventory'
            );
            add(
                scenario === 'api_501_burst' || paramsMissing.length > 0 ? 'warn' : 'pass',
                '签名与请求参数',
                paramsMissing.length > 0
                    ? `缺少或疑似失效参数：${paramsMissing.join('、')}。`
                    : '校验经纬度、分页、站点 ID、wsgsig/secdd 等动态参数是否与当前请求一致。',
                'validate_signed_params'
            );
            add(
                scenario === 'api_501_burst' || (status501Count || 0) >= settings.failureSignals.fail501Threshold ? 'fail' : 'pass',
                '返回码健康度',
                status501Count
                    ? `连续 501 次数 ${status501Count}，已达到或接近阈值。`
                    : '统计当前模板最近请求的 501、304、空 JSON 和超时占比。',
                'inspect_status_distribution'
            );
            add(
                scenario === 'api_empty_payload' || (emptyResponseCount || 0) >= settings.failureSignals.emptyResponseThreshold ? 'warn' : 'pass',
                '响应体与分页',
                emptyResponseCount
                    ? `空响应次数 ${emptyResponseCount}，需要确认分页、城市范围和返回体字段。`
                    : '用当前目标位置重新校验列表页和详情页是否仍返回可解析数据。',
                'validate_latest_request'
            );
            add(
                scenario === 'api_empty_payload' || (parserErrorCount || 0) > 0 || parseCount === 0 ? 'warn' : 'pass',
                '解析器命中',
                parserErrorCount
                    ? `解析器异常 ${parserErrorCount} 次，需要检查字段映射。`
                    : '检查场站名、地址、枪型、闲忙枪数和分时价格字段是否命中。',
                'validate_parser_mapping'
            );
            add(
                networkSettings.enabled ? 'pass' : 'warn',
                'UA 与代理注入',
                networkSettings.enabled
                    ? '检查真实 UA 轮换和代理出口是否实际进入 API 请求。'
                    : '未配置代理时，仅检查 UA 轮换和请求头一致性。',
                'validate_identity_layer'
            );
            return diagnostics;
        }

        if (currentChain === 'har') {
            add(
                scenario === 'har_not_recording' ? 'fail' : 'pass',
                '内置录包状态',
                '检查系统录包进程、代理监听、证书信任和目标域名过滤是否正常。',
                'check_har_recording'
            );
            add(
                scenario === 'har_not_recording' ? 'warn' : 'pass',
                'HAR 文件增长',
                '确认最新 HAR 文件存在、非空、持续增长且没有被截断。',
                'validate_har_growth'
            );
            add(
                'pass',
                'HAR 解析器',
                '复测最新 HAR 是否能识别平台、接口、场站、枪型、价格和闲忙字段。',
                'validate_har_parser'
            );
            return diagnostics;
        }

        if (currentChain === 'page') {
            add(
                scenario === 'wechat_window_lost' ? 'fail' : 'pass',
                '微信小程序窗口',
                '检查目标小程序窗口是否可见、置前且仍停留在列表或详情页。',
                'check_wechat_window'
            );
            add(
                scenario === 'page_no_station_found' ? 'warn' : 'pass',
                '截图与页面识别',
                '确认截图成功、文本密度正常，并能识别场站卡片或详情字段。',
                'validate_screenshot_ocr'
            );
            add(
                scenario === 'page_no_station_found' || scenario === 'session_stalled' ? 'warn' : 'pass',
                '滚动脚本心跳',
                '检查滚动脚本是否仍在运行、取消标记是否生效、滚动距离和节奏是否合理。',
                'check_scroll_worker'
            );
            return diagnostics;
        }

        add('warn', '未知能力', '当前链路类型未识别，需要先确认任务配置。', 'validate_current_chain');
        return diagnostics;
    }

    static buildRepairPlan({ scenario, settings, currentChain, networkSettings }) {
        const fallbackChain = settings.autoFallbackEnabled
            ? this.findNextChain(settings.chainPriority, currentChain)
            : null;
        const repairPlan = [];

        const add = (code, title, description, automatic = true) => {
            repairPlan.push({ code, title, description, automatic });
        };

        switch (scenario) {
        case 'api_501_burst':
            add('validate_signed_params', '校验动态签名与请求参数', '检查当前模板里的 wsgsig/secdd、经纬度、分页、站点 ID 和时间类参数是否与当前请求匹配。');
            if (settings.autoTemplateSwitch) {
                add('validate_template_candidate', '校验候选模板', '优先在 API 能力内校验同平台候选模板，不切换到其他采集链路。');
            }
            if (settings.autoUaRotate) {
                add('rotate_user_agent', '轮换真实 UA', '自动改用另一条真实可信的 UA 组合后重试请求。');
            }
            if (settings.autoProxyRotate && networkSettings.enabled) {
                add('validate_or_rotate_proxy', '检测代理出口', '验证当前请求是否走代理；若代理不可用，再更换同类代理出口重试。');
            }
            if (settings.autoRefreshLearning) {
                add('refresh_learning', '补学习最新样本', '触发短时样本学习，刷新模板池里的最新请求样本。');
            }
            break;
        case 'api_empty_payload':
            add('validate_latest_request', '校验当前目标请求', '按当前目标位置重新发起模板请求，确认是否为分页、城市范围或参数改写问题。');
            add('validate_parser_mapping', '校验解析字段映射', '检查列表页和详情页的场站名、地址、枪型、闲忙枪数和分时价格字段是否命中。');
            if (settings.autoTemplateSwitch) {
                add('validate_template_candidate', '校验空响应模板', '在 API 模板池内复测候选样本，确认是否为分页、城市范围或参数改写问题。');
            }
            break;
        case 'har_not_recording':
            add('check_har_recording', '检查内置录包', '确认系统录包进程、代理监听、证书信任和目标域名过滤是否正常。');
            add('restart_har_recording', '重置内置录包', '自动停止并重新开启录制，同时重绑新的 HAR 会话文件。');
            add('clear_temp_export', '清理损坏导出文件', '剔除空 HAR、截断文件或无法解析的临时导出。');
            add('validate_har_parser', '复测 HAR 解析器', '使用最新非空 HAR 复测平台、接口、枪型、价格和闲忙字段解析。');
            break;
        case 'page_no_station_found':
            add('check_wechat_window', '确认微信窗口', '检查小程序窗口是否置前、未丢失焦点，并仍在目标列表或详情页。');
            add('recapture_screen', '重新截图识别', '重新采集当前页面截图并检查文本密度、卡片边界和字段位置。');
            add('adjust_scroll_rhythm', '调整滚动脚本', '缩短单次滚动距离并回滚一屏后重新识别，避免跳过场站卡片。');
            break;
        case 'session_stalled':
            if (settings.resumeFromBreakpoint) {
                add('resume_from_checkpoint', '从断点继续', '保留已完成平台、城市和场站进度，直接从卡住位置恢复。');
            }
            add('inspect_current_worker', '检查当前脚本心跳', '检查当前任务脚本、最近日志时间、队列游标和取消标记是否异常。');
            add('reset_window', '重建当前能力状态', '重新激活当前能力依赖的窗口、会话或模板上下文，再继续本轮任务。');
            break;
        case 'template_missing':
            if (settings.autoRefreshLearning) {
                add('learn_template', '自动补学习模板', '优先从最新系统 HAR 中补入可用模板。');
            }
            add('validate_template_scope', '校验模板范围', '检查平台、列表页、详情页、城市坐标和启用状态，避免可用模板被误判为缺失。');
            break;
        case 'proxy_blocked':
            if (settings.autoProxyRotate) {
                add('validate_or_rotate_proxy', '检测代理节点', '先确认当前请求是否真实走代理；代理不可用时再更换同类出口。');
            }
            add('recheck_network', '复测网络链路', '对新代理或直连链路做一次轻量连通性验证。');
            break;
        case 'wechat_window_lost':
            add('focus_wechat', '重新激活微信窗口', '将微信置前并回到目标小程序，恢复后续自动化动作。');
            add('reopen_list_page', '回到目标列表页', '若已偏离列表或详情页，自动按平台模板回到正确位置。');
            break;
        default:
            add('manual_check', '人工核查', '未命中特定场景，请保留最近日志、截图和请求摘要后人工复核。', false);
            break;
        }

        if (fallbackChain) {
            add(
                'fallback_chain_after_repair',
                `当前能力失败后兜底到${CHAIN_LABELS[fallbackChain]}`,
                `仅当当前能力完成上述修复后仍不可用，才允许改用 ${CHAIN_LABELS[fallbackChain]}。`
            );
        }

        if (repairPlan.length === 0) {
            add('manual_check', '人工核查', '当前场景没有可直接自动修复的动作，需要人工检查。', false);
        }

        return { fallbackChain, repairPlan };
    }

    static diagnose(payload = {}) {
        const settings = this.normalizeSettings(payload.settings || payload.selfHealSettings || {});
        const currentChain = String(payload.currentChain || 'api').trim().toLowerCase();
        const scenario = SCENARIO_MAP[payload.scenario] ? payload.scenario : 'api_501_burst';
        const scenarioMeta = SCENARIO_MAP[scenario];
        const networkSettings = payload.networkSettings || {};
        const attempt = normalizePositiveInt(payload.attempt, 1);
        const { fallbackChain, repairPlan } = this.buildRepairPlan({
            scenario,
            settings,
            currentChain,
            networkSettings
        });
        const capabilityDiagnostics = this.buildCapabilityDiagnostics({
            scenario,
            settings,
            currentChain,
            networkSettings,
            metrics: payload.metrics || payload.runtimeMetrics || {}
        });

        const automaticActions = repairPlan.filter(item => item.automatic);
        const requiresManual = (
            !settings.enabled
            || attempt >= settings.manualEscalationThreshold
            || automaticActions.length === 0
        );

        return {
            scenario,
            code: scenarioMeta.code,
            title: scenarioMeta.title,
            message: scenarioMeta.message,
            severity: scenarioMeta.severity,
            currentChain,
            currentChainLabel: CHAIN_LABELS[currentChain] || currentChain,
            nextChain: null,
            nextChainLabel: null,
            fallbackChain,
            fallbackChainLabel: fallbackChain ? CHAIN_LABELS[fallbackChain] : null,
            status: requiresManual ? 'manual_required' : 'recoverable',
            attempt,
            maxAttemptsPerRun: settings.maxAttemptsPerRun,
            automaticActionCount: automaticActions.length,
            capabilityDiagnostics,
            repairPlan,
            summary: requiresManual
                ? '已达到人工介入阈值，需要保留诊断信息后人工处理。'
                : `预计自动执行 ${automaticActions.length} 个当前能力修复动作，然后继续从${settings.resumeFromBreakpoint ? '断点' : '当前任务'}恢复。`,
            execution: this.buildExecutionHint({
                currentChain,
                requiresManual,
                repairPlan,
                settings,
                fallbackChain
            })
        };
    }

    static buildExecutionHint({ currentChain, requiresManual, repairPlan, settings, fallbackChain }) {
        if (requiresManual) {
            return {
                mode: 'manual_required',
                targetChain: null,
                targetChainLabel: null,
                canAutoContinue: false,
                message: '需要人工介入后再恢复任务。'
            };
        }

        return {
            mode: 'same_chain_repair',
            targetChain: currentChain,
            targetChainLabel: CHAIN_LABELS[currentChain] || currentChain,
            fallbackChain: fallbackChain || null,
            fallbackChainLabel: fallbackChain ? CHAIN_LABELS[fallbackChain] : null,
            canAutoContinue: Boolean(repairPlan.some(item => item.automatic)),
            message: fallbackChain
                ? `先修复 ${CHAIN_LABELS[currentChain] || currentChain}；仅当前能力仍失败时，才允许兜底到 ${CHAIN_LABELS[fallbackChain]}。`
                : `修复后继续使用 ${CHAIN_LABELS[currentChain] || currentChain}。`
        };
    }
}

module.exports = TaskSelfHealService;
