const db = require('../database/init');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const PriceScheduleModel = require('./price-schedule');
const OcrConfidence = require('../services/ocr-confidence');
const {
    findForbiddenFuelField,
    validateFuelOffer,
    validateFuelQuote,
    validateProviderEvidence,
} = require('../services/fuel-payload-policy');
const { serializeRedacted } = require('../services/sensitive-redactor');
const { resolveDataRoot } = require('../config/runtime');

const dataRoot = resolveDataRoot(path.resolve(__dirname, '../..'), process.env.DATA_ROOT);
const PUBLIC_FUEL_STATION_FIELDS = Object.freeze([
    'address', 'availablePorts', 'busyPorts', 'totalPorts',
    'portSemantics', 'missingFields', 'qualityStatus', 'needsReview',
]);

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
                  AND COALESCE(station_type, 'charging') = ?
                LIMIT 1
            `).get(data.platform, String(data.stationId), data.stationType || 'charging');

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
              AND COALESCE(station_type, 'charging') = ?
            LIMIT 1
        `).get(
            data.platform,
            data.stationName || null,
            data.address || null,
            data.latitude ?? null,
            data.longitude ?? null,
            data.stationType || 'charging'
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
              AND COALESCE(station_type, 'charging') = ?
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
            data.stationType || 'charging',
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
        return db.transaction(value => this.insertWithinTransaction(value))(data);
    }

    static insertWithinTransaction(data) {
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
                fuel_92_count, fuel_95_count, fuel_98_count, fuel_diesel_count, operator,
                source_type, source_stage, source_agent, source_node, source_record_id,
                raw_data, collected_at, snapshot_at, station_type, source_station_key, provider_name, fuel_offers,
                busy_ports, port_semantics, missing_fields, quality_status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const sourceType = data.sourceType
            || data.raw?.sourceType
            || data.raw?.source
            || null;
        const sourceStage = data.sourceStage
            || data.raw?.sourceStage
            || data.raw?.stage
            || null;
        const sourceAgent = data.sourceAgent
            || data.raw?.sourceAgent
            || data.raw?.mobileSync?.meta?.sourceAgent
            || null;
        const sourceNode = data.sourceNode
            || data.raw?.sourceNode
            || data.raw?.mobileSync?.meta?.sourceNode
            || null;
        const sourceRecordId = data.sourceRecordId
            ?? data.raw?.sourceRecordId
            ?? data.raw?.mobileSync?.meta?.sourceRecordId
            ?? null;
        const snapshotAt = this.normalizeSnapshotTime(data);
        const rawData = (data.stationType || 'charging') === 'fuel'
            ? this.serializeStructuredRawData(data.raw, 'fuel station raw')
            : this.serializeRawData(data.raw);

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
            data.operator || null,
            sourceType,
            sourceStage,
            sourceAgent,
            sourceNode,
            sourceRecordId,
            rawData,
            snapshotAt,
            snapshotAt,
            data.stationType || 'charging',
            data.sourceStationKey || null,
            data.providerName || null,
            this.serializeFuelOffers(data.fuelOffers),
            data.busyPorts ?? null,
            data.portSemantics || null,
            this.serializeMissingFields(data.missingFields),
            data.qualityStatus || null
        );

        if (!result.changes) {
            return null;
        }

        if ((data.stationType || 'charging') === 'fuel') {
            this.persistFuelObservation(result.lastInsertRowid, data, sourceRecordId);
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

        this.recordEvidenceAssets(result.lastInsertRowid, data, sourceType, sourceStage);

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
        const sourceAgent = data.sourceAgent
            || data.raw?.sourceAgent
            || data.raw?.mobileSync?.meta?.sourceAgent
            || existing.source_agent
            || null;
        const sourceNode = data.sourceNode
            || data.raw?.sourceNode
            || data.raw?.mobileSync?.meta?.sourceNode
            || existing.source_node
            || null;
        const sourceRecordId = data.sourceRecordId
            ?? data.raw?.sourceRecordId
            ?? data.raw?.mobileSync?.meta?.sourceRecordId
            ?? existing.source_record_id
            ?? null;
        const rawData = (data.stationType || existing.station_type || 'charging') === 'fuel'
            ? this.serializeStructuredRawData(data.raw, 'fuel station raw')
            : this.pickBestRaw(existing.raw_data, data.raw);

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
            busyPorts: this.pickMaxNumber(existing.busy_ports, data.busyPorts),
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
            fuelDieselCount: this.pickMaxNumber(existing.fuel_diesel_count, data.fuelDieselCount),
            portSemantics: this.pickBestString(existing.port_semantics, data.portSemantics),
            missingFields: data.missingFields === undefined
                ? existing.missing_fields
                : this.serializeMissingFields(data.missingFields),
            qualityStatus: this.pickBestString(existing.quality_status, data.qualityStatus)
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
                source_agent = ?,
                source_node = ?,
                source_record_id = ?,
                raw_data = ?,
                collected_at = ?,
                snapshot_at = ?,
                station_type = ?,
                source_station_key = ?,
                provider_name = ?,
                fuel_offers = ?,
                busy_ports = ?,
                port_semantics = ?,
                missing_fields = ?,
                quality_status = ?
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
            sourceAgent,
            sourceNode,
            sourceRecordId,
            rawData,
            snapshotAt,
            snapshotAt,
            data.stationType || existing.station_type || 'charging',
            data.sourceStationKey || existing.source_station_key || null,
            this.pickBestString(existing.provider_name, data.providerName),
            this.serializeFuelOffers(data.fuelOffers) || existing.fuel_offers || null,
            merged.busyPorts,
            merged.portSemantics,
            merged.missingFields,
            merged.qualityStatus,
            existing.id
        );

        if ((data.stationType || existing.station_type || 'charging') === 'fuel') {
            this.persistFuelObservation(existing.id, data, sourceRecordId);
        }

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

        this.recordEvidenceAssets(existing.id, data, sourceType, sourceStage);

        return result;
    }

    static insertBatch(dataArray, options = {}) {
        const insert = db.transaction((stations) => {
            let successCount = 0;
            let skipCount = 0;
            let redCount = 0;
            let yellowCount = 0;

            const { green, yellow, red, results } = OcrConfidence.batchEvaluate(stations);
            if (options.rejectOnRed === true && red.length > 0) {
                const error = new Error(`station batch contains ${red.length} rejected records`);
                error.code = 'station_batch_rejected';
                throw error;
            }

            for (const station of green) {
                delete station._confidenceResult;
                const result = this.insertWithinTransaction(station);
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
                const result = this.insertWithinTransaction(station);
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

    static recordEvidenceAssets(stationId, data = {}, sourceType = null, sourceStage = null) {
        if (!stationId) {
            return;
        }

        try {
            const assets = this.extractEvidenceAssets(stationId, data, sourceType, sourceStage);
            for (const asset of assets) {
                this.upsertEvidenceAsset(asset);
            }
        } catch (error) {
            console.warn('记录场站证据失败:', error.message);
        }
    }

    static extractEvidenceAssets(stationId, data = {}, sourceType = null, sourceStage = null) {
        const raw = data.raw && typeof data.raw === 'object' ? data.raw : {};
        const rawMeta = raw.meta && typeof raw.meta === 'object' ? raw.meta : {};
        const mobileMeta = raw.mobileSync?.meta && typeof raw.mobileSync.meta === 'object'
            ? raw.mobileSync.meta
            : {};
        const capturedAt = this.normalizeSnapshotTime(data) || this.toSqlDateTime(new Date());
        const platform = data.platform || raw.platform || rawMeta.platform || mobileMeta.platform || null;
        const stationName = data.stationName || data.station_name || raw.stationName || raw.station_name || null;
        const city = data.city || raw.city || rawMeta.city || mobileMeta.city || null;
        const resolvedSourceType = sourceType || data.sourceType || raw.sourceType || raw.source || mobileMeta.sourceType || null;
        const resolvedSourceStage = sourceStage || data.sourceStage || raw.sourceStage || raw.stage || mobileMeta.sourceStage || null;

        const baseAsset = {
            stationId,
            platform,
            stationName,
            city,
            sourceType: resolvedSourceType,
            sourceStage: resolvedSourceStage,
            capturedAt
        };

        const assets = [];
        const screenshotPaths = this.uniqueStringList([
            data.screenshotPath,
            raw.screenshotPath,
            rawMeta.screenshotPath,
            mobileMeta.screenshotPath
        ]);

        for (const screenshotPath of screenshotPaths) {
            const managed = this.copyManagedEvidenceFile(screenshotPath, {
                stationId,
                capturedAt,
                evidenceType: 'ocr-screenshot'
            });
            if (!managed) {
                continue;
            }
            assets.push({
                ...baseAsset,
                evidenceType: 'ocr-screenshot',
                assetPath: managed.relativePath,
                contentHash: managed.hash,
                summary: '页面截图已归档，可用于复核页面可见数据。',
                metadata: {
                    originalName: path.basename(screenshotPath),
                    byteSize: managed.byteSize
                }
            });
        }

        const screenshotHash = this.pickFirstString([
            data.screenshotHash,
            raw.screenshotHash,
            rawMeta.screenshotHash,
            mobileMeta.screenshotHash
        ]);
        if (screenshotHash) {
            assets.push({
                ...baseAsset,
                evidenceType: 'screenshot-hash',
                contentHash: this.hashText(screenshotHash),
                summary: '截图指纹已记录，图片文件待回传或待归档。',
                metadata: {
                    screenshotHash: this.truncateHash(screenshotHash)
                }
            });
        }

        const ocrTexts = this.extractOcrTexts(raw);
        if (ocrTexts.length > 0) {
            assets.push({
                ...baseAsset,
                evidenceType: 'ocr-text',
                contentHash: this.hashText(ocrTexts.join('\n')),
                summary: `页面识别文本已记录 ${ocrTexts.length} 条。`,
                metadata: {
                    rowCount: ocrTexts.length,
                    preview: ocrTexts.slice(0, 10)
                }
            });
        }

        return assets;
    }

    static copyManagedEvidenceFile(sourcePath, options = {}) {
        const normalizedSource = String(sourcePath || '').trim();
        if (!normalizedSource) {
            return null;
        }

        const sourceAbsolute = path.resolve(normalizedSource);
        if (!fs.existsSync(sourceAbsolute) || !fs.statSync(sourceAbsolute).isFile()) {
            return null;
        }

        const ext = path.extname(sourceAbsolute).toLowerCase();
        if (!['.png', '.jpg', '.jpeg'].includes(ext)) {
            return null;
        }

        const fileBuffer = fs.readFileSync(sourceAbsolute);
        const hash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
        const capturedAt = options.capturedAt ? new Date(options.capturedAt) : new Date();
        const datePart = Number.isNaN(capturedAt.getTime())
            ? new Date().toISOString().slice(0, 10).replace(/-/g, '')
            : capturedAt.toISOString().slice(0, 10).replace(/-/g, '');
        const evidenceRoot = this.getDataCenterEvidenceRoot();
        const targetDir = path.join(evidenceRoot, 'ocr-screenshots', datePart);
        fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
        const stationPart = String(options.stationId || 'station').replace(/[^a-zA-Z0-9_-]/g, '_');
        const filename = `${stationPart}-${hash.slice(0, 16)}${ext}`;
        const targetPath = path.join(targetDir, filename);
        if (!fs.existsSync(targetPath)) {
            fs.writeFileSync(targetPath, fileBuffer, { mode: 0o600 });
        }

        return {
            relativePath: path.relative(dataRoot, targetPath),
            hash,
            byteSize: fileBuffer.length
        };
    }

    static upsertEvidenceAsset(asset = {}) {
        const assetPath = asset.assetPath || null;
        const contentHash = asset.contentHash || null;
        const existing = db.prepare(`
            SELECT id, asset_url
            FROM station_evidence_assets
            WHERE station_id = ?
              AND evidence_type = ?
              AND COALESCE(content_hash, '') = COALESCE(?, '')
              AND COALESCE(asset_path, '') = COALESCE(?, '')
            LIMIT 1
        `).get(asset.stationId, asset.evidenceType, contentHash, assetPath);

        if (existing) {
            if (assetPath && !existing.asset_url) {
                db.prepare(`
                    UPDATE station_evidence_assets
                    SET asset_url = ?
                    WHERE id = ?
                `).run(`/api/stations/evidence-assets/${existing.id}/content`, existing.id);
            }
            return existing.id;
        }

        const result = db.prepare(`
            INSERT INTO station_evidence_assets (
                station_id, platform, station_name, city, evidence_type,
                source_type, source_stage, asset_path, asset_url, content_hash,
                captured_at, summary, metadata
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            asset.stationId,
            asset.platform || null,
            asset.stationName || null,
            asset.city || null,
            asset.evidenceType,
            asset.sourceType || null,
            asset.sourceStage || null,
            assetPath,
            null,
            contentHash,
            asset.capturedAt || null,
            asset.summary || null,
            asset.metadata ? JSON.stringify(asset.metadata) : null
        );

        if (assetPath && result.lastInsertRowid) {
            db.prepare(`
                UPDATE station_evidence_assets
                SET asset_url = ?
                WHERE id = ?
            `).run(`/api/stations/evidence-assets/${result.lastInsertRowid}/content`, result.lastInsertRowid);
        }

        return result.lastInsertRowid;
    }

    static getEvidenceAssets(filters = {}) {
        const safeLimit = Math.max(1, Math.min(1000, Number(filters.limit) || 200));
        const where = [];
        const params = [];

        if (filters.platform) {
            where.push('platform = ?');
            params.push(String(filters.platform));
        }
        if (filters.stationId) {
            where.push('station_id = ?');
            params.push(Number(filters.stationId));
        }
        if (filters.evidenceType) {
            where.push('evidence_type = ?');
            params.push(String(filters.evidenceType));
        }

        const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
        const rows = db.prepare(`
            SELECT *
            FROM station_evidence_assets
            ${whereClause}
            ORDER BY datetime(COALESCE(captured_at, created_at)) DESC, id DESC
            LIMIT ?
        `).all(...params, safeLimit);

        return rows.map(row => this.formatEvidenceAsset(row));
    }

    static getEvidenceAssetById(id) {
        const row = db.prepare(`
            SELECT *
            FROM station_evidence_assets
            WHERE id = ?
        `).get(Number(id));
        return row ? this.formatEvidenceAsset(row) : null;
    }

    static getEvidenceAssetFilePath(id) {
        const row = db.prepare(`
            SELECT *
            FROM station_evidence_assets
            WHERE id = ?
        `).get(Number(id));
        if (!row || !row.asset_path) {
            return null;
        }

        const allowedRoot = path.resolve(this.getDataCenterEvidenceRoot());
        const candidates = Array.from(new Set([
            path.resolve(dataRoot, row.asset_path),
            path.resolve(this.getProjectRoot(), row.asset_path)
        ]));
        const allowedRootReal = fs.existsSync(allowedRoot)
            ? fs.realpathSync(allowedRoot)
            : allowedRoot;
        const resolved = candidates.reduce((match, candidate) => {
            if (match || !candidate.startsWith(`${allowedRoot}${path.sep}`) || !fs.existsSync(candidate)) {
                return match;
            }
            const candidateReal = fs.realpathSync(candidate);
            if (!candidateReal.startsWith(`${allowedRootReal}${path.sep}`) || !fs.statSync(candidateReal).isFile()) {
                return match;
            }
            return candidateReal;
        }, null);
        if (!resolved) {
            return null;
        }
        return {
            filePath: resolved,
            contentType: this.getEvidenceContentType(resolved),
            filename: path.basename(resolved)
        };
    }

    static getEvidenceSummaryMapByStationIds(stationIds = []) {
        const ids = this.uniqueNumericList(stationIds);
        const summaryMap = new Map();
        if (ids.length === 0) {
            return summaryMap;
        }

        const placeholders = ids.map(() => '?').join(',');
        const rows = db.prepare(`
            SELECT *
            FROM station_evidence_assets
            WHERE station_id IN (${placeholders})
            ORDER BY datetime(COALESCE(captured_at, created_at)) DESC, id DESC
        `).all(...ids);

        for (const row of rows) {
            const stationId = Number(row.station_id);
            if (!summaryMap.has(stationId)) {
                summaryMap.set(stationId, []);
            }
            summaryMap.get(stationId).push(this.formatEvidenceAsset(row));
        }
        return summaryMap;
    }

    static buildEvidenceMeta(row = {}, evidenceSummaryMap = new Map()) {
        const stationIds = this.getSourceStationIds(row);
        const assets = [];
        const seen = new Set();

        for (const stationId of stationIds) {
            const items = evidenceSummaryMap.get(Number(stationId)) || [];
            for (const item of items) {
                if (seen.has(item.id)) {
                    continue;
                }
                seen.add(item.id);
                assets.push(item);
            }
        }

        const screenshotCount = assets.filter(item => item.evidenceType === 'ocr-screenshot').length;
        const ocrTextCount = assets.filter(item => item.evidenceType === 'ocr-text')
            .reduce((sum, item) => sum + (Number(item.metadata?.rowCount) || 0), 0);
        const screenshotHashCount = assets.filter(item => item.evidenceType === 'screenshot-hash').length;
        const latest = assets
            .map(item => item.capturedAt || item.createdAt)
            .filter(Boolean)
            .sort()
            .pop() || null;

        let label = '待补充证据';
        if (screenshotCount > 0) {
            label = `页面截图 ${screenshotCount} 张`;
        } else if (ocrTextCount > 0) {
            label = `页面识别 ${ocrTextCount} 条`;
        } else if (screenshotHashCount > 0) {
            label = '截图指纹已记录';
        }

        return {
            assets,
            summary: {
                total: assets.length,
                screenshotCount,
                ocrTextCount,
                screenshotHashCount,
                hasImage: screenshotCount > 0,
                latestCapturedAt: latest,
                label
            }
        };
    }

    static formatEvidenceAsset(row = {}) {
        return {
            id: Number(row.id),
            stationId: row.station_id === null || row.station_id === undefined ? null : Number(row.station_id),
            platform: row.platform || null,
            stationName: row.station_name || null,
            city: row.city || null,
            evidenceType: row.evidence_type,
            evidenceLabel: this.getEvidenceTypeLabel(row.evidence_type),
            sourceType: row.source_type || null,
            sourceStage: row.source_stage || null,
            assetUrl: row.asset_url || null,
            contentHash: this.truncateHash(row.content_hash),
            capturedAt: row.captured_at || null,
            createdAt: row.created_at || null,
            summary: row.summary || null,
            metadata: this.safeParse(row.metadata) || {}
        };
    }

    static extractOcrTexts(raw = {}) {
        const candidates = [
            raw.ocrTexts,
            raw.textLines,
            raw.lines,
            raw.rows,
            raw.ocrRows,
            raw.meta?.ocrRows,
            raw.mobileSync?.ocrRows
        ];
        const texts = [];

        for (const candidate of candidates) {
            if (!Array.isArray(candidate)) {
                continue;
            }
            for (const item of candidate) {
                const text = typeof item === 'string' ? item : item?.text;
                const normalized = String(text || '').trim();
                if (normalized) {
                    texts.push(normalized);
                }
            }
        }

        return this.uniqueStringList(texts);
    }

    static pickFirstString(values = []) {
        for (const value of values) {
            const normalized = String(value || '').trim();
            if (normalized) {
                return normalized;
            }
        }
        return '';
    }

    static hashText(value) {
        return crypto.createHash('sha256').update(String(value || '')).digest('hex');
    }

    static truncateHash(value) {
        const text = String(value || '').trim();
        if (!text) {
            return null;
        }
        return text.length > 16 ? `${text.slice(0, 12)}...${text.slice(-4)}` : text;
    }

    static getEvidenceTypeLabel(type) {
        const labels = {
            'ocr-screenshot': '页面截图',
            'ocr-text': '页面识别文本',
            'screenshot-hash': '截图指纹',
            'capture-json': '识别明细'
        };
        return labels[type] || '证据材料';
    }

    static getProjectRoot() {
        return path.join(__dirname, '../..');
    }

    static getDataCenterEvidenceRoot() {
        return path.join(dataRoot, 'data-center', 'evidence');
    }

    static getEvidenceContentType(filePath) {
        const ext = path.extname(filePath).toLowerCase();
        if (ext === '.png') return 'image/png';
        if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
        return 'application/octet-stream';
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

    static countSnapshotsForExport(platform = null) {
        if (platform) {
            return Number(db.prepare('SELECT COUNT(*) AS count FROM stations WHERE platform = ?').get(platform)?.count || 0);
        }
        return Number(db.prepare('SELECT COUNT(*) AS count FROM stations').get()?.count || 0);
    }

    static iterateSnapshotsForExport(platform = null, limit = 50000) {
        const safeLimit = Math.max(1, Math.min(100000, Number(limit) || 50000));
        const fields = `
            platform, station_id, station_name, address,
            available_ports, busy_ports, total_ports,
            port_semantics, missing_fields, quality_status,
            price_fast, price_slow, price_super, price_service,
            online_fast_ports, online_slow_ports,
            fast_idle_ports, fast_total_ports,
            slow_idle_ports, slow_total_ports,
            super_idle_ports, super_total_ports,
            fuel_92_price, fuel_95_price, fuel_98_price, fuel_diesel_price,
            fuel_92_count, fuel_95_count, fuel_98_count, fuel_diesel_count,
            source_type, source_stage, source_agent, source_node, source_record_id,
            snapshot_at, collected_at
        `;
        if (platform) {
            return db.prepare(`
                SELECT ${fields}
                FROM stations
                WHERE platform = ?
                ORDER BY datetime(COALESCE(snapshot_at, collected_at)) DESC, id DESC
                LIMIT ?
            `).iterate(platform, safeLimit);
        }
        return db.prepare(`
            SELECT ${fields}
            FROM stations
            ORDER BY datetime(COALESCE(snapshot_at, collected_at)) DESC, id DESC
            LIMIT ?
        `).iterate(safeLimit);
    }

    static *iterateFuelSnapshotsForExport(platform = null, limit = 50000) {
        const safeLimit = Math.max(1, Math.min(100000, Number(limit) || 50000));
        const where = platform ? 'WHERE station_type = ? AND platform = ?' : 'WHERE station_type = ?';
        const params = platform ? ['fuel', platform, safeLimit] : ['fuel', safeLimit];
        const rows = db.prepare(`
            SELECT
                id, platform, station_id, station_name, address,
                available_ports, busy_ports, total_ports,
                port_semantics, missing_fields, quality_status,
                provider_name,
                source_type, source_stage, source_agent, source_node, source_record_id,
                snapshot_at, collected_at
            FROM stations
            ${where}
            ORDER BY datetime(COALESCE(snapshot_at, collected_at)) DESC, id DESC
            LIMIT ?
        `).iterate(...params);
        const offerQuery = db.prepare(`
            SELECT
                fuel_type, grade_code, grade_label,
                display_price, station_price, national_price,
                list_price, discount_price, unclassified_price,
                discount_kind, currency, unit, evidence
            FROM fuel_offers
            WHERE station_id = ?
            ORDER BY offer_index ASC, id ASC
        `);
        const quoteQuery = db.prepare(`
            SELECT
                quote_observation_id, quote_dedup_key,
                grade_code, grade_label, gun_code, gun_label,
                selected_amount, gross_discount, service_fee,
                net_discount, payable_amount, quote_entry,
                needs_review, captured_at
            FROM fuel_quotes
            WHERE station_id = ?
            ORDER BY datetime(COALESCE(captured_at, created_at)) ASC, id ASC
        `);

        for (const row of rows) {
            yield {
                ...row,
                fuel_offers_json: JSON.stringify(
                    offerQuery.all(row.id).map(offer => this.formatFuelOffer(offer))
                ),
                fuel_quotes_json: JSON.stringify(
                    quoteQuery.all(row.id).map(quote => this.formatFuelQuote(quote))
                ),
            };
        }
    }

    static countFuelSnapshotsForExport(platform = null) {
        if (platform) {
            return Number(db.prepare(`
                SELECT COUNT(*) AS count
                FROM stations
                WHERE station_type = 'fuel' AND platform = ?
            `).get(platform)?.count || 0);
        }
        return Number(db.prepare(`
            SELECT COUNT(*) AS count
            FROM stations
            WHERE station_type = 'fuel'
        `).get()?.count || 0);
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
        const stationType = data.stationType === 'fuel' ? 'fuel' : 'charging';
        if (stationType === 'fuel') {
            const fuelPolicyData = { ...data };
            for (const field of PUBLIC_FUEL_STATION_FIELDS) delete fuelPolicyData[field];
            if (findForbiddenFuelField(fuelPolicyData)) {
                throw new Error('fuel station contains charging fields');
            }
            const offers = data.fuelOffers;
            const quotes = data.fuelQuotes;
            if (!Array.isArray(offers)
                    || offers.length > 32
                    || offers.some(offer => validateFuelOffer(offer))) {
                throw new Error('fuel station offers are invalid');
            }
            if (!Array.isArray(quotes)
                    || quotes.length > 128
                    || quotes.some(quote => validateFuelQuote(quote))) {
                throw new Error('fuel station quotes are invalid');
            }
            if (offers.length === 0 && quotes.length === 0) {
                throw new Error('fuel station requires offers or quotes');
            }
            const providerName = data.providerName;
            if (providerName !== null && providerName !== undefined
                    && (typeof providerName !== 'string'
                        || !providerName.trim()
                        || providerName.length > 128)) {
                throw new Error('fuel station provider is invalid');
            }
            const incomingRaw = data.raw && typeof data.raw === 'object' && !Array.isArray(data.raw)
                ? data.raw
                : {};
            const rawFuel = incomingRaw.fuelObservation;
            const providerEvidence = data.providerEvidence
                ?? (rawFuel && typeof rawFuel === 'object' && !Array.isArray(rawFuel)
                    ? rawFuel.providerEvidence
                    : null)
                ?? incomingRaw.providerEvidence
                ?? null;
            if (validateProviderEvidence(providerEvidence) || (providerName && !providerEvidence)) {
                throw new Error('fuel station provider evidence is invalid');
            }
            const canonicalRaw = { ...incomingRaw };
            delete canonicalRaw.providerEvidence;
            const raw = {
                ...canonicalRaw,
                ...(providerEvidence ? {
                    fuelObservation: {
                        ...(rawFuel && typeof rawFuel === 'object' && !Array.isArray(rawFuel)
                            ? rawFuel
                            : {}),
                        providerEvidence,
                    },
                } : {}),
            };
            return {
                ...data,
                stationType,
                latitude: null,
                longitude: null,
                priceFast: null,
                priceSlow: null,
                priceSuper: null,
                priceService: null,
                onlineFastPorts: 0,
                onlineSlowPorts: 0,
                fastIdlePorts: 0,
                fastTotalPorts: 0,
                slowIdlePorts: 0,
                slowTotalPorts: 0,
                superIdlePorts: 0,
                superTotalPorts: 0,
                providerName: providerName ?? null,
                providerEvidence,
                fuelOffers: offers,
                fuelQuotes: quotes,
                raw,
            };
        }
        return {
            ...data,
            priceFast: this.normalizeEnergyPrice(data.priceFast),
            priceSlow: this.normalizeEnergyPrice(data.priceSlow),
            priceSuper: this.normalizeEnergyPrice(data.priceSuper),
            stationType,
            fuelOffers: []
        };
    }

    static serializeFuelOffers(value) {
        if (!Array.isArray(value) || value.length === 0) return null;
        return JSON.stringify(value);
    }

    static serializeMissingFields(value) {
        if (!Array.isArray(value) || value.length === 0) return null;
        return JSON.stringify([...new Set(
            value.map(item => String(item || '').trim()).filter(Boolean)
        )]);
    }

    static persistFuelObservation(stationId, data = {}, sourceRecordId = null) {
        const offers = Array.isArray(data.fuelOffers) ? data.fuelOffers : [];
        const quotes = Array.isArray(data.fuelQuotes) ? data.fuelQuotes : [];
        if (offers.some(offer => validateFuelOffer(offer))) {
            throw new Error('fuel station offers are invalid');
        }
        if (quotes.some(quote => validateFuelQuote(quote))) {
            throw new Error('fuel station quotes are invalid');
        }
        if (offers.length === 0 && quotes.length === 0) {
            throw new Error('fuel station requires offers or quotes');
        }

        db.prepare('DELETE FROM fuel_offers WHERE station_id = ?').run(stationId);
        const insertOffer = db.prepare(`
            INSERT INTO fuel_offers (
                station_id, source_record_id, offer_index,
                fuel_type, grade_code, grade_label,
                display_price, station_price, national_price,
                list_price, discount_price, unclassified_price,
                discount_kind, currency, unit, evidence, raw_data
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        offers.forEach((offer, index) => {
            insertOffer.run(
                stationId,
                sourceRecordId,
                index,
                offer.fuelType || null,
                offer.gradeCode || null,
                offer.gradeLabel || null,
                offer.displayPrice ?? null,
                offer.stationPrice ?? null,
                offer.nationalPrice ?? null,
                offer.listPrice ?? null,
                offer.discountPrice ?? null,
                offer.unclassifiedPrice ?? null,
                offer.discountKind || null,
                offer.currency || null,
                offer.unit || null,
                this.serializeStructuredRawData(offer.evidence, 'fuel offer evidence'),
                this.serializeStructuredRawData(offer, 'fuel offer raw')
            );
        });

        const insertQuote = db.prepare(`
            INSERT OR IGNORE INTO fuel_quotes (
                station_id, source_record_id,
                quote_observation_id, quote_dedup_key,
                grade_code, grade_label, gun_code, gun_label,
                selected_amount, gross_discount, service_fee,
                net_discount, payable_amount, quote_entry,
                needs_review, captured_at, raw_data
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const findQuote = db.prepare(`
            SELECT station_id, quote_observation_id, quote_dedup_key
            FROM fuel_quotes
            WHERE quote_observation_id = ? OR quote_dedup_key = ?
            LIMIT 1
        `);
        for (const quote of quotes) {
            const result = insertQuote.run(
                stationId,
                sourceRecordId,
                quote.quoteObservationId,
                quote.quoteDedupKey,
                quote.gradeCode || null,
                quote.gradeLabel || null,
                quote.gunCode || null,
                quote.gunLabel || null,
                this.normalizeMoneyString(quote.selectedAmount),
                this.normalizeMoneyString(quote.grossDiscount),
                this.normalizeMoneyString(quote.serviceFee),
                this.normalizeMoneyString(quote.netDiscount),
                this.normalizeMoneyString(quote.payableAmount),
                quote.quoteEntry || null,
                this.quoteNeedsReview(quote) ? 1 : 0,
                this.toSqlDateTime(quote.capturedAt || data.capturedAt || data.snapshotAt),
                this.serializeStructuredRawData(quote.raw, 'fuel quote raw')
            );
            if (!result.changes) {
                const existing = findQuote.get(quote.quoteObservationId, quote.quoteDedupKey);
                if (!existing
                        || existing.quote_observation_id !== quote.quoteObservationId
                        || existing.quote_dedup_key !== quote.quoteDedupKey
                        || Number(existing.station_id) !== Number(stationId)) {
                    throw new Error('fuel quote idempotency conflict');
                }
            }
        }
    }

    static normalizeMoneyString(value) {
        const cents = this.moneyToCents(value);
        if (cents === null) return null;
        return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
    }

    static moneyToCents(value) {
        if (value === null || value === undefined || value === '') return null;
        const text = String(value).trim();
        if (!/^(?:0|[1-9]\d{0,6})(?:\.\d{1,2})?$/.test(text)) return null;
        const [yuan, fraction = ''] = text.split('.');
        const cents = Number(yuan) * 100 + Number(fraction.padEnd(2, '0'));
        return Number.isSafeInteger(cents) ? cents : null;
    }

    static quoteNeedsReview(quote = {}) {
        if (quote.needsReview === true || quote.needsReview === 1) return true;
        const selected = this.moneyToCents(quote.selectedAmount);
        const gross = this.moneyToCents(quote.grossDiscount);
        const service = this.moneyToCents(quote.serviceFee);
        const net = this.moneyToCents(quote.netDiscount);
        const payable = this.moneyToCents(quote.payableAmount);
        if (gross !== null && service !== null && net !== null
                && Math.abs((gross - service) - net) > 1) {
            return true;
        }
        return selected !== null && gross !== null && service !== null && payable !== null
            && Math.abs((selected - gross + service) - payable) > 1;
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
        const currentValue = typeof currentText === 'string'
            ? (this.safeParse(currentText) ?? currentText)
            : currentText;
        const currentSafeText = this.serializeRawData(currentValue);
        const incomingText = this.serializeRawData(incomingRaw);
        if (!incomingText) {
            return currentSafeText || null;
        }
        if (!currentSafeText) {
            return incomingText;
        }

        return incomingText.length >= currentSafeText.length ? incomingText : currentSafeText;
    }

    static serializeRawData(rawData) {
        return serializeRedacted(rawData, {
            maxBytes: process.env.RAW_DATA_MAX_BYTES
        });
    }

    static serializeStructuredRawData(rawData, label) {
        const serialized = this.serializeRawData(rawData);
        const parsed = this.safeParse(serialized);
        if (!serialized || parsed?._storagePolicy?.truncated === true) {
            throw new Error(`${label} cannot be stored completely`);
        }
        return serialized;
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
        const evidenceSummaryMap = this.getEvidenceSummaryMapByStationIds(stationIds);
        const fuelObservationMap = this.getFuelObservationMapByStationIds(stationIds);

        return mergedRows.map(row => this.decorateRowForView(
            row,
            priceScheduleSummaryMap,
            evidenceSummaryMap,
            fuelObservationMap
        ));
    }

    static normalizeRowForView(row = {}) {
        const raw = this.safeParse(row.raw_data);
        return {
            ...row,
            snapshot_at: row.snapshot_at || row.collected_at || null,
            raw,
            source_station_ids: this.uniqueNumericList([row.id]),
            source_types: this.toStringList(row.source_type),
            source_stages: this.toStringList(row.source_stage),
            source_agents: this.toStringList(row.source_agent),
            source_nodes: this.toStringList(row.source_node)
        };
    }

    static decorateRowForView(
        row = {},
        priceScheduleSummaryMap = new Map(),
        evidenceSummaryMap = new Map(),
        fuelObservationMap = new Map()
    ) {
        const priceScheduleMeta = this.buildPriceScheduleMeta(row, priceScheduleSummaryMap);
        const evidenceMeta = this.buildEvidenceMeta(row, evidenceSummaryMap);
        const fuelObservation = this.mergeFuelObservations(
            this.getSourceStationIds(row),
            fuelObservationMap
        );
        return {
            ...row,
            price_gun_snapshot_at: row.snapshot_at || row.collected_at || null,
            source_types: this.uniqueStringList(row.source_types),
            source_stages: this.uniqueStringList(row.source_stages),
            source_agents: this.uniqueStringList(row.source_agents),
            source_nodes: this.uniqueStringList(row.source_nodes),
            has_price_schedule: priceScheduleMeta.hasPriceSchedule,
            price_schedule_types: priceScheduleMeta.types,
            price_schedule_count: priceScheduleMeta.count,
            price_schedule_min_price: priceScheduleMeta.minPrice,
            price_schedule_max_price: priceScheduleMeta.maxPrice,
            price_schedule_min_service_fee: priceScheduleMeta.minServiceFee,
            price_schedule_max_service_fee: priceScheduleMeta.maxServiceFee,
            evidence_assets: evidenceMeta.assets,
            evidence_summary: evidenceMeta.summary,
            fuel_offers_normalized: fuelObservation.offers,
            fuel_quotes: fuelObservation.quotes
        };
    }

    static getFuelObservationMapByStationIds(stationIds = []) {
        const ids = this.uniqueNumericList(stationIds);
        const result = new Map();
        for (const id of ids) result.set(id, { offers: [], quotes: [] });
        if (ids.length === 0) return result;

        const placeholders = ids.map(() => '?').join(',');
        const offers = db.prepare(`
            SELECT *
            FROM fuel_offers
            WHERE station_id IN (${placeholders})
            ORDER BY station_id ASC, offer_index ASC, id ASC
        `).all(...ids);
        for (const offer of offers) {
            result.get(Number(offer.station_id))?.offers.push(this.formatFuelOffer(offer));
        }
        const quotes = db.prepare(`
            SELECT *
            FROM fuel_quotes
            WHERE station_id IN (${placeholders})
            ORDER BY station_id ASC, datetime(COALESCE(captured_at, created_at)) ASC, id ASC
        `).all(...ids);
        for (const quote of quotes) {
            result.get(Number(quote.station_id))?.quotes.push(this.formatFuelQuote(quote));
        }
        return result;
    }

    static mergeFuelObservations(stationIds = [], observationMap = new Map()) {
        const offers = [];
        const quotes = [];
        const quoteKeys = new Set();
        for (const stationId of stationIds) {
            const observation = observationMap.get(Number(stationId));
            if (!observation) continue;
            offers.push(...observation.offers);
            for (const quote of observation.quotes) {
                const key = quote.quoteDedupKey || quote.quoteObservationId;
                if (key && quoteKeys.has(key)) continue;
                if (key) quoteKeys.add(key);
                quotes.push(quote);
            }
        }
        return { offers, quotes };
    }

    static formatFuelOffer(row = {}) {
        const raw = this.safeParse(row.raw_data) || {};
        return {
            fuelType: row.fuel_type || null,
            gradeCode: row.grade_code || null,
            gradeLabel: row.grade_label || null,
            displayPrice: row.display_price ?? null,
            stationPrice: row.station_price ?? null,
            nationalPrice: row.national_price ?? null,
            listPrice: row.list_price ?? null,
            discountPrice: row.discount_price ?? null,
            unclassifiedPrice: row.unclassified_price ?? null,
            discountKind: row.discount_kind || null,
            currency: row.currency || null,
            unit: row.unit || null,
            fieldSource: raw.fieldSource && typeof raw.fieldSource === 'object'
                && !Array.isArray(raw.fieldSource)
                ? raw.fieldSource
                : {},
            evidence: this.safeParse(row.evidence) || [],
            capturedAt: raw.capturedAt || null,
        };
    }

    static formatFuelQuote(row = {}) {
        return {
            quoteObservationId: row.quote_observation_id,
            quoteDedupKey: row.quote_dedup_key,
            gradeCode: row.grade_code || null,
            gradeLabel: row.grade_label || null,
            gunCode: row.gun_code || null,
            gunLabel: row.gun_label || null,
            selectedAmount: row.selected_amount ?? null,
            grossDiscount: row.gross_discount ?? null,
            serviceFee: row.service_fee ?? null,
            netDiscount: row.net_discount ?? null,
            payableAmount: row.payable_amount ?? null,
            quoteEntry: row.quote_entry || null,
            needsReview: Boolean(row.needs_review),
            capturedAt: row.captured_at || null,
            raw: this.safeParse(row.raw_data) || {},
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
        merged.busy_ports = this.pickSnapshotField(freshest, existing, incoming, 'busy_ports');
        merged.total_ports = this.pickSnapshotField(freshest, existing, incoming, 'total_ports');
        merged.port_semantics = this.pickSnapshotField(freshest, existing, incoming, 'port_semantics');
        merged.missing_fields = this.pickSnapshotField(freshest, existing, incoming, 'missing_fields');
        merged.quality_status = this.pickSnapshotField(freshest, existing, incoming, 'quality_status');
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
        merged.station_type = freshest.station_type || existing.station_type || incoming.station_type || 'charging';
        merged.source_station_key = freshest.source_station_key
            || existing.source_station_key
            || incoming.source_station_key
            || null;
        merged.provider_name = this.pickBestString(existing.provider_name, incoming.provider_name);
        merged.fuel_offers = freshest.fuel_offers || existing.fuel_offers || incoming.fuel_offers || null;
        merged.source_type = freshest.source_type || existing.source_type || incoming.source_type || null;
        merged.source_stage = freshest.source_stage || existing.source_stage || incoming.source_stage || null;
        merged.source_agent = freshest.source_agent || existing.source_agent || incoming.source_agent || null;
        merged.source_node = freshest.source_node || existing.source_node || incoming.source_node || null;
        merged.source_record_id = freshest.source_record_id || existing.source_record_id || incoming.source_record_id || null;
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
        merged.source_agents = this.uniqueStringList([
            ...this.toStringList(existing.source_agents),
            ...this.toStringList(incoming.source_agents),
            ...this.toStringList(existing.source_agent),
            ...this.toStringList(incoming.source_agent)
        ]);
        merged.source_nodes = this.uniqueStringList([
            ...this.toStringList(existing.source_nodes),
            ...this.toStringList(incoming.source_nodes),
            ...this.toStringList(existing.source_node),
            ...this.toStringList(incoming.source_node)
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
        db.prepare('UPDATE stations SET needs_review = 1 WHERE id = ?').run(stationRowId);
    }

    static saveConfidenceMeta(stationRowId, score, dimensions) {
        db.prepare('UPDATE stations SET confidence_score = ?, confidence_dimensions = ? WHERE id = ?')
            .run(score, JSON.stringify(dimensions || {}), stationRowId);
    }

    static getPendingReview(limit = 100, offset = 0) {
        const safeLimit = Math.max(1, Math.min(1000, Number(limit) || 100));
        const safeOffset = Math.max(0, Number(offset) || 0);

        return db.prepare(
            'SELECT * FROM stations WHERE needs_review = 1 ORDER BY id DESC LIMIT ? OFFSET ?'
        ).all(safeLimit, safeOffset);
    }

    static getPendingReviewCount() {
        const row = db.prepare('SELECT COUNT(*) AS cnt FROM stations WHERE needs_review = 1').get();
        return Number(row?.cnt || 0);
    }

    static approveStation(id) {
        return db.prepare('UPDATE stations SET needs_review = 0 WHERE id = ? AND needs_review = 1').run(id);
    }

    static rejectStation(id) {
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
        const totalRow = db.prepare('SELECT COUNT(*) AS cnt FROM stations').get();
        const total = Number(totalRow?.cnt || 0);
        const nrRow = db.prepare('SELECT COUNT(*) AS cnt FROM stations WHERE needs_review = 1').get();
        const needsReview = Number(nrRow?.cnt || 0);
        const approved = total - needsReview;
        const avgRow = db.prepare('SELECT AVG(confidence_score) AS avg FROM stations WHERE confidence_score IS NOT NULL').get();
        const avgConfidence = avgRow?.avg ?? null;

        // 读取红灯日志统计
        let redCount = 0;
        let redRecent = [];
        try {
            const fs = require('fs');
            const rejectedDir = path.join(dataRoot, 'ocr-rejected');
            if (fs.existsSync(rejectedDir)) {
                const files = fs.readdirSync(rejectedDir).filter(f => f.endsWith('.jsonl')).sort().reverse();
                for (const f of files.slice(0, 30)) {
                    const lines = fs.readFileSync(path.join(rejectedDir, f), 'utf8').split('\n').filter(Boolean);
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
