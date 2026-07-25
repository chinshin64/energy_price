(function attachAccessValidationControl(global) {
    'use strict';

    function requireDependency(deps, name) {
        const value = deps[name];
        if (!value) {
            throw new Error(`Access validation dependency missing: ${name}`);
        }
        return value;
    }

    function createController(deps = {}) {
        const documentRef = deps.document || global.document;
        const fetchFn = deps.fetch || global.fetch;
        const serviceBase = requireDependency(deps, 'serviceBase');
        const defaultPlatformId = requireDependency(deps, 'defaultPlatformId');
        const ensureSelectedPlatforms = requireDependency(deps, 'ensureSelectedPlatforms');
        const formatUserReason = requireDependency(deps, 'formatUserReason');
        const renderStatus = requireDependency(deps, 'renderStatus');
        const setStatusBannerState = requireDependency(deps, 'setStatusBannerState');
        const addLog = deps.addLog || (() => {});

        function byId(id) {
            return documentRef.getElementById(id);
        }

        function getInput() {
            ensureSelectedPlatforms();
            const selectedPlatforms = Array.isArray(deps.getSelectedPlatforms?.())
                ? deps.getSelectedPlatforms()
                : [];
            return {
                platform: selectedPlatforms[0] || defaultPlatformId,
                city: byId('method3City')?.value?.trim() || '上海',
                lat: Number(byId('method3Lat')?.value || 31.2304),
                lng: Number(byId('method3Lng')?.value || 121.4737),
                mode: 'list',
                maxPages: 1,
                maxRequestCount: 5,
                maxQps: 1
            };
        }

        function setBanner(message, tone = 'info') {
            const banner = byId('method3ReasonBanner');
            if (banner) {
                setStatusBannerState(banner, message, tone);
            }
        }

        function formatReason(reason) {
            return formatUserReason(reason || 'unknown_error', { includeTech: false });
        }

        async function refreshStatus() {
            setBanner('正在刷新访问验证状态...', 'info');
            try {
                const res = await fetchFn(`${serviceBase}/method3/status`);
                const result = await res.json();
                renderStatus(result);
                return result;
            } catch (error) {
                const fallback = {
                    success: false,
                    available: false,
                    reason: 'unknown_error',
                    error: error.message,
                    checks: {}
                };
                renderStatus(fallback);
                return fallback;
            }
        }

        async function runPreflight() {
            setBanner('正在检查请求材料...', 'info');
            const res = await fetchFn(`${serviceBase}/method3/preflight`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(getInput())
            });
            const result = await res.json();
            const matched = result.status === 'matched';
            const reason = result.diagnostics?.[0]?.code || result.status || 'unknown_error';
            const out = byId('method3PreflightSummary');
            if (out) {
                out.value = matched
                    ? `状态：材料可用\n匹配请求数：${result.matchedCount || 0}`
                    : `状态：材料不可用\n原因：${formatReason(reason)}`;
            }
            setBanner(
                matched ? '请求材料可用' : `请求材料不可用：${formatReason(reason)}`,
                matched ? 'success' : 'warn'
            );
            addLog(
                matched ? '请求材料可用' : `请求材料不可用：${formatReason(reason)}`,
                matched ? 'success' : 'warn'
            );
            return result;
        }

        async function runBasicCheck() {
            setBanner('正在执行访问验证...', 'info');
            const res = await fetchFn(`${serviceBase}/method3/run-basic-check`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(getInput())
            });
            const result = await res.json();
            const out = byId('method3RunSummary');
            if (out) {
                out.value = result.success
                    ? `状态：验证通过\n验证数：${result.checkedCount || result.summary?.totalChecked || 0}`
                    : `状态：验证未通过\n原因：${formatReason(result.reason)}`;
            }
            setBanner(
                result.success ? '访问验证完成' : `访问验证未通过：${formatReason(result.reason)}`,
                result.success ? 'success' : 'warn'
            );
            addLog(
                result.success ? '访问验证完成' : `访问验证未通过：${formatReason(result.reason)}`,
                result.success ? 'success' : 'warn'
            );
            return result;
        }

        return {
            getInput,
            refreshStatus,
            runBasicCheck,
            runPreflight
        };
    }

    global.AccessValidationControl = { createController };
})(window);
