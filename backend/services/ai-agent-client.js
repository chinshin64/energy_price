'use strict';

const axios = require('axios');
const { redactObject } = require('./sensitive-redactor');

const DEFAULT_TIMEOUT_MS = 60000;

function normalizeMode(value) {
    const mode = String(value || 'disabled').trim().toLowerCase();
    if (['enabled', 'dry_run', 'dry-run', 'disabled'].includes(mode)) {
        return mode === 'dry-run' ? 'dry_run' : mode;
    }
    return 'disabled';
}

function truthy(value) {
    return /^(1|true|yes|on)$/i.test(String(value || ''));
}

function buildAiAgentConfig(baseConfig = {}) {
    const cfg = baseConfig.aiAgent || baseConfig || {};
    return {
        mode: normalizeMode(process.env.AI_AGENT_MODE || cfg.mode),
        type: String(process.env.AI_AGENT_TYPE || cfg.type || 'openai_compatible').trim().toLowerCase(),
        baseUrl: String(process.env.AI_AGENT_BASE_URL || cfg.baseUrl || '').trim(),
        apiKey: String(process.env.AI_AGENT_API_KEY || cfg.apiKey || '').trim(),
        modelId: String(process.env.AI_AGENT_MODEL_ID || cfg.modelId || cfg.model || '').trim(),
        timeoutMs: Number(process.env.AI_AGENT_TIMEOUT_MS || cfg.timeoutMs || DEFAULT_TIMEOUT_MS),
        applyLowRiskPatches: process.env.AI_AGENT_APPLY_LOW_RISK_PATCHES !== undefined
            ? truthy(process.env.AI_AGENT_APPLY_LOW_RISK_PATCHES)
            : Boolean(cfg.applyLowRiskPatches),
        saveEvents: process.env.AI_AGENT_SAVE_EVENTS !== undefined
            ? truthy(process.env.AI_AGENT_SAVE_EVENTS)
            : cfg.saveEvents !== false,
        temperature: Number(process.env.AI_AGENT_TEMPERATURE || cfg.temperature || 0),
        maxTokens: Number(process.env.AI_AGENT_MAX_TOKENS || cfg.maxTokens || 1200),
    };
}

function publicConfig(config = {}) {
    return {
        mode: config.mode,
        type: config.type,
        baseUrl: config.baseUrl ? config.baseUrl.replace(/\/[^/]*$/, '/***') : '',
        modelId: config.modelId || '',
        timeoutMs: config.timeoutMs,
        applyLowRiskPatches: Boolean(config.applyLowRiskPatches),
        saveEvents: Boolean(config.saveEvents),
        configured: Boolean(config.baseUrl && config.apiKey && config.modelId),
    };
}

function extractJsonFromModelContent(content) {
    if (!content || typeof content !== 'string') {
        throw new Error('empty model content');
    }
    const trimmed = content.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        return JSON.parse(trimmed);
    }
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenced && fenced[1]) {
        return JSON.parse(fenced[1].trim());
    }
    const first = trimmed.indexOf('{');
    const last = trimmed.lastIndexOf('}');
    if (first >= 0 && last > first) {
        return JSON.parse(trimmed.slice(first, last + 1));
    }
    throw new Error('model content is not JSON');
}

function validateAgentAnalysis(raw) {
    if (!raw || typeof raw !== 'object') {
        return { success: false, reason: 'ai_agent_invalid_schema', message: 'analysis is not an object' };
    }
    const diagnosis = raw.diagnosis && typeof raw.diagnosis === 'object' ? raw.diagnosis : {};
    const nextAction = raw.nextAction && typeof raw.nextAction === 'object' ? raw.nextAction : {};
    const strategyPatch = raw.strategyPatch && typeof raw.strategyPatch === 'object' ? raw.strategyPatch : undefined;

    return {
        success: raw.success !== false,
        diagnosis: {
            category: String(diagnosis.category || 'unknown'),
            confidence: Math.max(0, Math.min(1, Number(diagnosis.confidence || 0))),
            reason: String(diagnosis.reason || 'No diagnosis reason returned'),
            evidence: Array.isArray(diagnosis.evidence) ? diagnosis.evidence.map(String).slice(0, 20) : [],
        },
        strategyPatch: strategyPatch ? {
            patchType: String(strategyPatch.patchType || 'no_auto_change'),
            riskLevel: String(strategyPatch.riskLevel || 'medium'),
            applyMode: String(strategyPatch.applyMode || 'manual_review'),
            changes: redactObject(strategyPatch.changes || {}),
        } : undefined,
        nextAction: {
            action: String(nextAction.action || 'manual_review'),
            reason: String(nextAction.reason || 'Manual review required'),
        },
        rawMeta: raw.rawMeta && typeof raw.rawMeta === 'object' ? raw.rawMeta : undefined,
    };
}

