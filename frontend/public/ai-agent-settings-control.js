(function attachAiAgentSettingsControl(global) {
    'use strict';

    function requireDependency(deps, name) {
        const value = deps[name];
        if (!value) {
            throw new Error(`AI agent settings dependency missing: ${name}`);
        }
        return value;
    }

    function createController(deps = {}) {
        const documentRef = deps.document || global.document;
        const escapeHtml = requireDependency(deps, 'escapeHtml');
        const setStatusBannerState = requireDependency(deps, 'setStatusBannerState');
        const getModelPresets = deps.getModelPresets || (() => []);
        const renderWorkbenchModelSelect = deps.renderWorkbenchModelSelect || (() => {});
        const outputLimitField = deps.outputLimitField || 'maxTokens';
        let eventsBound = false;

        function byId(id) {
            return documentRef.getElementById(id);
        }

        function currentPresets() {
            return Array.isArray(getModelPresets()) ? getModelPresets() : [];
        }

        function getModelLabel(modelId = '') {
            const preset = currentPresets().find(item => item.id === modelId);
            return preset?.label || modelId || '模型未配置';
        }

        function renderModelSelect(currentModelId = '') {
            const select = byId('aiAgentSettingsModelSelect');
            const modelEl = byId('aiAgentSettingsModelId');
            if (!select) return;
            const presets = currentPresets();
            const hasCurrent = presets.some(item => item.id === currentModelId);
            select.innerHTML = [
                '<option value="">请选择模型</option>',
                ...presets.map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.label || item.id)}</option>`),
                '<option value="__custom__">自定义模型</option>'
            ].join('');
            select.value = currentModelId ? (hasCurrent ? currentModelId : '__custom__') : '';
            if (modelEl && select.value !== '__custom__') {
                modelEl.value = select.value;
            }
        }

        function updateProviderHints() {
            const type = byId('aiAgentSettingsType')?.value || 'openai_compatible';
            const baseUrlEl = byId('aiAgentSettingsBaseUrl');
            const modelEl = byId('aiAgentSettingsModelId');
            if (type === 'anthropic_native') {
                if (baseUrlEl) baseUrlEl.placeholder = 'https://api.anthropic.com/v1';
                if (modelEl) modelEl.placeholder = 'claude-sonnet-4-6';
                return;
            }
            if (baseUrlEl) baseUrlEl.placeholder = 'https://api.openai.com/v1';
            if (modelEl) modelEl.placeholder = 'gpt-4.1-mini';
        }

        function applyModelSelection() {
            const select = byId('aiAgentSettingsModelSelect');
            const modelEl = byId('aiAgentSettingsModelId');
            if (!select || !modelEl) return;
            if (!select.value) {
                modelEl.value = '';
                return;
            }
            if (select.value === '__custom__') {
                modelEl.focus();
                return;
            }
            modelEl.value = select.value;
        }

        function renderSettings(data = {}) {
            const effective = data.effective || {};
            const modeEl = byId('aiAgentSettingsMode');
            const typeEl = byId('aiAgentSettingsType');
            const baseUrlEl = byId('aiAgentSettingsBaseUrl');
            const modelSelectEl = byId('aiAgentSettingsModelSelect');
            const modelEl = byId('aiAgentSettingsModelId');
            const timeoutEl = byId('aiAgentSettingsTimeoutMs');
            const keyEl = byId('aiAgentSettingsApiKey');
            const keepKeyEl = byId('aiAgentSettingsKeepKey');
            const clearKeyEl = byId('aiAgentSettingsClearKey');
            const creativityEl = byId('aiAgentSettingsCreativity');
            const outputLimitEl = byId('aiAgentSettingsOutputLimit');
            const saveEventsEl = byId('aiAgentSettingsSaveEvents');
            const lowRiskEl = byId('aiAgentSettingsApplyLowRiskPatches');
            const statusEl = byId('aiAgentSettingsStatus');
            const displayModelId = data.modelId || effective.modelId || '';

            if (modeEl) modeEl.value = data.mode || effective.mode || 'disabled';
            if (typeEl) typeEl.value = data.type || effective.type || 'openai_compatible';
            if (baseUrlEl) baseUrlEl.value = data.baseUrl || '';
            renderModelSelect(displayModelId);
            if (modelSelectEl && modelEl && modelSelectEl.value !== '__custom__') {
                modelEl.value = modelSelectEl.value;
            }
            if (modelEl) modelEl.value = displayModelId;
            renderWorkbenchModelSelect(effective.modelId || displayModelId);
            if (timeoutEl) timeoutEl.value = String(data.timeoutMs || effective.timeoutMs || 60000);
            if (creativityEl) creativityEl.value = String(data.temperature ?? 0);
            if (outputLimitEl) outputLimitEl.value = String(data[outputLimitField] || 1200);
            if (saveEventsEl) saveEventsEl.checked = data.saveEvents !== false;
            if (lowRiskEl) lowRiskEl.checked = Boolean(data.applyLowRiskPatches);
            if (keepKeyEl) keepKeyEl.checked = true;
            if (clearKeyEl) clearKeyEl.checked = false;
            if (keyEl) {
                keyEl.value = '';
                keyEl.placeholder = data.apiKeyConfigured
                    ? `已保存密钥：${data.apiKeyPreview || '********'}，留空保留`
                    : '请输入访问密钥';
            }

            if (statusEl) {
                const configured = Boolean(effective.configured || data.configured);
                const mode = effective.mode || data.mode || 'disabled';
                const envOverride = data.envOverride || {};
                const overrideNames = Object.entries(envOverride)
                    .filter(([, enabled]) => enabled)
                    .map(([name]) => name);
                const parts = [
                    configured ? '智能助手已配置' : '智能助手未完整配置',
                    `模式 ${mode}`,
                    data.apiKeyConfigured || effective.configured ? '密钥已保存' : '密钥未配置',
                    displayModelId ? `模型 ${displayModelId}` : '模型未配置'
                ];
                if (overrideNames.length) {
                    parts.push(`环境变量覆盖：${overrideNames.join(', ')}`);
                }
                setStatusBannerState(statusEl, parts.join(' · '), configured ? 'success' : 'warn');
            }
            updateProviderHints();
        }

        function collectSettings() {
            const apiKey = byId('aiAgentSettingsApiKey')?.value || '';
            return {
                mode: byId('aiAgentSettingsMode')?.value || 'disabled',
                type: byId('aiAgentSettingsType')?.value || 'openai_compatible',
                baseUrl: byId('aiAgentSettingsBaseUrl')?.value?.trim() || '',
                apiKey,
                keepApiKey: Boolean(byId('aiAgentSettingsKeepKey')?.checked),
                clearApiKey: Boolean(byId('aiAgentSettingsClearKey')?.checked),
                modelId: byId('aiAgentSettingsModelId')?.value?.trim() || '',
                timeoutMs: Math.max(1000, Math.floor(Number(byId('aiAgentSettingsTimeoutMs')?.value) || 60000)),
                temperature: Number(byId('aiAgentSettingsCreativity')?.value || 0),
                [outputLimitField]: Math.max(1, Math.floor(Number(byId('aiAgentSettingsOutputLimit')?.value) || 1200)),
                saveEvents: Boolean(byId('aiAgentSettingsSaveEvents')?.checked),
                applyLowRiskPatches: Boolean(byId('aiAgentSettingsApplyLowRiskPatches')?.checked)
            };
        }

        function handleClearKeyChange(event) {
            const keyEl = byId('aiAgentSettingsApiKey');
            const keepEl = byId('aiAgentSettingsKeepKey');
            if (event.target.checked) {
                if (keyEl) keyEl.value = '';
                if (keepEl) keepEl.checked = false;
            }
        }

        function init() {
            if (eventsBound) {
                return;
            }
            eventsBound = true;
            byId('aiAgentSettingsType')?.addEventListener('change', updateProviderHints);
            byId('aiAgentSettingsModelSelect')?.addEventListener('change', applyModelSelection);
            byId('aiAgentSettingsClearKey')?.addEventListener('change', handleClearKeyChange);
        }

        return {
            applyModelSelection,
            collectSettings,
            getModelLabel,
            init,
            renderModelSelect,
            renderSettings,
            updateProviderHints
        };
    }

    global.AiAgentSettingsControl = { createController };
})(window);
