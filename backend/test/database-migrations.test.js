'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const Database = require('better-sqlite3');
const {
    MIGRATIONS,
    getMigrationPlan,
    runMigrations,
    tableColumns,
} = require('../database/migrations');

function legacyDatabase() {
    const db = new Database(':memory:');
    db.exec(`
        CREATE TABLE stations (
            id INTEGER PRIMARY KEY,
            platform TEXT,
            collected_at DATETIME
        );
        INSERT INTO stations (id, platform, collected_at)
        VALUES (1, 'didi-charging', '2026-07-10 10:00:00');
        CREATE TABLE api_templates (id INTEGER PRIMARY KEY);
        CREATE TABLE blue_team_reports (report_id TEXT PRIMARY KEY);
        CREATE TABLE schedules (
            id INTEGER PRIMARY KEY,
            name TEXT,
            platforms TEXT,
            cron_expression TEXT,
            enabled INTEGER,
            last_run DATETIME,
            next_run DATETIME,
            created_at DATETIME
        );
        INSERT INTO schedules (id, name, platforms, cron_expression, enabled)
        VALUES (1, 'legacy', '["didi-charging"]', '0 * * * *', 1);
    `);
    return db;
}

test('版本化迁移补齐旧库并记录当前版本', () => {
    const db = legacyDatabase();
    try {
        const result = runMigrations(db);
        assert.deepEqual(result.appliedNow, [1, 2, 3, 4, 5, 6, 7, 8]);
        assert.equal(result.currentVersion, MIGRATIONS.at(-1).version);
        assert.equal(db.pragma('user_version', { simple: true }), MIGRATIONS.at(-1).version);
        for (const column of ['snapshot_at', 'needs_review', 'confidence_score', 'confidence_dimensions']) {
            assert.equal(tableColumns(db, 'stations').has(column), true);
        }
        assert.equal(tableColumns(db, 'stations').has('source_agent'), true);
        assert.equal(tableColumns(db, 'stations').has('source_node'), true);
        assert.equal(tableColumns(db, 'stations').has('source_record_id'), true);
        assert.equal(tableColumns(db, 'stations').has('station_type'), true);
        assert.equal(tableColumns(db, 'stations').has('source_station_key'), true);
        assert.equal(tableColumns(db, 'stations').has('fuel_offers'), true);
        assert.equal(tableColumns(db, 'stations').has('provider_name'), true);
        assert.equal(tableColumns(db, 'fuel_offers').has('display_price'), true);
        assert.equal(tableColumns(db, 'fuel_offers').has('station_price'), true);
        assert.equal(tableColumns(db, 'fuel_offers').has('national_price'), true);
        assert.equal(tableColumns(db, 'fuel_quotes').has('quote_dedup_key'), true);
        assert.equal(tableColumns(db, 'api_templates').has('template_scope'), true);
        assert.equal(tableColumns(db, 'blue_team_reports').has('schema_version'), true);
        assert.equal(tableColumns(db, 'schedules').has('last_status'), true);
        assert.equal(tableColumns(db, 'schedules').has('timezone'), true);
        assert.equal(db.prepare('SELECT task_type FROM schedules WHERE id = 1').get().task_type, 'validation');
        const migratedSchedule = db.prepare(`
            SELECT enabled, last_status, last_error
            FROM schedules
            WHERE id = 1
        `).get();
        assert.equal(migratedSchedule.enabled, 0);
        assert.equal(migratedSchedule.last_status, 'configuration_required');
        assert.match(migratedSchedule.last_error, /explicit method3 target/);
        assert.equal(
            db.prepare('SELECT snapshot_at FROM stations WHERE id = 1').get().snapshot_at,
            '2026-07-10 10:00:00'
        );
    } finally {
        db.close();
    }
});

test('安全的 method3 定时验证在隔离迁移中保持启用', () => {
    const db = legacyDatabase();
    try {
        runMigrations(db, { migrations: MIGRATIONS.slice(0, 2) });
        db.prepare(`
            UPDATE schedules
            SET task_type = 'validation', payload = ?
            WHERE id = 1
        `).run(JSON.stringify({
            chain: 'method3',
            mode: 'list',
            target: {
                city: '西安',
                lat: 34.3416,
                lng: 108.9398,
                coordinateSystem: 'WGS84',
                radiusKm: 20,
            },
            maxPages: 1,
            maxRequestCount: 2,
            maxQps: 0.5,
        }));

        const result = runMigrations(db);
        assert.deepEqual(result.appliedNow, [3, 4, 5, 6, 7, 8]);
        const schedule = db.prepare(`
            SELECT enabled, last_status, last_error
            FROM schedules
            WHERE id = 1
        `).get();
        assert.equal(schedule.enabled, 1);
        assert.equal(schedule.last_status, 'never_run');
        assert.equal(schedule.last_error, null);
    } finally {
        db.close();
    }
});

