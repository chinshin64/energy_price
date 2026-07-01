'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const TemplatePreflightService = require('./template-preflight-service');
const { redactObject, isSensitiveKey, REDACTED } = require('./sensitive-redactor');
const { RequestFailureAnalyzer } = require('./request-failure-analyzer');

const REASONS = {
    template_missing: 'No API templates available',
    signature_corpus_missing: 'Signature corpus not found or empty',
    signature_corpus_expired: 'Signature corpus is expired and cannot be used for matching',
    live_request_material_missing: 'No live request material for current target',
    signed_template_target_mismatch: 'Template/corpus does not match target location',
    request_limit_exceeded: 'Request limit exceeded (maxPages=1, maxRequests=5, maxQps=1)',
    target_scope_required: 'Target scope (city/lat/lng) required',
    target_scope_violation: 'Request parameters violate target scope constraints',
    request_failed: 'API request failed',
    response_parse_failed: 'API response parse failed',
    no_data_returned: 'API returned no data',
    proxy_not_configured: 'METHOD3_UPSTREAM_PROXY is not configured; refusing to use an implicit outbound proxy',
    unknown_error: 'unknown error',
};

// Upstream proxy for outbound traffic. Do not use a hard-coded public proxy by default.
const UPSTREAM_PROXY = String(process.env.METHOD3_UPSTREAM_PROXY || '').trim();

// 强制限制
const MAX_PAGES = 1;
const MAX_REQUEST_COUNT = 5;
const MAX_QPS = 1;

class Method3Service {
    constructor(options = {}) {
        this.signatureProvider = options.signatureProvider || null;
        this.failureAnalyzer = options.failureAnalyzer || new RequestFailureAnalyzer({ config: options.aiAgentConfig || {} });
        this.preflightService = new TemplatePreflightService({
            signatureProvider: this.signatureProvider,
            templateDir: options.templateDir || path.join(__dirname, '../../data'),
        });
    }

    /**
     * GET /api/method3/status
     * 返回模板统计、语料统计、最近失败原因
     */
    getStatus(input = {}) {
        const templateStats = this.preflightService._countTemplates();
        let corpusStats = null;
        let lastFailureReason = null;
        let corpusReason = 'signature_corpus_missing';

        if (this.signatureProvider && typeof this.signatureProvider.getHealthStatus === 'function') {
            try {
                const health = this.signatureProvider.getHealthStatus();
                corpusStats = {
                    totalEntries: health.totalEntries,
                    entriesByCity: health.entriesByCity,
                    entriesByScope: health.entriesByScope,
                    corpusAgeDays: health.corpusAgeDays,
                    status: health.status,
                };
                corpusReason = health.totalEntries > 0 ? 'signature_corpus_ready' : 'signature_corpus_missing';
            } catch {
                corpusReason = 'signature_corpus_missing';
            }
        }

        const templateAvailable = Number(templateStats.list || 0) + Number(templateStats.detail || 0) > 0;
        const corpusAvailable = Boolean(corpusStats && Number(corpusStats.totalEntries || 0) > 0);
        const proxyConfigured = Boolean(UPSTREAM_PROXY);
        const hasTarget = Boolean(input.city && Number.isFinite(Number(input.lat)) && Number.isFinite(Number(input.lng)));
        let targetPreflight = null;
        let targetMatched = true;
        let targetReason = 'target_not_checked';

        if (hasTarget && templateAvailable && corpusAvailable) {
            targetPreflight = this.preflight(input);
            targetMatched = targetPreflight.status === 'matched';
            targetReason = targetMatched ? 'preflight_matched' : this._primaryFailureCode(targetPreflight);
        }

        const available = templateAvailable && corpusAvailable && proxyConfigured && (!hasTarget || targetMatched);
        const reason = !templateAvailable
            ? 'template_missing'
            : (!corpusAvailable
                ? 'signature_corpus_missing'
                : (!proxyConfigured
                    ? 'proxy_not_configured'
                    : (hasTarget && !targetMatched ? targetReason : 'ready')));

        return {
            success: available,
            available,
            reason,
            checks: {
                templates: {
                    status: templateAvailable ? 'ready' : 'unavailable',
                    reason: templateAvailable ? 'template_ready' : 'template_missing',
                },
                corpus: {
                    status: corpusAvailable ? 'ready' : 'unavailable',
                    reason: corpusReason,
                },
                outboundProxy: {
                    status: proxyConfigured ? 'configured' : 'unavailable',
                    reason: proxyConfigured ? 'proxy_configured' : 'proxy_not_configured',
                },
                ...(hasTarget ? {
                    targetPreflight: {
                        status: targetPreflight ? (targetMatched ? 'ready' : 'unavailable') : 'unavailable',
                        reason: targetReason,
                        preflightStatus: targetPreflight?.status || 'not_run',
                    }
                } : {}),
            },
            templateStats,
            corpusStats,
            targetPreflight,
            lastFailureReason,
            limits: {
                maxPages: MAX_PAGES,
                maxRequestCount: MAX_REQUEST_COUNT,
                maxQps: MAX_QPS,
            },
        };
    }

