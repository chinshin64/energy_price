(function attachSecurityReportControl(global) {
    'use strict';

    function requireDependency(deps, name) {
        const value = deps[name];
        if (!value) {
            throw new Error(`Security report dependency missing: ${name}`);
        }
        return value;
    }

    function createController(deps = {}) {
        const documentRef = deps.document || global.document;
        const escapeHtml = requireDependency(deps, 'escapeHtml');
        const formatTime = requireDependency(deps, 'formatTime');
        const setElementText = requireDependency(deps, 'setElementText');
        const setStatusBannerState = requireDependency(deps, 'setStatusBannerState');
        const getState = requireDependency(deps, 'getState');
        const isAiFeaturesEnabled = deps.isAiFeaturesEnabled || (() => false);
        const serviceBase = deps.serviceBase || '/api';

        function byId(id) {
            return documentRef.getElementById(id);
        }

        function state() {
            return getState() || {};
        }

        function normalizeSecurityReportStatus(value) {
            const key = String(value || '').trim().toLowerCase();
            const labels = {
                partial: '部分通过',
                passed: '已通过',
                success: '已通过',
                failed: '失败',
                pending: '待处理',
                'pending-retest': '待复测',
                'in-progress': '进行中',
                running: '进行中',
                none: '无需复测',
                draft: '草稿',
                complete: '完整',
                completed: '已完成',
                finalized: '已完成',
                incomplete: '不完整',
                unknown: '未知'
            };
            return labels[key] || String(value || '').trim();
        }

        function normalizeRiskLevelLabel(value) {
            const key = String(value || '').trim().toLowerCase();
            const labels = {
                critical: '严重',
                high: '高',
                medium: '中',
                low: '低',
                none: '无',
                unknown: '未知'
            };
            return labels[key] || String(value || '未知').trim();
        }

        function normalizeEvidenceCompletenessLabel(value) {
            const key = String(value || '').trim().toLowerCase();
            const labels = {
                complete: '完整',
                full: '完整',
                partial: '部分完整',
                incomplete: '不完整',
                pending: '待补齐',
                unknown: '未知'
            };
            return labels[key] || String(value || '未知').trim();
        }

        function getSecurityReportId(report = {}) {
            return String(report.reportId || report.id || '').trim();
        }

        function getSecurityReportTargetName(report = {}) {
            if (report.target && typeof report.target === 'object') {
                return report.target.name || report.targetName || '';
            }
            return report.target || report.targetName || '';
        }

        function getSecurityReportScope(report = {}) {
            if (report.scope) {
                return report.scope;
            }
            if (report.target && typeof report.target === 'object') {
                return report.target.scope || '';
            }
            return '';
        }

        function getSecurityReportMethods(report = {}) {
            const methods = Array.isArray(report.methods) ? report.methods : [];
            return methods.map(item => {
                if (typeof item === 'string') {
                    return item;
                }
                return item?.name || item?.id || '';
            }).filter(Boolean);
        }

        function getSecurityReportCities(report = {}) {
            const target = report.target && typeof report.target === 'object' ? report.target : {};
            const cities = Array.isArray(target.cities) ? target.cities : [];
            return cities.join('、') || getSecurityReportScope(report);
        }

        function getSecurityReportExecutor(report = {}) {
            const executor = report.executor;
            if (!executor) {
                return report.owner || '-';
            }
            if (typeof executor === 'string') {
                return executor;
            }
            return executor.name || executor.role || '-';
        }

        function getSecurityReportDownloadUrl(report = {}, format = 'markdown') {
            const id = getSecurityReportId(report);
            const downloads = report.downloads || {};
            const directUrl = downloads[format] || (format === 'markdown' ? downloads.md : '');
            if (directUrl) {
                const withSanitize = directUrl.includes('sanitize=')
                    ? directUrl
                    : `${directUrl}${directUrl.includes('?') ? '&' : '?'}sanitize=true`;
                if (/^https?:\/\//i.test(directUrl)) {
                    return withSanitize;
                }
                if (directUrl.startsWith('/')) {
                    const apiBaseUrl = new URL(serviceBase, global.location.origin);
                    return apiBaseUrl.origin === global.location.origin
                        ? withSanitize
                        : `${apiBaseUrl.origin}${withSanitize}`;
                }
                return withSanitize;
            }
            return `${serviceBase}/blue-team/reports/${encodeURIComponent(id)}/download?format=${encodeURIComponent(format)}&sanitize=true`;
        }

        function normalizeSecurityReport(rawReport = {}, source = state().securityReportSource || 'fallback') {
            const id = getSecurityReportId(rawReport);
            const title = rawReport.title || rawReport.reportName || id || '未命名报告';
            const targetName = getSecurityReportTargetName(rawReport) || '-';
            const scope = getSecurityReportScope(rawReport) || '-';
            const riskLevelLabel = rawReport.riskLevelLabel || normalizeRiskLevelLabel(rawReport.riskLevel);
            const statusText = rawReport.status
                || rawReport.retest?.statusLabel
                || normalizeSecurityReportStatus(rawReport.retestStatus || rawReport.overallStatus)
                || '-';
            const evidenceCompletenessLabel = normalizeEvidenceCompletenessLabel(rawReport.evidenceCompleteness);
            const methodNames = getSecurityReportMethods(rawReport);

            return {
                ...rawReport,
                id,
                reportId: id,
                title,
                reportName: rawReport.reportName || title,
                targetName,
                scope,
                riskLevelLabel,
                statusText,
                evidenceCompletenessLabel,
                methodText: methodNames.join(' / ') || rawReport.method || '-',
                cityText: getSecurityReportCities(rawReport) || '-',
                executorText: getSecurityReportExecutor(rawReport),
                source
            };
        }

        function getFallbackSecurityReports(fallbackReports = state().fallbackReports || []) {
            return fallbackReports.map(report => normalizeSecurityReport(report, 'fallback')).filter(report => report.id);
        }

        function getSecurityReportItems() {
            const current = state();
            return current.securityReportItems?.length > 0
                ? current.securityReportItems
                : getFallbackSecurityReports(current.fallbackReports || []);
        }

        function setSecurityReportStatus(message, tone = 'warn') {
            setStatusBannerState(byId('securityReportsSourceStatus'), message, tone);
        }

        function getSecurityReportById(reportId) {
            const current = state();
            const reports = getSecurityReportItems();
            return current.securityReportDetailCache?.get(reportId)
                || reports.find(report => report.id === reportId)
                || reports[0]
                || normalizeSecurityReport((current.fallbackReports || [])[0], 'fallback');
        }

        function getSecurityReportEvidenceStats() {
            const rows = Array.isArray(state().captureEvidenceRows) ? state().captureEvidenceRows : [];
            const successCount = rows.filter(row => row?.success).length;
            const failedCount = rows.filter(row => row && !row.success).length;
            const latest = rows.find(row => row?.createdAt) || null;
            const chains = new Set(rows.map(row => row?.chain || row?.evidenceType).filter(Boolean));
            return {
                total: rows.length,
                successCount,
                failedCount,
                latestAt: latest?.createdAt || '',
                chainCount: chains.size
            };
        }

        function renderSecurityReportList() {
            const listEl = byId('securityReportList');
            if (!listEl) {
                return;
            }
            const current = state();
            const stats = getSecurityReportEvidenceStats();
            setStatusBannerState(
                byId('securityReportsSourceStatus'),
                current.securityReportStatusMessage,
                current.securityReportStatusTone
            );
            listEl.innerHTML = getSecurityReportItems().map(report => {
                const latestText = stats.latestAt ? `最近证据：${formatTime(stats.latestAt)}` : '最近证据：暂无';
                return `
                    <button class="security-report-row" type="button" data-report-id="${escapeHtml(report.id)}">
                        <span>${escapeHtml(formatTime(report.createdAt))}</span>
                        <span class="report-row-title">
                            <strong>${escapeHtml(report.title)}</strong>
                            <small>${escapeHtml(report.targetName)} / ${escapeHtml(report.scope)}</small>
                        </span>
                        <span>风险等级：${escapeHtml(report.riskLevelLabel)}</span>
                        <span>${escapeHtml(report.statusText)}<br><small>${escapeHtml(latestText)}</small></span>
                        <span class="report-row-action">查看详情</span>
                    </button>
                `;
            }).join('');
            renderProductReadinessPanel();
        }

        function renderReportField(label, value, hint = '') {
            return `
                <div class="report-field">
                    <span>${escapeHtml(label)}</span>
                    <strong>${escapeHtml(value || '-')}</strong>
                    <small>${escapeHtml(hint || '-')}</small>
                </div>
            `;
        }

        function getRuntimeEnvironmentLabel() {
            const host = String(global.location.hostname || '').trim();
            if (!host || host === 'localhost' || host === '127.0.0.1' || host === '::1') {
                return '本地环境';
            }
            return '部署环境';
        }

        function renderReadinessCheckRow(label, value, hint = '', tone = '') {
            const badgeClass = tone ? ` ${tone}` : '';
            return `
                <div class="readiness-check-row">
                    <strong>${escapeHtml(label)}</strong>
                    <small>${escapeHtml(hint || '-')}</small>
                    <span class="report-badge${badgeClass}">${escapeHtml(value || '-')}</span>
                </div>
            `;
        }

        function isPendingStatus(value) {
            const text = String(value || '').toLowerCase();
            return Boolean(text.includes('待') || text.includes('partial') || text.includes('pending') || text.includes('部分'));
        }

        function renderProductReadinessPanel() {
            const statusEl = byId('productReadinessStatus');
            const gridEl = byId('productReadinessGrid');
            const checklistEl = byId('productReadinessChecklist');
            if (!statusEl || !gridEl || !checklistEl) {
                return;
            }

            const current = state();
            const reports = getSecurityReportItems();
            const report = getSecurityReportById(current.activeSecurityReportId);
            const stats = getSecurityReportEvidenceStats();
            const apiConnected = current.securityReportSource === 'api';
            const recorderKnown = current.captureRecorderSnapshot !== null;
            const recorderAvailable = Boolean(current.captureRecorderSnapshot?.available);
            const retestText = report.retest?.statusLabel || normalizeSecurityReportStatus(report.retestStatus);
            const retestPending = isPendingStatus(retestText || report.conclusion || report.overallStatus);
            const envLabel = getRuntimeEnvironmentLabel();
            const aiEnabled = isAiFeaturesEnabled();
            const currentHost = String(global.location.host || '-');
            const reportCountText = `${reports.length} 份报告`;
            const evidenceText = stats.total > 0
                ? `${stats.total} 条请求证据，成功 ${stats.successCount}，失败 ${stats.failedCount}`
                : '暂无请求证据';
            const recorderText = recorderKnown
                ? (recorderAvailable ? '请求记录服务可用' : '请求记录服务不可用')
                : '请求记录状态待加载';
            const summaryTone = !apiConnected || retestPending || !recorderAvailable ? 'warn' : 'success';
            const summaryText = apiConnected
                ? `当前报告来自报告服务，${evidenceText}。${retestPending ? '仍需完成复测闭环。' : '复测闭环已满足。'}`
                : `当前使用本地样例兜底，${evidenceText}。需接入报告服务后再验收。`;

            setStatusBannerState(statusEl, summaryText, summaryTone);
            gridEl.innerHTML = [
                renderReportField(
                    '产品视角',
                    apiConnected ? '报告流可用' : '样例兜底',
                    `${reportCountText} / ${report.evidenceCompletenessLabel || '-'}`
                ),
                renderReportField(
                    '用户视角',
                    stats.total > 0 ? '可查证据' : '待补证据',
                    `列表、详情、下载${apiConnected ? '已接服务' : '使用样例'}`
                ),
                renderReportField(
                    '研发视角',
                    `${envLabel} / ${apiConnected ? '报告服务已通' : '报告服务未通'}`,
                    `${recorderText} / 智能诊断${aiEnabled ? '已启用' : '计划态'}`
                )
            ].join('');

            checklistEl.innerHTML = [
                renderReadinessCheckRow(
                    '报告归档',
                    apiConnected ? '已接入' : '待接入',
                    `${report.title || '-'} / ${reportCountText}`,
                    apiConnected ? 'success' : 'warn'
                ),
                renderReadinessCheckRow(
                    '证据链',
                    stats.total > 0 ? '有数据' : '待补齐',
                    evidenceText,
                    stats.total > 0 ? 'success' : 'warn'
                ),
                renderReadinessCheckRow(
                    '复测闭环',
                    retestText || '-',
                    report.conclusion || normalizeSecurityReportStatus(report.overallStatus) || '-',
                    retestPending ? 'warn' : 'success'
                ),
                renderReadinessCheckRow(
                    '部署环境',
                    envLabel,
                    envLabel === '本地环境'
                        ? '当前为本地验收'
                        : `当前访问 ${currentHost}`,
                    envLabel === '本地环境' ? 'warn' : 'success'
                ),
                renderReadinessCheckRow(
                    'AI / 手机指令',
                    aiEnabled ? 'AI 已启用' : '规则解析',
                    aiEnabled ? 'DCC/AI 可参与解析' : 'AI 未启用，手机指令走内置规则解析',
                    aiEnabled ? 'success' : 'warn'
                )
            ].join('');
        }

        function getReportBadgeTone(value) {
            const text = String(value || '').toLowerCase();
            if (text.includes('fail') || text.includes('error') || text.includes('不完整') || text.includes('失败')) {
                return 'error';
            }
            if (text.includes('partial') || text.includes('pending') || text.includes('待') || text.includes('部分')) {
                return 'warn';
            }
            return '';
        }

        function renderSecurityReportSummary(report) {
            const grid = byId('securityReportSummaryGrid');
            if (!grid) {
                return;
            }
            const target = report.target && typeof report.target === 'object' ? report.target : {};
            const retestText = report.retest?.statusLabel || normalizeSecurityReportStatus(report.retestStatus);
            const business = report.businessSummary || {};
            const result = business.resultSummary || {};
            const cost = business.costSummary || {};
            const conclusion = business.conclusionSummary || {};
            grid.innerHTML = [
                renderReportField('测试方式', business.methodSummary?.title || report.methodText, business.methodSummary?.description || '按授权范围执行蓝军验证'),
                renderReportField('资源成本', cost.label || '成本待统计', cost.tokenUsage?.totalTokens ? `${cost.tokenUsage.totalTokens} tokens` : '按人力估算'),
                renderReportField('测试结果', result.label || '-', result.successRate != null ? `成功率 ${result.successRate}%` : '-'),
                renderReportField('数据产出', `${result.dataRecords ?? 0} 条`, result.evidenceFileCount != null ? `证据 ${result.evidenceFileCount} 份` : '-'),
                renderReportField('城市范围', report.cityText, target.radiusKm ? `${target.radiusKm}km` : report.scope),
                renderReportField('当前结论', conclusion.conclusion || report.conclusion || normalizeSecurityReportStatus(report.overallStatus), conclusion.nextAction || retestText || '-'),
                renderReportField('风险等级', report.riskLevelLabel, report.riskLevel || '-'),
                renderReportField('测试对象', report.targetName, target.businessLine || target.platform || '-')
            ].join('');
        }

        function renderSecurityReportExploitRisk(report) {
            const grid = byId('securityReportExploitRiskGrid');
            if (!grid) {
                return;
            }
            const risk = report.exploitableRisk || {};
            const cost = risk.exploitCost || {};
            if (!risk.summary) {
                grid.innerHTML = renderReportField('可利用性', '待补充', '当前报告未记录可利用风险与利用成本');
                return;
            }
            grid.innerHTML = [
                renderReportField('可利用性', risk.exploitability || '-', risk.summary || '-'),
                renderReportField('前置条件', Array.isArray(risk.prerequisites) ? risk.prerequisites.join('、') : risk.prerequisites, '缺少前置条件时不判定为可复现'),
                renderReportField('可达能力', Array.isArray(risk.availableCapabilities) ? risk.availableCapabilities.join('、') : risk.availableCapabilities, risk.businessImpact || '-'),
                renderReportField('已有限制', Array.isArray(risk.limitations) ? risk.limitations.join('、') : risk.limitations, '报告不提供绕过限制的做法'),
                renderReportField('模型成本', cost.tokenLabel || '-', cost.modelUsageNote || '-'),
                renderReportField('人力成本', cost.humanCostLabel || '-', cost.totalCostLabel || '-')
            ].join('');
        }

        function renderSecurityReportExecutionProcedure(report) {
            const list = byId('securityReportExecutionProcedure');
            if (!list) {
                return;
            }
            const procedure = report.executionProcedure || {};
            const steps = Array.isArray(procedure.steps) ? procedure.steps : [];
            if (steps.length === 0) {
                list.innerHTML = '<div class="finding-card"><p>当前报告未记录具体执行过程。</p></div>';
                return;
            }
            list.innerHTML = steps.map(step => `
                <div class="finding-card">
                    <header>
                        <span class="severity-chip low">${escapeHtml(String(step.order || '-'))}</span>
                        <h3>${escapeHtml(step.name || step.phase || '未命名步骤')}</h3>
                    </header>
                    <p><strong>输入材料：</strong>${escapeHtml(Array.isArray(step.inputs) ? step.inputs.join('、') : (step.inputs || '-'))}</p>
                    <p><strong>执行方式：</strong>${escapeHtml(step.action || '-')}</p>
                    <p><strong>输出结果：</strong>${escapeHtml(step.output || step.result || '-')}</p>
                    <p><strong>校验方式：</strong>${escapeHtml(Array.isArray(step.validation) ? step.validation.join('、') : (step.validation || '-'))}</p>
                    <p><strong>安全边界：</strong>${escapeHtml(step.boundary || '-')}</p>
                </div>
            `).join('');
        }

        function renderSecurityReportStatusRow(report) {
            const row = byId('securityReportStatusRow');
            if (!row) {
                return;
            }
            const badges = [
                `结论：${report.conclusion || normalizeSecurityReportStatus(report.overallStatus) || '-'}`,
                `证据：${report.evidenceCompletenessLabel}`,
                `范围：${report.scope || '-'}`,
                `复测：${report.retest?.statusLabel || normalizeSecurityReportStatus(report.retestStatus) || '-'}`
            ];
            row.innerHTML = badges.map(label => {
                const tone = getReportBadgeTone(label);
                return `<span class="report-badge${tone ? ` ${tone}` : ''}">${escapeHtml(label)}</span>`;
            }).join('');
        }

        function getFindingEvidenceText(finding = {}) {
            if (Array.isArray(finding.evidenceRefs) && finding.evidenceRefs.length > 0) {
                return finding.evidenceRefs.map(item => {
                    if (typeof item === 'string') {
                        return item;
                    }
                    return item?.label || item?.type || '';
                }).filter(Boolean).join(' / ');
            }
            const reproductionRefs = Array.isArray(finding.reproduction?.evidenceRefs) ? finding.reproduction.evidenceRefs : [];
            return reproductionRefs.map(item => item?.label || item?.type || '').filter(Boolean).join(' / ') || '-';
        }

        function renderSecurityReportFindings(report) {
            const list = byId('securityReportFindingsList');
            if (!list) {
                return;
            }
            const findings = Array.isArray(report.findings) ? report.findings : [];
            if (findings.length === 0) {
                list.innerHTML = '<div class="finding-card"><p>暂无风险发现。</p></div>';
                return;
            }
            list.innerHTML = findings.map(finding => {
                const severity = String(finding.severity || '').toLowerCase();
                const severityClass = ['high', 'medium', 'low'].includes(severity) ? severity : 'medium';
                const title = [finding.id, finding.title].filter(Boolean).join(' ');
                const status = finding.retestStatus || finding.status || '-';
                const statusLabel = status === 'pending' ? '待复测' : normalizeSecurityReportStatus(status) || status;
                const evidence = getFindingEvidenceText(finding);
                return `
                    <div class="finding-card">
                        <header>
                            <span class="severity-chip ${escapeHtml(severityClass)}">${escapeHtml(finding.severityLabel || normalizeRiskLevelLabel(finding.severity))}</span>
                            <h3>${escapeHtml(title || '未命名发现')}</h3>
                        </header>
                        <p><strong>状态：</strong>${escapeHtml(statusLabel)}。<strong>证据：</strong>${escapeHtml(evidence)}。</p>
                    </div>
                `;
            }).join('');
        }

        function renderSecurityReportEvidenceMatrix(report) {
            const body = byId('securityReportEvidenceMatrixBody');
            if (!body) {
                return;
            }
            const rows = Array.isArray(report.evidenceMatrix) ? report.evidenceMatrix : [];
            if (rows.length === 0) {
                body.innerHTML = '<tr><td colspan="3" style="text-align:center; padding:32px;">暂无证据矩阵。</td></tr>';
                return;
            }
            body.innerHTML = rows.map(row => `
                <tr>
                    <td>${escapeHtml(row.type || row.evidenceType || '-')}</td>
                    <td>${escapeHtml(normalizeEvidenceCompletenessLabel(row.status) || normalizeSecurityReportStatus(row.status) || row.status || '-')}</td>
                    <td>${escapeHtml(row.purpose || (Array.isArray(row.refs) ? row.refs.join(' / ') : row.refs) || '-')}</td>
                </tr>
            `).join('');
        }

        function renderSecurityReportRetest(report) {
            const grid = byId('securityReportRetestGrid');
            if (!grid) {
                return;
            }
            const criteria = Array.isArray(report.retest?.criteria) ? report.retest.criteria : [];
            const methods = Array.isArray(report.methods) ? report.methods : [];
            const fields = [
                renderReportField('复测状态', report.retest?.statusLabel || normalizeSecurityReportStatus(report.retestStatus), report.retest?.status || '-'),
                renderReportField('测试方式', report.methodText, methods.map(item => normalizeSecurityReportStatus(item?.status)).filter(Boolean).join(' / ') || '-'),
                renderReportField('入库 / 归档', report.files?.json || 'report.json', report.files?.markdown || 'report.md'),
                renderReportField('复测标准', criteria[0] || '可复核', criteria.slice(1).join('；') || '待确认')
            ];
            grid.innerHTML = fields.join('');
        }

        function renderSecurityReportDownloads(report) {
            const markdownBtn = byId('downloadSecurityReportMarkdownBtn');
            const jsonBtn = byId('downloadSecurityReportJsonBtn');
            if (markdownBtn) {
                markdownBtn.href = getSecurityReportDownloadUrl(report, 'markdown');
            }
            if (jsonBtn) {
                jsonBtn.href = getSecurityReportDownloadUrl(report, 'json');
            }
        }

        function renderSecurityReportDetailHeader(reportId = state().activeSecurityReportId, detailStatusMessage = '', detailStatusTone = '') {
            const report = getSecurityReportById(reportId);
            const stats = getSecurityReportEvidenceStats();
            const evidenceText = stats.total > 0
                ? `原始请求证据 ${stats.total} 条，成功 ${stats.successCount} 条，失败 ${stats.failedCount} 条，链路 ${stats.chainCount} 类`
                : '原始请求证据暂无数据';
            setElementText('securityReportDetailTitle', report.title);
            setElementText(
                'securityReportDetailMeta',
                `${formatTime(report.createdAt)} ｜ ${report.targetName} ｜ ${report.scope} ｜ ${evidenceText}`
            );
            renderSecurityReportSummary(report);
            renderSecurityReportExploitRisk(report);
            renderSecurityReportStatusRow(report);
            renderSecurityReportExecutionProcedure(report);
            renderSecurityReportFindings(report);
            renderSecurityReportEvidenceMatrix(report);
            renderSecurityReportRetest(report);
            renderSecurityReportDownloads(report);
            setStatusBannerState(
                byId('securityReportDetailStatus'),
                detailStatusMessage || (report.source === 'api' ? '报告详情已加载' : '报告详情使用本地样例。'),
                detailStatusTone || (report.source === 'api' ? 'success' : 'warn')
            );
            renderProductReadinessPanel();
        }

        function showSecurityReportList() {
            renderSecurityReportList();
            const listView = byId('securityReportListView');
            const detailView = byId('securityReportDetailView');
            if (detailView) detailView.hidden = true;
            if (listView) listView.hidden = false;
        }

        return {
            getFallbackSecurityReports,
            getFindingEvidenceText,
            getReportBadgeTone,
            getRuntimeEnvironmentLabel,
            getSecurityReportById,
            getSecurityReportCities,
            getSecurityReportDownloadUrl,
            getSecurityReportEvidenceStats,
            getSecurityReportExecutor,
            getSecurityReportId,
            getSecurityReportItems,
            getSecurityReportMethods,
            getSecurityReportScope,
            getSecurityReportTargetName,
            isPendingStatus,
            normalizeEvidenceCompletenessLabel,
            normalizeRiskLevelLabel,
            normalizeSecurityReport,
            normalizeSecurityReportStatus,
            renderProductReadinessPanel,
            renderReadinessCheckRow,
            renderReportField,
            renderSecurityReportDetailHeader,
            renderSecurityReportDownloads,
            renderSecurityReportEvidenceMatrix,
            renderSecurityReportExecutionProcedure,
            renderSecurityReportExploitRisk,
            renderSecurityReportFindings,
            renderSecurityReportList,
            renderSecurityReportRetest,
            renderSecurityReportStatusRow,
            renderSecurityReportSummary,
            setSecurityReportStatus,
            showSecurityReportList
        };
    }

    global.SecurityReportControl = { createController };
})(window);
