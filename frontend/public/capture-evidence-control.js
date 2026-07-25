(function attachCaptureEvidenceControl(global) {
    'use strict';

    function requireDependency(deps, name) {
        const value = deps[name];
        if (!value) {
            throw new Error(`Capture evidence dependency missing: ${name}`);
        }
        return value;
    }

    function createController(deps = {}) {
        const documentRef = deps.document || global.document;
        const escapeHtml = requireDependency(deps, 'escapeHtml');
        const formatTime = requireDependency(deps, 'formatTime');
        const setElementText = requireDependency(deps, 'setElementText');
        const setStatusBannerState = requireDependency(deps, 'setStatusBannerState');

        function byId(id) {
            return documentRef.getElementById(id);
        }

        function getEvidenceLimit() {
            const raw = Number(byId('captureEvidenceLimit')?.value || 100);
            if (!Number.isFinite(raw) || raw <= 0) {
                return 100;
            }
            return Math.max(1, Math.min(1000, Math.floor(raw)));
        }

        function renderStatus(data = {}) {
            setElementText('captureProxyEnabled', data.proxyEnabled ? '开启' : '关闭');
            setElementText('captureDefaultProxy', data.defaultProxyUrl || '直连');
            setElementText('captureCityProxyCount', String(Number(data.cityProxyPoolCount) || 0));

            const evidenceDirEl = byId('captureEvidenceDir');
            if (evidenceDirEl) {
                evidenceDirEl.textContent = data.evidenceDir ? '证据已保存' : '';
            }

            const scopeText = [
                data.proxyEnabled ? '网络出口已启用' : '网络出口未启用',
                data.defaultProxyUrl ? `默认网络出口 ${data.defaultProxyUrl}` : '默认直连',
                data.autoCityProxyEnabled ? `城市网络出口 ${Number(data.cityProxyPoolCount) || 0} 条` : '城市匹配关闭',
                data.providerProxyEnabled ? '供应商出口补充开启' : '供应商出口补充关闭',
                '仅场站/油站访问验证使用配置出口'
            ].join(' ｜ ');
            setStatusBannerState(
                byId('captureScopeStatus'),
                scopeText,
                data.proxyEnabled ? 'success' : 'warn'
            );

            return Array.isArray(data.recentEvidence) ? data.recentEvidence : [];
        }

        function updateLatestEvidence(rows = []) {
            const latest = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
            setElementText('captureLatestEvidenceAt', latest?.createdAt ? formatTime(latest.createdAt) : '-');
        }

        function renderRecorderStatus(data = {}) {
            const active = data.activeSession || null;
            const latestSession = active || data.recentSessions?.[0] || null;
            const stats = latestSession?.stats || null;
            const diagnostics = latestSession?.logDiagnostics || null;
            setElementText('captureRecorderAvailable', data.available ? '可用' : '未安装');
            setElementText('captureRecorderEndpoint', data.available ? '就绪' : '未启动');
            setElementText('captureRecorderSession', active ? '运行中' : '未运行');
            setElementText('captureRecorderOutput', latestSession?.harPath ? '已生成记录' : '无记录');
            setElementText('captureRecorderRequestCount', formatStatCount(stats?.requestCount));
            setElementText('captureRecorderRecordedCount', formatStatCount(stats?.recordedCount));
            setElementText('captureRecorderFilteredCount', formatStatCount(stats?.filteredCount));
            setElementText('captureRecorderBlockedCount', formatStatCount(stats?.blockedCount));
            setElementText('captureRecorderErrorCount', formatStatCount(stats?.errorCount));
            const filters = active?.filters || data.defaultFilters || {};
            const filterText = formatFilters(filters);
            const statsText = formatStats(stats, Boolean(active), diagnostics);
            const tone = resolveRecorderTone(data, active, stats, diagnostics);

            const text = active
                ? `请求记录中 ${active.listenHost}:${active.listenPort} ${filterText} ${statsText}`
                : data.available
                    ? `可启动 ${filterText} ${statsText}`
                    : '未检测到请求记录服务，请联系运维补齐记录组件。';
            setStatusBannerState(byId('captureRecorderStatus'), text, tone);
        }

        function formatStatCount(value) {
            return Number.isFinite(Number(value)) ? String(Number(value)) : '-';
        }

        function formatStats(stats = null, active = false, diagnostics = null) {
            const tlsErrorCount = Number(diagnostics?.tlsHandshakeErrorCount) || 0;
            const proxyConnectCount = Number(diagnostics?.clientConnectCount) || 0;
            const diagnosticText = diagnostics?.proxyTrafficSeen
                ? `网络出口连接 ${proxyConnectCount}，加密握手失败 ${tlsErrorCount}。`
                : '';

            if (tlsErrorCount > 0) {
                return `${diagnosticText}客户端未信任请求记录证书，最近目标 ${diagnostics?.lastServerHost || '-'}。`;
            }

            if (!stats || typeof stats !== 'object') {
                return active ? '尚未收到请求记录统计。' : '最近会话暂无请求记录统计。';
            }

            const requestCount = Number(stats.requestCount) || 0;
            const recordedCount = Number(stats.recordedCount) || 0;
            const filteredCount = Number(stats.filteredCount) || 0;
            const blockedCount = Number(stats.blockedCount) || 0;
            const errorCount = Number(stats.errorCount) || 0;
            const baseText = `统计：接收 ${requestCount}，记录 ${recordedCount}，过滤 ${filteredCount}，拦截 ${blockedCount}，错误 ${errorCount}。${diagnosticText}`;

            if (requestCount <= 0) {
                return diagnostics?.proxyTrafficSeen
                    ? `${baseText}网络出口有连接但未形成可解析请求。`
                    : `${baseText}当前网络出口入口还没有收到请求。`;
            }
            if (recordedCount <= 0 && filteredCount > 0) {
                return `${baseText}已有请求进入网络出口，但都被过滤项排除。`;
            }
            if (blockedCount > 0 && recordedCount <= 0 && blockedCount >= requestCount) {
                return `${baseText}请求已被访问策略拦截，不写入请求记录。`;
            }
            if (blockedCount > 0 && recordedCount > 0) {
                return `${baseText}已拦截部分干扰流量。`;
            }
            if (recordedCount <= 0 && errorCount > 0) {
                return `${baseText}已有请求进入网络出口，但存在连接或证书错误。`;
            }
            if (recordedCount <= 0) {
                return `${baseText}已有请求进入网络出口，但尚未形成可写入请求记录的响应。`;
            }
            return baseText;
        }

        function resolveRecorderTone(data = {}, active = null, stats = null, diagnostics = null) {
            if (!data.available) {
                return 'error';
            }
            if (Number(diagnostics?.tlsHandshakeErrorCount) > 0) {
                return 'error';
            }
            if (!stats || typeof stats !== 'object') {
                return active ? 'warn' : 'warn';
            }
            const requestCount = Number(stats.requestCount) || 0;
            const recordedCount = Number(stats.recordedCount) || 0;
            const errorCount = Number(stats.errorCount) || 0;
            if (requestCount <= 0 || recordedCount <= 0 || errorCount > 0) {
                return 'warn';
            }
            return 'success';
        }

        function formatFilters(filters = {}) {
            const hosts = Array.isArray(filters.hosts) ? filters.hosts : [];
            const ips = Array.isArray(filters.ips) ? filters.ips : [];
            if (hosts.length === 0 && ips.length === 0) {
                return ' 当前未设置过滤项，将记录全部可解密流量。';
            }
            return ` 当前过滤：域名 ${hosts.join(', ') || '-'}；IP ${ips.join(', ') || '-'}。`;
        }

        function splitFilterInput(value) {
            return Array.from(new Set(
                String(value || '')
                    .split(/[\n,，;；|\s]+/)
                    .map(item => item.trim())
                    .filter(Boolean)
            ));
        }

        function getFilters(hostInputId, ipInputId) {
            return {
                hosts: splitFilterInput(byId(hostInputId)?.value || ''),
                ips: splitFilterInput(byId(ipInputId)?.value || '')
            };
        }

        function getFilteredEvidenceRows(rows = []) {
            const proxyFilter = byId('captureProxyFilter')?.value || '';
            const statusFilter = byId('captureStatusFilter')?.value || '';

            return (Array.isArray(rows) ? rows : []).filter(row => {
                if (proxyFilter === 'proxied' && !row?.proxy?.used) {
                    return false;
                }
                if (proxyFilter === 'direct' && row?.proxy?.used) {
                    return false;
                }
                if (statusFilter === 'success' && !row?.success) {
                    return false;
                }
                if (statusFilter === 'failed' && row?.success) {
                    return false;
                }
                return true;
            });
        }

        function renderEvidenceTable(rows = []) {
            const tableBody = byId('captureEvidenceTableBody');
            if (!tableBody) {
                return;
            }

            const filteredRows = getFilteredEvidenceRows(rows);
            if (filteredRows.length === 0) {
                tableBody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:32px;">暂无匹配证据</td></tr>';
                return;
            }

            tableBody.innerHTML = filteredRows.map(row => {
                const statusTone = row.success ? 'success' : 'error';
                const statusText = row.success ? '成功' : '失败';
                const statusCode = row.statusCode ? ` ${row.statusCode}` : '';
                const errorText = row.error?.message || row.error?.code || '-';
                return `
                    <tr>
                        <td><span class="time-text">${escapeHtml(formatTime(row.createdAt))}</span></td>
                        <td>
                            <div class="source-stack">
                                <span class="source-chip">${escapeHtml(row.chain || row.evidenceType || '-')}</span>
                                <span class="source-stage">${escapeHtml(row.platform || '-')} / ${escapeHtml(row.reason || '-')}</span>
                            </div>
                        </td>
                        <td>${renderTarget(row)}</td>
                        <td>${renderProxy(row.proxy || {})}</td>
                        <td><span class="chain-badge ${statusTone}">${statusText}${escapeHtml(statusCode)}</span></td>
                        <td>${escapeHtml(row.durationMs ?? '-')} ms</td>
                        <td><span class="source-stage">${escapeHtml(errorText)}</span></td>
                    </tr>
                `;
            }).join('');
        }

        function renderTarget(row = {}) {
            const location = row.targetLocation || {};
            const locationText = [
                location.province,
                location.city,
                location.district,
                location.keyword
            ].filter(Boolean).join(' / ');
            const hostPath = [row.targetHost || '', row.targetPath || ''].filter(Boolean).join('');
            const method = row.method || 'GET';
            return `
                <div class="capture-target">
                    <strong>${escapeHtml(method)} ${escapeHtml(hostPath || row.url || '-')}</strong>
                    <span>${escapeHtml(locationText || '-')}</span>
                </div>
            `;
        }

        function renderProxy(proxy = {}) {
            const used = Boolean(proxy.used);
            const label = used ? (proxy.label || proxy.type || '网络出口') : '直连';
            const tone = used ? 'success' : 'warn';
            return `
                <div class="capture-proxy">
                    <span class="chain-badge ${tone}">${escapeHtml(label)}</span>
                    <code>${escapeHtml(proxy.proxyUrl || '-')}</code>
                </div>
            `;
        }

        function exportEvidence(rows = []) {
            const filteredRows = getFilteredEvidenceRows(rows);
            const blob = new Blob([JSON.stringify(filteredRows, null, 2)], { type: 'application/json;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const link = documentRef.createElement('a');
            link.href = url;
            link.download = `outbound-evidence-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
            documentRef.body.appendChild(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(url);
        }

        function maskProxyUrl(proxyUrl) {
            const raw = String(proxyUrl || '').trim();
            if (!raw) {
                return '';
            }

            try {
                const url = new URL(raw);
                if (url.username) url.username = '***';
                if (url.password) url.password = '***';
                return url.toString();
            } catch (error) {
                return raw.replace(/\/\/([^/@:]+):([^/@]+)@/, '//***:***@');
            }
        }

        return {
            exportEvidence,
            formatFilters,
            formatStatCount,
            formatStats,
            getEvidenceLimit,
            getFilteredEvidenceRows,
            getFilters,
            maskProxyUrl,
            renderEvidenceTable,
            renderProxy,
            renderRecorderStatus,
            renderStatus,
            renderTarget,
            resolveRecorderTone,
            splitFilterInput,
            updateLatestEvidence
        };
    }

    global.CaptureEvidenceControl = { createController };
})(window);
