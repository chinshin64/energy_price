'use strict';

const fs = require('fs');
const path = require('path');
const CaptureRecorder = require('./capture-recorder');
const { summarizeRedactedEntry, redactUrl, REDACTED, isSensitiveKey } = require('./sensitive-redactor');
const { RequestFailureAnalyzer } = require('./request-failure-analyzer');
const HarParser = require('../parser/har-parser');
const StationModel = require('../models/station');

// 请求采集关注的目标业务主机列表
const TARGET_HOSTS = [
    'energy.xiaojukeji.com',
    'api.xiaojukeji.com',
    'didiglobal.com',
    'xiaojukeji.com',
];

const REASONS = {
    mitmdump_missing: '请求记录组件未就绪，请联系运维补齐记录组件',
    recorder_start_failed: '请求记录服务启动失败',
    recorder_stop_failed: '请求记录服务停止失败',
    recorder_already_running: '已有请求记录会话正在运行，请先停止后再重试',
    proxy_not_configured: '网络出口未配置，请按当前记录会话提示完成设置',
    page_automation_unavailable: '页面操作服务未配置，无法自动操控小程序',
    page_operation_failed: '小程序页面操作失败',
    no_request_captured: '本次会话没有记录到请求',
    no_target_request_detected: '本次会话没有发现目标业务请求',
    har_not_found: '请求记录文件未生成',
    har_parse_failed: '请求记录解析失败',
    har_import_failed: '请求记录已解析但入库失败',
    har_output_unwritable: '请求记录保存目录不可写',
    certificate_not_trusted: '证书信任状态不满足解析要求，请联系运维处理',
    tls_not_decryptable: '加密请求无法解析，请检查证书信任链路',
    unknown_error: '未知错误',
};

class Method2Service {
    constructor(options = {}) {
        this.recorder = options.recorder || new CaptureRecorder(options.recorderOptions || {});
        this.targetHosts = options.targetHosts || TARGET_HOSTS;
        this.failureAnalyzer = options.failureAnalyzer || new RequestFailureAnalyzer({ config: options.aiAgentConfig || {} });
        this.harParser = options.harParser || new HarParser();
        this.stationModel = options.stationModel || StationModel;
        this.pageAutomation = options.pageAutomation || null;
    }

    setAiAgentConfig(config = {}) {
        this.failureAnalyzer = new RequestFailureAnalyzer({ config });
        return this.failureAnalyzer.getStatus();
    }

    /**
     * 返回请求记录、网络出口和保存目录状态
     */
    getStatus() {
        const recorderStatus = this.recorder.getStatus();
        const harWritable = this._isDirWritable(this.recorder.dataDir);
        const mitmdumpReady = Boolean(recorderStatus.available);
        const recorderRunning = recorderStatus.activeSession?.status === 'running';
        const available = mitmdumpReady && harWritable;
        const reason = !mitmdumpReady
            ? 'mitmdump_missing'
            : (!harWritable ? 'har_output_unwritable' : 'ready');

        const checks = {
            mitmdump: {
                status: mitmdumpReady ? 'ready' : 'unavailable',
                reason: mitmdumpReady ? 'mitmdump_ready' : 'mitmdump_missing',
                binary: recorderStatus.binary || null,
            },
            recorder: {
                status: recorderRunning ? 'running' : 'ready',
                reason: recorderRunning ? 'recorder_running' : 'recorder_ready',
                activeSession: recorderStatus.activeSession
                    ? {
                        id: recorderStatus.activeSession.id,
                        status: recorderStatus.activeSession.status,
                        startedAt: recorderStatus.activeSession.startedAt,
                        listenHost: recorderStatus.activeSession.listenHost,
                        listenPort: recorderStatus.activeSession.listenPort,
                    }
                    : null,
                recentCount: recorderStatus.recentSessions?.length || 0,
            },
            proxy: {
                status: recorderRunning ? 'configured' : 'unknown',
                reason: recorderRunning ? 'proxy_configured' : 'proxy_not_checked',
                listenHost: recorderStatus.activeSession?.listenHost || null,
                listenPort: recorderStatus.activeSession?.listenPort || null,
            },
            harOutput: {
                status: harWritable ? 'ready' : 'unavailable',
                reason: harWritable ? 'har_output_ready' : 'har_output_unwritable',
                dir: this.recorder.dataDir,
                writable: harWritable,
            },
        };

        return {
            success: available,
            available,
            reason,
            checks,
            // 兼容旧前端 / 旧调试脚本字段
            mitmdump: {
                available: recorderStatus.available,
                binary: recorderStatus.binary || null,
                ...checks.mitmdump,
            },
            recorder: checks.recorder,
            proxy: {
                configured: recorderRunning,
                listenHost: recorderStatus.activeSession?.listenHost || null,
                listenPort: recorderStatus.activeSession?.listenPort || null,
                ...checks.proxy,
            },
            harOutput: {
                dir: this.recorder.dataDir,
                writable: harWritable,
                ...checks.harOutput,
            },
        };
    }

