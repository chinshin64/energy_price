(function attachCollectionResultControl(global) {
    'use strict';

    function requireDependency(deps, name) {
        const value = deps[name];
        if (!value) {
            throw new Error(`Collection result dependency missing: ${name}`);
        }
        return value;
    }

    function createController(deps = {}) {
        const documentRef = deps.document || global.document;
        const addLog = requireDependency(deps, 'addLog');
        const escapeHtml = requireDependency(deps, 'escapeHtml');
        const formatCaptureStats = requireDependency(deps, 'formatCaptureStats');
        const formatUserReason = requireDependency(deps, 'formatUserReason');

        function byId(id) {
            return documentRef.getElementById(id);
        }

        function formatRequestCollectionImportSummary(importSummary = null) {
            if (!importSummary) {
                return '入库：未执行';
            }
            if (importSummary.enabled === false) {
                return '入库：已跳过';
            }
            if (importSummary.success === false) {
                return `入库：失败 / ${formatUserReason(importSummary.reason || 'har_import_failed', { includeTech: false })}`;
            }
            return [
                `请求文件识别场站数：${importSummary.stationCount || 0}`,
                `成功入库：${importSummary.insertedCount || 0}`,
                `待审核：${importSummary.yellowCount || 0}`,
                `跳过：${importSummary.skippedCount || 0}`,
                `红灯拦截：${importSummary.redCount || 0}`
            ].join('\n');
        }

        function formatRequestCollectionOperationSummary(operation = {}) {
            if (!operation) {
                return '页面操控：未执行';
            }
            const lines = [
                `页面操控：${operation.success ? '完成' : '未通过'}`,
                `原因：${formatUserReason(operation.reason || 'unknown_error', { includeTech: false })}`
            ];
            if (operation.target) {
                lines.push(`目标：${operation.target}`);
            }
            const trace = Array.isArray(operation.trace) ? operation.trace : [];
            trace.slice(0, 8).forEach((item, index) => {
                lines.push(`${index + 1}. ${item.action || '-'} / ${item.success ? '成功' : '失败'} / ${formatUserReason(item.reason || 'unknown_error', { includeTech: false })}`);
            });
            return lines.join('\n');
        }

        function formatRequestCollectionRequestSummary(result = {}) {
            const requests = Array.isArray(result.requests) ? result.requests : [];
            if (requests.length === 0) {
                return '暂无目标业务请求。';
            }
            const lines = [`已记录目标业务请求：${requests.length} 个，仅展示前 20 条`];
            requests.slice(0, 20).forEach((request, index) => {
                lines.push(`${index + 1}. ${request.method || '-'} ${request.host || ''}${request.path || ''}`);
            });
            return lines.join('\n');
        }

        function setPageCollectionTrace(result = {}) {
            const trace = byId('method1ActionTrace');
            if (!trace) {
                return;
            }
            trace.value = result.success
                ? `状态：完成\n动作：${result.action || result.path || ''}\n结果：${formatUserReason(result.reason || 'success', { includeTech: false })}`
                : `状态：失败\n原因：${formatUserReason(result.reason || 'unknown_error', { includeTech: false })}`;
        }

        function renderPreflightChecks(checks = []) {
            checks.forEach(check => {
                const status = String(check.status || 'info');
                const icon = status === 'pass'
                    ? '✅'
                    : status === 'warn'
                        ? '⚠️'
                        : status === 'fail'
                            ? '❌'
                            : 'ℹ️';
                const logType = status === 'pass'
                    ? 'success'
                    : status === 'warn'
                        ? 'warn'
                        : status === 'fail'
                            ? 'error'
                            : 'info';

                addLog(`${icon} ${check.label}: ${check.message}`, logType);
            });
        }

        function renderCaptureAnalysisLog(analysis) {
            if (!analysis) {
                return;
            }
            const fatalStatuses = new Set(['failed', 'missing-business-flow', 'parser-missed-business-flow']);
            const tone = analysis.status === 'success'
                ? 'success'
                : fatalStatuses.has(analysis.status)
                    ? 'error'
                    : 'warn';
            addLog(`自动请求分析: ${analysis.message || analysis.status}`, tone);
            addLog(
                `请求记录 ${analysis.entryCount || 0} 条，场站 ${analysis.stationCount || 0} 个，入库 ${analysis.insertedCount || 0} 条，请求材料 ${analysis.learnedPatternCount || 0}/${analysis.savedTemplateCount || 0}`,
                tone
            );
            if (analysis.businessSignals) {
                const signals = analysis.businessSignals;
                addLog(
                    `滴滴业务请求: 列表 ${signals.didiStationListUrlCount || 0} 条，详情 ${signals.didiGetOneInfoUrlCount || 0} 条，业务响应 ${signals.didiStationBusinessBodyCount || 0} 条`,
                    tone
                );
            }
            if (analysis.captureStats) {
                addLog(`请求记录统计: ${formatCaptureStats(analysis.captureStats, false, analysis.captureDiagnostics)}`, tone);
            }
            if (analysis.captureHealth?.message) {
                addLog(`请求记录诊断: ${analysis.captureHealth.message}`, tone);
            }
        }

        function renderSessionLogs(logs = []) {
            const logContainer = byId('collectionLog');
            if (!logContainer || !Array.isArray(logs) || logs.length === 0) {
                return;
            }

            logContainer.innerHTML = logs.slice().reverse().map(log => {
                const type = String(log.type || 'info').replace(/[^\w-]/g, '') || 'info';
                const time = new Date(log.timestamp).toLocaleTimeString();
                return `
                    <div class="log-entry ${escapeHtml(type)}">
                        <div class="timestamp">${escapeHtml(time)}</div>
                        <div>${escapeHtml(log.message || '')}</div>
                    </div>
                `;
            }).join('');
        }

        return {
            formatRequestCollectionImportSummary,
            formatRequestCollectionOperationSummary,
            formatRequestCollectionRequestSummary,
            renderCaptureAnalysisLog,
            renderPreflightChecks,
            renderSessionLogs,
            setPageCollectionTrace
        };
    }

    global.CollectionResultControl = { createController };
})(window);
