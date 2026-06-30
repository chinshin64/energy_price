'use strict';

const path = require('path');
const { AiAgentClient, buildAiAgentConfig } = require('./ai-agent-client');
const RequestStrategyStore = require('./request-strategy-store');
const { RequestStrategyApplier } = require('./request-strategy-applier');
const { redactObject } = require('./sensitive-redactor');

function buildConstraints() {
    return {
        cannotBypassAuth: true,
        cannotBypassSignature: true,
        cannotIncreaseRequestLimit: true,
        cannotExposeSensitiveFields: true,
        allowedAutoPatchTypes: [
            'mark_endpoint_unsupported',
            'disable_template',
            'require_live_capture',
            'reduce_request_rate',
            'update_error_classifier',
        ],
        manualReviewRequiredTypes: [
            'change_host',
            'change_path',
            'change_method',
            'change_signature_material',
            'add_required_param',
            'reuse_cross_city_material',
        ],
        forbiddenPatchTypes: [
            'bypass_signature_check',
            'generate_fake_signature',
            'bypass_auth',
            'bypass_captcha',
            'evade_risk_control',
            'increase_request_limit',
        ],
    };
}

function classifyReasonFromResponse(response = {}, fallbackReason = 'unknown_error') {
    const httpStatus = Number(response.httpStatus || response.status || 0);
    const businessCode = response.businessCode ?? response.bodySummary?.code ?? response.bodySummary?.errno;
    if (httpStatus === 501) return 'http_501';
    if (String(businessCode) === '501') return 'business_code_501';
    if (httpStatus >= 500) return 'http_5xx';
    if (httpStatus >= 400) return 'http_4xx';
    return fallbackReason;
}

class RequestFailureAnalyzer {
    constructor(options = {}) {
        this.config = buildAiAgentConfig(options.config || {});
        this.store = options.store || new RequestStrategyStore({
            projectRoot: options.projectRoot || path.join(__dirname, '../..'),
        });
        this.client = options.client || new AiAgentClient(this.config);
        this.applier = options.applier || new RequestStrategyApplier({
            store: this.store,
            applyLowRiskPatches: this.config.applyLowRiskPatches,
        });
    }

    getStatus() {
        return this.client.getStatus();
    }

    async analyzeFailure(event = {}) {
        const failureEvent = this._buildFailureEvent(event);
        const savedEvent = this.config.saveEvents === false ? failureEvent : this.store.appendFailureEvent(failureEvent);

        if (this.config.mode === 'disabled') {
            return {
                success: false,
                reason: 'ai_agent_disabled',
                failureEventId: savedEvent.id,
            };
        }

        const payload = {
            taskType: 'request_failure_analysis',
            failureEvent: savedEvent,
            constraints: buildConstraints(),
        };

        const analysis = await this.client.analyzeFailure(payload);
        const savedAnalysis = this.store.appendAnalysis({
            failureEventId: savedEvent.id,
            source: savedEvent.source,
            analysis,
            mode: this.config.mode,
        });

        let patchCandidate = null;
        if (analysis.success && analysis.strategyPatch) {
            patchCandidate = this.applier.createPatchCandidate({
                failureEventId: savedEvent.id,
                analysisId: savedAnalysis.id,
                source: savedEvent.source,
                strategyPatch: analysis.strategyPatch,
            });
        }

        return {
            success: analysis.success,
            reason: analysis.success ? 'agent_analysis_ready' : (analysis.reason || 'agent_analysis_failed'),
            failureEventId: savedEvent.id,
            analysisId: savedAnalysis.id,
            agentAnalysis: analysis.success ? analysis : undefined,
            agentError: analysis.success ? undefined : analysis,
            strategyPatch: patchCandidate,
        };
    }

    _buildFailureEvent(event = {}) {
        const response = redactObject(event.response || {});
        const reason = event.error?.reason || event.reason || classifyReasonFromResponse(response, 'unknown_error');
        return redactObject({
            id: event.id,
            source: event.source || 'unknown',
            taskId: event.taskId,
            templateId: event.templateId,
            request: event.request || {},
            response,
            error: {
                reason,
                message: event.error?.message || event.message || '',
            },
            context: event.context || {},
            createdAt: event.createdAt || new Date().toISOString(),
        });
    }
}

let singleton = null;
function getRequestFailureAnalyzer(options = {}) {
    if (!singleton) {
        singleton = new RequestFailureAnalyzer(options);
    }
    return singleton;
}

module.exports = {
    RequestFailureAnalyzer,
    getRequestFailureAnalyzer,
    buildConstraints,
    classifyReasonFromResponse,
};
