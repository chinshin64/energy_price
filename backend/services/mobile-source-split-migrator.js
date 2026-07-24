'use strict';

const crypto = require('node:crypto');

// v5 拆表迁移：将充电/加油拆为独立表，新增全局游标表。
// v4 迁移器（mobile-source-mysql-migrator.js）保持不动，本迁移器在其之上增量执行。
// 旧表 mobile_ocr_station_snapshots 保留为只读兜底，不在此删除。

const TARGET_SCHEMA_VERSION = 5;
const MIGRATION_NAME = 'mobile_station_observation_split_v5';
// v5 使用独立 component，与 v4 版本记录隔离，避免 v4 的 future-version 校验拒绝 v5。
const COMPONENT = 'mobile-ocr-source-split';
const LOCK_NAME = 'data-for-didi:mobile-ocr-source:migration-v5';

const TABLES = Object.freeze({
    migrations: 'mobile_ocr_schema_migrations',
    batches: 'mobile_ocr_ingest_batches',
    // v4 旧表（保留，只读兜底）
    snapshots: 'mobile_ocr_station_snapshots',
    fuelOffers: 'mobile_ocr_fuel_offers',
    fuelQuotes: 'mobile_ocr_fuel_quotes',
    // v5 新表
    chargingSnapshots: 'mobile_ocr_charging_snapshots',
    fuelSnapshots: 'mobile_ocr_fuel_snapshots',
    sourceCursor: 'mobile_ocr_source_record_cursor',
});

// v5 新表列定义（用于 assertColumns 校验）
const CHARGING_SNAPSHOT_COLUMNS = Object.freeze([
    'source_record_id', 'ingest_batch_id', 'record_index', 'source_node',
    'source_agent', 'source_type', 'source_stage', 'platform', 'city',
    'station_id', 'station_name', 'address', 'latitude', 'longitude',
    'price_fast', 'price_slow', 'price_super', 'price_service',
    'available_ports', 'total_ports', 'fast_idle_ports', 'fast_total_ports',
    'slow_idle_ports', 'slow_total_ports', 'super_idle_ports',
    'super_total_ports', 'busy_ports', 'port_semantics',
    'captured_at', 'raw_data', 'provider_name', 'missing_fields',
    'quality_status', 'created_at',
]);

const FUEL_SNAPSHOT_COLUMNS = Object.freeze([
    'source_record_id', 'ingest_batch_id', 'record_index', 'source_node',
    'source_agent', 'source_type', 'source_stage', 'platform', 'city',
    'station_id', 'station_name', 'address', 'latitude', 'longitude',
    'provider_name', 'captured_at', 'raw_data', 'missing_fields',
    'quality_status', 'created_at',
]);

const SOURCE_CURSOR_COLUMNS = Object.freeze([
    'global_seq', 'source_record_id', 'station_type', 'ingest_batch_id', 'created_at',
]);

// v5 子表 FK：fuel_offers/fuel_quotes 改指向 fuel_snapshots（原指向 station_snapshots）。
const FUEL_FOREIGN_KEYS = Object.freeze([
    {
        table: 'mobile_ocr_fuel_offers',
        name: 'fk_mobile_ocr_fuel_offer_snapshot',
        column: 'source_record_id',
        referencedTable: 'mobile_ocr_fuel_snapshots',
        referencedColumn: 'source_record_id',
        onDelete: 'CASCADE',
        onUpdate: 'RESTRICT',
    },
    {
        table: 'mobile_ocr_fuel_quotes',
        name: 'fk_mobile_ocr_fuel_quote_snapshot',
        column: 'source_record_id',
        referencedTable: 'mobile_ocr_fuel_snapshots',
        referencedColumn: 'source_record_id',
        onDelete: 'CASCADE',
        onUpdate: 'RESTRICT',
    },
]);

