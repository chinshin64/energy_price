(function attachCrawlerRunQuotaControl(global) {
    'use strict';

    function requireDependency(deps, name) {
        const value = deps[name];
        if (!value) {
            throw new Error(`Crawler run quota dependency missing: ${name}`);
        }
        return value;
    }

    function createController(deps = {}) {
        const documentRef = deps.document || global.document;
        const fetchFn = deps.fetch || global.fetch;
        const serviceBase = requireDependency(deps, 'serviceBase');
        const escapeHtml = requireDependency(deps, 'escapeHtml');
        const addLog = deps.addLog || (() => {});
        const workflowLabel = deps.workflowLabel || '小规模访问验证';
        const consoleRef = deps.console || global.console;

        function byId(id) {
            return documentRef.getElementById(id);
        }

        function normalizeRunQuotaStats(data = null) {
            if (!data || typeof data !== 'object') {
                return null;
            }

            const unlimited = Boolean(data.unlimited) || data.limit === null;
            const limit = unlimited ? null : Math.max(0, Number(data.limit) || 0);
            return {
                limit,
                unlimited,
                used: Math.max(0, Number(data.used) || 0),
                success: Math.max(0, Number(data.success) || 0),
                fail501: Math.max(0, Number(data.fail501) || 0),
                remaining: data.remaining === null || data.remaining === undefined
                    ? null
                    : Math.max(0, Number(data.remaining) || 0),
                quotaMode: data.quotaMode || '',
                targetCount: Math.max(0, Number(data.targetCount) || 0),
                perTargetLimit: data.perTargetLimit === null || data.perTargetLimit === undefined
                    ? null
                    : Math.max(0, Number(data.perTargetLimit) || 0)
            };
        }

        function formatRunQuotaLimit(limit, unlimited = false) {
            return unlimited || limit === null ? '无上限' : String(limit);
        }

        function formatRunQuotaUsage(runQuota = {}) {
            const used = Math.max(0, Number(runQuota.used) || 0);
            return `${used}/${formatRunQuotaLimit(runQuota.limit, runQuota.unlimited)}`;
        }

        function getPerRunLimitFromInput() {
            if (byId('crawlerUnlimitedRunInput')?.checked) {
                return null;
            }

            const rawValue = byId('crawlerRunLimitInput')?.value?.trim() || '';
            if (!rawValue) {
                return null;
            }

            const raw = Number(rawValue);
            if (!Number.isFinite(raw) || raw <= 0) {
                return undefined;
            }
            return Math.floor(raw);
        }

        function setStatus(message, tone = '') {
            const status = byId('crawlerRunQuotaStatus');
            if (!status) {
                return;
            }
            status.textContent = message;
            status.className = `field-hint ${tone ? ` ${tone}` : ''}`;
        }

        function render(data = {}, runQuota = null) {
            const limitInput = byId('crawlerRunLimitInput');
            const unlimitedInput = byId('crawlerUnlimitedRunInput');
            const statsEl = byId('crawlerRunQuotaStats');
            const perRunUnlimited = Boolean(data.perRunUnlimited) || data.perRunLimit === null;
            const perRunLimit = perRunUnlimited ? null : Math.max(1, Math.floor(Number(data.perRunLimit ?? data.limit) || 100));
            const normalizedRunQuota = normalizeRunQuotaStats(runQuota || deps.getCurrentRunStats?.()) || {
                limit: perRunLimit,
                unlimited: perRunUnlimited,
                used: 0,
                success: 0,
                fail501: 0
            };

            if (limitInput) {
                limitInput.value = perRunUnlimited ? '' : String(perRunLimit);
                limitInput.disabled = perRunUnlimited;
            }
            if (unlimitedInput) {
                unlimitedInput.checked = perRunUnlimited;
            }

            if (statsEl) {
                const total = Math.max(0, Number(data.totalRequests) || 0);
                const success = Math.max(0, Number(data.successRequests) || 0);
                const fail501 = Math.max(0, Number(data.fail501Requests) || 0);
                const used = Math.max(0, Number(normalizedRunQuota.used) || 0);
                const date = data.date ? `（${data.date}）` : '';
                statsEl.innerHTML = `
                    <div class="quota-chip"><strong>${total}</strong><span>今日请求${escapeHtml(date)}</span></div>
                    <div class="quota-chip"><strong>${success}</strong><span>今日成功</span></div>
                    <div class="quota-chip"><strong>${fail501}</strong><span>材料校验失败</span></div>
                    <div class="quota-chip"><strong>${used}</strong><span>本轮已用</span></div>
                `;
            }

            const modeText = perRunUnlimited
                ? '当前本轮请求不设上限。'
                : `当前每个目标最多请求 ${perRunLimit} 次。`;
            setStatus(modeText, perRunUnlimited ? 'warn' : 'success');
        }

        async function load() {
            try {
                const res = await fetchFn(`${serviceBase}/crawler/run-quota`);
                const result = await res.json();
                if (!result.success) {
                    return;
                }

                render(result.data || {}, deps.getCurrentRunStats?.());
            } catch (error) {
                consoleRef.error('Failed to load crawler run quota:', error);
                setStatus('访问保护策略加载失败。', 'error');
            }
        }

        async function save() {
            const limitInput = byId('crawlerRunLimitInput');
            const unlimited = Boolean(byId('crawlerUnlimitedRunInput')?.checked);
            const rawValue = limitInput?.value?.trim() || '';
            const rawLimit = Number(rawValue);
            const body = unlimited || !rawValue
                ? { unlimited: true, perRunLimit: null }
                : { perRunLimit: Math.floor(rawLimit) };

            if (!unlimited && (!Number.isFinite(rawLimit) || rawLimit <= 0)) {
                global.alert?.('访问保护策略配置无效');
                return;
            }

            const res = await fetchFn(`${serviceBase}/crawler/run-quota`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            const result = await res.json();
            if (!result.success) {
                throw new Error(result.error || '保存访问保护策略失败');
            }

            render(result.data || {}, deps.getCurrentRunStats?.());
            addLog(`${workflowLabel}访问保护策略已更新`, 'info');
        }

        function syncUnlimitedInput(event) {
            const limitInput = byId('crawlerRunLimitInput');
            if (!limitInput) {
                return;
            }
            limitInput.disabled = Boolean(event?.target?.checked);
            if (event?.target?.checked) {
                limitInput.value = '';
            }
        }

        return {
            formatRunQuotaLimit,
            formatRunQuotaUsage,
            getPerRunLimitFromInput,
            load,
            normalizeRunQuotaStats,
            render,
            save,
            syncUnlimitedInput
        };
    }

    global.CrawlerRunQuotaControl = { createController };
})(window);
