'use strict';

const mysql = require('mysql2/promise');
const { MobileSourceMysqlMigrator } = require('./mobile-source-mysql-migrator');
const { MobileSourceSplitMigrator } = require('./mobile-source-split-migrator');

const SOURCE_NODE = '47-mysql';
const DEFAULT_MYSQL_QUEUE_LIMIT = 500;
const MAX_MYSQL_QUEUE_LIMIT = 5000;

function boundedPositiveInteger(value, fallback, maximum) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 && parsed <= maximum
        ? parsed
        : fallback;
}

function createMysqlPool(env = process.env) {
    const port = Number(env.MOBILE_SOURCE_MYSQL_PORT || env.MYSQL_PORT || 3306);
    const connectionLimit = Number(env.MOBILE_SOURCE_MYSQL_POOL_SIZE || 10);
    const queueLimit = boundedPositiveInteger(
        env.MOBILE_SOURCE_MYSQL_QUEUE_LIMIT,
        DEFAULT_MYSQL_QUEUE_LIMIT,
        MAX_MYSQL_QUEUE_LIMIT
    );
    return mysql.createPool({
        host: env.MOBILE_SOURCE_MYSQL_HOST || env.MYSQL_HOST || '127.0.0.1',
        port: Number.isInteger(port) && port > 0 ? port : 3306,
        user: env.MOBILE_SOURCE_MYSQL_USER || env.MYSQL_USER,
        password: env.MOBILE_SOURCE_MYSQL_PASSWORD || env.MYSQL_PASSWORD,
        database: env.MOBILE_SOURCE_MYSQL_DATABASE || env.MYSQL_DATABASE,
        charset: 'utf8mb4',
        timezone: 'Z',
        dateStrings: true,
        waitForConnections: true,
        connectionLimit: Number.isInteger(connectionLimit) && connectionLimit > 0 ? connectionLimit : 10,
        queueLimit,
        enableKeepAlive: true,
        keepAliveInitialDelay: 0,
    });
}

class MysqlMobileSourceStore {
    constructor(options = {}) {
        this.pool = options.pool || createMysqlPool(options.env);
        this.sourceNode = options.sourceNode || SOURCE_NODE;
        // v5 拆表后的 schema 校验：校验充电/燃油/cursor 三张新表。
        this.schemaValidator = options.schemaValidator
            || new MobileSourceSplitMigrator({ connection: this.pool });
        // v4 迁移器仍需先跑（建 batches + 旧表 + 子表），由部署迁移流程保证，store 不直接调用。
    }

    async health() {
        await this.pool.query('SELECT 1 AS mobile_source_database_ready');
        await this.schemaValidator.validate();
        return true;
    }