    getWorkflowReadiness(input = {}) {
        const status = this.getStatus();
        const checks = status.checks || {};
        const captureDiagnostics = this._buildCaptureDiagnostics(status);
        const stage = this._workflowStageForReason(status.reason, captureDiagnostics);
        const diagnostics = this._workflowDiagnosticsFromChecks(checks, status.reason);

        return {
            success: Boolean(status.available),
            available: Boolean(status.available),
            stage,
            reason: status.reason || 'unknown_error',
            nextAction: this._workflowNextAction(status.reason, stage, captureDiagnostics),
            diagnostics,
            checks,
            captureDiagnostics,
            targetHosts: input.targetHosts || this.targetHosts
        };
    }

    /**
     * POST /api/method2/start-capture
     * 启动请求记录，返回 sessionId、listenHost、listenPort、outputPath、proxyTips
     */
    startCapture(input = {}) {
        // 检查请求记录组件
        const status = this.recorder.getStatus();
        if (!status.available) {
            return {
                success: false,
                reason: 'mitmdump_missing',
                message: REASONS.mitmdump_missing,
            };
        }

        try {
            const session = this.recorder.startSession({
                listenHost: input.listenHost,
                listenPort: input.listenPort,
                label: input.label || 'method2-capture',
                scope: input.scope || 'method2',
                platforms: input.platforms || ['didi-charging'],
                cities: input.cities || [],
                filterHosts: input.filterHosts || '',
                filterIps: input.filterIps || '',
                overrideCity: input.city || input.overrideCity || '',
                overrideLat: input.lat || input.overrideLat || 0,
                overrideLng: input.lng || input.overrideLng || 0,
                upstreamProxy: input.upstreamProxy || '',
                manageSystemProxy: Boolean(input.manageSystemProxy || input.autoSystemProxy || input.configureSystemProxy),
                proxyServices: input.proxyServices,
                targets: Array.isArray(input.targets) ? input.targets : [],
                trafficPolicy: input.trafficPolicy || input.policy || {},
            });

            return {
                success: true,
                sessionId: session.id,
                listenHost: session.listenHost,
                listenPort: session.listenPort,
                outputPath: session.harPath,
                proxyTips: this._buildProxyTips(session),
                locationOverride: session.locationOverride || null,
                upstreamProxy: session.upstreamProxy || null,
            };
        } catch (err) {
            return {
                success: false,
                reason: 'recorder_start_failed',
                message: REASONS.recorder_start_failed,
            };
        }
    }

