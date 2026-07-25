'use strict';

const { AiAgentClient, buildAiAgentConfig, publicConfig } = require('./ai-agent-client');
const { buildConstraints } = require('./request-failure-analyzer');

const TOOL_DEFINITIONS = {
    get_product_overview: {
        mutating: false,
        description: '读取产品运行总览、三链路状态和最近报告摘要。'
    },
    get_chain_status: {
        mutating: false,
        description: '读取三条测试链路统一状态。'
    },
    get_method1_workflow: {
        mutating: false,
        description: '读取页面采集准备状态、阻断原因和推荐下一步。'
    },
    get_method2_workflow: {
        mutating: false,
        description: '读取请求采集准备状态、用户操作窗口要求和推荐下一步。'
    },
    list_reports: {
        mutating: false,
        description: '读取蓝军报告列表和报告完成状态。'
    },
    get_report_detail: {
        mutating: false,
        description: '读取指定蓝军报告详情、证据矩阵和结论。'
    },
    run_method1: {
        mutating: true,
        description: '执行页面采集基础验证。'
    },
    run_method2: {
        mutating: true,
        description: '按“开始记录 -> 用户操作 -> 停止分析”分阶段执行请求采集，需要用户在记录窗口内操作目标小程序。'
    },
    run_method3: {
        mutating: true,
        description: '执行小规模访问验证。'
    },
    run_best_chain: {
        mutating: true,
        description: '按当前状态选择可用链路执行验证。'
    },
    diagnose_chain_failure: {
        mutating: false,
        description: '诊断链路失败原因。'
    },
    append_report_event: {
        mutating: true,
        description: '向蓝军报告追加事件。'
    },
    append_report_evidence: {
        mutating: true,
        description: '向蓝军报告追加证据。'
    },
    finalize_report: {
        mutating: true,
        description: '完成蓝军报告。'
    },
    start_mobile_workflow: {
        mutating: true,
        description: '启动手机辅助多城市增量工作流。'
    }
};

const FORBIDDEN_PATTERNS = [
    /绕过|bypass/i,
    /伪造|fake|forge/i,
    /验证码|captcha/i,
    /风控.*规避|evade/i,
    /提高.*qps|increase.*qps/i,
    /提高.*请求|increase.*request/i,
    /扩大.*半径|increase.*radius/i,
    /(伪造|fake|forge).*(cookie|token|signature|wsgsig|sign)/i,
    /(绕过|bypass).*(cookie|token|signature|wsgsig|sign|auth|login)/i
];

function nowIso() {
    return new Date().toISOString();
}

function normalizeMode(mode) {
    const value = String(mode || 'disabled').toLowerCase();
    if (value === 'dry-run') return 'dry_run';
    return ['disabled', 'dry_run', 'enabled'].includes(value) ? value : 'disabled';
}

function buildGlobalPlanPrompt() {
    return [
        'You are the global planning agent for a blue-team test-chain console.',
        'Choose exactly one whitelisted tool for the user request.',
        'Allowed tools: ' + Object.keys(TOOL_DEFINITIONS).join(', ') + '.',
        'Never bypass login, authorization, signatures, captcha, or risk controls.',
        'Never forge credentials, request materials, signatures, or authorization state.',
        'Never increase request volume, QPS, collection radius, maxPages, or maxRequestCount.',
        'For status, readiness, feasibility, or next-step questions, prefer the page-collection or request-collection workflow when a chain is named; otherwise use get_chain_status.',
        'Use mutating run_* tools only when the user explicitly asks to execute or start a verification.',
        'Request collection is staged: start recording, wait for the user to operate the mini-program, then stop and analyze. Never promise that one chat turn captured requests successfully.',
        'In dry_run, only generate a plan; do not claim that requests, screenshots, or evidence were captured.',
        'Prefer run_best_chain for explicit small verification requests without a named method.',
        'Return JSON only. Schema: {"tool":string,"input":object,"reason":string}.'
    ].join('\n');
}

