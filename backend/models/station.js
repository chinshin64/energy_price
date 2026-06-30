const db = require('../database/init');
const PriceScheduleModel = require('./price-schedule');
const OcrConfidence = require('../services/ocr-confidence');

class StationModel {
    static getDuplicateRecord(data) {
        const hasStationId = !!(data.stationId && String(data.stationId).trim());
        const hasFallbackIdentity = this.hasFallbackIdentity(data);

        if (hasStationId) {
            const byStationId = db.prepare(`
                SELECT *
                FROM stations
                WHERE platform = ?
                  AND station_id = ?
                LIMIT 1
            `).get(data.platform, String(data.stationId));

            if (byStationId) {
                return byStationId;
            }
        }

        if (hasFallbackIdentity) {
            const exactMatch = this.findByFallbackIdentity(data);
            if (exactMatch) {
                return exactMatch;
            }
            if (this.isOcrStation(data)) {
                return this.findByLooseOcrIdentity(data);
            }
        }

        return null;
    }

    static findByFallbackIdentity(data) {
        return db.prepare(`
            SELECT *
            FROM stations
            WHERE platform = ?
              AND COALESCE(station_name, '') = COALESCE(?, '')
              AND COALESCE(address, '') = COALESCE(?, '')
              AND ROUND(COALESCE(latitude, 0), 6) = ROUND(COALESCE(?, 0), 6)
              AND ROUND(COALESCE(longitude, 0), 6) = ROUND(COALESCE(?, 0), 6)
            LIMIT 1
        `).get(
            data.platform,
            data.stationName || null,
            data.address || null,
            data.latitude ?? null,
            data.longitude ?? null
        );
    }

    static findByLooseOcrIdentity(data) {
        const stationName = String(data.stationName || '').trim();
        const address = String(data.address || '').trim();
        if (!stationName && !address) {
            return null;
        }

        return db.prepare(`
            SELECT *
            FROM stations
            WHERE platform = ?
              AND (? = '' OR COALESCE(station_name, '') = ? OR COALESCE(station_name, '') = '')
              AND (? = '' OR COALESCE(address, '') = ? OR COALESCE(address, '') = '')
              AND (
                    (
                        ROUND(COALESCE(latitude, 0), 6) = ROUND(COALESCE(?, 0), 6)
                        AND ROUND(COALESCE(longitude, 0), 6) = ROUND(COALESCE(?, 0), 6)
                    )
                    OR (COALESCE(latitude, 0) = 0 AND COALESCE(longitude, 0) = 0)
                    OR (COALESCE(?, 0) = 0 AND COALESCE(?, 0) = 0)
              )
              AND (
                    COALESCE(source_type, '') IN ('mobile-ocr', 'ocr', '')
                    OR COALESCE(source_stage, '') LIKE 'phone-%'
              )
            ORDER BY
                CASE WHEN COALESCE(station_name, '') = ? THEN 0 ELSE 1 END,
                CASE WHEN COALESCE(address, '') = ? THEN 0 ELSE 1 END,
                datetime(COALESCE(snapshot_at, collected_at)) DESC,
                id DESC
            LIMIT 1
        `).get(
            data.platform,
            stationName,
            stationName,
            address,
            address,
            data.latitude ?? null,
            data.longitude ?? null,
            data.latitude ?? null,
            data.longitude ?? null,
            stationName,
            address
        );
    }

    static hasFallbackIdentity(data = {}) {
        return [
            data.stationName,
            data.address,
            data.latitude,
            data.longitude
        ].some(value => value !== null && value !== undefined && String(value).trim() !== '');
    }

    static isOcrStation(data = {}) {
        const sourceType = String(data.sourceType || data.raw?.sourceType || data.raw?.source || '').trim();
        const sourceStage = String(data.sourceStage || data.raw?.sourceStage || data.raw?.stage || '').trim();
        return sourceType === 'mobile-ocr'
            || sourceType === 'ocr'
            || sourceStage.startsWith('phone-');
    }

