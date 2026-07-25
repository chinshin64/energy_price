(function attachOperationsGovernanceControl(global) {
    'use strict';

    function createController(deps = {}) {
        const documentRef = deps.document || global.document;
        const fetchRef = deps.fetch || global.fetch.bind(global);
        const escapeHtml = deps.escapeHtml;
        const serviceBase = deps.serviceBase;
        const setStatusBannerState = deps.setStatusBannerState;
        const formatUserReason = deps.formatUserReason || (value => value || '-');
        const formatTime = deps.formatTime || (value => value || '-');
        const confirmAction = deps.confirm || global.confirm.bind(global);
        let eventsBound = false;

        function byId(id) {
            return documentRef.getElementById(id);
        }

        async function request(path, options = {}) {
            const response = await fetchRef(`${serviceBase}${path}`, {
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
                ...options
            });
            const result = await response.json();
            if (!response.ok || !result.success) {
                throw new Error(result.error || result.code || '系统治理服务请求失败');
            }
            return result;
        }

        function runStatusLabel(status, reason) {
            if (status === 'success') return '验证通过';
            if (status === 'failed') return `验证失败：${formatUserReason(reason, { includeTech: false })}`;
            return '尚未验证';
        }

        function renderPlatformHealth(diagnostics = [], health = [], refreshStatus = {}) {
            const body = byId('platformHealthTableBody');
            if (!body) return;
            const diagnosticsMap = new Map(diagnostics.map(item => [item.platform, item]));
            const supported = new Set(refreshStatus.supportedPlatforms || []);
            const rateLimits = refreshStatus.rateLimits || {};
            if (!health.length) {
                body.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:28px;">暂无平台健康数据</td></tr>';
                return;
            }
            body.innerHTML = health.map(item => {
                const diagnostic = diagnosticsMap.get(item.platform) || {};
                const remaining = rateLimits[item.platform]?.remainingToday;
                const canRefresh = supported.has(item.platform) && Number(remaining) > 0;
                return `
                    <tr>
                        <td>${escapeHtml(item.name || item.platform)}</td>
                        <td>${diagnostic.activeListTemplates || 0}/${diagnostic.activeDetailTemplates || 0}</td>
                        <td>${escapeHtml(runStatusLabel(diagnostic.latestRunStatus, diagnostic.latestRunReason))}</td>
                        <td><span class="status-pill ${item.status === 'green' ? 'success' : 'warn'}">${escapeHtml(item.statusMessage || item.status || '-')}</span></td>
                        <td>${escapeHtml(formatTime(item.latestTimestamp))}</td>
                        <td>${remaining === undefined ? '-' : escapeHtml(String(remaining))}</td>
                        <td><button class="btn btn-secondary" type="button" data-signature-refresh-platform="${escapeHtml(item.platform)}" ${canRefresh ? '' : 'disabled'}>刷新材料</button></td>
                    </tr>
                `;
            }).join('');
        }

        function renderAuditEvents(events = []) {
            const body = byId('auditEventTableBody');
            if (!body) return;
            if (!events.length) {
                body.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:28px;">暂无操作审计记录</td></tr>';
                return;
            }
            body.innerHTML = events.map(event => `
                <tr>
                    <td>${escapeHtml(formatTime(event.createdAt))}</td>
                    <td>${escapeHtml(event.actorId || '-')}</td>
                    <td>${escapeHtml(event.action || '-')} · ${escapeHtml(event.resource || '-')}</td>
                    <td>${escapeHtml(event.outcome === 'success' ? '成功' : (event.outcome === 'denied' ? '已拒绝' : event.outcome || '-'))}</td>
                    <td>${escapeHtml(event.requestId || '-')}</td>
                </tr>
            `).join('');
        }

        async function loadPlatformHealth() {
            const status = byId('platformHealthStatus');
            setStatusBannerState(status, '正在刷新平台能力健康...', 'info');
            try {
                const [diagnostics, health, refreshStatus] = await Promise.all([
                    request('/diagnostics/platforms'),
                    request('/signature/health'),
                    request('/signature/refresh/status')
                ]);
                const rows = health.platforms || [];
                renderPlatformHealth(diagnostics.data || [], rows, refreshStatus.data || {});
                const unhealthy = rows.filter(item => item.status !== 'green').length;
                setStatusBannerState(status, `已检查 ${rows.length} 个平台，需处理 ${unhealthy} 个`, unhealthy ? 'warn' : 'success');
            } catch (error) {
                renderPlatformHealth([], [], {});
                setStatusBannerState(status, `平台能力健康读取失败：${error.message}`, 'error');
            }
        }

        async function loadAuditEvents() {
            const status = byId('auditEventStatus');
            setStatusBannerState(status, '正在刷新操作审计...', 'info');
            try {
                const result = await request('/audit/events?limit=20');
                const events = Array.isArray(result.data) ? result.data : [];
                renderAuditEvents(events);
                setStatusBannerState(status, `已加载最近 ${events.length} 条操作记录`, 'success');
            } catch (error) {
                renderAuditEvents([]);
                setStatusBannerState(status, `操作审计读取失败：${error.message}`, 'error');
            }
        }

        async function refreshSignature(platform) {
            if (!confirmAction(`确认刷新“${platform}”的请求材料？该操作会打开受控采集链路。`)) return;
            const status = byId('platformHealthStatus');
            setStatusBannerState(status, '正在刷新请求材料...', 'info');
            try {
                await request(`/signature/refresh/${encodeURIComponent(platform)}`, { method: 'POST', body: '{}' });
                await loadPlatformHealth();
                await loadAuditEvents();
            } catch (error) {
                setStatusBannerState(status, `请求材料刷新失败：${error.message}`, 'error');
            }
        }

        function init() {
            if (!eventsBound) {
                byId('refreshOperationsGovernanceBtn')?.addEventListener('click', loadPlatformHealth);
                byId('refreshAuditEventsBtn')?.addEventListener('click', loadAuditEvents);
                byId('platformHealthTableBody')?.addEventListener('click', event => {
                    const button = event.target.closest('[data-signature-refresh-platform]');
                    if (button) refreshSignature(button.dataset.signatureRefreshPlatform);
                });
                eventsBound = true;
            }
            return Promise.all([loadPlatformHealth(), loadAuditEvents()]);
        }

        return { init, loadPlatformHealth, loadAuditEvents, renderPlatformHealth, renderAuditEvents };
    }

    global.OperationsGovernanceControl = { createController };
})(window);
