'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createMobileSourceNodeApp } = require('../mobile-source-node');
const {
    FOREIGN_KEYS,
    INDEXES,
    MIGRATION_NAME,
    MobileSourceMysqlMigrator,
    TABLES,
    V1_BATCH_COLUMNS,
    V1_SNAPSHOT_COLUMNS,
    V2_FUEL_COLUMNS,
    V3_FUEL_COLUMNS,
    V3_FUEL_QUOTE_COLUMNS,
    V4_SNAPSHOT_COLUMNS,
    schemaChecksum,
} = require('../services/mobile-source-mysql-migrator');
const { MobileSourceNodeService } = require('../services/mobile-source-node-service');
const { MysqlMobileSourceStore } = require('../services/mysql-mobile-source-store');
const { MobileSourceSplitMigrator, TABLES: SPLIT_TABLES,
    CHARGING_SNAPSHOT_COLUMNS, FUEL_SNAPSHOT_COLUMNS, SOURCE_CURSOR_COLUMNS }
    = require('../services/mobile-source-split-migrator');
const {
    buildMigrationConnectionConfig,
    runCli,
} = require('../scripts/migrate-mobile-source-mysql');
const {
    runCli: runDeploymentEnvironmentCli,
    validateDeploymentEnvironment,
} = require('../scripts/validate-mobile-source-deployment-env');

function column(dataType = 'varchar', options = {}) {
    return {
        column_name: options.name,
        data_type: dataType,
        character_maximum_length: options.maxLength ?? null,
        numeric_precision: options.numericPrecision ?? null,
        numeric_scale: options.numericScale ?? null,
        is_nullable: options.nullable === false ? 'NO' : 'YES',
        column_default: options.defaultValue ?? null,
    };
}

class FakeMysqlConnection {
    constructor({
        uppercaseInformationSchema = false,
        reportRestrictAsNoAction = false,
    } = {}) {
        this.tables = new Map();
        this.versionRow = null;
        this.versionRows = new Map();
        this.ddlStatements = [];
        this.failPattern = null;
        this.ended = false;
        this.uppercaseInformationSchema = uppercaseInformationSchema;
        this.reportRestrictAsNoAction = reportRestrictAsNoAction;
    }

    informationSchemaRow(sql, row) {
        if (!this.uppercaseInformationSchema || !row) return row;
        return Object.fromEntries(Object.entries(row).map(([key, value]) => {
            const hasLowercaseAlias = new RegExp(`\\bAS\\s+${key}\\b`, 'i').test(sql);
            return [hasLowercaseAlias ? key : key.toUpperCase(), value];
        }));
    }

    reportedReferentialAction(action) {
        if (this.reportRestrictAsNoAction && action === 'RESTRICT') return 'NO ACTION';
        return action;
    }

    seedV1() {
        this.createTableState(TABLES.batches, V1_BATCH_COLUMNS);
        this.createTableState(TABLES.snapshots, V1_SNAPSHOT_COLUMNS);
        for (const index of INDEXES.filter(item =>
            [TABLES.batches, TABLES.snapshots].includes(item.table)
            && !item.name.includes('observation_type')
            && !item.name.includes('station_type')
        )) {
            this.addIndex(index);
        }
        this.addForeignKey({
            table: TABLES.snapshots,
            name: 'fk_mobile_ocr_snapshot_batch',
            column: 'ingest_batch_id',
            referencedTable: TABLES.batches,
            referencedColumn: 'id',
            onDelete: 'RESTRICT',
            onUpdate: 'RESTRICT',
        });
    }

    seedV2() {
        this.seedV1();
        this.addMigrationColumn(TABLES.batches, 'schema_version');
        this.addMigrationColumn(TABLES.batches, 'observation_type');
        this.addMigrationColumn(TABLES.snapshots, 'station_type');
        for (const index of INDEXES.filter(item =>
            [TABLES.batches, TABLES.snapshots].includes(item.table)
        )) {
            if (!this.tables.get(index.table).indexes.has(index.name)) this.addIndex(index);
        }
        this.createTableState(TABLES.fuelOffers, V2_FUEL_COLUMNS);
        for (const index of INDEXES.filter(item => item.table === TABLES.fuelOffers)) {
            this.addIndex(index);
        }
        this.addForeignKey(FOREIGN_KEYS.find(item => item.table === TABLES.fuelOffers));
        this.seedMetadata(2, 'legacy-v2-checksum');
    }

    seedMetadata(version, checksum) {
        this.createTableState(TABLES.migrations, [
            'component', 'version', 'checksum', 'applied_at',
        ]);
        this.versionRow = { component: 'mobile-ocr-source', version, checksum };
        this.versionRows.set('mobile-ocr-source', { ...this.versionRow });
    }

    createTableState(name, columns) {
        const table = { columns: new Map(), indexes: new Map(), foreignKeys: new Map() };
        for (const nameValue of columns) {
            table.columns.set(nameValue, column('varchar', { name: nameValue }));
        }
        this.tables.set(name, table);
        return table;
    }

    addIndex(index) {
        this.tables.get(index.table).indexes.set(index.name, {
            columns: [...index.columns],
            unique: Boolean(index.unique),
        });
    }

    addForeignKey(foreignKey) {
        this.tables.get(foreignKey.table).foreignKeys.set(foreignKey.name, {
            column: foreignKey.column,
            referencedTable: foreignKey.referencedTable,
            referencedColumn: foreignKey.referencedColumn,
            onDelete: foreignKey.onDelete || 'RESTRICT',
            onUpdate: foreignKey.onUpdate || 'RESTRICT',
        });
    }

    addMigrationColumn(tableName, columnName) {
        const shapes = {
            schema_version: column('int', {
                name: columnName,
                nullable: false,
                defaultValue: '1',
            }),
            observation_type: column('varchar', {
                name: columnName,
                maxLength: 16,
                nullable: false,
                defaultValue: 'charging',
            }),
            station_type: column('varchar', {
                name: columnName,
                maxLength: 16,
                nullable: false,
                defaultValue: 'charging',
            }),
            provider_name: column('varchar', {
                name: columnName,
                maxLength: 128,
            }),
            display_price: column('decimal', {
                name: columnName,
                numericPrecision: 10,
                numericScale: 4,
            }),
            station_price: column('decimal', {
                name: columnName,
                numericPrecision: 10,
                numericScale: 4,
            }),
            national_price: column('decimal', {
                name: columnName,
                numericPrecision: 10,
                numericScale: 4,
            }),
            busy_ports: column('int', { name: columnName }),
            port_semantics: column('varchar', {
                name: columnName,
                maxLength: 32,
            }),
            missing_fields: column('json', { name: columnName }),
            quality_status: column('varchar', {
                name: columnName,
                maxLength: 32,
            }),
        };
        this.tables.get(tableName).columns.set(columnName, shapes[columnName]);
    }

    applyFuelQuoteColumnShapes(table) {
        const varcharShapes = {
            quote_observation_id: 128,
            quote_dedup_key: 64,
        };
        for (const [name, maxLength] of Object.entries(varcharShapes)) {
            table.columns.set(name, column(
                name === 'quote_dedup_key' ? 'char' : 'varchar',
                { name, maxLength, nullable: false }
            ));
        }
        for (const name of [
            'selected_amount', 'gross_discount', 'service_fee',
            'net_discount', 'payable_amount',
        ]) {
            table.columns.set(name, column('decimal', {
                name,
                numericPrecision: 12,
                numericScale: 2,
                nullable: name !== 'selected_amount',
            }));
        }
        table.columns.set('needs_review', column('tinyint', {
            name: 'needs_review',
            numericPrecision: 3,
            numericScale: 0,
            nullable: false,
            defaultValue: '0',
        }));
    }

