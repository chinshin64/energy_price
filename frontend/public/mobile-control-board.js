(function attachMobileControlBoard(global) {
    'use strict';

    function requireDependency(deps, name) {
        const value = deps[name];
        if (!value) {
            throw new Error(`Mobile control board dependency missing: ${name}`);
        }
        return value;
    }

    function createController(deps = {}) {
        const documentRef = deps.document || global.document;
        const escapeHtml = requireDependency(deps, 'escapeHtml');
        const formatPresetCoordinate = requireDependency(deps, 'formatPresetCoordinate');
        const formatTime = requireDependency(deps, 'formatTime');

        function byId(id) {
            return documentRef.getElementById(id);
        }

        function formatCommandType(type) {
            return {
                status: '设备状态',
                collect_visible_text: '读取页面',
                collect_landmark: '验证地标',
                set_mock_location: '模拟定位',
                clear_mock_location: '恢复定位',
                stop_collection: '停止验证',
                start_text_collection: '启动验证',
                open_app: '打开应用',
                back: '返回',
                scroll: '下滑',
                tap: '点击',
                click_text: '点击文字',
                set_text: '输入文本',
                ime_replace_text: '输入文本'
            }[String(type || '')] || String(type || '未知动作');
        }

        function formatMobileStatus(status) {
            return {
                pending: '待执行',
                running: '执行中',
                succeeded: '已完成',
                success: '已完成',
                failed: '失败',
                aborted: '已中止'
            }[String(status || '')] || String(status || '未知');
        }

        function formatLandmarkCursor(cursor = {}) {
            const entries = Object.entries(cursor || {});
            if (entries.length === 0) {
                return '-';
            }
            return entries.map(([city, value]) => `${city}:${value}`).join(' ');
        }

        function summarizeCommandResult(command = {}) {
            const result = command.result && typeof command.result === 'object' ? command.result : null;
            if (!result) {
                return '';
            }
            if (result.message) {
                return result.message;
            }
            if (result.rowCount !== undefined) {
                return `识别 ${result.rowCount} 行可见文本`;
            }
            if (result.city || result.keyword) {
                return [result.city, result.keyword, result.timedOut ? '已超时停止' : '执行完成'].filter(Boolean).join(' ｜ ');
            }
            const status = result.deviceStatus || result;
            if (status.currentPackageName || status.visibleTextRowCount !== undefined) {
                return `${status.currentPackageName || '-'} · 可见文本 ${status.visibleTextRowCount ?? 0}`;
            }
            return '';
        }

        function findLatestDeviceStatus(commands = []) {
            for (const command of commands) {
                const result = command?.result && typeof command.result === 'object' ? command.result : null;
                if (!result) {
                    continue;
                }
                if (result.deviceStatus && typeof result.deviceStatus === 'object') {
                    return result.deviceStatus;
                }
                if (result.deviceId || result.serverUrl || result.commandServiceRunning !== undefined) {
                    return result;
                }
            }
            return null;
        }

        function renderOverview(workflows = [], commands = [], devices = []) {
            const container = byId('mobileOverviewTiles');
            if (!container) {
                return;
            }
            const safeWorkflows = Array.isArray(workflows) ? workflows : [];
            const safeCommands = Array.isArray(commands) ? commands : [];
            const runningWorkflow = safeWorkflows.find(workflow => workflow.status === 'running');
            const activeCommand = safeCommands.find(command => ['pending', 'running'].includes(command.status));
            const latestCommand = safeCommands[0] || null;
            const latestDevice = Array.isArray(devices) ? devices[0] : null;
            const historicalStatus = findLatestDeviceStatus(safeCommands);
            const deviceStatus = historicalStatus || latestDevice;
            const deviceOnline = latestDevice?.online === true;
            const deviceDetail = deviceStatus
                ? `${deviceStatus.currentPackageName || latestDevice?.platform || '-'} · ${deviceOnline ? `可见文本 ${deviceStatus.visibleTextRowCount ?? 0}` : `最后心跳 ${formatTime(latestDevice?.lastSeenAt)}`}`
                : '点击“刷新设备状态”获取手机端状态';

            const tiles = [
                {
                    label: '设备状态',
                    value: latestDevice ? (deviceOnline ? '在线' : '离线') : '待刷新',
                    detail: deviceDetail
                },
                {
                    label: '当前任务',
                    value: runningWorkflow ? `新增 ${runningWorkflow.progress?.completed || 0}/${runningWorkflow.progress?.total || 0}` : (activeCommand ? formatCommandType(activeCommand.type) : '空闲'),
                    detail: runningWorkflow
                        ? `城市 ${runningWorkflow.cities?.join('、') || '-'} · 剩余 ${runningWorkflow.progress?.remaining ?? 0}`
                        : (activeCommand ? formatMobileStatus(activeCommand.status) : '暂无执行中的任务')
                },
                {
                    label: '同步通道',
                    value: deviceStatus?.deviceSessionId ? '已认证' : (deviceStatus?.serverUrl ? '已配置' : '待确认'),
                    detail: deviceStatus?.serverUrl
                        ? `${deviceStatus.serverUrl}${deviceStatus.relayNode ? ` · ${deviceStatus.relayNode}` : ''}`
                        : '手机端未建立认证会话'
                },
                {
                    label: '最近动作',
                    value: latestCommand ? formatCommandType(latestCommand.type) : '暂无',
                    detail: latestCommand ? `${formatMobileStatus(latestCommand.status)} · ${latestCommand.updatedAt || latestCommand.createdAt || '-'}` : '暂无手机指令'
                }
            ];

            container.innerHTML = tiles.map(tile => `
                <div class="mobile-overview-tile">
                    <span>${escapeHtml(tile.label)}</span>
                    <strong>${escapeHtml(tile.value)}</strong>
                    <small>${escapeHtml(tile.detail)}</small>
                </div>
            `).join('');
        }

        function renderWorkflows(workflows = []) {
            const container = byId('mobileWorkflowList');
            if (!container) {
                return;
            }
            container.innerHTML = '';
            (Array.isArray(workflows) ? workflows : []).slice(0, 8).forEach(workflow => {
                const card = documentRef.createElement('div');
                card.className = 'task-progress-card';
                const cities = Array.isArray(workflow.cities) ? workflow.cities : [];
                const cityIndex = Number(workflow.currentCityIndex) || 0;
                const currentCity = cities[cityIndex] || '';
                const targetText = cities.map(city => {
                    const stats = workflow.currentStats?.[city] || {};
                    const baseline = Number(stats.baselineRecords ?? workflow.baselines?.[city]?.total ?? 0);
                    const added = Number(stats.addedSnapshots ?? stats.addedRecords ?? 0);
                    const targetIncrement = Number(stats.targetIncrement ?? workflow.targetIncrement ?? 0);
                    const distinct = Number(stats.distinct ?? workflow.baselines?.[city]?.distinct ?? 0);
                    return `${city} 新增 ${added}/${targetIncrement}（当前快照 ${baseline + added}，去重场站 ${distinct}）`;
                }).join(' ｜ ');
                const progress = workflow.progress || {};
                const percent = Math.max(0, Math.min(100, Number(progress.percent) || 0));
                card.innerHTML = `
                    <div class="task-progress-head">
                        <div class="task-progress-title">${escapeHtml(cities.join('、') || workflow.id || '-')}</div>
                        <div class="task-progress-status ${escapeHtml(workflow.status || '')}">${escapeHtml(formatMobileStatus(workflow.status))}</div>
                    </div>
                    <div class="task-progress-bar">
                        <span class="task-progress-seg success" style="width:${percent}%;"></span>
                    </div>
                    <div class="task-progress-metrics">
                        <div class="task-progress-metric"><strong>${escapeHtml(progress.completed ?? 0)}</strong><span>已新增快照</span></div>
                        <div class="task-progress-metric"><strong>${escapeHtml(progress.remaining ?? 0)}</strong><span>剩余</span></div>
                        <div class="task-progress-metric"><strong>${escapeHtml(currentCity || '完成')}</strong><span>当前城市</span></div>
                        <div class="task-progress-metric"><strong>${escapeHtml(formatLandmarkCursor(workflow.landmarkCursor || {}))}</strong><span>地标游标</span></div>
                    </div>
                    <div class="task-progress-meta">
                        <span>每城新增快照 ${escapeHtml(workflow.targetIncrement || 0)}</span>
                        <span>${escapeHtml(targetText || '暂无目标')}</span>
                    </div>
                    ${workflow.error ? `<div class="meta-hint" style="color:var(--danger);">${escapeHtml(workflow.error)}</div>` : ''}
                `;
                container.appendChild(card);
            });
        }

        function renderCommands(commands = []) {
            const container = byId('mobileCommandList');
            if (!container) {
                return;
            }
            container.innerHTML = '';
            (Array.isArray(commands) ? commands : []).slice(0, 12).forEach(command => {
                const entry = documentRef.createElement('div');
                const tone = command.status === 'succeeded'
                    ? 'success'
                    : command.status === 'failed' || command.status === 'aborted'
                        ? 'error'
                        : command.status === 'running'
                            ? 'warn'
                            : 'info';
                entry.className = `mobile-command-card ${tone}`;
                const payload = command.payload && typeof command.payload === 'object' ? command.payload : {};
                let coordinateSummary = '';
                if (command.type === 'set_mock_location' && Number.isFinite(Number(payload.lat)) && Number.isFinite(Number(payload.lng))) {
                    const inputLat = Number(payload.inputLat ?? payload.lat);
                    const inputLng = Number(payload.inputLng ?? payload.lng);
                    const inputSystem = payload.inputCoordinateSystem || payload.coordinateSystem || '';
                    coordinateSummary = Number.isFinite(inputLat) && Number.isFinite(inputLng)
                        ? `${formatPresetCoordinate(inputLat)}, ${formatPresetCoordinate(inputLng)} ${inputSystem}`.trim()
                        : `${formatPresetCoordinate(Number(payload.lat))}, ${formatPresetCoordinate(Number(payload.lng))}`;
                    if (payload.coordinateTransform && payload.coordinateTransform !== 'NONE') {
                        coordinateSummary += ` -> WGS84 ${formatPresetCoordinate(Number(payload.lat))}, ${formatPresetCoordinate(Number(payload.lng))}`;
                    }
                }
                const summary = [payload.city, payload.keyword, coordinateSummary, payload.instruction].filter(Boolean).join(' ｜ ');
                const resultSummary = summarizeCommandResult(command);
                entry.innerHTML = `
                    <div class="mobile-command-title">
                        <span>${escapeHtml(formatCommandType(command.type))}</span>
                        <span class="mobile-status-chip ${escapeHtml(command.status || '')}">${escapeHtml(formatMobileStatus(command.status))}</span>
                    </div>
                    <div class="meta-hint">${escapeHtml(command.updatedAt || command.createdAt || '')}</div>
                    ${summary ? `<div class="meta-hint">${escapeHtml(summary)}</div>` : ''}
                    ${resultSummary ? `<div class="meta-hint">${escapeHtml(resultSummary)}</div>` : ''}
                    ${command.error ? `<div class="meta-hint" style="color:var(--danger);">${escapeHtml(command.error)}</div>` : ''}
                `;
                container.appendChild(entry);
            });
        }

        return {
            findLatestDeviceStatus,
            formatCommandType,
            formatLandmarkCursor,
            formatMobileStatus,
            renderCommands,
            renderOverview,
            renderWorkflows,
            summarizeCommandResult
        };
    }

    global.MobileControlBoard = { createController };
})(window);