    async ingest(batch) {
        const existing = await this.findBatchByIdempotencyKey(batch.idempotencyKey);
        if (existing) {
            return this.toIngestResult(existing, true);
        }

        const connection = await this.pool.getConnection();
        try {
            await connection.beginTransaction();
            const batchValues = [
                batch.ingestId,
                batch.idempotencyKey,
                this.sourceNode,
                batch.sourceAgent,
                'mobile-ocr',
                batch.sourceStage,
                batch.platform,
                batch.city,
                batch.deviceId,
                batch.sessionId,
                batch.pageIndex,
                batch.clientVersion,
                batch.capturedAt,
                batch.stations.length,
                JSON.stringify(batch.rawMeta || {}),
                batch.schemaVersion || 1,
                batch.stationType || 'charging',
            ];
            const [insertedBatch] = await connection.execute(`
                INSERT INTO mobile_ocr_ingest_batches (
                    ingest_id, idempotency_key, source_node, source_agent,
                    source_type, source_stage, platform, city, device_id,
                    session_id, page_index, client_version, captured_at,
                    station_count, raw_meta, schema_version, observation_type
                ) VALUES (${batchValues.map(() => '?').join(', ')})
            `, batchValues);

            let firstGlobalSeq = null;
            let lastGlobalSeq = null;
            let firstFuelGlobalSeq = null;
            let lastFuelGlobalSeq = null;
            let acceptedQuoteCount = 0;
            for (let index = 0; index < batch.stations.length; index += 1) {
                const station = batch.stations[index];
                const stationType = station.stationType || batch.stationType || 'charging';
                const sourceRecordId = stationType === 'fuel'
                    ? await this.insertFuelSnapshot(connection, insertedBatch.insertId, index, batch, station)
                    : await this.insertChargingSnapshot(connection, insertedBatch.insertId, index, batch, station);

                if (stationType === 'fuel') {
                    for (let offerIndex = 0; offerIndex < station.fuelOffers.length; offerIndex += 1) {
                        await this.insertFuelOffer(connection, sourceRecordId, offerIndex, station, batch);
                    }
                    for (const quote of station.fuelQuotes || []) {
                        await this.insertFuelQuote(connection, sourceRecordId, quote, station, batch);
                        acceptedQuoteCount += 1;
                    }
                }

                // 写全局游标，统一两表自增 ID 序列。
                const [cursorRow] = await connection.execute(`
                    INSERT INTO mobile_ocr_source_record_cursor (
                        source_record_id, station_type, ingest_batch_id
                    ) VALUES (?, ?, ?)
                `, [sourceRecordId, stationType, insertedBatch.insertId]);
                const globalSeq = Number(cursorRow.insertId);
                if (firstGlobalSeq === null) firstGlobalSeq = globalSeq;
                lastGlobalSeq = globalSeq;
                if (stationType === 'fuel') {
                    if (firstFuelGlobalSeq === null) firstFuelGlobalSeq = globalSeq;
                    lastFuelGlobalSeq = globalSeq;
                }
            }

            await connection.commit();
            return {
                ingestId: batch.ingestId,
                idempotencyKey: batch.idempotencyKey,
                sourceNode: this.sourceNode,
                sourceAgent: batch.sourceAgent,
                persisted: true,
                duplicate: false,
                acceptedCount: batch.stations.length,
                acceptedStationCount: batch.stations.length,
                acceptedQuoteCount,
                firstSourceRecordId: firstGlobalSeq,
                lastSourceRecordId: lastGlobalSeq,
                firstFuelSourceRecordId: firstFuelGlobalSeq,
                lastFuelSourceRecordId: lastFuelGlobalSeq,
            };
        } catch (error) {
            await connection.rollback();
            if (error?.code === 'ER_DUP_ENTRY') {
                const raced = await this.findBatchByIdempotencyKey(batch.idempotencyKey);
                if (raced) return this.toIngestResult(raced, true);
            }
            throw error;
        } finally {
            connection.release();
        }
    }

    async insertChargingSnapshot(connection, batchId, index, batch, station) {
        const values = [
            batchId,
            index,
            this.sourceNode,
            batch.sourceAgent,
            'mobile-ocr',
            station.sourceStage || batch.sourceStage,
            batch.platform,
            batch.city,
            station.stationId || station.sourceStationKey,
            station.stationName,
            station.address,
            station.latitude,
            station.longitude,
            station.priceFast,
            station.priceSlow,
            station.priceSuper,
            station.priceService,
            station.availablePorts ?? null,
            station.totalPorts ?? null,
            station.fastIdlePorts ?? null,
            station.fastTotalPorts ?? null,
            station.slowIdlePorts ?? null,
            station.slowTotalPorts ?? null,
            station.superIdlePorts ?? null,
            station.superTotalPorts ?? null,
            station.busyPorts ?? null,
            station.portSemantics || null,
            station.capturedAt || batch.capturedAt,
            JSON.stringify(station.raw || {}),
            station.providerName,
            JSON.stringify(station.missingFields || []),
            station.qualityStatus || null,
        ];
        const [inserted] = await connection.execute(`
            INSERT INTO mobile_ocr_charging_snapshots (
                ingest_batch_id, record_index, source_node, source_agent,
                source_type, source_stage, platform, city, station_id,
                station_name, address, latitude, longitude, price_fast,
                price_slow, price_super, price_service, available_ports,
                total_ports, fast_idle_ports, fast_total_ports,
                slow_idle_ports, slow_total_ports, super_idle_ports,
                super_total_ports, busy_ports, port_semantics,
                captured_at, raw_data, provider_name, missing_fields,
                quality_status
            ) VALUES (${values.map(() => '?').join(', ')})
        `, values);
        return Number(inserted.insertId);
    }

