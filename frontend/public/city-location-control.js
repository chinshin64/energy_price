(function attachCityLocationControl(global) {
    'use strict';

    function requireDependency(deps, name) {
        const value = deps[name];
        if (!value) {
            throw new Error(`City location dependency missing: ${name}`);
        }
        return value;
    }

    function createController(deps = {}) {
        const documentRef = deps.document || global.document;
        const fetchRef = deps.fetch || global.fetch?.bind(global);
        const alertRef = deps.alert || global.alert?.bind(global) || function noop() {};
        const getCityPresets = requireDependency(deps, 'getCityPresets');
        const getCollectState = requireDependency(deps, 'getCollectState');
        const setCollectState = requireDependency(deps, 'setCollectState');
        const serviceBase = requireDependency(deps, 'serviceBase');
        const cityPresetLookup = new Map();
        let lookupSource = null;

        function getPresets() {
            const presets = getCityPresets();
            return Array.isArray(presets) ? presets : [];
        }

        function getState() {
            const state = getCollectState() || {};
            return {
                location: state.location || null,
                locations: Array.isArray(state.locations) ? state.locations : []
            };
        }

        function setState(location, locations = []) {
            setCollectState({
                location: location || null,
                locations: Array.isArray(locations) ? locations : []
            });
        }

        function normalizeCityPresetKeyword(value = '') {
            return String(value || '')
                .trim()
                .replace(/\s+/g, '')
                .replace(/(特别行政区|自治州|地区|盟|市)$/u, '');
        }

        function formatPresetCoordinate(value) {
            const num = Number(value);
            if (!Number.isFinite(num)) {
                return '';
            }

            return num.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
        }

        function buildCityPresetLookup() {
            const presets = getPresets();
            if (lookupSource === presets && cityPresetLookup.size > 0) {
                return;
            }

            lookupSource = presets;
            cityPresetLookup.clear();
            presets.forEach(city => {
                const keys = new Set([
                    city.name,
                    city.city,
                    city.province,
                    ...(Array.isArray(city.aliases) ? city.aliases : [])
                ].map(normalizeCityPresetKeyword).filter(Boolean));

                keys.forEach(key => {
                    if (!cityPresetLookup.has(key)) {
                        cityPresetLookup.set(key, city);
                    }
                });
            });
        }

        function findCityPreset(keyword) {
            const normalized = normalizeCityPresetKeyword(keyword);
            if (!normalized) {
                return null;
            }

            buildCityPresetLookup();
            return cityPresetLookup.get(normalized) || null;
        }

        function populateCityPresetOptions(datalistId) {
            const datalist = documentRef.getElementById(datalistId);
            if (!datalist) {
                return;
            }

            datalist.innerHTML = '';
            getPresets().forEach(city => {
                const option = documentRef.createElement('option');
                option.value = city.name;
                option.label = `${city.province}${city.city && city.city !== city.name ? ` · ${city.city}` : ''} · ${formatPresetCoordinate(city.lat)}, ${formatPresetCoordinate(city.lng)}`;
                datalist.appendChild(option);
            });
        }

        function updateCityPresetMeta(metaEl, city, fallbackText = '') {
            if (!metaEl) {
                return;
            }

            if (!city) {
                metaEl.textContent = fallbackText;
                return;
            }

            metaEl.textContent = `${city.province} · 纬度 ${formatPresetCoordinate(city.lat)} · 经度 ${formatPresetCoordinate(city.lng)}`;
        }

        function applyLocationToCollectForm(location) {
            if (!location) {
                return false;
            }

            const lat = Number(location.lat);
            const lng = Number(location.lng);
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
                return false;
            }

            const inputEl = documentRef.getElementById('collectPresetCity');
            const latEl = documentRef.getElementById('collectCenterLat');
            const lngEl = documentRef.getElementById('collectCenterLng');
            const metaEl = documentRef.getElementById('collectPresetCityMeta');

            if (inputEl && location.name) {
                inputEl.value = location.name;
            }
            if (latEl) latEl.value = formatPresetCoordinate(lat);
            if (lngEl) lngEl.value = formatPresetCoordinate(lng);

            const nextLocation = {
                keyword: inputEl?.value?.trim() || location.keyword || location.name || '',
                name: location.name || inputEl?.value?.trim() || '',
                province: location.province || '',
                city: location.city || '',
                district: location.district || '',
                lat,
                lng,
                source: location.source || ''
            };
            setState(nextLocation, [nextLocation]);
            if (metaEl) {
                const source = location.source ? ` · ${location.source}` : '';
                metaEl.textContent = `${location.province || location.city || '目标'} · 纬度 ${formatPresetCoordinate(lat)} · 经度 ${formatPresetCoordinate(lng)}${source}`;
            }
            return true;
        }

        function buildCollectTargetLocation(centerLat, centerLng) {
            const keyword = documentRef.getElementById('collectPresetCity')?.value?.trim() || '';
            const preset = findCityPreset(keyword);
            const base = getState().location || preset || {};

            return {
                keyword,
                name: base.name || keyword,
                province: base.province || '',
                city: base.city || '',
                district: base.district || '',
                lat: Number.isFinite(centerLat) ? centerLat : Number(base.lat) || null,
                lng: Number.isFinite(centerLng) ? centerLng : Number(base.lng) || null,
                source: base.source || (preset ? '城市预设' : '')
            };
        }

        function parseCollectTargetKeywords() {
            const raw = documentRef.getElementById('collectPresetCity')?.value || '';
            return raw
                .split(/[,，;；\n\r]+/u)
                .map(item => item.trim())
                .filter(Boolean);
        }

        function parseCoordinateKeyword(keyword) {
            const match = String(keyword || '').match(/(-?\d+(?:\.\d+)?)\s*[,，\s]\s*(-?\d+(?:\.\d+)?)/);
            if (!match) {
                return null;
            }

            const first = Number(match[1]);
            const second = Number(match[2]);
            if (!Number.isFinite(first) || !Number.isFinite(second)) {
                return null;
            }

            const lat = Math.abs(first) <= 90 ? first : second;
            const lng = Math.abs(first) <= 90 ? second : first;
            if (Math.abs(lat) > 90 || Math.abs(lng) > 180) {
                return null;
            }

            return {
                keyword,
                name: keyword,
                province: '',
                city: '',
                district: '',
                lat,
                lng,
                source: '经纬度',
                coordinateSystem: 'WGS84'
            };
        }

        async function resolveLocationKeyword(keyword) {
            const coordinate = parseCoordinateKeyword(keyword);
            if (coordinate) {
                return coordinate;
            }

            const preset = findCityPreset(keyword);
            if (preset) {
                return { ...preset, keyword, source: '城市预设', coordinateSystem: 'WGS84' };
            }

            const res = await fetchRef(`${serviceBase}/geocode/search?q=${encodeURIComponent(keyword)}`);
            const result = await res.json();
            const first = Array.isArray(result.data) ? result.data[0] : null;
            if (!result.success || !first) {
                throw new Error(`${keyword} 未定位`);
            }
            return { ...first, keyword, source: first.source || '地理编码' };
        }

        function summarizeTargetLocations(locations = []) {
            return locations
                .map(item => item.name || item.keyword || item.city || `${formatPresetCoordinate(item.lat)},${formatPresetCoordinate(item.lng)}`)
                .join('、');
        }

        function applyTargetLocationsToCollectForm(locations = []) {
            const validLocations = locations
                .map(item => {
                    const lat = Number(item.lat);
                    const lng = Number(item.lng);
                    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
                        return null;
                    }
                    return {
                        keyword: item.keyword || item.name || item.city || '',
                        name: item.name || item.keyword || item.city || '',
                        province: item.province || '',
                        city: item.city || item.name || '',
                        district: item.district || '',
                        lat,
                        lng,
                        source: item.source || '',
                        coordinateSystem: item.coordinateSystem || null
                    };
                })
                .filter(Boolean);

            if (validLocations.length === 0) {
                return false;
            }

            setState(validLocations[0], validLocations);

            const inputEl = documentRef.getElementById('collectPresetCity');
            const latEl = documentRef.getElementById('collectCenterLat');
            const lngEl = documentRef.getElementById('collectCenterLng');
            const metaEl = documentRef.getElementById('collectPresetCityMeta');

            if (inputEl && validLocations.length === 1) {
                inputEl.value = validLocations[0].keyword || validLocations[0].name || inputEl.value;
            }
            if (latEl) latEl.value = formatPresetCoordinate(validLocations[0].lat);
            if (lngEl) lngEl.value = formatPresetCoordinate(validLocations[0].lng);
            if (metaEl) {
                metaEl.textContent = validLocations.length === 1
                    ? `${validLocations[0].province || validLocations[0].city || '目标'} · 纬度 ${formatPresetCoordinate(validLocations[0].lat)} · 经度 ${formatPresetCoordinate(validLocations[0].lng)}${validLocations[0].source ? ` · ${validLocations[0].source}` : ''}`
                    : `已选择 ${validLocations.length} 个目标：${summarizeTargetLocations(validLocations)}`;
            }
            return true;
        }

        async function resolveCollectTargetLocations(centerLat = null, centerLng = null) {
            const keywords = parseCollectTargetKeywords();
            if (keywords.length === 0) {
                const fallback = buildCollectTargetLocation(centerLat, centerLng);
                if (Number.isFinite(Number(fallback.lat)) && Number.isFinite(Number(fallback.lng))) {
                    return [fallback];
                }
                throw new Error('请输入目标位置或中心经纬度');
            }

            const resolved = [];
            const state = getState();
            for (const keyword of keywords) {
                if (keywords.length === 1
                    && state.location
                    && normalizeCityPresetKeyword(state.location.keyword || state.location.name) === normalizeCityPresetKeyword(keyword)) {
                    resolved.push(buildCollectTargetLocation(centerLat, centerLng));
                    continue;
                }
                resolved.push(await resolveLocationKeyword(keyword));
            }

            applyTargetLocationsToCollectForm(resolved);
            const nextState = getState();
            return nextState.locations.length > 0 ? nextState.locations : resolved;
        }

        async function resolveCollectLocation() {
            const keyword = documentRef.getElementById('collectPresetCity')?.value?.trim() || '';
            const metaEl = documentRef.getElementById('collectPresetCityMeta');
            if (!keyword) {
                alertRef('请输入目标位置');
                return;
            }

            if (metaEl) {
                metaEl.textContent = '定位中...';
            }

            try {
                const locations = [];
                for (const item of parseCollectTargetKeywords()) {
                    locations.push(await resolveLocationKeyword(item));
                }
                if (!applyTargetLocationsToCollectForm(locations)) {
                    throw new Error('未找到可用位置');
                }
            } catch (error) {
                if (metaEl) metaEl.textContent = '定位失败';
                alertRef(`定位失败：${error.message}`);
            }
        }

        function setupCityPresetInput({ inputId, datalistId, latId, lngId, metaId, defaultCityName = '' }) {
            const inputEl = documentRef.getElementById(inputId);
            const latEl = documentRef.getElementById(latId);
            const lngEl = documentRef.getElementById(lngId);
            const metaEl = documentRef.getElementById(metaId);

            if (!inputEl || !latEl || !lngEl) {
                return;
            }

            populateCityPresetOptions(datalistId);

            const applyPreset = (city, shouldUpdateInput = true) => {
                if (!city) {
                    return false;
                }

                if (shouldUpdateInput) {
                    inputEl.value = city.name;
                }
                latEl.value = formatPresetCoordinate(city.lat);
                lngEl.value = formatPresetCoordinate(city.lng);
                const nextLocation = {
                    keyword: inputEl.value.trim() || city.name,
                    name: city.name,
                    province: city.province || '',
                    city: city.city || city.name || '',
                    district: city.district || '',
                    lat: Number(city.lat),
                    lng: Number(city.lng),
                    source: '城市预设'
                };
                setState(nextLocation, [nextLocation]);
                updateCityPresetMeta(metaEl, city);
                return true;
            };

            const clearState = (text = '') => {
                setState(null, []);
                updateCityPresetMeta(metaEl, null, text);
            };

            const syncFromInput = () => {
                const city = findCityPreset(inputEl.value);
                if (!inputEl.value.trim()) {
                    clearState();
                    return false;
                }

                if (!city) {
                    clearState('待定位');
                    return false;
                }

                return applyPreset(city, false);
            };

            inputEl.addEventListener('change', syncFromInput);
            inputEl.addEventListener('blur', syncFromInput);
            inputEl.addEventListener('input', () => {
                if (!inputEl.value.trim()) {
                    clearState();
                    return;
                }

                const city = findCityPreset(inputEl.value);
                if (city) {
                    applyPreset(city, false);
                }
            });

            if (defaultCityName && !inputEl.value.trim() && !latEl.value && !lngEl.value) {
                applyPreset(findCityPreset(defaultCityName));
                return;
            }

            if (inputEl.value.trim()) {
                syncFromInput();
                return;
            }

            updateCityPresetMeta(metaEl, null);
        }

        return {
            applyLocationToCollectForm,
            applyTargetLocationsToCollectForm,
            buildCollectTargetLocation,
            findCityPreset,
            formatPresetCoordinate,
            normalizeCityPresetKeyword,
            parseCollectTargetKeywords,
            parseCoordinateKeyword,
            populateCityPresetOptions,
            resolveCollectLocation,
            resolveCollectTargetLocations,
            resolveLocationKeyword,
            setupCityPresetInput,
            summarizeTargetLocations,
            updateCityPresetMeta
        };
    }

    global.CityLocationControl = { createController };
})(window);
