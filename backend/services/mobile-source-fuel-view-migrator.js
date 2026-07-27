'use strict';

const crypto = require('node:crypto');

const TARGET_SCHEMA_VERSION = 1;
const MINIMUM_SOURCE_SCHEMA_VERSION = 4;
const MIGRATION_NAME = 'mobile_fuel_complete_view_v1';
const COMPONENT = 'mobile-ocr-source-fuel-view';
const SOURCE_COMPONENT = 'mobile-ocr-source';
const LOCK_NAME = 'data-for-didi:mobile-ocr-source:fuel-view-v1';
const VIEW_NAME = 'mobile_ocr_fuel_complete_records';
const VIEW_COLUMNS = Object.freeze([
    'source_record_id', 'ingest_id', 'channel', 'platform', 'city',
    'station_id', 'station_name', 'grade_code', 'grade_label',
    'display_price', 'discount_amount', 'service_fee', 'payable_amount',
    'cp_name', 'quote_observation_id', 'needs_review', 'captured_at',
]);
const SOURCE_TABLE_COLUMNS = Object.freeze({
    mobile_ocr_ingest_batches: Object.freeze(['id', 'ingest_id', 'platform']),
    mobile_ocr_station_snapshots: Object.freeze([
        'source_record_id', 'ingest_batch_id', 'platform', 'city',
        'station_id', 'station_name', 'provider_name', 'captured_at',
    ]),
    mobile_ocr_fuel_offers: Object.freeze([
        'source_record_id', 'grade_code', 'grade_label', 'display_price', 'captured_at',
    ]),
    mobile_ocr_fuel_quotes: Object.freeze([
        'source_record_id', 'quote_observation_id', 'grade_code',
        'gross_discount', 'service_fee', 'payable_amount', 'needs_review', 'captured_at',
    ]),
});

const CREATE_VIEW_SQL = `
    CREATE OR REPLACE
    ALGORITHM=UNDEFINED
    SQL SECURITY INVOKER
    VIEW mobile_ocr_fuel_complete_records AS
    SELECT
        s.source_record_id AS source_record_id,
        b.ingest_id AS ingest_id,
        b.platform AS channel,
        s.platform AS platform,
        s.city AS city,
        s.station_id AS station_id,
        s.station_name AS station_name,
        o.grade_code AS grade_code,
        o.grade_label AS grade_label,
        o.display_price AS display_price,
        q.gross_discount AS discount_amount,
        q.service_fee AS service_fee,
        q.payable_amount AS payable_amount,
        s.provider_name AS cp_name,
        q.quote_observation_id AS quote_observation_id,
        q.needs_review AS needs_review,
        COALESCE(q.captured_at, o.captured_at, s.captured_at) AS captured_at
    FROM mobile_ocr_station_snapshots AS s
    INNER JOIN mobile_ocr_ingest_batches AS b
        ON b.id = s.ingest_batch_id
    LEFT JOIN mobile_ocr_fuel_offers AS o
        ON o.source_record_id = s.source_record_id
    LEFT JOIN mobile_ocr_fuel_quotes AS q
        ON q.source_record_id = s.source_record_id
       AND q.grade_code = o.grade_code
`;

function schemaChecksum() {
    return crypto.createHash('sha256').update(JSON.stringify({
        target: TARGET_SCHEMA_VERSION,
        migrationName: MIGRATION_NAME,
        viewName: VIEW_NAME,
        columns: VIEW_COLUMNS,
        definition: CREATE_VIEW_SQL.replace(/\s+/g, ' ').trim(),
    })).digest('hex');
}

function migrationError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

class MobileSourceFuelViewMigrator {
    constructor(options = {}) {
        if (!options.connection) throw new TypeError('MySQL migration connection is required');
        this.connection = options.connection;
        this.lockTimeoutSeconds = Number.isInteger(options.lockTimeoutSeconds)
            ? options.lockTimeoutSeconds
            : 30;
    }

    async migrate() {
        await this.acquireLock();
        try {
            await this.requireSourceV4();
            await this.validateSourceTables();
            const version = await this.currentVersion();
            if (version !== TARGET_SCHEMA_VERSION) {
                await this.connection.query(CREATE_VIEW_SQL);
                await this.validatePhysicalView();
                await this.recordVersion();
            } else {
                await this.validatePhysicalView();
            }
            return {
                component: COMPONENT,
                migrationName: MIGRATION_NAME,
                schemaVersion: TARGET_SCHEMA_VERSION,
                viewName: VIEW_NAME,
            };
        } finally {
            await this.releaseLock();
        }
    }

    async validate() {
        await this.requireSourceV4();
        await this.validateSourceTables();
        const version = await this.currentVersion();
        if (version !== TARGET_SCHEMA_VERSION) {
            throw migrationError(
                'mobile_source_fuel_view_version_missing',
                'mobile source fuel view migration is not applied'
            );
        }
        await this.validatePhysicalView();
        return {
            valid: true,
            schemaVersion: TARGET_SCHEMA_VERSION,
            viewName: VIEW_NAME,
        };
    }