    async insertFuelSnapshot(connection, batchId, index, batch, station) {
        // 燃油快照不写任何 ports 字段。
        const values = [
            batchId,
            index,
            this.sourceNode,
            batch.sourceAgent,
            'mobile-ocr',
            station.sourceStage || batch.sourceStage,
            batch.platform,
            batch.city,
            station.stationId || station.sourceStationKey,
            station.stationName,
            station.address,
            station.latitude,
            station.longitude,
            station.providerName,
            station.capturedAt || batch.capturedAt,
            JSON.stringify(station.raw || {}),
            JSON.stringify(station.missingFields || []),
            station.qualityStatus || null,
        ];
        const [inserted] = await connection.execute(`
            INSERT INTO mobile_ocr_fuel_snapshots (
                ingest_batch_id, record_index, source_node, source_agent,
                source_type, source_stage, platform, city, station_id,
                station_name, address, latitude, longitude, provider_name,
                captured_at, raw_data, missing_fields, quality_status
            ) VALUES (${values.map(() => '?').join(', ')})
        `, values);
        return Number(inserted.insertId);
    }

    async insertFuelOffer(connection, sourceRecordId, offerIndex, station, batch) {
        const offer = station.fuelOffers[offerIndex];
        const offerValues = [
            sourceRecordId,
            offerIndex,
            offer.fuelType,
            offer.gradeCode,
            offer.gradeLabel,
            offer.displayPrice,
            offer.stationPrice,
            offer.nationalPrice,
            offer.listPrice,
            offer.discountPrice,
            offer.unclassifiedPrice,
            offer.discountKind,
            offer.currency,
            offer.unit,
            JSON.stringify({
                rows: offer.evidence || [],
                fieldSource: offer.fieldSource || {},
            }),
            offer.capturedAt || station.capturedAt || batch.capturedAt,
        ];
        await connection.execute(`
            INSERT INTO mobile_ocr_fuel_offers (
                source_record_id, offer_index, fuel_type, grade_code, grade_label,
                display_price, station_price, national_price,
                list_price, discount_price, unclassified_price, discount_kind,
                currency, unit, evidence, captured_at
            ) VALUES (${offerValues.map(() => '?').join(', ')})
        `, offerValues);
    }

    async insertFuelQuote(connection, sourceRecordId, quote, station, batch) {
        const quoteValues = [
            sourceRecordId,
            quote.quoteObservationId,
            quote.quoteDedupKey,
            quote.gradeCode,
            quote.gradeLabel,
            quote.gunCode,
            quote.gunLabel,
            quote.selectedAmount,
            quote.grossDiscount,
            quote.serviceFee,
            quote.netDiscount,
            quote.payableAmount,
            quote.quoteEntry,
            quote.needsReview ? 1 : 0,
            quote.capturedAt || station.capturedAt || batch.capturedAt,
            JSON.stringify(quote.raw || {}),
        ];
        await connection.execute(`
            INSERT INTO mobile_ocr_fuel_quotes (
                source_record_id, quote_observation_id, quote_dedup_key,
                grade_code, grade_label, gun_code, gun_label, selected_amount,
                gross_discount, service_fee, net_discount, payable_amount,
                quote_entry, needs_review, captured_at, raw_data
            ) VALUES (${quoteValues.map(() => '?').join(', ')})
        `, quoteValues);
    }

