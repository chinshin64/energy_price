(function attachScheduleControl(global) {
    'use strict';

    function requireDependency(deps, name) {
        const value = deps[name];
        if (!value) {
            throw new Error(`Schedule control dependency missing: ${name}`);
        }
        return value;
    }

    function createController(deps = {}) {
        const documentRef = deps.document || global.document;
        const fetchImpl = requireDependency(deps, 'fetch');
        const serviceBase = requireDependency(deps, 'serviceBase');
        const alertFn = deps.alert || global.alert;
        const confirmFn = deps.confirm || global.confirm;
        const consoleRef = deps.console || global.console;
        const collectSelfHealSettingsFromForm = requireDependency(deps, 'collectSelfHealSettingsFromForm');
        const ensureSelectedPlatforms = requireDependency(deps, 'ensureSelectedPlatforms');
        const escapeHtml = requireDependency(deps, 'escapeHtml');
        const formatTime = requireDependency(deps, 'formatTime');
        const getCrawlerPerRunLimitFromInput = requireDependency(deps, 'getCrawlerPerRunLimitFromInput');
        const getPlatformName = requireDependency(deps, 'getPlatformName');
        const getSelectedPlatforms = requireDependency(deps, 'getSelectedPlatforms');
        const getTargetLocation = requireDependency(deps, 'getTargetLocation');
        const loadData = requireDependency(deps, 'loadData');
        const loadSelfHealRuns = requireDependency(deps, 'loadSelfHealRuns');
        const loadStats = requireDependency(deps, 'loadStats');
        const parseJsonArray = requireDependency(deps, 'parseJsonArray');
        const renderSelfHealPlan = requireDependency(deps, 'renderSelfHealPlan');
        const setStatusBannerState = requireDependency(deps, 'setStatusBannerState');
        const getSelfHealDiagnosisRequest = deps.getSelfHealDiagnosisRequest || (() => ({
            scenario: 'api_501_burst',
            currentChain: 'api'
        }));

        function byId(id) {
            return documentRef.getElementById(id);
        }

        function normalizeScheduleId(id) {
            const value = Number(id);
            return Number.isSafeInteger(value) && value > 0 ? value : 0;
        }

        function renderEmpty(message) {
            const tbody = byId('scheduleList');
            if (tbody) {
                tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; padding: 20px;">${escapeHtml(message)}</td></tr>`;
            }
        }

        function renderSchedules(rows = []) {
            const tbody = byId('scheduleList');
            if (!tbody) {
                return;
            }
            if (!Array.isArray(rows) || rows.length === 0) {
                renderEmpty('暂无任务');
                return;
            }

            tbody.innerHTML = rows.map(schedule => {
                const id = normalizeScheduleId(schedule.id);
                const platforms = parseJsonArray(schedule.platforms);
                const selfHealEnabled = Boolean(schedule.self_heal_enabled);
                const cronExpression = schedule.cronExpression || schedule.cron_expression || '';
                const nextRun = schedule.nextRun || schedule.next_run || null;
                const lastStatus = schedule.lastStatus || schedule.last_status || 'never_run';
                const enabled = Boolean(schedule.enabled);
                return `
                    <tr>
                        <td>${escapeHtml(schedule.name || '')}</td>
                        <td>
                            <code>${escapeHtml(cronExpression)}</code>
                            ${nextRun ? `<div class="recovery-text">下次：${escapeHtml(formatTime(nextRun))}</div>` : ''}
                        </td>
                        <td>${escapeHtml(platforms.map(getPlatformName).join(', '))}</td>
                        <td>
                            <span class="self-heal-chip ${selfHealEnabled ? '' : 'off'}">${selfHealEnabled ? '自动排查已启用' : '自动排查已关闭'}</span>
                            <div class="recovery-text">${escapeHtml(schedule.self_heal_summary || '-')}</div>
                        </td>
                        <td>
                            <div>${escapeHtml(schedule.last_recovery_status || '未执行')}</div>
                            <div class="recovery-text">${escapeHtml(schedule.last_recovery_summary || '尚未生成恢复记录')}</div>
                            ${schedule.last_recovery_at ? `<div class="recovery-text">${escapeHtml(schedule.last_recovery_at)}</div>` : ''}
                        </td>
                        <td>
                            <div>${enabled ? '启用' : '暂停'}</div>
                            <div class="recovery-text">${escapeHtml(lastStatus)}</div>
                        </td>
                        <td>
                            <button class="btn btn-secondary" onclick="toggleSchedule(${id}, ${!enabled})">
                                ${enabled ? '暂停' : '启用'}
                            </button>
                            <button class="btn btn-secondary" onclick="runScheduleNow(${id})">运行</button>
                            <button class="btn btn-secondary" onclick="drillSchedule(${id})">演练</button>
                            <button class="btn btn-danger" onclick="deleteSchedule(${id})">删除</button>
                        </td>
                    </tr>
                `;
            }).join('');
        }

        async function loadSchedules() {
            try {
                const response = await fetchImpl(`${serviceBase}/schedules`);
                const result = await response.json();
                if (!result.success) {
                    throw new Error(result.error || '定时任务加载失败');
                }
                renderSchedules(Array.isArray(result.data) ? result.data : []);
            } catch (error) {
                consoleRef.error('Failed to load schedules:', error);
                renderEmpty(`定时任务加载失败：${error.message}`);
            }
        }

        async function createSchedule() {
            ensureSelectedPlatforms();
            const selectedPlatforms = getSelectedPlatforms();
            const targetLocation = getTargetLocation();
            const name = byId('scheduleName')?.value.trim() || '';
            const cron = byId('scheduleCron')?.value.trim() || '';
            const lat = Number(byId('collectCenterLat')?.value || targetLocation?.lat);
            const lng = Number(byId('collectCenterLng')?.value || targetLocation?.lng);
            const city = String(
                targetLocation?.city
                || targetLocation?.name
                || byId('collectPresetCity')?.value
                || ''
            ).trim();
            const radiusKm = Number(byId('collectRadius')?.value || 20);
            const configuredRunLimit = getCrawlerPerRunLimitFromInput();

            if (!name || !cron) {
                alertFn('请填写任务名称和 Cron 表达式');
                return;
            }
            if (!Array.isArray(selectedPlatforms) || selectedPlatforms.length === 0) {
                alertFn('请选择至少一个平台');
                return;
            }
            if (!city || !Number.isFinite(lat) || !Number.isFinite(lng)) {
                alertFn('请先在验证目标中选择城市并确认中心经纬度');
                return;
            }
            if (configuredRunLimit === undefined) {
                return;
            }

            try {
                const response = await fetchImpl(`${serviceBase}/schedules`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        name,
                        platforms: selectedPlatforms,
                        cronExpression: cron,
                        taskType: 'validation',
                        payload: {
                            chain: 'method3',
                            mode: 'list',
                            target: {
                                city,
                                lat,
                                lng,
                                radiusKm,
                                coordinateSystem: targetLocation?.coordinateSystem || 'WGS84'
                            },
                            maxPages: 1,
                            maxRequestCount: Math.min(5, configuredRunLimit === null ? 5 : configuredRunLimit),
                            maxQps: 1
                        },
                        selfHealSettings: collectSelfHealSettingsFromForm()
                    })
                });

                const result = await response.json();
                if (result.success) {
                    alertFn('定时任务创建成功！');
                    await loadSchedules();
                    return;
                }
                alertFn(`创建失败：${result.error}`);
            } catch (error) {
                alertFn(`请求失败：${error.message}`);
            }
        }

        async function drillSchedule(id) {
            try {
                const scheduleId = normalizeScheduleId(id);
                const { scenario, currentChain } = getSelfHealDiagnosisRequest();
                const response = await fetchImpl(`${serviceBase}/schedules/${scheduleId}/drill`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ scenario, currentChain })
                });
                const result = await response.json();
                if (!result.success) {
                    throw new Error(result.error || '排查演练失败');
                }

                renderSelfHealPlan(result.data?.diagnosis || null);
                await loadSelfHealRuns();
                await loadSchedules();
                setStatusBannerState(
                    byId('selfHealStatus'),
                    `${result.data?.schedule?.name || '任务'} 已生成当前能力排查方案`,
                    result.data?.diagnosis?.status === 'recoverable' ? 'success' : 'error'
                );
            } catch (error) {
                alertFn(`排查演练失败：${error.message}`);
            }
        }

        async function runScheduleNow(id) {
            try {
                const response = await fetchImpl(`${serviceBase}/schedules/${normalizeScheduleId(id)}/run`, { method: 'POST' });
                const result = await response.json();
                if (!result.success) {
                    throw new Error(result.error || '任务运行失败');
                }
                await loadSchedules();
                await loadStats();
                await loadData();
            } catch (error) {
                alertFn(`任务运行失败：${error.message}`);
            }
        }

        async function toggleSchedule(id, enabled) {
            try {
                const response = await fetchImpl(`${serviceBase}/schedules/${normalizeScheduleId(id)}/toggle`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ enabled })
                });
                const result = await response.json();
                if (result.success) {
                    await loadSchedules();
                    return;
                }
                alertFn(`操作失败：${result.error || '任务状态更新失败'}`);
            } catch (error) {
                alertFn(`操作失败：${error.message}`);
            }
        }

        async function deleteSchedule(id) {
            if (!confirmFn('确定要删除这个任务吗？')) {
                return;
            }

            try {
                const response = await fetchImpl(`${serviceBase}/schedules/${normalizeScheduleId(id)}`, {
                    method: 'DELETE'
                });
                const result = await response.json();
                if (result.success) {
                    await loadSchedules();
                    return;
                }
                alertFn(`删除失败：${result.error || '任务删除失败'}`);
            } catch (error) {
                alertFn(`删除失败：${error.message}`);
            }
        }

        return {
            createSchedule,
            deleteSchedule,
            drillSchedule,
            loadSchedules,
            renderSchedules,
            runScheduleNow,
            toggleSchedule
        };
    }

    global.ScheduleControl = { createController };
})(window);
