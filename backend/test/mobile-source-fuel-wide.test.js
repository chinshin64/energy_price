'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
    COMPONENT,
    REQUIRED_COLUMNS,
    MobileSourceFuelWideMigrator,
    schemaChecksum,
} = require('../services/mobile-source-fuel-wide-migrator');
const {
    WIDE_COLUMNS,
    buildWideSelectSql,
    buildWideUpsertSql,
} = require('../services/mobile-source-fuel-wide-sql');
const {
    MobileSourceFuelWideWriter,
} = require('../services/mobile-source-fuel-wide-writer');
const {
    applyPatch,
    sha256,
} = require('../scripts/patch-mobile-source-v4-fuel-wide-store');
const {
    parseMode,
} = require('../scripts/migrate-mobile-source-fuel-wide');

test('fuel wide SQL preserves every quote, unselected offer and station-only snapshot', () => {
    const selection = buildWideSelectSql({
        snapshotTable: 'mobile_ocr_station_snapshots',
        requireFuelStationType: true,
        sourceRecordId: 150,
    });
    assert.equal(WIDE_COLUMNS.length, 56);
    assert.deepEqual(selection.parameters, [150, 150, 150]);
    assert.match(selection.sql, /'quote-only'/);
    assert.match(selection.sql, /'complete'/);
    assert.match(selection.sql, /'offer-only'/);
    assert.match(selection.sql, /'station-only'/);
    assert.match(selection.sql, /SELECT MIN\(o2\.id\)/);
    assert.match(selection.sql, /NOT EXISTS/);
    assert.match(selection.sql, /s\.station_type = 'fuel'/);
    assert.equal(
        selection.sql.match(/AS `agent_report_ip`/g)?.length,
        3
    );

    const upsert = buildWideUpsertSql();
    assert.match(upsert.sql, /ON DUPLICATE KEY UPDATE/);
    assert.doesNotMatch(upsert.sql, /bearer|authorization|password/i);
});

test('fuel wide writer uses the caller transaction connection and scoped source id', async () => {
    const statements = [];
    const connection = {
        async execute(sql, parameters) {
            statements.push({ sql, parameters });
            return [{ affectedRows: 2 }];
        },
    };
    const result = await new MobileSourceFuelWideWriter()
        .upsertSourceRecord(connection, 150);
    assert.deepEqual(result, { affectedRows: 2, sourceRecordId: 150 });
    assert.equal(statements.length, 1);
    assert.deepEqual(statements[0].parameters, [150, 150, 150]);
    assert.match(statements[0].sql, /mobile_ocr_fuel_wide_records/);
});

test('fuel wide writer propagates failures so ingest can roll back all writes', async () => {
    const error = new Error('simulated wide insert failure');
    error.code = 'ER_BAD_NULL_ERROR';
    const connection = {
        async execute() {
            throw error;
        },
    };
    await assert.rejects(
        () => new MobileSourceFuelWideWriter().upsertSourceRecord(connection, 150),
        thrown => thrown === error
    );
});

test('strict production v4 fixture patch injects only writer wiring and pre-commit call', () => {
    const fixturePath = path.join(
        __dirname,
        'fixtures/mysql-mobile-source-store-v4-production-excerpt.txt'
    );
    const fixture = fs.readFileSync(fixturePath, 'utf8');
    const result = applyPatch(fixture, { expectedSha256: sha256(fixture) });
    assert.equal(result.alreadyPatched, false);
    assert.match(result.content, /MobileSourceFuelWideWriter/);
    assert.match(result.content, /snapshotTable: 'mobile_ocr_station_snapshots'/);
    const duplicatePosition = result.content.indexOf('toIngestResult(existing, true)');
    const writerPosition = result.content.indexOf('fuelWideWriter.upsertSourceRecord');
    const commitPosition = result.content.indexOf('connection.commit');
    const rollbackPosition = result.content.indexOf('connection.rollback');
    assert.ok(duplicatePosition > 0 && duplicatePosition < writerPosition);
    assert.ok(writerPosition > 0 && writerPosition < commitPosition);
    assert.ok(commitPosition < rollbackPosition);
    assert.equal(applyPatch(result.content, {
        expectedPatchedSha256: sha256(result.content),
    }).alreadyPatched, true);
    assert.throws(
        () => applyPatch(`${fixture}\n// unexpected drift`, {
            expectedSha256: sha256(fixture),
        }),
        error => error.code === 'mobile_source_v4_patch_sha_mismatch'
    );
});

class FakeWideMigrationConnection {
    constructor(options = {}) {
        this.statements = [];
        this.currentVersion = options.currentVersion || null;
        this.currentChecksum = options.currentChecksum || null;
        this.hasAgentReportIp = options.hasAgentReportIp !== false;
        this.backfillCalls = 0;
    }

