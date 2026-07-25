(function attachRequestCollectionControl(global) {
    'use strict';

    function requireDependency(deps, name) {
        const value = deps[name];
        if (!value) {
            throw new Error(`Request collection dependency missing: ${name}`);
        }
        return value;
    }

    function createController(deps = {}) {
        const documentRef = deps.document || global.document;
        const fetchFn = deps.fetch || global.fetch;
        const serviceBase = requireDependency(deps, 'serviceBase');
        const defaultPlatformId = requireDependency(deps, 'defaultPlatformId');
        const ensureSelectedPlatforms = requireDependency(deps, 'ensureSelectedPlatforms');
        const fetchJsonOrThrow = requireDependency(deps, 'fetchJsonOrThrow');
        const formatUserReason = requireDependency(deps, 'formatUserReason');
        const renderStatus = requireDependency(deps, 'renderStatus');
        const setStatusBannerState = requireDependency(deps, 'setStatusBannerState');
        const getRequestCollectionFilters = requireDependency(deps, 'getRequestCollectionFilters');
        const getRequestCollectionLocationOverride = requireDependency(deps, 'getRequestCollectionLocationOverride');
        const getAutomationCities = requireDependency(deps, 'getAutomationCities');
        const formatImportSummary = requireDependency(deps, 'formatImportSummary');
        const formatOperationSummary = requireDependency(deps, 'formatOperationSummary');
        const formatRequestSummary = requireDependency(deps, 'formatRequestSummary');
        const addLog = deps.addLog || (() => {});
        const alertFn = deps.alert || global.alert || (() => {});

        function byId(id) {
            return documentRef.getElementById(id);
        }

        function setBanner(message, tone = 'info') {
            const banner = byId('method2ReasonBanner');
            if (banner) {
                setStatusBannerState(banner, message, tone);
            }
        }

        function formatReason(reason) {
            return formatUserReason(reason || 'unknown_error', { includeTech: false });
        }

        function getSelectedPlatform() {
            ensureSelectedPlatforms();
            const selectedPlatforms = Array.isArray(deps.getSelectedPlatforms?.())
                ? deps.getSelectedPlatforms()
                : [];
            return selectedPlatforms[0] || defaultPlatformId;
        }

        function getLocationOverrideText(locationOverride) {
            if (!locationOverride) {
                return '';
            }
            return `\n虚拟定位：${locationOverride.city || 'custom'}${
                locationOverride.lat && locationOverride.lng ? ` (${locationOverride.lat}, ${locationOverride.lng})` : ''
            }`;
        }

        async function refreshStatus() {
            setBanner('正在检查请求采集环境...', 'info');
            try {
                let result;
                try {
                    result = await fetchJsonOrThrow(`${serviceBase}/method2/workflow`);
                } catch {
                    result = await fetchJsonOrThrow(`${serviceBase}/method2/status`);
                }
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

        async function startCapture() {
            const filters = getRequestCollectionFilters();
            const locationOverride = getRequestCollectionLocationOverride();
            setBanner('正在启动请求采集...', 'info');
            const res = await fetchFn(`${serviceBase}/method2/start-capture`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    label: 'method2-desktop-capture',
                    filterHosts: (filters.hosts || []).join(','),
                    filterIps: (filters.ips || []).join(','),
                    ...locationOverride
                })
            });
            const result = await res.json();
            const summary = byId('method2CaptureSummary');
            const activeOverride = result.locationOverride || null;
            if (summary) {
                summary.value = result.success
                    ? `状态：已启动\n请求数：${result.summary?.totalRequests || 0}${getLocationOverrideText(activeOverride)}`
                    : `状态：启动失败\n原因：${formatReason(result.reason)}`;
            }
            setBanner(
                result.success ? '请求采集已启动' : `请求采集启动失败：${formatReason(result.reason)}`,
                result.success ? 'success' : 'error'
            );
            addLog(
                result.success ? '请求采集已开始' : `请求采集启动失败：${formatReason(result.reason)}`,
                result.success ? 'success' : 'error'
            );
            if (result.success && activeOverride) {
                addLog(`本次请求采集已使用测试定位：${activeOverride.city || 'custom'}${
                    activeOverride.lat && activeOverride.lng ? ` (${activeOverride.lat}, ${activeOverride.lng})` : ''
                }`, 'info');
            }
            await refreshStatus();
            return result;
        }

        async function stopAndAnalyze() {
            setBanner('正在停止采集并生成摘要...', 'info');
            const res = await fetchFn(`${serviceBase}/method2/stop-and-analyze`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({})
            });
            const result = await res.json();
            const summary = byId('method2CaptureSummary');
            const requests = byId('method2RequestSummary');
            if (summary) {
                summary.value = result.success
                    ? `状态：分析完成\n目标请求数：${result.summary?.targetRequests || 0}\n总请求数：${result.summary?.totalRequests || 0}\n${formatImportSummary(result.importSummary)}`
                    : `状态：分析未通过\n原因：${formatReason(result.reason)}`;
            }
            if (requests) {
                requests.value = formatRequestSummary(result);
            }
            setBanner(
                result.success
                    ? `请求摘要已生成：发现目标业务请求 ${result.summary?.targetRequests || 0} 个`
                    : `请求摘要未生成：${formatReason(result.reason)}`,
                result.success ? 'success' : 'warn'
            );
            addLog(
                result.success ? '请求摘要已生成' : `请求摘要未生成：${formatReason(result.reason)}`,
                result.success ? 'success' : 'warn'
            );
            await refreshStatus();
            return result;
        }

        function getAutoInput() {
            const targets = getAutomationCities();
            const scrollMode = documentRef.querySelector('input[name="scrollMode"]:checked')?.value || 'duration';
            const scrollCount = Math.max(1, parseInt(byId('scrollCount')?.value, 10) || 5);
            const durationMin = Math.max(0, parseInt(byId('scrollDurationMin')?.value, 10) || 0);
            const durationSec = Math.max(0, parseInt(byId('scrollDurationSec')?.value, 10) || 0);
            const durationSeconds = Math.max(10, durationMin * 60 + durationSec);
            const filters = getRequestCollectionFilters();
            const locationOverride = getRequestCollectionLocationOverride();
            return {
                platform: getSelectedPlatform(),
                targets,
                cities: targets,
                filterHosts: (filters.hosts || []).join(','),
                filterIps: (filters.ips || []).join(','),
                manageSystemProxy: true,
                writeToDb: true,
                maxScrolls: scrollMode === 'count' ? Math.min(scrollCount, 10) : 5,
                maxSteps: scrollMode === 'count' ? Math.min(Math.max(scrollCount * 3, 6), 50) : 20,
                maxDurationSeconds: scrollMode === 'count' ? 180 : Math.min(durationSeconds, 600),
                ...locationOverride
            };
        }

        async function runAutoCapture() {
            const targets = getAutomationCities();
            if (targets.length === 0) {
                alertFn('请至少配置 1 个查询目标');
                return null;
            }
            setBanner('正在通过小程序自动采集业务请求并准备入库...', 'info');
            const input = getAutoInput();
            const res = await fetchFn(`${serviceBase}/method2/run-auto-capture`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(input)
            });
            const result = await res.json();
            const summary = byId('method2CaptureSummary');
            const requests = byId('method2RequestSummary');
            const analysis = result.analysis || {};
            if (summary) {
                summary.value = [
                    `状态：${result.success ? '自动采集流程完成' : '自动采集流程未通过'}`,
                    `原因：${formatReason(result.reason)}`,
                    `目标请求数：${analysis.summary?.targetRequests || 0}`,
                    `总请求数：${analysis.summary?.totalRequests || 0}`,
                    formatImportSummary(result.importSummary || analysis.importSummary),
                    '',
                    formatOperationSummary(result.operation)
                ].join('\n');
            }
            if (requests) {
                requests.value = formatRequestSummary(analysis);
            }
            const targetRequests = analysis.summary?.targetRequests || 0;
            const inserted = (result.importSummary || analysis.importSummary || {}).insertedCount || 0;
            setBanner(
                result.success
                    ? `自动采集完成：目标业务请求 ${targetRequests} 个，成功入库 ${inserted} 条`
                    : `自动采集未通过：${formatReason(result.reason)}`,
                result.success ? 'success' : 'warn'
            );
            addLog(
                result.success ? '请求自动采集、解析入库完成' : `请求自动采集未通过：${formatReason(result.reason)}`,
                result.success ? 'success' : 'warn'
            );
            await refreshStatus();
            return result;
        }

        return {
            getAutoInput,
            refreshStatus,
            runAutoCapture,
            startCapture,
            stopAndAnalyze
        };
    }

    global.RequestCollectionControl = { createController };
})(window);
