(function attachTemplateApiProgressControl(global) {
    'use strict';

    function requireDependency(deps, name) {
        const value = deps[name];
        if (!value) {
            throw new Error(`Template API progress dependency missing: ${name}`);
        }
        return value;
    }

    function createController(deps = {}) {
        const documentRef = deps.document || global.document;
        const serviceBase = requireDependency(deps, 'serviceBase');
        const escapeHtml = requireDependency(deps, 'escapeHtml');
        const normalizeRunQuotaStats = requireDependency(deps, 'normalizeRunQuotaStats');
        const addLog = requireDependency(deps, 'addLog');
        const renderCrawlerRunQuotaStats = requireDependency(deps, 'renderCrawlerRunQuotaStats');
        const loadCrawlerRunQuota = requireDependency(deps, 'loadCrawlerRunQuota');
        const getCurrentRunStats = deps.getCurrentRunStats || function noStats() { return null; };
        const setCurrentRunStats = deps.setCurrentRunStats || function noop() {};
        const refreshData = deps.refreshData || function noop() {};
        const workflowLabel = deps.workflowLabel || '小规模访问验证';
        const progressTimers = new Map();
        const renderedFinalRuns = new Set();

        function byId(id) {
            return documentRef.getElementById(id);
        }

        function setProgressMeta(text) {
            const meta = byId('crawlerProgressMeta');
            if (meta) {
                meta.textContent = text;
            }
        }

        function stopPolling(runId = null) {
            if (runId !== null) {
                const timer = progressTimers.get(Number(runId));
                if (timer) {
                    clearInterval(timer);
                    progressTimers.delete(Number(runId));
                }
                return;
            }

            progressTimers.forEach(timer => clearInterval(timer));
            progressTimers.clear();
        }

        function clearProgress() {
            stopPolling();
            const container = byId('crawlerProgressList');
            if (container) {
                container.innerHTML = '';
            }
            renderedFinalRuns.clear();
        }

        function addProgressLog(message, type = 'info', mirrorToCollectionLog = true) {
            if (mirrorToCollectionLog) {
                addLog(message, type);
            }
            setProgressMeta(String(message || ''));
        }

        function setRunning(isRunning) {
            const button = byId('crawlByCoordinatesBtn');
            if (!button) {
                return;
            }

            button.disabled = false;
            button.textContent = isRunning ? '继续新增任务' : '按坐标开始验证';
        }

        function renderProgressCard(run) {
            if (!run) {
                return;
            }

            const container = byId('crawlerProgressList');
            if (!container) {
                return;
            }

            const result = run.resultSummary || {};
            const progress = result.progress || {};
            const quota = normalizeRunQuotaStats(result.runQuota || progress) || normalizeRunQuotaStats(getCurrentRunStats()) || {
                limit: progress.limit ?? null,
                unlimited: Boolean(progress.unlimited),
                used: Number(progress.used) || 0,
                success: Number(progress.success) || 0,
                fail501: Number(progress.fail501) || 0
            };
            const used = Math.max(0, Number(quota.used) || 0);
            const success = Math.max(0, Number(quota.success) || 0);
            const fail501 = Math.max(0, Number(quota.fail501) || 0);
            const other = Math.max(0, used - success - fail501);
            const totalForBar = Math.max(used, 1);
            const percent = value => `${Math.max(0, Math.min(100, (value / totalForBar) * 100)).toFixed(2)}%`;
            const targets = Array.isArray(result.targetLocations) ? result.targetLocations : [];
            const activeTarget = result.activeTarget || progress.activeTarget || null;
            const targetText = activeTarget
                ? `当前：${[activeTarget.province, activeTarget.city, activeTarget.district, activeTarget.keyword || activeTarget.name].filter(Boolean).join(' / ')}`
                : targets.length > 0
                    ? `目标 ${progress.completedTargetCount || 0}/${targets.length}`
                    : '目标待确认';
            const status = String(run.status || progress.status || 'running');
            const statusLabel = {
                running: '执行中',
                success: '已完成',
                failed: '失败',
                aborted: '已中断'
            }[status] || status;
            const title = `Run #${run.id} · ${targetText}`;

            let card = container.querySelector(`[data-run-id="${run.id}"]`);
            if (!card) {
                card = documentRef.createElement('div');
                card.className = 'task-progress-card';
                card.dataset.runId = run.id;
                container.prepend(card);
            }

            card.innerHTML = `
                <div class="task-progress-head">
                    <div class="task-progress-title">${escapeHtml(title)}</div>
                    <div class="task-progress-status ${escapeHtml(status)}">${escapeHtml(statusLabel)}</div>
                </div>
                <div class="task-progress-bar" aria-label="${workflowLabel}执行进度">
                    <div class="task-progress-seg success" style="width:${percent(success)}"></div>
                    <div class="task-progress-seg fail501" style="width:${percent(fail501)}"></div>
                    <div class="task-progress-seg other" style="width:${percent(other)}"></div>
                </div>
                <div class="task-progress-metrics">
                    <div class="task-progress-metric"><strong>${success}</strong><span>成功请求</span></div>
                    <div class="task-progress-metric"><strong>${fail501}</strong><span>材料校验失败</span></div>
                    <div class="task-progress-metric"><strong>${used}</strong><span>已发请求</span></div>
                </div>
                <div class="task-progress-meta">
                    <span>目标 ${progress.completedTargetCount || 0}/${progress.targetCount || targets.length || 0} · 场站 ${result.totalStations || 0} · 入库 ${result.totalInserted || 0} · 跳过 ${result.totalSkipped || 0}</span>
                    <span>${escapeHtml(run.createdAt || '')}</span>
                </div>
            `;
        }

        async function pollRunProgress(runId) {
            if (!runId) {
                return null;
            }

            const runRes = await fetch(`${serviceBase}/runs/${runId}`);
            const runResult = await runRes.json();

            if (!runResult.success) {
                throw new Error(runResult.error || `读取${workflowLabel}任务状态失败`);
            }

            const run = runResult.data;
            renderProgressCard(run);
            const result = run.resultSummary || {};
            const progress = result.progress || {};
            setProgressMeta(`运行任务 ${progressTimers.size} 个 ｜ Run #${run.id} ｜ ${run.status} ｜ 成功 ${progress.success || 0} ｜ 材料校验失败 ${progress.fail501 || 0} ｜ 还剩 ${progress.unlimited ? '无上限' : (progress.remaining ?? '-')}`);
            if (run.status !== 'running') {
                stopPolling(runId);
                renderRunResult(run);
            }

            return run;
        }

        function startPolling(runId) {
            if (progressTimers.has(Number(runId))) {
                return;
            }

            const timer = setInterval(() => {
                pollRunProgress(runId).catch(error => {
                    addProgressLog(`❌ 读取执行进度失败: ${error.message}`, 'error', false);
                });
            }, 1500);
            progressTimers.set(Number(runId), timer);
            pollRunProgress(runId).catch(error => {
                addProgressLog(`❌ 读取执行进度失败: ${error.message}`, 'error', false);
            });
        }

        function renderRunResult(run) {
            if (renderedFinalRuns.has(Number(run?.id))) {
                return;
            }
            renderedFinalRuns.add(Number(run?.id));
            setRunning(false);
            renderProgressCard(run);

            const result = run?.resultSummary || {};
            if (run?.status === 'success') {
                setProgressMeta(`Run #${run.id} 完成：识别 ${result.totalStations || 0}，入库 ${result.totalInserted || 0}，跳过 ${result.totalSkipped || 0}`);
            } else {
                setProgressMeta(`Run #${run?.id || '-'} 失败：${run?.errorMessage || '任务异常结束'}`);
            }

            setCurrentRunStats(normalizeRunQuotaStats(result.runQuota));
            if (result.quotaStats) {
                renderCrawlerRunQuotaStats(result.quotaStats, getCurrentRunStats());
            } else {
                loadCrawlerRunQuota();
            }
            refreshData();
        }

        return {
            addProgressLog,
            clearProgress,
            pollRunProgress,
            renderProgressCard,
            renderRunResult,
            setProgressMeta,
            setRunning,
            startPolling,
            stopPolling
        };
    }

    global.TemplateApiProgressControl = { createController };
})(window);