    /**
     * POST /api/method2/stop-and-analyze
     * 停止请求记录，生成记录文件，解析后返回请求摘要
     */
    async stopAndAnalyze(input = {}) {
        // 检查活跃会话
        const active = this.recorder.getActiveSession();
        if (!active || active.status !== 'running') {
            return this._withAgentAnalysis({
                success: false,
                reason: 'no_request_captured',
                message: 'No active capture session to stop',
            }, { stage: 'stop_and_analyze' });
        }

        const sessionId = active.id;
        const harPath = active.harPath;

        // 停止请求记录
        let stopResult;
        try {
            stopResult = this.recorder.stopSession();
        } catch (err) {
            return this._withAgentAnalysis({
                success: false,
                reason: 'recorder_stop_failed',
                message: REASONS.recorder_stop_failed,
                sessionId,
            }, { sessionId, stage: 'stop_recorder' });
        }

        // 等待请求记录文件写入
        const harReady = await this._waitForFile(harPath, 10000);

        // 检查文件是否真正就绪
        if (!fs.existsSync(harPath)) {
            return this._withAgentAnalysis({
                success: false,
                reason: 'har_not_found',
                message: '请求记录文件未在停止记录后生成',
                sessionId,
            }, { sessionId, harPath, stage: 'har_write_check' });
        }
        if (!harReady) {
            return this._withAgentAnalysis({
                success: false,
                reason: 'har_parse_failed',
                message: '请求记录文件已生成但尚未完成写入，请稍后重试',
                sessionId,
                harPath,
            }, { sessionId, harPath, stage: 'har_flush_wait' });
        }

        // 解析请求记录
        return this._analyzeHarFile(harPath, sessionId, input);
    }

    /**
     * POST /api/method2/analyze-har
     * 分析已有请求记录文件
     */
    async analyzeHar(input = {}) {
        const harPath = input.harPath;
        if (!harPath || !fs.existsSync(harPath)) {
            return this._withAgentAnalysis({
                success: false,
                reason: 'har_not_found',
                message: REASONS.har_not_found,
            }, { harPath, stage: 'analyze_har' });
        }
        // 路径白名单校验：只允许请求记录会话目录下的文件
        const allowedDir = this.recorder.dataDir;
        const resolved = path.resolve(harPath);
        const allowedResolved = path.resolve(allowedDir);
        if (resolved !== allowedResolved && !resolved.startsWith(allowedResolved + path.sep)) {
            return this._withAgentAnalysis({
                success: false,
                reason: 'har_not_found',
                message: '请求记录文件不在允许目录内',
            }, { harPath, stage: 'analyze_har_path_guard' });
        }
        return this._analyzeHarFile(harPath, null, input);
    }

    /**
     * POST /api/method2/run-auto-capture
     * 启动请求记录，自动操控已授权的电脑端微信小程序，停止记录并解析入库。
     */
    async runAutoCapture(input = {}) {
        const platform = this._normalizePlatform(input.platform || input.platformId);
        const targets = this._normalizeTargets(input.targets || input.cities || input.city || input.targetCity || []);
        const startedAt = new Date().toISOString();
        const activeBefore = this.recorder.getActiveSession();
        if (activeBefore?.status === 'running') {
            return this._withAgentAnalysis({
                success: false,
                reason: 'recorder_already_running',
                message: REASONS.recorder_already_running,
                capture: { activeSession: activeBefore },
                operation: null,
                analysis: null,
            }, { stage: 'auto_capture_preflight' });
        }

        const pageReadiness = await this._getPageReadiness(platform);
        if (!pageReadiness.available) {
            return this._withAgentAnalysis({
                success: false,
                reason: pageReadiness.reason || 'page_operation_failed',
                message: pageReadiness.message || REASONS.page_operation_failed,
                pageReadiness,
                capture: null,
                operation: null,
                analysis: null,
            }, { stage: 'page_readiness' });
        }

        let capture = null;
        let operation = null;
        let analysis = null;
        try {
            capture = this.startCapture({
                ...input,
                label: input.label || 'method2-auto-capture',
                scope: 'method2-auto-capture',
                platforms: [platform],
                cities: targets,
                targets,
                manageSystemProxy: input.manageSystemProxy !== false,
                autoSystemProxy: input.manageSystemProxy !== false,
            });
            if (!capture.success) {
                return this._withAgentAnalysis({
                    success: false,
                    reason: capture.reason || 'recorder_start_failed',
                    message: capture.message || REASONS.recorder_start_failed,
                    capture,
                    operation: null,
                    analysis: null,
                }, { stage: 'start_auto_capture' });
            }

            operation = await this._operateMiniProgram({
                platform,
                targets,
                ...input,
            });
            await this._sleep(Math.max(0, Number(input.afterOperationWaitMs) || 1500));
            analysis = await this.stopAndAnalyze({
                ...input,
                writeToDb: input.writeToDb !== false,
            });

            const importSummary = analysis?.importSummary || null;
            const success = Boolean(
                capture.success
                && operation?.success
                && analysis?.success
                && (!importSummary || importSummary.success !== false)
            );
            const reason = success
                ? 'auto_capture_import_completed'
                : (operation?.reason || analysis?.reason || importSummary?.reason || 'page_operation_failed');
            return {
                success,
                reason,
                startedAt,
                completedAt: new Date().toISOString(),
                platform,
                targets,
                capture,
                pageReadiness,
                operation,
                analysis,
                importSummary,
            };
        } catch (err) {
            const active = this.recorder.getActiveSession();
            if (active?.status === 'running' && (!capture?.sessionId || active.id === capture.sessionId)) {
                try {
                    this.recorder.stopSession();
                } catch {}
            }
            return this._withAgentAnalysis({
                success: false,
                reason: 'page_operation_failed',
                message: err.message,
                startedAt,
                completedAt: new Date().toISOString(),
                platform,
                targets,
                capture,
                operation,
                analysis,
            }, { stage: 'auto_capture_exception' });
        }
    }

