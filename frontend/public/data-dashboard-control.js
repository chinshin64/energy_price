(function attachDataDashboardControl(global) {
    'use strict';

    function requireDependency(deps, name) {
        const value = deps[name];
        if (!value) {
            throw new Error(`Data dashboard dependency missing: ${name}`);
        }
        return value;
    }

    function createController(deps = {}) {
        const documentRef = deps.document || global.document;
        const fetchImpl = requireDependency(deps, 'fetch');
        const serviceBase = requireDependency(deps, 'serviceBase');
        const escapeHtml = requireDependency(deps, 'escapeHtml');
        const formatTime = requireDependency(deps, 'formatTime');
        const getConfiguredPlatforms = requireDependency(deps, 'getConfiguredPlatforms');
        const getPlatformName = requireDependency(deps, 'getPlatformName');
        const normalizeStationRecord = requireDependency(deps, 'normalizeStationRecord');
        const renderAvailabilitySummary = requireDependency(deps, 'renderAvailabilitySummary');
        const renderPriceSummary = requireDependency(deps, 'renderPriceSummary');
        const renderSourceSummary = requireDependency(deps, 'renderSourceSummary');
        const renderStationEvidenceSummary = requireDependency(deps, 'renderStationEvidenceSummary');
        const setElementText = requireDependency(deps, 'setElementText');
        const consoleRef = deps.console || global.console;
        const openWindow = deps.openWindow || ((url, target) => global.open(url, target));

        function byId(id) {
            return documentRef.getElementById(id);
        }

        function updateOverviewDataMetrics(stats = []) {
            const rows = Array.isArray(stats) ? stats : [];
            const totalStations = rows.reduce((sum, item) => sum + (Number(item?.unique_stations) || 0), 0);
            const totalRecords = rows.reduce((sum, item) => sum + (Number(item?.total_records) || 0), 0);

            setElementText('heroStationCount', String(totalStations));
            setElementText('heroRecordCount', String(totalRecords));
        }

        function normalizePlatformStats(stats = []) {
            const rawStats = Array.isArray(stats) ? stats : [];
            const configuredPlatforms = Array.isArray(getConfiguredPlatforms()) ? getConfiguredPlatforms() : [];
            if (configuredPlatforms.length === 0) {
                return rawStats;
            }

            const statsByPlatform = new Map(rawStats.map(item => [item.platform, item]));
            const configuredIds = new Set(configuredPlatforms.map(platform => platform.id));
            const normalized = configuredPlatforms.map(platform => {
                const item = statsByPlatform.get(platform.id) || {};
                return {
                    platform: platform.id,
                    total_records: Number(item.total_records) || 0,
                    unique_stations: Number(item.unique_stations) || 0,
                    last_collected: item.last_collected || null
                };
            });

            return normalized.concat(rawStats.filter(item => item?.platform && !configuredIds.has(item.platform)));
        }

        function renderStats(platformStats = []) {
            const container = byId('statsContainer');
            if (!container) {
                return;
            }

            const rows = Array.isArray(platformStats) ? platformStats : [];
            const statsHtml = rows.map(stat => `
                <div class="stat-card">
                    <h4>${escapeHtml(getPlatformName(stat.platform))}</h4>
                    <div class="value">${Number(stat.unique_stations) || 0}</div>
                    <div style="font-size: 12px; opacity: 0.8; margin-top: 5px;">
                        ${Number(stat.total_records) || 0} 条记录
                    </div>
                </div>
            `).join('');

            container.innerHTML = statsHtml || '<div style="text-align: center; padding: 40px;">暂无数据</div>';
        }

        async function loadStats() {
            try {
                const response = await fetchImpl(`${serviceBase}/stats`);
                const result = await response.json();
                const platformStats = normalizePlatformStats(result.data || []);
                updateOverviewDataMetrics(platformStats);
                renderStats(platformStats);
            } catch (error) {
                consoleRef.error('Failed to load stats:', error);
            }
        }

        function currentPlatformFilter() {
            return byId('platformFilter')?.value || '';
        }

        function buildRecentStationsUrl(platform) {
            const query = new URLSearchParams({ limit: '300' });
            if (platform) {
                query.set('platform', platform);
            }
            return `${serviceBase}/stations/recent?${query.toString()}`;
        }

        function renderDataRows(rows = []) {
            const tableBody = byId('dataTableBody');
            if (!tableBody) {
                return;
            }

            if (!Array.isArray(rows) || rows.length === 0) {
                tableBody.innerHTML = '<tr><td colspan="8" style="text-align: center; padding: 40px;">暂无数据</td></tr>';
                return;
            }

            tableBody.innerHTML = rows.map(rawRow => {
                const row = normalizeStationRecord(rawRow);
                return `
                    <tr>
                        <td><span class="platform-chip">${escapeHtml(getPlatformName(row.platform))}</span></td>
                        <td><div class="station-name">${escapeHtml(row.station_name || '-')}</div></td>
                        <td><div class="station-address">${escapeHtml(row.address || '-')}</div></td>
                        <td>${renderPriceSummary(row)}</td>
                        <td>${renderAvailabilitySummary(row)}</td>
                        <td>${renderStationEvidenceSummary(row)}</td>
                        <td>${renderSourceSummary(row)}</td>
                        <td><span class="time-text">${escapeHtml(formatTime(row.price_gun_snapshot_at || row.snapshot_at || row.collected_at))}</span></td>
                    </tr>
                `;
            }).join('');
        }

        async function loadData() {
            try {
                const response = await fetchImpl(buildRecentStationsUrl(currentPlatformFilter()));
                const result = await response.json();
                renderDataRows(Array.isArray(result.data) ? result.data : []);
            } catch (error) {
                consoleRef.error('Failed to load data:', error);
            }
        }

        function exportCSV() {
            const platform = currentPlatformFilter();
            const query = platform ? `?platform=${encodeURIComponent(platform)}` : '';
            openWindow(`${serviceBase}/export/csv${query}`, '_blank');
        }

        return {
            exportCSV,
            loadData,
            loadStats,
            normalizePlatformStats,
            renderDataRows,
            renderStats,
            updateOverviewDataMetrics
        };
    }

    global.DataDashboardControl = { createController };
})(window);
