(function attachSelfHealSettingsControl(global) {
    'use strict';

    function requireDependency(deps, name) {
        const value = deps[name];
        if (!value) {
            throw new Error(`Self-heal settings dependency missing: ${name}`);
        }
        return value;
    }

    function createController(deps = {}) {
        const documentRef = deps.document || global.document;
        const escapeHtml = requireDependency(deps, 'escapeHtml');
        const setStatusBannerState = requireDependency(deps, 'setStatusBannerState');
        const getPlatformName = deps.getPlatformName || (value => value || '-');
        const getConfig = deps.getConfig || (() => ({}));
        const defaultPlatformId = deps.defaultPlatformId || 'didi-charging';
        const onApplyPlan = deps.onApplyPlan || (() => {});
        const onClearPlan = deps.onClearPlan || (() => {});
        let planActionsBound = false;

        function byId(id) {
            return documentRef.getElementById(id);
        }

        function setChecked(id, value) {
            const el = byId(id);
            if (el) el.checked = Boolean(value);
        }

        function setValue(id, value, fallback = '') {
            const el = byId(id);
            if (el) el.value = value ?? fallback;
        }

        function positiveInteger(id, fallback) {
            return Math.max(1, Math.floor(Number(byId(id)?.value) || fallback));
        }

        function populateScenarioOptions(options = []) {
            const select = byId('selfHealScenario');
            if (!select) {
                return;
            }

            const currentValue = select.value;
            const items = Array.isArray(options) ? options : [];
            if (items.length === 0) {
                select.innerHTML = '<option value="api_501_burst">小规模访问验证被拦截</option>';
                return;
            }

            select.innerHTML = items.map(item => `
                <option value="${escapeHtml(item.value || '')}">${escapeHtml(item.label || item.value || '')}</option>
            `).join('');

            if (currentValue && items.some(item => item.value === currentValue)) {
                select.value = currentValue;
            }
        }

        function renderSettings(data = {}) {
            const signals = data.failureSignals || {};
            setChecked('selfHealEnabled', data.enabled);
            setChecked('autoFallbackEnabled', data.autoFallbackEnabled);
            setChecked('autoTemplateSwitch', data.autoTemplateSwitch);
            setChecked('autoProxyRotate', data.autoProxyRotate);
            setChecked('autoUaRotate', data.autoUaRotate);
            setChecked('autoRefreshLearning', data.autoRefreshLearning);
            setChecked('resumeFromBreakpoint', data.resumeFromBreakpoint);
            setValue('maxAttemptsPerRun', data.maxAttemptsPerRun, 3);
            setValue('manualEscalationThreshold', data.manualEscalationThreshold, 3);
            setValue('stallMinutes', signals.stallMinutes, 8);
            setValue('fail501Threshold', signals.fail501Threshold, 2);
            setValue('emptyResponseThreshold', signals.emptyResponseThreshold, 1);
            setValue('parseEmptyThreshold', signals.parseEmptyThreshold, 1);

            populateScenarioOptions(data.scenarios || getConfig()?.selfHeal?.scenarios || []);
            setStatusBannerState(
                byId('selfHealStatus'),
                `${data.summary || '排查策略已更新'}${data.updatedAt ? ` ｜ 最近保存：${data.updatedAt}` : ''}`,
                data.enabled ? 'success' : 'warn'
            );
        }

        function collectSettings() {
            return {
                enabled: Boolean(byId('selfHealEnabled')?.checked),
                autoFallbackEnabled: Boolean(byId('autoFallbackEnabled')?.checked),
                autoTemplateSwitch: Boolean(byId('autoTemplateSwitch')?.checked),
                autoProxyRotate: Boolean(byId('autoProxyRotate')?.checked),
                autoUaRotate: Boolean(byId('autoUaRotate')?.checked),
                autoRefreshLearning: Boolean(byId('autoRefreshLearning')?.checked),
                resumeFromBreakpoint: Boolean(byId('resumeFromBreakpoint')?.checked),
                maxAttemptsPerRun: positiveInteger('maxAttemptsPerRun', 3),
                manualEscalationThreshold: positiveInteger('manualEscalationThreshold', 3),
                failureSignals: {
                    fail501Threshold: positiveInteger('fail501Threshold', 2),
                    emptyResponseThreshold: positiveInteger('emptyResponseThreshold', 1),
                    parseEmptyThreshold: positiveInteger('parseEmptyThreshold', 1),
                    stallMinutes: positiveInteger('stallMinutes', 8)
                }
            };
        }

        function renderRuns(runs = []) {
            const container = byId('selfHealLog');
            if (!container) {
                return;
            }

            if (!Array.isArray(runs) || runs.length === 0) {
                container.innerHTML = '';
                return;
            }

            container.innerHTML = runs.map(run => {
                const tone = run.status === 'recoverable'
                    ? 'success'
                    : run.status === 'manual_required'
                        ? 'error'
                        : 'info';
                const scope = run.scheduleName
                    ? `${escapeHtml(run.scheduleName)}`
                    : `${escapeHtml(getPlatformName(run.platform || defaultPlatformId))}`;

                return `
                    <div class="log-entry ${tone}">
                        <div class="timestamp">${escapeHtml(run.createdAt || '')}</div>
                        <div><strong>${escapeHtml(run.title || '排查演练')}</strong> · ${scope}</div>
                        <div>${escapeHtml(run.summary || '')}</div>
                    </div>
                `;
            }).join('');
        }

        function renderPlan(diagnosis = null) {
            const container = byId('selfHealPlan');
            if (!container) {
                return;
            }

            if (!diagnosis) {
                container.innerHTML = '';
                return;
            }

            const header = `
                <div class="self-heal-step">
                    <strong>${escapeHtml(diagnosis.title || '当前能力排查建议')}</strong>
                    <span>${escapeHtml(diagnosis.summary || diagnosis.message || '')}${diagnosis.execution?.message ? ` ${escapeHtml(diagnosis.execution.message)}` : ''}</span>
                </div>
                <div class="action-row" style="margin-top:0;">
                    <button class="btn btn-primary" type="button" data-self-heal-action="apply">执行当前能力修复</button>
                    <button class="btn btn-secondary" type="button" data-self-heal-action="clear">清空方案</button>
                </div>
            `;

            const steps = Array.isArray(diagnosis.repairPlan) ? diagnosis.repairPlan : [];
            const diagnostics = Array.isArray(diagnosis.capabilityDiagnostics)
                ? diagnosis.capabilityDiagnostics
                : [];
            const diagnosticHtml = diagnostics.map((item, index) => `
                <div class="self-heal-step">
                    <strong>检查 ${index + 1} · ${escapeHtml(item.label || item.fixCode || '能力检查')}</strong>
                    <span>${escapeHtml(item.message || '')}${item.status ? `（${escapeHtml(item.status)}）` : ''}</span>
                </div>
            `).join('');
            container.innerHTML = header + diagnosticHtml + steps.map((item, index) => `
                <div class="self-heal-step">
                    <strong>步骤 ${index + 1} · ${escapeHtml(item.title || item.code || '恢复动作')}</strong>
                    <span>${escapeHtml(item.description || '')}${item.automatic === false ? '（需人工处理）' : ''}</span>
                </div>
            `).join('');
        }

        function getDiagnosisRequest() {
            return {
                scenario: byId('selfHealScenario')?.value || 'api_501_burst',
                currentChain: byId('selfHealCurrentChain')?.value || 'api'
            };
        }

        function setActionsDisabled(disabled) {
            ['saveSelfHealSettingsBtn', 'runSelfHealDiagnosisBtn'].forEach(id => {
                const node = byId(id);
                if (node) {
                    node.disabled = Boolean(disabled);
                }
            });
        }

        function setStatus(message, tone = '') {
            setStatusBannerState(byId('selfHealStatus'), message, tone);
        }

        function init() {
            if (planActionsBound) {
                return;
            }
            const container = byId('selfHealPlan');
            if (!container) {
                return;
            }
            planActionsBound = true;
            container.addEventListener('click', event => {
                const action = event.target.closest('[data-self-heal-action]')?.dataset.selfHealAction;
                if (!action) {
                    return;
                }
                if (action === 'apply') {
                    onApplyPlan();
                } else if (action === 'clear') {
                    onClearPlan();
                }
            });
        }

        return {
            collectSettings,
            getDiagnosisRequest,
            init,
            populateScenarioOptions,
            renderPlan,
            renderRuns,
            renderSettings,
            setActionsDisabled,
            setStatus
        };
    }

    global.SelfHealSettingsControl = { createController };
})(window);
