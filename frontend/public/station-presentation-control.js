(function attachStationPresentationControl(global) {
    'use strict';

    function requireDependency(deps, name) {
        const value = deps[name];
        if (!value) {
            throw new Error(`Station presentation dependency missing: ${name}`);
        }
        return value;
    }

    function createController(deps = {}) {
        const escapeHtml = requireDependency(deps, 'escapeHtml');
        const formatTime = requireDependency(deps, 'formatTime');

        function formatPriceCell(value) {
            if (value === null || value === undefined || value === '') {
                return '-';
            }

            return `<span class="price-text">¥${escapeHtml(value)}</span>`;
        }

        function normalizeStationRecord(record = {}) {
            const sourceTypes = getArrayField(record, ['source_types', 'sourceTypes']);
            const sourceStages = getArrayField(record, ['source_stages', 'sourceStages']);
            const sourceAgents = getArrayField(record, ['source_agents', 'sourceAgents']);
            const sourceNodes = getArrayField(record, ['source_nodes', 'sourceNodes']);
            return {
                ...record,
                platform: getFirstField(record, ['platform']) || null,
                station_id: getFirstField(record, ['station_id', 'stationId']) || null,
                station_name: getFirstField(record, ['station_name', 'stationName']) || null,
                address: getFirstField(record, ['address']) || null,
                available_ports: getNumericField(record, ['available_ports', 'availablePorts']),
                busy_ports: getNumericField(record, ['busy_ports', 'busyPorts']),
                total_ports: getNumericField(record, ['total_ports', 'totalPorts']),
                port_semantics: getFirstField(record, ['port_semantics', 'portSemantics']) || null,
                missing_fields: getArrayField(record, ['missing_fields', 'missingFields']),
                quality_status: getFirstField(record, ['quality_status', 'qualityStatus']) || null,
                price_fast: getNumericField(record, ['price_fast', 'priceFast']),
                price_slow: getNumericField(record, ['price_slow', 'priceSlow']),
                price_super: getNumericField(record, ['price_super', 'priceSuper']),
                price_service: getNumericField(record, ['price_service', 'priceService']),
                fast_idle_ports: getNumericField(record, ['fast_idle_ports', 'fastIdlePorts']),
                fast_total_ports: getNumericField(record, ['fast_total_ports', 'fastTotalPorts']),
                slow_idle_ports: getNumericField(record, ['slow_idle_ports', 'slowIdlePorts']),
                slow_total_ports: getNumericField(record, ['slow_total_ports', 'slowTotalPorts']),
                super_idle_ports: getNumericField(record, ['super_idle_ports', 'superIdlePorts']),
                super_total_ports: getNumericField(record, ['super_total_ports', 'superTotalPorts']),
                online_fast_ports: getNumericField(record, ['online_fast_ports', 'onlineFastPorts']),
                online_slow_ports: getNumericField(record, ['online_slow_ports', 'onlineSlowPorts']),
                fuel_92_price: getNumericField(record, ['fuel_92_price', 'fuel92Price']),
                fuel_95_price: getNumericField(record, ['fuel_95_price', 'fuel95Price']),
                fuel_98_price: getNumericField(record, ['fuel_98_price', 'fuel98Price']),
                fuel_diesel_price: getNumericField(record, ['fuel_diesel_price', 'fuelDieselPrice']),
                fuel_92_count: getNumericField(record, ['fuel_92_count', 'fuel92Count']),
                fuel_95_count: getNumericField(record, ['fuel_95_count', 'fuel95Count']),
                fuel_98_count: getNumericField(record, ['fuel_98_count', 'fuel98Count']),
                fuel_diesel_count: getNumericField(record, ['fuel_diesel_count', 'fuelDieselCount']),
                source_type: getFirstField(record, ['source_type', 'sourceType']) || null,
                source_stage: getFirstField(record, ['source_stage', 'sourceStage']) || null,
                source_agent: getFirstField(record, ['source_agent', 'sourceAgent']) || null,
                source_node: getFirstField(record, ['source_node', 'sourceNode']) || null,
                source_record_id: getNumericField(record, ['source_record_id', 'sourceRecordId']),
                source_types: uniqueStrings([
                    ...sourceTypes,
                    getFirstField(record, ['source_type', 'sourceType']) || null
                ]),
                source_stages: uniqueStrings([
                    ...sourceStages,
                    getFirstField(record, ['source_stage', 'sourceStage']) || null
                ]),
                source_agents: uniqueStrings([
                    ...sourceAgents,
                    getFirstField(record, ['source_agent', 'sourceAgent']) || null
                ]),
                source_nodes: uniqueStrings([
                    ...sourceNodes,
                    getFirstField(record, ['source_node', 'sourceNode']) || null
                ]),
                has_price_schedule: Boolean(getFirstField(record, ['has_price_schedule', 'hasPriceSchedule'])),
                price_schedule_types: getArrayField(record, ['price_schedule_types', 'priceScheduleTypes']),
                price_schedule_count: getNumericField(record, ['price_schedule_count', 'priceScheduleCount']),
                evidence_assets: Array.isArray(record.evidence_assets) ? record.evidence_assets : (Array.isArray(record.evidenceAssets) ? record.evidenceAssets : []),
                evidence_summary: getFirstField(record, ['evidence_summary', 'evidenceSummary']) || null,
                collected_at: getFirstField(record, ['collected_at', 'collectedAt']) || null,
                snapshot_at: getFirstField(record, ['snapshot_at', 'snapshotAt']) || null,
                price_gun_snapshot_at: getFirstField(record, ['price_gun_snapshot_at', 'priceGunSnapshotAt']) || null
            };
        }

        function getFirstField(record, keys) {
            for (const key of keys) {
                const value = record?.[key];
                if (value !== null && value !== undefined && value !== '') {
                    return value;
                }
            }
            return null;
        }

        function getNumericField(record, keys) {
            const value = getFirstField(record, keys);
            if (value === null) {
                return null;
            }

            const num = Number(value);
            return Number.isFinite(num) ? num : null;
        }

        function getArrayField(record, keys) {
            for (const key of keys) {
                const value = record?.[key];
                if (Array.isArray(value)) {
                    return uniqueStrings(value);
                }
                if (typeof value === 'string' && value.trim()) {
                    return uniqueStrings(value.split(','));
                }
            }

            return [];
        }

        function uniqueStrings(values = []) {
            return Array.from(new Set(
                values
                    .map(value => String(value || '').trim())
                    .filter(Boolean)
            ));
        }

        function parseJsonArray(value) {
            if (Array.isArray(value)) {
                return value;
            }
            if (typeof value !== 'string' || !value.trim()) {
                return [];
            }
            try {
                const parsed = JSON.parse(value);
                return Array.isArray(parsed) ? parsed : [];
            } catch (error) {
                return [];
            }
        }

        function hasPositiveNumber(value) {
            return Number.isFinite(Number(value)) && Number(value) > 0;
        }

        function isFuelPlatform(row) {
            return row.station_type === 'fuel'
                || row.stationType === 'fuel'
                || row.platform === 'tuanyou'
                || hasPositiveNumber(row.fuel_92_price)
                || hasPositiveNumber(row.fuel_95_price)
                || hasPositiveNumber(row.fuel_98_price)
                || hasPositiveNumber(row.fuel_diesel_price)
                || hasPositiveNumber(row.fuel_92_count)
                || hasPositiveNumber(row.fuel_95_count)
                || hasPositiveNumber(row.fuel_98_count)
                || hasPositiveNumber(row.fuel_diesel_count);
        }

        function formatNumericPrice(value) {
            if (!hasPositiveNumber(value)) {
                return '';
            }

            const num = Number(value);
            return num.toFixed(num % 1 === 0 ? 2 : 4).replace(/0+$/, '').replace(/\.$/, '');
        }

        function buildPriceItems(row) {
            if (isFuelPlatform(row)) {
                return [
                    buildPriceItem('fuel92', '92#', row.fuel_92_price),
                    buildPriceItem('fuel95', '95#', row.fuel_95_price),
                    buildPriceItem('fuel98', '98#', row.fuel_98_price),
                    buildPriceItem('fuelDiesel', '柴油', row.fuel_diesel_price)
                ].filter(Boolean);
            }

            return [
                buildPriceItem('fast', '快充', row.price_fast),
                buildPriceItem('slow', '慢充', row.price_slow),
                buildPriceItem('super', '超充', row.price_super),
                buildPriceItem('service', '服务费', row.price_service)
            ].filter(Boolean);
        }

        function buildPriceItem(kind, label, value) {
            if (!hasPositiveNumber(value)) {
                return null;
            }

            return {
                kind,
                label,
                primary: `¥${formatNumericPrice(value)}`
            };
        }

        function buildFuelCountItems(row) {
            return [
                buildCountItem('fuel92', '92#', row.fuel_92_count),
                buildCountItem('fuel95', '95#', row.fuel_95_count),
                buildCountItem('fuel98', '98#', row.fuel_98_count),
                buildCountItem('fuelDiesel', '柴油', row.fuel_diesel_count)
            ].filter(Boolean);
        }

        function buildFuelTypeItems(row) {
            const items = [];
            const definitions = [
                { kind: 'fuel92', label: '92#', count: row.fuel_92_count, price: row.fuel_92_price },
                { kind: 'fuel95', label: '95#', count: row.fuel_95_count, price: row.fuel_95_price },
                { kind: 'fuel98', label: '98#', count: row.fuel_98_count, price: row.fuel_98_price },
                { kind: 'fuelDiesel', label: '柴油', count: row.fuel_diesel_count, price: row.fuel_diesel_price }
            ];

            definitions.forEach(definition => {
                const normalizedCount = normalizeInt(definition.count);
                const normalizedPrice = Number(definition.price);
                const hasValidPrice = Number.isFinite(normalizedPrice) && normalizedPrice > 0;
                const hasValidCount = normalizedCount > 0;

                if (!hasValidPrice && !hasValidCount) {
                    return;
                }

                if (hasValidCount) {
                    items.push({
                        kind: definition.kind,
                        label: definition.label,
                        primary: `${normalizedCount} 枪`,
                        secondary: hasValidPrice ? `¥${normalizedPrice.toFixed(2)}` : null
                    });
                    return;
                }

                if (hasValidPrice) {
                    items.push({
                        kind: definition.kind,
                        label: definition.label,
                        primary: `¥${normalizedPrice.toFixed(2)}`,
                        secondary: null
                    });
                }
            });

            return items;
        }

        function buildCountItem(kind, label, count) {
            const normalized = normalizeInt(count);
            if (normalized <= 0) {
                return null;
            }

            return {
                kind,
                label,
                primary: `${normalized} 枪`
            };
        }

        function buildGunItems(row) {
            // 燃油侧无枪数据：燃油平台不渲染任何枪口项。
            if (isFuelPlatform(row)) {
                return [];
            }
            const items = [];
            const pushItem = (kind, label, idleValue, totalValue) => {
                const idle = normalizeInt(idleValue);
                const total = normalizeInt(totalValue);
                if (idle === 0 && total === 0) {
                    return;
                }

                items.push({
                    kind,
                    label,
                    idle,
                    total,
                    totalLabel: String(total),
                    busy: Math.max(0, total - idle),
                    hasBusy: true
                });
            };

            pushItem('fast', '快充', row.fast_idle_ports, row.fast_total_ports);
            pushItem('slow', '慢充', row.slow_idle_ports, row.slow_total_ports);
            pushItem('super', '超充', row.super_idle_ports, row.super_total_ports);

            if (items.length > 0) {
                return items;
            }

            const fallbackFast = normalizeInt(row.online_fast_ports);
            const fallbackSlow = normalizeInt(row.online_slow_ports);

            if (fallbackFast > 0) {
                items.push({
                    kind: 'fast',
                    label: '快充',
                    idle: fallbackFast,
                    total: null,
                    totalLabel: '-',
                    busy: null,
                    hasBusy: false
                });
            }

            if (fallbackSlow > 0) {
                items.push({
                    kind: 'slow',
                    label: '慢充',
                    idle: fallbackSlow,
                    total: null,
                    totalLabel: '-',
                    busy: null,
                    hasBusy: false
                });
            }

            if (items.length === 0) {
                const available = row.available_ports;
                const total = row.total_ports;
                const observedBusy = row.busy_ports;
                if ([available, observedBusy, total].some(value =>
                    value !== null && value !== undefined && value !== ''
                )) {
                    const idle = available === null || available === undefined
                        ? null
                        : normalizeInt(available);
                    const normalizedTotal = total === null || total === undefined
                        ? null
                        : normalizeInt(total);
                    const busy = observedBusy === null || observedBusy === undefined
                        ? (idle !== null && normalizedTotal !== null
                            ? Math.max(0, normalizedTotal - idle)
                            : null)
                        : normalizeInt(observedBusy);
                    items.push({
                        kind: row.port_semantics === 'fuel-gun' ? 'fuel' : 'generic',
                        label: row.port_semantics === 'fuel-gun' ? '油枪' : '枪位',
                        idle,
                        total: normalizedTotal,
                        totalLabel: normalizedTotal === null ? '-' : String(normalizedTotal),
                        busy,
                        hasBusy: busy !== null
                    });
                }
            }

            return items;
        }

        function formatGunTypeSummary(row) {
            // 燃油侧无枪数据：不返回枪口摘要。
            if (isFuelPlatform(row)) {
                return '';
            }
            const items = buildGunItems(row);
            if (items.length === 0) {
                return '枪口数据缺失';
            }

            return items.map(item => {
                const busyText = item.hasBusy ? ` 忙${item.busy}` : '';
                return `${item.label} 空闲${item.idle}/${item.totalLabel}${busyText}`;
            }).join(' | ');
        }

        function formatGunPart(label, idleValue, totalValue) {
            const idle = normalizeInt(idleValue);
            const total = normalizeInt(totalValue);
            const busy = Math.max(0, total - idle);
            if (idle === 0 && total === 0) {
                return '';
            }
            return `${label} 空闲${idle}/${total} 忙${busy}`;
        }

        function normalizeInt(value) {
            const num = Number(value);
            if (!Number.isFinite(num)) {
                return 0;
            }
            return Math.max(0, Math.round(num));
        }

        function renderGunTypeSummary(row) {
            // 燃油侧无枪数据：不渲染枪口摘要。
            if (isFuelPlatform(row)) {
                return '';
            }
            const items = buildGunItems(row);
            if (items.length === 0) {
                return '<span class="gun-empty">枪口数据缺失</span>';
            }

            return `
                <div class="gun-summary">
                    ${items.map(item => `
                        <div class="gun-line gun-${item.kind}">
                            <span class="gun-type">${escapeHtml(item.label)}</span>
                            <span class="gun-meta">空闲${item.idle}/${item.totalLabel}</span>
                            ${item.hasBusy ? `<span class="gun-busy">忙${item.busy}</span>` : ''}
                        </div>
                    `).join('')}
                </div>
            `;
        }

        function renderSummaryItems(items, emptyText) {
            if (!Array.isArray(items) || items.length === 0) {
                return `<span class="summary-empty">${escapeHtml(emptyText)}</span>`;
            }

            return `
                <div class="summary-stack">
                    ${items.map(item => `
                        <div class="summary-row summary-${escapeHtml(item.kind || 'unknown').toLowerCase()}">
                            <span class="summary-label">${escapeHtml(item.label)}</span>
                            <span class="summary-value">${escapeHtml(item.primary)}</span>
                            ${item.secondary ? `<span class="summary-muted">${escapeHtml(item.secondary)}</span>` : ''}
                        </div>
                    `).join('')}
                </div>
            `;
        }

        function renderAvailabilityItems(items, emptyText) {
            if (!Array.isArray(items) || items.length === 0) {
                return `<span class="summary-empty">${escapeHtml(emptyText)}</span>`;
            }

            return `
                <div class="availability-stack">
                    ${items.map(item => `
                        <div class="availability-row availability-${escapeHtml(item.kind || 'unknown').toLowerCase()}">
                            <span class="availability-label">${escapeHtml(item.label)}</span>
                            <span class="availability-value">${escapeHtml(item.primary)}</span>
                            ${item.secondary ? `<span class="availability-muted">${escapeHtml(item.secondary)}</span>` : ''}
                        </div>
                    `).join('')}
                </div>
            `;
        }

        function renderPriceSummary(row) {
            const base = renderSummaryItems(buildPriceItems(row), '价格数据缺失');
            if (!row.has_price_schedule) {
                return base;
            }

            const detailText = row.price_schedule_count
                ? `已保留分时价 ${row.price_schedule_count} 段`
                : '已保留分时价';
            const scheduleTypes = row.price_schedule_types
                .map(formatScheduleType)
                .filter(Boolean);
            const typeText = scheduleTypes.length > 0
                ? ` · ${escapeHtml(scheduleTypes.join(' / '))}`
                : '';

            return `${base}<div class="summary-muted price-schedule-note">${detailText}${typeText}</div>`;
        }

        function renderAvailabilitySummary(rawRow) {
            const row = normalizeStationRecord(rawRow);
            if (isFuelPlatform(row)) {
                return renderAvailabilityItems(buildFuelTypeItems(row), '油号数据缺失');
            }

            const items = buildGunItems(row).map(item => ({
                kind: item.kind,
                label: item.label,
                primary: `空闲${item.idle}/${item.totalLabel}`,
                secondary: item.hasBusy ? `忙${item.busy}` : null
            }));
            return renderAvailabilityItems(items, '枪口数据缺失');
        }

        function renderStationEvidenceSummary(rawRow) {
            const row = normalizeStationRecord(rawRow);
            const summary = row.evidence_summary || {};
            const assets = Array.isArray(row.evidence_assets) ? row.evidence_assets : [];
            const label = summary.label || (assets.length > 0 ? '证据已记录' : '待补充证据');
            const latest = summary.latestCapturedAt ? formatTime(summary.latestCapturedAt) : '';
            const imageAsset = assets.find(item => item.assetUrl);
            const chips = [];

            if (summary.screenshotCount) chips.push(`截图 ${summary.screenshotCount}`);
            if (summary.ocrTextCount) chips.push(`识别 ${summary.ocrTextCount}`);
            if (summary.screenshotHashCount) chips.push('截图指纹');

            return `
                <div class="source-stack">
                    <span class="source-chip ${summary.total ? 'page-ocr' : 'unknown'}">${escapeHtml(label)}</span>
                    ${chips.length ? `<span class="source-stage">${escapeHtml(chips.join(' / '))}</span>` : ''}
                    ${latest ? `<span class="source-stage">${escapeHtml(latest)}</span>` : ''}
                    ${imageAsset ? `<a class="source-stage" href="${escapeHtml(imageAsset.assetUrl)}" target="_blank" rel="noopener">查看截图</a>` : ''}
                </div>
            `;
        }

        function getSourceMeta(sourceType) {
            const normalized = String(sourceType || '').trim() || 'unknown';
            const map = {
                'page-ocr': { label: '页面识别', className: 'page-ocr' },
                'mitm-har': { label: '请求记录解析', className: 'mitm-har' },
                'api-crawl': { label: '业务请求验证', className: 'api-crawl' },
                'runtime-capture': { label: '运行时识别', className: 'runtime-capture' },
                'teld-runtime': { label: '运行时识别', className: 'runtime-capture' }
            };

            return map[normalized] || { label: normalized, className: 'unknown' };
        }

        function renderSourceSummary(rawRow) {
            const row = normalizeStationRecord(rawRow);
            const sourceTypes = row.source_types.length > 0
                ? row.source_types
                : (row.source_type ? [row.source_type] : []);
            const sourceStages = row.source_stages.length > 0
                ? row.source_stages
                : (row.source_stage ? [row.source_stage] : []);
            const sourceAgents = row.source_agents.length > 0
                ? row.source_agents
                : (row.source_agent ? [row.source_agent] : []);
            const sourceNodes = row.source_nodes.length > 0
                ? row.source_nodes
                : (row.source_node ? [row.source_node] : []);
            const stageLabel = sourceStages.length > 0
                ? sourceStages.map(item => item.replace(/_/g, ' ')).join(' / ')
                : '未标记阶段';

            return `
                <div class="source-stack">
                    ${(sourceTypes.length > 0 ? sourceTypes : ['unknown']).map(type => {
                        const sourceMeta = getSourceMeta(type);
                        return `<span class="source-chip ${escapeHtml(sourceMeta.className)}">${escapeHtml(sourceMeta.label)}</span>`;
                    }).join('')}
                    ${sourceAgents.map(agent => `<span class="source-stage">${escapeHtml(agent)}</span>`).join('')}
                    ${sourceNodes.map(node => `<span class="source-stage">${escapeHtml(node)}</span>`).join('')}
                    <div class="source-stage">${escapeHtml(stageLabel)}</div>
                </div>
            `;
        }

        function formatStationInlineSummary(rawRow) {
            const row = normalizeStationRecord(rawRow);
            const priceItems = buildPriceItems(row);
            const availabilityItems = isFuelPlatform(row)
                ? buildFuelTypeItems(row)
                : buildGunItems(row).map(item => ({
                    label: item.label,
                    text: `空闲${item.idle}/${item.totalLabel}${item.hasBusy ? ` 忙${item.busy}` : ''}`
                }));

            const parts = [];
            if (priceItems.length > 0) {
                parts.push(priceItems.map(item => `${item.label} ${item.primary}`).join(' / '));
            }

            if (isFuelPlatform(row)) {
                if (availabilityItems.length > 0) {
                    parts.push(availabilityItems.map(item => `${item.label} ${item.primary}${item.secondary ? ` ${item.secondary}` : ''}`).join(' / '));
                }
            } else if (availabilityItems.length > 0) {
                parts.push(availabilityItems.map(item => `${item.label} ${item.text}`).join(' / '));
            }

            if (row.has_price_schedule) {
                parts.push(`分时价已保留${row.price_schedule_count ? `(${row.price_schedule_count}段)` : ''}`);
            }

            return parts.length > 0 ? parts.join('，') : '未识别到价格或枪口信息';
        }

        function formatScheduleType(value) {
            const normalized = String(value || '');
            if (/chargingPrices/i.test(normalized)) return '星星充电分时价';
            if (/aggregatedPrices/i.test(normalized)) return '聚合分时价';
            if (/dpolicyPriceList/i.test(normalized)) return '滴滴分时价';
            if (/stubGroupDetailFeeInfos/i.test(normalized)) return '费率明细';
            return normalized.split('.').pop().replace(/\[\d+\]/g, '');
        }

        return {
            buildFuelCountItems,
            buildGunItems,
            buildPriceItems,
            formatGunPart,
            formatGunTypeSummary,
            formatPriceCell,
            formatScheduleType,
            formatStationInlineSummary,
            getSourceMeta,
            isFuelPlatform,
            normalizeStationRecord,
            parseJsonArray,
            renderAvailabilitySummary,
            renderGunTypeSummary,
            renderPriceSummary,
            renderSourceSummary,
            renderStationEvidenceSummary
        };
    }

    global.StationPresentationControl = { createController };
})(window);
