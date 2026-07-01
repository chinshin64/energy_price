'use strict';

const { buildAiAgentConfig, publicConfig } = require('./ai-agent-client');
const { buildConstraints } = require('./request-failure-analyzer');

const TOOL_DEFINITIONS = {
    get_chain_status: {
        mutating: false,
        description: '读取三条测试链路统一状态。'
    },
    run_method1: {
        mutating: true,
        description: '执行页面自动化识别小规模验证。'
    },
    run_method2: {
        mutating: true,
        description: '执行后台自动化识别录包/分析。'
    },
    run_method3: {
        mutating: true,
        description: '执行流量自动化识别小规模验证。'
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
        return this.config;
    }

    getStatus() {
        return {
            success: true,
            available: this.config.mode !== 'disabled',
            mode: this.config.mode,
            reason: this.config.mode === 'disabled' ? 'global_agent_disabled' : 'global_agent_ready',
            config: publicConfig(this.config),
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
            if (/执行|开始|运行|验证|run|execute/.test(message)) {
                if (/方式一|页面|method1/.test(message)) {
                    tool = 'run_method1';
                } else if (/方式二|录包|请求验证|method2/.test(message)) {
                    tool = 'run_method2';
                } else if (/方式三|接口|流量|method3/.test(message)) {
                    tool = 'run_method3';
                } else {
                    tool = 'run_best_chain';
                }
            } else if (/状态|status|检查|诊断/.test(message)) {
                tool = /诊断/.test(message) ? 'diagnose_chain_failure' : 'get_chain_status';
            } else if (/方式一|页面|method1/.test(message)) {
                tool = 'run_method1';
            } else if (/方式二|录包|请求验证|method2/.test(message)) {
                tool = 'run_method2';
            } else if (/方式三|接口|流量|method3/.test(message)) {
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

    async execute(input = {}) {
        const plan = input.plan || input;
        const actions = Array.isArray(plan.actions) ? plan.actions : [];
        const results = [];

        if (this.config.mode === 'disabled') {
            return {
                success: false,
                reason: 'global_agent_disabled',
                message: '全局 AI Agent 未启用，仅可生成规则建议。',
                results: actions.map(action => ({ tool: action.tool, skipped: true, reason: 'global_agent_disabled' }))
            };
        }

        for (const action of actions) {
            if (!TOOL_DEFINITIONS[action.tool]) {
                results.push({ tool: action.tool, success: false, reason: 'unknown_tool' });
                continue;
            }
            const meta = TOOL_DEFINITIONS[action.tool];
            if (this.config.mode === 'dry_run' || action.dryRun === true || input.dryRun === true) {
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
                case 'get_chain_status':
                    return { tool, success: true, data: await this.orchestrator.getStatus(input.target || input) };
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
            return plan.plan?.guardrail?.message || '全局 AI Agent 无法生成可执行计划。';
        }
        const action = plan.plan.actions?.[0];
        if (!action) return '没有需要执行的动作。';
        if (!execution) {
            return `已生成计划：${action.description}`;
        }
        if (execution.success) {
            return execution.results?.some(item => item.dryRun)
                ? `已完成预演：${action.description}`
                : `已执行：${action.description}`;
        }
        return `执行未完成：${execution.reason || execution.results?.[0]?.reason || 'unknown_error'}`;
    }
}

module.exports = GlobalAgentService;
