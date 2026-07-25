(function attachSmartCollectionControl(global) {
    'use strict';

    function requireDependency(deps, name) {
        const value = deps[name];
        if (!value) {
            throw new Error(`Smart collection dependency missing: ${name}`);
        }
        return value;
    }

    function createController(deps = {}) {
        const documentRef = deps.document || global.document;
        const fetchFn = deps.fetch || global.fetch;
        const serviceBase = requireDependency(deps, 'serviceBase');
        const workflowLabels = requireDependency(deps, 'workflowLabels');
        const addLog = requireDependency(deps, 'addLog');
        const alertFn = deps.alert || global.alert || (() => {});
        const ensureSelectedPlatforms = requireDependency(deps, 'ensureSelectedPlatforms');
        const getSelectedPlatforms = requireDependency(deps, 'getSelectedPlatforms');
        const getConfig = requireDependency(deps, 'getConfig');
        const getAutomationCities = requireDependency(deps, 'getAutomationCities');
        const getPlatformName = requireDependency(deps, 'getPlatformName');
        const getRequestCollectionFilters = requireDependency(deps, 'getRequestCollectionFilters');
        const formatCaptureFilters = requireDependency(deps, 'formatCaptureFilters');
        const renderPreflightChecks = requireDependency(deps, 'renderPreflightChecks');
        const setActiveSession = requireDependency(deps, 'setActiveSession');
        const setCaptureCollectButtons = requireDependency(deps, 'setCaptureCollectButtons');
        const startSessionPolling = requireDependency(deps, 'startSessionPolling');

        function byId(id) {
            return documentRef.getElementById(id);
        }

        function getPlatforms() {
            ensureSelectedPlatforms();
            const selectedPlatforms = getSelectedPlatforms();
            return Array.isArray(selectedPlatforms) ? selectedPlatforms : [];
        }

        function validatePlatforms() {
            const selectedPlatforms = getPlatforms();
            if (selectedPlatforms.length === 0) {
                alertFn('请至少选择一个平台');
                return null;
            }
            const config = getConfig() || {};
            const maxPlatforms = Number(config.automation?.maxPlatformsPerSession) || 1;
            if (selectedPlatforms.length > maxPlatforms) {
                alertFn(`当前自动化链路一次只支持 ${maxPlatforms} 个平台，请分开执行`);
                return null;
            }
            return selectedPlatforms;
        }

        function validateTargets() {
            const automationCities = getAutomationCities();
            if (automationCities.length === 0) {
                alertFn('请至少配置 1 个查询目标');
                return null;
            }
            return automationCities;
        }

        function getScrollOptions() {
            const scrollMode = documentRef.querySelector('input[name="scrollMode"]:checked')?.value || 'count';
            const scrollIntervalMin = parseInt(byId('scrollIntervalMin')?.value, 10) || 4000;
            const scrollIntervalMax = parseInt(byId('scrollIntervalMax')?.value, 10) || 8000;

            if (scrollMode === 'count') {
                const scrollCount = parseInt(byId('scrollCount')?.value, 10) || 10;
                addLog(`🔄 滑动参数: 模式=按次数, 次数=${scrollCount}, 间隔=${scrollIntervalMin}~${scrollIntervalMax}ms`, 'info');
                return {
                    scrollMode,
                    scrollCount,
                    scrollDurationMs: null,
                    scrollIntervalMin,
                    scrollIntervalMax
                };
            }

            const durationMin = parseInt(byId('scrollDurationMin')?.value, 10) || 2;
            const durationSec = parseInt(byId('scrollDurationSec')?.value, 10) || 0;
            const scrollDurationMs = (durationMin * 60 + durationSec) * 1000;
            addLog(`🔄 滑动参数: 模式=按时间, 时长=${durationMin}分${durationSec}秒, 间隔=${scrollIntervalMin}~${scrollIntervalMax}ms`, 'info');
            return {
                scrollMode,
                scrollCount: null,
                scrollDurationMs,
                scrollIntervalMin,
                scrollIntervalMax
            };
        }

        async function runPreflight() {
            const selectedPlatforms = validatePlatforms();
            if (!selectedPlatforms) {
                return null;
            }
            const automationCities = validateTargets();
            if (!automationCities) {
                return null;
            }

            addLog('开始自动化预检...', 'info');

            try {
                const res = await fetchFn(`${serviceBase}/smart-collect/preflight`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        platforms: selectedPlatforms,
                        targets: automationCities,
                        cities: automationCities,
                        captureFilters: getRequestCollectionFilters()
                    })
                });
                const result = await res.json();

                if (!result.success) {
                    addLog(`❌ 自动化预检失败: ${result.error}`, 'error');
                    return null;
                }

                const data = result.data || {};
                renderPreflightChecks(data.checks || []);

                if (data.canStart) {
                    addLog('自动化预检通过，可以开始验证', 'success');
                } else {
                    addLog('❌ 自动化预检未通过，请先处理失败项', 'error');
                }

                return data;
            } catch (error) {
                addLog(`❌ 自动化预检请求失败: ${error.message}`, 'error');
                return null;
            }
        }

        async function startCollection() {
            const selectedPlatforms = validatePlatforms();
            if (!selectedPlatforms) {
                return;
            }
            const automationCities = validateTargets();
            if (!automationCities) {
                return;
            }

            const logContainer = byId('collectionLog');
            if (logContainer) {
                logContainer.innerHTML = '';
            }

            const preflight = await runPreflight();
            if (!preflight || !preflight.canStart) {
                addLog('❌ 自动化预检未通过，已取消启动。请先处理失败项后再重试。', 'error');
                return;
            }

            addLog('🚀 启动自动验证任务', 'info');
            addLog(`📦 本次平台: ${selectedPlatforms.map(getPlatformName).join('、')}`, 'info');
            addLog(`📍 查询目标: ${automationCities.join('、')}`, 'info');
            addLog(`${workflowLabels.business}启动`, 'info');
            addLog('请求记录启动', 'info');
            const captureFilters = getRequestCollectionFilters();
            addLog(`请求记录范围: ${formatCaptureFilters(captureFilters).trim()}`, 'info');
            const scrollOptions = getScrollOptions();

            try {
                const res = await fetchFn(`${serviceBase}/smart-collect/start`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        platforms: selectedPlatforms,
                        targets: automationCities,
                        cities: automationCities,
                        captureFilters,
                        ...scrollOptions
                    })
                });

                const result = await res.json();

                if (result.success) {
                    setActiveSession({
                        sessionId: result.sessionId,
                        mode: 'mitm'
                    });

                    addLog('自动验证任务已启动', 'success');
                    addLog('任务已启动', 'info');
                    addLog('后续将自动完成：按目标切换/搜索、点击列表并连续下滑；系统会保存请求记录并生成摘要', 'success');

                    setCaptureCollectButtons(true);
                    startSessionPolling();
                } else {
                    addLog(`❌ 启动失败: ${result.error}`, 'error');
                }
            } catch (error) {
                addLog(`❌ 请求失败: ${error.message}`, 'error');
            }
        }

        return {
            getScrollOptions,
            runPreflight,
            startCollection
        };
    }

    global.SmartCollectionControl = { createController };
})(window);
