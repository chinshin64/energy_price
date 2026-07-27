'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    COMPONENT,
    CREATE_VIEW_SQL,
    MINIMUM_SOURCE_SCHEMA_VERSION,
    MobileSourceFuelViewMigrator,
    SOURCE_COMPONENT,
    SOURCE_TABLE_COLUMNS,
    TARGET_SCHEMA_VERSION,
    VIEW_COLUMNS,
    VIEW_NAME,
    schemaChecksum,
} = require('../services/mobile-source-fuel-view-migrator');
const PRODUCTION_V4_SHOW_CREATE = require('./fixtures/mobile-source-v4-show-create');

function columnsFromShowCreate(sql) {
    return String(sql)
        .split('\n')
        .map(line => line.trim())
        .filter(line => /^[a-z_][a-z0-9_]*\s+/i.test(line))
        .map(line => line.split(/\s+/)[0].replace(/`/g, ''));
}

class FakeConnection {
    constructor() {
        this.created = false;
        this.version = null;
        this.viewWrites = 0;
        this.sourceColumns = Object.fromEntries(
            Object.entries(PRODUCTION_V4_SHOW_CREATE)
                .map(([table, sql]) => [table, columnsFromShowCreate(sql)])
        );
    }

    async execute(sql, values = []) {
        const normalized = String(sql).replace(/\s+/g, ' ').trim();
        if (normalized.includes('GET_LOCK')) return [[{ acquired: 1 }]];
        if (normalized.includes('RELEASE_LOCK')) return [[{ released: 1 }]];
        if (normalized.includes('WHERE component = ?') && values[0] === SOURCE_COMPONENT) {
            return [[{ version: MINIMUM_SOURCE_SCHEMA_VERSION }]];
        }
        if (normalized.startsWith('SELECT version AS version, checksum AS checksum')) {
            return [this.version ? [this.version] : []];
        }
        if (normalized.includes('FROM information_schema.views')) {
            return [this.created ? [{ table_name: VIEW_NAME }] : []];
        }
        if (normalized.includes('FROM information_schema.columns')) {
            if (Object.hasOwn(this.sourceColumns, values[0])) {
                return [this.sourceColumns[values[0]].map(column_name => ({ column_name }))];
            }
            return [this.created ? VIEW_COLUMNS.map(column_name => ({ column_name })) : []];
        }
        if (normalized.startsWith('INSERT INTO mobile_ocr_schema_migrations')) {
            assert.deepEqual(values.slice(0, 2), [COMPONENT, TARGET_SCHEMA_VERSION]);
            this.version = { version: TARGET_SCHEMA_VERSION, checksum: values[2] };
            return [{ affectedRows: 1 }];
        }
        throw new Error(`unsupported fake execute: ${normalized}`);
    }

    async query(sql) {
        const normalized = String(sql).replace(/\s+/g, ' ').trim();
        assert.match(normalized, /^CREATE OR REPLACE ALGORITHM=UNDEFINED SQL SECURITY INVOKER VIEW/);
        this.created = true;
        this.viewWrites += 1;
        return [{ affectedRows: 0 }];
    }
}

test('fuel complete view exposes the normalized read-only business contract', () => {
    const sql = CREATE_VIEW_SQL.replace(/\s+/g, ' ');
    assert.match(sql, /b\.platform AS channel/);
    assert.match(sql, /s\.station_name AS station_name/);
    assert.match(sql, /FROM mobile_ocr_station_snapshots AS s/);
    assert.match(sql, /o\.display_price AS display_price/);
    assert.match(sql, /q\.gross_discount AS discount_amount/);
    assert.match(sql, /q\.service_fee AS service_fee/);
    assert.match(sql, /q\.payable_amount AS payable_amount/);
    assert.match(sql, /s\.provider_name AS cp_name/);
    assert.match(sql, /q\.source_record_id = s\.source_record_id/);
    assert.match(sql, /q\.grade_code = o\.grade_code/);
    assert.doesNotMatch(sql, /mobile_ocr_fuel_snapshots|mobile_ocr_source_record_cursor/);
    assert.doesNotMatch(sql, /\bINSERT\b|\bUPDATE\b|\bDELETE\b/i);
});

test('fuel complete view dependencies match the production v4 SHOW CREATE TABLE contract', () => {
    assert.deepEqual(
        Object.keys(SOURCE_TABLE_COLUMNS).sort(),
        Object.keys(PRODUCTION_V4_SHOW_CREATE).sort()
    );
    for (const [table, requiredColumns] of Object.entries(SOURCE_TABLE_COLUMNS)) {
        const productionColumns = new Set(columnsFromShowCreate(PRODUCTION_V4_SHOW_CREATE[table]));
        for (const column of requiredColumns) {
            assert.equal(
                productionColumns.has(column),
                true,
                `${table}.${column} must exist in the production v4 contract`
            );
        }
    }
});

test('fuel complete view migration is repeatable and validates its exact columns', async () => {
    const connection = new FakeConnection();
    const migrator = new MobileSourceFuelViewMigrator({ connection });
    const first = await migrator.migrate();
    assert.equal(first.viewName, VIEW_NAME);
    assert.equal(connection.viewWrites, 1);
    assert.equal(connection.version.checksum, schemaChecksum());

    const second = await migrator.migrate();
    assert.equal(second.schemaVersion, TARGET_SCHEMA_VERSION);
    assert.equal(connection.viewWrites, 1);
    assert.deepEqual(await migrator.validate(), {
        valid: true,
        schemaVersion: TARGET_SCHEMA_VERSION,
        viewName: VIEW_NAME,
    });
});

test('fuel complete view migration refuses to run before source schema v4', async () => {
    const connection = new FakeConnection();
    const execute = connection.execute.bind(connection);
    connection.execute = (sql, values = []) => {
        if (values[0] === SOURCE_COMPONENT) return Promise.resolve([[{ version: 3 }]]);
        return execute(sql, values);
    };
    await assert.rejects(
        () => new MobileSourceFuelViewMigrator({ connection }).migrate(),
        error => error.code === 'mobile_source_fuel_view_requires_v4'
    );
});

test('fuel complete view migration fails closed when a production v4 column is missing', async () => {
    const connection = new FakeConnection();
    connection.sourceColumns.mobile_ocr_station_snapshots =
        connection.sourceColumns.mobile_ocr_station_snapshots
            .filter(column => column !== 'station_name');
    await assert.rejects(
        () => new MobileSourceFuelViewMigrator({ connection }).migrate(),
        error => error.code === 'mobile_source_fuel_view_source_schema_invalid'
    );
});
