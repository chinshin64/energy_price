'use strict';

const crypto = require('node:crypto');

const TARGET_SCHEMA_VERSION = 4;
const MIGRATION_NAME = 'mobile_station_observation_physical_v4';
const COMPONENT = 'mobile-ocr-source';
const LOCK_NAME = 'data-for-didi:mobile-ocr-source:migration';

const TABLES = Object.freeze({
    migrations: 'mobile_ocr_schema_migrations',
    batches: 'mobile_ocr_ingest_batches',
    snapshots: 'mobile_ocr_station_snapshots',
    fuelOffers: 'mobile_ocr_fuel_offers',
    fuelQuotes: 'mobile_ocr_fuel_quotes',
});

const V1_BATCH_COLUMNS = Object.freeze([
    'id', 'ingest_id', 'idempotency_key', 'source_node', 'source_agent',
    'source_type', 'source_stage', 'platform', 'city', 'device_id',
    'session_id', 'page_index', 'client_version', 'captured_at',
    'station_count', 'raw_meta', 'created_at',
]);

const MIGRATION_COLUMNS = Object.freeze([
    'component', 'version', 'checksum', 'applied_at',
]);

const V1_SNAPSHOT_COLUMNS = Object.freeze([
    'source_record_id', 'ingest_batch_id', 'record_index', 'source_node',
    'source_agent', 'source_type', 'source_stage', 'platform', 'city',
    'station_id', 'station_name', 'address', 'latitude', 'longitude',
    'price_fast', 'price_slow', 'price_super', 'price_service',
    'available_ports', 'total_ports', 'fast_idle_ports', 'fast_total_ports',
    'slow_idle_ports', 'slow_total_ports', 'super_idle_ports',
    'super_total_ports', 'captured_at', 'raw_data', 'created_at',
]);

const V2_FUEL_COLUMNS = Object.freeze([
    'id', 'source_record_id', 'offer_index', 'fuel_type', 'grade_code',
    'grade_label', 'list_price', 'discount_price', 'unclassified_price',
    'discount_kind', 'currency', 'unit', 'evidence', 'captured_at',
    'created_at',
]);

const V3_FUEL_COLUMNS = Object.freeze([
    ...V2_FUEL_COLUMNS,
    'display_price', 'station_price', 'national_price',
]);

const V3_FUEL_QUOTE_COLUMNS = Object.freeze([
    'id', 'source_record_id', 'quote_observation_id', 'quote_dedup_key',
    'grade_code', 'grade_label', 'gun_code', 'gun_label',
    'selected_amount', 'gross_discount', 'service_fee', 'net_discount',
    'payable_amount', 'quote_entry', 'needs_review', 'captured_at',
    'raw_data', 'created_at',
]);

const V4_SNAPSHOT_COLUMNS = Object.freeze([
    ...V1_SNAPSHOT_COLUMNS,
    'station_type', 'provider_name',
    'busy_ports', 'port_semantics', 'missing_fields', 'quality_status',
]);

const MIGRATION_PLAN = Object.freeze([
    'acquire-migration-lock',
    'ensure-migration-metadata',
    'ensure-v1-batch-table',
    'ensure-v1-snapshot-table',
    'ensure-v2-batch-columns',
    'ensure-v2-snapshot-columns',
    'ensure-v2-indexes',
    'ensure-v2-fuel-offer-table',
    'ensure-v2-fuel-offer-foreign-key',
    'ensure-v3-provider-column',
    'ensure-v3-fuel-price-columns',
    'ensure-v3-fuel-quote-table',
    'ensure-v3-fuel-quote-indexes',
    'ensure-v3-fuel-quote-foreign-key',
    'ensure-v4-station-observation-columns',
    'verify-physical-schema',
    'record-schema-version-4',
    'verify-target-schema',
]);