    /**
     * POST /api/method3/preflight
     * 只做模板和签名语料匹配预检，不发真实请求
     */
    preflight(input = {}) {
        const { platform, city, lat, lng, mode } = input;

        // 验证必填参数
        if (!city || !Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) {
            return {
                success: false,
                status: 'target_scope_required',
                templateStats: this.preflightService._countTemplates(),
                diagnostics: [{
                    code: 'target_scope_required',
                    message: REASONS.target_scope_required,
                }],
            };
        }

        return this.preflightService.preflight(input);
    }

    /**
     * POST /api/method3/run-basic-check
     * 只在 preflight matched 时执行小规模请求
     */
    async runBasicCheck(input = {}) {
        const { platform, city, lat, lng, mode } = input;

        // 1. 验证必填参数
        if (!city || !Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) {
            return this._withAgentAnalysis({
                success: false,
                reason: 'target_scope_required',
                message: REASONS.target_scope_required,
            }, { input, stage: 'target_scope_validation' });
        }

        // 2. 执行 preflight
        const preflightResult = this.preflight(input);
        if (preflightResult.status !== 'matched') {
            const reason = this._primaryFailureCode(preflightResult);
            return this._withAgentAnalysis({
                success: false,
                reason,
                status: preflightResult.status,
                message: REASONS[reason] || REASONS[preflightResult.status] || preflightResult.status,
                preflight: preflightResult,
            }, { input, stage: 'preflight', preflightResult });
        }

        // 3. 验证限制条件
        const requestedMaxPages = Number(input.maxPages ?? 1);
        const requestedMaxRequests = Number(input.maxRequestCount ?? 5);
        const requestedMaxQps = Number(input.maxQps ?? 1);

        if (requestedMaxPages > MAX_PAGES || requestedMaxRequests > MAX_REQUEST_COUNT || requestedMaxQps > MAX_QPS) {
            return this._withAgentAnalysis({
                success: false,
                reason: 'request_limit_exceeded',
                message: REASONS.request_limit_exceeded,
                limits: { maxPages: MAX_PAGES, maxRequestCount: MAX_REQUEST_COUNT, maxQps: MAX_QPS },
            }, { input, stage: 'request_limit' });
        }

        // 4. 尝试使用 signature provider 发请求
        if (!this.signatureProvider) {
            return this._withAgentAnalysis({
                success: false,
                reason: 'live_request_material_missing',
                message: 'Signature provider not configured',
                preflight: preflightResult,
            }, { input, stage: 'signature_provider', preflightResult });
        }

        // 5. 构造请求参数（使用语料中匹配的签名）
        const targetLat = Number(lat);
        const targetLng = Number(lng);
        const radiusKm = Number(input.radiusKm || input.maxDistanceKm || 0);
        const proxyContext = {
            lat: targetLat,
            lng: targetLng,
            city,
            ...(Number.isFinite(radiusKm) && radiusKm > 0 ? { radiusKm, maxDistanceKm: radiusKm } : {})
        };

        const listPattern = { platform: platform || 'didi-charging', baseUrl: 'https://energy.xiaojukeji.com/station-api/homepage/stationList', method: 'POST' };
        const detailPattern = { platform: platform || 'didi-charging', baseUrl: 'https://energy.xiaojukeji.com/station-api/station/getoneinfo', method: 'POST' };

        // 方式三不依赖实时请求参数，直接用 findListCandidates 找最近语料条目
        const candidates = this.signatureProvider.findListCandidates(listPattern, proxyContext);
        if (!candidates || candidates.length === 0) {
            return this._withAgentAnalysis({
                success: false,
                reason: 'signed_template_target_mismatch',
                message: 'No corpus entries match target within maxDistanceKm',
                preflight: preflightResult,
                diagnostics: [{
                    code: 'signed_template_target_mismatch',
                    message: 'No corpus entries match target within maxDistanceKm',
                    targetCoordinate: { lat: targetLat, lng: targetLng },
                    maxDistanceKm: this.signatureProvider.maxDistanceKm || 10,
                    mismatchFields: ['distance'],
                    repairSuggestion: '需要从当前目标重新采集请求语料',
                }],
            }, { input, stage: 'corpus_candidate_match', preflightResult });
        }
        const nearest = candidates[0];
        const nearestParams = nearest.params || nearest.queryParams || {};
        const nearestHeaders = nearest.headers || {};
        const nearestDistance = nearest.__distanceKm || 0;

        // 7. Execute bounded request through upstream proxy
        const redactedParams = this._redactRequestParams(nearestParams);
        const redactedHeaders = this._redactHeaders(nearestHeaders);

        const requestResult = await this._executeBoundedRequest({
            entry: nearest,
            targetLat,
            targetLng,
            city,
            radiusKm,
            nearestDistance,
            mode: mode || 'list',
            maxRequestCount: Math.min(requestedMaxRequests, MAX_REQUEST_COUNT),
        });

        const output = {
            success: requestResult.success,
            status: requestResult.success ? 'request_sent' : 'request_failed',
            reason: requestResult.success ? undefined : (requestResult.reason || 'request_failed'),
            preflight: {
                status: 'matched',
                matchedSample: preflightResult.matchedSample,
                nearestDistance,
            },
            request: {
                method: 'POST',
                url: 'https://energy.xiaojukeji.com/station-api/homepage/stationList',
                paramsReady: true,
                paramsPreview: redactedParams,
                headersPreview: redactedHeaders,
                sourceEntry: {
                    city: nearest.city,
                    distanceKm: nearestDistance,
                    scope: nearest.scope,
                    capturedAt: nearest.capturedAt || nearest.sourceTime,
                },
            },
            result: requestResult,
            limits: {
                maxPages: Math.min(requestedMaxPages, MAX_PAGES),
                maxRequestCount: Math.min(requestedMaxRequests, MAX_REQUEST_COUNT),
                maxQps: Math.min(requestedMaxQps, MAX_QPS),
            },
        };

        if (!output.success) {
            return this._withAgentAnalysis(output, {
                input,
                stage: 'bounded_request',
                preflightResult,
                nearest,
                requestResult,
                request: output.request,
            });
        }
        return output;
    }


