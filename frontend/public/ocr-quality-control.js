(function attachOcrQualityControl(global) {
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
                throw new Error(result.error || 'OCR 质量服务请求失败');
            }
            return result;
        }

        function setMetric(id, value) {
            const element = byId(id);
            if (element) element.textContent = value;
        }

        function renderDashboard(data = {}) {
            setMetric('ocrQualityTotal', String(data.total || 0));
            setMetric('ocrQualityApproved', String(data.approved || 0));
            setMetric('ocrQualityPending', String(data.needsReview || 0));
            setMetric('ocrQualityRejected', String(data.redCount || 0));
            setMetric('ocrQualityAccuracy', `${Number(data.accuracyRate || 0).toFixed(2)}%`);
            setMetric('ocrQualityConfidence', data.avgConfidence === null || data.avgConfidence === undefined
                ? '-'
                : Number(data.avgConfidence).toFixed(2));
        }

        function renderRows(rows = []) {
            const body = byId('ocrReviewTableBody');
            if (!body) return;
            if (!rows.length) {
                body.innerHTML = '<tr><td colspan="6" style="text-align:center; padding:28px;">暂无待复核数据</td></tr>';
                return;
            }
            body.innerHTML = rows.map(row => `
                <tr>
                    <td>${escapeHtml(row.platform || '-')}</td>
                    <td>${escapeHtml(row.station_name || row.stationName || '-')}</td>
                    <td>${escapeHtml(row.address || '-')}</td>
                    <td>${row.confidence_score === null || row.confidence_score === undefined ? '-' : escapeHtml(Number(row.confidence_score).toFixed(2))}</td>
                    <td>${escapeHtml(formatTime(row.snapshot_at || row.created_at || row.createdAt))}</td>
                    <td>
                        <div class="action-row table-action-row">
                            <button class="btn btn-secondary" type="button" data-ocr-review-action="approve" data-review-id="${escapeHtml(row.id)}">通过</button>
                            <button class="btn btn-danger" type="button" data-ocr-review-action="reject" data-review-id="${escapeHtml(row.id)}">拒绝</button>
                        </div>
                    </td>
                </tr>
            `).join('');
        }

        async function load() {
            const status = byId('ocrQualityStatus');
            setStatusBannerState(status, '正在刷新 OCR 数据质量...', 'info');
            try {
                const [dashboard, pending] = await Promise.all([
                    request('/ocr-quality/dashboard'),
                    request('/ocr-review/pending?limit=50')
                ]);
                renderDashboard(dashboard.data || {});
                renderRows(Array.isArray(pending.data) ? pending.data : []);
                setStatusBannerState(status, `质量数据已更新，待复核 ${pending.total || 0} 条`, (pending.total || 0) > 0 ? 'warn' : 'success');
            } catch (error) {
                renderRows([]);
                setStatusBannerState(status, `OCR 数据质量读取失败：${error.message}`, 'error');
            }
        }

        async function processReview(action, id) {
            if (action === 'reject' && !confirmAction('拒绝后记录将移入异常池并从场站数据中删除，确认继续？')) {
                return;
            }
            const status = byId('ocrQualityStatus');
            setStatusBannerState(status, action === 'approve' ? '正在通过复核...' : '正在拒绝记录...', 'info');
            try {
                await request(`/ocr-review/${action}/${encodeURIComponent(id)}`, { method: 'POST', body: '{}' });
                await load();
            } catch (error) {
                setStatusBannerState(status, `复核操作失败：${error.message}`, 'error');
            }
        }

        function init() {
            if (!eventsBound) {
                byId('refreshOcrQualityBtn')?.addEventListener('click', load);
                byId('ocrReviewTableBody')?.addEventListener('click', event => {
                    const button = event.target.closest('[data-ocr-review-action]');
                    if (button) processReview(button.dataset.ocrReviewAction, button.dataset.reviewId);
                });
                eventsBound = true;
            }
            return load();
        }

        return { init, load, renderDashboard, renderRows };
    }

    global.OcrQualityControl = { createController };
})(window);
