'use strict';

const fs = require('fs');
const path = require('path');
const CaptureRecorder = require('./capture-recorder');
const { summarizeRedactedEntry, redactUrl, REDACTED, isSensitiveKey } = require('./sensitive-redactor');
const { RequestFailureAnalyzer } = require('./request-failure-analyzer');

// 目标接口 host 列表 — 方式二关注这些
const TARGET_HOSTS = [
    'energy.xiaojukeji.com',
    'api.xiaojukeji.com',
    'didiglobal.com',
    'xiaojukeji.com',
];

const REASONS = {
    mitmdump_missing: 'mitmdump binary not found; install mitmproxy or set CAPTURE_RECORDER_BIN',
    recorder_start_failed: 'capture recorder failed to start session',
    recorder_stop_failed: 'capture recorder failed to stop session',
    proxy_not_configured: 'system proxy not configured; set browser/OS proxy to capture port',
    no_request_captured: 'no requests captured in this session',
    no_target_request_detected: 'no target API requests detected in captured traffic',
    har_not_found: 'HAR file not found after capture session',
    har_parse_failed: 'HAR file parse error',
    har_output_unwritable: 'HAR output directory not writable',
    certificate_not_trusted: 'mitmproxy CA certificate not trusted by client; install cert',
    tls_not_decryptable: 'TLS traffic cannot be decrypted; check certificate trust chain',
    unknown_error: 'unknown error',
};

class Method2Service {
    constructor(options = {}) {
        this.recorder = options.recorder || new CaptureRecorder(options.recorderOptions || {});
        this.targetHosts = options.targetHosts || TARGET_HOSTS;
        this.failureAnalyzer = options.failureAnalyzer || new RequestFailureAnalyzer({ config: options.aiAgentConfig || {} });
    }

    /**
     * GET /api/method2/status
     * 返回 mitmdump、recorder、proxy、harOutput 状态
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
            success: true,
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

    /**
     * POST /api/method2/start-capture
     * 启动录包，返回 sessionId、listenHost、listenPort、outputPath、proxyTips
     */
    startCapture(input = {}) {
        // 检查 mitmdump
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
                scope: 'method2',
                platforms: input.platforms || ['didi-charging'],
                cities: input.cities || [],
                filterHosts: input.filterHosts || '',
                filterIps: input.filterIps || '',
                overrideCity: input.city || input.overrideCity || '',
                overrideLat: input.lat || input.overrideLat || 0,
                overrideLng: input.lng || input.overrideLng || 0,
                upstreamProxy: input.upstreamProxy || '',
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
     * 停止录包，生成 HAR，解析 HAR，返回接口摘要
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

        // 停止录包
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

        // 等待 HAR 文件写入（mitmdump 需要一点时间 flush）
        const harReady = await this._waitForFile(harPath, 10000);

        // 检查文件是否真正就绪
        if (!fs.existsSync(harPath)) {
            return this._withAgentAnalysis({
                success: false,
                reason: 'har_not_found',
                message: 'HAR file not written after capture session stop',
                sessionId,
            }, { sessionId, harPath, stage: 'har_write_check' });
        }
        if (!harReady) {
            return this._withAgentAnalysis({
                success: false,
                reason: 'har_parse_failed',
                message: 'HAR file was written but not ready for JSON parsing',
                sessionId,
                harPath,
            }, { sessionId, harPath, stage: 'har_flush_wait' });
        }

        // 解析 HAR
        return this._analyzeHarFile(harPath, sessionId, input.targetHosts);
    }

    /**
     * POST /api/method2/analyze-har
     * 分析已有 HAR 文件
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
        // 路径白名单校验：只允许 data/capture-sessions 目录下的 HAR
        const allowedDir = this.recorder.dataDir;
        const resolved = path.resolve(harPath);
        const allowedResolved = path.resolve(allowedDir);
        if (resolved !== allowedResolved && !resolved.startsWith(allowedResolved + path.sep)) {
            return this._withAgentAnalysis({
                success: false,
                reason: 'har_not_found',
                message: 'HAR path outside allowed directory; only capture-sessions directory is permitted',
            }, { harPath, stage: 'analyze_har_path_guard' });
        }
        return this._analyzeHarFile(harPath, null, input.targetHosts);
    }

    /**
     * 核心解析逻辑
     */
    async _analyzeHarFile(harPath, sessionId, customTargetHosts) {
        const targetHosts = customTargetHosts || this.targetHosts;

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
            `设置系统代理: ${session.listenHost === '0.0.0.0' ? '127.0.0.1' : session.listenHost}:${session.listenPort}`,
            '或设置浏览器代理: HTTP Proxy → 上述地址',
            '电脑端微信小程序会使用系统代理',
            '首次使用需安装 mitmproxy CA 证书 (http://mitm.it)',
        ];
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
                    // 验证 HAR 文件写入完成：尝试解析确认 JSON 有效
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
}

Method2Service.REASONS = REASONS;
Method2Service.TARGET_HOSTS = TARGET_HOSTS;

module.exports = Method2Service;
