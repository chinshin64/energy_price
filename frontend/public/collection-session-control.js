(function attachCollectionSessionControl(global) {
    'use strict';

    const TERMINAL_STATUSES = new Set(['completed', 'cancelled', 'failed']);

    function requireDependency(deps, name) {
        const value = deps[name];
        if (!value) {
            throw new Error(`Collection session dependency missing: ${name}`);
        }
        return value;
    }

    function createController(deps = {}) {
        const fetchImpl = requireDependency(deps, 'fetch');
        const serviceBase = requireDependency(deps, 'serviceBase');
        const addLog = requireDependency(deps, 'addLog');
        const confirmRef = deps.confirm || global.confirm?.bind(global);
        const getActiveSession = requireDependency(deps, 'getActiveSession');
        const clearActiveSession = requireDependency(deps, 'clearActiveSession');
        const renderCaptureAnalysisLog = requireDependency(deps, 'renderCaptureAnalysisLog');
        const renderSessionLogs = requireDependency(deps, 'renderSessionLogs');
        const setCaptureCollectButtons = requireDependency(deps, 'setCaptureCollectButtons');
        const setPageOcrButtons = requireDependency(deps, 'setPageOcrButtons');
        const loadStats = requireDependency(deps, 'loadStats');
        const loadData = requireDependency(deps, 'loadData');
        if (!confirmRef) {
            throw new Error('Collection session dependency missing: confirm');
        }
        const consoleRef = deps.console || global.console;
        const workflowLabels = deps.workflowLabels || { business: '请求采集' };
        const pollIntervalMs = Math.max(1000, Number(deps.pollIntervalMs) || 5000);
        let sessionPollTimer = null;

        function stopSessionPolling() {
            if (sessionPollTimer) {
                global.clearInterval(sessionPollTimer);
                sessionPollTimer = null;
            }
        }

        async function syncActiveSession() {
            const activeSession = getActiveSession();
            if (!activeSession) {
                return;
            }

            try {
                const response = await fetchImpl(`${serviceBase}/smart-collect/status/${activeSession.sessionId}`);
                const result = await response.json();
                if (!result.success) {
                    return;
                }

                const session = result.data || {};
                renderSessionLogs(session.logs || []);

                if (!TERMINAL_STATUSES.has(session.status)) {
                    return;
                }

                const isPageOcrMode = activeSession.mode === 'page-ocr' || session.options?.collectionMode === 'page-ocr';
                const isFailed = session.status === 'failed';
                stopSessionPolling();
                addLog(
                    isFailed
                        ? `❌ 本次目标自动检索未达成：${session.error || '请求记录 未通过业务包校验'}`
                        : isPageOcrMode
                            ? `📊 本次完成 ${Array.isArray(session.results) ? session.results.length : 0} 组目标 页面识别 检索，识别结果已自动入库`
                            : `📊 本次完成 ${Array.isArray(session.results) ? session.results.length : 0} 组目标自动检索；内置请求记录已自动分析`,
                    isFailed ? 'error' : 'success'
                );
                renderCaptureAnalysisLog(session.captureAnalysis);
                clearActiveSession();
                setCaptureCollectButtons(false);
                setPageOcrButtons(false);
                loadStats();
                loadData();
            } catch (error) {
                consoleRef.error('同步会话状态失败:', error);
            }
        }

        function startSessionPolling() {
            stopSessionPolling();
            sessionPollTimer = global.setInterval(syncActiveSession, pollIntervalMs);
            syncActiveSession();
        }

        async function finishSession() {
            const activeSession = getActiveSession();
            if (!activeSession) {
                return;
            }

            const isPageOcrMode = activeSession.mode === 'page-ocr';
            const confirmMessage = isPageOcrMode
                ? '结束识别后会停止当前自动点击/下滑，并保留已入库的页面识别结果。确定继续吗？'
                : '结束验证后会停止当前自动点击/下滑，并由系统停止请求记录服务、保留请求记录。确定继续吗？';
            if (!confirmRef(confirmMessage)) {
                return;
            }

            try {
                const res = await fetchImpl(`${serviceBase}/smart-collect/finish`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sessionId: activeSession.sessionId })
                });
                const result = await res.json();
                if (result.success) {
                    addLog(
                        isPageOcrMode
                            ? '已发送结束识别请求，正在停止当前动作'
                            : '已发送结束验证请求，正在停止当前动作；系统正在停止请求记录并保留请求记录',
                        'success'
                    );
                    if (result.captureSession?.harPath) {
                        addLog('请求记录已保存', 'info');
                    }
                    renderCaptureAnalysisLog(result.captureAnalysis);
                } else {
                    addLog(`❌ 结束验证失败: ${result.error}`, 'error');
                }
            } catch (error) {
                addLog(`❌ 结束验证请求失败: ${error.message}`, 'error');
            }
        }

        async function cancelSession() {
            const activeSession = getActiveSession();
            if (!activeSession) {
                return;
            }

            if (!confirmRef(`停止验证会立即取消本次任务，并停止当前滑动；${workflowLabels.business}会同步停止请求记录服务。确定继续吗？`)) {
                return;
            }

            try {
                const res = await fetchImpl(`${serviceBase}/smart-collect/cancel`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sessionId: activeSession.sessionId })
                });
                const result = await res.json();

                addLog('已发送停止验证请求，正在终止当前滑动并停止请求记录', 'error');
                if (result.captureSession?.harPath) {
                    addLog('请求记录已保存', 'info');
                }
                renderCaptureAnalysisLog(result.captureAnalysis);
            } catch (error) {
                consoleRef.error('取消失败:', error);
            }
        }

        return {
            cancelSession,
            finishSession,
            startSessionPolling,
            stopSessionPolling,
            syncActiveSession
        };
    }

    global.CollectionSessionControl = { createController };
})(window);
