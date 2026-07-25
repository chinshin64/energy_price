(function attachCaptureRecorderControl(global) {
    'use strict';

    function requireDependency(deps, name) {
        const value = deps[name];
        if (!value) {
            throw new Error(`Capture recorder dependency missing: ${name}`);
        }
        return value;
    }

    function createController(deps = {}) {
        const documentRef = deps.document || global.document;
        const fetchImpl = requireDependency(deps, 'fetch');
        const serviceBase = requireDependency(deps, 'serviceBase');
        const renderRecorderStatus = requireDependency(deps, 'renderRecorderStatus');
        const renderProductReadinessPanel = requireDependency(deps, 'renderProductReadinessPanel');
        const setRecorderSnapshot = requireDependency(deps, 'setRecorderSnapshot');
        const setStatusBannerState = requireDependency(deps, 'setStatusBannerState');

        function byId(id) {
            return documentRef.getElementById(id);
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

        function formatFilters(filters = {}) {
            const hosts = Array.isArray(filters.hosts) ? filters.hosts : [];
            const ips = Array.isArray(filters.ips) ? filters.ips : [];
            if (hosts.length === 0 && ips.length === 0) {
                return ' 当前未设置过滤项，将记录全部可解密流量。';
            }
            return ` 当前过滤：域名 ${hosts.join(', ') || '-'}；IP ${ips.join(', ') || '-'}。`;
        }

        function getRequestCollectionFilters() {
            return getFilters('method2CaptureHostFilter', 'method2CaptureIpFilter');
        }

        function getManualFilters() {
            return getFilters('captureRecorderHostFilter', 'captureRecorderIpFilter');
        }

        function getRequestCollectionLocationOverride() {
            const enabled = Boolean(byId('method2LocationOverrideEnabled')?.checked);
            if (!enabled) {
                return {};
            }

            const city = String(byId('method2OverrideCity')?.value || '').trim();
            const latRaw = String(byId('method2OverrideLat')?.value || '').trim();
            const lngRaw = String(byId('method2OverrideLng')?.value || '').trim();
            const lat = Number(latRaw);
            const lng = Number(lngRaw);
            const hasLatLngInput = Boolean(latRaw || lngRaw);
            const hasValidLatLng = Number.isFinite(lat)
                && Number.isFinite(lng)
                && lat >= -90
                && lat <= 90
                && lng >= -180
                && lng <= 180
                && lat !== 0
                && lng !== 0;

            if (!city && !hasValidLatLng) {
                throw new Error('启用虚拟定位后，需要填写定位城市或有效经纬度');
            }
            if (hasLatLngInput && !hasValidLatLng) {
                throw new Error('虚拟定位经纬度不完整或超出范围');
            }

            return {
                overrideCity: city || 'custom',
                ...(hasValidLatLng ? { overrideLat: lat, overrideLng: lng } : {})
            };
        }

        async function loadStatus() {
            const statusEl = byId('captureRecorderStatus');
            if (!statusEl) {
                return;
            }
            try {
                const response = await fetchImpl(`${serviceBase}/capture-recorder/status`);
                const result = await response.json();
                if (!result.success) {
                    throw new Error(result.error || '请求记录服务状态读取失败');
                }
                renderRecorderStatus(result.data || {});
            } catch (error) {
                setRecorderSnapshot(null);
                setStatusBannerState(statusEl, `请求记录服务状态读取失败：${error.message}`, 'error');
                renderProductReadinessPanel();
            }
        }

        async function start() {
            const filters = getManualFilters();
            const response = await fetchImpl(`${serviceBase}/capture-recorder/start`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ label: 'manual-capture-center', filters })
            });
            const result = await response.json();
            if (!result.success) {
                throw new Error(result.error || '请求记录服务启动失败');
            }
            renderRecorderStatus({
                available: true,
                listenHost: result.data.listenHost,
                listenPort: result.data.listenPort,
                activeSession: result.data,
                recentSessions: []
            });
        }

        async function stop() {
            const response = await fetchImpl(`${serviceBase}/capture-recorder/stop`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });
            const result = await response.json();
            if (!result.success) {
                throw new Error(result.error || '请求记录服务停止失败');
            }
            await loadStatus();
        }

        return {
            formatFilters,
            getFilters,
            getManualFilters,
            getRequestCollectionFilters,
            getRequestCollectionLocationOverride,
            loadStatus,
            splitFilterInput,
            start,
            stop
        };
    }

    global.CaptureRecorderControl = { createController };
})(window);