    static insert(data) {
        // 只验证 platform 是否存在
        if (!data.platform) {
            console.warn('跳过无效数据：缺少 platform', data);
            return null;
        }
        data = this.sanitizeIncomingData(data);

        const duplicateRecord = this.shouldMergeIntoExisting(data)
            ? this.getDuplicateRecord(data)
            : null;
        if (duplicateRecord) {
            return this.updateExisting(duplicateRecord, data);
        }

        const stmt = db.prepare(`
            INSERT OR IGNORE INTO stations (
                platform, station_id, station_name, address,
                latitude, longitude, price_fast, price_slow, price_super, price_service,
                available_ports, total_ports, online_fast_ports, online_slow_ports,
                fast_idle_ports, fast_total_ports, slow_idle_ports, slow_total_ports, super_idle_ports, super_total_ports,
                fuel_92_price, fuel_95_price, fuel_98_price, fuel_diesel_price,
                fuel_92_count, fuel_95_count, fuel_98_count, fuel_diesel_count,
                source_type, source_stage,
                raw_data, collected_at, snapshot_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const sourceType = data.sourceType
            || data.raw?.sourceType
            || data.raw?.source
            || null;
        const sourceStage = data.sourceStage
            || data.raw?.sourceStage
            || data.raw?.stage
            || null;
        const snapshotAt = this.normalizeSnapshotTime(data);

        const result = stmt.run(
            data.platform,
            data.stationId || null,
            data.stationName || null,  // 允许为 null
            data.address || null,
            data.latitude,
            data.longitude,
            data.priceFast,
            data.priceSlow,
            data.priceSuper,
            data.priceService,
            data.availablePorts,
            data.totalPorts,
            data.onlineFastPorts,
            data.onlineSlowPorts,
            data.fastIdlePorts ?? 0,
            data.fastTotalPorts ?? 0,
            data.slowIdlePorts ?? 0,
            data.slowTotalPorts ?? 0,
            data.superIdlePorts ?? 0,
            data.superTotalPorts ?? 0,
            data.fuel92Price ?? null,
            data.fuel95Price ?? null,
            data.fuel98Price ?? null,
            data.fuelDieselPrice ?? null,
            data.fuel92Count ?? null,
            data.fuel95Count ?? null,
            data.fuel98Count ?? null,
            data.fuelDieselCount ?? null,
            sourceType,
            sourceStage,
            JSON.stringify(data.raw),
            snapshotAt,
            snapshotAt
        );

        if (!result.changes) {
            return null;
        }

        // 提取并保存分时价格
        if (result.lastInsertRowid && data.raw) {
            const schedules = PriceScheduleModel.extractFromRawData(
                data.raw,
                data.platform,
                result.lastInsertRowid,
                sourceType,
                sourceStage
            );
            if (schedules.length > 0) {
                PriceScheduleModel.insertBatch(schedules);
            }
        }

        return result;
    }

    static updateExisting(existing, data) {
        const sourceType = data.sourceType
            || data.raw?.sourceType
            || data.raw?.source
            || existing.source_type
            || null;
        const sourceStage = data.sourceStage
            || data.raw?.sourceStage
            || data.raw?.stage
            || existing.source_stage
            || null;
        const rawData = this.pickBestRaw(existing.raw_data, data.raw);

        const merged = {
            stationId: this.pickBestString(existing.station_id, data.stationId),
            stationName: this.pickBestString(existing.station_name, data.stationName),
            address: this.pickBestString(existing.address, data.address),
            latitude: this.pickBestNumber(existing.latitude, data.latitude),
            longitude: this.pickBestNumber(existing.longitude, data.longitude),
            priceFast: this.pickBestEnergyPrice(existing.price_fast, data.priceFast),
            priceSlow: this.pickBestEnergyPrice(existing.price_slow, data.priceSlow),
            priceSuper: this.pickBestEnergyPrice(existing.price_super, data.priceSuper),
            priceService: this.pickBestNumber(existing.price_service, data.priceService),
            availablePorts: this.pickMaxNumber(existing.available_ports, data.availablePorts),
            totalPorts: this.pickMaxNumber(existing.total_ports, data.totalPorts),
            onlineFastPorts: this.pickMaxNumber(existing.online_fast_ports, data.onlineFastPorts),
            onlineSlowPorts: this.pickMaxNumber(existing.online_slow_ports, data.onlineSlowPorts),
            fastIdlePorts: this.pickMaxNumber(existing.fast_idle_ports, data.fastIdlePorts),
            fastTotalPorts: this.pickMaxNumber(existing.fast_total_ports, data.fastTotalPorts),
            slowIdlePorts: this.pickMaxNumber(existing.slow_idle_ports, data.slowIdlePorts),
            slowTotalPorts: this.pickMaxNumber(existing.slow_total_ports, data.slowTotalPorts),
            superIdlePorts: this.pickMaxNumber(existing.super_idle_ports, data.superIdlePorts),
            superTotalPorts: this.pickMaxNumber(existing.super_total_ports, data.superTotalPorts),
            fuel92Price: this.pickBestNumber(existing.fuel_92_price, data.fuel92Price),
            fuel95Price: this.pickBestNumber(existing.fuel_95_price, data.fuel95Price),
            fuel98Price: this.pickBestNumber(existing.fuel_98_price, data.fuel98Price),
            fuelDieselPrice: this.pickBestNumber(existing.fuel_diesel_price, data.fuelDieselPrice),
            fuel92Count: this.pickMaxNumber(existing.fuel_92_count, data.fuel92Count),
            fuel95Count: this.pickMaxNumber(existing.fuel_95_count, data.fuel95Count),
            fuel98Count: this.pickMaxNumber(existing.fuel_98_count, data.fuel98Count),
            fuelDieselCount: this.pickMaxNumber(existing.fuel_diesel_count, data.fuelDieselCount)
        };

        const stmt = db.prepare(`
            UPDATE stations
            SET
                station_id = ?,
                station_name = ?,
                address = ?,
                latitude = ?,
                longitude = ?,
                price_fast = ?,
                price_slow = ?,
                price_super = ?,
                price_service = ?,
                available_ports = ?,
                total_ports = ?,
                online_fast_ports = ?,
                online_slow_ports = ?,
                fast_idle_ports = ?,
                fast_total_ports = ?,
                slow_idle_ports = ?,
                slow_total_ports = ?,
                super_idle_ports = ?,
                super_total_ports = ?,
                fuel_92_price = ?,
                fuel_95_price = ?,
                fuel_98_price = ?,
                fuel_diesel_price = ?,
                fuel_92_count = ?,
                fuel_95_count = ?,
                fuel_98_count = ?,
                fuel_diesel_count = ?,
                source_type = ?,
                source_stage = ?,
                raw_data = ?,
                collected_at = ?,
                snapshot_at = ?
            WHERE id = ?
        `);
        const snapshotAt = this.normalizeSnapshotTime(data);

        const result = stmt.run(
            merged.stationId,
            merged.stationName,
            merged.address,
            merged.latitude,
            merged.longitude,
            merged.priceFast,
            merged.priceSlow,
            merged.priceSuper,
            merged.priceService,
            merged.availablePorts,
            merged.totalPorts,
            merged.onlineFastPorts,
            merged.onlineSlowPorts,
            merged.fastIdlePorts,
            merged.fastTotalPorts,
            merged.slowIdlePorts,
            merged.slowTotalPorts,
            merged.superIdlePorts,
            merged.superTotalPorts,
            merged.fuel92Price,
            merged.fuel95Price,
            merged.fuel98Price,
            merged.fuelDieselPrice,
            merged.fuel92Count,
            merged.fuel95Count,
            merged.fuel98Count,
            merged.fuelDieselCount,
            sourceType,
            sourceStage,
            rawData,
            snapshotAt,
            snapshotAt,
            existing.id
        );

        // 更新时也提取分时价格
        if (existing.id && data.raw) {
            const schedules = PriceScheduleModel.extractFromRawData(
                data.raw,
                data.platform || existing.platform,
                existing.id,
                sourceType,
                sourceStage
            );
            if (schedules.length > 0) {
                PriceScheduleModel.deleteByStationId(existing.id);
                PriceScheduleModel.insertBatch(schedules);
            }
        }

        return result;
    }

    static insertBatch(dataArray) {
        const insert = db.transaction((stations) => {
            let successCount = 0;
            let skipCount = 0;
            let redCount = 0;
            let yellowCount = 0;

            const { green, yellow, red, results } = OcrConfidence.batchEvaluate(stations);

            for (const station of green) {
                delete station._confidenceResult;
                const result = this.insert(station);
                if (result) {
                    successCount++;
                } else {
                    skipCount++;
                }
            }

            for (const station of yellow) {
                const confResult = station._confidenceResult;
                delete station._confidenceResult;
                station.needsReview = true;
                station._confidenceScore = confResult.score;
                station._confidenceDimensions = confResult.dimensions;
                const result = this.insert(station);
                if (result) {
                    this.markNeedsReview(result.lastInsertRowid);
                    yellowCount++;
                } else {
                    skipCount++;
                }
            }

            redCount = red.length;

            console.log(`批量插入完成: 成功 ${successCount}, 待审核 ${yellowCount}, 红灯拦截 ${redCount}, 跳过 ${skipCount}`);
            return { successCount, skipCount, redCount, yellowCount, details: results.map(r => ({ light: r.result.light, score: r.result.score, hardRules: r.result.hardRules })) };
        });
        return insert(dataArray);
    }

    static deduplicateExisting() {
        const duplicateRows = db.prepare(`
            WITH ranked AS (
                SELECT
                    id,
                    ROW_NUMBER() OVER (
                        PARTITION BY
                            platform,
                            CASE
                                WHEN station_id IS NOT NULL AND station_id != ''
                                    THEN 'id:' || station_id
                                ELSE 'fallback:' ||
                                    COALESCE(station_name, '') || '|' ||
                                    COALESCE(address, '') || '|' ||
                                    ROUND(COALESCE(latitude, 0), 6) || '|' ||
                                    ROUND(COALESCE(longitude, 0), 6)
                            END,
                            COALESCE(snapshot_at, collected_at)
                        ORDER BY id DESC
                    ) AS rn
                FROM stations
            )
            SELECT id
            FROM ranked
            WHERE rn > 1
        `).all();

        if (duplicateRows.length === 0) {
            return { removed: 0 };
        }

        const deleteStmt = db.prepare(`DELETE FROM stations WHERE id = ?`);
        const remove = db.transaction((rows) => {
            let removed = 0;
            for (const row of rows) {
                const result = deleteStmt.run(row.id);
                removed += result.changes;
            }
            return removed;
        });

        return { removed: remove(duplicateRows) };
    }

    static getRecent(limit = 100, platform = null) {
        const safeLimit = Math.max(1, Math.min(1000, Number(limit) || 100));
        const fetchLimit = Math.max(safeLimit, Math.min(5000, safeLimit * 12));
        let query = 'SELECT * FROM stations';
        const params = [];

        if (platform) {
            query += ' WHERE platform = ?';
            params.push(platform);
        }

        query += ' ORDER BY datetime(COALESCE(snapshot_at, collected_at)) DESC, id DESC LIMIT ?';
        params.push(fetchLimit);

        const rows = db.prepare(query).all(...params);
        return this.buildUnifiedRows(rows).slice(0, safeLimit);
    }

    static getByDateRange(startDate, endDate, platform = null) {
        let query = 'SELECT * FROM stations WHERE COALESCE(snapshot_at, collected_at) BETWEEN ? AND ?';
        const params = [startDate, endDate];

        if (platform) {
            query += ' AND platform = ?';
            params.push(platform);
        }

        query += ' ORDER BY datetime(COALESCE(snapshot_at, collected_at)) DESC, id DESC';
        return db.prepare(query).all(...params);
    }

    static getStatistics() {
        const rawStats = db.prepare(`
            SELECT
                platform,
                COUNT(*) as total_records,
                MAX(COALESCE(snapshot_at, collected_at)) as last_collected
            FROM stations
            GROUP BY platform
        `).all();

        const unifiedRows = this.buildUnifiedRows(
            db.prepare(`
                SELECT *
                FROM stations
                ORDER BY datetime(COALESCE(snapshot_at, collected_at)) DESC, id DESC
            `).all()
        );
        const uniqueCountByPlatform = new Map();

        for (const row of unifiedRows) {
            uniqueCountByPlatform.set(
                row.platform,
                (uniqueCountByPlatform.get(row.platform) || 0) + 1
            );
        }

        return rawStats.map(item => ({
            ...item,
            unique_stations: uniqueCountByPlatform.get(item.platform) || 0
        }));
    }

    static getNearbySeeds(platform, centerLat, centerLng, radiusKm = 10, limit = 500) {
        const lat = Number(centerLat);
        const lng = Number(centerLng);
        const radius = Math.max(0.1, Number(radiusKm) || 10);
        const safeLimit = Math.max(1, Math.min(5000, Number(limit) || 500));

        const latDelta = radius / 111;
        const lngDelta = radius / (111 * Math.max(0.1, Math.cos(lat * Math.PI / 180)));

        const rows = db.prepare(`
            SELECT *
            FROM stations
            WHERE platform = ?
              AND latitude BETWEEN ? AND ?
              AND longitude BETWEEN ? AND ?
            ORDER BY datetime(COALESCE(snapshot_at, collected_at)) DESC, id DESC
            LIMIT ?
        `).all(
            platform,
            lat - latDelta,
            lat + latDelta,
            lng - lngDelta,
            lng + lngDelta,
            safeLimit
        );

        return rows.map(row => ({
            ...row,
            raw: this.safeParse(row.raw_data)
        }));
    }

    static safeParse(text) {
        if (!text) {
            return null;
        }

        try {
            return JSON.parse(text);
        } catch (error) {
            return null;
        }
    }

    static shouldMergeIntoExisting(data = {}) {
        return String(data.snapshotMode || data.raw?.snapshotMode || '').toLowerCase() === 'merge';
    }

    static sanitizeIncomingData(data = {}) {
        return {
            ...data,
            priceFast: this.normalizeEnergyPrice(data.priceFast),
            priceSlow: this.normalizeEnergyPrice(data.priceSlow),
            priceSuper: this.normalizeEnergyPrice(data.priceSuper)
        };
    }

    static normalizeSnapshotTime(data = {}) {
        const candidates = [
            data.snapshotAt,
            data.sampledAt,
            data.collectedAt,
            data.capturedAt,
            data.raw?.snapshotAt,
            data.raw?.sampledAt,
            data.raw?.collectedAt,
            data.raw?.capturedAt,
            data.raw?.mobileSync?.meta?.capturedAt
        ];

        for (const candidate of candidates) {
            const normalized = this.toSqlDateTime(candidate);
            if (normalized) {
                return normalized;
            }
        }

        return this.toSqlDateTime(new Date());
    }

    static toSqlDateTime(value) {
        if (!value) {
            return null;
        }

        const date = value instanceof Date ? value : new Date(value);
        if (Number.isNaN(date.getTime())) {
            return null;
        }

        const pad = number => String(number).padStart(2, '0');
        return [
            date.getFullYear(),
            pad(date.getMonth() + 1),
            pad(date.getDate())
        ].join('-') + ' ' + [
            pad(date.getHours()),
            pad(date.getMinutes()),
            pad(date.getSeconds())
        ].join(':');
    }

    static normalizeEnergyPrice(value) {
        if (value === null || value === undefined || value === '') {
            return null;
        }
        const number = Number(value);
        if (!Number.isFinite(number) || number < 0.2 || number > 3.5) {
            return null;
        }
        return value;
    }

    static pickBestString(currentValue, incomingValue) {
        const current = String(currentValue || '').trim();
        const incoming = String(incomingValue || '').trim();
        if (!incoming) {
            return currentValue ?? null;
        }
        if (!current) {
            return incomingValue;
        }
        return incoming.length > current.length ? incomingValue : currentValue;
    }

    static pickBestNumber(currentValue, incomingValue) {
        const current = Number(currentValue);
        const incoming = Number(incomingValue);
        const hasCurrent = Number.isFinite(current);
        const hasIncoming = Number.isFinite(incoming);

        if (!hasIncoming) {
            return hasCurrent ? currentValue : null;
        }
        if (!hasCurrent) {
            return incomingValue;
        }
        if (incoming > 0 && current <= 0) {
            return incomingValue;
        }

        const currentPrecision = this.getNumericPrecision(current);
        const incomingPrecision = this.getNumericPrecision(incoming);
        if (incoming > 0 && incomingPrecision > currentPrecision) {
            return incomingValue;
        }

        return currentValue;
    }

    static pickBestEnergyPrice(currentValue, incomingValue) {
        return this.pickBestNumber(
            this.normalizeEnergyPrice(currentValue),
            this.normalizeEnergyPrice(incomingValue)
        );
    }

    static pickMaxNumber(currentValue, incomingValue) {
        const current = Number(currentValue);
        const incoming = Number(incomingValue);
        const hasCurrent = Number.isFinite(current);
        const hasIncoming = Number.isFinite(incoming);

        if (!hasIncoming) {
            return hasCurrent ? currentValue : null;
        }
        if (!hasCurrent) {
            return incomingValue;
        }

        return incoming > current ? incomingValue : currentValue;
    }

    static getNumericPrecision(value) {
        const text = String(value ?? '');
        const index = text.indexOf('.');
        return index >= 0 ? text.length - index - 1 : 0;
    }

    static pickBestRaw(currentText, incomingRaw) {
        const incomingText = incomingRaw ? JSON.stringify(incomingRaw) : null;
        if (!incomingText) {
            return currentText || null;
        }
        if (!currentText) {
            return incomingText;
        }

        return incomingText.length >= currentText.length ? incomingText : currentText;
    }

    static buildUnifiedRows(rows = []) {
        const bestByKey = new Map();

        for (const row of rows) {
            const normalized = this.normalizeRowForView(row);
            const keys = this.getStoredDedupKeys(normalized);
            if (keys.length === 0) {
                continue;
            }

            const existing = keys.map(key => bestByKey.get(key)).find(Boolean) || null;
            const merged = existing
                ? this.mergeStoredRows(existing, normalized)
                : normalized;

            for (const key of this.getStoredDedupKeys(merged)) {
                bestByKey.set(key, merged);
            }
        }

        const mergedRows = Array.from(new Set(bestByKey.values()))
            .sort((a, b) => this.compareRowsByFreshness(a, b));
        const stationIds = mergedRows.flatMap(row => this.getSourceStationIds(row));
        const priceScheduleSummaryMap = PriceScheduleModel.getSummaryMapByStationIds(stationIds);

        return mergedRows.map(row => this.decorateRowForView(row, priceScheduleSummaryMap));
    }

    static normalizeRowForView(row = {}) {
        const raw = this.safeParse(row.raw_data);
        return {
            ...row,
            snapshot_at: row.snapshot_at || row.collected_at || null,
            raw,
            source_station_ids: this.uniqueNumericList([row.id]),
            source_types: this.toStringList(row.source_type),
            source_stages: this.toStringList(row.source_stage)
        };
    }

    static decorateRowForView(row = {}, priceScheduleSummaryMap = new Map()) {
        const priceScheduleMeta = this.buildPriceScheduleMeta(row, priceScheduleSummaryMap);
        return {
            ...row,
            price_gun_snapshot_at: row.snapshot_at || row.collected_at || null,
            source_types: this.uniqueStringList(row.source_types),
            source_stages: this.uniqueStringList(row.source_stages),
            has_price_schedule: priceScheduleMeta.hasPriceSchedule,
            price_schedule_types: priceScheduleMeta.types,
            price_schedule_count: priceScheduleMeta.count,
            price_schedule_min_price: priceScheduleMeta.minPrice,
            price_schedule_max_price: priceScheduleMeta.maxPrice,
            price_schedule_min_service_fee: priceScheduleMeta.minServiceFee,
            price_schedule_max_service_fee: priceScheduleMeta.maxServiceFee
        };
    }

    static buildPriceScheduleMeta(row = {}, priceScheduleSummaryMap = new Map()) {
        const stationIds = this.getSourceStationIds(row);
        const fromTable = this.mergePriceScheduleSummaries(stationIds, priceScheduleSummaryMap);
        if (fromTable.hasPriceSchedule) {
            return fromTable;
        }

        return this.inspectPriceSchedule(row.raw);
    }

    static getStoredDedupKeys(row = {}) {
        const keys = [];
        const platform = row.platform || '';
        const stationId = String(row.station_id || '').trim();
        if (stationId) {
            keys.push(`${platform}|id:${stationId}`);
        }

        const fallbackParts = [
            String(row.station_name || '').trim(),
            String(row.address || '').trim(),
            this.normalizeCoordinate(row.latitude),
            this.normalizeCoordinate(row.longitude)
        ];
        if (fallbackParts.some(Boolean)) {
            keys.push([platform, ...fallbackParts].join('|'));
        }

        return keys;
    }

    static mergeStoredRows(existing, incoming) {
        const merged = { ...existing };
        const freshest = this.compareRowsByFreshness(existing, incoming) <= 0 ? existing : incoming;
        merged.id = freshest.id;
        merged.platform = this.pickBestString(existing.platform, incoming.platform);
        merged.station_id = this.pickBestString(existing.station_id, incoming.station_id);
        merged.station_name = this.pickBestString(existing.station_name, incoming.station_name);
        merged.address = this.pickBestString(existing.address, incoming.address);
        merged.latitude = this.pickBestNumber(existing.latitude, incoming.latitude);
        merged.longitude = this.pickBestNumber(existing.longitude, incoming.longitude);
        merged.price_fast = this.pickSnapshotField(freshest, existing, incoming, 'price_fast');
        merged.price_slow = this.pickSnapshotField(freshest, existing, incoming, 'price_slow');
        merged.price_super = this.pickSnapshotField(freshest, existing, incoming, 'price_super');
        merged.price_service = this.pickSnapshotField(freshest, existing, incoming, 'price_service');
        merged.available_ports = this.pickSnapshotField(freshest, existing, incoming, 'available_ports');
        merged.total_ports = this.pickSnapshotField(freshest, existing, incoming, 'total_ports');
        merged.online_fast_ports = this.pickSnapshotField(freshest, existing, incoming, 'online_fast_ports');
        merged.online_slow_ports = this.pickSnapshotField(freshest, existing, incoming, 'online_slow_ports');
        merged.fast_idle_ports = this.pickSnapshotField(freshest, existing, incoming, 'fast_idle_ports');
        merged.fast_total_ports = this.pickSnapshotField(freshest, existing, incoming, 'fast_total_ports');
        merged.slow_idle_ports = this.pickSnapshotField(freshest, existing, incoming, 'slow_idle_ports');
        merged.slow_total_ports = this.pickSnapshotField(freshest, existing, incoming, 'slow_total_ports');
        merged.super_idle_ports = this.pickSnapshotField(freshest, existing, incoming, 'super_idle_ports');
        merged.super_total_ports = this.pickSnapshotField(freshest, existing, incoming, 'super_total_ports');
        merged.fuel_92_price = this.pickSnapshotField(freshest, existing, incoming, 'fuel_92_price');
        merged.fuel_95_price = this.pickSnapshotField(freshest, existing, incoming, 'fuel_95_price');
        merged.fuel_98_price = this.pickSnapshotField(freshest, existing, incoming, 'fuel_98_price');
        merged.fuel_diesel_price = this.pickSnapshotField(freshest, existing, incoming, 'fuel_diesel_price');
        merged.fuel_92_count = this.pickSnapshotField(freshest, existing, incoming, 'fuel_92_count');
        merged.fuel_95_count = this.pickSnapshotField(freshest, existing, incoming, 'fuel_95_count');
        merged.fuel_98_count = this.pickSnapshotField(freshest, existing, incoming, 'fuel_98_count');
        merged.fuel_diesel_count = this.pickSnapshotField(freshest, existing, incoming, 'fuel_diesel_count');
        merged.source_type = freshest.source_type || existing.source_type || incoming.source_type || null;
        merged.source_stage = freshest.source_stage || existing.source_stage || incoming.source_stage || null;
        merged.source_station_ids = this.uniqueNumericList([
            ...this.getSourceStationIds(existing),
            ...this.getSourceStationIds(incoming)
        ]);
        merged.source_types = this.uniqueStringList([
            ...this.toStringList(existing.source_types),
            ...this.toStringList(incoming.source_types),
            ...this.toStringList(existing.source_type),
            ...this.toStringList(incoming.source_type)
        ]);
        merged.source_stages = this.uniqueStringList([
            ...this.toStringList(existing.source_stages),
            ...this.toStringList(incoming.source_stages),
            ...this.toStringList(existing.source_stage),
            ...this.toStringList(incoming.source_stage)
        ]);
        merged.raw_data = this.pickBestRaw(existing.raw_data, incoming.raw || incoming.raw_data);
        merged.raw = this.safeParse(merged.raw_data);
        merged.collected_at = this.pickLatestTimestamp(existing.collected_at, incoming.collected_at);
        merged.snapshot_at = this.pickLatestTimestamp(existing.snapshot_at, incoming.snapshot_at);
        return merged;
    }

    static pickSnapshotField(freshest = {}, existing = {}, incoming = {}, field) {
        const freshValue = freshest[field];
        if (freshValue !== null && freshValue !== undefined && freshValue !== '') {
            return freshValue;
        }

        const fallback = freshest === existing ? incoming : existing;
        return fallback?.[field] ?? null;
    }

    static compareRowsByFreshness(left, right) {
        const leftTime = new Date(left?.snapshot_at || left?.collected_at || 0).getTime() || 0;
        const rightTime = new Date(right?.snapshot_at || right?.collected_at || 0).getTime() || 0;

        if (rightTime !== leftTime) {
            return rightTime - leftTime;
        }

        return Number(right?.id || 0) - Number(left?.id || 0);
    }

    static pickLatestTimestamp(currentValue, incomingValue) {
        const currentTime = new Date(currentValue || 0).getTime() || 0;
        const incomingTime = new Date(incomingValue || 0).getTime() || 0;
        return incomingTime >= currentTime ? incomingValue : currentValue;
    }

    static normalizeCoordinate(value) {
        const num = Number(value);
        if (!Number.isFinite(num)) {
            return '';
        }
        return num.toFixed(6);
    }

    static toStringList(value) {
        if (Array.isArray(value)) {
            return value
                .map(item => String(item || '').trim())
                .filter(Boolean);
        }

        const normalized = String(value || '').trim();
        return normalized ? [normalized] : [];
    }

    static uniqueStringList(values = []) {
        return Array.from(new Set(this.toStringList(values)));
    }

    static uniqueNumericList(values = []) {
        return Array.from(new Set(
            (Array.isArray(values) ? values : [values])
                .map(value => Number(value))
                .filter(Number.isInteger)
                .filter(value => value > 0)
        ));
    }

    static getSourceStationIds(row = {}) {
        return this.uniqueNumericList([
            ...(Array.isArray(row.source_station_ids) ? row.source_station_ids : []),
            row.id
        ]);
    }

    static mergePriceScheduleSummaries(stationIds = [], summaryMap = new Map()) {
        const summary = {
            hasPriceSchedule: false,
            count: 0,
            types: [],
            minPrice: null,
            maxPrice: null,
            minServiceFee: null,
            maxServiceFee: null
        };

        for (const stationId of this.uniqueNumericList(stationIds)) {
            const current = summaryMap.get(stationId);
            if (!current) {
                continue;
            }

            summary.hasPriceSchedule = summary.hasPriceSchedule || Boolean(current.hasPriceSchedule);
            summary.count += Number(current.count) || 0;
            summary.types.push(...this.toStringList(current.types));
            summary.minPrice = this.pickMinNumber(summary.minPrice, current.minPrice);
            summary.maxPrice = this.pickMaxNullableNumber(summary.maxPrice, current.maxPrice);
            summary.minServiceFee = this.pickMinNumber(summary.minServiceFee, current.minServiceFee);
            summary.maxServiceFee = this.pickMaxNullableNumber(summary.maxServiceFee, current.maxServiceFee);
        }

        summary.types = this.uniqueStringList(summary.types);
        return summary;
    }

    static inspectPriceSchedule(raw) {
        const summary = {
            hasPriceSchedule: false,
            count: 0,
            types: [],
            minPrice: null,
            maxPrice: null,
            minServiceFee: null,
            maxServiceFee: null
        };

        const seen = new Set();

        const visit = (node, pathKey = '', depth = 0) => {
            if (!node || depth > 6 || seen.has(node)) {
                return;
            }

            if (typeof node === 'object') {
                seen.add(node);
            }

            if (Array.isArray(node)) {
                if (this.looksLikePriceScheduleArray(node, pathKey)) {
                    summary.hasPriceSchedule = true;
                    summary.count += node.length;
                    summary.types.push(pathKey || 'timeslots');
                }

                node.forEach((item, index) => visit(item, `${pathKey}[${index}]`, depth + 1));
                return;
            }

            if (typeof node !== 'object') {
                return;
            }

            Object.entries(node).forEach(([key, value]) => {
                visit(value, pathKey ? `${pathKey}.${key}` : key, depth + 1);
            });
        };

        visit(raw);
        summary.types = Array.from(new Set(summary.types));
        return summary;
    }

    static looksLikePriceScheduleArray(items, pathKey = '') {
        if (!Array.isArray(items) || items.length === 0) {
            return false;
        }

        const scheduleKeyPattern = /(chargingPrices|aggregatedPrices|dpolicyPriceList|stubGroupDetailFeeInfos)/i;
        if (scheduleKeyPattern.test(String(pathKey || ''))) {
            return true;
        }

        return items.some(item => this.looksLikePriceScheduleEntry(item));
    }

    static looksLikePriceScheduleEntry(item) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            return false;
        }

        const keys = Object.keys(item);
        const hasTimeField = keys.some(key => /(start|end|time|period)/i.test(key));
        const hasPriceField = keys.some(key => /(price|fee|amount)/i.test(key));
        return hasTimeField && hasPriceField;
    }

    static pickMinNumber(currentValue, incomingValue) {
        const current = Number(currentValue);
        const incoming = Number(incomingValue);
        const hasCurrent = Number.isFinite(current);
        const hasIncoming = Number.isFinite(incoming);

        if (!hasIncoming) {
            return hasCurrent ? currentValue : null;
        }
        if (!hasCurrent) {
            return incomingValue;
        }

        return incoming < current ? incomingValue : currentValue;
    }

    static pickMaxNullableNumber(currentValue, incomingValue) {
        const current = Number(currentValue);
        const incoming = Number(incomingValue);
        const hasCurrent = Number.isFinite(current);
        const hasIncoming = Number.isFinite(incoming);

        if (!hasIncoming) {
            return hasCurrent ? currentValue : null;
        }
        if (!hasCurrent) {
            return incomingValue;
        }

        return incoming > current ? incomingValue : currentValue;
    }

    // ── OCR 置信度审核相关方法 ──

    static markNeedsReview(stationRowId) {
        const stationColumns = db.prepare('PRAGMA table_info(stations)').all().map(col => col.name);
        if (!stationColumns.includes('needs_review')) {
            db.exec('ALTER TABLE stations ADD COLUMN needs_review INTEGER DEFAULT 0');
        }
        if (!stationColumns.includes('confidence_score')) {
            db.exec('ALTER TABLE stations ADD COLUMN confidence_score INTEGER');
        }
        if (!stationColumns.includes('confidence_dimensions')) {
            db.exec('ALTER TABLE stations ADD COLUMN confidence_dimensions TEXT');
        }
        db.prepare('UPDATE stations SET needs_review = 1 WHERE id = ?').run(stationRowId);
    }

    static saveConfidenceMeta(stationRowId, score, dimensions) {
        const stationColumns = db.prepare('PRAGMA table_info(stations)').all().map(col => col.name);
        if (!stationColumns.includes('confidence_score')) {
            db.exec('ALTER TABLE stations ADD COLUMN confidence_score INTEGER');
        }
        if (!stationColumns.includes('confidence_dimensions')) {
            db.exec('ALTER TABLE stations ADD COLUMN confidence_dimensions TEXT');
        }
        db.prepare('UPDATE stations SET confidence_score = ?, confidence_dimensions = ? WHERE id = ?')
            .run(score, JSON.stringify(dimensions || {}), stationRowId);
    }

    static getPendingReview(limit = 100, offset = 0) {
        const safeLimit = Math.max(1, Math.min(1000, Number(limit) || 100));
        const safeOffset = Math.max(0, Number(offset) || 0);

        const stationColumns = db.prepare('PRAGMA table_info(stations)').all().map(col => col.name);
        if (!stationColumns.includes('needs_review')) {
            return [];
        }

        const rows = db.prepare(
            'SELECT * FROM stations WHERE needs_review = 1 ORDER BY id DESC LIMIT ? OFFSET ?'
        ).all(safeLimit, safeOffset);

        return rows;
    }

    static getPendingReviewCount() {
        const stationColumns = db.prepare('PRAGMA table_info(stations)').all().map(col => col.name);
        if (!stationColumns.includes('needs_review')) {
            return 0;
        }
        const row = db.prepare('SELECT COUNT(*) AS cnt FROM stations WHERE needs_review = 1').get();
        return Number(row?.cnt || 0);
    }

    static approveStation(id) {
        const stationColumns = db.prepare('PRAGMA table_info(stations)').all().map(col => col.name);
        if (!stationColumns.includes('needs_review')) {
            return { changes: 0 };
        }
        return db.prepare('UPDATE stations SET needs_review = 0 WHERE id = ? AND needs_review = 1').run(id);
    }

    static rejectStation(id) {
        const stationColumns = db.prepare('PRAGMA table_info(stations)').all().map(col => col.name);
        if (!stationColumns.includes('needs_review')) {
            return { changes: 0 };
        }
        const row = db.prepare('SELECT * FROM stations WHERE id = ? AND needs_review = 1').get(id);
        if (!row) {
            return { changes: 0 };
        }
        // 写入红灯日志后删除
        OcrConfidence.writeRejectedLog(
            { stationName: row.station_name, stationId: row.station_id, platform: row.platform, address: row.address, raw: StationModel.safeParse(row.raw_data) },
            { score: 0, light: 'red', hardRules: ['manual_reject'], dimensions: {} }
        );
        return db.prepare('DELETE FROM stations WHERE id = ? AND needs_review = 1').run(id);
    }

    static getOcrQualityDashboard() {
        const stationColumns = db.prepare('PRAGMA table_info(stations)').all().map(col => col.name);
        const hasNeedsReview = stationColumns.includes('needs_review');
        const hasConfidenceScore = stationColumns.includes('confidence_score');

        const totalRow = db.prepare('SELECT COUNT(*) AS cnt FROM stations').get();
        const total = Number(totalRow?.cnt || 0);

        let needsReview = 0;
        let approved = 0;
        if (hasNeedsReview) {
            const nrRow = db.prepare('SELECT COUNT(*) AS cnt FROM stations WHERE needs_review = 1').get();
            needsReview = Number(nrRow?.cnt || 0);
            approved = total - needsReview;
        } else {
            approved = total;
        }

        let avgConfidence = null;
        if (hasConfidenceScore) {
            const avgRow = db.prepare('SELECT AVG(confidence_score) AS avg FROM stations WHERE confidence_score IS NOT NULL').get();
            avgConfidence = avgRow?.avg ?? null;
        }

        // 读取红灯日志统计
        let redCount = 0;
        let redRecent = [];
        try {
            const fs = require('fs');
            const p = require('path');
            const rejectedDir = p.join(__dirname, '../../data/ocr-rejected');
            if (fs.existsSync(rejectedDir)) {
                const files = fs.readdirSync(rejectedDir).filter(f => f.endsWith('.jsonl')).sort().reverse();
                for (const f of files.slice(0, 30)) {
                    const lines = fs.readFileSync(p.join(rejectedDir, f), 'utf8').split('\n').filter(Boolean);
                    redCount += lines.length;
                    for (const line of lines.slice(0, 10)) {
                        try { redRecent.push(JSON.parse(line)); } catch (e) { /* skip */ }
                    }
                }
            }
        } catch (err) {
            // ignore
        }

        const accuracyRate = total > 0 ? Math.round((approved / total) * 10000) / 100 : 0;

        return {
            total,
            approved,
            needsReview,
            redCount,
            accuracyRate,
            avgConfidence: avgConfidence !== null ? Math.round(avgConfidence * 100) / 100 : null,
            redRecent: redRecent.slice(0, 20)
        };
    }
}

module.exports = StationModel;
