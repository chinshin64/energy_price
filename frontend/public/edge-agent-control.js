(function attachEdgeAgentControl(global) {
    'use strict';

    function createController(deps = {}) {
        const documentRef = deps.document || global.document;
        const escapeHtml = deps.escapeHtml;
        const formatTime = deps.formatTime;

        function byId(id) {
            return documentRef.getElementById(id);
        }

        function formatGeo(geo = {}) {
            return [geo.country, geo.province, geo.city].filter(Boolean).join(' · ') || '属地待校验';
        }

        function formatTaskStatus(status) {
            return {
                pending: '等待节点',
                running: '执行中',
                succeeded: '已完成',
                failed: '失败',
                cancelled: '已取消'
            }[status] || status || '未知';
        }

        function renderStatus(status = {}) {
            const element = byId('edgeOrchestrationStatus');
            if (!element) return;
            const nodes = status.nodes || {};
            const tasks = status.tasks || {};
            element.textContent = `在线 ${nodes.online || 0}/${nodes.total || 0} · 属地已校验 ${nodes.geoVerified || 0} · 执行中 ${tasks.running || 0} · 等待 ${tasks.pending || 0}`;
            element.className = `status-banner ${(nodes.online || 0) > 0 ? 'success' : 'warn'}`;
        }

        function renderNodes(nodes = []) {
            const container = byId('edgeNodeList');
            if (!container) return;
            const values = Array.isArray(nodes) ? nodes : [];
            if (values.length === 0) {
                container.innerHTML = '<div class="meta-hint">暂无已登记协同节点</div>';
                return;
            }
            container.innerHTML = values.slice(0, 20).map(node => {
                const capabilityCount = Array.isArray(node.capabilities) ? node.capabilities.length : 0;
                const detail = [node.platform, `v${node.version || '-'}`, formatGeo(node.geo), node.egressIp].filter(Boolean).join(' ｜ ');
                return `<div class="mobile-command-card ${node.online ? 'success' : 'error'}">
                    <div class="mobile-command-title">
                        <span>${escapeHtml(node.nodeId || '-')}</span>
                        <span class="mobile-status-chip ${node.online ? 'succeeded' : 'failed'}">${node.online ? '在线' : '离线'}</span>
                    </div>
                    <div class="meta-hint">${escapeHtml(detail)}</div>
                    <div class="meta-hint">能力 ${capabilityCount} 项 · 活跃任务 ${node.activeTaskCount || 0}${node.parentNodeId ? ` · 上级 ${escapeHtml(node.parentNodeId)}` : ''}</div>
                    <div class="meta-hint">最后心跳 ${escapeHtml(formatTime(node.lastSeenAt))}</div>
                </div>`;
            }).join('');
        }

        function renderTasks(tasks = []) {
            const container = byId('edgeTaskList');
            if (!container) return;
            const values = Array.isArray(tasks) ? tasks : [];
            if (values.length === 0) {
                container.innerHTML = '<div class="meta-hint">暂无协同任务</div>';
                return;
            }
            container.innerHTML = values.slice(0, 20).map(task => {
                const tone = task.status === 'succeeded' ? 'success' : task.status === 'failed' ? 'error' : task.status === 'running' ? 'warn' : 'info';
                const targetGeo = formatGeo(task.requiredGeo);
                const executionGeo = task.executionGeo ? formatGeo(task.executionGeo) : '';
                return `<div class="mobile-command-card ${tone}">
                    <div class="mobile-command-title">
                        <span>${escapeHtml(task.type || task.capability || '-')}</span>
                        <span class="mobile-status-chip ${escapeHtml(task.status || '')}">${escapeHtml(formatTaskStatus(task.status))}</span>
                    </div>
                    <div class="meta-hint">${escapeHtml(task.targetNodeId || '等待匹配节点')} · ${escapeHtml(targetGeo)}</div>
                    <div class="meta-hint">来源 ${escapeHtml(task.origin || '-')} · 尝试 ${task.attemptCount || 0}/${task.maxAttempts || 0}${executionGeo ? ` · 执行地 ${escapeHtml(executionGeo)}` : ''}</div>
                    ${task.error ? `<div class="meta-hint" style="color:var(--danger);">${escapeHtml(task.error)}</div>` : ''}
                </div>`;
            }).join('');
        }

        function render(snapshot = {}) {
            renderStatus(snapshot.status);
            renderNodes(snapshot.nodes);
            renderTasks(snapshot.tasks);
        }

        return { formatGeo, formatTaskStatus, render, renderNodes, renderStatus, renderTasks };
    }

    global.EdgeAgentControl = { createController };
})(window);
