(function attachMobileIntentChatControl(global) {
    'use strict';

    const CHAT_SESSION_KEY = 'dataForDidiMobileChatSessionId';

    function requireDependency(deps, name) {
        const value = deps[name];
        if (!value) {
            throw new Error(`Mobile intent chat dependency missing: ${name}`);
        }
        return value;
    }

    function createController(deps = {}) {
        const documentRef = deps.document || global.document;
        const storage = deps.localStorage || global.localStorage;
        const requestMobileControl = requireDependency(deps, 'requestMobileControl');
        const refreshMobileControl = requireDependency(deps, 'refreshMobileControl');
        const setStatusBannerState = requireDependency(deps, 'setStatusBannerState');
        const escapeHtml = requireDependency(deps, 'escapeHtml');
        const isAiFeaturesEnabled = requireDependency(deps, 'isAiFeaturesEnabled');
        const renderProductReadinessPanel = deps.renderProductReadinessPanel || function noop() {};
        let chatSessionId = storage?.getItem(CHAT_SESSION_KEY) || '';

        function byId(id) {
            return documentRef.getElementById(id);
        }

        function setStatus(message, tone = '') {
            setStatusBannerState(byId('mobileIntentStatus'), message, tone);
        }

        function formatParseSource(value) {
            const key = String(value || '').trim().toLowerCase();
            const labels = {
                dcc: 'DCC',
                rule: '内置规则',
                'rule-ai-disabled': '内置规则',
                'rule-deterministic': '固定命令',
                'rule-fallback': '规则兜底',
                unknown: '未知'
            };
            return labels[key] || value || '未知';
        }

        function renderDccStatus(intentParser = {}) {
            const planned = Boolean(intentParser.planned || intentParser.aiFeaturesEnabled === false);
            const mode = intentParser.dccMode || (intentParser.dccConfigured ? 'dcc' : 'disabled');
            const timeoutNote = intentParser.timeoutCapped
                ? ` · 超时已限制 ${Math.round(Number(intentParser.timeoutMs || 0) / 1000)}s`
                : '';
            const label = planned
                ? (intentParser.message || 'AI 对话解析未启用，当前使用内置规则解析。')
                : intentParser.dccConfigured
                ? `DCC 已启用 · ${mode === 'cli' ? 'CLI 服务' : mode === 'http' ? 'HTTP 服务' : mode}${timeoutNote}`
                : 'DCC 未启用 · 使用内置规则解析';
            setStatusBannerState(
                byId('mobileDccStatus'),
                label,
                intentParser.dccConfigured ? 'success' : 'warn'
            );
            setStatus(planned ? 'AI 未启用，手机指令将走内置规则解析。' : '等待下发任务。', planned ? 'warn' : '');
            renderProductReadinessPanel();
        }

        function renderExamples(examples = []) {
            const container = byId('mobileIntentExamples');
            if (!container) {
                return;
            }
            container.innerHTML = (Array.isArray(examples) ? examples : []).map(text => `
                <button class="intent-example-chip" type="button" data-mobile-intent-example="${escapeHtml(text)}">${escapeHtml(text)}</button>
            `).join('');
            container.querySelectorAll('[data-mobile-intent-example]').forEach(button => {
                button.addEventListener('click', () => {
                    const input = byId('mobileIntentInput');
                    if (input) {
                        input.value = button.dataset.mobileIntentExample || '';
                        input.focus();
                    }
                });
            });
        }

        function appendChatMessage(message = {}, scroll = true) {
            const container = byId('mobileChatWindow');
            if (!container || !message.content) {
                return;
            }
            const role = message.role === 'user' ? 'user' : 'assistant';
            const node = documentRef.createElement('div');
            node.className = `mobile-chat-message ${role}`;
            const meta = message.meta || {};
            const metaText = [
                meta.parseSource ? `解析 ${formatParseSource(meta.parseSource)}` : '',
                meta.workflowId ? `工作流 ${meta.workflowId}` : '',
                meta.commandId ? `命令 ${meta.commandId}` : ''
            ].filter(Boolean).join(' · ');
            node.innerHTML = `
                <strong>${role === 'user' ? '你' : '指令解析'}</strong>
                <p>${escapeHtml(message.content)}</p>
                <small>${escapeHtml(metaText || message.createdAt || '')}</small>
            `;
            container.appendChild(node);
            if (scroll) {
                container.scrollTop = container.scrollHeight;
            }
        }

        function renderChat(messages = []) {
            const container = byId('mobileChatWindow');
            if (!container) {
                return;
            }
            container.innerHTML = '';
            (Array.isArray(messages) ? messages : []).slice(-30).forEach(message => {
                appendChatMessage(message, false);
            });
            container.scrollTop = container.scrollHeight;
        }

        async function loadChatSession() {
            if (!chatSessionId) {
                renderChat([]);
                return;
            }
            try {
                const session = await requestMobileControl(`/mobile-control/chat/sessions/${encodeURIComponent(chatSessionId)}`);
                renderChat(session.messages || []);
            } catch (error) {
                chatSessionId = '';
                storage?.removeItem(CHAT_SESSION_KEY);
                renderChat([]);
            }
        }

        async function submit(instruction) {
            const text = String(instruction || byId('mobileIntentInput')?.value || '').trim();
            if (!text) {
                alert('请输入需要下发给手机的需求');
                return;
            }
            appendChatMessage({ role: 'user', content: text, createdAt: new Date().toISOString() });
            setStatus(`正在发送给${isAiFeaturesEnabled() ? '指令解析服务' : '内置规则解析'}...`, 'warn');
            const data = await requestMobileControl('/mobile-control/chat', {
                method: 'POST',
                body: JSON.stringify({ sessionId: chatSessionId, message: text })
            });
            if (data.session?.id) {
                chatSessionId = data.session.id;
                storage?.setItem(CHAT_SESSION_KEY, chatSessionId);
                renderChat(data.session.messages || []);
            }
            const result = data.result || {};
            const parseSource = result.parsed?.parseSource || data.assistantMessage?.meta?.parseSource || 'unknown';
            setStatus(`${result.message || '需求已下发'}（解析：${formatParseSource(parseSource)}）`, 'success');
            const input = byId('mobileIntentInput');
            if (!instruction && input) {
                input.value = '';
            }
            await refreshMobileControl();
        }

        async function loadInteractionConfig() {
            const data = await requestMobileControl('/mobile-control/interaction/config');
            renderExamples(data.examples || []);
            renderDccStatus(data.intentParser || {});
            return data;
        }

        function setConfigError(error) {
            setStatusBannerState(
                byId('mobileDccStatus'),
                `指令解析配置读取失败：${error.message}`,
                'error'
            );
            setStatus(`控制配置读取失败：${error.message}`, 'error');
        }

        function init(defaultExamples = []) {
            renderExamples(defaultExamples);
            setStatusBannerState(
                byId('mobileDccStatus'),
                '正在通过当前登录会话读取指令配置...',
                'info'
            );
            loadInteractionConfig().catch(setConfigError);
            loadChatSession().catch(() => {});
        }

        return {
            formatParseSource,
            init,
            loadChatSession,
            loadInteractionConfig,
            renderChat,
            renderDccStatus,
            renderExamples,
            setConfigError,
            setStatus,
            submit
        };
    }

    global.MobileIntentChatControl = { createController };
})(window);