function summarizeChainStatus(status = {}) {
    const chains = status.chains && typeof status.chains === 'object' ? status.chains : {};
    return Object.fromEntries(Object.entries(chains).map(([key, value]) => [key, {
        available: Boolean(value.available),
        status: value.status || 'unknown',
        blockingReason: value.blockingReason || '',
        recommendedAction: value.recommendedAction || ''
    }]));
}

function isReadinessQuestion(message) {
    return /状态|status|检查|诊断|可行|能不能|是否|ready|readiness|workflow|下一步|怎么做|如何|准备/.test(message);
}

function isExecutionRequest(message) {
    return /执行|开始|运行|验证|run|execute/.test(message);
}

function buildWorkflowFallback(chain, status = {}, target = {}) {
    const chainStatus = status.chains?.[chain] || {};
    const isMethod2 = chain === 'method2';
    const phases = isMethod2
        ? [
            { id: 'prepare', title: '准备请求记录环境', status: chainStatus.available ? 'ready' : 'blocked' },
            { id: 'start_recording', title: '开始记录', status: chainStatus.available ? 'available' : 'blocked' },
            { id: 'user_operation_window', title: '用户操作目标小程序触发业务请求', status: 'manual_required' },
            { id: 'stop_and_analyze', title: '停止记录并生成摘要', status: 'pending_user_operation' }
        ]
        : [
            { id: 'prepare', title: '准备电脑端微信和目标小程序窗口', status: chainStatus.available ? 'ready' : 'blocked' },
            { id: 'observe', title: '截图和页面状态识别', status: chainStatus.available ? 'available' : 'blocked' },
            { id: 'guided_action', title: '按页面状态执行观察、滚动或城市切换', status: chainStatus.available ? 'available' : 'pending_readiness' }
        ];

    return {
        success: true,
        source: 'orchestrator_status_fallback',
        chain,
        target,
        ready: Boolean(chainStatus.available),
        status: chainStatus.status || 'unknown',
        blockingReason: chainStatus.blockingReason || '',
        recommendedAction: chainStatus.recommendedAction || '',
        manualActionRequired: isMethod2,
        userOperationWindowRequired: isMethod2,
        dryRunSemantics: isMethod2
            ? '预演只生成分阶段计划，不代表已经开始记录或捕获到请求。'
            : '预演只生成计划，不代表已经完成截图、页面识别或页面动作。',
        phases,
        diagnostics: chainStatus.diagnostics || [],
        rawStatus: chainStatus.raw || {}
    };
}

class GlobalAgentService {
    constructor(options = {}) {
        this.orchestrator = options.orchestrator;
        this.reportService = options.reportService || null;
        this.mobileCommandService = options.mobileCommandService || null;
        this.setConfig(options.config || {});
    }

    setConfig(config = {}) {
        this.config = buildAiAgentConfig(config);
        this.config.mode = normalizeMode(this.config.mode);
        this.client = new AiAgentClient(this.config);
        return this.config;
    }

    getStatus() {
        const modelStatus = this.client.getStatus();
        return {
            success: true,
            available: this.config.mode !== 'disabled',
            mode: this.config.mode,
            reason: this.config.mode === 'disabled' ? 'global_agent_disabled' : 'global_agent_ready',
            config: publicConfig(this.config),
            model: {
                available: Boolean(modelStatus.available),
                reason: modelStatus.reason,
                config: modelStatus.config
            },
            tools: Object.entries(TOOL_DEFINITIONS).map(([name, meta]) => ({
                name,
                mutating: meta.mutating,
                description: meta.description
            })),
            guardrails: {
                ...buildConstraints(),
                highRiskRequiresConfirmation: true,
                dryRunBlocksMutation: true
            }
        };
    }