    async findBatchByIdempotencyKey(idempotencyKey) {
        // 通过 cursor 表统计，统一两表的 source_record_id 序列。
        const [rows] = await this.pool.execute(`
            SELECT
                b.ingest_id, b.idempotency_key, b.source_node, b.source_agent, b.station_count,
                MIN(c.global_seq) AS first_source_record_id,
                MAX(c.global_seq) AS last_source_record_id,
                MIN(CASE WHEN c.station_type = 'fuel' THEN c.global_seq END)
                    AS first_fuel_source_record_id,
                MAX(CASE WHEN c.station_type = 'fuel' THEN c.global_seq END)
                    AS last_fuel_source_record_id,
                COUNT(q.id) AS accepted_quote_count
            FROM mobile_ocr_ingest_batches b
            LEFT JOIN mobile_ocr_source_record_cursor c ON c.ingest_batch_id = b.id
            LEFT JOIN mobile_ocr_fuel_quotes q ON q.source_record_id = c.source_record_id
            WHERE b.idempotency_key = ?
            GROUP BY b.id, b.ingest_id, b.idempotency_key, b.source_node, b.source_agent, b.station_count
            LIMIT 1
        `, [idempotencyKey]);
        return rows?.[0] || null;
    }

    async listAfter(afterSeq, limit) {
        // 按 global_seq 增量拉取，再按 station_type 分发到对应拆分表取详情。
        // global_seq 直接通过 JOIN 带出，作为返回记录的 sourceRecordId（下游游标语义）。
        const [cursorRows] = await this.pool.query(`
            SELECT global_seq, source_record_id, station_type
            FROM mobile_ocr_source_record_cursor
            WHERE global_seq > ?
            ORDER BY global_seq ASC
            LIMIT ?
        `, [afterSeq, limit]);
        if (cursorRows.length === 0) return [];

        const chargingSeqs = [];
        const fuelSeqs = [];
        for (const row of cursorRows) {
            const entry = { seq: Number(row.global_seq), recordId: Number(row.source_record_id) };
            if (row.station_type === 'fuel') fuelSeqs.push(entry);
            else chargingSeqs.push(entry);
        }

        const chargingRows = chargingSeqs.length > 0
            ? await this.fetchChargingRows(chargingSeqs)
            : [];
        const fuelRows = fuelSeqs.length > 0
            ? await this.fetchFuelRows(fuelSeqs)
            : [];

        const fuelIds = fuelSeqs.map(item => item.recordId);
        const offersByRecord = new Map();
        const quotesByRecord = new Map();
        if (fuelIds.length > 0) {
            const placeholders = fuelIds.map(() => '?').join(', ');
            const [offerRows] = await this.pool.execute(`
                SELECT source_record_id, offer_index, fuel_type, grade_code, grade_label,
                       display_price, station_price, national_price,
                       list_price, discount_price, unclassified_price, discount_kind,
                       currency, unit, evidence, captured_at
                FROM mobile_ocr_fuel_offers
                WHERE source_record_id IN (${placeholders})
                ORDER BY source_record_id ASC, offer_index ASC
            `, fuelIds);
            for (const offerRow of offerRows) {
                const key = Number(offerRow.source_record_id);
                if (!offersByRecord.has(key)) offersByRecord.set(key, []);
                offersByRecord.get(key).push(this.toFuelOffer(offerRow));
            }
            const [quoteRows] = await this.pool.execute(`
                SELECT source_record_id, quote_observation_id, quote_dedup_key,
                       grade_code, grade_label, gun_code, gun_label, selected_amount,
                       gross_discount, service_fee, net_discount, payable_amount,
                       quote_entry, needs_review, captured_at, raw_data
                FROM mobile_ocr_fuel_quotes
                WHERE source_record_id IN (${placeholders})
                ORDER BY source_record_id ASC, id ASC
            `, fuelIds);
            for (const quoteRow of quoteRows) {
                const key = Number(quoteRow.source_record_id);
                if (!quotesByRecord.has(key)) quotesByRecord.set(key, []);
                quotesByRecord.get(key).push(this.toFuelQuote(quoteRow));
            }
        }

        const records = [];
        for (const row of chargingRows) {
            records.push(this.toChargingRecord(row));
        }
        for (const row of fuelRows) {
            const recordId = Number(row.source_record_id);
            records.push(this.toFuelRecord(
                row,
                offersByRecord.get(recordId) || [],
                quotesByRecord.get(recordId) || []
            ));
        }
        // 按 global_seq 排序，与 cursor 顺序一致。
        records.sort((a, b) => a.sourceRecordId - b.sourceRecordId);
        return records;
    }

