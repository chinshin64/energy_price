(function attachAiAgentDashboardControl(global) {
    'use strict';

    function requireDependency(deps, name) {
        const value = deps[name];
        if (!value) {
            throw new Error(`AI agent dashboard dependency missing: ${name}`);
        }
        return value;
    }

    function createController(deps = {}) {
        const documentRef = deps.document || global.document;
        const fetchRef = deps.fetch || global.fetch?.bind(global);
        if (!fetchRef) {
            throw new Error('AI agent dashboard dependency missing: fetch');
        }
        const serviceBase = requireDependency(deps, 'serviceBase');
        const formatUserReason = requireDependency(deps, 'formatUserReason');
        const setElementText = requireDependency(deps, 'setElementText');
        const setStatusBannerState = requireDependency(deps, 'setStatusBannerState');

        function byId(id) {
            return documentRef.getElementById(id);
        }

        function summarizeFailureEvent(item = {}) {
            const event = item.failureEvent || item;
            const sourceMap = { method2: '请求采集', method3: '小规模访问验证' };
            const source = sourceMap[event.source] || event.source || '-';
            const reason = event.error?.reason || item.reason || event.reason || 'unknown_error';
            const status = event.response?.httpStatus ? `HTTP ${event.response.httpStatus}` : '';
            const path = event.request?.path || '';
            return `${source}｜${formatUserReason(reason, { includeTech: false })}${status ? `｜${status}` : ''}${path ? `｜${path}` : ''}`;
        }

        function summarizeAgentAnalysis(item = {}) {
            const analysis = item.analysis || item.agentAnalysis || item;
            const diagnosis = analysis.diagnosis || {};
            const nextAction = analysis.nextAction || {};
            return `${diagnosis.category || 'unknown'}｜置信度 ${Math.round((Number(diagnosis.confidence) || 0) * 100)}%｜${diagnosis.reason || '-'}｜建议：${nextAction.reason || nextAction.action || '-'}`;
        }

        function summarizeStrategyPatch(item = {}) {
            const patch = item.patch || item.strategyPatch || item;
            const status = item.status || patch.status || '待处理';
            return `${patch.patchType || 'no_auto_change'}｜风险：${patch.riskLevel || '-'}｜处理方式：${patch.applyMode || 'manual_review'}｜状态：${status}`;
        }

        function renderDashboard(status = {}, events = [], analyses = [], patches = []) {
            const cfg = status.config || {};
            const modeLabel = ({ enabled: '已启用', dry_run: '预演模式', disabled: '未启用' }[cfg.mode]) || '未配置';
            setElementText('aiAgentMode', modeLabel);
            setElementText('aiAgentModel', cfg.configured ? '已配置' : '未配置');
            setElementText('aiAgentBaseUrl', cfg.configured ? '已配置' : '未配置');
            setElementText('aiAgentKeyStatus', cfg.configured ? '已配置' : '未配置');

            const banner = byId('aiAgentStatusBanner');
            if (banner) {
                const message = status.available
                    ? `智能诊断助手已可用：${modeLabel}，失败后会生成诊断建议。`
                    : `智能诊断助手不可用：${formatUserReason(status.reason || 'ai_agent_not_configured', { includeTech: false })}`;
                setStatusBannerState(banner, message, status.available ? 'success' : 'warn');
            }

            const failureEl = byId('aiAgentFailureEvents');
            if (failureEl) {
                failureEl.value = events.length ? events.map(summarizeFailureEvent).join('\n') : '暂无失败记录。';
            }
            const analysesEl = byId('aiAgentAnalyses');
            if (analysesEl) {
                analysesEl.value = analyses.length ? analyses.map(summarizeAgentAnalysis).join('\n\n') : '暂无诊断结果。';
            }
            const patchesEl = byId('aiAgentPatches');
            if (patchesEl) {
                patchesEl.value = patches.length ? patches.map(summarizeStrategyPatch).join('\n') : '暂无待处理建议。';
            }
        }

        async function loadDashboard() {
            try {
                const [statusRes, eventsRes, analysesRes, patchesRes] = await Promise.all([
                    fetchRef(`${serviceBase}/ai-agent/status`),
                    fetchRef(`${serviceBase}/ai-agent/failure-events?limit=5`),
                    fetchRef(`${serviceBase}/ai-agent/analyses?limit=5`),
                    fetchRef(`${serviceBase}/ai-agent/patches?limit=5`)
                ]);
                const status = await statusRes.json().catch(() => ({}));
                const events = await eventsRes.json().catch(() => ({}));
                const analyses = await analysesRes.json().catch(() => ({}));
                const patches = await patchesRes.json().catch(() => ({}));
                renderDashboard(status, events.items || [], analyses.items || [], patches.items || []);
                return status;
            } catch (error) {
                renderDashboard({ available: false, reason: 'ai_agent_request_failed', error: error.message }, [], [], []);
                return { success: false, reason: 'ai_agent_request_failed', error: error.message };
            }
        }

        return {
            loadDashboard,
            renderDashboard,
            summarizeAgentAnalysis,
            summarizeFailureEvent,
            summarizeStrategyPatch
        };
    }

    global.AiAgentDashboardControl = { createController };
})(window);