    async _withAgentAnalysis(result, meta = {}) {
        if (!result || result.success) return result;
        try {
            const input = meta.input || {};
            const request = meta.request || {
                method: result.request?.method || 'POST',
                host: result.request?.url ? new URL(result.request.url).hostname : undefined,
                path: result.request?.url ? new URL(result.request.url).pathname : undefined,
                apiType: input.mode || 'list',
                city: input.city,
                lat: Number(input.lat),
                lng: Number(input.lng),
                querySummary: result.request?.paramsPreview || {},
                bodySummary: result.request?.paramsPreview || {},
                headersSummary: result.request?.headersPreview || {},
            };
            const firstAttempt = Array.isArray(meta.requestResult?.results) ? meta.requestResult.results.find(item => !item.ok) : null;
            const response = {
                httpStatus: firstAttempt?.status || result.result?.results?.[0]?.status || undefined,
                bodySummary: firstAttempt?.dataPreview || result.result?.results?.[0]?.dataPreview || {},
            };
            const analysisResult = await this.failureAnalyzer.analyzeFailure({
                source: 'method3',
                templateId: meta.nearest?.id || meta.preflightResult?.matchedSample?.id || undefined,
                request,
                response,
                error: {
                    reason: result.reason || 'unknown_error',
                    message: result.message || result.result?.error || '',
                },
                context: {
                    stage: meta.stage,
                    preflightStatus: meta.preflightResult?.status || result.preflight?.status || result.status,
                    mismatchFields: result.diagnostics?.flatMap(item => item.mismatchFields || []) || [],
                    diagnostics: result.diagnostics || meta.preflightResult?.diagnostics || [],
                    requestLimit: {
                        maxPages: MAX_PAGES,
                        maxRequestCount: MAX_REQUEST_COUNT,
                        maxQps: MAX_QPS,
                    },
                },
            });
            return {
                ...result,
                failureEventId: analysisResult.failureEventId,
                agentAnalysis: analysisResult.agentAnalysis,
                agentError: analysisResult.agentError,
                strategyPatch: analysisResult.strategyPatch,
            };
        } catch (err) {
            return {
                ...result,
                agentError: {
                    success: false,
                    reason: 'agent_analysis_exception',
                    message: err.message,
                },
            };
        }
    }