    async fetchChargingRows(seqEntries) {
        const ids = seqEntries.map(item => item.recordId);
        const placeholders = ids.map(() => '?').join(', ');
        const [rows] = await this.pool.execute(`
            SELECT
                c.global_seq, s.source_record_id, b.ingest_id, s.record_index,
                s.source_node, s.source_agent, s.source_type, s.source_stage,
                s.platform, s.city, s.station_id, s.station_name, s.address,
                s.latitude, s.longitude, s.price_fast, s.price_slow,
                s.price_super, s.price_service, s.available_ports, s.total_ports,
                s.fast_idle_ports, s.fast_total_ports, s.slow_idle_ports,
                s.slow_total_ports, s.super_idle_ports, s.super_total_ports,
                s.busy_ports, s.port_semantics, s.captured_at, s.raw_data,
                s.provider_name, s.missing_fields, s.quality_status
            FROM mobile_ocr_charging_snapshots s
            INNER JOIN mobile_ocr_ingest_batches b ON b.id = s.ingest_batch_id
            INNER JOIN mobile_ocr_source_record_cursor c
                ON c.source_record_id = s.source_record_id AND c.station_type = 'charging'
            WHERE s.source_record_id IN (${placeholders})
            ORDER BY c.global_seq ASC
        `, ids);
        return rows;
    }

    async fetchFuelRows(seqEntries) {
        const ids = seqEntries.map(item => item.recordId);
        const placeholders = ids.map(() => '?').join(', ');
        const [rows] = await this.pool.execute(`
            SELECT
                c.global_seq, s.source_record_id, b.ingest_id, s.record_index,
                s.source_node, s.source_agent, s.source_type, s.source_stage,
                s.platform, s.city, s.station_id, s.station_name, s.address,
                s.latitude, s.longitude, s.provider_name, s.captured_at,
                s.raw_data, s.missing_fields, s.quality_status
            FROM mobile_ocr_fuel_snapshots s
            INNER JOIN mobile_ocr_ingest_batches b ON b.id = s.ingest_batch_id
            INNER JOIN mobile_ocr_source_record_cursor c
                ON c.source_record_id = s.source_record_id AND c.station_type = 'fuel'
            WHERE s.source_record_id IN (${placeholders})
            ORDER BY c.global_seq ASC
        `, ids);
        return rows;
    }