test('SQLite v7 从 stations.fuel_offers 兼容列回填规范表且保留旧列', () => {
    const db = legacyDatabase();
    try {
        runMigrations(db, { migrations: MIGRATIONS.slice(0, 6) });
        const offers = [{
            fuelType: 'gasoline',
            gradeCode: '92',
            gradeLabel: '92#汽油',
            displayPrice: '6.6300',
            stationPrice: '7.8600',
            nationalPrice: '8.1200',
            currency: 'CNY',
            unit: 'CNY_PER_LITER',
            evidence: [{ kind: 'display-price', text: '6.63' }],
        }];
        db.prepare(`
            UPDATE stations
            SET station_type = 'fuel', fuel_offers = ?
            WHERE id = 1
        `).run(JSON.stringify(offers));

        const result = runMigrations(db);
        assert.deepEqual(result.appliedNow, [7, 8]);
        const station = db.prepare('SELECT fuel_offers FROM stations WHERE id = 1').get();
        const offer = db.prepare(`
            SELECT display_price, station_price, national_price, evidence
            FROM fuel_offers
            WHERE station_id = 1
        `).get();
        assert.deepEqual(JSON.parse(station.fuel_offers), offers);
        assert.equal(Number(offer.display_price), 6.63);
        assert.equal(Number(offer.station_price), 7.86);
        assert.equal(Number(offer.national_price), 8.12);
        assert.deepEqual(JSON.parse(offer.evidence), offers[0].evidence);
    } finally {
        db.close();
    }
});

test('迁移重复执行幂等并拒绝已应用定义漂移', () => {
    const db = legacyDatabase();
    try {
        runMigrations(db);
        assert.deepEqual(runMigrations(db).appliedNow, []);
        db.prepare('UPDATE schema_migrations SET checksum = ? WHERE version = 1').run('tampered');
        assert.throws(() => runMigrations(db), error => error.code === 'migration_checksum_mismatch');
    } finally {
        db.close();
    }
});

test('SQLite v7 已应用后检测物理索引漂移且不静默重建', () => {
    const db = legacyDatabase();
    try {
        runMigrations(db);
        db.exec('DROP INDEX idx_fuel_quotes_source_record');
        assert.throws(
            () => getMigrationPlan(db),
            error => error.code === 'migration_physical_drift'
        );
        assert.throws(
            () => runMigrations(db),
            error => error.code === 'migration_physical_drift'
        );
        assert.equal(
            db.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 7').get().count,
            1
        );
    } finally {
        db.close();
    }
});

test('SQLite v7 部分物理对象失败不记版本，清理漂移后可安全重入', () => {
    const db = legacyDatabase();
    try {
        runMigrations(db, { migrations: MIGRATIONS.slice(0, 6) });
        db.exec('CREATE TABLE fuel_quotes (id INTEGER PRIMARY KEY)');
        assert.throws(
            () => runMigrations(db),
            error => error.code === 'migration_physical_drift'
        );
        assert.equal(
            db.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 7').get().count,
            0
        );
        db.exec('DROP TABLE fuel_quotes');
        const recovered = runMigrations(db);
        assert.deepEqual(recovered.appliedNow, [7, 8]);
        assert.deepEqual(runMigrations(db).appliedNow, []);
    } finally {
        db.close();
    }
});

test('失败迁移不会写入版本记录或留下部分 DDL', () => {
    const db = legacyDatabase();
    const failing = [{
        version: 1,
        name: 'failing_migration',
        signature: 'failing-v1',
        up(database) {
            database.exec('CREATE TABLE should_rollback (id INTEGER)');
            throw new Error('migration failed');
        },
    }];
    try {
        assert.throws(() => runMigrations(db, { migrations: failing }), /migration failed/);
        assert.equal(
            db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'should_rollback'").get().count,
            0
        );
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count, 0);
    } finally {
        db.close();
    }
});