    async _executeBoundedRequest({ entry, targetLat, targetLng, city, radiusKm, nearestDistance, mode, maxRequestCount }) {
        const results = [];
        let successCount = 0;
        let failCount = 0;

        if (!UPSTREAM_PROXY) {
            return {
                success: false,
                reason: 'proxy_not_configured',
                totalAttempts: 0,
                successCount: 0,
                failCount: 0,
                results: [],
                error: REASONS.proxy_not_configured,
            };
        }

        try {
            const proxyUrl = 'http://' + UPSTREAM_PROXY;
            const agent = new HttpsProxyAgent(proxyUrl);

            // Construct request from corpus entry
            const url = entry.baseUrl || 'https://energy.xiaojukeji.com/station-api/homepage/stationList';
            const method = (entry.method || 'POST').toUpperCase();

            // Build query params
            const queryParams = { ...(entry.queryParams || {}) };
            // Build body params. Some signatures bind the full request payload; when the
            // signed sample is still inside the requested radius, replay the signed
            // coordinate instead of silently invalidating wsgsig with a new center point.
            const bodyParams = { ...(entry.bodyParams || {}) };
            const preserveSignedCoordinate = this._shouldPreserveSignedCoordinate(entry, {
                radiusKm,
                nearestDistance
            });
            if (!preserveSignedCoordinate && targetLat && targetLng) {
                bodyParams.lat = targetLat;
                bodyParams.lng = targetLng;
                bodyParams.userlat = targetLat;
                bodyParams.userlng = targetLng;
            }
            bodyParams.pageNo = 1;
            bodyParams.pageSize = 10;

            // Build headers
            const headers = { ...(entry.headers || {}) };
            headers['content-type'] = 'application/json';

            const requestCount = Math.min(maxRequestCount, MAX_REQUEST_COUNT);

            for (let i = 0; i < requestCount; i++) {
                try {
                    const axiosConfig = {
                        method,
                        url,
                        params: queryParams,
                        data: bodyParams,
                        headers,
                        httpsAgent: agent,
                        timeout: 10000,
                        validateStatus: () => true, // accept any status
                    };

                    const response = await axios(axiosConfig);
                    const isOk = response.status >= 200 && response.status < 300;
                    const responseData = response.data;

                    // Redact sensitive fields from response
                    const redactedData = redactObject(
                        typeof responseData === 'object' ? responseData : { raw: String(responseData).substring(0, 200) }
                    );

                    results.push({
                        attempt: i + 1,
                        status: response.status,
                        ok: isOk,
                        dataSize: JSON.stringify(responseData).length,
                        dataPreview: redactedData,
                        upstreamProxy: this._redactProxy(UPSTREAM_PROXY),
                        coordinateStrategy: preserveSignedCoordinate ? 'preserve_signed_sample' : 'target_center',
                        effectiveCoordinate: preserveSignedCoordinate
                            ? {
                                lat: Number(entry.lat),
                                lng: Number(entry.lng),
                                distanceKmFromTarget: nearestDistance
                            }
                            : { lat: targetLat, lng: targetLng }
                    });

                    if (isOk) successCount++;
                    else failCount++;

                    // Rate limit: 1 QPS
                    if (i < requestCount - 1) {
                        await new Promise(r => setTimeout(r, 1000));
                    }
                } catch (err) {
                    results.push({
                        attempt: i + 1,
                        status: 0,
                        ok: false,
                        error: err.code || 'request_failed',
                    });
                    failCount++;
                }
            }

            return {
                success: successCount > 0,
                reason: successCount > 0 ? undefined : 'request_failed',
                totalAttempts: requestCount,
                successCount,
                failCount,
                results,
            };
        } catch (err) {
            return {
                success: false,
                reason: 'request_failed',
                totalAttempts: 0,
                successCount: 0,
                failCount: 0,
                results: [],
                error: err.code || 'request_failed',
            };
        }
    }

    _primaryFailureCode(preflightResult = {}) {
        const firstDiagnosticCode = Array.isArray(preflightResult.diagnostics)
            ? preflightResult.diagnostics.find(item => item && item.code)?.code
            : '';
        return firstDiagnosticCode || preflightResult.reason || preflightResult.status || 'unknown_error';
    }

    _redactRequestParams(params) {
        if (!params) return null;
        return redactObject(params);
    }

    _redactHeaders(headers) {
        if (!headers) return null;
        return redactObject(headers);
    }

    _redactProxy(proxy = '') {
        const value = String(proxy || '').trim();
        if (!value) return '';
        return value.replace(/^[^@]+@/, '***:***@');
    }

    _shouldPreserveSignedCoordinate(entry = {}, context = {}) {
        const hasBoundSignature = Boolean(entry.queryParams?.wsgsig || entry.bodyParams?.wsgsig);
        if (!hasBoundSignature) return false;
        const radiusKm = Number(context.radiusKm || 0);
        const distanceKm = Number(context.nearestDistance);
        if (!Number.isFinite(radiusKm) || radiusKm <= 0) return false;
        return Number.isFinite(distanceKm) && distanceKm <= radiusKm;
    }
}

Method3Service.REASONS = REASONS;
Method3Service.LIMITS = { MAX_PAGES, MAX_REQUEST_COUNT, MAX_QPS };

module.exports = Method3Service;