    async chat(input = {}) {
        const message = String(input.message || input.prompt || '').trim();
        const plan = await this.plan({ ...input, message });
        if (!plan.success) {
            return {
                success: false,
                mode: this.config.mode,
                reason: plan.reason || plan.plan?.guardrail?.reason || 'plan_failed',
                reply: this.buildReply(plan, null),
                plan: plan.plan,
                execution: null,
                createdAt: nowIso()
            };
        }
        const shouldExecute = /执行|开始|运行|验证|run|execute/i.test(message) || input.execute === true;
        const execution = shouldExecute
            ? await this.execute({ plan: plan.plan, dryRun: input.dryRun })
            : null;
        return {
            success: true,
            mode: this.config.mode,
            reply: this.buildReply(plan, execution),
            plan: plan.plan,
            execution,
            createdAt: nowIso()
        };
    }

    async plan(input = {}) {
        const guardrail = this.checkGuardrails(input);
        if (!guardrail.allowed) {
            return {
                success: false,
                reason: guardrail.reason,
                plan: {
                    mode: this.config.mode,
                    actions: [],
                    blocked: true,
                    guardrail
                }
            };
        }

        const message = String(input.message || input.prompt || '').toLowerCase();
        const target = this.orchestrator.normalizeTarget(input.target || input);
        let tool = input.tool || input.action || '';

        if (!tool) {
            const modelPlan = await this.planWithModel(input, target);
            if (modelPlan.success || modelPlan.blocked) {
                return modelPlan;
            }

            const asksExecution = isExecutionRequest(message);
            const asksReadiness = isReadinessQuestion(message);
            if (asksExecution) {
                if (/页面采集|页面|method1/.test(message)) {
                    tool = 'run_method1';
                } else if (/请求采集|请求验证|method2/.test(message)) {
                    tool = 'run_method2';
                } else if (/小规模访问验证|访问验证|method3/.test(message)) {
                    tool = 'run_method3';
                } else {
                    tool = 'run_best_chain';
                }
            } else if (asksReadiness) {
                if (/页面采集|页面|method1/.test(message)) {
                    tool = 'get_method1_workflow';
                } else if (/请求采集|请求验证|method2/.test(message)) {
                    tool = 'get_method2_workflow';
                } else {
                    tool = /诊断/.test(message) ? 'diagnose_chain_failure' : 'get_chain_status';
                }
            } else if (/页面采集|页面|method1/.test(message)) {
                tool = 'get_method1_workflow';
            } else if (/请求采集|请求验证|method2/.test(message)) {
                tool = 'get_method2_workflow';
            } else if (/小规模访问验证|访问验证|method3/.test(message)) {
                tool = 'run_method3';
            } else {
                tool = 'run_best_chain';
            }
        }

        if (!TOOL_DEFINITIONS[tool]) {
            return {
                success: false,
                reason: 'unknown_tool',
                plan: {
                    mode: this.config.mode,
                    actions: [],
                    error: `unknown tool: ${tool}`
                }
            };
        }

        const meta = TOOL_DEFINITIONS[tool];
        const dryRun = input.dryRun === true || this.config.mode !== 'enabled';
        const action = {
            tool,
            input: {
                ...input,
                target
            },
            mutating: meta.mutating,
            dryRun: dryRun || Boolean(input.planOnly),
            requiresConfirmation: meta.mutating && this.config.mode === 'enabled' && input.confirm !== true,
            description: meta.description
        };

        return {
            success: true,
            plan: {
                id: `global-agent-plan-${Date.now()}`,
                mode: this.config.mode,
                dryRun,
                target,
                actions: [action],
                createdAt: nowIso()
            }
        };
    }