    /**
     * 核心解析逻辑
     */
    async _analyzeHarFile(harPath, sessionId, analyzeOptions) {
        const options = Array.isArray(analyzeOptions)
            ? { targetHosts: analyzeOptions }
            : (analyzeOptions || {});
        const targetHosts = options.targetHosts || this.targetHosts;

        if (!fs.existsSync(harPath)) {
            return this._withAgentAnalysis({
                success: false,
                reason: 'har_not_found',
                message: REASONS.har_not_found,
                sessionId,
            }, { sessionId, harPath, stage: 'analyze_har_file' });
        }

        let har;
        try {
            const content = fs.readFileSync(harPath, 'utf8');
            har = JSON.parse(content);
        } catch (err) {
            return this._withAgentAnalysis({
                success: false,
                reason: 'har_parse_failed',
                message: REASONS.har_parse_failed,
                sessionId,
            }, { sessionId, harPath, stage: 'parse_har' });
        }

        const entries = har.log?.entries || [];
        if (entries.length === 0) {
            return this._withAgentAnalysis({
                success: false,
                reason: 'no_request_captured',
                message: REASONS.no_request_captured,
                sessionId,
                harPath,
            }, { sessionId, harPath, stage: 'empty_har' });
        }

        // 生成脱敏摘要
        const requests = entries.map(entry => summarizeRedactedEntry(entry, targetHosts));
        const targetRequests = requests.filter(r => r.isTarget);

        if (targetRequests.length === 0) {
            return this._withAgentAnalysis({
                success: false,
                reason: 'no_target_request_detected',
                message: REASONS.no_target_request_detected,
                sessionId,
                harPath,
                summary: {
                    totalRequests: entries.length,
                    targetRequests: 0,
                    hosts: this._collectHosts(entries),
                    apiPaths: [],
                    fieldSummary: [],
                },
                requests: [],
            }, {
                sessionId,
                harPath,
                stage: 'target_filter',
                context: {
                    totalRequests: entries.length,
                    hosts: this._collectHosts(entries),
                    targetHosts,
                }
            });
        }

        // 统计字段摘要
        const fieldSummary = this._buildFieldSummary(targetRequests);

        const importSummary = options.writeToDb === false
            ? {
                enabled: false,
                success: true,
                stationCount: 0,
                insertedCount: 0,
                skippedCount: 0,
                message: '请求记录入库已按请求跳过'
            }
            : await this._parseAndImportHar(harPath, sessionId, options);

        return {
            success: true,
            sessionId,
            harPath,
            summary: {
                totalRequests: entries.length,
                targetRequests: targetRequests.length,
                hosts: this._collectHosts(entries),
                apiPaths: [...new Set(targetRequests.map(r => r.path).filter(Boolean))],
                fieldSummary,
            },
            requests: targetRequests,
            importSummary,
        };
    }