    async query(sql) {
        this.statements.push({ method: 'query', sql });
        if (/ADD COLUMN agent_report_ip/.test(sql)) {
            this.hasAgentReportIp = true;
            return [{ affectedRows: 0 }];
        }
        if (/SELECT\s+COUNT\(\*\) AS actual_count/i.test(sql)) {
            return [[{
                actual_count: 4,
                duplicate_key_count: 0,
                empty_station_name_count: 0,
                invalid_record_kind_count: 0,
                amount_mismatch_count: 0,
            }]];
        }
        if (/missing_quote_count/i.test(sql)) {
            return [[{
                missing_quote_count: 0,
                missing_offer_count: 0,
                missing_station_count: 0,
            }]];
        }
        if (/GROUP BY record_kind/i.test(sql)) {
            return [[
                { record_kind: 'complete', row_count: 1 },
                { record_kind: 'offer-only', row_count: 1 },
                { record_kind: 'quote-only', row_count: 1 },
                { record_kind: 'station-only', row_count: 1 },
            ]];
        }
        return [[]];
    }

    async execute(sql, parameters = []) {
        this.statements.push({ method: 'execute', sql, parameters });
        if (/GET_LOCK/.test(sql)) return [[{ acquired: 1 }]];
        if (/RELEASE_LOCK/.test(sql)) return [[{ released: 1 }]];
        if (/information_schema\.tables/.test(sql)) return [[{ table_count: 1 }]];
        if (/column_name = 'agent_report_ip'/.test(sql)) {
            return [[{ column_count: this.hasAgentReportIp ? 1 : 0 }]];
        }
        if (/information_schema\.columns/.test(sql)) {
            return [REQUIRED_COLUMNS
                .filter(column_name => this.hasAgentReportIp
                    || column_name !== 'agent_report_ip')
                .map(column_name => ({ column_name }))];
        }
        if (/information_schema\.statistics/.test(sql)) {
            return [[{ non_unique: 0, columns_csv: 'wide_record_key' }]];
        }
        if (/SELECT version, checksum/.test(sql)) {
            return [[this.currentVersion
                ? { version: this.currentVersion, checksum: this.currentChecksum }
                : undefined].filter(Boolean)];
        }
        if (/INSERT INTO mobile_ocr_schema_migrations/.test(sql)) {
            assert.equal(parameters[0], COMPONENT);
            this.currentVersion = 2;
            this.currentChecksum = schemaChecksum();
            return [{ affectedRows: 1 }];
        }
        if (/expected_wide_rows/.test(sql)) return [[{ expected_count: 4 }]];
        if (/INSERT INTO mobile_ocr_fuel_wide_records/.test(sql)) {
            this.backfillCalls += 1;
            return [{ affectedRows: this.backfillCalls === 1 ? 4 : 0 }];
        }
        return [[]];
    }
}

test('fuel wide migrator creates, backfills, records and validates independently of v5', async () => {
    const connection = new FakeWideMigrationConnection();
    const migrator = new MobileSourceFuelWideMigrator({ connection });
    const result = await migrator.migrate();
    assert.equal(result.schemaVersion, 2);
    assert.equal(result.backfill.affectedRows, 4);
    assert.equal(result.validation.actualCount, 4);
    assert.deepEqual(result.validation.recordKinds, {
        complete: 1,
        'offer-only': 1,
        'quote-only': 1,
        'station-only': 1,
    });
    const secondBackfill = await migrator.backfill();
    assert.equal(secondBackfill.affectedRows, 0);
    assert.equal(connection.backfillCalls, 2);
    const validation = await migrator.validate();
    assert.equal(validation.valid, true);
    assert.ok(connection.statements.some(item => /CREATE TABLE IF NOT EXISTS mobile_ocr_fuel_wide_records/
        .test(item.sql)));
});

test('fuel wide migrator upgrades an existing v1 table to nullable report IP without history synthesis', async () => {
    const connection = new FakeWideMigrationConnection({
        currentVersion: 1,
        currentChecksum: 'deployed-v1-checksum',
        hasAgentReportIp: false,
    });
    const result = await new MobileSourceFuelWideMigrator({ connection }).migrate();
    assert.equal(result.schemaVersion, 2);
    assert.equal(connection.hasAgentReportIp, true);
    const alter = connection.statements.find(item => /ADD COLUMN agent_report_ip/.test(item.sql));
    assert.ok(alter);
    assert.match(alter.sql, /VARCHAR\(45\) NULL/);
    const backfill = connection.statements.find(item =>
        /INSERT INTO mobile_ocr_fuel_wide_records/.test(item.sql)
    );
    assert.match(backfill.sql, /JSON_EXTRACT\(b\.raw_meta, '\$\.agentReportIp'\)/);
    assert.doesNotMatch(backfill.sql, /\$\.remoteAddress/);
    assert.match(
        backfill.sql,
        /agent_report_ip = COALESCE\(VALUES\(agent_report_ip\), agent_report_ip\)/
    );
});

test('fuel wide CLI requires an explicit mutating mode', () => {
    assert.equal(parseMode([]), 'plan');
    assert.equal(parseMode(['--dry-run']), 'plan');
    assert.equal(parseMode(['--apply']), 'apply');
    assert.equal(parseMode(['--backfill-only']), 'backfill');
    assert.equal(parseMode(['--validate-only']), 'validate');
    assert.throws(
        () => parseMode(['--apply', '--validate-only']),
        error => error.code === 'mobile_source_fuel_wide_argument_invalid'
    );
});