    async execute(sql, values = []) {
        const normalized = String(sql).replace(/\s+/g, ' ').trim();
        if (normalized.includes('GET_LOCK')) return [[{ acquired: 1 }]];
        if (normalized.includes('RELEASE_LOCK')) return [[{ released: 1 }]];
        if (normalized.includes('information_schema.tables')) {
            const row = this.tables.has(values[0]) ? { table_name: values[0] } : undefined;
            return [[this.informationSchemaRow(normalized, row)].filter(Boolean)];
        }
        if (normalized.includes('information_schema.columns')) {
            const table = this.tables.get(values[0]);
            const rows = table ? [...table.columns.values()] : [];
            if (normalized.includes('column_name = ?')) {
                const row = rows.find(item => item.column_name === values[1]);
                return [[this.informationSchemaRow(normalized, row)].filter(Boolean)];
            }
            return [rows.map(item => this.informationSchemaRow(normalized, {
                column_name: item.column_name,
            }))];
        }
        if (normalized.includes('information_schema.statistics')) {
            const index = this.tables.get(values[0])?.indexes.get(values[1]);
            if (!index) return [[]];
            if (normalized.includes('LIMIT 1')) {
                return [[this.informationSchemaRow(normalized, { index_name: values[1] })]];
            }
            return [index.columns.map((columnName, position) => this.informationSchemaRow(normalized, {
                column_name: columnName,
                non_unique: index.unique ? 0 : 1,
                seq_in_index: position + 1,
            }))];
        }
        if (normalized.includes('information_schema.table_constraints')) {
            const foreignKey = this.tables.get(values[0])?.foreignKeys.get(values[1]);
            const row = foreignKey ? { constraint_name: values[1] } : undefined;
            return [[this.informationSchemaRow(normalized, row)].filter(Boolean)];
        }
        if (normalized.includes('information_schema.key_column_usage')) {
            const foreignKey = this.tables.get(values[0])?.foreignKeys.get(values[1]);
            const row = foreignKey ? {
                column_name: foreignKey.column,
                referenced_table_name: foreignKey.referencedTable,
                referenced_column_name: foreignKey.referencedColumn,
                delete_rule: this.reportedReferentialAction(foreignKey.onDelete),
                update_rule: this.reportedReferentialAction(foreignKey.onUpdate),
            } : undefined;
            return [[this.informationSchemaRow(normalized, row)].filter(Boolean)];
        }
        if (/^INSERT INTO mobile_ocr_schema_migrations/i.test(normalized)) {
            this.versionRow = { component: values[0], version: values[1], checksum: values[2] };
            this.versionRows.set(values[0], { ...this.versionRow });
            return [{ affectedRows: 1 }];
        }
        if (/^SELECT version, checksum FROM mobile_ocr_schema_migrations/i.test(normalized)) {
            // 按 component 区分（v4='mobile-ocr-source', v5='mobile-ocr-source-split'）。
            const row = values[0] ? this.versionRows.get(values[0]) : this.versionRow;
            return [[row ? {
                version: row.version,
                checksum: row.checksum,
            } : undefined].filter(Boolean)];
        }
        // v5 v4ComponentVersion：查 v4 component 版本（字面量 component，带 LIMIT 1）。
        if (/^SELECT version FROM mobile_ocr_schema_migrations WHERE component = '(mobile-ocr-source(?:-split)?)' LIMIT 1$/i.test(normalized)) {
            const match = normalized.match(/WHERE component = '(mobile-ocr-source(?:-split)?)'/i);
            const row = match ? this.versionRows.get(match[1]) : null;
            return [[row ? { version: row.version } : undefined].filter(Boolean)];
        }
        throw new Error(`fake execute does not support statement: ${normalized.slice(0, 80)}`);
    }