    async _withAgentAnalysis(result, meta = {}) {
        if (!result || result.success) return result;
        try {
            const analysisResult = await this.failureAnalyzer.analyzeFailure({
                source: 'method2',
                request: {
                    apiType: 'capture',
                    targetHosts: meta.context?.targetHosts || this.targetHosts,
                },
                response: {
                    summary: result.summary || meta.context || {},
                },
                error: {
                    reason: result.reason || 'unknown_error',
                    message: result.message || '',
                },
                context: {
                    stage: meta.stage,
                    sessionId: meta.sessionId || result.sessionId,
                    harPath: meta.harPath || result.harPath,
                    ...(meta.context || {}),
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

    _buildProxyTips(session) {
        return [
            `设置系统网络出口: ${session.listenHost === '0.0.0.0' ? '127.0.0.1' : session.listenHost}:${session.listenPort}`,
            '或按浏览器网络出口配置指向上述地址',
            '电脑端微信小程序会使用系统网络出口',
            '首次使用需完成证书信任配置',
        ];
    }

    async _getPageReadiness(platform) {
        if (!this.pageAutomation) {
            return {
                success: false,
                available: false,
                reason: 'page_automation_unavailable',
                message: REASONS.page_automation_unavailable,
            };
        }
        if (typeof this.pageAutomation.getWorkflowReadiness === 'function') {
            return this.pageAutomation.getWorkflowReadiness({ platform });
        }
        if (typeof this.pageAutomation.getStatus === 'function') {
            return this.pageAutomation.getStatus({ platform });
        }
        return {
            success: false,
            available: false,
            reason: 'page_automation_unavailable',
            message: REASONS.page_automation_unavailable,
        };
    }

    async _operateMiniProgram(input = {}) {
        if (!this.pageAutomation) {
            return {
                success: false,
                available: false,
                reason: 'page_automation_unavailable',
                message: REASONS.page_automation_unavailable,
                trace: [],
            };
        }

        const platform = this._normalizePlatform(input.platform);
        const targets = this._normalizeTargets(input.targets || input.cities || input.city || input.targetCity || []);
        const trace = [];
        const target = targets[0] || '';

        if (target && input.switchCity !== false && typeof this.pageAutomation.switchCityAction === 'function') {
            const switchResult = await this.pageAutomation.switchCityAction({
                platform,
                city: target,
                targetCity: target,
            });
            trace.push({
                action: 'switch-city',
                target,
                success: Boolean(switchResult.success),
                reason: switchResult.reason || '',
                actionTrace: switchResult.actionTrace || [],
            });
            if (!switchResult.success && input.continueOnPageOperationFailure !== true) {
                return {
                    success: false,
                    available: false,
                    reason: switchResult.reason || 'page_operation_failed',
                    target,
                    trace,
                    switchResult,
                };
            }
        } else if (typeof this.pageAutomation.observeAction === 'function') {
            const observeResult = await this.pageAutomation.observeAction({ platform });
            trace.push({
                action: 'observe',
                success: Boolean(observeResult.success),
                reason: observeResult.reason || '',
                observation: observeResult.observation || null,
            });
            if (!observeResult.success && input.continueOnPageOperationFailure !== true) {
                return {
                    success: false,
                    available: false,
                    reason: observeResult.reason || 'page_operation_failed',
                    target,
                    trace,
                    observeResult,
                };
            }
        }

        if (typeof this.pageAutomation.runAdaptive === 'function') {
            const adaptiveResult = await this.pageAutomation.runAdaptive({
                platform,
                goal: input.goal || 'station_list_scroll',
                limits: {
                    maxSteps: Math.min(Math.max(1, Number(input.maxSteps || input.limits?.maxSteps || 20)), 50),
                    maxScrolls: Math.min(Math.max(0, Number(input.maxScrolls || input.limits?.maxScrolls || 5)), 10),
                    maxDurationSeconds: Math.min(Math.max(10, Number(input.maxDurationSeconds || input.limits?.maxDurationSeconds || 180)), 600),
                },
            });
            trace.push({
                action: 'run-adaptive',
                success: Boolean(adaptiveResult.success),
                reason: adaptiveResult.reason || '',
                summary: adaptiveResult.summary || {},
                actionTrace: adaptiveResult.actionTrace || [],
            });
            if (!adaptiveResult.success && input.continueOnPageOperationFailure !== true) {
                return {
                    success: false,
                    available: false,
                    reason: adaptiveResult.reason || 'page_operation_failed',
                    target,
                    trace,
                    adaptiveResult,
                };
            }
        } else if (typeof this.pageAutomation.scrollAction === 'function') {
            const maxScrolls = Math.min(Math.max(1, Number(input.maxScrolls || 3)), 10);
            for (let index = 0; index < maxScrolls; index += 1) {
                const scrollResult = await this.pageAutomation.scrollAction({ platform });
                trace.push({
                    action: 'scroll',
                    index: index + 1,
                    success: Boolean(scrollResult.success),
                    reason: scrollResult.reason || '',
                });
                if (!scrollResult.success && input.continueOnPageOperationFailure !== true) {
                    return {
                        success: false,
                        available: false,
                        reason: scrollResult.reason || 'page_operation_failed',
                        target,
                        trace,
                        scrollResult,
                    };
                }
                await this._sleep(Math.max(0, Number(input.scrollIntervalMs) || 1200));
            }
        }

        return {
            success: true,
            available: true,
            reason: 'page_operation_completed',
            target,
            trace,
        };
    }

    async _parseAndImportHar(harPath, sessionId, options = {}) {
        if (!this.harParser || typeof this.harParser.parseSessionFile !== 'function') {
            return {
                enabled: false,
                success: false,
                reason: 'har_import_failed',
                message: '请求记录解析器未配置',
                stationCount: 0,
                insertedCount: 0,
                skippedCount: 0,
            };
        }
        try {
            const stations = await this.harParser.parseSessionFile(harPath);
            const insertResult = stations.length > 0 && this.stationModel?.insertBatch
                ? this.stationModel.insertBatch(stations)
                : { successCount: 0, skipCount: 0, redCount: 0, yellowCount: 0 };
            return {
                enabled: true,
                success: true,
                sessionId,
                harPath,
                stationCount: stations.length,
                insertedCount: insertResult.successCount || 0,
                skippedCount: insertResult.skipCount || 0,
                yellowCount: insertResult.yellowCount || 0,
                redCount: insertResult.redCount || 0,
                writeToDb: options.writeToDb !== false,
            };
        } catch (err) {
            return {
                enabled: true,
                success: false,
                reason: 'har_import_failed',
                message: err.message,
                sessionId,
                harPath,
                stationCount: 0,
                insertedCount: 0,
                skippedCount: 0,
            };
        }
    }

    _normalizePlatform(value) {
        return String(value || 'didi-charging').trim() || 'didi-charging';
    }

    _normalizeTargets(value) {
        const source = Array.isArray(value) ? value : String(value || '').split(/[\n,，;；|]/);
        return Array.from(new Set(
            source
                .map(item => String(item || '').trim())
                .filter(Boolean)
        ));
    }

    _buildCaptureDiagnostics(status = {}) {
        const activeSession = status.recorder?.activeSession || null;
        return {
            activeSession,
            proxyConfigured: Boolean(status.proxy?.configured),
            proxyStatus: status.proxy?.status || 'unknown',
            proxyReason: status.proxy?.reason || 'proxy_not_checked',
            listenHost: status.proxy?.listenHost || null,
            listenPort: status.proxy?.listenPort || null,
            harOutputReady: Boolean(status.harOutput?.writable),
            harOutputDir: status.harOutput?.dir || this.recorder.dataDir,
            mitmdumpReady: Boolean(status.mitmdump?.available),
            mitmdumpBinary: status.mitmdump?.binary || null,
            recentCount: Number(status.recorder?.recentCount || 0)
        };
    }

    _workflowDiagnosticsFromChecks(checks = {}, fallbackReason = 'unknown_error') {
        const diagnostics = Object.entries(checks)
            .filter(([, check]) => check && !['ready', 'running', 'configured'].includes(check.status))
            .map(([name, check]) => ({
                code: check.reason || fallbackReason,
                component: name,
                status: check.status || 'unknown',
                message: REASONS[check.reason] || ''
            }));
        if (diagnostics.length === 0 && fallbackReason && fallbackReason !== 'ready') {
            diagnostics.push({
                code: fallbackReason,
                component: 'method2',
                status: 'unavailable',
                message: REASONS[fallbackReason] || ''
            });
        }
        return diagnostics;
    }

    _workflowStageForReason(reason, captureDiagnostics = {}) {
        if (reason === 'ready') {
            return captureDiagnostics.activeSession ? 'capturing' : 'ready';
        }
        const stageByReason = {
            mitmdump_missing: 'mitmdump',
            har_output_unwritable: 'har_output',
            proxy_not_configured: 'proxy'
        };
        return stageByReason[reason] || 'diagnose';
    }

    _workflowNextAction(reason, stage, captureDiagnostics = {}) {
        if (reason === 'ready' && captureDiagnostics.activeSession) {
            return '请求记录会话正在运行；请在授权小程序窗口完成操作，结束后停止记录并生成摘要。';
        }
        const actions = {
            ready: '请求采集环境已准备好；确认授权范围后可以开始记录。',
            mitmdump_missing: '请联系运维补齐请求记录组件，然后重新检查环境。',
            har_output_unwritable: '请修复请求记录保存目录权限，然后重新检查环境。',
            proxy_not_configured: '请按当前记录会话提示配置网络出口，再执行授权采集。'
        };
        return actions[reason] || `请根据${stage || '诊断'}阶段提示处理阻塞后重新检查环境。`;
    }

    _buildFieldSummary(targetRequests) {
        const fieldMap = {};
        for (const req of targetRequests) {
            if (req.querySummary && typeof req.querySummary === 'object') {
                for (const key of Object.keys(req.querySummary)) {
                    if (!fieldMap[key]) fieldMap[key] = { in: 'query', sensitive: isSensitiveKey(key), count: 0 };
                    fieldMap[key].count++;
                }
            }
            if (req.bodySummary && typeof req.bodySummary === 'object') {
                for (const key of Object.keys(req.bodySummary)) {
                    if (!fieldMap[key]) fieldMap[key] = { in: 'body', sensitive: isSensitiveKey(key), count: 0 };
                    fieldMap[key].count++;
                }
            }
            for (const f of (req.responseFieldSummary || [])) {
                if (!fieldMap[f]) fieldMap[f] = { in: 'response', sensitive: isSensitiveKey(f), count: 0 };
                fieldMap[f].count++;
            }
        }
        return Object.entries(fieldMap).map(([name, info]) => ({ name, ...info }));
    }

    _collectHosts(entries) {
        const hosts = new Set();
        for (const entry of entries) {
            try {
                const url = entry.request?.url;
                if (url) hosts.add(new URL(url).hostname);
            } catch {}
        }
        return [...hosts];
    }

    _isDirWritable(dir) {
        try {
            fs.mkdirSync(dir, { recursive: true });
            const testFile = path.join(dir, '.write-test-' + Date.now());
            fs.writeFileSync(testFile, '1');
            fs.unlinkSync(testFile);
            return true;
        } catch {
            return false;
        }
    }

    _waitForFile(filePath, timeoutMs) {
        return new Promise(resolve => {
            const start = Date.now();
            const check = () => {
                if (fs.existsSync(filePath) && fs.statSync(filePath).size > 2) {
                    // 验证请求记录文件写入完成
                    try {
                        const content = fs.readFileSync(filePath, 'utf8');
                        const har = JSON.parse(content);
                        if (har.log && Array.isArray(har.log.entries)) return resolve(true);
                    } catch {
                        // JSON 不完整，文件还在写入
                    }
                }
                if (Date.now() - start > timeoutMs) return resolve(false);
                setTimeout(check, 200);
            };
            check();
        });
    }

    _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

Method2Service.REASONS = REASONS;
Method2Service.TARGET_HOSTS = TARGET_HOSTS;

module.exports = Method2Service;
