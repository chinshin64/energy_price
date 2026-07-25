(function attachSelfHealOperationsControl(global) {
    'use strict';

    function requireDependency(deps, name) {
        const value = deps[name];
        if (!value) {
            throw new Error(`Self-heal operations dependency missing: ${name}`);
        }
        return value;
    }

    function createController(deps = {}) {
        const documentRef = deps.document || global.document;
        const fetchRef = deps.fetch || global.fetch?.bind(global);
        const alertRef = deps.alert || global.alert?.bind(global) || (() => {});
        const consoleRef = deps.console || global.console || { warn: () => {} };
        if (!fetchRef) {
            throw new Error('Self-heal operations dependency missing: fetch');
        }
        const serviceBase = requireDependency(deps, 'serviceBase');
        const addLog = requireDependency(deps, 'addLog');
        const ensureSelectedPlatforms = requireDependency(deps, 'ensureSelectedPlatforms');
        const getSelectedPlatforms = deps.getSelectedPlatforms || (() => []);
        const getSelfHealConfig = deps.getSelfHealConfig || (() => ({}));
        const getSettingsControl = requireDependency(deps, 'getSettingsControl');
        const loadSelfHealRuns = deps.loadSelfHealRuns || (async () => {});
        const setStatusBannerState = requireDependency(deps, 'setStatusBannerState');
        const defaultPlatformId = deps.defaultPlatformId || 'didi-charging';
        let latestDiagnosis = null;

        function byId(id) {
            return documentRef.getElementById(id);
        }

        function getPlatformsForRequest() {
            const platforms = getSelectedPlatforms();
            return Array.isArray(platforms) && platforms.length > 0
                ? platforms
                : [defaultPlatformId];
        }

        function setStatus(message, tone = '') {
            setStatusBannerState(byId('selfHealStatus'), message, tone);
        }

        function renderPlan(diagnosis = null) {
            latestDiagnosis = diagnosis || null;
            getSettingsControl()?.renderPlan(diagnosis);
        }

        function renderInlineLogs(selfHeal, logger = addLog) {
            const diagnosis = selfHeal?.diagnosis || null;
            if (!diagnosis) {
                return;
            }

            renderPlan(diagnosis);
            logger(
                `  自动诊断: ${diagnosis.title}，${diagnosis.summary}`,
                diagnosis.status === 'recoverable' ? 'warn' : 'error'
            );
            const steps = Array.isArray(diagnosis.repairPlan) ? diagnosis.repairPlan : [];
            steps.slice(0, 4).forEach((step, index) => {
                logger(`    修复动作 ${index + 1}: ${step.title}`, step.automatic === false ? 'error' : 'info');
            });
        }

        function clearPlan() {
            latestDiagnosis = null;
            getSettingsControl()?.renderPlan(null);
            const config = getSelfHealConfig() || {};
            setStatus(
                config.summary || '排查方案已清空',
                config.enabled ? 'success' : 'warn'
            );
        }

        async function recordApplication(diagnosis) {
            try {
                const res = await fetchRef(`${serviceBase}/self-heal/apply`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        platforms: getPlatformsForRequest(),
                        diagnosis
                    })
                });
                const result = await res.json();
                if (result.success) {
                    await loadSelfHealRuns();
                }
                return result;
            } catch (error) {
                consoleRef.warn('Failed to record self-heal application:', error);
                return { success: false, error: error.message };
            }
        }

        async function applyLatestPlan() {
            const diagnosis = latestDiagnosis;
            if (!diagnosis) {
                alertRef('当前没有可执行的排查方案');
                return;
            }

            if (diagnosis.status === 'manual_required') {
                alertRef('当前诊断已达到人工介入阈值，请先处理失败原因后再继续');
                return;
            }

            const targetChain = diagnosis.currentChain || diagnosis.execution?.targetChain || diagnosis.nextChain;
            const targetChainLabel = diagnosis.currentChainLabel
                || diagnosis.execution?.targetChainLabel
                || diagnosis.nextChainLabel
                || targetChain;
            setStatus(`正在执行当前能力修复：${targetChainLabel}`, 'warn');
            await recordApplication(diagnosis);

            addLog(`已按方案执行 ${targetChainLabel} 的当前能力修复检查，修复后继续使用当前能力。`, 'warn');
        }

        async function runDiagnosis() {
            ensureSelectedPlatforms();
            const { scenario, currentChain } = getSettingsControl()?.getDiagnosisRequest() || {
                scenario: 'api_501_burst',
                currentChain: 'api'
            };

            try {
                const res = await fetchRef(`${serviceBase}/self-heal/diagnose`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        platforms: getPlatformsForRequest(),
                        scenario,
                        currentChain
                    })
                });
                const result = await res.json();
                if (!result.success) {
                    throw new Error(result.error || '排查演练失败');
                }

                renderPlan(result.data?.diagnosis || null);
                await loadSelfHealRuns();
                setStatus(
                    result.data?.diagnosis?.summary || '排查演练已完成',
                    result.data?.diagnosis?.status === 'recoverable' ? 'success' : 'error'
                );
            } catch (error) {
                alertRef(`排查演练失败：${error.message}`);
            }
        }

        return {
            applyLatestPlan,
            clearPlan,
            recordApplication,
            renderInlineLogs,
            renderPlan,
            runDiagnosis
        };
    }

    global.SelfHealOperationsControl = { createController };
})(window);
