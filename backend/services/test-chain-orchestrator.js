'use strict';

const fs = require('fs');
const path = require('path');

const CHAIN_META = {
    method1: {
        id: 'method1',
        label: '页面自动化识别',
        method: 'page-automation',
        evidenceType: 'method1-result',
        recommendedAction: '打开电脑端微信和目标小程序，确认截图、OCR、下滑权限可用。'
    },
    method2: {
        id: 'method2',
        label: '后台自动化识别',
        method: 'background-automation',
        evidenceType: 'method2-result',
        recommendedAction: '启动请求记录服务，按提示配置代理并触发目标小程序请求。'
    },
    method3: {
        id: 'method3',
        label: '流量自动化识别',
        method: 'traffic-template',
        evidenceType: 'method3-result',
        recommendedAction: '确认模板、签名语料和目标城市坐标匹配后再执行小规模请求。'
    }
};

const CHAIN_ORDER = ['method3', 'method2', 'method1'];

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function nowIso() {
    return new Date().toISOString();
}

function safeClone(value) {
    try {
        return JSON.parse(JSON.stringify(value));
    } catch {
        return value;
    }
}

class TestChainOrchestrator {
    constructor(options = {}) {
        this.method1Service = options.method1Service || null;
        this.method2Service = options.method2Service || null;
        this.method3Service = options.method3Service || null;
        this.reportService = options.reportService || null;
        this.projectRoot = options.projectRoot || path.join(__dirname, '../..');
        this.dataDir = options.dataDir || path.join(this.projectRoot, 'data/test-chain-runs');
        this.statePath = path.join(this.dataDir, 'state.json');
        this.runs = new Map();
        fs.mkdirSync(this.dataDir, { recursive: true });
        this._loadState();
    }

    async getStatus(options = {}) {
        const target = this.normalizeTarget(options.target || options);
        const [method1Raw, method2Raw, method3Raw] = await Promise.all([
            this._safeCall('method1', () => this.method1Service.getStatus({ platform: target.platform })),
            this._safeCall('method2', () => this.method2Service.getStatus()),
            this._safeCall('method3', () => this.method3Service.getStatus(target))
        ]);

        const chains = {
            method1: this.normalizeStatus('method1', method1Raw),
            method2: this.normalizeStatus('method2', method2Raw),
            method3: this.normalizeStatus('method3', method3Raw)
        };

        const bestChain = this.pickBestChain(chains);
        return {
            success: true,
            target,
            chains,
            bestChain,
            summary: {
                availableCount: Object.values(chains).filter(item => item.available).length,
                blockedCount: Object.values(chains).filter(item => !item.available).length,
                recommendedChain: bestChain
            },
            checkedAt: nowIso()
        };
    }

