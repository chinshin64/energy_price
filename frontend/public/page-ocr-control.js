(function attachPageOcrControl(global) {
    'use strict';

    function requireDependency(deps, name) {
        const value = deps[name];
        if (!value) {
            throw new Error(`Page OCR dependency missing: ${name}`);
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
        const getPageOcrCities = requireDependency(deps, 'getPageOcrCities');
        const getPageOcrScrollOptions = requireDependency(deps, 'getPageOcrScrollOptions');
        const getPlatformName = requireDependency(deps, 'getPlatformName');
        const renderPreflightChecks = requireDependency(deps, 'renderPreflightChecks');
        const setActiveSession = requireDependency(deps, 'setActiveSession');
        const getActiveSession = requireDependency(deps, 'getActiveSession');
        const setPageOcrButtons = requireDependency(deps, 'setPageOcrButtons');
        const startSessionPolling = requireDependency(deps, 'startSessionPolling');
        const normalizeStationRecord = requireDependency(deps, 'normalizeStationRecord');
        const formatStationInlineSummary = requireDependency(deps, 'formatStationInlineSummary');
        const loadStats = requireDependency(deps, 'loadStats');
        const loadData = requireDependency(deps, 'loadData');

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

        function getCollectionMode() {
            return byId('pageCollectionMode')?.value || 'page-assisted';
        }

        function validateCities() {
            const cities = getPageOcrCities();
            if (cities.length === 0) {
                alertFn('请至少配置 1 个查询城市或地标');
                return null;
            }
            return cities;
        }

        async function runPreflight() {
            const selectedPlatforms = validatePlatforms();
            if (!selectedPlatforms) {
                return null;
            }
            const cities = validateCities();
            if (!cities) {
                return null;
            }

            const pageCollectionMode = getCollectionMode();
            addLog(`🔎 开始${workflowLabels.page} 页面识别检查...`, 'info');

            try {
                const res = await fetchFn(`${serviceBase}/page-collect/preflight`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        platforms: selectedPlatforms,
                        cities,
                        pageCollectionMode
                    })
                });
                const result = await res.json();

                if (!result.success) {
                    addLog(`❌ 页面识别检查失败: ${result.error}`, 'error');
                    return null;
                }

                const data = result.data || {};
                renderPreflightChecks(data.checks || []);
                addLog(
                    data.canStart ? `✅ 页面识别检查通过，可以启动${workflowLabels.page}` : '❌ 页面识别检查未通过，请先处理失败项',
                    data.canStart ? 'success' : 'error'
                );
                return data;
            } catch (error) {
                addLog(`❌ 页面识别检查请求失败: ${error.message}`, 'error');
                return null;
            }
        }

        async function startCollection() {
            const selectedPlatforms = validatePlatforms();
            if (!selectedPlatforms) {
                return;
            }
            const cities = validateCities();
            if (!cities) {
                return;
            }

            const logContainer = byId('collectionLog');
            if (logContainer) {
                logContainer.innerHTML = '';
            }

            const pageCollectionMode = getCollectionMode();
            const preflight = await runPreflight();
            if (!preflight || !preflight.canStart) {
                addLog(`❌ ${workflowLabels.page}预检未通过，已取消启动。`, 'error');
                return;
            }

            const scrollOptions = getPageOcrScrollOptions();
            addLog(`🚀 启动${workflowLabels.page}：${pageCollectionMode === 'page-assisted' ? '人工辅助 + 页面增量识别' : '自动下滑 + 页面识别入库'}`, 'info');
            addLog(`📦 本次平台: ${selectedPlatforms.map(getPlatformName).join('、')}`, 'info');
            addLog(`🏙️ 查询城市/地标: ${cities.join('、')}`, 'info');
            if (pageCollectionMode === 'page-assisted') {
                addLog('🤝 人工辅助模式：请在微信小程序内手动下滑，系统后台将周期截图并执行页面增量识别。', 'info');
            }
            addLog(`🔄 下滑参数: 次数=${scrollOptions.scrollCount}, 间隔=${scrollOptions.scrollIntervalMin}~${scrollOptions.scrollIntervalMax}ms，每次下滑后识别页面`, 'info');

            try {
                const res = await fetchFn(`${serviceBase}/page-collect/start`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        platforms: selectedPlatforms,
                        cities,
                        pageCollectionMode,
                        ...scrollOptions
                    })
                });
                const result = await res.json();

                if (result.success) {
                    setActiveSession({
                        sessionId: result.sessionId,
                        mode: 'page-ocr'
                    });
                    addLog(`✅ ${workflowLabels.page}任务已启动`, 'success');
                    addLog('任务已启动', 'info');
                    setPageOcrButtons(true);
                    startSessionPolling();
                } else {
                    addLog(`❌ ${workflowLabels.page}启动失败: ${result.error}`, 'error');
                }
            } catch (error) {
                addLog(`❌ ${workflowLabels.page}请求失败: ${error.message}`, 'error');
            }
        }

        function resolveManualCapturePlatform() {
            const activeSession = getActiveSession();
            const selectedPlatforms = getPlatforms();
            if (activeSession?.currentPlatform) {
                return activeSession.currentPlatform;
            }

            if (selectedPlatforms.length === 1) {
                return selectedPlatforms[0];
            }

            if (selectedPlatforms.length === 0) {
                throw new Error('请先选择一个平台后再执行当前页面识别');
            }

            throw new Error('当前页面识别一次只支持一个平台，请只保留一个选中平台');
        }

        async function captureCurrentPage() {
            const platform = resolveManualCapturePlatform();
            addLog(`👀 正在识别当前 ${getPlatformName(platform)} 页面...`, 'info');
            addLog('🖼️ 后端将自动截图、识别页面并把识别结果写入数据库', 'info');

            try {
                const res = await fetchFn(`${serviceBase}/page-capture`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ platform, stage: 'manual' })
                });

                const result = await res.json();
                if (!result.success) {
                    addLog(`❌ ${getPlatformName(platform)} 页面识别失败: ${result.error}`, 'error');
                    return;
                }

                if (result.meta?.window) {
                    const win = result.meta.window;
                    addLog(`🪟 窗口: ${win.ownerName || '未知'} - ${win.name || '无标题'}`, 'info');
                }

                addLog(`✅ ${getPlatformName(platform)} 页面识别完成，识别 ${result.stationCount} 个场站`, 'success');

                if (Array.isArray(result.data)) {
                    result.data.forEach(rawStation => {
                        const station = normalizeStationRecord(rawStation);
                        addLog(`📍 ${station.station_name || '未命名场站'}，${formatStationInlineSummary(station)}`, 'success');

                        if (rawStation.raw?.priceSchedules && rawStation.raw.priceSchedules.length > 0) {
                            const scheduleInfo = rawStation.raw.priceSchedules.map(s =>
                                `${s.start_time}-${s.end_time}: ¥${s.price}`
                            ).join(', ');
                            addLog(`   ⏰ 分时价格: ${scheduleInfo}`, 'info');
                        }
                    });
                }

                loadStats();
                loadData();
            } catch (error) {
                addLog(`❌ ${getPlatformName(platform)} 页面识别请求失败: ${error.message}`, 'error');
            }
        }

        return {
            captureCurrentPage,
            resolveManualCapturePlatform,
            runPreflight,
            startCollection
        };
    }

    global.PageOcrControl = { createController };
})(window);
