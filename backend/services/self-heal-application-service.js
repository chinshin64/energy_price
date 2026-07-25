'use strict';

class SelfHealApplicationService {
    constructor(options = {}) {
        this.appSettingModel = options.appSettingModel;
        this.diagnosticService = options.diagnosticService;
        this.enabled = Boolean(options.enabled);
        if (!this.appSettingModel || !this.diagnosticService) {
            throw new TypeError('self-heal application service dependencies are required');
        }
    }

    getAiFeatureStatus() {
        return {
            enabled: this.enabled,
            status: this.enabled ? 'enabled' : 'planned',
            message: this.enabled ? '已启用' : '未接入',
            plannedItems: [
                '手机控制自然语言指令解析',
                '移动端监督与页面决策',
                '自动排查与自愈诊断',
            ],
        };
    }

    getRuntimeMetadata() {
        return {
            enabled: this.enabled,
            status: this.enabled ? 'enabled' : 'planned',
            chainLabels: this.enabled ? this.diagnosticService.getChainLabels() : {},
            scenarios: this.enabled ? this.diagnosticService.getScenarioOptions() : [],
        };
    }

    getDisabledSettings() {
        return {
            enabled: false,
            status: 'planned',
            summary: '自动排查与自愈已暂时下线，后续版本恢复。',
            scenarios: [],
            chainLabels: {},
            aiFeatures: this.getAiFeatureStatus(),
        };
    }

    getDisabledResponse(featureName = '智能能力') {
        return {
            success: false,
            code: 'ai_feature_planned',
            error: `${featureName}已暂时下线，标记为后续版本更新项。`,
            aiFeatures: this.getAiFeatureStatus(),
        };
    }

    getSettings() {
        const settings = this.appSettingModel.getSelfHealSettings();
        return {
            ...settings,
            summary: this.diagnosticService.buildSummary(settings),
            scenarios: this.diagnosticService.getScenarioOptions(),
            chainLabels: this.diagnosticService.getChainLabels(),
        };
    }

    saveSettings(payload = {}) {
        this.appSettingModel.saveSelfHealSettings(payload);
        return this.getSettings();
    }

    listRuns(limit) {
        return this.appSettingModel.getSelfHealRuns(limit);
    }

    diagnose(payload = {}) {
        return this.diagnosticService.diagnose({
            ...payload,
            settings: this.appSettingModel.getSelfHealSettings(),
            networkSettings: this.appSettingModel.getProxySettings(),
        });
    }

    recordDiagnosis(diagnosis, payload = {}) {
        return this.appSettingModel.recordSelfHealRun({
            scheduleId: payload.scheduleId || null,
            scheduleName: payload.scheduleName || '',
            platform: payload.platform || '',
            currentChain: diagnosis.currentChain,
            currentChainLabel: diagnosis.currentChainLabel,
            nextChain: diagnosis.nextChain,
            nextChainLabel: diagnosis.nextChainLabel,
            fallbackChain: diagnosis.fallbackChain || null,
            fallbackChainLabel: diagnosis.fallbackChainLabel || null,
            scenario: diagnosis.scenario,
            title: diagnosis.title,
            status: diagnosis.status,
            summary: diagnosis.summary,
            capabilityDiagnostics: diagnosis.capabilityDiagnostics || [],
            execution: diagnosis.execution,
            repairPlan: diagnosis.repairPlan,
        });
    }

    diagnoseAndRecord(payload = {}) {
        const diagnosis = this.diagnose(payload);
        const run = this.recordDiagnosis(diagnosis, {
            platform: Array.isArray(payload.platforms) && payload.platforms[0] ? payload.platforms[0] : '',
            scheduleId: payload.scheduleId || null,
            scheduleName: payload.scheduleName || '',
        });
        return { diagnosis, run };
    }

    apply(payload = {}) {
        const diagnosis = payload.diagnosis && typeof payload.diagnosis === 'object' && !Array.isArray(payload.diagnosis)
            ? payload.diagnosis
            : this.diagnose(payload);
        const targetChainLabel = diagnosis.currentChainLabel
            || diagnosis.execution?.targetChainLabel
            || diagnosis.nextChainLabel
            || '';
        const run = this.appSettingModel.recordSelfHealRun({
            scheduleId: payload.scheduleId || null,
            scheduleName: payload.scheduleName || '',
            platform: Array.isArray(payload.platforms) && payload.platforms[0] ? payload.platforms[0] : '',
            currentChain: diagnosis.currentChain,
            currentChainLabel: diagnosis.currentChainLabel,
            nextChain: diagnosis.nextChain || null,
            nextChainLabel: diagnosis.nextChainLabel || null,
            fallbackChain: diagnosis.fallbackChain || diagnosis.execution?.fallbackChain || null,
            fallbackChainLabel: diagnosis.fallbackChainLabel || diagnosis.execution?.fallbackChainLabel || null,
            scenario: diagnosis.scenario,
            title: '已执行当前能力修复',
            status: 'applied',
            summary: targetChainLabel ? `已按方案执行 ${targetChainLabel} 当前能力修复` : '已按方案继续当前能力',
            capabilityDiagnostics: diagnosis.capabilityDiagnostics || [],
            execution: diagnosis.execution || null,
            repairPlan: diagnosis.repairPlan || [],
        });
        return { run };
    }

    inferApiFailureScenario(reason, runQuota = null) {
        const text = String(reason || '').toLowerCase();
        if (text.includes('no_active_template') || text.includes('无可用模板')) return 'template_missing';
        if (text.includes('signed_template_target_mismatch') || text.includes('签名')) return 'api_501_burst';
        if (text.includes('501') || Number(runQuota?.fail501) > 0) return 'api_501_burst';
        if (text.includes('empty') || text.includes('unexpected end') || text.includes('json')) return 'api_empty_payload';
        if (text.includes('proxy')) return 'proxy_blocked';
        return 'api_empty_payload';
    }

    buildApiFailure(platform, reason, runQuota = null) {
        if (!this.enabled) {
            return {
                skipped: true,
                reason: 'ai_feature_planned',
                aiFeatures: this.getAiFeatureStatus(),
            };
        }
        const diagnosis = this.diagnose({
            scenario: this.inferApiFailureScenario(reason, runQuota),
            currentChain: 'api',
            platforms: [platform],
            attempt: 1,
        });
        const run = this.recordDiagnosis(diagnosis, { platform });
        return { diagnosis, run };
    }

    enrichSchedule(schedule) {
        const settings = this.appSettingModel.getSelfHealSettings();
        const recovery = this.appSettingModel.getScheduleRecovery(schedule.id);
        return {
            ...schedule,
            self_heal_enabled: settings.enabled,
            self_heal_summary: this.diagnosticService.buildSummary(settings),
            last_recovery_status: recovery?.status || schedule.last_recovery_status || '未执行',
            last_recovery_summary: recovery?.summary || schedule.last_recovery_summary || '尚未演练自动修复',
            last_recovery_at: recovery?.at || schedule.last_recovery_at || null,
        };
    }
}

module.exports = SelfHealApplicationService;
