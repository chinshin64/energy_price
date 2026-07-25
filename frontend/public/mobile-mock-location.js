(function attachMobileMockLocationControl(global) {
    'use strict';

    const DEFAULT_COORDINATE = { lat: 34.261, lng: 108.9425 };
    const MAP_BOUNDS = {
        minLat: 18,
        maxLat: 54,
        minLng: 73,
        maxLng: 135
    };

    function clampNumber(value, min, max, fallback) {
        const number = Number(value);
        if (!Number.isFinite(number)) {
            return fallback;
        }
        return Math.max(min, Math.min(max, number));
    }

    function requireDependency(deps, name) {
        const value = deps[name];
        if (!value) {
            throw new Error(`Mobile mock location dependency missing: ${name}`);
        }
        return value;
    }

    function createController(deps = {}) {
        const documentRef = deps.document || global.document;
        const findCityPreset = requireDependency(deps, 'findCityPreset');
        const populateCityPresetOptions = requireDependency(deps, 'populateCityPresetOptions');
        const formatPresetCoordinate = requireDependency(deps, 'formatPresetCoordinate');
        const setStatusBannerState = requireDependency(deps, 'setStatusBannerState');
        const requestMobileControl = requireDependency(deps, 'requestMobileControl');
        const refreshMobileControl = requireDependency(deps, 'refreshMobileControl');
        let pointerId = null;
        let coordinateSource = 'operator_app_preset';

        function byId(id) {
            return documentRef.getElementById(id);
        }

        function pointFromCoordinate(lat, lng) {
            const safeLat = clampNumber(lat, MAP_BOUNDS.minLat, MAP_BOUNDS.maxLat, DEFAULT_COORDINATE.lat);
            const safeLng = clampNumber(lng, MAP_BOUNDS.minLng, MAP_BOUNDS.maxLng, DEFAULT_COORDINATE.lng);
            return {
                x: ((safeLng - MAP_BOUNDS.minLng) / (MAP_BOUNDS.maxLng - MAP_BOUNDS.minLng)) * 100,
                y: ((MAP_BOUNDS.maxLat - safeLat) / (MAP_BOUNDS.maxLat - MAP_BOUNDS.minLat)) * 100
            };
        }

        function coordinateFromPointer(event) {
            const map = byId('mobileMockMap');
            if (!map) {
                return null;
            }
            const rect = map.getBoundingClientRect();
            if (!rect.width || !rect.height) {
                return null;
            }
            const xRatio = clampNumber((event.clientX - rect.left) / rect.width, 0, 1, 0.5);
            const yRatio = clampNumber((event.clientY - rect.top) / rect.height, 0, 1, 0.5);
            return {
                lat: MAP_BOUNDS.maxLat - yRatio * (MAP_BOUNDS.maxLat - MAP_BOUNDS.minLat),
                lng: MAP_BOUNDS.minLng + xRatio * (MAP_BOUNDS.maxLng - MAP_BOUNDS.minLng)
            };
        }

        function setStatus(message, tone = '') {
            setStatusBannerState(byId('mobileMockLocationStatus'), message, tone);
        }

        function syncMarker() {
            const marker = byId('mobileMockMarker');
            const lat = Number(byId('mobileMockLat')?.value);
            const lng = Number(byId('mobileMockLng')?.value);
            if (!marker || !Number.isFinite(lat) || !Number.isFinite(lng)) {
                return;
            }
            const point = pointFromCoordinate(lat, lng);
            marker.style.left = `${point.x}%`;
            marker.style.top = `${point.y}%`;
        }

        function updateInputs({
            lat,
            lng,
            keyword = '',
            city = '',
            source = '',
            updateKeyword = false,
            nextCoordinateSource = ''
        } = {}) {
            const latEl = byId('mobileMockLat');
            const lngEl = byId('mobileMockLng');
            const keywordEl = byId('mobileMockKeyword');
            const coordinate = {
                lat: clampNumber(lat, -90, 90, Number(latEl?.value) || DEFAULT_COORDINATE.lat),
                lng: clampNumber(lng, -180, 180, Number(lngEl?.value) || DEFAULT_COORDINATE.lng)
            };
            if (latEl) latEl.value = formatPresetCoordinate(coordinate.lat);
            if (lngEl) lngEl.value = formatPresetCoordinate(coordinate.lng);
            if (keywordEl && updateKeyword && keyword) keywordEl.value = keyword;
            if (nextCoordinateSource) {
                coordinateSource = nextCoordinateSource;
            }
            syncMarker();
            const label = keyword || city || keywordEl?.value?.trim() || '自定义位置';
            setStatus(
                `${label} · 纬度 ${formatPresetCoordinate(coordinate.lat)} · 经度 ${formatPresetCoordinate(coordinate.lng)}${source ? ` · ${source}` : ''}`,
                'info'
            );
        }

        function renderCityDots() {
            const container = byId('mobileMockCityDots');
            if (!container) {
                return;
            }
            container.innerHTML = '';
            const presets = Array.isArray(deps.getCityPresets?.()) ? deps.getCityPresets() : [];
            presets.forEach(item => {
                const lat = Number(item.lat);
                const lng = Number(item.lng);
                if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
                    return;
                }
                const point = pointFromCoordinate(lat, lng);
                const dot = documentRef.createElement('span');
                dot.className = 'mobile-mock-city-dot';
                dot.title = item.name || item.city || '';
                dot.style.left = `${point.x}%`;
                dot.style.top = `${point.y}%`;
                container.appendChild(dot);
            });
        }

        function syncFromPreset() {
            const keywordEl = byId('mobileMockKeyword');
            const preset = findCityPreset(keywordEl?.value || '');
            if (!preset) {
                syncMarker();
                return false;
            }
            updateInputs({
                lat: preset.lat,
                lng: preset.lng,
                keyword: preset.name,
                city: preset.city || preset.name,
                source: '城市预设',
                updateKeyword: true,
                nextCoordinateSource: 'operator_app_preset'
            });
            return true;
        }

        function syncFromManualInputs() {
            const lat = Number(byId('mobileMockLat')?.value);
            const lng = Number(byId('mobileMockLng')?.value);
            if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
                setStatus('经纬度无效。', 'error');
                return false;
            }
            updateInputs({
                lat,
                lng,
                source: '手动输入',
                nextCoordinateSource: 'operator_app_manual'
            });
            return true;
        }

        function updateFromPointer(event) {
            const coordinate = coordinateFromPointer(event);
            if (!coordinate) {
                return;
            }
            updateInputs({
                lat: coordinate.lat,
                lng: coordinate.lng,
                source: '地图选择',
                nextCoordinateSource: 'operator_app_map'
            });
        }

        function getPayload() {
            const lat = Number(byId('mobileMockLat')?.value);
            const lng = Number(byId('mobileMockLng')?.value);
            if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
                throw new Error('纬度必须在 -90 到 90 之间');
            }
            if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
                throw new Error('经度必须在 -180 到 180 之间');
            }
            const keyword = byId('mobileMockKeyword')?.value?.trim() || '自定义位置';
            const preset = findCityPreset(keyword);
            return {
                city: preset?.city || preset?.name || keyword.replace(/市$/, ''),
                keyword,
                lat,
                lng,
                accuracy: Math.max(1, Math.min(1000, Number(byId('mobileMockAccuracy')?.value) || 20)),
                coordinateSystem: byId('mobileMockCoordinateSystem')?.value || 'WGS84',
                coordinateSource,
                platform: byId('mobileMockPlatform')?.value || 'didi-charging'
            };
        }

        async function apply() {
            const payload = getPayload();
            const deviceId = byId('mobileMockDeviceId')?.value?.trim() || '*';
            setStatus(`正在下发模拟定位：${payload.keyword}`, 'warn');
            const command = await requestMobileControl('/mobile-control/commands', {
                method: 'POST',
                body: JSON.stringify({
                    type: 'set_mock_location',
                    deviceId,
                    payload
                })
            });
            setStatus(
                `已下发：${payload.keyword} · ${formatPresetCoordinate(payload.lat)}, ${formatPresetCoordinate(payload.lng)} · ${command.id || ''}`,
                'success'
            );
            await refreshMobileControl();
        }

        async function restore() {
            const deviceId = byId('mobileMockDeviceId')?.value?.trim() || '*';
            setStatus('正在下发恢复真实定位指令...', 'warn');
            const command = await requestMobileControl('/mobile-control/commands', {
                method: 'POST',
                body: JSON.stringify({
                    type: 'clear_mock_location',
                    deviceId,
                    payload: { reason: 'operator_restore_real_location' }
                })
            });
            setStatus(`已下发恢复真实定位指令 · ${command.id || ''}`, 'success');
            await refreshMobileControl();
        }

        function init() {
            const map = byId('mobileMockMap');
            const marker = byId('mobileMockMarker');
            const latEl = byId('mobileMockLat');
            const lngEl = byId('mobileMockLng');
            const keywordEl = byId('mobileMockKeyword');
            if (!map || !marker || !latEl || !lngEl || !keywordEl) {
                return;
            }
            populateCityPresetOptions('mobileMockPresetList');
            renderCityDots();
            syncFromPreset();
            syncMarker();

            keywordEl.addEventListener('change', syncFromPreset);
            keywordEl.addEventListener('blur', syncFromPreset);
            [latEl, lngEl].forEach(input => {
                input.addEventListener('input', () => {
                    coordinateSource = 'operator_app_manual';
                    syncMarker();
                });
                input.addEventListener('change', syncFromManualInputs);
            });

            map.addEventListener('pointerdown', event => {
                pointerId = event.pointerId;
                map.setPointerCapture(event.pointerId);
                updateFromPointer(event);
            });
            map.addEventListener('pointermove', event => {
                if (pointerId !== event.pointerId) {
                    return;
                }
                updateFromPointer(event);
            });
            const releasePointer = event => {
                if (pointerId === event.pointerId) {
                    pointerId = null;
                }
            };
            map.addEventListener('pointerup', releasePointer);
            map.addEventListener('pointercancel', releasePointer);

            marker.addEventListener('keydown', event => {
                const step = event.shiftKey ? 0.05 : 0.005;
                const lat = Number(latEl.value);
                const lng = Number(lngEl.value);
                if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
                    return;
                }
                const deltas = {
                    ArrowUp: { lat: step, lng: 0 },
                    ArrowDown: { lat: -step, lng: 0 },
                    ArrowLeft: { lat: 0, lng: -step },
                    ArrowRight: { lat: 0, lng: step }
                };
                const delta = deltas[event.key];
                if (!delta) {
                    return;
                }
                event.preventDefault();
                updateInputs({
                    lat: lat + delta.lat,
                    lng: lng + delta.lng,
                    source: '地图选择',
                    nextCoordinateSource: 'operator_app_map'
                });
            });
        }

        return {
            apply,
            init,
            restore,
            setStatus
        };
    }

    global.MobileMockLocationControl = { createController };
})(window);
