(function attachCoordinateCrawlControl(global) {
    'use strict';

    function requireDependency(deps, name) {
        const value = deps[name];
        if (!value) {
            throw new Error(`Coordinate crawl dependency missing: ${name}`);
        }
        return value;
    }

    function createController(deps = {}) {
        const documentRef = deps.document || global.document;
        const fetchRef = deps.fetch || global.fetch?.bind(global);
        const alertRef = deps.alert || global.alert?.bind(global) || (() => {});
        if (!fetchRef) {
            throw new Error('Coordinate crawl dependency missing: fetch');
        }

        const serviceBase = requireDependency(deps, 'serviceBase');
        const workflowLabel = deps.workflowLabel || '小规模访问验证';
        const ensureSelectedPlatforms = requireDependency(deps, 'ensureSelectedPlatforms');
        const getSelectedPlatforms = deps.getSelectedPlatforms || (() => []);
        const getPlatformName = deps.getPlatformName || (value => value || '-');
        const getCrawlerPerRunLimitFromInput = requireDependency(deps, 'getCrawlerPerRunLimitFromInput');
        const parseCollectTargetKeywords = requireDependency(deps, 'parseCollectTargetKeywords');
        const resolveCollectTargetLocations = requireDependency(deps, 'resolveCollectTargetLocations');
        const setProgressRunning = requireDependency(deps, 'setProgressRunning');
        const setProgressMeta = requireDependency(deps, 'setProgressMeta');
        const addProgressLog = requireDependency(deps, 'addProgressLog');
        const stopProgressPolling = requireDependency(deps, 'stopProgressPolling');
        const startProgressPolling = requireDependency(deps, 'startProgressPolling');
        const normalizeRunQuotaStats = requireDependency(deps, 'normalizeRunQuotaStats');
        const renderCrawlerRunQuotaStats = requireDependency(deps, 'renderCrawlerRunQuotaStats');
        const setCurrentRunStats = deps.setCurrentRunStats || (() => {});

        function byId(id) {
            return documentRef.getElementById(id);
        }

        function readNumberInput(id, fallback = NaN) {
            const raw = byId(id)?.value?.trim() || '';
            return raw ? Number(raw) : fallback;
        }

        function readInput() {
            return {
                centerLat: readNumberInput('collectCenterLat'),
                centerLng: readNumberInput('collectCenterLng'),
                radius: Number(byId('collectRadius')?.value || 20),
                gridSize: Number(byId('collectGridSize')?.value || 2),
                crawlMode: byId('collectCrawlMode')?.value || 'both',
                perRunLimit: getCrawlerPerRunLimitFromInput()
            };
        }

        function buildInitialRunStats(perRunLimit, targetCount) {
            return {
                limit: perRunLimit === null ? null : perRunLimit * Math.max(1, targetCount),
                unlimited: perRunLimit === null,
                used: 0,
                success: 0,
                fail501: 0,
                quotaMode: 'per-target',
                perTargetLimit: perRunLimit,
                targetCount
            };
        }

        function renderRunQuota(result = {}) {
            const runStats = normalizeRunQuotaStats(result.runQuota);
            setCurrentRunStats(runStats);
            if (result.quotaStats) {
                renderCrawlerRunQuotaStats(result.quotaStats, runStats);
            }
            return runStats;
        }

        async function startForSelectedPlatforms() {
            ensureSelectedPlatforms();
            const selectedPlatforms = getSelectedPlatforms();
            if (!Array.isArray(selectedPlatforms) || selectedPlatforms.length === 0) {
                alertRef('请先选择至少一个平台');
                return;
            }

            const input = readInput();
            const hasCenter = Number.isFinite(input.centerLat) && Number.isFinite(input.centerLng);
            if (!hasCenter && parseCollectTargetKeywords().length === 0) {
                alertRef('请输入有效的中心经纬度或目标位置');
                return;
            }
            if (input.perRunLimit === undefined) {
                alertRef('访问保护策略配置无效');
                return;
            }

            let targetLocations = [];
            try {
                targetLocations = await resolveCollectTargetLocations(input.centerLat, input.centerLng);
            } catch (error) {
                alertRef(error.message);
                return;
            }

            setProgressRunning(true);
            setProgressMeta(`正在提交${workflowLabel}后台任务...`);
            addProgressLog(`🧭 启动按坐标验证，目标 ${targetLocations.length} 个`, 'info');
            if (targetLocations.length > 1) {
                addProgressLog('本次按单任务多目标下发，每个城市/地标独立请求预算和网络出口策略。', 'info');
            }
            addProgressLog(`📦 平台: ${selectedPlatforms.map(getPlatformName).join('、')}`, 'info');
            addProgressLog(`🧩 检索模式: ${input.crawlMode}`, 'info');
            addProgressLog('访问保护策略已启用', 'info');
            if (selectedPlatforms.includes('didi-charging')) {
                addProgressLog('滴滴请求材料含凭证校验信息时会按目标坐标真实请求；若材料校验失败，需要重新采集当前目标的请求记录。', 'warn');
            }
            setCurrentRunStats(buildInitialRunStats(input.perRunLimit, targetLocations.length));

            try {
                const requestCenterLat = Number.isFinite(input.centerLat) ? input.centerLat : targetLocations[0].lat;
                const requestCenterLng = Number.isFinite(input.centerLng) ? input.centerLng : targetLocations[0].lng;
                const res = await fetchRef(`${serviceBase}/crawler/crawl-platforms-with-coordinates/start`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        platforms: selectedPlatforms,
                        centerLat: requestCenterLat,
                        centerLng: requestCenterLng,
                        radius: input.radius,
                        gridSize: input.gridSize,
                        crawlMode: input.crawlMode,
                        perRunLimit: input.perRunLimit,
                        perRunUnlimited: input.perRunLimit === null,
                        targetLocation: targetLocations[0],
                        targetLocations
                    })
                });

                const result = await res.json();
                if (!result.success) {
                    addProgressLog(`❌ 坐标验证启动失败: ${result.error}`, 'error');
                    renderRunQuota(result);
                    setProgressRunning(false);
                    setProgressMeta('启动失败');
                    return;
                }

                addProgressLog(`✅ ${workflowLabel}后台任务已启动: Run #${result.runId}`, 'success');
                setProgressMeta(`Run #${result.runId} ｜ running`);
                renderRunQuota(result);
                startProgressPolling(result.runId);
            } catch (error) {
                stopProgressPolling();
                setProgressRunning(false);
                setProgressMeta('请求失败');
                addProgressLog(`❌ 坐标验证请求失败: ${error.message}`, 'error');
            }
        }

        return {
            startForSelectedPlatforms
        };
    }

    global.CoordinateCrawlControl = { createController };
})(window);