class AiAgentClient {
    constructor(config = {}) {
        this.config = buildAiAgentConfig(config);
    }

    getStatus() {
        const cfg = this.config;
        if (cfg.mode === 'disabled') {
            return { success: true, available: false, reason: 'ai_agent_disabled', config: publicConfig(cfg) };
        }
        if (cfg.type !== 'openai_compatible') {
            return { success: true, available: false, reason: 'ai_agent_type_unsupported', config: publicConfig(cfg) };
        }
        if (!cfg.baseUrl || !cfg.apiKey || !cfg.modelId) {
            return { success: true, available: false, reason: 'ai_agent_not_configured', config: publicConfig(cfg) };
        }
        return { success: true, available: true, reason: 'ai_agent_configured', config: publicConfig(cfg) };
    }

    async analyzeFailure(payload) {
        const cfg = this.config;
        if (cfg.mode === 'disabled') {
            return { success: false, reason: 'ai_agent_disabled' };
        }
        if (cfg.type !== 'openai_compatible') {
            return { success: false, reason: 'ai_agent_type_unsupported', type: cfg.type };
        }
        if (!cfg.baseUrl || !cfg.apiKey || !cfg.modelId) {
            return { success: false, reason: 'ai_agent_not_configured' };
        }

        const url = cfg.baseUrl.replace(/\/$/, '') + '/chat/completions';
        const safePayload = redactObject(payload || {});
        const body = {
            model: cfg.modelId,
            temperature: cfg.temperature,
            max_tokens: cfg.maxTokens,
            messages: [
                {
                    role: 'system',
                    content: [
                        '你是风控蓝军测试系统的请求失败诊断 Agent。',
                        '你只能分析失败原因并输出请求策略建议。',
                        '禁止建议绕过登录、鉴权、签名校验、验证码或风控。',
                        '禁止建议伪造 sign/signature/token/cookie。',
                        '禁止建议提高 maxPages、maxRequestCount 或 maxQps。',
                        '必须区分 HTTP status 501 与响应体业务 code=501。',
                        '必须只输出 JSON，不要输出 Markdown、代码块或解释性正文。',
                        'JSON schema: {"success":boolean,"diagnosis":{"category":string,"confidence":number,"reason":string,"evidence":string[]},"strategyPatch":{"patchType":string,"riskLevel":"low|medium|high","applyMode":"auto|manual_review","changes":object},"nextAction":{"action":string,"reason":string}}'
                    ].join('\n')
                },
                {
                    role: 'user',
                    content: JSON.stringify(safePayload)
                }
            ]
        };

        try {
            const resp = await axios.post(url, body, {
                timeout: cfg.timeoutMs,
                headers: {
                    'content-type': 'application/json',
                    authorization: `Bearer ${cfg.apiKey}`,
                },
                validateStatus: () => true,
            });

            if (resp.status < 200 || resp.status >= 300) {
                return {
                    success: false,
                    reason: 'ai_agent_request_failed',
                    status: resp.status,
                    message: typeof resp.data === 'string' ? resp.data.slice(0, 1000) : JSON.stringify(redactObject(resp.data || {})).slice(0, 1000),
                };
            }

            const content = resp.data?.choices?.[0]?.message?.content;
            if (!content) {
                return { success: false, reason: 'ai_agent_empty_response' };
            }

            let parsed;
            try {
                parsed = extractJsonFromModelContent(content);
            } catch (err) {
                return {
                    success: false,
                    reason: 'ai_agent_invalid_json',
                    message: err.message,
                    rawContent: content.slice(0, 2000),
                };
            }

            return validateAgentAnalysis(parsed);
        } catch (err) {
            return {
                success: false,
                reason: err.code === 'ECONNABORTED' ? 'ai_agent_timeout' : 'ai_agent_call_failed',
                message: err.message,
            };
        }
    }
}

module.exports = {
    AiAgentClient,
    buildAiAgentConfig,
    publicConfig,
    validateAgentAnalysis,
};