    async run(input = {}) {
        const target = this.normalizeTarget(input.target || input);
        const requestedChain = String(input.chain || input.method || 'best').trim();
        const dryRun = input.dryRun === true || input.mode === 'dry_run';
        const status = await this.getStatus({ target });
        const chainList = this.resolveChainList(requestedChain, status.chains);
        const run = {
            id: `chain-run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            status: dryRun ? 'dry_run' : 'running',
            requestedChain,
            chainList,
            target,
            dryRun,
            startedAt: nowIso(),
            finishedAt: null,
            steps: [],
            evidenceRefs: [],
            reportId: input.reportId || null,
            success: false,
            reason: 'not_finished'
        };

        this.runs.set(run.id, run);
        this._saveState();

        if (dryRun) {
            run.status = 'planned';
            run.success = true;
            run.reason = 'dry_run';
            run.plan = this.buildRunPlan(chainList, status.chains, target);
            run.finishedAt = nowIso();
            this._saveState();
            return { success: true, run };
        }

        await this._ensureReport(run, input);
        await this._appendReportEvent(run, {
            type: 'step',
            chain: 'orchestrator',
            message: '三链路统一执行开始',
            target,
            chainList
        });

        try {
            for (const chain of chainList) {
                if (run.status === 'stopped') break;
                const step = await this.runSingleChain(chain, target, input);
                run.steps.push(step);
                run.evidenceRefs.push(...(step.evidenceRefs || []));
                await this._appendReportEvent(run, {
                    type: step.pass ? 'info' : 'warning',
                    chain,
                    message: `${CHAIN_META[chain]?.label || chain}${step.pass ? '执行通过' : '执行未通过'}`,
                    result: step.summary || step.result || {}
                });
                await this._appendReportEvidence(run, chain, step);
                if (step.pass) break;
            }

            const passedStep = run.steps.find(step => step.pass);
            run.success = Boolean(passedStep);
            run.status = run.success ? 'passed' : (run.status === 'stopped' ? 'stopped' : 'failed');
            run.reason = run.success ? 'chain_passed' : 'all_candidate_chains_failed';
            run.finishedAt = nowIso();

            await this._appendReportEvent(run, {
                type: run.success ? 'info' : 'error',
                chain: 'orchestrator',
                message: run.success ? '三链路执行完成：已有链路通过' : '三链路执行完成：候选链路均未通过',
                status: run.status,
                reason: run.reason
            });
            await this._finalizeReport(run);
        } catch (error) {
            run.success = false;
            run.status = 'failed';
            run.reason = 'orchestrator_exception';
            run.error = error.message;
            run.finishedAt = nowIso();
            await this._appendReportEvent(run, {
                type: 'error',
                chain: 'orchestrator',
                message: error.message
            });
        } finally {
            this._saveState();
        }

        return { success: run.success, run };
    }

    getRun(runId) {
        return this.runs.get(String(runId || '')) || null;
    }

    stopRun(runId) {
        const run = this.getRun(runId);
        if (!run) {
            return { success: false, reason: 'run_not_found' };
        }
        if (['passed', 'failed', 'stopped', 'planned'].includes(run.status)) {
            return { success: true, run, message: 'run already finished' };
        }
        run.status = 'stopped';
        run.reason = 'stopped_by_user';
        run.finishedAt = nowIso();
        this._saveState();
        return { success: true, run };
    }

    async diagnose(input = {}) {
        const status = input.status || await this.getStatus(input);
        const chain = input.chain || status.bestChain || 'method3';
        const chainStatus = status.chains?.[chain] || null;
        const reason = input.reason || chainStatus?.blockingReason || 'unknown_error';
        const diagnostics = this.buildDiagnostics(chain, reason, chainStatus?.raw || input.context || {});
        return {
            success: diagnostics.severity !== 'unknown',
            chain,
            reason,
            diagnostics: [diagnostics],
            recommendedAction: diagnostics.recommendedAction,
            status: chainStatus || null
        };
    }

    normalizeTarget(input = {}) {
        return {
            platform: String(input.platform || input.platformId || 'didi-charging').trim() || 'didi-charging',
            city: String(input.city || input.targetCity || '上海').trim() || '上海',
            lat: Number.isFinite(Number(input.lat)) ? Number(input.lat) : 31.2304,
            lng: Number.isFinite(Number(input.lng)) ? Number(input.lng) : 121.4737,
            radiusKm: Math.max(1, Math.min(50, Number(input.radiusKm || input.radius || input.maxDistanceKm || 20))),
            maxPages: Math.max(1, Math.min(1, Number(input.maxPages || 1))),
            maxRequestCount: Math.max(1, Math.min(5, Number(input.maxRequestCount || 5))),
            maxQps: Math.max(1, Math.min(1, Number(input.maxQps || 1)))
        };
    }

    normalizeStatus(chain, raw) {
        const meta = CHAIN_META[chain] || { id: chain, label: chain };
        const available = Boolean(raw && raw.available === true && raw.success !== false);
        const reason = raw?.reason || raw?.status || (available ? 'ready' : 'unknown_error');
        return {
            chain,
            label: meta.label,
            success: available,
            available,
            status: available ? 'ready' : 'blocked',
            blockingReason: available ? '' : reason,
            checks: raw?.checks || {},
            diagnostics: available ? [] : [this.buildDiagnostics(chain, reason, raw)],
            recommendedAction: available ? '可直接执行小规模验证。' : this.recommendForReason(chain, reason),
            evidenceRefs: [],
            lastRun: this.findLastRunForChain(chain),
            raw: raw || {}
        };
    }

    resolveChainList(requestedChain, chains = {}) {
        const normalized = String(requestedChain || 'best').toLowerCase();
        if (['method1', 'method2', 'method3'].includes(normalized)) return [normalized];
        if (normalized === 'all') return ['method1', 'method2', 'method3'];
        const best = this.pickBestChain(chains);
        if (best) return [best, ...CHAIN_ORDER.filter(chain => chain !== best)];
        return [...CHAIN_ORDER];
    }

    pickBestChain(chains = {}) {
        return CHAIN_ORDER.find(chain => chains[chain]?.available) || null;
    }

    buildRunPlan(chainList, chains, target) {
        return chainList.map(chain => ({
            chain,
            label: CHAIN_META[chain]?.label || chain,
            available: Boolean(chains[chain]?.available),
            target,
            action: chain === 'method2' ? 'start_capture_then_stop_and_analyze' : 'run_basic_check',
            expectedEvidence: CHAIN_META[chain]?.evidenceType || `${chain}-result`
        }));
    }

    async runSingleChain(chain, target, input = {}) {
        const startedAt = nowIso();
        let result;
        if (chain === 'method1') {
            result = await this.method1Service.runBasicCheck({
                platform: target.platform,
                city: target.city,
                targetCity: target.city,
                maxScrolls: input.maxScrolls || 1
            });
        } else if (chain === 'method2') {
            result = await this.runMethod2(target, input);
        } else if (chain === 'method3') {
            result = await this.method3Service.runBasicCheck({
                platform: target.platform,
                city: target.city,
                lat: target.lat,
                lng: target.lng,
                radiusKm: target.radiusKm,
                maxPages: target.maxPages,
                maxRequestCount: target.maxRequestCount,
                maxQps: target.maxQps,
                mode: input.mode || 'list'
            });
        } else {
            result = { success: false, reason: 'unknown_chain' };
        }

        const pass = this.isPass(chain, result);
        return {
            chain,
            label: CHAIN_META[chain]?.label || chain,
            pass,
            status: pass ? 'passed' : 'failed',
            reason: pass ? 'passed' : (result?.reason || result?.status || 'chain_failed'),
            startedAt,
            finishedAt: nowIso(),
            result: safeClone(result),
            summary: this.summarizeResult(chain, result),
            diagnostics: pass ? [] : [this.buildDiagnostics(chain, result?.reason || result?.status || 'chain_failed', result)],
            evidenceRefs: this.extractEvidenceRefs(chain, result)
        };
    }

    async runMethod2(target, input = {}) {
        if (input.harPath) {
            return this.method2Service.analyzeHar({ harPath: input.harPath });
        }
        const start = this.method2Service.startCapture({
            label: input.label || `orchestrator-${Date.now()}`,
            platforms: [target.platform],
            cities: [target.city],
            city: target.city,
            lat: target.lat,
            lng: target.lng,
            filterHosts: input.filterHosts || ''
        });
        if (!start.success) return start;
        await sleep(Math.max(0, Math.min(30000, Number(input.captureWindowMs || 3000))));
        const analyzed = await this.method2Service.stopAndAnalyze({});
        return {
            ...analyzed,
            start
        };
    }

    isPass(chain, result = {}) {
        if (chain === 'method2') {
            return result.success === true && Number(result.summary?.targetRequests || 0) > 0;
        }
        if (chain === 'method3') {
            return result.success === true && (result.result?.success !== false);
        }
        return result.success === true && result.available !== false;
    }

    summarizeResult(chain, result = {}) {
        if (chain === 'method1') {
            return {
                beforeStatus: result.before?.status,
                afterStatus: result.after?.status,
                scrollStatus: result.scroll?.status,
                reason: result.reason
            };
        }
        if (chain === 'method2') {
            return {
                totalRequests: result.summary?.totalRequests || 0,
                targetRequests: result.summary?.targetRequests || 0,
                reason: result.reason
            };
        }
        if (chain === 'method3') {
            return {
                status: result.status,
                reason: result.reason,
                attempts: result.result?.totalAttempts || 0,
                successCount: result.result?.successCount || 0
            };
        }
        return { reason: result.reason || result.status || 'unknown' };
    }

    extractEvidenceRefs(chain, result = {}) {
        const refs = [];
        if (chain === 'method1') {
            [result.before?.screenshotPath, result.after?.screenshotPath].filter(Boolean).forEach(item => refs.push(item));
        }
        if (chain === 'method2') {
            [result.harPath, result.outputPath, result.start?.outputPath].filter(Boolean).forEach(item => refs.push(item));
        }
        if (chain === 'method3') {
            const traceIds = (result.result?.results || []).map(item => item.traceId).filter(Boolean);
            refs.push(...traceIds.map(id => `trace:${id}`));
        }
        return refs;
    }

    buildDiagnostics(chain, reason, raw = {}) {
        return {
            code: reason || 'unknown_error',
            chain,
            severity: reason ? 'warning' : 'unknown',
            message: this.messageForReason(reason),
            recommendedAction: this.recommendForReason(chain, reason),
            rawReason: raw?.reason || raw?.status || reason || ''
        };
    }

    messageForReason(reason) {
        const map = {
            ready: '链路可用。',
            wechat_not_running: '未检测到电脑端微信。',
            target_window_missing: '未找到目标小程序窗口。',
            screenshot_failed: '截图能力不可用。',
            ocr_unavailable: 'OCR 或页面识别不可用。',
            mitmdump_missing: '未检测到 mitmdump/mitmproxy。',
            no_request_captured: '本次录包没有捕获请求。',
            no_target_request_detected: '录包里没有目标业务请求。',
            template_missing: '缺少可用 API 模板。',
            signature_corpus_missing: '签名语料缺失或为空。',
            signature_corpus_expired: '签名语料已过期。',
            signed_template_target_mismatch: '模板或签名语料与目标城市/坐标不匹配。',
            proxy_not_configured: '网络出口代理未配置。',
            request_failed: '目标接口请求失败。'
        };
        return map[reason] || '链路未通过，需要查看诊断详情。';
    }

    recommendForReason(chain, reason) {
        const map = {
            wechat_not_running: '先打开电脑端微信，再进入目标小程序页面。',
            target_window_missing: '在微信中打开目标小程序，并保持窗口可见。',
            screenshot_failed: '检查系统屏幕录制权限和截图脚本可执行性。',
            ocr_unavailable: '检查 OCR 依赖或改用请求验证链路。',
            mitmdump_missing: '安装 mitmproxy，或设置 CAPTURE_RECORDER_BIN。',
            no_request_captured: '确认代理配置生效，然后重新操作小程序触发请求。',
            no_target_request_detected: '确认目标页面发生业务请求，必要时扩大 host 过滤范围。',
            template_missing: '先导入 HAR 学习模板，或通过请求验证链路补充材料。',
            signature_corpus_missing: '通过方式二采集当前目标请求材料，再合并签名语料。',
            signature_corpus_expired: '刷新当前城市签名语料后重试。',
            signed_template_target_mismatch: '为当前城市/坐标重新采集请求材料，避免跨城复用签名。',
            proxy_not_configured: '配置 METHOD3_UPSTREAM_PROXY，或先使用方式一/二验证。',
            request_failed: '查看响应状态和 AI 诊断，优先检查签名、代理和目标范围。'
        };
        return map[reason] || CHAIN_META[chain]?.recommendedAction || '查看链路检查项并按阻断原因处理。';
    }

    findLastRunForChain(chain) {
        const runs = Array.from(this.runs.values())
            .filter(run => Array.isArray(run.steps) && run.steps.some(step => step.chain === chain))
            .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
        const run = runs[0];
        if (!run) return null;
        const step = run.steps.find(item => item.chain === chain);
        return {
            runId: run.id,
            status: step?.status || run.status,
            pass: step?.pass === true,
            at: step?.finishedAt || run.finishedAt || run.startedAt,
            reason: step?.reason || run.reason
        };
    }

    async _safeCall(chain, fn) {
        try {
            if (!fn) return { success: false, available: false, reason: 'service_missing' };
            const result = await fn();
            return result || { success: false, available: false, reason: 'empty_result' };
        } catch (error) {
            return { success: false, available: false, reason: error.reason || 'unknown_error', error: error.message, chain };
        }
    }

    async _ensureReport(run, input = {}) {
        if (!this.reportService || input.disableEvidence === true) return;
        if (run.reportId) return;
        try {
            const report = this.reportService.startReport({
                title: `三链路验证报告 - ${run.target.city}`,
                method: 'chain-orchestrator',
                platform: run.target.platform,
                cities: [run.target.city],
                target: {
                    platform: run.target.platform,
                    cities: [run.target.city],
                    scope: `${run.target.city} / ${run.target.radiusKm}km`,
                    assets: run.chainList
                },
                scope: `${run.target.city} / ${run.target.radiusKm}km`,
                executor: { name: input.executorName || 'Global AI Agent' },
                methods: run.chainList.map(chain => ({
                    id: CHAIN_META[chain]?.method || chain,
                    name: CHAIN_META[chain]?.label || chain,
                    status: 'planned'
                }))
            });
            run.reportId = report.reportId;
        } catch (error) {
            run.reportError = error.message;
        }
    }

    async _appendReportEvent(run, event = {}) {
        if (!this.reportService || !run.reportId) return;
        try {
            this.reportService.appendEvent(run.reportId, {
                at: nowIso(),
                source: 'test-chain-orchestrator',
                runId: run.id,
                ...event
            });
        } catch (error) {
            run.reportError = error.message;
        }
    }

    async _appendReportEvidence(run, chain, step) {
        if (!this.reportService || !run.reportId) return;
        try {
            const result = this.reportService.appendEvidence(run.reportId, {
                type: 'supervisor-event',
                city: run.target.city,
                data: {
                    at: nowIso(),
                    source: 'test-chain-orchestrator',
                    runId: run.id,
                    chain,
                    pass: step.pass,
                    reason: step.reason,
                    summary: step.summary,
                    evidenceRefs: step.evidenceRefs || []
                }
            });
            if (result?.path) run.evidenceRefs.push(result.path);
        } catch (error) {
            run.reportError = error.message;
        }
    }

    async _finalizeReport(run) {
        if (!this.reportService || !run.reportId) return;
        try {
            this.reportService.finalizeReport(run.reportId, {
                overallStatus: run.success ? 'passed' : 'partial',
                conclusion: run.success
                    ? '三链路统一验证已有链路通过。'
                    : '三链路统一验证未通过，需按诊断建议处理阻断项。',
                riskLevel: run.success ? 'low' : 'medium',
                findings: run.steps
                    .filter(step => !step.pass)
                    .map((step, index) => ({
                        id: `CHAIN-${index + 1}`,
                        title: `${step.label}未通过`,
                        severity: 'medium',
                        status: 'pending-retest',
                        impact: step.diagnostics?.[0]?.message || step.reason,
                        recommendation: step.diagnostics?.[0]?.recommendedAction || '',
                        evidenceRefs: step.evidenceRefs || []
                    })),
                recommendations: run.steps
                    .filter(step => !step.pass)
                    .map(step => step.diagnostics?.[0]?.recommendedAction)
                    .filter(Boolean)
            });
        } catch (error) {
            run.reportError = error.message;
        }
    }

    _loadState() {
        try {
            if (!fs.existsSync(this.statePath)) return;
            const parsed = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
            const runs = Array.isArray(parsed.runs) ? parsed.runs : [];
            this.runs = new Map(runs.map(run => [run.id, run]));
        } catch {
            this.runs = new Map();
        }
    }

    _saveState() {
        const runs = Array.from(this.runs.values())
            .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
            .slice(0, 100);
        fs.writeFileSync(this.statePath, JSON.stringify({ runs }, null, 2), 'utf8');
    }
}

module.exports = TestChainOrchestrator;