    async planWithModel(input = {}, target = {}) {
        const modelStatus = this.client.getStatus();
        if (!modelStatus.available || this.config.mode === 'disabled') {
            return { success: false, reason: modelStatus.reason || 'model_not_available' };
        }

        let chainSummary = {};
        try {
            chainSummary = summarizeChainStatus(await this.orchestrator.getStatus(target));
        } catch (error) {
            chainSummary = { error: error.message };
        }

        const completion = await this.client.completeJson({
            system: buildGlobalPlanPrompt(),
            payload: {
                taskType: 'global_agent_plan',
                message: String(input.message || input.prompt || ''),
                requestedTool: input.tool || input.action || '',
                target,
                chainSummary,
                mode: this.config.mode,
                allowedTools: Object.keys(TOOL_DEFINITIONS),
                guardrails: {
                    ...buildConstraints(),
                    highRiskRequiresConfirmation: true,
                    dryRunBlocksMutation: true
                }
            }
        });

        if (!completion.success) {
            return { success: false, reason: completion.reason || 'model_plan_failed', modelError: completion };
        }

        const rawPlan = completion.parsed || {};
        const guardrail = this.checkGuardrails({ input, modelPlan: rawPlan });
        if (!guardrail.allowed) {
            return {
                success: false,
                blocked: true,
                reason: guardrail.reason,
                plan: {
                    mode: this.config.mode,
                    actions: [],
                    blocked: true,
                    guardrail,
                    model: completion.rawMeta || null
                }
            };
        }

        let tool = String(rawPlan.tool || rawPlan.action || '').trim();
        const message = String(input.message || input.prompt || '').toLowerCase();
        if (!isExecutionRequest(message) && isReadinessQuestion(message)) {
            if (tool === 'run_method1' || /页面采集|页面|method1/.test(message)) {
                tool = 'get_method1_workflow';
            } else if (tool === 'run_method2' || /请求采集|请求验证|method2/.test(message)) {
                tool = 'get_method2_workflow';
            }
        }
        if (!TOOL_DEFINITIONS[tool]) {
            return { success: false, reason: 'model_plan_invalid_tool', modelTool: tool };
        }

        const meta = TOOL_DEFINITIONS[tool];
        const dryRun = input.dryRun === true || this.config.mode !== 'enabled';
        const modelInput = rawPlan.input && typeof rawPlan.input === 'object' && !Array.isArray(rawPlan.input)
            ? rawPlan.input
            : {};
        const action = {
            tool,
            input: {
                ...input,
                ...modelInput,
                target
            },
            mutating: meta.mutating,
            dryRun: dryRun || Boolean(input.planOnly),
            requiresConfirmation: meta.mutating && this.config.mode === 'enabled' && input.confirm !== true,
            description: meta.description,
            reason: String(rawPlan.reason || '')
        };

        return {
            success: true,
            plan: {
                id: `global-agent-plan-${Date.now()}`,
                mode: this.config.mode,
                dryRun,
                target,
                source: 'model',
                model: completion.rawMeta || null,
                actions: [action],
                createdAt: nowIso()
            }
        };
    }

    async execute(input = {}) {
        const plan = input.plan || input;
        const actions = Array.isArray(plan.actions) ? plan.actions : [];
        const results = [];

        if (this.config.mode === 'disabled') {
            return {
                success: false,
                reason: 'global_agent_disabled',
                message: '全局智能助手未启用，仅可生成规则建议。',
                results: actions.map(action => ({ tool: action.tool, skipped: true, reason: 'global_agent_disabled' }))
            };
        }

        for (const action of actions) {
            if (!TOOL_DEFINITIONS[action.tool]) {
                results.push({ tool: action.tool, success: false, reason: 'unknown_tool' });
                continue;
            }
            const meta = TOOL_DEFINITIONS[action.tool];
            const dryRunRequested = this.config.mode === 'dry_run' || action.dryRun === true || input.dryRun === true;
            if (meta.mutating && dryRunRequested) {
                results.push({
                    tool: action.tool,
                    success: true,
                    dryRun: true,
                    skipped: true,
                    reason: 'dry_run',
                    plannedInput: action.input
                });
                continue;
            }
            if (meta.mutating && this.config.mode === 'enabled' && input.confirm !== true) {
                results.push({
                    tool: action.tool,
                    success: false,
                    reason: 'confirmation_required',
                    message: '写操作需要人工确认。'
                });
                continue;
            }
            results.push(await this.executeTool(action.tool, action.input || {}));
        }

        return {
            success: results.every(item => item.success !== false),
            mode: this.config.mode,
            results,
            executedAt: nowIso()
        };
    }