const CREATE_CHARGING_SNAPSHOTS_TABLE = `
    CREATE TABLE IF NOT EXISTS mobile_ocr_charging_snapshots (
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
        available_ports INT UNSIGNED NULL,
        total_ports INT UNSIGNED NULL,
        fast_idle_ports INT UNSIGNED NULL,
        fast_total_ports INT UNSIGNED NULL,
        slow_idle_ports INT UNSIGNED NULL,
        slow_total_ports INT UNSIGNED NULL,
        super_idle_ports INT UNSIGNED NULL,
        super_total_ports INT UNSIGNED NULL,
        busy_ports INT UNSIGNED NULL,
        port_semantics VARCHAR(32) NULL,
        captured_at DATETIME(3) NOT NULL,
        raw_data JSON NULL,
        provider_name VARCHAR(128) NULL,
        missing_fields JSON NULL,
        quality_status VARCHAR(32) NULL,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (source_record_id),
        UNIQUE KEY uk_charging_batch_record (ingest_batch_id, record_index),
        KEY idx_charging_city_cursor (city, source_record_id),
        KEY idx_charging_platform_cursor (platform, source_record_id),
        KEY idx_charging_agent_cursor (source_agent, source_record_id),
        CONSTRAINT fk_charging_snapshot_batch
            FOREIGN KEY (ingest_batch_id) REFERENCES mobile_ocr_ingest_batches(id)
            ON DELETE RESTRICT ON UPDATE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;

const CREATE_FUEL_SNAPSHOTS_TABLE = `
    CREATE TABLE IF NOT EXISTS mobile_ocr_fuel_snapshots (
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
        provider_name VARCHAR(128) NULL,
        captured_at DATETIME(3) NOT NULL,
        raw_data JSON NULL,
        missing_fields JSON NULL,
        quality_status VARCHAR(32) NULL,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (source_record_id),
        UNIQUE KEY uk_fuel_batch_record (ingest_batch_id, record_index),
        KEY idx_fuel_city_cursor (city, source_record_id),
        KEY idx_fuel_platform_cursor (platform, source_record_id),
        KEY idx_fuel_agent_cursor (source_agent, source_record_id),
        CONSTRAINT fk_fuel_snapshot_batch
            FOREIGN KEY (ingest_batch_id) REFERENCES mobile_ocr_ingest_batches(id)
            ON DELETE RESTRICT ON UPDATE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;

// 全局游标表：统一两表自增 ID 序列，供增量拉取使用。
// station_type: 'charging' | 'fuel'，指向对应拆分表的主键。
const CREATE_SOURCE_CURSOR_TABLE = `
    CREATE TABLE IF NOT EXISTS mobile_ocr_source_record_cursor (
        global_seq BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        source_record_id BIGINT UNSIGNED NOT NULL,
        station_type VARCHAR(16) NOT NULL,
        ingest_batch_id BIGINT UNSIGNED NOT NULL,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (global_seq),
        KEY idx_cursor_type_seq (station_type, global_seq),
        KEY idx_cursor_record (source_record_id, station_type)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;

const MIGRATION_PLAN = Object.freeze([
    'acquire-migration-lock',
    'ensure-migration-metadata',
    'ensure-v5-charging-snapshots-table',
    'ensure-v5-fuel-snapshots-table',
    'ensure-v5-source-cursor-table',
    'verify-v5-physical-schema',
    'record-schema-version-5',
]);

// migrations 元数据表由 v4 迁移器创建；这里仅作为幂等兜底，结构必须与 v4 一致。
const CREATE_MIGRATIONS_METADATA_IF_MISSING = `
    CREATE TABLE IF NOT EXISTS mobile_ocr_schema_migrations (
        component VARCHAR(64) NOT NULL,
        version INT UNSIGNED NOT NULL,
        checksum CHAR(64) NOT NULL,
        applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (component)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;

function migrationError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function schemaChecksum() {
    const manifest = JSON.stringify({
        target: TARGET_SCHEMA_VERSION,
        migrationName: MIGRATION_NAME,
        tables: TABLES,
        chargingSnapshotColumns: CHARGING_SNAPSHOT_COLUMNS,
        fuelSnapshotColumns: FUEL_SNAPSHOT_COLUMNS,
        sourceCursorColumns: SOURCE_CURSOR_COLUMNS,
    });
    return crypto.createHash('sha256').update(manifest).digest('hex');
}

class MobileSourceSplitMigrator {
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
            await this.ensureTable(TABLES.migrations, CREATE_MIGRATIONS_METADATA_IF_MISSING);
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
            if (existingVersion !== null && existingVersion > TARGET_SCHEMA_VERSION) {
                throw migrationError(
                    'mobile_source_split_future_version',
                    'mobile source split schema is newer than this migration runner'
                );
            }
            // v5 依赖 v4 物理表（batches/snapshots/fuel_offers/fuel_quotes），必须先跑 v4。
            const v4Version = await this.v4ComponentVersion();
            if (v4Version === null || v4Version < 4) {
                throw migrationError(
                    'mobile_source_split_requires_v4',
                    'v5 split migration requires physical schema v4; run the v4 migration first'
                );
            }

            await this.ensureTable(TABLES.chargingSnapshots, CREATE_CHARGING_SNAPSHOTS_TABLE);
            await this.assertColumns(
                TABLES.chargingSnapshots,
                CHARGING_SNAPSHOT_COLUMNS,
                'v5 charging snapshot'
            );

            await this.ensureTable(TABLES.fuelSnapshots, CREATE_FUEL_SNAPSHOTS_TABLE);
            await this.assertColumns(
                TABLES.fuelSnapshots,
                FUEL_SNAPSHOT_COLUMNS,
                'v5 fuel snapshot'
            );

            // 子表 fuel_offers/fuel_quotes 的 FK 从旧 station_snapshots 改指向 fuel_snapshots。
            await this.rebuildFuelForeignKeys();

            await this.ensureTable(TABLES.sourceCursor, CREATE_SOURCE_CURSOR_TABLE);
            await this.assertColumns(
                TABLES.sourceCursor,
                SOURCE_CURSOR_COLUMNS,
                'v5 source cursor'
            );

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
                'mobile_source_split_version_invalid',
                'mobile source split schema target version is not recorded'
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
        for (const table of [
            TABLES.chargingSnapshots,
            TABLES.fuelSnapshots,
            TABLES.sourceCursor,
        ]) {
            if (!await this.tableExists(table)) {
                throw migrationError(
                    'mobile_source_split_table_missing',
                    `required v5 split table is missing: ${table}`
                );
            }
        }
        await this.assertColumns(
            TABLES.chargingSnapshots,
            CHARGING_SNAPSHOT_COLUMNS,
            'v5 charging snapshot'
        );
        await this.assertColumns(
            TABLES.fuelSnapshots,
            FUEL_SNAPSHOT_COLUMNS,
            'v5 fuel snapshot'
        );
        await this.assertColumns(
            TABLES.sourceCursor,
            SOURCE_CURSOR_COLUMNS,
            'v5 source cursor'
        );
        // 校验子表 FK 已指向 fuel_snapshots（而非旧 station_snapshots）。
        for (const foreignKey of FUEL_FOREIGN_KEYS) {
            const referenced = await this.foreignKeyReferencedTable(
                foreignKey.table, foreignKey.name
            );
            if (referenced !== foreignKey.referencedTable) {
                throw migrationError(
                    'mobile_source_split_fuel_foreign_key_invalid',
                    `${foreignKey.name} must reference ${foreignKey.referencedTable}`
                );
            }
        }
        return true;
    }

    // 重建子表 FK：从旧 station_snapshots 改指向 fuel_snapshots。
    // 全清重建场景下旧表无数据，DROP/ADD FK 无冲突；若 FK 已指向 fuel_snapshots 则跳过。
    async rebuildFuelForeignKeys() {
        for (const foreignKey of FUEL_FOREIGN_KEYS) {
            const referenced = await this.foreignKeyReferencedTable(foreignKey.table, foreignKey.name);
            if (referenced === foreignKey.referencedTable) continue;
            if (referenced !== null) {
                await this.executeDdl(
                    `ALTER TABLE \`${foreignKey.table}\` DROP FOREIGN KEY \`${foreignKey.name}\``,
                    `drop-foreign-key:${foreignKey.name}`
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
        }
    }

    async foreignKeyReferencedTable(table, name) {
        const [rows] = await this.connection.execute(`
            SELECT kcu.referenced_table_name AS referenced_table_name
            FROM information_schema.key_column_usage kcu
            INNER JOIN information_schema.referential_constraints rc
                ON rc.constraint_schema = kcu.constraint_schema
               AND rc.table_name = kcu.table_name
               AND rc.constraint_name = kcu.constraint_name
            WHERE kcu.table_schema = DATABASE()
              AND kcu.table_name = ?
              AND kcu.constraint_name = ?
              AND kcu.referenced_table_name IS NOT NULL
            LIMIT 1
        `, [table, name]);
        return rows.length === 1 ? String(rows[0].referenced_table_name) : null;
    }

    async acquireLock() {
        const [rows] = await this.connection.execute(
            'SELECT GET_LOCK(?, ?) AS acquired',
            [LOCK_NAME, this.lockTimeoutSeconds]
        );
        if (Number(rows?.[0]?.acquired) !== 1) {
            throw migrationError(
                'mobile_source_split_lock_unavailable',
                'mobile source v5 split migration lock is unavailable'
            );
        }
    }

    async releaseLock() {
        try {
            await this.connection.execute('SELECT RELEASE_LOCK(?) AS released', [LOCK_NAME]);
        } catch {
            // The migration result must win; MySQL also releases the lock on disconnect.
        }
    }

    async ensureTable(table, createSql) {
        if (await this.tableExists(table)) return;
        await this.executeDdl(createSql, `create-table:${table}`);
        if (!await this.tableExists(table)) {
            throw migrationError(
                'mobile_source_split_table_create_failed',
                `v5 split table was not created: ${table}`
            );
        }
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
                'mobile_source_split_columns_missing',
                `${label} schema is incomplete; missing columns: ${missing.join(',')}`
            );
        }
    }

    async executeDdl(sql, step) {
        if (/delimiter|create\s+procedure|call\s+/i.test(sql)) {
            throw migrationError(
                'mobile_source_split_unsupported_statement',
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
                'mobile_source_split_version_write_declined',
                'mobile source split schema version was not advanced'
            );
        }
        this.appliedSteps.push('record-version:5');
    }

    // 查 v4 物理迁移（component='mobile-ocr-source'）的版本，用于 v5 前置依赖检查。
    async v4ComponentVersion() {
        if (!await this.tableExists(TABLES.migrations)) return null;
        const [rows] = await this.connection.execute(`
            SELECT version
            FROM mobile_ocr_schema_migrations
            WHERE component = 'mobile-ocr-source'
            LIMIT 1
        `);
        if (rows.length === 0) return null;
        const version = Number(rows[0].version);
        return Number.isInteger(version) && version >= 0 ? version : null;
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
                'mobile_source_split_version_invalid',
                'mobile source schema version metadata is invalid'
            );
        }
        if (version > TARGET_SCHEMA_VERSION) {
            throw migrationError(
                'mobile_source_split_future_version',
                'mobile source schema is newer than this split migration runner'
            );
        }
        if (version === TARGET_SCHEMA_VERSION
                && String(rows[0].checksum) !== schemaChecksum()) {
            throw migrationError(
                'mobile_source_split_checksum_invalid',
                'mobile source split schema checksum does not match the target manifest'
            );
        }
        return version;
    }
}

module.exports = {
    COMPONENT,
    LOCK_NAME,
    MIGRATION_NAME,
    MIGRATION_PLAN,
    MobileSourceSplitMigrator,
    TABLES,
    TARGET_SCHEMA_VERSION,
    CHARGING_SNAPSHOT_COLUMNS,
    FUEL_SNAPSHOT_COLUMNS,
    SOURCE_CURSOR_COLUMNS,
    schemaChecksum,
};
