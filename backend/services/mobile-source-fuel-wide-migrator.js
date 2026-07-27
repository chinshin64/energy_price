'use strict';

const crypto = require('node:crypto');
const { WIDE_COLUMNS, buildWideSelectSql, buildWideUpsertSql }
    = require('./mobile-source-fuel-wide-sql');

const TARGET_SCHEMA_VERSION = 2;
const COMPONENT = 'mobile-ocr-source-fuel-wide';
const MIGRATION_NAME = 'mobile_fuel_physical_wide_table_v2';
const LOCK_NAME = 'data-for-didi:mobile-ocr-source:fuel-wide-v1';
const WIDE_TABLE = 'mobile_ocr_fuel_wide_records';

const REQUIRED_COLUMNS = Object.freeze([
    'id',
    ...WIDE_COLUMNS,
    'created_at',
    'updated_at',
]);

const CREATE_MIGRATION_METADATA = `
    CREATE TABLE IF NOT EXISTS mobile_ocr_schema_migrations (
        component VARCHAR(64) NOT NULL,
        version INT UNSIGNED NOT NULL,
        checksum CHAR(64) NOT NULL,
        applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (component)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;

const CREATE_WIDE_TABLE = `
    CREATE TABLE IF NOT EXISTS mobile_ocr_fuel_wide_records (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        wide_record_key VARCHAR(191) NOT NULL,
        record_kind VARCHAR(16) NOT NULL,
        source_record_id BIGINT UNSIGNED NOT NULL,
        source_offer_id BIGINT UNSIGNED NULL,
        source_quote_id BIGINT UNSIGNED NULL,
        ingest_batch_id BIGINT UNSIGNED NOT NULL,
        ingest_id CHAR(36) NOT NULL,
        idempotency_key CHAR(64) NOT NULL,
        source_node VARCHAR(64) NOT NULL,
        source_agent VARCHAR(64) NOT NULL,
        source_type VARCHAR(32) NOT NULL,
        client_version VARCHAR(64) NULL,
        device_id VARCHAR(128) NULL,
        agent_report_ip VARCHAR(45) NULL,
        session_id VARCHAR(128) NOT NULL,
        page_index INT UNSIGNED NOT NULL,
        record_index INT UNSIGNED NOT NULL,
        channel VARCHAR(64) NOT NULL,
        platform VARCHAR(64) NOT NULL,
        city VARCHAR(128) NOT NULL,
        source_stage VARCHAR(64) NULL,
        station_id VARCHAR(191) NULL,
        station_name VARCHAR(512) NOT NULL,
        cp_name VARCHAR(128) NULL,
        provider_evidence JSON NULL,
        quality_status VARCHAR(32) NULL,
        missing_fields JSON NULL,
        needs_review TINYINT(1) NOT NULL DEFAULT 0,
        fuel_type VARCHAR(32) NULL,
        grade_code VARCHAR(32) NULL,
        grade_label VARCHAR(64) NULL,
        station_price DECIMAL(10,4) NULL,
        list_price DECIMAL(10,4) NULL,
        display_price DECIMAL(10,4) NULL,
        discount_price DECIMAL(10,4) NULL,
        national_price DECIMAL(10,4) NULL,
        unclassified_price DECIMAL(10,4) NULL,
        discount_kind VARCHAR(32) NULL,
        currency VARCHAR(8) NULL,
        unit VARCHAR(32) NULL,
        selected_amount DECIMAL(12,2) NULL,
        discount_amount DECIMAL(12,2) NULL,
        service_fee DECIMAL(12,2) NULL,
        net_discount DECIMAL(12,2) NULL,
        payable_amount DECIMAL(12,2) NULL,
        offer_index INT UNSIGNED NULL,
        quote_observation_id VARCHAR(128) NULL,
        quote_dedup_key CHAR(64) NULL,
        quote_entry VARCHAR(32) NULL,
        gun_code VARCHAR(32) NULL,
        gun_label VARCHAR(64) NULL,
        offer_evidence JSON NULL,
        station_raw_data JSON NULL,
        quote_raw_data JSON NULL,
        captured_at DATETIME(3) NOT NULL,
        received_at DATETIME(3) NOT NULL,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
            ON UPDATE CURRENT_TIMESTAMP(3),
        PRIMARY KEY (id),
        UNIQUE KEY uk_mobile_ocr_fuel_wide_key (wide_record_key),
        KEY idx_mobile_ocr_fuel_wide_source (source_record_id, id),
        KEY idx_mobile_ocr_fuel_wide_station_time (station_name, captured_at),
        KEY idx_mobile_ocr_fuel_wide_channel_time (channel, captured_at),
        KEY idx_mobile_ocr_fuel_wide_device_time (device_id, captured_at),
        KEY idx_mobile_ocr_fuel_wide_grade_time (grade_code, captured_at),
        CONSTRAINT fk_mobile_ocr_fuel_wide_batch
            FOREIGN KEY (ingest_batch_id) REFERENCES mobile_ocr_ingest_batches(id)
            ON DELETE RESTRICT ON UPDATE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;

const MIGRATION_PLAN = Object.freeze([
    'acquire-dedicated-migration-lock',
    'ensure-migration-metadata',
    'create-mobile-ocr-fuel-wide-records',
    'ensure-nullable-agent-report-ip-column',
    'validate-v4-compatible-physical-schema',
    'idempotently-backfill-complete-offer-only-quote-only-station-only-rows',
    'validate-source-coverage-and-wide-record-key-uniqueness',
    'record-independent-component-version-2',
]);

function migrationError(code, message, details) {
    const error = new Error(message);
    error.code = code;
    if (details !== undefined) error.details = details;
    return error;
}

function schemaChecksum() {
    return crypto.createHash('sha256').update(JSON.stringify({
        component: COMPONENT,
        migrationName: MIGRATION_NAME,
        targetVersion: TARGET_SCHEMA_VERSION,
        requiredColumns: REQUIRED_COLUMNS,
        createTable: CREATE_WIDE_TABLE.replace(/\s+/g, ' ').trim(),
    })).digest('hex');
}

class MobileSourceFuelWideMigrator {
    constructor(options = {}) {
        if (!options.connection) throw new TypeError('fuel wide migration connection is required');
        this.connection = options.connection;
        this.lockTimeoutSeconds = Number.isInteger(options.lockTimeoutSeconds)
            ? options.lockTimeoutSeconds
            : 30;
    }

    async migrate() {
        await this.acquireLock();
        try {
            await this.connection.query(CREATE_MIGRATION_METADATA);
            const current = await this.currentComponent();
            if (current && Number(current.version) > TARGET_SCHEMA_VERSION) {
                throw migrationError(
                    'mobile_source_fuel_wide_future_version',
                    'fuel wide schema is newer than this migration runner'
                );
            }
            if (current && Number(current.version) === TARGET_SCHEMA_VERSION
                    && current.checksum !== schemaChecksum()) {
                throw migrationError(
                    'mobile_source_fuel_wide_checksum_drift',
                    'recorded fuel wide migration checksum does not match this runner'
                );
            }
            await this.connection.query(CREATE_WIDE_TABLE);
            await this.ensureAgentReportIpColumn();
            await this.validatePhysicalSchema();
            const backfill = await this.backfill();
            const validation = await this.validateData();
            await this.recordVersion();
            return {
                component: COMPONENT,
                migrationName: MIGRATION_NAME,
                schemaVersion: TARGET_SCHEMA_VERSION,
                backfill,
                validation,
            };
        } finally {
            await this.releaseLock();
        }
    }

    async backfill() {
        await this.validatePhysicalSchema();
        const statement = buildWideUpsertSql({
            snapshotTable: 'mobile_ocr_station_snapshots',
            requireFuelStationType: true,
        });
        const [result] = await this.connection.execute(statement.sql, statement.parameters);
        return {
            affectedRows: Number(result?.affectedRows) || 0,
        };
    }

    async validate() {
        await this.validatePhysicalSchema();
        const current = await this.currentComponent();
        const version = Number(current?.version);
        if (version !== TARGET_SCHEMA_VERSION || current?.checksum !== schemaChecksum()) {
            throw migrationError(
                'mobile_source_fuel_wide_version_invalid',
                'fuel wide component version or checksum is invalid'
            );
        }
        const validation = await this.validateData();
        return {
            component: COMPONENT,
            migrationName: MIGRATION_NAME,
            schemaVersion: version,
            valid: true,
            validation,
        };
    }

    async validatePhysicalSchema() {
        const [tableRows] = await this.connection.execute(`
            SELECT COUNT(*) AS table_count
            FROM information_schema.tables
            WHERE table_schema = DATABASE() AND table_name = ?
        `, [WIDE_TABLE]);
        if (Number(tableRows?.[0]?.table_count) !== 1) {
            throw migrationError(
                'mobile_source_fuel_wide_table_missing',
                `required table is missing: ${WIDE_TABLE}`
            );
        }
        const [columnRows] = await this.connection.execute(`
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = DATABASE() AND table_name = ?
            ORDER BY ordinal_position
        `, [WIDE_TABLE]);
        const actualColumns = new Set(
            (columnRows || []).map(row => String(row.column_name || row.COLUMN_NAME || ''))
        );
        const missingColumns = REQUIRED_COLUMNS.filter(column => !actualColumns.has(column));
        if (missingColumns.length > 0) {
            throw migrationError(
                'mobile_source_fuel_wide_columns_missing',
                'fuel wide table is missing required columns',
                missingColumns
            );
        }
        const [indexRows] = await this.connection.execute(`
            SELECT non_unique, GROUP_CONCAT(column_name ORDER BY seq_in_index) AS columns_csv
            FROM information_schema.statistics
            WHERE table_schema = DATABASE()
              AND table_name = ?
              AND index_name = 'uk_mobile_ocr_fuel_wide_key'
            GROUP BY index_name, non_unique
        `, [WIDE_TABLE]);
        const index = indexRows?.[0];
        if (Number(index?.non_unique ?? index?.NON_UNIQUE) !== 0
                || String(index?.columns_csv || index?.COLUMNS_CSV) !== 'wide_record_key') {
            throw migrationError(
                'mobile_source_fuel_wide_unique_key_invalid',
                'wide_record_key must have a single-column unique index'
            );
        }
        return true;
    }

    async validateData() {
        const expectedSelection = buildWideSelectSql({
            snapshotTable: 'mobile_ocr_station_snapshots',
            requireFuelStationType: true,
        });
        const [expectedRows] = await this.connection.execute(`
            SELECT COUNT(*) AS expected_count
            FROM (${expectedSelection.sql}) expected_wide_rows
        `, expectedSelection.parameters);
        const [metricRows] = await this.connection.query(`
            SELECT
                COUNT(*) AS actual_count,
                COUNT(*) - COUNT(DISTINCT wide_record_key) AS duplicate_key_count,
                SUM(station_name IS NULL OR TRIM(station_name) = '') AS empty_station_name_count,
                SUM(record_kind NOT IN (
                    'complete', 'offer-only', 'quote-only', 'station-only'
                )) AS invalid_record_kind_count,
                SUM(
                    selected_amount IS NOT NULL
                    AND discount_amount IS NOT NULL
                    AND service_fee IS NOT NULL
                    AND payable_amount IS NOT NULL
                    AND ABS(
                        selected_amount - discount_amount + service_fee - payable_amount
                    ) > 0.02
                ) AS amount_mismatch_count
            FROM mobile_ocr_fuel_wide_records
        `);
        const [coverageRows] = await this.connection.query(`
            SELECT
                (
                    SELECT COUNT(*)
                    FROM mobile_ocr_fuel_quotes q
                    INNER JOIN mobile_ocr_station_snapshots s
                        ON s.source_record_id = q.source_record_id
                       AND s.station_type = 'fuel'
                    LEFT JOIN mobile_ocr_fuel_wide_records w
                        ON w.source_quote_id = q.id
                    WHERE w.id IS NULL
                ) AS missing_quote_count,
                (
                    SELECT COUNT(*)
                    FROM mobile_ocr_fuel_offers o
                    INNER JOIN mobile_ocr_station_snapshots s
                        ON s.source_record_id = o.source_record_id
                       AND s.station_type = 'fuel'
                    LEFT JOIN mobile_ocr_fuel_wide_records w
                        ON w.source_offer_id = o.id
                    WHERE w.id IS NULL
                ) AS missing_offer_count,
                (
                    SELECT COUNT(*)
                    FROM mobile_ocr_station_snapshots s
                    LEFT JOIN mobile_ocr_fuel_wide_records w
                        ON w.source_record_id = s.source_record_id
                    WHERE s.station_type = 'fuel' AND w.id IS NULL
                ) AS missing_station_count
        `);
        const [kindRows] = await this.connection.query(`
            SELECT record_kind, COUNT(*) AS row_count
            FROM mobile_ocr_fuel_wide_records
            GROUP BY record_kind
            ORDER BY record_kind
        `);
        const expectedCount = Number(expectedRows?.[0]?.expected_count) || 0;
        const metrics = metricRows?.[0] || {};
        const coverage = coverageRows?.[0] || {};
        const hardFailures = {
            countMismatch: expectedCount !== (Number(metrics.actual_count) || 0),
            duplicateKeyCount: Number(metrics.duplicate_key_count) || 0,
            emptyStationNameCount: Number(metrics.empty_station_name_count) || 0,
            invalidRecordKindCount: Number(metrics.invalid_record_kind_count) || 0,
            missingQuoteCount: Number(coverage.missing_quote_count) || 0,
            missingOfferCount: Number(coverage.missing_offer_count) || 0,
            missingStationCount: Number(coverage.missing_station_count) || 0,
        };
        if (Object.values(hardFailures).some(value => value === true || value > 0)) {
            throw migrationError(
                'mobile_source_fuel_wide_data_invalid',
                'fuel wide source coverage validation failed',
                hardFailures
            );
        }
        return {
            expectedCount,
            actualCount: Number(metrics.actual_count) || 0,
            amountMismatchCount: Number(metrics.amount_mismatch_count) || 0,
            recordKinds: Object.fromEntries((kindRows || []).map(row => [
                row.record_kind,
                Number(row.row_count) || 0,
            ])),
            ...hardFailures,
        };
    }

    async acquireLock() {
        const [rows] = await this.connection.execute(
            'SELECT GET_LOCK(?, ?) AS acquired',
            [LOCK_NAME, this.lockTimeoutSeconds]
        );
        if (Number(rows?.[0]?.acquired) !== 1) {
            throw migrationError(
                'mobile_source_fuel_wide_lock_timeout',
                'failed to acquire fuel wide migration lock'
            );
        }
    }

    async releaseLock() {
        try {
            await this.connection.execute('SELECT RELEASE_LOCK(?) AS released', [LOCK_NAME]);
        } catch (error) {
            // The connection closing also releases MySQL advisory locks.
        }
    }

    async recordVersion() {
        await this.connection.execute(`
            INSERT INTO mobile_ocr_schema_migrations (
                component, version, checksum, applied_at
            ) VALUES (?, ?, ?, CURRENT_TIMESTAMP(3))
            ON DUPLICATE KEY UPDATE
                version = VALUES(version),
                checksum = VALUES(checksum),
                applied_at = VALUES(applied_at)
        `, [COMPONENT, TARGET_SCHEMA_VERSION, schemaChecksum()]);
    }

    async ensureAgentReportIpColumn() {
        const [rows] = await this.connection.execute(`
            SELECT COUNT(*) AS column_count
            FROM information_schema.columns
            WHERE table_schema = DATABASE()
              AND table_name = ?
              AND column_name = 'agent_report_ip'
        `, [WIDE_TABLE]);
        if (Number(rows?.[0]?.column_count) === 1) return false;
        await this.connection.query(`
            ALTER TABLE mobile_ocr_fuel_wide_records
            ADD COLUMN agent_report_ip VARCHAR(45) NULL AFTER device_id
        `);
        return true;
    }

    async currentComponent() {
        const [rows] = await this.connection.execute(`
            SELECT version, checksum
            FROM mobile_ocr_schema_migrations
            WHERE component = ?
            LIMIT 1
        `, [COMPONENT]);
        return rows?.[0] || null;
    }
}

module.exports = {
    COMPONENT,
    CREATE_WIDE_TABLE,
    MIGRATION_NAME,
    MIGRATION_PLAN,
    MobileSourceFuelWideMigrator,
    REQUIRED_COLUMNS,
    TARGET_SCHEMA_VERSION,
    WIDE_TABLE,
    schemaChecksum,
};