    async executeTool(tool, input = {}) {
        try {
            switch (tool) {
                case 'get_product_overview':
                    return this.getProductOverview(tool, input);
                case 'get_chain_status':
                    return { tool, success: true, data: await this.orchestrator.getStatus(input.target || input) };
                case 'get_method1_workflow':
                    return this.getMethodWorkflow(tool, 'method1', input);
                case 'get_method2_workflow':
                    return this.getMethodWorkflow(tool, 'method2', input);
                case 'list_reports':
                    return this.listReports(tool, input);
                case 'get_report_detail':
                    return this.getReportDetail(tool, input);
                case 'run_method1':
                    return { tool, ...(await this.orchestrator.run({ ...input, chain: 'method1' })) };
                case 'run_method2':
                    return { tool, ...(await this.orchestrator.run({ ...input, chain: 'method2' })) };
                case 'run_method3':
                    return { tool, ...(await this.orchestrator.run({ ...input, chain: 'method3' })) };
                case 'run_best_chain':
                    return { tool, ...(await this.orchestrator.run({ ...input, chain: 'best' })) };
                case 'diagnose_chain_failure':
                    return { tool, success: true, data: await this.orchestrator.diagnose(input) };
                case 'append_report_event':
                    return this.appendReportEvent(tool, input);
                case 'append_report_evidence':
                    return this.appendReportEvidence(tool, input);
                case 'finalize_report':
                    return this.finalizeReport(tool, input);
                case 'start_mobile_workflow':
                    return this.startMobileWorkflow(tool, input);
                default:
                    return { tool, success: false, reason: 'unknown_tool' };
            }
        } catch (error) {
            return { tool, success: false, reason: 'tool_execution_failed', message: error.message };
        }
    }

    async getProductOverview(tool, input = {}) {
        const chainStatus = await this.orchestrator.getStatus(input.target || input);
        let reports = null;
        if (this.reportService && typeof this.reportService.listReports === 'function') {
            reports = this.reportService.listReports({ limit: 5 });
        }
        return {
            tool,
            success: true,
            data: {
                chainStatus,
                reports
            }
        };
    }

    async getMethodWorkflow(tool, chain, input = {}) {
        const target = this.orchestrator.normalizeTarget(input.target || input);
        const service = chain === 'method1' ? this.orchestrator.method1Service : this.orchestrator.method2Service;
        const helperNames = chain === 'method1'
            ? ['getWorkflowReadiness', 'getWorkflowSummary', 'getWorkflowStatus']
            : ['getWorkflowReadiness', 'getWorkflowSummary', 'getWorkflowStatus', 'getCaptureReadiness'];

        for (const helperName of helperNames) {
            if (!service || typeof service[helperName] !== 'function') continue;
            try {
                const data = await service[helperName](chain === 'method1' ? { platform: target.platform, target } : { target });
                return {
                    tool,
                    success: true,
                    data: {
                        success: true,
                        source: `${chain}_service.${helperName}`,
                        chain,
                        target,
                        ...data
                    }
                };
            } catch (error) {
                return {
                    tool,
                    success: true,
                    data: buildWorkflowFallback(chain, await this.orchestrator.getStatus({ target }), target),
                    fallbackReason: error.message
                };
            }
        }

        const status = await this.orchestrator.getStatus({ target });
        return {
            tool,
            success: true,
            data: buildWorkflowFallback(chain, status, target)
        };
    }

