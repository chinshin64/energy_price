(function attachSyncNodeControl(global) {
    'use strict';

    function createController(deps = {}) {
        const documentRef = deps.document || global.document;
        const fetchRef = deps.fetch || global.fetch.bind(global);
        const escapeHtml = deps.escapeHtml;
        const serviceBase = deps.serviceBase;
        const setStatusBannerState = deps.setStatusBannerState;
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
                throw new Error(result.error || '同步节点服务请求失败');
            }
            return result.data;
        }

        function directionLabel(value) {
            return ({ 'push-only': '仅推送', 'pull-only': '仅拉取', bidirectional: '双向' }[value]) || value || '-';
        }

        function renderRows(nodes = []) {
            const body = byId('syncNodeTableBody');
            if (!body) return;
            if (!nodes.length) {
                body.innerHTML = '<tr><td colspan="6" style="text-align:center; padding:28px;">暂无同步节点</td></tr>';
                return;
            }
            body.innerHTML = nodes.map(node => `
                <tr>
                    <td>${escapeHtml(node.name)}</td>
                    <td>${escapeHtml(node.url)}</td>
                    <td><span class="status-pill ${node.status === 'online' ? 'success' : 'warn'}">${node.status === 'online' ? '在线' : '离线'}</span></td>
                    <td>${escapeHtml(directionLabel(node.direction))}</td>
                    <td>${escapeHtml(formatTime(node.lastSyncAt))}</td>
                    <td>
                        <div class="action-row table-action-row">
                            <button class="btn btn-secondary" type="button" data-sync-node-action="push" data-node-name="${escapeHtml(node.name)}">推送</button>
                            <button class="btn btn-danger" type="button" data-sync-node-action="delete" data-node-name="${escapeHtml(node.name)}">删除</button>
                        </div>
                    </td>
                </tr>
            `).join('');
        }

        async function load() {
            const status = byId('syncNodeStatus');
            setStatusBannerState(status, '正在刷新同步节点...', 'info');
            try {
                const nodes = await request('/sync/nodes');
                renderRows(Array.isArray(nodes) ? nodes : []);
                const online = (nodes || []).filter(node => node.status === 'online').length;
                setStatusBannerState(status, `已加载 ${nodes?.length || 0} 个节点，在线 ${online} 个`, online > 0 ? 'success' : 'warn');
            } catch (error) {
                renderRows([]);
                setStatusBannerState(status, `同步节点读取失败：${error.message}`, 'error');
            }
        }

        async function addNode() {
            const payload = {
                name: byId('syncNodeName')?.value.trim(),
                url: byId('syncNodeUrl')?.value.trim(),
                direction: byId('syncNodeDirection')?.value || 'bidirectional',
                authToken: byId('syncNodeAuthToken')?.value || ''
            };
            const status = byId('syncNodeStatus');
            if (!payload.name || !payload.url) {
                setStatusBannerState(status, '请填写节点名称和服务地址', 'warn');
                return;
            }
            try {
                await request('/sync/nodes', { method: 'POST', body: JSON.stringify(payload) });
                if (byId('syncNodeAuthToken')) byId('syncNodeAuthToken').value = '';
                await load();
            } catch (error) {
                setStatusBannerState(status, `新增节点失败：${error.message}`, 'error');
            }
        }

        async function runAction(action, name) {
            const wording = action === 'delete' ? '删除' : '向该节点推送报告与证据';
            if (!confirmAction(`确认${wording}“${name}”？`)) return;
            const status = byId('syncNodeStatus');
            setStatusBannerState(status, `正在${wording}...`, 'info');
            try {
                if (action === 'delete') {
                    await request(`/sync/nodes/${encodeURIComponent(name)}`, { method: 'DELETE' });
                } else {
                    const result = await request('/sync/push', { method: 'POST', body: JSON.stringify({ node: name }) });
                    setStatusBannerState(status, `推送完成：成功 ${result.pushed || 0}，跳过 ${result.skipped || 0}，失败 ${result.errors || 0}`, result.errors ? 'warn' : 'success');
                }
                await load();
            } catch (error) {
                setStatusBannerState(status, `${wording}失败：${error.message}`, 'error');
            }
        }

        function init() {
            if (!eventsBound) {
                byId('refreshSyncNodesBtn')?.addEventListener('click', load);
                byId('addSyncNodeBtn')?.addEventListener('click', addNode);
                byId('syncNodeTableBody')?.addEventListener('click', event => {
                    const button = event.target.closest('[data-sync-node-action]');
                    if (button) runAction(button.dataset.syncNodeAction, button.dataset.nodeName);
                });
                eventsBound = true;
            }
            return load();
        }

        return { init, load, renderRows };
    }

    global.SyncNodeControl = { createController };
})(window);