    async query(sql) {
        const normalized = String(sql).replace(/\s+/g, ' ').trim();
        if (normalized === 'SELECT 1 AS mobile_source_database_ready') return [[{ mobile_source_database_ready: 1 }]];
        if (/^SELECT /i.test(normalized)) {
            const match = normalized.match(/SELECT (.+) FROM (mobile_ocr_[a-z_]+) LIMIT 0/i);
            if (!match) throw new Error('unsupported fake health query');
            const table = this.tables.get(match[2]);
            if (!table) throw new Error('table missing');
            const selected = match[1].split(',').map(value => value.trim());
            if (selected.some(name => !table.columns.has(name))) throw new Error('column missing');
            return [[]];
        }
        if (this.failPattern && this.failPattern.test(normalized)) {
            const error = new Error('DDL permission denied');
            error.code = 'ER_TABLEACCESS_DENIED_ERROR';
            throw error;
        }
        if (/delimiter|create procedure|call /i.test(normalized)) {
            throw new Error('client command must never reach mysql2');
        }
        this.ddlStatements.push(normalized);
        const create = normalized.match(/^CREATE TABLE IF NOT EXISTS (?:`)?(mobile_ocr_[a-z_]+)(?:`)?/i);
        if (create) {
            const tableName = create[1];
            if (this.tables.has(tableName)) return [{ affectedRows: 0 }];
            if (tableName === TABLES.migrations) {
                this.createTableState(tableName, ['component', 'version', 'checksum', 'applied_at']);
            } else if (tableName === TABLES.batches) {
                this.createTableState(tableName, V1_BATCH_COLUMNS);
                for (const index of INDEXES.filter(item =>
                    item.table === tableName && !item.name.includes('observation_type')
                )) this.addIndex(index);
            } else if (tableName === TABLES.snapshots) {
                this.createTableState(tableName, V1_SNAPSHOT_COLUMNS);
                for (const index of INDEXES.filter(item =>
                    item.table === tableName && !item.name.includes('station_type')
                )) this.addIndex(index);
                this.addForeignKey({
                    table: TABLES.snapshots,
                    name: 'fk_mobile_ocr_snapshot_batch',
                    column: 'ingest_batch_id',
                    referencedTable: TABLES.batches,
                    referencedColumn: 'id',
                    onDelete: 'RESTRICT',
                    onUpdate: 'RESTRICT',
                });
            } else if (tableName === TABLES.fuelOffers) {
                this.createTableState(tableName, V2_FUEL_COLUMNS);
                for (const index of INDEXES.filter(item => item.table === tableName)) {
                    this.addIndex(index);
                }
                this.addForeignKey({
                    table: TABLES.fuelOffers,
                    name: 'fk_mobile_ocr_fuel_offer_snapshot',
                    column: 'source_record_id',
                    referencedTable: TABLES.snapshots,
                    referencedColumn: 'source_record_id',
                    onDelete: 'CASCADE',
                    onUpdate: 'RESTRICT',
                });
            } else if (tableName === TABLES.fuelQuotes) {
                const table = this.createTableState(tableName, V3_FUEL_QUOTE_COLUMNS);
                this.applyFuelQuoteColumnShapes(table);
                for (const index of INDEXES.filter(item => item.table === tableName)) {
                    this.addIndex(index);
                }
                this.addForeignKey({
                    table: TABLES.fuelQuotes,
                    name: 'fk_mobile_ocr_fuel_quote_snapshot',
                    column: 'source_record_id',
                    referencedTable: TABLES.snapshots,
                    referencedColumn: 'source_record_id',
                    onDelete: 'CASCADE',
                    onUpdate: 'RESTRICT',
                });
            } else if (tableName === SPLIT_TABLES.chargingSnapshots) {
                this.createTableState(tableName, CHARGING_SNAPSHOT_COLUMNS);
            } else if (tableName === SPLIT_TABLES.fuelSnapshots) {
                this.createTableState(tableName, FUEL_SNAPSHOT_COLUMNS);
            } else if (tableName === SPLIT_TABLES.sourceCursor) {
                this.createTableState(tableName, SOURCE_CURSOR_COLUMNS);
            }
            return [{ affectedRows: 1 }];
        }
        const addColumn = normalized.match(
            /^ALTER TABLE `([^`]+)` ADD COLUMN `([^`]+)` (.+)$/i
        );
        if (addColumn) {
            this.addMigrationColumn(addColumn[1], addColumn[2]);
            return [{ affectedRows: 1 }];
        }
        const createIndex = normalized.match(
            /^CREATE (UNIQUE )?INDEX `([^`]+)` ON `([^`]+)` \((.+)\)$/i
        );
        if (createIndex) {
            this.addIndex({
                unique: Boolean(createIndex[1]),
                name: createIndex[2],
                table: createIndex[3],
                columns: createIndex[4].split(',').map(value => value.replace(/`/g, '').trim()),
            });
            return [{ affectedRows: 1 }];
        }
        const addForeignKey = normalized.match(
            /^ALTER TABLE `([^`]+)` ADD CONSTRAINT `([^`]+)` FOREIGN KEY \(`([^`]+)`\) REFERENCES `([^`]+)` \(`([^`]+)`\) ON DELETE (CASCADE|RESTRICT) ON UPDATE (CASCADE|RESTRICT)/i
        );
        if (addForeignKey) {
            this.addForeignKey({
                table: addForeignKey[1],
                name: addForeignKey[2],
                column: addForeignKey[3],
                referencedTable: addForeignKey[4],
                referencedColumn: addForeignKey[5],
                onDelete: addForeignKey[6].toUpperCase(),
                onUpdate: addForeignKey[7].toUpperCase(),
            });
            return [{ affectedRows: 1 }];
        }
        const dropForeignKey = normalized.match(
            /^ALTER TABLE `([^`]+)` DROP FOREIGN KEY `([^`]+)`/i
        );
        if (dropForeignKey) {
            this.tables.get(dropForeignKey[1])?.foreignKeys.delete(dropForeignKey[2]);
            return [{ affectedRows: 1 }];
        }
        throw new Error(`fake query does not support statement: ${normalized.slice(0, 80)}`);
    }

    async end() {
        this.ended = true;
    }
}

async function healthStatus(store) {
    const service = new MobileSourceNodeService({ store });
    const app = createMobileSourceNodeApp({
        service,
        requireAuth: false,
    });
    const server = await new Promise(resolve => {
        const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    try {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/health`);
        return response.status;
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
}

test('fresh schema migrates to physical v4 then v5 split, health changes from 503 to 200', async () => {
    const connection = new FakeMysqlConnection();
    const store = new MysqlMobileSourceStore({
        pool: {
            query: (...args) => connection.query(...args),
            execute: (...args) => connection.execute(...args),
        },
    });
    assert.equal(await healthStatus(store), 503);
    const result = await new MobileSourceMysqlMigrator({ connection }).migrate();
    assert.equal(result.schemaVersion, 4);
    assert.equal(result.migrationName, 'mobile_station_observation_physical_v4');
    assert.equal(result.migrationName, MIGRATION_NAME);
    // v4 迁移只建旧表，store.health 现在由 v5 校验器校验新拆分表，仍为 503。
    assert.equal(await healthStatus(store), 503);
    const splitResult = await new MobileSourceSplitMigrator({ connection }).migrate();
    assert.equal(splitResult.schemaVersion, 5);
    assert.equal(await healthStatus(store), 200);
});

test('mysql 8 uppercase information_schema metadata is normalized by lowercase aliases', async () => {
    const connection = new FakeMysqlConnection({ uppercaseInformationSchema: true });
    const migrator = new MobileSourceMysqlMigrator({ connection });
    const result = await migrator.migrate();
    assert.equal(result.schemaVersion, 4);
    const validation = await migrator.validate();
    assert.equal(validation.schemaVersion, 4);
});

test('fresh schema accepts MySQL NO ACTION as explicit RESTRICT semantics', async () => {
    const connection = new FakeMysqlConnection({ reportRestrictAsNoAction: true });
    const migrator = new MobileSourceMysqlMigrator({ connection });
    const result = await migrator.migrate();
    assert.equal(result.schemaVersion, 4);
    const fuelTableDdl = connection.ddlStatements.find(statement =>
        statement.startsWith(`CREATE TABLE IF NOT EXISTS ${TABLES.fuelOffers}`)
    );
    assert.match(fuelTableDdl, /ON DELETE CASCADE ON UPDATE RESTRICT/);
    assert.equal((await migrator.validate()).valid, true);
});

test('all consumed information_schema fields have explicit lowercase aliases', () => {
    const source = fs.readFileSync(
        path.join(__dirname, '../services/mobile-source-mysql-migrator.js'),
        'utf8'
    );
    const aliases = [
        'table_name',
        'column_name',
        'data_type',
        'character_maximum_length',
        'numeric_precision',
        'numeric_scale',
        'is_nullable',
        'column_default',
        'index_name',
        'non_unique',
        'seq_in_index',
        'constraint_name',
        'referenced_table_name',
        'referenced_column_name',
        'delete_rule',
        'update_rule',
    ];
    for (const alias of aliases) {
        assert.match(
            source,
            new RegExp(`\\b(?:[a-z]+\\.)?${alias}\\s+AS\\s+${alias}\\b`, 'i'),
            `missing explicit lowercase alias for ${alias}`
        );
    }
});

test('existing v1 schema upgrades to v4 without rebuilding v1 tables', async () => {
    const connection = new FakeMysqlConnection();
    connection.seedV1();
    const result = await new MobileSourceMysqlMigrator({ connection }).migrate();
    assert.equal(result.schemaVersion, 4);
    assert.equal(connection.tables.get(TABLES.batches).columns.has('schema_version'), true);
    assert.equal(connection.tables.get(TABLES.batches).columns.has('observation_type'), true);
    assert.equal(connection.tables.get(TABLES.snapshots).columns.has('station_type'), true);
    assert.equal(connection.tables.get(TABLES.snapshots).columns.has('provider_name'), true);
    assert.deepEqual(
        V4_SNAPSHOT_COLUMNS.filter(name =>
            !connection.tables.get(TABLES.snapshots).columns.has(name)
        ),
        []
    );
    assert.equal(connection.tables.has(TABLES.fuelOffers), true);
    assert.deepEqual(
        V3_FUEL_COLUMNS.filter(name =>
            !connection.tables.get(TABLES.fuelOffers).columns.has(name)
        ),
        []
    );
    assert.equal(connection.tables.has(TABLES.fuelQuotes), true);
    assert.equal(
        connection.tables.get(TABLES.fuelOffers).foreignKeys.has('fk_mobile_ocr_fuel_offer_snapshot'),
        true
    );
});

test('existing physical v2 schema upgrades incrementally to v4', async () => {
    const connection = new FakeMysqlConnection();
    connection.seedV2();
    const result = await new MobileSourceMysqlMigrator({ connection }).migrate();
    assert.equal(result.schemaVersion, 4);
    assert.equal(connection.tables.get(TABLES.snapshots).columns.has('provider_name'), true);
    assert.equal(connection.tables.get(TABLES.fuelOffers).columns.has('display_price'), true);
    assert.equal(connection.tables.get(TABLES.fuelOffers).columns.has('station_price'), true);
    assert.equal(connection.tables.get(TABLES.fuelOffers).columns.has('national_price'), true);
    assert.equal(connection.tables.has(TABLES.fuelQuotes), true);
    assert.equal(
        connection.ddlStatements.some(statement =>
            statement.startsWith(`CREATE TABLE IF NOT EXISTS ${TABLES.batches}`)
        ),
        false
    );
});

test('v4 migration is repeatable and emits no additional DDL', async () => {
    const connection = new FakeMysqlConnection();
    await new MobileSourceMysqlMigrator({ connection }).migrate();
    const ddlCount = connection.ddlStatements.length;
    await new MobileSourceMysqlMigrator({ connection }).migrate();
    assert.equal(connection.ddlStatements.length, ddlCount);
});

test('migration rejects future metadata without downgrading it', async () => {
    const connection = new FakeMysqlConnection();
    connection.seedMetadata(5, 'future-schema-checksum');
    await assert.rejects(
        () => new MobileSourceMysqlMigrator({ connection }).migrate(),
        error => error.code === 'mobile_source_schema_future_version'
    );
    assert.equal(connection.versionRow.version, 5);
    assert.equal(connection.versionRow.checksum, 'future-schema-checksum');
    assert.equal(connection.ddlStatements.length, 0);
});

test('migration rejects target-version checksum drift without overwriting metadata', async () => {
    const connection = new FakeMysqlConnection();
    connection.seedMetadata(4, 'drifted-v4-checksum');
    await assert.rejects(
        () => new MobileSourceMysqlMigrator({ connection }).migrate(),
        error => error.code === 'mobile_source_schema_checksum_invalid'
    );
    assert.equal(connection.versionRow.version, 4);
    assert.equal(connection.versionRow.checksum, 'drifted-v4-checksum');
    assert.equal(connection.ddlStatements.length, 0);
});

test('migration rejects target-version physical drift without rewriting metadata', async () => {
    const connection = new FakeMysqlConnection();
    connection.seedMetadata(4, schemaChecksum());
    await assert.rejects(
        () => new MobileSourceMysqlMigrator({ connection }).migrate(),
        error => error.code === 'mobile_source_schema_table_missing'
    );
    assert.equal(connection.versionRow.version, 4);
    assert.equal(connection.versionRow.checksum, schemaChecksum());
    assert.equal(connection.ddlStatements.length, 0);
});

test('partial v4 failure records no target version and recovers on the next run', async () => {
    const connection = new FakeMysqlConnection();
    connection.seedV1();
    connection.addMigrationColumn(TABLES.batches, 'schema_version');
    connection.failPattern = /mobile_ocr_fuel_quotes/;
    await assert.rejects(
        () => new MobileSourceMysqlMigrator({ connection }).migrate(),
        error => error.code === 'ER_TABLEACCESS_DENIED_ERROR'
    );
    assert.equal(connection.versionRow, null);
    assert.equal(connection.tables.get(TABLES.batches).columns.has('observation_type'), true);
    connection.failPattern = null;
    const recovered = await new MobileSourceMysqlMigrator({ connection }).migrate();
    assert.equal(recovered.schemaVersion, 4);
});

test('v3 quote foreign key accepts MySQL NO ACTION as RESTRICT during recovery', async () => {
    const connection = new FakeMysqlConnection();
    await new MobileSourceMysqlMigrator({ connection }).migrate();
    connection.versionRow = null;
    const foreignKey = connection.tables.get(TABLES.fuelQuotes)
        .foreignKeys.get('fk_mobile_ocr_fuel_quote_snapshot');
    foreignKey.onUpdate = 'NO ACTION';
    const ddlCount = connection.ddlStatements.length;
    const migrator = new MobileSourceMysqlMigrator({ connection });
    const recovered = await migrator.migrate();
    assert.equal(recovered.schemaVersion, 4);
    assert.equal(connection.ddlStatements.length, ddlCount);
    assert.equal((await migrator.validate()).valid, true);
});

test('DDL permission failure is nonzero and never records target version', async () => {
    const connection = new FakeMysqlConnection();
    connection.failPattern = /^CREATE TABLE/;
    await assert.rejects(
        () => new MobileSourceMysqlMigrator({ connection }).migrate(),
        error => error.code === 'ER_TABLEACCESS_DENIED_ERROR'
    );
    assert.equal(connection.versionRow, null);
});

test('validate-only rejects v1 and accepts fully migrated v4', async () => {
    const connection = new FakeMysqlConnection();
    connection.seedV1();
    const migrator = new MobileSourceMysqlMigrator({ connection });
    await assert.rejects(() => migrator.validate(), /required mobile source table is missing/);
    await migrator.migrate();
    assert.equal((await migrator.validate()).valid, true);
});

test('validate-only rejects a foreign key with an incorrect delete or update rule', async () => {
    for (const [field, value] of [
        ['onDelete', 'RESTRICT'],
        ['onUpdate', 'CASCADE'],
    ]) {
        const connection = new FakeMysqlConnection();
        await new MobileSourceMysqlMigrator({ connection }).migrate();
        const foreignKey = connection.tables.get(TABLES.fuelQuotes)
            .foreignKeys.get('fk_mobile_ocr_fuel_quote_snapshot');
        foreignKey[field] = value;
        await assert.rejects(
            () => new MobileSourceMysqlMigrator({ connection }).validate(),
            error => error.code === 'mobile_source_schema_foreign_key_invalid'
        );
    }
});

test('validate-only rejects v3/v4 column or quote uniqueness drift', async () => {
    const invalidColumn = new FakeMysqlConnection();
    await new MobileSourceMysqlMigrator({ connection: invalidColumn }).migrate();
    invalidColumn.tables.get(TABLES.fuelOffers).columns.get('display_price').numeric_scale = 2;
    await assert.rejects(
        () => new MobileSourceMysqlMigrator({ connection: invalidColumn }).validate(),
        error => error.code === 'mobile_source_schema_column_invalid'
    );

    const invalidIndex = new FakeMysqlConnection();
    await new MobileSourceMysqlMigrator({ connection: invalidIndex }).migrate();
    invalidIndex.tables.get(TABLES.fuelQuotes)
        .indexes.get('uq_mobile_ocr_quote_dedup').unique = false;
    await assert.rejects(
        () => new MobileSourceMysqlMigrator({ connection: invalidIndex }).validate(),
        error => error.code === 'mobile_source_schema_index_invalid'
    );

    const invalidV4Column = new FakeMysqlConnection();
    await new MobileSourceMysqlMigrator({ connection: invalidV4Column }).migrate();
    invalidV4Column.tables.get(TABLES.snapshots).columns.get('busy_ports').data_type = 'varchar';
    await assert.rejects(
        () => new MobileSourceMysqlMigrator({ connection: invalidV4Column }).validate(),
        error => error.code === 'mobile_source_schema_column_invalid'
    );
});

test('rollback contract is capability-first and never emits destructive schema DDL', async () => {
    const connection = new FakeMysqlConnection();
    const migrator = new MobileSourceMysqlMigrator({ connection });
    await migrator.migrate();
    assert.equal(connection.versionRow.version, 4);
    assert.equal(typeof migrator.down, 'undefined');
    assert.equal(
        connection.ddlStatements.some(statement =>
            /^(?:DROP|TRUNCATE|DELETE)\b/i.test(statement)
        ),
        false
    );
});

test('migration CLI plan does not connect or expose credentials', async () => {
    const output = [];
    const env = {
        MOBILE_SOURCE_MIGRATION_MYSQL_USER: 'unit-test-migration-user',
        MOBILE_SOURCE_MIGRATION_MYSQL_PASSWORD: 'unit-test-migration-password',
        MOBILE_SOURCE_MIGRATION_MYSQL_DATABASE: 'unit-test-database',
        MOBILE_SOURCE_RUNTIME_MYSQL_USER: 'unit-test-runtime-user',
        MOBILE_SOURCE_RUNTIME_MYSQL_DATABASE: 'unit-test-database',
    };
    const result = await runCli({
        argv: ['--dry-run'],
        env,
        logger: value => output.push(String(value)),
        mysqlModule: {
            async createConnection() {
                throw new Error('dry-run must not connect');
            },
        },
    });
    assert.equal(result.mode, 'plan');
    const text = output.join('\n');
    assert.match(text, new RegExp(MIGRATION_NAME));
    for (const value of Object.values(env)) assert.equal(text.includes(value), false);
});

test('migration connection config keeps isolation by default and supports explicit same-owner opt-in', () => {
    const config = buildMigrationConnectionConfig({
        MOBILE_SOURCE_MIGRATION_MYSQL_USER: 'unit-test-migration-user',
        MOBILE_SOURCE_MIGRATION_MYSQL_PASSWORD: 'unit-test-password',
        MOBILE_SOURCE_MIGRATION_MYSQL_DATABASE: 'unit-test-database',
        MOBILE_SOURCE_RUNTIME_MYSQL_USER: 'unit-test-runtime-user',
        MOBILE_SOURCE_RUNTIME_MYSQL_DATABASE: 'unit-test-database',
    });
    assert.equal(config.multipleStatements, false);

    const sharedOwnerConfig = buildMigrationConnectionConfig({
        MOBILE_SOURCE_MIGRATION_MYSQL_USER: 'unit-test-shared-owner',
        MOBILE_SOURCE_MIGRATION_MYSQL_PASSWORD: 'unit-test-password',
        MOBILE_SOURCE_MIGRATION_MYSQL_DATABASE: 'unit-test-database',
        MOBILE_SOURCE_RUNTIME_MYSQL_USER: 'unit-test-shared-owner',
        MOBILE_SOURCE_RUNTIME_MYSQL_DATABASE: 'unit-test-database',
        MOBILE_SOURCE_ALLOW_SHARED_DB_OWNER_MIGRATION: 'true',
    });
    assert.equal(sharedOwnerConfig.user, 'unit-test-shared-owner');
    assert.equal(sharedOwnerConfig.database, 'unit-test-database');
    assert.equal(sharedOwnerConfig.multipleStatements, false);

    assert.throws(() => buildMigrationConnectionConfig({
        MOBILE_SOURCE_MIGRATION_MYSQL_USER: 'same-user',
        MOBILE_SOURCE_MIGRATION_MYSQL_PASSWORD: 'unit-test-password',
        MOBILE_SOURCE_MIGRATION_MYSQL_DATABASE: 'unit-test-database',
        MOBILE_SOURCE_RUNTIME_MYSQL_USER: 'same-user',
        MOBILE_SOURCE_RUNTIME_MYSQL_DATABASE: 'unit-test-database',
    }), error => error.code === 'mobile_source_migration_account_not_separated');
    assert.throws(() => buildMigrationConnectionConfig({
        MOBILE_SOURCE_MIGRATION_MYSQL_USER: 'same-user',
        MOBILE_SOURCE_MIGRATION_MYSQL_PASSWORD: 'unit-test-password',
        MOBILE_SOURCE_MIGRATION_MYSQL_DATABASE: 'migration-database',
        MOBILE_SOURCE_RUNTIME_MYSQL_USER: 'same-user',
        MOBILE_SOURCE_RUNTIME_MYSQL_DATABASE: 'runtime-database',
        MOBILE_SOURCE_ALLOW_SHARED_DB_OWNER_MIGRATION: 'true',
    }), error => error.code === 'mobile_source_migration_shared_owner_database_mismatch');
    assert.throws(() => buildMigrationConnectionConfig({
        MOBILE_SOURCE_MIGRATION_MYSQL_USER: 'migration-user',
        MOBILE_SOURCE_MIGRATION_MYSQL_PASSWORD: 'unit-test-password',
        MOBILE_SOURCE_MIGRATION_MYSQL_DATABASE: 'unit-test-database',
        MOBILE_SOURCE_RUNTIME_MYSQL_USER: 'runtime-user',
        MOBILE_SOURCE_RUNTIME_MYSQL_DATABASE: 'unit-test-database',
        MOBILE_SOURCE_ALLOW_SHARED_DB_OWNER_MIGRATION: 'true',
    }), error => error.code === 'mobile_source_migration_shared_owner_opt_in_not_applicable');
    assert.throws(() => buildMigrationConnectionConfig({
        MOBILE_SOURCE_MIGRATION_MYSQL_USER: 'same-user',
        MOBILE_SOURCE_MIGRATION_MYSQL_PASSWORD: 'unit-test-password',
        MOBILE_SOURCE_MIGRATION_MYSQL_DATABASE: 'unit-test-database',
        MOBILE_SOURCE_RUNTIME_MYSQL_USER: 'same-user',
        MOBILE_SOURCE_RUNTIME_MYSQL_DATABASE: 'unit-test-database',
        MOBILE_SOURCE_ALLOW_SHARED_DB_OWNER_MIGRATION: 'yes',
    }), error => error.code === 'mobile_source_migration_shared_owner_opt_in_invalid');
    assert.throws(() => buildMigrationConnectionConfig({
        MOBILE_SOURCE_MIGRATION_MYSQL_USER: 'migration-user',
        MOBILE_SOURCE_MIGRATION_MYSQL_PASSWORD: 'unit-test-password',
        MOBILE_SOURCE_MIGRATION_MYSQL_DATABASE: 'unit-test-database',
        MOBILE_SOURCE_RUNTIME_MYSQL_USER: 'runtime-user',
    }), error => (
        error.code === 'mobile_source_migration_configuration_required'
        && !error.message.includes('unit-test-password')
    ));
    assert.throws(() => buildMigrationConnectionConfig({
        MOBILE_SOURCE_MIGRATION_MYSQL_USER: 'migration-user',
        MOBILE_SOURCE_MIGRATION_MYSQL_PASSWORD: 'unit-test-password',
        MOBILE_SOURCE_MIGRATION_MYSQL_DATABASE: 'migration-database',
        MOBILE_SOURCE_RUNTIME_MYSQL_USER: 'runtime-user',
        MOBILE_SOURCE_RUNTIME_MYSQL_DATABASE: 'runtime-database',
    }), error => error.code === 'mobile_source_migration_database_mismatch');
});

test('protected deployment environment validates isolated and explicit shared-owner modes', () => {
    const runtime = {
        MOBILE_SOURCE_HOST: '127.0.0.1',
        MOBILE_SOURCE_PORT: '50081',
        MOBILE_SOURCE_FUEL_QUOTE_V1_ENABLED: 'false',
        MOBILE_SOURCE_INGEST_TOKEN: 'unit-test-ingest-token',
        MOBILE_SOURCE_SYNC_TOKEN: 'unit-test-sync-token',
        MOBILE_SOURCE_MYSQL_USER: 'unit-test-runtime-user',
        MOBILE_SOURCE_MYSQL_PASSWORD: 'unit-test-runtime-password',
        MOBILE_SOURCE_MYSQL_DATABASE: 'unit-test-database',
    };
    const migration = {
        MOBILE_SOURCE_MIGRATION_MYSQL_USER: 'unit-test-migration-user',
        MOBILE_SOURCE_MIGRATION_MYSQL_PASSWORD: 'unit-test-migration-password',
        MOBILE_SOURCE_MIGRATION_MYSQL_DATABASE: 'unit-test-database',
    };
    const options = {
        runtime,
        migration,
        expectedHost: '127.0.0.1',
        expectedPort: '50081',
    };
    assert.deepEqual(validateDeploymentEnvironment(options), {
        identityMode: 'isolated',
    });
    assert.deepEqual(validateDeploymentEnvironment({
        ...options,
        runtime: {
            ...runtime,
            MOBILE_SOURCE_MYSQL_USER: 'unit-test-shared-owner',
        },
        migration: {
            ...migration,
            MOBILE_SOURCE_MIGRATION_MYSQL_USER: 'unit-test-shared-owner',
            MOBILE_SOURCE_ALLOW_SHARED_DB_OWNER_MIGRATION: 'true',
        },
    }), {
        identityMode: 'shared-db-owner',
    });

    const cases = [
        {
            runtime: {
                ...runtime,
                MOBILE_SOURCE_MYSQL_USER: 'same-user',
            },
            migration: {
                ...migration,
                MOBILE_SOURCE_MIGRATION_MYSQL_USER: 'same-user',
            },
            code: 'mobile_source_migration_account_not_separated',
        },
        {
            runtime: {
                ...runtime,
                MOBILE_SOURCE_MYSQL_USER: 'same-user',
            },
            migration: {
                ...migration,
                MOBILE_SOURCE_MIGRATION_MYSQL_USER: 'same-user',
                MOBILE_SOURCE_MIGRATION_MYSQL_DATABASE: 'other-database',
                MOBILE_SOURCE_ALLOW_SHARED_DB_OWNER_MIGRATION: 'true',
            },
            code: 'mobile_source_migration_shared_owner_database_mismatch',
        },
        {
            runtime,
            migration: {
                ...migration,
                MOBILE_SOURCE_ALLOW_SHARED_DB_OWNER_MIGRATION: 'true',
            },
            code: 'mobile_source_migration_shared_owner_opt_in_not_applicable',
        },
        {
            runtime,
            migration: {
                ...migration,
                MOBILE_SOURCE_ALLOW_SHARED_DB_OWNER_MIGRATION: '1',
            },
            code: 'mobile_source_migration_shared_owner_opt_in_invalid',
        },
        {
            runtime: {
                ...runtime,
                MOBILE_SOURCE_ALLOW_SHARED_DB_OWNER_MIGRATION: 'true',
            },
            migration,
            code: 'mobile_source_migration_shared_owner_opt_in_scope_invalid',
        },
        {
            runtime,
            migration: {
                ...migration,
                MOBILE_SOURCE_MIGRATION_MYSQL_DATABASE: 'other-database',
            },
            code: 'mobile_source_migration_database_mismatch',
        },
    ];
    for (const item of cases) {
        assert.throws(() => validateDeploymentEnvironment({
            ...options,
            runtime: item.runtime,
            migration: item.migration,
        }), error => (
            error.code === item.code
            && !error.message.includes('unit-test-runtime-password')
            && !error.message.includes('unit-test-migration-password')
        ));
    }
});

test('protected deployment environment CLI reads fixture files without exposing values', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-source-env-contract-'));
    const runtimePath = path.join(directory, 'runtime.env');
    const migrationPath = path.join(directory, 'migration.env');
    const output = [];
    try {
        fs.writeFileSync(runtimePath, [
            'MOBILE_SOURCE_HOST=127.0.0.1',
            'MOBILE_SOURCE_PORT=50081',
            'MOBILE_SOURCE_FUEL_QUOTE_V1_ENABLED=false',
            'MOBILE_SOURCE_INGEST_TOKEN=fixture-ingest-sensitive',
            'MOBILE_SOURCE_SYNC_TOKEN=fixture-sync-sensitive',
            'MOBILE_SOURCE_MYSQL_USER=fixture-owner-sensitive',
            'MOBILE_SOURCE_MYSQL_PASSWORD=fixture-runtime-password-sensitive',
            'MOBILE_SOURCE_MYSQL_DATABASE=fixture-database-sensitive',
            '',
        ].join('\n'), { mode: 0o600 });
        fs.writeFileSync(migrationPath, [
            'MOBILE_SOURCE_MIGRATION_MYSQL_USER=fixture-owner-sensitive',
            'MOBILE_SOURCE_MIGRATION_MYSQL_PASSWORD=fixture-migration-password-sensitive',
            'MOBILE_SOURCE_MIGRATION_MYSQL_DATABASE=fixture-database-sensitive',
            'MOBILE_SOURCE_ALLOW_SHARED_DB_OWNER_MIGRATION=true',
            '',
        ].join('\n'), { mode: 0o600 });
        const result = runDeploymentEnvironmentCli({
            argv: [runtimePath, migrationPath, '127.0.0.1', '50081'],
            logger: value => output.push(String(value)),
        });
        assert.deepEqual(result, { identityMode: 'shared-db-owner' });
        const text = output.join('\n');
        assert.equal(text, 'Protected environment contract passed');
        for (const sensitive of [
            'fixture-ingest-sensitive',
            'fixture-owner-sensitive',
            'fixture-runtime-password-sensitive',
            'fixture-migration-password-sensitive',
            'fixture-database-sensitive',
        ]) {
            assert.equal(text.includes(sensitive), false);
        }

        fs.appendFileSync(
            migrationPath,
            'MOBILE_SOURCE_ALLOW_SHARED_DB_OWNER_MIGRATION=invalid\n'
        );
        const invalid = spawnSync(process.execPath, [
            path.resolve(
                __dirname,
                '../scripts/validate-mobile-source-deployment-env.js'
            ),
            runtimePath,
            migrationPath,
            '127.0.0.1',
            '50081',
        ], { encoding: 'utf8' });
        assert.equal(invalid.status, 1);
        assert.match(
            invalid.stderr,
            /Protected environment contract failed \[mobile_source_migration_shared_owner_opt_in_invalid\]/
        );
        for (const sensitive of [
            'fixture-ingest-sensitive',
            'fixture-owner-sensitive',
            'fixture-runtime-password-sensitive',
            'fixture-migration-password-sensitive',
            'fixture-database-sensitive',
        ]) {
            assert.equal(invalid.stderr.includes(sensitive), false);
        }
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('formal install is backup-first, migration-before-cutover and feature-disabled', () => {
    const root = path.resolve(__dirname, '../..');
    const install = fs.readFileSync(
        path.join(root, 'scripts/install-47-mobile-source-systemd.sh'),
        'utf8'
    );
    const migrationRunner = fs.readFileSync(
        path.join(root, 'scripts/run-47-mobile-source-migration.sh'),
        'utf8'
    );
    const runtimeRunner = fs.readFileSync(
        path.join(root, 'scripts/run-47-mobile-source-foreground.sh'),
        'utf8'
    );
    const preflightBody = install.match(/^preflight\(\) \{([\s\S]*?)^\}/m)?.[1] || '';
    const migrationBody = install.match(/^migrate_before_cutover\(\) \{([\s\S]*?)^\}/m)?.[1] || '';
    const cutoverBody = install.match(/^cutover\(\) \{([\s\S]*?)^\}/m)?.[1] || '';
    const rollbackBody = install.match(/^rollback_cutover\(\) \{([\s\S]*?)^\}/m)?.[1] || '';
    const mainBody = install.match(/^main\(\) \{([\s\S]*?)^\}/m)?.[1] || '';
    const writeUnitBody = install.match(/^write_unit\(\) \{([\s\S]*?)^\}/m)?.[1] || '';
    const writeSmokeUnitBody = install.match(
        /^write_smoke_unit\(\) \{([\s\S]*?)^\}/m
    )?.[1] || '';
    const assertUnitReleaseRootBody = install.match(
        /^assert_unit_release_root\(\) \{([\s\S]*?)^\}/m
    )?.[1] || '';

    assert.match(preflightBody, /create_backup/);
    assert.match(preflightBody, /assert_release "\$ROOT" "Candidate release"/);
    assert.match(preflightBody, /CANDIDATE_MANIFEST="\$\(release_manifest "\$ROOT"\)"/);
    assert.match(preflightBody, /resolve_rollback_release/);
    assert.match(preflightBody, /assert_environment_contract/);
    assert.match(preflightBody, /"\$MIGRATION_RUNNER" --dry-run/);
    assert.doesNotMatch(preflightBody, /systemctl (?:stop|restart)/);

    const apply = migrationBody.indexOf('"$MIGRATION_RUNNER" --apply');
    const validate = migrationBody.indexOf('"$MIGRATION_RUNNER" --validate-only');
    const activeMigrateGuard = migrationBody.indexOf('[ "$MODE" = "--migrate" ]');
    assert.ok(activeMigrateGuard >= 0 && activeMigrateGuard < apply);
    assert.ok(apply >= 0 && validate > apply);
    assert.doesNotMatch(migrationBody, /systemctl (?:stop|restart)/);

    const validateBeforeCutover = cutoverBody.indexOf('validate_before_cutover');
    const smokeBeforeCutover = cutoverBody.indexOf('smoke_candidate_before_cutover');
    const markCutover = cutoverBody.indexOf('CUTOVER_STARTED=1');
    const restart = cutoverBody.indexOf('systemctl restart');
    const health = cutoverBody.indexOf('wait_for_health');
    assert.ok(validateBeforeCutover >= 0);
    assert.ok(smokeBeforeCutover > validateBeforeCutover);
    assert.ok(markCutover > smokeBeforeCutover);
    assert.ok(restart > markCutover);
    assert.ok(health > restart);

    assert.match(rollbackBody, /"\$ROLLBACK_UNIT"/);
    assert.match(rollbackBody, /cleanup_smoke_service/);
    assert.match(rollbackBody, /systemctl start/);
    assert.match(
        install,
        /--migrate refuses an active v2\/v3\/v4 service; use --all for an indivisible migration and cutover/
    );
    assert.match(mainBody, /--all\)[\s\S]*migrate_before_cutover[\s\S]*CUTOVER_STARTED=1[\s\S]*cutover/);
    assert.match(install, /TARGET_SCHEMA_VERSION/);
    assert.match(install, /\[ "\$target_version" = "4" \]/);
    assert.match(install, /physical-schema-v4 compatible/);
    assert.match(install, /DATABASE_BACKUP_CONFIRMED=1/);
    assert.match(install, /^EXPECTED_RUNTIME_HOST="127\.0\.0\.1"$/m);
    assert.match(install, /^EXPECTED_RUNTIME_PORT="50081"$/m);
    assert.match(install, /^SMOKE_RUNTIME_PORT="\$\{SMOKE_RUNTIME_PORT:-50082\}"$/m);
    assert.match(
        install,
        /^SMOKE_HEALTH_URL="http:\/\/\$\{EXPECTED_RUNTIME_HOST\}:\$\{SMOKE_RUNTIME_PORT\}\/health"$/m
    );
    assert.match(preflightBody, /assert_smoke_runtime_port/);
    assert.match(install, /SMOKE_RUNTIME_PORT must stay within the controlled 50082-50200 range/);
    assert.match(install, /"\$EXPECTED_RUNTIME_HOST" "\$SMOKE_RUNTIME_PORT"/);
    assert.match(install, /Candidate smoke port is unavailable/);
    assert.match(
        install,
        /backend\/scripts\/validate-mobile-source-deployment-env\.js/
    );
    assert.match(
        preflightBody,
        /assert_environment_contract/
    );
    assert.match(
        install,
        /^ExecStart=\$ENV_BIN ROOT=\$release_root ENV_FILE=\$RUNTIME_ENV_FILE NODE_BIN=\$NODE_BIN MOBILE_SOURCE_HOST=\$EXPECTED_RUNTIME_HOST MOBILE_SOURCE_PORT=\$EXPECTED_RUNTIME_PORT MOBILE_SOURCE_FUEL_QUOTE_V1_ENABLED=false \$release_runner$/m
    );
    assert.match(
        writeUnitBody,
        /WorkingDirectory=\$release_root[\s\S]*ExecStart=\$ENV_BIN ROOT=\$release_root ENV_FILE=\$RUNTIME_ENV_FILE[\s\S]*\$release_runner/
    );
    assert.match(writeSmokeUnitBody, /local release_root="\$1"/);
    assert.match(
        writeSmokeUnitBody,
        /local release_runner="\$release_root\/scripts\/run-47-mobile-source-foreground\.sh"/
    );
    assert.match(
        writeSmokeUnitBody,
        /WorkingDirectory=\$release_root[\s\S]*ExecStart=\$ENV_BIN ROOT=\$release_root ENV_FILE=\$RUNTIME_ENV_FILE[\s\S]*MOBILE_SOURCE_PORT=\$SMOKE_RUNTIME_PORT[\s\S]*\$release_runner/
    );
    assert.doesNotMatch(writeUnitBody, /\/opt\/data-for-didi-mobile-source/);
    assert.doesNotMatch(writeSmokeUnitBody, /\/opt\/data-for-didi-mobile-source|\$RUNNER/);
    assert.match(preflightBody, /write_smoke_unit "\$ROOT" "\$SMOKE_UNIT"/);
    assert.match(
        assertUnitReleaseRootBody,
        /expected_exec="ExecStart=\$ENV_BIN ROOT=\$release_root ENV_FILE=\$RUNTIME_ENV_FILE[\s\S]*\$release_runner"/
    );
    assert.match(
        assertUnitReleaseRootBody,
        /grep -Fqx "WorkingDirectory=\$release_root"/
    );
    assert.match(
        assertUnitReleaseRootBody,
        /grep -Fqx "EnvironmentFile=\$RUNTIME_ENV_FILE"/
    );
    assert.match(
        preflightBody,
        /assert_unit_release_root "\$CANDIDATE_UNIT" "\$ROOT" "\$EXPECTED_RUNTIME_PORT"/
    );
    assert.match(
        preflightBody,
        /assert_unit_release_root "\$SMOKE_UNIT" "\$ROOT" "\$SMOKE_RUNTIME_PORT"/
    );
    assert.match(
        preflightBody,
        /assert_unit_release_root[\s\\]*"\$ROLLBACK_UNIT" "\$ROLLBACK_ROOT" "\$EXPECTED_RUNTIME_PORT"/
    );
    assert.match(install, /^EnvironmentFile=\$RUNTIME_ENV_FILE$/m);
    assert.doesNotMatch(
        install.match(/^write_unit\(\) \{([\s\S]*?)^\}/m)?.[1] || '',
        /MOBILE_SOURCE_ALLOW_SHARED_DB_OWNER_MIGRATION/
    );
    assert.doesNotMatch(install, /RUNTIME_ENV_FILE="\$ENV_FILE"/);
    assert.doesNotMatch(install, /(?:cat|sed|awk)\s+["']?\$RUNTIME_ENV_FILE/);
    assert.doesNotMatch(
        `${writeUnitBody}\n${writeSmokeUnitBody}`,
        /(?:cp|install|rsync)[^\n]*RUNTIME_ENV_FILE/
    );
    assert.match(migrationRunner, /MOBILE_SOURCE_RUNTIME_MYSQL_DATABASE="\$\(/);
    assert.match(migrationRunner, /^export MOBILE_SOURCE_RUNTIME_MYSQL_DATABASE$/m);
    assert.match(
        migrationRunner,
        /unset[\s\S]*MOBILE_SOURCE_MIGRATION_MYSQL_PASSWORD[\s\S]*MOBILE_SOURCE_ALLOW_SHARED_DB_OWNER_MIGRATION/
    );
    assert.doesNotMatch(migrationRunner, /DOTENV_CONFIG_OVERRIDE/);
    assert.doesNotMatch(migrationRunner, /MOBILE_SOURCE_RUNTIME_MYSQL_PASSWORD/);
    assert.match(
        runtimeRunner,
        /^RUNTIME_NODE_MODULES="\$ROOT\/backend\/mobile-source-runtime\/node_modules"$/m
    );
    assert.match(runtimeRunner, /^cd "\$ROOT\/backend"$/m);
    assert.match(
        runtimeRunner,
        /^exec "\$NODE_BIN" scripts\/start-mobile-source-node\.js$/m
    );
    const v4Reference = fs.readFileSync(
        path.join(root, 'backend/resources/mysql/mobile-ocr-source-v4.sql'),
        'utf8'
    );
    assert.doesNotMatch(v4Reference, /\bDELIMITER\b|CREATE\s+PROCEDURE|CALL\s+/i);
    assert.doesNotMatch(v4Reference, /^(?!\s*--).*\b(?:DROP\s+TABLE|DELETE\s+FROM)\b/im);
});

test('generated candidate, smoke and rollback units bind cwd, ROOT and runner to one release', () => {
    const root = path.resolve(__dirname, '../..');
    const installPath = path.join(root, 'scripts/install-47-mobile-source-systemd.sh');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-source-unit-root-'));
    const candidateRoot = '/opt/data-for-didi-mobile-source-releases/unit-test-candidate';
    const productionUnit = path.join(directory, 'candidate.service');
    const smokeUnit = path.join(directory, 'candidate-smoke.service');
    const rollbackRoot = '/opt/data-for-didi-mobile-source-rollbacks/unit-test-rollback';
    const rollbackUnit = path.join(directory, 'rollback.service');
    try {
        const render = spawnSync('bash', [
            '-c',
            [
                'set -euo pipefail',
                'source "$1"',
                'install() {',
                '  local destination="${@: -1}"',
                '  /bin/cat > "$destination"',
                '}',
                'write_unit "$2" "$3"',
                'write_smoke_unit "$2" "$4"',
                'write_unit "$5" "$6"',
                'assert_unit_release_root "$3" "$2" "$EXPECTED_RUNTIME_PORT"',
                'assert_unit_release_root "$4" "$2" "$SMOKE_RUNTIME_PORT"',
                'assert_unit_release_root "$6" "$5" "$EXPECTED_RUNTIME_PORT"',
            ].join('\n'),
            'render-mobile-source-units',
            installPath,
            candidateRoot,
            productionUnit,
            smokeUnit,
            rollbackRoot,
            rollbackUnit,
        ], {
            encoding: 'utf8',
            env: {
                ...process.env,
                ENV_BIN: '/usr/bin/env',
                NODE_BIN: '/opt/node-v22/bin/node',
                RUNTIME_ENV_FILE: '/opt/protected/runtime.env',
            },
        });
        assert.equal(render.status, 0, render.stderr);

        const production = fs.readFileSync(productionUnit, 'utf8');
        const smoke = fs.readFileSync(smokeUnit, 'utf8');
        const rollback = fs.readFileSync(rollbackUnit, 'utf8');
        const runner = `${candidateRoot}/scripts/run-47-mobile-source-foreground.sh`;
        const rollbackRunner = `${rollbackRoot}/scripts/run-47-mobile-source-foreground.sh`;
        assert.match(production, new RegExp(`^WorkingDirectory=${candidateRoot}$`, 'm'));
        assert.match(
            production,
            new RegExp(
                `^ExecStart=/usr/bin/env ROOT=${candidateRoot} `
                + `ENV_FILE=/opt/protected/runtime\\.env NODE_BIN=/opt/node-v22/bin/node `
                + `MOBILE_SOURCE_HOST=127\\.0\\.0\\.1 MOBILE_SOURCE_PORT=50081 `
                + `MOBILE_SOURCE_FUEL_QUOTE_V1_ENABLED=false ${runner}$`,
                'm'
            )
        );
        assert.match(smoke, new RegExp(`^WorkingDirectory=${candidateRoot}$`, 'm'));
        assert.match(
            smoke,
            new RegExp(
                `^ExecStart=/usr/bin/env ROOT=${candidateRoot} `
                + `ENV_FILE=/opt/protected/runtime\\.env NODE_BIN=/opt/node-v22/bin/node `
                + `MOBILE_SOURCE_HOST=127\\.0\\.0\\.1 MOBILE_SOURCE_PORT=50082 `
                + `MOBILE_SOURCE_FUEL_QUOTE_V1_ENABLED=false ${runner}$`,
                'm'
            )
        );
        assert.match(rollback, new RegExp(`^WorkingDirectory=${rollbackRoot}$`, 'm'));
        assert.match(
            rollback,
            new RegExp(
                `^ExecStart=/usr/bin/env ROOT=${rollbackRoot} `
                + `ENV_FILE=/opt/protected/runtime\\.env NODE_BIN=/opt/node-v22/bin/node `
                + `MOBILE_SOURCE_HOST=127\\.0\\.0\\.1 MOBILE_SOURCE_PORT=50081 `
                + `MOBILE_SOURCE_FUEL_QUOTE_V1_ENABLED=false ${rollbackRunner}$`,
                'm'
            )
        );
        assert.equal(
            production.includes(
                'ROOT=/opt/data-for-didi-mobile-source NODE_BIN='
            ),
            false
        );
        assert.equal(
            smoke.includes(
                'ROOT=/opt/data-for-didi-mobile-source NODE_BIN='
            ),
            false
        );
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('runtime runner loads candidate code and modules while keeping protected env outside release', () => {
    const root = path.resolve(__dirname, '../..');
    const runtimeRunner = path.join(root, 'scripts/run-47-mobile-source-foreground.sh');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-source-runtime-root-'));
    const candidateRoot = path.join(directory, 'candidate');
    const protectedRoot = path.join(directory, 'protected');
    const fakeBin = path.join(directory, 'bin');
    const runtimeModules = path.join(
        candidateRoot,
        'backend/mobile-source-runtime/node_modules'
    );
    const protectedEnv = path.join(protectedRoot, '.env.mobile-source');
    const probeOutput = path.join(directory, 'runtime-probe.txt');
    const fakeNode = path.join(fakeBin, 'node');
    const fakeStat = path.join(fakeBin, 'stat');
    try {
        fs.mkdirSync(runtimeModules, { recursive: true });
        fs.mkdirSync(protectedRoot, { recursive: true });
        fs.mkdirSync(fakeBin, { recursive: true });
        fs.writeFileSync(protectedEnv, '# protected fixture\n', { mode: 0o600 });
        fs.writeFileSync(fakeNode, [
            '#!/usr/bin/env bash',
            'set -euo pipefail',
            'if [ "${1:-}" = "-p" ]; then',
            '  printf "22\\n"',
            '  exit 0',
            'fi',
            '{',
            '  printf "%s\\n" "$PWD"',
            '  printf "%s\\n" "$NODE_PATH"',
            '  printf "%s\\n" "$ENV_FILE"',
            '  printf "%s\\n" "$*"',
            '} > "$PROBE_OUTPUT"',
        ].join('\n'), { mode: 0o700 });
        fs.writeFileSync(fakeStat, [
            '#!/usr/bin/env bash',
            'set -euo pipefail',
            'if [ "${1:-}" = "-c" ] && [ "${2:-}" = "%a" ]; then',
            '  printf "600\\n"',
            '  exit 0',
            'fi',
            'exit 1',
        ].join('\n'), { mode: 0o700 });
        fs.chmodSync(fakeNode, 0o700);
        fs.chmodSync(fakeStat, 0o700);

        const result = spawnSync('bash', [runtimeRunner], {
            encoding: 'utf8',
            env: {
                ...process.env,
                PATH: `${fakeBin}:${process.env.PATH || ''}`,
                ROOT: candidateRoot,
                ENV_FILE: protectedEnv,
                NODE_BIN: fakeNode,
                PROBE_OUTPUT: probeOutput,
                MOBILE_SOURCE_INGEST_TOKEN: 'fixture-ingest',
                MOBILE_SOURCE_SYNC_TOKEN: 'fixture-sync',
                MOBILE_SOURCE_MYSQL_USER: 'fixture-runtime',
                MOBILE_SOURCE_MYSQL_PASSWORD: 'fixture-password',
                MOBILE_SOURCE_MYSQL_DATABASE: 'fixture-database',
            },
        });
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(
            fs.readFileSync(probeOutput, 'utf8').trim().split('\n'),
            [
                path.join(candidateRoot, 'backend'),
                runtimeModules,
                protectedEnv,
                'scripts/start-mobile-source-node.js',
            ]
        );
        assert.equal(
            fs.existsSync(path.join(candidateRoot, '.env.mobile-source')),
            false
        );
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('physical v4 cutover requires candidate and rollback to use the same release manifest', () => {
    const root = path.resolve(__dirname, '../..');
    const install = fs.readFileSync(
        path.join(root, 'scripts/install-47-mobile-source-systemd.sh'),
        'utf8'
    );
    const releaseManifestBody = install.match(
        /^release_manifest\(\) \{([\s\S]*?)^\}/m
    )?.[1] || '';
    const sameManifestBody = install.match(
        /^assert_same_release_manifest\(\) \{([\s\S]*?)^\}/m
    )?.[1] || '';
    const rollbackResolutionBody = install.match(
        /^resolve_rollback_release\(\) \{([\s\S]*?)^\}/m
    )?.[1] || '';

    assert.match(releaseManifestBody, /createHash\('sha256'\)/);
    assert.match(releaseManifestBody, /mobile-source-mysql-migrator\.js/);
    assert.match(releaseManifestBody, /migrate-mobile-source-mysql\.js/);
    assert.match(releaseManifestBody, /validate-mobile-source-deployment-env\.js/);
    assert.match(releaseManifestBody, /mobile-source-migration-identity-policy\.js/);
    assert.match(releaseManifestBody, /install-47-mobile-source-systemd\.sh/);
    assert.match(releaseManifestBody, /mobile-source-node-service\.js/);
    assert.match(releaseManifestBody, /mysql-mobile-source-store\.js/);
    assert.match(sameManifestBody, /rollback_manifest="\$\(release_manifest "\$ROLLBACK_ROOT"\)"/);
    assert.match(sameManifestBody, /\[ "\$rollback_manifest" = "\$CANDIDATE_MANIFEST" \]/);
    assert.match(sameManifestBody, /same physical-schema-v4 release manifest/);
    assert.match(rollbackResolutionBody, /assert_same_release_manifest/);
    assert.match(
        install,
        /schema metadata is v4[\s\S]*same-manifest v4 fallback/
    );
});
