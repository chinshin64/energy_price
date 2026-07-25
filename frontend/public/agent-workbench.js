(function attachAgentWorkbenchControl(global) {
    'use strict';

    function requireDependency(deps, name) {
        const value = deps[name];
        if (!value) {
            throw new Error(`Agent workbench dependency missing: ${name}`);
        }
        return value;
    }

    function createController(deps = {}) {
        const documentRef = deps.document || global.document;
        const fetchRef = deps.fetch || global.fetch.bind(global);
        const serviceBase = requireDependency(deps, 'serviceBase');
        const setElementText = requireDependency(deps, 'setElementText');
        const setStatusBannerState = requireDependency(deps, 'setStatusBannerState');
        const formatUserReason = requireDependency(deps, 'formatUserReason');
        const safeJson = requireDependency(deps, 'safeJson');
        const getModelLabel = requireDependency(deps, 'getModelLabel');
        const saveModel = requireDependency(deps, 'saveModel');
        const loadDashboard = requireDependency(deps, 'loadDashboard');
        const getModelPresets = deps.getModelPresets || function emptyModelPresets() { return []; };
        const getSettingsSnapshot = deps.getSettingsSnapshot || function emptySettings() { return {}; };
        const getSelectedPlatform = deps.getSelectedPlatform || function defaultPlatform() { return deps.defaultPlatformId || 'didi-charging'; };
        const outputLimitField = deps.outputLimitField || 'maxTokens';
        const defaultPlatformId = deps.defaultPlatformId || 'didi-charging';
        let latestPlan = null;
        let messageCount = 0;

        function byId(id) {
            return documentRef.getElementById(id);
        }

        function getSettings() {
            return getSettingsSnapshot() || {};
        }

        function renderSelectOptions(select, items, currentValue = '') {
            select.replaceChildren();
            items.forEach(item => {
                const option = documentRef.createElement('option');
                option.value = item.id || item.value || '';
                option.textContent = item.label || item.name || item.id || item.value || '';
                select.appendChild(option);
            });
            const values = items.map(item => item.id || item.value || '');
            select.value = values.includes(currentValue) ? currentValue : (values[0] || '');
        }

        function renderPlatformOptions(platforms = []) {
            const select = byId('agentWorkbenchPlatform');
            if (!select) return;
            const list = Array.isArray(platforms) && platforms.length
                ? platforms
                : [{ id: defaultPlatformId, name: '滴滴充电' }];
            const current = select.value || getSelectedPlatform() || defaultPlatformId;
            renderSelectOptions(select, list, current);
        }

        function renderModelSelect(currentModelId = '') {
            const select = byId('agentWorkbenchModelSelect');
            if (!select) return;
            const presets = Array.isArray(getModelPresets()) ? getModelPresets() : [];
            const hasCurrent = presets.some(item => item.id === currentModelId);
            const items = [
                { id: '', label: '请选择模型' },
                ...presets.map(item => ({ id: item.id, label: item.label || item.id }))
            ];
            if (!hasCurrent && currentModelId) {
                items.push({ id: currentModelId, label: currentModelId });
            }
            renderSelectOptions(select, items, currentModelId);
            select.disabled = presets.length === 0 && !currentModelId;
            select.title = getSettings()?.envOverride?.modelId
                ? '当前环境变量覆盖模型配置，保存后需移除覆盖并重启服务才会改变实际模型。'
                : '切换智能助手模型';
        }

        function renderStatus(agent = {}, chains = {}) {
            const settings = getSettings();
            const modeLabel = ({ enabled: '已启用', dry_run: '预演模式', disabled: '未启用' }[agent.mode]) || agent.mode || '未知';
            const modelAvailable = Boolean(agent.model?.available);
            const availableCount = chains.summary?.availableCount ?? Object.values(chains.chains || {}).filter(item => item.available).length;
            const bestLabel = chains.bestChain ? (chains.chains?.[chains.bestChain]?.label || chains.bestChain) : '暂无推荐';
            const tone = agent.mode === 'enabled' && modelAvailable ? 'success' : 'warn';
            const modelId = agent.model?.config?.modelId || '';
            const outputLimit = agent.model?.config?.[outputLimitField]
                || settings?.effective?.[outputLimitField]
                || settings?.[outputLimitField];
            const envModelOverride = Boolean(settings?.envOverride?.modelId);

            setElementText('agentWorkbenchMode', modeLabel);
            setElementText('agentWorkbenchChainCount', String(availableCount || 0));
            setElementText('agentWorkbenchBestChain', `推荐链路：${bestLabel}`);
            renderModelSelect(modelId || settings?.modelId || '');
            setElementText(
                'agentWorkbenchModelStatus',
                modelAvailable
                    ? `上下文由模型服务决定 · 输出 ${outputLimit || 1200}${envModelOverride ? ' · 环境变量覆盖' : ''}`
                    : formatUserReason(agent.model?.reason || 'ai_agent_not_configured', { includeTech: false })
            );
            const banner = byId('agentWorkbenchStatusBanner');
            if (banner) {
                const modelText = modelAvailable ? `当前模型 ${getModelLabel(modelId)}` : '模型未配置';
                setStatusBannerState(banner, `${modeLabel} · ${modelText}`, tone);
            }
        }

        function appendMessage(role, content, detail = null) {
            const container = byId('agentWorkbenchChatMessages');
            if (!container) return null;
            messageCount += 1;
            const message = documentRef.createElement('div');
            message.className = `agent-message ${role}`;
            const text = documentRef.createElement('div');
            text.textContent = content;
            message.appendChild(text);
            if (detail) {
                const details = documentRef.createElement('details');
                const summary = documentRef.createElement('summary');
                summary.textContent = '查看结构化结果';
                const pre = documentRef.createElement('pre');
                pre.textContent = typeof detail === 'string' ? detail : safeJson(detail);
                details.append(summary, pre);
                message.appendChild(details);
            }
            container.appendChild(message);
            container.scrollTop = container.scrollHeight;
            return message;
        }

        function replaceMessage(message, content, detail = null) {
            if (!message) return null;
            message.replaceChildren();
            const text = documentRef.createElement('div');
            text.textContent = content;
            message.appendChild(text);
            if (detail) {
                const details = documentRef.createElement('details');
                const summary = documentRef.createElement('summary');
                summary.textContent = '查看结构化结果';
                const pre = documentRef.createElement('pre');
                pre.textContent = typeof detail === 'string' ? detail : safeJson(detail);
                details.append(summary, pre);
                message.appendChild(details);
            }
            return message;
        }

        function appendPlanActions(message, result = {}) {
            const plan = result.plan;
            const actions = Array.isArray(plan?.actions) ? plan.actions : [];
            if (!message || actions.length === 0) return;
            const action = actions[0];
            const executionItems = Array.isArray(result.execution?.results) ? result.execution.results : [];
            const confirmationPending = executionItems.some(item => item.reason === 'confirmation_required');
            if (result.execution && !confirmationPending && !action.mutating) return;
            const row = documentRef.createElement('div');
            row.className = 'agent-message-actions';

            const preview = documentRef.createElement('button');
            preview.type = 'button';
            preview.className = 'btn btn-secondary';
            preview.textContent = '预演';
            preview.addEventListener('click', () => executePlan(plan, true, false));
            row.appendChild(preview);

            if (action.mutating || action.requiresConfirmation) {
                const confirm = documentRef.createElement('button');
                confirm.type = 'button';
                confirm.className = 'btn btn-primary';
                confirm.textContent = '确认执行';
                confirm.addEventListener('click', () => executePlan(plan, false, true));
                row.appendChild(confirm);
            }
            message.appendChild(row);
        }

        async function executePlan(plan, dryRun, confirm) {
            const pending = appendMessage('agent', dryRun ? '正在预演计划...' : '正在执行已确认的计划...');
            try {
                const response = await fetchRef(`${serviceBase}/global-agent/actions/execute`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ plan, dryRun, confirm })
                });
                const result = await response.json();
                replaceMessage(pending, summarizeExecution(result), result);
                await loadDashboard();
                return result;
            } catch (error) {
                replaceMessage(pending, `执行失败：${error.message}`);
                return { success: false, error: error.message };
            }
        }

        function resetConversation() {
            latestPlan = null;
            messageCount = 0;
            const container = byId('agentWorkbenchChatMessages');
            if (container) {
                container.replaceChildren();
                appendMessage(
                    'system',
                    '描述你的目标，Agent 会读取产品状态并给出可追溯的处理结果。'
                );
            }
            const prompt = byId('agentWorkbenchPrompt');
            if (prompt) {
                prompt.value = '';
                prompt.style.height = '';
                prompt.focus();
            }
        }

        function summarizePlan(result = {}) {
            if (!result.success) {
                return `计划生成失败：${formatUserReason(result.reason || result.error || 'unknown_error', { includeTech: false })}`;
            }
            const action = result.plan?.actions?.[0];
            if (!action) return '没有生成需要执行的动作。';
            const mode = result.plan?.mode || 'unknown';
            const dryRun = action.dryRun || result.plan?.dryRun ? '预演' : '可执行';
            return `计划已生成：${action.description || action.tool}。工具：${action.tool}；模式：${mode}；状态：${dryRun}。`;
        }

        function summarizeExecution(result = {}) {
            if (!result.success) {
                return `执行未完成：${formatUserReason(result.reason || result.error || 'unknown_error', { includeTech: false })}`;
            }
            const items = Array.isArray(result.results) ? result.results : [];
            if (items.length === 0) return '执行完成，但没有返回工具结果。';
            return items.map(item => {
                if (item.dryRun || item.skipped) {
                    return `${item.tool}：已预演，未执行写操作。`;
                }
                return `${item.tool}：${item.success === false ? '失败' : '完成'}${item.reason ? `（${item.reason}）` : ''}`;
            }).join('\n');
        }

        function getTarget() {
            const platform = byId('agentWorkbenchPlatform')?.value || getSelectedPlatform() || defaultPlatformId;
            return {
                platform,
                city: byId('agentWorkbenchCity')?.value?.trim() || '上海',
                lat: Number(byId('agentWorkbenchLat')?.value || 31.2304),
                lng: Number(byId('agentWorkbenchLng')?.value || 121.4737),
                radiusKm: 20,
                maxPages: 1,
                maxRequestCount: 5,
                maxQps: 1
            };
        }

        function getPrompt() {
            return byId('agentWorkbenchPrompt')?.value?.trim() || '';
        }

        async function sendChat() {
            const promptEl = byId('agentWorkbenchPrompt');
            const message = getPrompt();
            if (!message) {
                promptEl?.focus();
                return { success: false, reason: 'message_required' };
            }
            appendMessage('user', message);
            if (promptEl) promptEl.value = '';
            if (promptEl) promptEl.style.height = '';
            const sendButton = byId('agentWorkbenchSendBtn');
            if (sendButton) sendButton.disabled = true;
            const pending = appendMessage('agent', '正在处理...');
            try {
                const res = await fetchRef(`${serviceBase}/global-agent/chat`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        message,
                        target: getTarget(),
                        dryRun: false
                    })
                });
                const result = await res.json();
                if (result.plan) latestPlan = result.plan;
                replaceMessage(
                    pending,
                    result.reply || summarizePlan(result),
                    result
                );
                appendPlanActions(pending, result);
                await loadDashboard();
                return result;
            } catch (error) {
                replaceMessage(pending, `请求失败：${error.message}`);
                return { success: false, error: error.message };
            } finally {
                if (sendButton) sendButton.disabled = false;
                promptEl?.focus();
            }
        }

        async function applyModelSelection() {
            const select = byId('agentWorkbenchModelSelect');
            const modelId = select?.value || '';
            if (!modelId) return;
            const settings = getSettings();
            const previousModelId = settings?.effective?.modelId || settings?.modelId || '';
            try {
                select.disabled = true;
                await saveModel(modelId);
                const envModelOverride = Boolean(getSettings()?.envOverride?.modelId);
                if (envModelOverride) {
                    appendMessage(
                        'system',
                        `模型配置已保存为 ${getModelLabel(modelId)}，但当前 AI_AGENT_MODEL_ID 环境变量仍在覆盖实际模型。`
                    );
                } else {
                    appendMessage('system', `已切换模型：${getModelLabel(modelId)}`);
                }
            } catch (error) {
                if (select) select.value = previousModelId;
                alert(error.message);
            } finally {
                if (select) select.disabled = false;
            }
        }

        function syncComposer() {
            const prompt = byId('agentWorkbenchPrompt');
            const send = byId('agentWorkbenchSendBtn');
            if (!prompt) return;
            prompt.style.height = 'auto';
            prompt.style.height = `${Math.min(180, Math.max(48, prompt.scrollHeight))}px`;
            if (send) send.disabled = !prompt.value.trim();
        }

        return {
            appendMessage,
            applyModelSelection,
            executePlan,
            getPrompt,
            getTarget,
            renderModelSelect,
            renderPlatformOptions,
            renderStatus,
            replaceMessage,
            resetConversation,
            sendChat,
            summarizeExecution,
            summarizePlan,
            syncComposer
        };
    }

    global.AgentWorkbenchControl = { createController };
})(window);