const CREATE_MIGRATIONS_TABLE = `
    CREATE TABLE IF NOT EXISTS mobile_ocr_schema_migrations (
        component VARCHAR(64) NOT NULL,
        version INT UNSIGNED NOT NULL,
        checksum CHAR(64) NOT NULL,
        applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (component)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;

const CREATE_BATCH_TABLE = `
    CREATE TABLE IF NOT EXISTS mobile_ocr_ingest_batches (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        ingest_id CHAR(36) NOT NULL,
        idempotency_key CHAR(64) NOT NULL,
        source_node VARCHAR(64) NOT NULL DEFAULT '47-mysql',
        source_agent VARCHAR(64) NOT NULL,
        source_type VARCHAR(32) NOT NULL DEFAULT 'mobile-ocr',
        source_stage VARCHAR(64) NULL,
        platform VARCHAR(64) NOT NULL,
        city VARCHAR(128) NOT NULL,
        device_id VARCHAR(128) NULL,
        session_id VARCHAR(128) NOT NULL,
        page_index INT UNSIGNED NOT NULL DEFAULT 0,
        client_version VARCHAR(64) NULL,
        captured_at DATETIME(3) NOT NULL,
        station_count INT UNSIGNED NOT NULL,
        raw_meta JSON NULL,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (id),
        UNIQUE KEY uk_mobile_ocr_ingest_id (ingest_id),
        UNIQUE KEY uk_mobile_ocr_idempotency (idempotency_key),
        KEY idx_mobile_ocr_batch_agent_time (source_agent, captured_at),
        KEY idx_mobile_ocr_batch_city_time (city, captured_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;

const CREATE_SNAPSHOT_TABLE = `
    CREATE TABLE IF NOT EXISTS mobile_ocr_station_snapshots (
        source_record_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        ingest_batch_id BIGINT UNSIGNED NOT NULL,
        record_index INT UNSIGNED NOT NULL,
        source_node VARCHAR(64) NOT NULL DEFAULT '47-mysql',
        source_agent VARCHAR(64) NOT NULL,
        source_type VARCHAR(32) NOT NULL DEFAULT 'mobile-ocr',
        source_stage VARCHAR(64) NULL,
        platform VARCHAR(64) NOT NULL,
        city VARCHAR(128) NOT NULL,
        station_id VARCHAR(191) NULL,
        station_name VARCHAR(512) NOT NULL,
        address VARCHAR(1024) NULL,
        latitude DECIMAL(10,7) NULL,
        longitude DECIMAL(10,7) NULL,
        price_fast DECIMAL(10,4) NULL,
        price_slow DECIMAL(10,4) NULL,
        price_super DECIMAL(10,4) NULL,
        price_service DECIMAL(10,4) NULL,
        available_ports INT UNSIGNED NOT NULL DEFAULT 0,
        total_ports INT UNSIGNED NOT NULL DEFAULT 0,
        fast_idle_ports INT UNSIGNED NOT NULL DEFAULT 0,
        fast_total_ports INT UNSIGNED NOT NULL DEFAULT 0,
        slow_idle_ports INT UNSIGNED NOT NULL DEFAULT 0,
        slow_total_ports INT UNSIGNED NOT NULL DEFAULT 0,
        super_idle_ports INT UNSIGNED NOT NULL DEFAULT 0,
        super_total_ports INT UNSIGNED NOT NULL DEFAULT 0,
        captured_at DATETIME(3) NOT NULL,
        raw_data JSON NULL,
        station_type VARCHAR(16) NOT NULL DEFAULT 'charging',
        provider_name VARCHAR(128) NULL,
        busy_ports INT UNSIGNED NULL,
        port_semantics VARCHAR(32) NULL,
        missing_fields JSON NULL,
        quality_status VARCHAR(32) NULL,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (source_record_id),
        UNIQUE KEY uk_mobile_ocr_batch_record (ingest_batch_id, record_index),
        KEY idx_mobile_ocr_snapshot_city_cursor (city, source_record_id),
        KEY idx_mobile_ocr_snapshot_platform_cursor (platform, source_record_id),
        KEY idx_mobile_ocr_snapshot_agent_cursor (source_agent, source_record_id),
        CONSTRAINT fk_mobile_ocr_snapshot_batch
            FOREIGN KEY (ingest_batch_id) REFERENCES mobile_ocr_ingest_batches(id)
            ON DELETE RESTRICT ON UPDATE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;

const CREATE_FUEL_OFFERS_TABLE = `
    CREATE TABLE IF NOT EXISTS mobile_ocr_fuel_offers (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        source_record_id BIGINT UNSIGNED NOT NULL,
        offer_index INT UNSIGNED NOT NULL,
        fuel_type VARCHAR(32) NOT NULL,
        grade_code VARCHAR(32) NOT NULL,
        grade_label VARCHAR(64) NOT NULL,
        list_price DECIMAL(10,4) NULL,
        discount_price DECIMAL(10,4) NULL,
        unclassified_price DECIMAL(10,4) NULL,
        discount_kind VARCHAR(32) NOT NULL DEFAULT 'none',
        currency VARCHAR(8) NOT NULL DEFAULT 'CNY',
        unit VARCHAR(32) NOT NULL DEFAULT 'CNY_PER_LITER',
        evidence JSON NOT NULL,
        captured_at DATETIME(3) NOT NULL,
        display_price DECIMAL(10,4) NULL,
        station_price DECIMAL(10,4) NULL,
        national_price DECIMAL(10,4) NULL,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (id),
        UNIQUE KEY uq_mobile_ocr_fuel_offer (source_record_id, offer_index),
        KEY idx_mobile_ocr_fuel_offer_grade (grade_code, source_record_id),
        CONSTRAINT fk_mobile_ocr_fuel_offer_snapshot
            FOREIGN KEY (source_record_id)
            REFERENCES mobile_ocr_station_snapshots(source_record_id)
            ON DELETE CASCADE ON UPDATE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;

const CREATE_FUEL_QUOTES_TABLE = `
    CREATE TABLE IF NOT EXISTS mobile_ocr_fuel_quotes (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        source_record_id BIGINT UNSIGNED NOT NULL,
        quote_observation_id VARCHAR(128) NOT NULL,
        quote_dedup_key CHAR(64) NOT NULL,
        grade_code VARCHAR(32) NOT NULL,
        grade_label VARCHAR(64) NOT NULL,
        gun_code VARCHAR(32) NULL,
        gun_label VARCHAR(64) NULL,
        selected_amount DECIMAL(12,2) NOT NULL,
        gross_discount DECIMAL(12,2) NULL,
        service_fee DECIMAL(12,2) NULL,
        net_discount DECIMAL(12,2) NULL,
        payable_amount DECIMAL(12,2) NULL,
        quote_entry VARCHAR(32) NOT NULL,
        needs_review TINYINT(1) NOT NULL DEFAULT 0,
        captured_at DATETIME(3) NOT NULL,
        raw_data JSON NULL,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (id),
        UNIQUE KEY uq_mobile_ocr_quote_observation (quote_observation_id),
        UNIQUE KEY uq_mobile_ocr_quote_dedup (quote_dedup_key),
        KEY idx_mobile_ocr_quote_grade (grade_code, source_record_id),
        CONSTRAINT fk_mobile_ocr_fuel_quote_snapshot
            FOREIGN KEY (source_record_id)
            REFERENCES mobile_ocr_station_snapshots(source_record_id)
            ON DELETE CASCADE ON UPDATE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;

const INDEXES = Object.freeze([
    {
        table: TABLES.batches,
        name: 'uk_mobile_ocr_ingest_id',
        columns: ['ingest_id'],
        unique: true,
    },
    {
        table: TABLES.batches,
        name: 'uk_mobile_ocr_idempotency',
        columns: ['idempotency_key'],
        unique: true,
    },
    {
        table: TABLES.batches,
        name: 'idx_mobile_ocr_batch_agent_time',
        columns: ['source_agent', 'captured_at'],
    },
    {
        table: TABLES.batches,
        name: 'idx_mobile_ocr_batch_city_time',
        columns: ['city', 'captured_at'],
    },
    {
        table: TABLES.batches,
        name: 'idx_mobile_ocr_batch_observation_type',
        columns: ['observation_type', 'id'],
    },
    {
        table: TABLES.snapshots,
        name: 'uk_mobile_ocr_batch_record',
        columns: ['ingest_batch_id', 'record_index'],
        unique: true,
    },
    {
        table: TABLES.snapshots,
        name: 'idx_mobile_ocr_snapshot_city_cursor',
        columns: ['city', 'source_record_id'],
    },
    {
        table: TABLES.snapshots,
        name: 'idx_mobile_ocr_snapshot_platform_cursor',
        columns: ['platform', 'source_record_id'],
    },
    {
        table: TABLES.snapshots,
        name: 'idx_mobile_ocr_snapshot_agent_cursor',
        columns: ['source_agent', 'source_record_id'],
    },
    {
        table: TABLES.snapshots,
        name: 'idx_mobile_ocr_snapshot_station_type',
        columns: ['station_type', 'source_record_id'],
    },
    {
        table: TABLES.fuelOffers,
        name: 'uq_mobile_ocr_fuel_offer',
        columns: ['source_record_id', 'offer_index'],
        unique: true,
    },
    {
        table: TABLES.fuelOffers,
        name: 'idx_mobile_ocr_fuel_offer_grade',
        columns: ['grade_code', 'source_record_id'],
    },
    {
        table: TABLES.fuelQuotes,
        name: 'uq_mobile_ocr_quote_observation',
        columns: ['quote_observation_id'],
        unique: true,
    },
    {
        table: TABLES.fuelQuotes,
        name: 'uq_mobile_ocr_quote_dedup',
        columns: ['quote_dedup_key'],
        unique: true,
    },
    {
        table: TABLES.fuelQuotes,
        name: 'idx_mobile_ocr_quote_grade',
        columns: ['grade_code', 'source_record_id'],
    },
]);

const FOREIGN_KEYS = Object.freeze([
    {
        table: TABLES.snapshots,
        name: 'fk_mobile_ocr_snapshot_batch',
        column: 'ingest_batch_id',
        referencedTable: TABLES.batches,
        referencedColumn: 'id',
        onDelete: 'RESTRICT',
        onUpdate: 'RESTRICT',
    },
    {
        table: TABLES.fuelOffers,
        name: 'fk_mobile_ocr_fuel_offer_snapshot',
        column: 'source_record_id',
        referencedTable: TABLES.snapshots,
        referencedColumn: 'source_record_id',
        onDelete: 'CASCADE',
        onUpdate: 'RESTRICT',
    },
    {
        table: TABLES.fuelQuotes,
        name: 'fk_mobile_ocr_fuel_quote_snapshot',
        column: 'source_record_id',
        referencedTable: TABLES.snapshots,
        referencedColumn: 'source_record_id',
        onDelete: 'CASCADE',
        onUpdate: 'RESTRICT',
    },
]);

function migrationError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function normalizeReferentialAction(action) {
    const normalized = String(action || '').trim().toUpperCase();
    return normalized === 'NO ACTION' ? 'RESTRICT' : normalized;
}

function schemaChecksum() {
    const manifest = JSON.stringify({
        target: TARGET_SCHEMA_VERSION,
        migrationName: MIGRATION_NAME,
        tables: TABLES,
        batchColumns: [...V1_BATCH_COLUMNS, 'schema_version', 'observation_type'],
        snapshotColumns: V4_SNAPSHOT_COLUMNS,
        fuelColumns: V3_FUEL_COLUMNS,
        fuelQuoteColumns: V3_FUEL_QUOTE_COLUMNS,
        indexes: INDEXES,
        foreignKeys: FOREIGN_KEYS,
    });
    return crypto.createHash('sha256').update(manifest).digest('hex');
}

class MobileSourceMysqlMigrator {
    constructor(options = {}) {
        if (!options.connection) throw new TypeError('MySQL migration connection is required');
        this.connection = options.connection;
        this.lockTimeoutSeconds = Number.isInteger(options.lockTimeoutSeconds)
            ? options.lockTimeoutSeconds
            : 30;
        this.appliedSteps = [];
    }

    async migrate() {
        await this.acquireLock();
        try {
            await this.ensureTable(TABLES.migrations, CREATE_MIGRATIONS_TABLE);
            const existingVersion = await this.currentVersion();
            if (existingVersion === TARGET_SCHEMA_VERSION) {
                await this.validatePhysicalSchema();
                return {
                    component: COMPONENT,
                    migrationName: MIGRATION_NAME,
                    schemaVersion: TARGET_SCHEMA_VERSION,
                    appliedSteps: [...this.appliedSteps],
                };
            }
            await this.ensureTable(TABLES.batches, CREATE_BATCH_TABLE);
            await this.ensureTable(TABLES.snapshots, CREATE_SNAPSHOT_TABLE);
            await this.assertColumns(TABLES.batches, V1_BATCH_COLUMNS, 'v1 batch');
            await this.assertColumns(TABLES.snapshots, V1_SNAPSHOT_COLUMNS, 'v1 snapshot');

            await this.ensureColumn(
                TABLES.batches,
                'schema_version',
                'INT NOT NULL DEFAULT 1'
            );
            await this.ensureColumn(
                TABLES.batches,
                'observation_type',
                "VARCHAR(16) NOT NULL DEFAULT 'charging'"
            );
            await this.ensureColumn(
                TABLES.snapshots,
                'station_type',
                "VARCHAR(16) NOT NULL DEFAULT 'charging'"
            );

            for (const index of INDEXES.filter(item =>
                item.table === TABLES.batches || item.table === TABLES.snapshots
            )) {
                await this.ensureIndex(index);
            }
            await this.ensureForeignKey(FOREIGN_KEYS[0]);

            await this.ensureTable(TABLES.fuelOffers, CREATE_FUEL_OFFERS_TABLE);
            await this.assertColumns(TABLES.fuelOffers, V2_FUEL_COLUMNS, 'v2 fuel offer');
            for (const index of INDEXES.filter(item => item.table === TABLES.fuelOffers)) {
                await this.ensureIndex(index);
            }
            await this.ensureForeignKey(FOREIGN_KEYS[1]);

            await this.ensureColumn(
                TABLES.snapshots,
                'provider_name',
                'VARCHAR(128) NULL'
            );
            for (const column of ['display_price', 'station_price', 'national_price']) {
                await this.ensureColumn(
                    TABLES.fuelOffers,
                    column,
                    'DECIMAL(10,4) NULL'
                );
            }

            await this.ensureTable(TABLES.fuelQuotes, CREATE_FUEL_QUOTES_TABLE);
            await this.assertColumns(
                TABLES.fuelQuotes,
                V3_FUEL_QUOTE_COLUMNS,
                'v3 fuel quote'
            );
            for (const index of INDEXES.filter(item => item.table === TABLES.fuelQuotes)) {
                await this.ensureIndex(index);
            }
            await this.ensureForeignKey(FOREIGN_KEYS[2]);

            await this.ensureColumn(TABLES.snapshots, 'busy_ports', 'INT UNSIGNED NULL');
            await this.ensureColumn(TABLES.snapshots, 'port_semantics', 'VARCHAR(32) NULL');
            await this.ensureColumn(TABLES.snapshots, 'missing_fields', 'JSON NULL');
            await this.ensureColumn(TABLES.snapshots, 'quality_status', 'VARCHAR(32) NULL');

            await this.validatePhysicalSchema();
            await this.recordTargetVersion();
            return {
                component: COMPONENT,
                migrationName: MIGRATION_NAME,
                schemaVersion: TARGET_SCHEMA_VERSION,
                appliedSteps: [...this.appliedSteps],
            };
        } finally {
            await this.releaseLock();
        }
    }

    async validate() {
        await this.validatePhysicalSchema();
        const version = await this.currentVersion();
        if (version !== TARGET_SCHEMA_VERSION) {
            throw migrationError(
                'mobile_source_schema_version_invalid',
                'mobile source schema target version is not recorded'
            );
        }
        return {
            component: COMPONENT,
            migrationName: MIGRATION_NAME,
            schemaVersion: version,
            valid: true,
        };
    }

    async validatePhysicalSchema() {
        for (const table of Object.values(TABLES)) {
            if (!await this.tableExists(table)) {
                throw migrationError(
                    'mobile_source_schema_table_missing',
                    `required mobile source table is missing: ${table}`
                );
            }
        }
        await this.assertColumns(TABLES.migrations, MIGRATION_COLUMNS, 'migration metadata');
        await this.assertColumns(TABLES.batches, [...V1_BATCH_COLUMNS, 'schema_version', 'observation_type'], 'v2 batch');
        await this.assertColumns(
            TABLES.snapshots,
            V4_SNAPSHOT_COLUMNS,
            'v4 snapshot'
        );
        await this.assertColumns(TABLES.fuelOffers, V3_FUEL_COLUMNS, 'v3 fuel offer');
        await this.assertColumns(TABLES.fuelQuotes, V3_FUEL_QUOTE_COLUMNS, 'v3 fuel quote');
        await this.assertColumnShape(TABLES.batches, 'schema_version', {
            dataType: 'int',
            nullable: false,
            defaultValue: '1',
        });
        await this.assertColumnShape(TABLES.batches, 'observation_type', {
            dataType: 'varchar',
            maxLength: 16,
            nullable: false,
            defaultValue: 'charging',
        });
        await this.assertColumnShape(TABLES.snapshots, 'station_type', {
            dataType: 'varchar',
            maxLength: 16,
            nullable: false,
            defaultValue: 'charging',
        });
        await this.assertColumnShape(TABLES.snapshots, 'provider_name', {
            dataType: 'varchar',
            maxLength: 128,
            nullable: true,
            defaultValue: null,
        });
        await this.assertColumnShape(TABLES.snapshots, 'busy_ports', {
            dataType: 'int',
            nullable: true,
            defaultValue: null,
        });
        await this.assertColumnShape(TABLES.snapshots, 'port_semantics', {
            dataType: 'varchar',
            maxLength: 32,
            nullable: true,
            defaultValue: null,
        });
        await this.assertColumnShape(TABLES.snapshots, 'missing_fields', {
            dataType: 'json',
            nullable: true,
            defaultValue: null,
        });
        await this.assertColumnShape(TABLES.snapshots, 'quality_status', {
            dataType: 'varchar',
            maxLength: 32,
            nullable: true,
            defaultValue: null,
        });
        for (const column of ['display_price', 'station_price', 'national_price']) {
            await this.assertColumnShape(TABLES.fuelOffers, column, {
                dataType: 'decimal',
                numericPrecision: 10,
                numericScale: 4,
                nullable: true,
                defaultValue: null,
            });
        }
        for (const column of [
            'selected_amount', 'gross_discount', 'service_fee',
            'net_discount', 'payable_amount',
        ]) {
            await this.assertColumnShape(TABLES.fuelQuotes, column, {
                dataType: 'decimal',
                numericPrecision: 12,
                numericScale: 2,
                nullable: column !== 'selected_amount',
                defaultValue: null,
            });
        }
        await this.assertColumnShape(TABLES.fuelQuotes, 'quote_observation_id', {
            dataType: 'varchar',
            maxLength: 128,
            nullable: false,
            defaultValue: null,
        });
        await this.assertColumnShape(TABLES.fuelQuotes, 'quote_dedup_key', {
            dataType: 'char',
            maxLength: 64,
            nullable: false,
            defaultValue: null,
        });
        await this.assertColumnShape(TABLES.fuelQuotes, 'needs_review', {
            dataType: 'tinyint',
            numericPrecision: 3,
            numericScale: 0,
            nullable: false,
            defaultValue: '0',
        });
        for (const index of INDEXES) {
            if (!await this.indexMatches(index)) {
                throw migrationError(
                    'mobile_source_schema_index_invalid',
                    `required mobile source index is missing or invalid: ${index.name}`
                );
            }
        }
        for (const foreignKey of FOREIGN_KEYS) {
            if (!await this.foreignKeyMatches(foreignKey)) {
                throw migrationError(
                    'mobile_source_schema_foreign_key_invalid',
                    `required mobile source foreign key is missing or invalid: ${foreignKey.name}`
                );
            }
        }
        return true;
    }

    async acquireLock() {
        const [rows] = await this.connection.execute(
            'SELECT GET_LOCK(?, ?) AS acquired',
            [LOCK_NAME, this.lockTimeoutSeconds]
        );
        if (Number(rows?.[0]?.acquired) !== 1) {
            throw migrationError(
                'mobile_source_migration_lock_unavailable',
                'mobile source migration lock is unavailable'
            );
        }
    }

    async releaseLock() {
        try {
            await this.connection.execute('SELECT RELEASE_LOCK(?) AS released', [LOCK_NAME]);
        } catch {
            // The original migration result must win; MySQL also releases the lock on disconnect.
        }
    }

    async ensureTable(table, createSql) {
        if (await this.tableExists(table)) return;
        await this.executeDdl(createSql, `create-table:${table}`);
        if (!await this.tableExists(table)) {
            throw migrationError(
                'mobile_source_migration_table_create_failed',
                `mobile source table was not created: ${table}`
            );
        }
    }

    async ensureColumn(table, column, definition) {
        if (await this.columnInfo(table, column)) return;
        await this.executeDdl(
            `ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`,
            `add-column:${table}.${column}`
        );
        if (!await this.columnInfo(table, column)) {
            throw migrationError(
                'mobile_source_migration_column_create_failed',
                `mobile source column was not created: ${table}.${column}`
            );
        }
    }

    async ensureIndex(index) {
        if (await this.indexMatches(index)) return;
        if (await this.indexExists(index.table, index.name)) {
            throw migrationError(
                'mobile_source_schema_index_conflict',
                `mobile source index exists with an incompatible definition: ${index.name}`
            );
        }
        const uniqueness = index.unique ? 'UNIQUE ' : '';
        const columns = index.columns.map(column => `\`${column}\``).join(', ');
        await this.executeDdl(
            `CREATE ${uniqueness}INDEX \`${index.name}\` ON \`${index.table}\` (${columns})`,
            `create-index:${index.name}`
        );
        if (!await this.indexMatches(index)) {
            throw migrationError(
                'mobile_source_migration_index_create_failed',
                `mobile source index was not created: ${index.name}`
            );
        }
    }

    async ensureForeignKey(foreignKey) {
        if (await this.foreignKeyMatches(foreignKey)) return;
        if (await this.constraintExists(foreignKey.table, foreignKey.name)) {
            throw migrationError(
                'mobile_source_schema_foreign_key_conflict',
                `mobile source foreign key exists with an incompatible definition: ${foreignKey.name}`
            );
        }
        await this.executeDdl(
            `ALTER TABLE \`${foreignKey.table}\` `
                + `ADD CONSTRAINT \`${foreignKey.name}\` `
                + `FOREIGN KEY (\`${foreignKey.column}\`) `
                + `REFERENCES \`${foreignKey.referencedTable}\` (\`${foreignKey.referencedColumn}\`) `
                + `ON DELETE ${foreignKey.onDelete} ON UPDATE ${foreignKey.onUpdate}`,
            `create-foreign-key:${foreignKey.name}`
        );
        if (!await this.foreignKeyMatches(foreignKey)) {
            throw migrationError(
                'mobile_source_migration_foreign_key_create_failed',
                `mobile source foreign key was not created: ${foreignKey.name}`
            );
        }
    }

    async executeDdl(sql, step) {
        if (/delimiter|create\s+procedure|call\s+/i.test(sql)) {
            throw migrationError(
                'mobile_source_migration_unsupported_statement',
                'client commands and stored procedures are not allowed in the migration runner'
            );
        }
        await this.connection.query(sql);
        this.appliedSteps.push(step);
    }

    async tableExists(table) {
        const [rows] = await this.connection.execute(`
            SELECT table_name AS table_name
            FROM information_schema.tables
            WHERE table_schema = DATABASE() AND table_name = ?
            LIMIT 1
        `, [table]);
        return rows.length === 1;
    }

    async columnInfo(table, column) {
        const [rows] = await this.connection.execute(`
            SELECT column_name AS column_name,
                   data_type AS data_type,
                   character_maximum_length AS character_maximum_length,
                   numeric_precision AS numeric_precision,
                   numeric_scale AS numeric_scale,
                   is_nullable AS is_nullable,
                   column_default AS column_default
            FROM information_schema.columns
            WHERE table_schema = DATABASE()
              AND table_name = ?
              AND column_name = ?
            LIMIT 1
        `, [table, column]);
        return rows[0] || null;
    }

    async assertColumns(table, columns, label) {
        const [rows] = await this.connection.execute(`
            SELECT column_name AS column_name
            FROM information_schema.columns
            WHERE table_schema = DATABASE() AND table_name = ?
        `, [table]);
        const present = new Set(rows.map(row => String(row.column_name)));
        const missing = columns.filter(column => !present.has(column));
        if (missing.length > 0) {
            throw migrationError(
                'mobile_source_schema_columns_missing',
                `${label} schema is incomplete; missing columns: ${missing.join(',')}`
            );
        }
    }

    async assertColumnShape(table, column, expected) {
        const actual = await this.columnInfo(table, column);
        const valid = actual
            && String(actual.data_type).toLowerCase() === expected.dataType
            && (expected.maxLength === undefined
                || Number(actual.character_maximum_length) === expected.maxLength)
            && (expected.numericPrecision === undefined
                || Number(actual.numeric_precision) === expected.numericPrecision)
            && (expected.numericScale === undefined
                || Number(actual.numeric_scale) === expected.numericScale)
            && (String(actual.is_nullable).toUpperCase() === 'YES') === expected.nullable
            && (expected.defaultValue === null
                ? actual.column_default === null
                : String(actual.column_default) === String(expected.defaultValue));
        if (!valid) {
            throw migrationError(
                'mobile_source_schema_column_invalid',
                `mobile source column has an incompatible definition: ${table}.${column}`
            );
        }
    }

    async indexExists(table, name) {
        const [rows] = await this.connection.execute(`
            SELECT index_name AS index_name
            FROM information_schema.statistics
            WHERE table_schema = DATABASE()
              AND table_name = ?
              AND index_name = ?
            LIMIT 1
        `, [table, name]);
        return rows.length > 0;
    }

    async indexMatches(index) {
        const [rows] = await this.connection.execute(`
            SELECT column_name AS column_name,
                   non_unique AS non_unique,
                   seq_in_index AS seq_in_index
            FROM information_schema.statistics
            WHERE table_schema = DATABASE()
              AND table_name = ?
              AND index_name = ?
            ORDER BY seq_in_index
        `, [index.table, index.name]);
        const columns = rows.map(row => String(row.column_name));
        const unique = rows.length > 0 && Number(rows[0].non_unique) === 0;
        return columns.length === index.columns.length
            && columns.every((column, position) => column === index.columns[position])
            && unique === Boolean(index.unique);
    }

    async constraintExists(table, name) {
        const [rows] = await this.connection.execute(`
            SELECT constraint_name AS constraint_name
            FROM information_schema.table_constraints
            WHERE table_schema = DATABASE()
              AND table_name = ?
              AND constraint_name = ?
            LIMIT 1
        `, [table, name]);
        return rows.length > 0;
    }

    async foreignKeyMatches(foreignKey) {
        const [rows] = await this.connection.execute(`
            SELECT kcu.column_name AS column_name,
                   kcu.referenced_table_name AS referenced_table_name,
                   kcu.referenced_column_name AS referenced_column_name,
                   rc.delete_rule AS delete_rule,
                   rc.update_rule AS update_rule
            FROM information_schema.key_column_usage kcu
            INNER JOIN information_schema.referential_constraints rc
                ON rc.constraint_schema = kcu.constraint_schema
               AND rc.table_name = kcu.table_name
               AND rc.constraint_name = kcu.constraint_name
            WHERE kcu.table_schema = DATABASE()
              AND kcu.table_name = ?
              AND kcu.constraint_name = ?
              AND kcu.referenced_table_name IS NOT NULL
            ORDER BY kcu.ordinal_position
        `, [foreignKey.table, foreignKey.name]);
        return rows.length === 1
            && String(rows[0].column_name) === foreignKey.column
            && String(rows[0].referenced_table_name) === foreignKey.referencedTable
            && String(rows[0].referenced_column_name) === foreignKey.referencedColumn
            && normalizeReferentialAction(rows[0].delete_rule) === foreignKey.onDelete
            && normalizeReferentialAction(rows[0].update_rule) === foreignKey.onUpdate;
    }

    async recordTargetVersion() {
        const [result] = await this.connection.execute(`
            INSERT INTO mobile_ocr_schema_migrations (
                component, version, checksum, applied_at
            ) VALUES (?, ?, ?, CURRENT_TIMESTAMP(3))
            ON DUPLICATE KEY UPDATE
                checksum = IF(version < VALUES(version), VALUES(checksum), checksum),
                applied_at = IF(version < VALUES(version), VALUES(applied_at), applied_at),
                version = IF(version < VALUES(version), VALUES(version), version)
        `, [COMPONENT, TARGET_SCHEMA_VERSION, schemaChecksum()]);
        if (Number(result?.affectedRows) < 1) {
            throw migrationError(
                'mobile_source_schema_version_write_declined',
                'mobile source schema version was not advanced'
            );
        }
        this.appliedSteps.push('record-version:4');
    }

    async currentVersion() {
        if (!await this.tableExists(TABLES.migrations)) return null;
        const [rows] = await this.connection.execute(`
            SELECT version, checksum
            FROM mobile_ocr_schema_migrations
            WHERE component = ?
            LIMIT 1
        `, [COMPONENT]);
        if (rows.length === 0) return null;
        const version = Number(rows[0].version);
        if (!Number.isInteger(version) || version < 0) {
            throw migrationError(
                'mobile_source_schema_version_invalid',
                'mobile source schema version metadata is invalid'
            );
        }
        if (version > TARGET_SCHEMA_VERSION) {
            throw migrationError(
                'mobile_source_schema_future_version',
                'mobile source schema is newer than this migration runner'
            );
        }
        if (version === TARGET_SCHEMA_VERSION
                && String(rows[0].checksum) !== schemaChecksum()) {
            throw migrationError(
                'mobile_source_schema_checksum_invalid',
                'mobile source schema checksum does not match the target manifest'
            );
        }
        return version;
    }
}

module.exports = {
    COMPONENT,
    FOREIGN_KEYS,
    INDEXES,
    LOCK_NAME,
    MIGRATION_NAME,
    MIGRATION_PLAN,
    MobileSourceMysqlMigrator,
    TABLES,
    TARGET_SCHEMA_VERSION,
    V1_BATCH_COLUMNS,
    V1_SNAPSHOT_COLUMNS,
    V2_FUEL_COLUMNS,
    V3_FUEL_COLUMNS,
    V3_FUEL_QUOTE_COLUMNS,
    V4_SNAPSHOT_COLUMNS,
    schemaChecksum,
};