    toChargingRecord(row) {
        const raw = this.parseJson(row.raw_data);
        const missingFields = this.parseJsonArray(row.missing_fields);
        const missing = new Set(missingFields);
        const availablePorts = missing.has('availablePorts')
            ? null
            : this.nullableNumber(row.available_ports);
        const totalPorts = missing.has('totalPorts')
            ? null
            : this.nullableNumber(row.total_ports);
        let busyPorts = missing.has('busyPorts')
            ? null
            : this.nullableNumber(row.busy_ports);
        if (busyPorts === null && !missing.has('busyPorts')
                && availablePorts !== null && totalPorts !== null) {
            busyPorts = Math.max(0, totalPorts - availablePorts);
        }
        return {
            sourceRecordId: Number(row.global_seq),
            ingestId: row.ingest_id,
            recordIndex: Number(row.record_index),
            sourceNode: row.source_node,
            sourceAgent: row.source_agent,
            sourceType: row.source_type,
            sourceStage: row.source_stage,
            platform: row.platform,
            city: row.city,
            stationType: 'charging',
            stationId: row.station_id,
            sourceStationKey: row.station_id,
            stationName: row.station_name,
            address: missing.has('address') ? null : row.address,
            latitude: this.nullableNumber(row.latitude),
            longitude: this.nullableNumber(row.longitude),
            priceFast: this.nullableNumber(row.price_fast),
            priceSlow: this.nullableNumber(row.price_slow),
            priceSuper: this.nullableNumber(row.price_super),
            priceService: this.nullableNumber(row.price_service),
            availablePorts,
            busyPorts,
            totalPorts,
            fastIdlePorts: this.nullableNumber(row.fast_idle_ports) ?? 0,
            fastTotalPorts: this.nullableNumber(row.fast_total_ports) ?? 0,
            slowIdlePorts: this.nullableNumber(row.slow_idle_ports) ?? 0,
            slowTotalPorts: this.nullableNumber(row.slow_total_ports) ?? 0,
            superIdlePorts: this.nullableNumber(row.super_idle_ports) ?? 0,
            superTotalPorts: this.nullableNumber(row.super_total_ports) ?? 0,
            portSemantics: row.port_semantics || null,
            missingFields,
            qualityStatus: row.quality_status || null,
            needsReview: Boolean(row.quality_status && row.quality_status !== 'valid'),
            capturedAt: this.toIsoTimestamp(row.captured_at),
            raw,
        };
    }

    toFuelRecord(row, fuelOffers = [], fuelQuotes = []) {
        const raw = this.parseJson(row.raw_data);
        const missingFields = this.parseJsonArray(row.missing_fields);
        const missing = new Set(missingFields);
        const rawFuelObservation = this.plainJsonObject(raw.fuelObservation) || {};
        const providerEvidence = this.plainJsonObject(
            rawFuelObservation.providerEvidence
        ) || this.plainJsonObject(raw.providerEvidence);
        const canonicalRaw = { ...raw };
        delete canonicalRaw.providerEvidence;
        if (providerEvidence) {
            canonicalRaw.fuelObservation = {
                ...rawFuelObservation,
                providerEvidence,
            };
        }
        return {
            sourceRecordId: Number(row.global_seq),
            ingestId: row.ingest_id,
            recordIndex: Number(row.record_index),
            sourceNode: row.source_node,
            sourceAgent: row.source_agent,
            sourceType: row.source_type,
            sourceStage: row.source_stage,
            platform: row.platform,
            city: row.city,
            stationType: 'fuel',
            stationId: row.station_id,
            sourceStationKey: row.station_id,
            stationName: row.station_name,
            address: missing.has('address') ? null : row.address,
            latitude: this.nullableNumber(row.latitude),
            longitude: this.nullableNumber(row.longitude),
            providerName: row.provider_name || null,
            providerEvidence,
            // 燃油侧无 ports/枪数据，显式置 null，不参与枪口渲染。
            availablePorts: null,
            busyPorts: null,
            totalPorts: null,
            portSemantics: null,
            missingFields,
            qualityStatus: row.quality_status || null,
            needsReview: Boolean(row.quality_status && row.quality_status !== 'valid'),
            capturedAt: this.toIsoTimestamp(row.captured_at),
            raw: canonicalRaw,
            fuelOffers,
            fuelQuotes,
        };
    }

    toFuelOffer(row) {
        const evidencePayload = this.parseJsonValue(row.evidence, []);
        const legacyEvidence = Array.isArray(evidencePayload);
        const evidence = legacyEvidence
            ? evidencePayload
            : (Array.isArray(evidencePayload?.rows) ? evidencePayload.rows : []);
        const fieldSource = legacyEvidence
            ? {}
            : this.plainJsonObject(evidencePayload?.fieldSource) || {};
        return {
            fuelType: row.fuel_type,
            gradeCode: row.grade_code,
            gradeLabel: row.grade_label,
            displayPrice: this.nullableNumber(row.display_price),
            stationPrice: this.nullableNumber(row.station_price),
            nationalPrice: this.nullableNumber(row.national_price),
            listPrice: this.nullableNumber(row.list_price),
            discountPrice: this.nullableNumber(row.discount_price),
            unclassifiedPrice: this.nullableNumber(row.unclassified_price),
            discountKind: row.discount_kind,
            currency: row.currency,
            unit: row.unit,
            fieldSource,
            evidence,
            capturedAt: this.toIsoTimestamp(row.captured_at),
        };
    }