    listReports(tool, input = {}) {
        if (!this.reportService || typeof this.reportService.listReports !== 'function') {
            return { tool, success: false, reason: 'report_service_missing' };
        }
        const limit = Math.max(1, Math.min(50, Number(input.limit || 10)));
        return { tool, success: true, data: this.reportService.listReports({ ...input, limit }) };
    }

    getReportDetail(tool, input = {}) {
        if (!this.reportService || typeof this.reportService.readReportRaw !== 'function') {
            return { tool, success: false, reason: 'report_service_missing' };
        }
        const reportId = String(input.reportId || input.id || '').trim();
        if (!reportId) {
            return { tool, success: false, reason: 'report_id_required' };
        }
        const report = this.reportService.readReportRaw(reportId);
        return {
            tool,
            success: true,
            data: {
                reportId: report.reportId || reportId,
                title: report.title || report.reportName || '',
                overallStatus: report.overallStatus || report.status || 'unknown',
                conclusion: report.conclusion || '',
                riskLevel: report.riskLevel || 'unknown',
                evidenceCompleteness: report.evidenceCompleteness || 'unknown',
                target: report.target || {},
                methods: report.methods || [],
                findings: Array.isArray(report.findings) ? report.findings.slice(0, 20) : [],
                evidenceMatrix: Array.isArray(report.evidenceMatrix) ? report.evidenceMatrix.slice(0, 30) : [],
                updatedAt: report.updatedAt || null
            }
        };
    }

    appendReportEvent(tool, input = {}) {
        if (!this.reportService || !input.reportId) {
            return { tool, success: false, reason: 'report_id_required' };
        }
        const result = this.reportService.appendEvent(input.reportId, {
            at: nowIso(),
            source: 'global-agent',
            ...(input.event || input.data || {})
        });
        return { tool, success: true, data: result };
    }

    appendReportEvidence(tool, input = {}) {
        if (!this.reportService || !input.reportId) {
            return { tool, success: false, reason: 'report_id_required' };
        }
        const result = this.reportService.appendEvidence(input.reportId, input.evidence || input.data || {});
        return { tool, success: true, data: result };
    }

    finalizeReport(tool, input = {}) {
        if (!this.reportService || !input.reportId) {
            return { tool, success: false, reason: 'report_id_required' };
        }
        const result = this.reportService.finalizeReport(input.reportId, input.finalize || input.data || {});
        return { tool, success: true, data: result };
    }

    startMobileWorkflow(tool, input = {}) {
        if (!this.mobileCommandService) {
            return { tool, success: false, reason: 'mobile_command_service_missing' };
        }
        const workflow = this.mobileCommandService.startCityIncrementWorkflow(input.workflow || input);
        return { tool, success: true, data: workflow };
    }

    checkGuardrails(input = {}) {
        const text = JSON.stringify(input || {});
        for (const pattern of FORBIDDEN_PATTERNS) {
            if (pattern.test(text)) {
                return {
                    allowed: false,
                    reason: 'guardrail_blocked',
                    message: '请求触发安全护栏：禁止绕过鉴权、签名、验证码、风控，禁止伪造敏感凭证或提高请求强度。'
                };
            }
        }
        return { allowed: true };
    }

    buildReply(plan, execution) {
        if (!plan.success) {
            return plan.plan?.guardrail?.message || '全局智能助手无法生成可执行计划。';
        }
        const action = plan.plan.actions?.[0];
        if (!action) return '没有需要执行的动作。';
        if (!execution) {
            return `已生成计划：${action.description}`;
        }
        if (execution.success) {
            return execution.results?.some(item => item.dryRun)
                ? `已生成预演计划：${action.description}`
                : `已执行：${action.description}`;
        }
        return `执行未完成：${execution.reason || execution.results?.[0]?.reason || 'unknown_error'}`;
    }
}

module.exports = GlobalAgentService;
