'use strict';

const fs = require('node:fs');
const express = require('express');

function normalizeCollectTargets(rawTargets = []) {
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

function normalizeCaptureFilters(input = {}) {
    const raw = input && typeof input === 'object' ? input : {};
    return {
        hosts: normalizeFilterList(raw.hosts || raw.host || raw.domains || raw.domain || ''),
        ips: normalizeFilterList(raw.ips || raw.ip || '')
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

function mergeUniqueLists(...lists) {
    return normalizeFilterList(lists.flat());
}

const DIDI_METHOD2_TRAFFIC_POLICY = {
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
        targetList: normalizeCollectTargets(rawTargets)
    };
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

function countHarEntries(harPath) {
    try {
        const payload = JSON.parse(fs.readFileSync(harPath, 'utf8'));
        return Array.isArray(payload?.log?.entries) ? payload.log.entries.length : 0;
    } catch (error) {
        return 0;
    }
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

function createSmartCollectRouter(options = {}) {
    const smartController = options.smartController;
    const captureRecorderService = options.captureRecorderService;
    const harParser = options.harParser;
    const stationModel = options.stationModel;
    const smartCrawler = options.smartCrawler;
    const apiTemplateModel = options.apiTemplateModel;
    const appSettingModel = options.appSettingModel;
    const taskSelfHealService = options.taskSelfHealService;
    const aiFeaturesEnabled = Boolean(options.aiFeaturesEnabled);
    const buildAiFeatureStatus = typeof options.buildAiFeatureStatus === 'function'
        ? options.buildAiFeatureStatus
        : () => ({ enabled: aiFeaturesEnabled });
    const findMissingRuntimePlatform = typeof options.findMissingRuntimePlatform === 'function'
        ? options.findMissingRuntimePlatform
        : () => null;
    const logger = options.logger || console;

    if (!smartController || !captureRecorderService || !harParser || !stationModel
        || !smartCrawler || !apiTemplateModel || !appSettingModel || !taskSelfHealService) {
        throw new TypeError('smart collect router dependencies are required');
    }

    const router = express.Router();
    const captureAnalysisPromises = new Map();

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

    function startCaptureSession(platformList = [], targetList = [], captureFilters = {}) {
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

    function stopCaptureSession(sessionId, reason = 'finish') {
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
        return apiTemplateModel.saveBatch(templates);
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
                ? stationModel.insertBatch(stations)
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

    async function analyzeCaptureSession(sessionId, captureSession, reason = 'finish') {
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

    router.post('/smart-collect/preflight', async (req, res) => {
        const { platformList, targetList } = resolveCollectPlatformsAndTargets(req.body);

        try {
            const result = await smartController.runAutomationPreflight(platformList, {
                cities: targetList,
                collectionMode: 'har'
            });
            const capturePreflight = buildCaptureRecorderPreflight();
            const selfHealPreflight = aiFeaturesEnabled
                ? taskSelfHealService.buildPreflight({
                    platforms: platformList,
                    cities: targetList,
                    settings: appSettingModel.getSelfHealSettings(),
                    networkSettings: appSettingModel.getProxySettings()
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

    router.post('/page-collect/preflight', async (req, res) => {
        const { platformList, targetList: cityList } = resolveCollectPlatformsAndTargets(req.body);
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

    router.post('/smart-collect/start', async (req, res) => {
        const body = req.body || {};
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
        } = body;
        const platformList = platforms || (platform ? [platform] : []);

        if (!Array.isArray(platformList) || platformList.length === 0) {
            return res.status(400).json({ success: false, error: 'platforms required' });
        }

        const missingPlatform = findMissingRuntimePlatform(platformList);
        if (missingPlatform) {
            return res.status(404).json({ success: false, error: `Platform not found: ${missingPlatform}` });
        }

        const targetList = normalizeCollectTargets(
            targets || targetLocations || landmarks || keywords || targetCities || cities || city || []
        );
        if (targetList.length === 0) {
            return res.status(400).json({ success: false, error: 'targets required' });
        }

        let captureSession = null;
        try {
            captureSession = startCaptureSession(platformList, targetList, captureFilters || {});
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
            return res.json({ ...result, captureSession });
        } catch (error) {
            if (captureSession) {
                try {
                    captureRecorderService.stopSession();
                } catch (stopError) {
                    logger.warn?.('启动方式二失败后停止内置录包失败:', stopError.message);
                }
            }
            return res.status(error.statusCode || 500).json({
                success: false,
                code: error.code || 'smart_collect_start_failed',
                error: error.message,
                recorderStatus: error.recorderStatus
            });
        }
    });

    router.post('/page-collect/start', async (req, res) => {
        const body = req.body || {};
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
        } = body;
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

    router.post('/smart-collect/scroll', async (req, res) => {
        const { sessionId, scrollCount, scrollInterval } = req.body || {};

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

    router.get('/smart-collect/status/:sessionId', (req, res) => {
        try {
            const session = smartController.getSession(req.params.sessionId);
            if (!session) {
                return res.status(404).json({ success: false, error: 'Session not found' });
            }
            return res.json({ success: true, data: session });
        } catch (error) {
            return res.status(500).json({ success: false, error: error.message });
        }
    });

    router.post('/smart-collect/finish', async (req, res) => {
        const { sessionId } = req.body || {};

        if (!sessionId) {
            return res.status(400).json({ success: false, error: 'sessionId required' });
        }

        try {
            const result = smartController.requestFinishSession(sessionId);
            const captureSession = result.success ? stopCaptureSession(sessionId, 'finish') : null;
            const captureAnalysis = captureSession
                ? await analyzeCaptureSession(sessionId, captureSession, 'finish')
                : null;
            return res.json({ ...result, captureSession: captureAnalysis?.captureSession || captureSession, captureAnalysis });
        } catch (error) {
            return res.status(500).json({ success: false, error: error.message });
        }
    });

    router.get('/smart-collect/sessions', (req, res) => {
        try {
            const sessions = smartController.getActiveSessions();
            res.json({ success: true, data: sessions });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    router.post('/smart-collect/cancel', async (req, res) => {
        const { sessionId } = req.body || {};

        if (!sessionId) {
            return res.status(400).json({ success: false, error: 'sessionId required' });
        }

        try {
            const result = smartController.cancelSession(sessionId);
            const captureSession = result.success ? stopCaptureSession(sessionId, 'cancel') : null;
            const captureAnalysis = captureSession
                ? await analyzeCaptureSession(sessionId, captureSession, 'cancel')
                : null;
            return res.json({ ...result, captureSession: captureAnalysis?.captureSession || captureSession, captureAnalysis });
        } catch (error) {
            return res.status(500).json({ success: false, error: error.message });
        }
    });

    return {
        router,
        analyzeCaptureSession,
        stopCaptureSession,
        buildCaptureRecorderPreflight,
        startCaptureSession
    };
}

module.exports = {
    buildCaptureHealth,
    buildSmartCollectTrafficPolicy,
    createSmartCollectRouter,
    inspectHarBusinessSignals,
    normalizeCaptureFilters,
    normalizeCollectTargets,
    normalizeFilterList,
    resolveCollectPlatformsAndTargets
};