    toFuelQuote(row) {
        return {
            quoteObservationId: row.quote_observation_id,
            quoteDedupKey: row.quote_dedup_key,
            gradeCode: row.grade_code,
            gradeLabel: row.grade_label,
            gunCode: row.gun_code,
            gunLabel: row.gun_label,
            selectedAmount: this.nullableDecimal(row.selected_amount),
            grossDiscount: this.nullableDecimal(row.gross_discount),
            serviceFee: this.nullableDecimal(row.service_fee),
            netDiscount: this.nullableDecimal(row.net_discount),
            payableAmount: this.nullableDecimal(row.payable_amount),
            quoteEntry: row.quote_entry,
            needsReview: Number(row.needs_review) === 1,
            capturedAt: this.toIsoTimestamp(row.captured_at),
            raw: this.parseJson(row.raw_data),
        };
    }

    toIngestResult(row, duplicate) {
        return {
            ingestId: row.ingest_id,
            idempotencyKey: row.idempotency_key,
            sourceNode: row.source_node,
            sourceAgent: row.source_agent,
            persisted: true,
            duplicate,
            acceptedCount: Number(row.station_count) || 0,
            acceptedStationCount: Number(row.station_count) || 0,
            acceptedQuoteCount: Number(row.accepted_quote_count) || 0,
            firstSourceRecordId: this.nullableSafeInteger(row.first_source_record_id),
            lastSourceRecordId: this.nullableSafeInteger(row.last_source_record_id),
            firstFuelSourceRecordId: this.nullableSafeInteger(row.first_fuel_source_record_id),
            lastFuelSourceRecordId: this.nullableSafeInteger(row.last_fuel_source_record_id),
        };
    }

    nullableSafeInteger(value) {
        if (value === null || value === undefined || value === '') return null;
        const number = Number(value);
        return Number.isSafeInteger(number) && number > 0 ? number : null;
    }

    nullableNumber(value) {
        if (value === null || value === undefined || value === '') return null;
        const number = Number(value);
        return Number.isFinite(number) ? number : null;
    }

    nullableDecimal(value) {
        if (value === null || value === undefined || value === '') return null;
        const text = String(value);
        return /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text) ? Number(text).toFixed(2) : null;
    }

    parseJson(value) {
        const parsed = this.parseJsonValue(value, {});
        return this.plainJsonObject(parsed) || {};
    }

    parseJsonValue(value, fallback) {
        if (value && typeof value === 'object') return value;
        try {
            return JSON.parse(String(value || ''));
        } catch (error) {
            return fallback;
        }
    }

    parseJsonArray(value) {
        const parsed = this.parseJsonValue(value, []);
        return Array.isArray(parsed)
            ? [...new Set(parsed.map(item => String(item || '').trim()).filter(Boolean))]
            : [];
    }

    plainJsonObject(value) {
        return value && typeof value === 'object' && !Array.isArray(value)
            ? value
            : null;
    }

    toIsoTimestamp(value) {
        const text = String(value || '').trim();
        if (!text) return new Date(0).toISOString();
        const normalized = text.includes('T') ? text : `${text.replace(' ', 'T')}Z`;
        const date = new Date(normalized);
        return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
    }

    async close() {
        await this.pool.end();
    }
}

module.exports = {
    DEFAULT_MYSQL_QUEUE_LIMIT,
    MAX_MYSQL_QUEUE_LIMIT,
    MysqlMobileSourceStore,
    SOURCE_NODE,
    boundedPositiveInteger,
    createMysqlPool,
};
