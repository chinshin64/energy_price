'use strict';

const LOW_RISK_PATCH_TYPES = new Set([
    'disable_template',
    'mark_endpoint_unsupported',
    'require_live_capture',
    'reduce_request_rate',
    'update_error_classifier',
]);

const HIGH_RISK_PATCH_TYPES = new Set([
    'change_host',
    'change_path',
    'change_method',
    'change_signature_material',
    'add_required_param',
    'reuse_cross_city_material',
]);

const FORBIDDEN_PATCH_TYPES = new Set([
    'bypass_signature_check',
    'generate_fake_signature',
    'bypass_auth',
    'bypass_captcha',
    'evade_risk_control',
    'increase_request_limit',
]);

function normalizePatch(rawPatch = {}) {
    return {
        patchType: String(rawPatch.patchType || 'no_auto_change'),
        riskLevel: String(rawPatch.riskLevel || 'medium'),
        applyMode: String(rawPatch.applyMode || 'manual_review'),
        changes: rawPatch.changes && typeof rawPatch.changes === 'object' ? rawPatch.changes : {},
    };
}

function validatePatch(rawPatch = {}) {
    const patch = normalizePatch(rawPatch);
    const type = patch.patchType;
    if (type === 'no_auto_change') {
        return { allowed: true, autoAllowed: false, reason: 'no_auto_change', patch };
    }
    if (FORBIDDEN_PATCH_TYPES.has(type)) {
        return { allowed: false, autoAllowed: false, reason: 'forbidden_patch_type', patch };
    }
    if (HIGH_RISK_PATCH_TYPES.has(type) || patch.riskLevel === 'high') {
        return { allowed: true, autoAllowed: false, reason: 'manual_review_required', patch: { ...patch, applyMode: 'manual_review' } };
    }
    if (LOW_RISK_PATCH_TYPES.has(type) && patch.riskLevel === 'low') {
        return { allowed: true, autoAllowed: patch.applyMode === 'auto', reason: 'low_risk_patch', patch };
    }
    return { allowed: true, autoAllowed: false, reason: 'manual_review_required', patch: { ...patch, applyMode: 'manual_review' } };
}

class RequestStrategyApplier {
    constructor(options = {}) {
        this.store = options.store;
        this.applyLowRiskPatches = Boolean(options.applyLowRiskPatches);
    }

    createPatchCandidate({ failureEventId, analysisId, source, strategyPatch }) {
        if (!strategyPatch) return null;
        const validation = validatePatch(strategyPatch);
        if (!validation.allowed) {
            return {
                rejected: true,
                reason: validation.reason,
                patch: validation.patch,
            };
        }
        const patchRecord = this.store.appendPatch({
            failureEventId,
            analysisId,
            source,
            patch: validation.patch,
            validation: {
                reason: validation.reason,
                autoAllowed: validation.autoAllowed,
            },
            status: validation.autoAllowed && this.applyLowRiskPatches ? 'auto_applied' : 'pending',
        });

        if (patchRecord.status === 'auto_applied') {
            this.applyPatchRecord(patchRecord, { appliedBy: 'ai_agent_auto' });
        }
        return patchRecord;
    }

    applyPatchById(patchId, options = {}) {
        const patchRecord = this.store.findPatch(patchId);
        if (!patchRecord) return { success: false, reason: 'patch_not_found' };
        const validation = validatePatch(patchRecord.patch || {});
        if (!validation.allowed) return { success: false, reason: validation.reason };
        if (!validation.autoAllowed && options.force !== true) {
            // Manual endpoint can pass force=true after human review.
        }
        this.applyPatchRecord(patchRecord, { appliedBy: options.appliedBy || 'human' });
        const marked = this.store.markPatch(patchId, 'applied', { appliedBy: options.appliedBy || 'human' });
        return { success: true, patch: marked };
    }

    rejectPatchById(patchId, options = {}) {
        const marked = this.store.markPatch(patchId, 'rejected', { rejectedBy: options.rejectedBy || 'human', rejectReason: options.reason || '' });
        if (!marked) return { success: false, reason: 'patch_not_found' };
        return { success: true, patch: marked };
    }

    applyPatchRecord(patchRecord, meta = {}) {
        const patch = patchRecord.patch || {};
        const changes = patch.changes || {};
        const strategyId = changes.strategyId || changes.templateId || `${patch.patchType}_default`;
        const existing = this.store.listStrategies().strategies?.find(item => item.id === strategyId) || {};
        return this.store.upsertStrategy({
            ...existing,
            id: strategyId,
            platform: changes.platform || existing.platform || 'unknown',
            apiType: changes.apiType || existing.apiType || 'unknown',
            status: changes.templateStatus || changes.status || existing.status || 'degraded',
            lastPatchType: patch.patchType,
            lastPatchReason: changes.reason || patchRecord.validation?.reason || '',
            updatedBy: meta.appliedBy || 'system',
        });
    }
}

module.exports = {
    RequestStrategyApplier,
    validatePatch,
    LOW_RISK_PATCH_TYPES,
    HIGH_RISK_PATCH_TYPES,
    FORBIDDEN_PATCH_TYPES,
};
