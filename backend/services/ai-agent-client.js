'use strict';

const axios = require('axios');
const { redactObject } = require('./sensitive-redactor');

const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_ANTHROPIC_VERSION = '2023-06-01';
const SUPPORTED_TYPES = new Set(['openai_compatible', 'anthropic_native']);
const AI_AGENT_MODEL_PRESETS = [
    { id: 'deepseek-v4-pro-external', label: 'DeepSeek V4 Pro', type: 'openai_compatible', contextWindow: 'provider_default' },
    { id: 'glm-5.1', label: 'GLM 5.1', type: 'openai_compatible', contextWindow: 'provider_default' },
    { id: 'glm-5.2', label: 'GLM 5.2', type: 'openai_compatible', contextWindow: 'provider_default' },
    { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', type: 'openai_compatible', contextWindow: 'provider_default' },
    { id: 'deepseek-ve-pro', label: 'DeepSeek VE Pro', type: 'openai_compatible', contextWindow: 'provider_default' },
];

function normalizeMode(value) {
    const mode = String(value || 'disabled').trim().toLowerCase();
    if (['enabled', 'dry_run', 'dry-run', 'disabled'].includes(mode)) {
        return mode === 'dry-run' ? 'dry_run' : mode;
    }
    return 'disabled';
}

function normalizeType(value) {
    const raw = String(value || 'openai_compatible').trim().toLowerCase();
    if (['openai', 'openai-compatible', 'openai_compatible'].includes(raw)) {
        return 'openai_compatible';
    }
    if (['anthropic', 'anthropic-native', 'anthropic_native', 'claude', 'claude-native', 'claude_native'].includes(raw)) {
        return 'anthropic_native';
    }
    return raw || 'openai_compatible';
}

function truthy(value) {
    return /^(1|true|yes|on)$/i.test(String(value || ''));
}

function buildAiAgentConfig(baseConfig = {}) {
    const cfg = baseConfig.aiAgent || baseConfig || {};
    return {
        mode: normalizeMode(process.env.AI_AGENT_MODE || cfg.mode),
        type: normalizeType(process.env.AI_AGENT_TYPE || cfg.type || 'openai_compatible'),
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
        anthropicVersion: String(process.env.AI_AGENT_ANTHROPIC_VERSION || cfg.anthropicVersion || DEFAULT_ANTHROPIC_VERSION).trim(),
    };
}

function publicConfig(config = {}) {
    return {
        mode: config.mode,
        type: config.type,
        baseUrl: config.baseUrl ? config.baseUrl.replace(/\/[^/]*$/, '/***') : '',
        modelId: config.modelId || '',
        timeoutMs: config.timeoutMs,
        maxTokens: config.maxTokens,
        contextWindow: 'provider_default',
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

function joinEndpoint(baseUrl, endpoint) {
    const cleanBase = String(baseUrl || '').trim().replace(/\/+$/, '');
    const cleanEndpoint = String(endpoint || '').replace(/^\/+/, '');
    if (!cleanBase) return `/${cleanEndpoint}`;
    if (cleanBase.toLowerCase().endsWith(`/${cleanEndpoint.toLowerCase()}`)) {
        return cleanBase;
    }
    return `${cleanBase}/${cleanEndpoint}`;
}

function modelContentToText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map(part => {
            if (typeof part === 'string') return part;
            if (part && typeof part.text === 'string') return part.text;
            if (part && typeof part.content === 'string') return part.content;
            return '';
        }).filter(Boolean).join('\n');
    }
    if (content && typeof content.text === 'string') return content.text;
    return '';
}

function buildFailureAnalysisPrompt() {
    return [
        'You are the request failure diagnosis agent for a blue-team testing system.',
        'Analyze why a request or chain failed and return only safe operational advice.',
        'Never suggest bypassing login, authorization, request-material validation, captcha, or risk control.',
        'Never suggest forging credentials, request materials, signatures, or authorization state.',
        'Never suggest increasing maxPages, maxRequestCount, maxQps, or collection radius.',
        'Distinguish HTTP status 501 from business response code=501.',
        'Return a structured object only. Do not return Markdown or explanatory prose.',
        'Schema: {"success":boolean,"diagnosis":{"category":string,"confidence":number,"reason":string,"evidence":string[]},"strategyPatch":{"patchType":string,"riskLevel":"low|medium|high","applyMode":"auto|manual_review","changes":object},"nextAction":{"action":string,"reason":string}}'
    ].join('\n');
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
        if (!SUPPORTED_TYPES.has(cfg.type)) {
            return { success: true, available: false, reason: 'ai_agent_type_unsupported', config: publicConfig(cfg) };
        }
        if (!cfg.baseUrl || !cfg.apiKey || !cfg.modelId) {
            return { success: true, available: false, reason: 'ai_agent_not_configured', config: publicConfig(cfg) };
        }
        return { success: true, available: true, reason: 'ai_agent_configured', config: publicConfig(cfg) };
    }

    async completeJson({ system, payload }) {
        const status = this.getStatus();
        if (!status.available) {
            return { success: false, reason: status.reason, config: status.config };
        }

        try {
            const response = await this.callModel({
                system,
                payload: redactObject(payload || {})
            });
            if (!response.success) {
                return response;
            }
            const parsed = extractJsonFromModelContent(response.content);
            return {
                success: true,
                parsed,
                rawMeta: response.rawMeta
            };
        } catch (err) {
            const isJsonError = /JSON|empty model content|not JSON|Unexpected token/i.test(err.message || '');
            return {
                success: false,
                reason: isJsonError ? 'ai_agent_invalid_json' : (err.code === 'ECONNABORTED' ? 'ai_agent_timeout' : 'ai_agent_call_failed'),
                message: err.message,
            };
        }
    }

    async callModel({ system, payload }) {
        if (this.config.type === 'anthropic_native') {
            return this.callAnthropicNative({ system, payload });
        }
        return this.callOpenAICompatible({ system, payload });
    }

    async callOpenAICompatible({ system, payload }) {
        const cfg = this.config;
        const resp = await axios.post(joinEndpoint(cfg.baseUrl, 'chat/completions'), {
            model: cfg.modelId,
            temperature: cfg.temperature,
            max_tokens: cfg.maxTokens,
            messages: [
                { role: 'system', content: String(system || '') },
                { role: 'user', content: JSON.stringify(payload || {}) }
            ]
        }, {
            timeout: cfg.timeoutMs,
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${cfg.apiKey}`,
            },
            validateStatus: () => true,
        });

        if (resp.status < 200 || resp.status >= 300) {
            return this.requestFailed(resp);
        }

        const content = modelContentToText(resp.data?.choices?.[0]?.message?.content);
        if (!content) {
            return { success: false, reason: 'ai_agent_empty_response' };
        }
        return {
            success: true,
            content,
            rawMeta: {
                provider: cfg.type,
                model: resp.data?.model,
                usage: resp.data?.usage
            }
        };
    }

    async callAnthropicNative({ system, payload }) {
        const cfg = this.config;
        const resp = await axios.post(joinEndpoint(cfg.baseUrl, 'messages'), {
            model: cfg.modelId,
            max_tokens: cfg.maxTokens,
            temperature: Math.max(0, Math.min(1, Number(cfg.temperature) || 0)),
            system: String(system || ''),
            messages: [
                { role: 'user', content: JSON.stringify(payload || {}) }
            ]
        }, {
            timeout: cfg.timeoutMs,
            headers: {
                'content-type': 'application/json',
                'x-api-key': cfg.apiKey,
                'anthropic-version': cfg.anthropicVersion || DEFAULT_ANTHROPIC_VERSION,
            },
            validateStatus: () => true,
        });

        if (resp.status < 200 || resp.status >= 300) {
            return this.requestFailed(resp);
        }

        const content = modelContentToText(resp.data?.content);
        if (!content) {
            return { success: false, reason: 'ai_agent_empty_response' };
        }
        return {
            success: true,
            content,
            rawMeta: {
                provider: cfg.type,
                model: resp.data?.model,
                usage: resp.data?.usage
            }
        };
    }

    requestFailed(resp) {
        return {
            success: false,
            reason: 'ai_agent_request_failed',
            status: resp.status,
            message: typeof resp.data === 'string'
                ? resp.data.slice(0, 1000)
                : JSON.stringify(redactObject(resp.data || {})).slice(0, 1000),
        };
    }

    async analyzeFailure(payload) {
        const completion = await this.completeJson({
            system: buildFailureAnalysisPrompt(),
            payload
        });
        if (!completion.success) {
            return completion;
        }

        const analysis = validateAgentAnalysis(completion.parsed);
        if (analysis.success && completion.rawMeta) {
            analysis.rawMeta = {
                ...(analysis.rawMeta || {}),
                provider: completion.rawMeta.provider,
                model: completion.rawMeta.model
            };
        }
        return analysis;
    }
}

module.exports = {
    AiAgentClient,
    buildAiAgentConfig,
    AI_AGENT_MODEL_PRESETS,
    publicConfig,
    validateAgentAnalysis,
    extractJsonFromModelContent,
};