    async requireSourceV4() {
        const [rows] = await this.connection.execute(`
            SELECT version AS version
            FROM mobile_ocr_schema_migrations
            WHERE component = ?
            LIMIT 1
        `, [SOURCE_COMPONENT]);
        if (Number(rows?.[0]?.version) < MINIMUM_SOURCE_SCHEMA_VERSION) {
            throw migrationError(
                'mobile_source_fuel_view_requires_v4',
                'fuel complete view requires mobile source schema v4 or newer'
            );
        }
    }

    async validateSourceTables() {
        for (const [table, requiredColumns] of Object.entries(SOURCE_TABLE_COLUMNS)) {
            const [rows] = await this.connection.execute(`
                SELECT column_name AS column_name
                FROM information_schema.columns
                WHERE table_schema = DATABASE() AND table_name = ?
            `, [table]);
            const present = new Set(rows.map(row => String(row.column_name)));
            const missing = requiredColumns.filter(column => !present.has(column));
            if (missing.length > 0) {
                throw migrationError(
                    'mobile_source_fuel_view_source_schema_invalid',
                    `fuel view source table is missing required columns: ${table}.${missing.join(',')}`
                );
            }
        }
    }

    async validatePhysicalView() {
        const [views] = await this.connection.execute(`
            SELECT table_name AS table_name
            FROM information_schema.views
            WHERE table_schema = DATABASE() AND table_name = ?
            LIMIT 1
        `, [VIEW_NAME]);
        if (views.length !== 1) {
            throw migrationError(
                'mobile_source_fuel_view_missing',
                'mobile source fuel complete view is missing'
            );
        }
        const [columns] = await this.connection.execute(`
            SELECT column_name AS column_name
            FROM information_schema.columns
            WHERE table_schema = DATABASE() AND table_name = ?
            ORDER BY ordinal_position
        `, [VIEW_NAME]);
        const actual = columns.map(row => String(row.column_name));
        if (actual.length !== VIEW_COLUMNS.length
                || VIEW_COLUMNS.some((name, index) => actual[index] !== name)) {
            throw migrationError(
                'mobile_source_fuel_view_columns_invalid',
                'mobile source fuel complete view columns do not match the contract'
            );
        }
    }

    async currentVersion() {
        const [rows] = await this.connection.execute(`
            SELECT version AS version, checksum AS checksum
            FROM mobile_ocr_schema_migrations
            WHERE component = ?
            LIMIT 1
        `, [COMPONENT]);
        if (rows.length === 0) return null;
        const version = Number(rows[0].version);
        if (version > TARGET_SCHEMA_VERSION) {
            throw migrationError(
                'mobile_source_fuel_view_future_version',
                'mobile source fuel view schema is newer than this runner'
            );
        }
        if (version === TARGET_SCHEMA_VERSION && String(rows[0].checksum) !== schemaChecksum()) {
            throw migrationError(
                'mobile_source_fuel_view_checksum_invalid',
                'mobile source fuel view checksum does not match the target manifest'
            );
        }
        return version;
    }

    async recordVersion() {
        const [result] = await this.connection.execute(`
            INSERT INTO mobile_ocr_schema_migrations (
                component, version, checksum, applied_at
            ) VALUES (?, ?, ?, CURRENT_TIMESTAMP(3))
            ON DUPLICATE KEY UPDATE
                checksum = VALUES(checksum),
                applied_at = VALUES(applied_at),
                version = VALUES(version)
        `, [COMPONENT, TARGET_SCHEMA_VERSION, schemaChecksum()]);
        if (Number(result?.affectedRows) < 1) {
            throw migrationError(
                'mobile_source_fuel_view_version_write_declined',
                'mobile source fuel view version was not recorded'
            );
        }
    }

    async acquireLock() {
        const [rows] = await this.connection.execute(
            'SELECT GET_LOCK(?, ?) AS acquired',
            [LOCK_NAME, this.lockTimeoutSeconds]
        );
        if (Number(rows?.[0]?.acquired) !== 1) {
            throw migrationError(
                'mobile_source_fuel_view_lock_unavailable',
                'mobile source fuel view migration lock is unavailable'
            );
        }
    }

    async releaseLock() {
        try {
            await this.connection.execute('SELECT RELEASE_LOCK(?) AS released', [LOCK_NAME]);
        } catch {
            // MySQL releases the named lock when the migration connection closes.
        }
    }
}

module.exports = {
    COMPONENT,
    CREATE_VIEW_SQL,
    MINIMUM_SOURCE_SCHEMA_VERSION,
    MIGRATION_NAME,
    MobileSourceFuelViewMigrator,
    SOURCE_COMPONENT,
    SOURCE_TABLE_COLUMNS,
    TARGET_SCHEMA_VERSION,
    VIEW_COLUMNS,
    VIEW_NAME,
    schemaChecksum,
};
