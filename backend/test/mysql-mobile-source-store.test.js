'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { MysqlMobileSourceStore } = require('../services/mysql-mobile-source-store');

function batch() {
    return {
        ingestId: '00000000-0000-4000-8000-000000000001',
        idempotencyKey: 'a'.repeat(64),
        sourceAgent: 'android-agent',
        sourceStage: 'phone-auto-scroll',
        platform: 'didi-charging',
        city: '西安',
        deviceId: 'device-1',
        sessionId: 'session-1',
        pageIndex: 2,
        clientVersion: 'android-1.0',
        capturedAt: new Date('2026-07-21T07:00:00.000Z'),
        rawMeta: {},
        stations: [{
            stationId: null,
            stationName: '软件新城站',
            address: '陕西省西安市雁塔区',
            latitude: null,
            longitude: null,
            priceFast: 0.85,
            priceSlow: null,
            priceSuper: null,
            priceService: null,
            availablePorts: 3,
            totalPorts: 8,
            fastIdlePorts: 3,
            fastTotalPorts: 8,
            slowIdlePorts: 0,
            slowTotalPorts: 0,
            superIdlePorts: 0,
            superTotalPorts: 0,
            sourceStage: 'phone-auto-scroll',
            capturedAt: new Date('2026-07-21T06:58:30.000Z'),
            raw: {},
        }],
    };
}

test('MySQL source store commits batch and snapshots in one transaction', async () => {
    const statements = [];
    const connection = {
        async beginTransaction() { statements.push('BEGIN'); },
        async execute(sql, values) {
            statements.push({ sql, values });
            if (sql.includes('mobile_ocr_ingest_batches')) return [{ insertId: 41 }];
            if (sql.includes('mobile_ocr_source_record_cursor')) return [{ insertId: 200 }];
            return [{ insertId: 99 }];
        },
        async commit() { statements.push('COMMIT'); },
        async rollback() { statements.push('ROLLBACK'); },
        release() { statements.push('RELEASE'); },
    };
    const pool = {
        async execute() { return [[]]; },
        async getConnection() { return connection; },
    };
    const store = new MysqlMobileSourceStore({ pool });
    const result = await store.ingest(batch());

    assert.equal(result.persisted, true);
    assert.equal(result.sourceNode, '47-mysql');
    assert.equal(result.acceptedCount, 1);
    // sourceRecordId 现在用全局游标 global_seq 表达。
    assert.equal(result.firstSourceRecordId, 200);
    assert.equal(result.lastSourceRecordId, 200);
    assert.deepEqual(statements.filter(item => typeof item === 'string'), ['BEGIN', 'COMMIT', 'RELEASE']);
    const snapshotInsert = statements.find(item => typeof item === 'object' && item.sql.includes('mobile_ocr_charging_snapshots'));
    assert.ok(snapshotInsert, 'charging snapshot insert expected');
    assert.equal(snapshotInsert.values[0], 41);
    assert.equal(snapshotInsert.values[2], '47-mysql');
    assert.equal(snapshotInsert.values[3], 'android-agent');
    assert.equal(snapshotInsert.values[27].toISOString(), '2026-07-21T06:58:30.000Z');
    const cursorInsert = statements.find(item => typeof item === 'object' && item.sql.includes('mobile_ocr_source_record_cursor'));
    assert.ok(cursorInsert, 'cursor insert expected');
    assert.equal(cursorInsert.values[0], 99);
    assert.equal(cursorInsert.values[1], 'charging');
    assert.equal(cursorInsert.values[2], 41);
});

test('MySQL source store returns the existing durable acknowledgement for duplicate key', async () => {
    const pool = {
        async execute() {
            return [[{
                ingest_id: 'existing-ingest',
                idempotency_key: 'b'.repeat(64),
                source_node: '47-mysql',
                source_agent: 'ios-agent',
                station_count: 2,
                accepted_quote_count: 3,
                first_source_record_id: 501,
                last_source_record_id: 502,
                first_fuel_source_record_id: 501,
                last_fuel_source_record_id: 502,
            }]];
        },
        async getConnection() { throw new Error('transaction must not start'); },
    };
    const store = new MysqlMobileSourceStore({ pool });
    const input = batch();
    input.idempotencyKey = 'b'.repeat(64);
    const result = await store.ingest(input);
    assert.equal(result.duplicate, true);
    assert.equal(result.ingestId, 'existing-ingest');
    assert.equal(result.acceptedCount, 2);
    assert.equal(result.acceptedStationCount, 2);
    assert.equal(result.acceptedQuoteCount, 3);
    assert.equal(result.firstSourceRecordId, 501);
    assert.equal(result.lastSourceRecordId, 502);
    assert.equal(result.firstFuelSourceRecordId, 501);
    assert.equal(result.lastFuelSourceRecordId, 502);
});

test('MySQL source store exports typed records with a monotonic source id', async () => {
    const calls = [];
    const pool = {
        async query(sql, values) {
            calls.push({ method: 'query', sql, values });
            assert.deepEqual(values, [10, 20]);
            // 先查全局游标表，返回一条充电记录。
            return [[{
                global_seq: 11,
                source_record_id: 99,
                station_type: 'charging',
            }]];
        },
        async execute(sql, values) {
            calls.push({ method: 'execute', sql, values });
            // fetchChargingRows：JOIN cursor 带 global_seq。
            if (sql.includes('mobile_ocr_charging_snapshots')) {
                return [[{
                    global_seq: 11,
                    source_record_id: 99,
                    ingest_id: 'ingest-1',
                    record_index: 0,
                    source_node: '47-mysql',
                    source_agent: 'android-agent',
                    source_type: 'mobile-ocr',
                    source_stage: 'phone-auto-scroll',
                    platform: 'didi-charging',
                    city: '西安',
                    station_id: null,
                    station_name: '软件新城站',
                    address: null,
                    latitude: null,
                    longitude: null,
                    price_fast: '0.8500',
                    price_slow: null,
                    price_super: null,
                    price_service: null,
                    available_ports: 3,
                    total_ports: 8,
                    fast_idle_ports: 3,
                    fast_total_ports: 8,
                    slow_idle_ports: 0,
                    slow_total_ports: 0,
                    super_idle_ports: 0,
                    super_total_ports: 0,
                    busy_ports: null,
                    port_semantics: null,
                    captured_at: '2026-07-21 07:00:00.000',
                    raw_data: '{}',
                    provider_name: null,
                    missing_fields: null,
                    quality_status: 'valid',
                }]];
            }
            throw new Error(`unexpected execute: ${sql}`);
        },
    };
    const store = new MysqlMobileSourceStore({ pool });
    const rows = await store.listAfter(10, 20);
    // 第一条 query 查 cursor 表，随后 execute 查 charging_snapshots。
    assert.match(calls[0].sql, /mobile_ocr_source_record_cursor/);
    assert.match(calls[0].sql, /WHERE global_seq > \?/);
    assert.match(calls[0].sql, /LIMIT \?/);
    assert.equal(rows[0].sourceRecordId, 11);
    assert.equal(rows[0].priceFast, 0.85);
    assert.equal(rows[0].capturedAt, '2026-07-21T07:00:00.000Z');
    assert.equal(rows[0].stationType, 'charging');
});

test('MySQL source store returns an empty parameterized page without a fuel query', async () => {
    const calls = [];
    const pool = {
        async query(sql, values) {
            calls.push({ method: 'query', sql, values });
            return [[]];
        },
        async execute() {
            throw new Error('empty page must not query fuel offers');
        },
    };
    const rows = await new MysqlMobileSourceStore({ pool }).listAfter(37, 125);
    assert.deepEqual(rows, []);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'query');
    assert.deepEqual(calls[0].values, [37, 125]);
    assert.match(calls[0].sql, /mobile_ocr_source_record_cursor/);
    assert.match(calls[0].sql, /WHERE global_seq > \?/);
    assert.match(calls[0].sql, /LIMIT \?/);
});

test('MySQL source health verifies database connectivity and the split schema manifest', async () => {
    const queries = [];
    let validations = 0;
    const pool = {
        async query(sql) {
            queries.push(sql);
            return [[]];
        },
    };
    const store = new MysqlMobileSourceStore({
        pool,
        schemaValidator: {
            async validate() {
                validations += 1;
                return { schemaVersion: 4, valid: true };
            },
        },
    });
    assert.equal(await store.health(), true);
    assert.deepEqual(queries, ['SELECT 1 AS mobile_source_database_ready']);
    assert.equal(validations, 1);
});

test('MySQL source store inserts fuel offers in the same transaction as the snapshot', async () => {
    const statements = [];
    const connection = {
        async beginTransaction() { statements.push('BEGIN'); },
        async execute(sql, values) {
            statements.push({ sql, values });
            if (sql.includes('mobile_ocr_ingest_batches')) return [{ insertId: 50 }];
            if (sql.includes('mobile_ocr_fuel_snapshots')) return [{ insertId: 600 }];
            if (sql.includes('mobile_ocr_source_record_cursor')) return [{ insertId: 700 }];
            return [{ insertId: 800 }];
        },
        async commit() { statements.push('COMMIT'); },
        async rollback() { statements.push('ROLLBACK'); },
        release() { statements.push('RELEASE'); },
    };
    const pool = {
        async execute() { return [[]]; },
        async getConnection() { return connection; },
    };
    const input = batch();
    input.schemaVersion = 2;
    input.stationType = 'fuel';
    input.platform = 'tuanyou';
    input.stations = [{
        ...input.stations[0],
        stationType: 'fuel',
        address: null,
        priceFast: null,
        availablePorts: 0,
        totalPorts: 0,
        providerName: '团油',
        providerEvidence: {
            kind: 'provider-attribution',
            text: '本次由服务商团油提供',
        },
        raw: {
            providerEvidence: {
                kind: 'provider-attribution',
                text: '本次由服务商团油提供',
            },
        },
        fuelOffers: [{
            fuelType: 'gasoline',
            gradeCode: '92',
            gradeLabel: '92#',
            displayPrice: 6.63,
            stationPrice: 7.86,
            nationalPrice: 8.12,
            listPrice: 7.4,
            discountPrice: 7.1,
            unclassifiedPrice: null,
            discountKind: 'explicit',
            currency: 'CNY',
            unit: 'CNY_PER_LITER',
            fieldSource: { displayPrice: 'ocr' },
            evidence: [{ kind: 'discount-price' }],
            capturedAt: input.capturedAt,
        }],
        fuelQuotes: [{
            quoteObservationId: 'quote-observation-1',
            quoteDedupKey: 'c'.repeat(64),
            gradeCode: '92',
            gradeLabel: '92#汽油',
            gunCode: '6',
            gunLabel: '6号枪',
            selectedAmount: '200.00',
            grossDiscount: '8.39',
            serviceFee: '1.34',
            netDiscount: '7.05',
            payableAmount: '192.95',
            quoteEntry: 'inline',
            needsReview: false,
            capturedAt: input.capturedAt,
            raw: { evidence: '预计实付192.95元' },
        }],
    }];
    const result = await new MysqlMobileSourceStore({ pool }).ingest(input);
    assert.equal(result.persisted, true);
    assert.equal(result.acceptedStationCount, 1);
    assert.equal(result.acceptedQuoteCount, 1);
    // firstFuelSourceRecordId 现在用全局游标 global_seq 表达。
    assert.equal(result.firstFuelSourceRecordId, 700);
    assert.equal(result.lastFuelSourceRecordId, 700);
    const snapshotInsert = statements.find(item => typeof item === 'object'
        && item.sql.includes('INSERT INTO mobile_ocr_fuel_snapshots'));
    assert.equal(snapshotInsert.values.at(-5), '团油');
    const fuelInsert = statements.find(item => typeof item === 'object'
        && item.sql.includes('INSERT INTO mobile_ocr_fuel_offers'));
    assert.ok(fuelInsert);
    assert.equal(fuelInsert.values[0], 600);
    assert.equal(fuelInsert.values[3], '92');
    assert.equal(fuelInsert.values[5], 6.63);
    assert.equal(fuelInsert.values[6], 7.86);
    assert.equal(fuelInsert.values[7], 8.12);
    assert.deepEqual(JSON.parse(fuelInsert.values[14]), {
        rows: [{ kind: 'discount-price' }],
        fieldSource: { displayPrice: 'ocr' },
    });
    const quoteInsert = statements.find(item => typeof item === 'object'
        && item.sql.includes('INSERT INTO mobile_ocr_fuel_quotes'));
    assert.ok(quoteInsert);
    assert.equal(quoteInsert.values[0], 600);
    assert.equal(quoteInsert.values[1], 'quote-observation-1');
    assert.equal(quoteInsert.values[7], '200.00');
    assert.deepEqual(statements.filter(item => typeof item === 'string'), ['BEGIN', 'COMMIT', 'RELEASE']);
});

test('MySQL source store exports provider, evidence, three prices and quotes without field loss', async () => {
    const pool = {
        async query() {
            // 全局游标表返回一条燃油记录。
            return [[{
                global_seq: 701,
                source_record_id: 99,
                station_type: 'fuel',
            }]];
        },
        async execute(sql, values) {
            if (sql.includes('mobile_ocr_fuel_snapshots')) {
                assert.deepEqual(values, [99]);
                return [[{
                    global_seq: 701,
                    source_record_id: 99,
                    ingest_id: 'fuel-ingest-701',
                    record_index: 0,
                    source_node: '47-mysql',
                    source_agent: 'android-agent',
                    source_type: 'mobile-ocr',
                    source_stage: 'user-driven-ocr',
                    platform: 'amap-fuel',
                    city: '西安',
                    station_id: 'amap-fuel:station-701',
                    station_name: '测试油站',
                    address: '陕西省西安市测试路701号',
                    latitude: null,
                    longitude: null,
                    provider_name: '团油',
                    captured_at: '2026-07-23 07:00:00.000',
                    raw_data: JSON.stringify({
                        providerEvidence: {
                            kind: 'provider-attribution',
                            text: '本次由服务商团油提供',
                        },
                    }),
                    missing_fields: JSON.stringify([]),
                    quality_status: 'incomplete',
                }]];
            }
            assert.deepEqual(values, [99]);
            if (sql.includes('mobile_ocr_fuel_offers')) {
                return [[{
                    source_record_id: 99,
                    offer_index: 0,
                    fuel_type: 'gasoline',
                    grade_code: '92',
                    grade_label: '92#汽油',
                    display_price: '6.6300',
                    station_price: '7.8600',
                    national_price: '8.1200',
                    list_price: null,
                    discount_price: null,
                    unclassified_price: null,
                    discount_kind: 'none',
                    currency: 'CNY',
                    unit: 'CNY_PER_LITER',
                    evidence: JSON.stringify({
                        rows: [{ kind: 'display-price' }],
                        fieldSource: { displayPrice: 'ocr' },
                    }),
                    captured_at: '2026-07-23 07:00:00.000',
                }]];
            }
            if (sql.includes('mobile_ocr_fuel_quotes')) {
                return [[{
                    source_record_id: 99,
                    quote_observation_id: 'quote-observation-701',
                    quote_dedup_key: 'd'.repeat(64),
                    grade_code: '92',
                    grade_label: '92#汽油',
                    gun_code: null,
                    gun_label: null,
                    selected_amount: '200.00',
                    gross_discount: '20.65',
                    service_fee: '3.30',
                    net_discount: '17.35',
                    payable_amount: '182.65',
                    quote_entry: 'explanation_popup',
                    needs_review: 0,
                    captured_at: '2026-07-23 07:00:00.000',
                    raw_data: '{"evidence":"优惠说明"}',
                }]];
            }
            throw new Error('unexpected query');
        },
    };
    const [record] = await new MysqlMobileSourceStore({ pool }).listAfter(700, 1);
    assert.equal(record.sourceRecordId, 701);
    assert.equal(record.sourceStationKey, 'amap-fuel:station-701');
    assert.equal(record.providerName, '团油');
    assert.equal(record.address, '陕西省西安市测试路701号');
    // 燃油侧无枪数据，ports/portSemantics 一律为 null。
    assert.equal(record.availablePorts, null);
    assert.equal(record.busyPorts, null);
    assert.equal(record.totalPorts, null);
    assert.equal(record.portSemantics, null);
    assert.deepEqual(record.missingFields, []);
    assert.equal(record.qualityStatus, 'incomplete');
    assert.equal(record.needsReview, true);
    assert.equal(record.providerEvidence.text, '本次由服务商团油提供');
    assert.equal(
        Object.prototype.hasOwnProperty.call(record.raw, 'providerEvidence'),
        false
    );
    assert.deepEqual(
        record.raw.fuelObservation.providerEvidence,
        record.providerEvidence
    );
    assert.deepEqual(record.fuelOffers[0], {
        fuelType: 'gasoline',
        gradeCode: '92',
        gradeLabel: '92#汽油',
        displayPrice: 6.63,
        stationPrice: 7.86,
        nationalPrice: 8.12,
        listPrice: null,
        discountPrice: null,
        unclassifiedPrice: null,
        discountKind: 'none',
        currency: 'CNY',
        unit: 'CNY_PER_LITER',
        fieldSource: { displayPrice: 'ocr' },
        evidence: [{ kind: 'display-price' }],
        capturedAt: '2026-07-23T07:00:00.000Z',
    });
    assert.equal(record.fuelQuotes[0].selectedAmount, '200.00');
    assert.equal(record.fuelQuotes[0].payableAmount, '182.65');
    assert.equal(record.fuelQuotes[0].quoteEntry, 'explanation_popup');
    assert.equal(record.fuelQuotes[0].raw.evidence, '优惠说明');
});

test('legacy API v1/v2 physical zero ports keep their explicit zero semantics', () => {
    const store = new MysqlMobileSourceStore({ pool: {} });
    const common = {
        global_seq: 702,
        source_record_id: 702,
        ingest_id: 'legacy-ingest-702',
        record_index: 0,
        source_node: '47-mysql',
        source_agent: 'android-agent',
        source_type: 'mobile-ocr',
        source_stage: 'phone-user-scroll',
        platform: 'didi-charging',
        city: '西安',
        station_id: 'legacy-zero-702',
        station_name: '旧版物理零值兼容站',
        address: null,
        captured_at: '2026-07-24 07:00:00.000',
        raw_data: '{}',
        provider_name: null,
        missing_fields: null,
        quality_status: null,
    };
    const charging = store.toChargingRecord({
        ...common,
        price_fast: null,
        price_slow: null,
        price_super: null,
        price_service: null,
        available_ports: 0,
        busy_ports: null,
        total_ports: 0,
        fast_idle_ports: 0,
        fast_total_ports: 0,
        slow_idle_ports: 0,
        slow_total_ports: 0,
        super_idle_ports: 0,
        super_total_ports: 0,
        port_semantics: null,
    });
    // 充电表 ports 为 NULLable，显式 0 保留 0 语义。
    assert.equal(charging.availablePorts, 0);
    assert.equal(charging.busyPorts, 0);
    assert.equal(charging.totalPorts, 0);
    assert.deepEqual(charging.missingFields, []);

    const fuel = store.toFuelRecord({
        ...common,
        platform: 'tuanyou',
        latitude: null,
        longitude: null,
    }, [], []);
    // 燃油侧无枪数据，ports 恒为 null，不受 legacy 零值影响。
    assert.equal(fuel.availablePorts, null);
    assert.equal(fuel.busyPorts, null);
    assert.equal(fuel.totalPorts, null);
    assert.equal(fuel.portSemantics, null);
    assert.deepEqual(fuel.missingFields, []);
});

test('MySQL source store rolls back parent, offers and quotes when a quote insert fails', async () => {
    const statements = [];
    const connection = {
        async beginTransaction() { statements.push('BEGIN'); },
        async execute(sql) {
            statements.push(sql);
            if (sql.includes('mobile_ocr_ingest_batches')) return [{ insertId: 80 }];
            if (sql.includes('mobile_ocr_fuel_snapshots')) return [{ insertId: 801 }];
            if (sql.includes('mobile_ocr_source_record_cursor')) return [{ insertId: 805 }];
            if (sql.includes('mobile_ocr_fuel_quotes')) {
                const error = new Error('quote insert failed');
                error.code = 'ER_DATA_TOO_LONG';
                throw error;
            }
            return [{ insertId: 802 }];
        },
        async commit() { statements.push('COMMIT'); },
        async rollback() { statements.push('ROLLBACK'); },
        release() { statements.push('RELEASE'); },
    };
    const pool = {
        async execute() { return [[]]; },
        async getConnection() { return connection; },
    };
    const input = batch();
    input.schemaVersion = 2;
    input.stationType = 'fuel';
    input.stations = [{
        ...input.stations[0],
        stationType: 'fuel',
        address: null,
        priceFast: null,
        availablePorts: 0,
        totalPorts: 0,
        fuelOffers: [{
            fuelType: 'gasoline',
            gradeCode: '92',
            gradeLabel: '92#',
            displayPrice: 6.63,
            stationPrice: null,
            nationalPrice: null,
            listPrice: null,
            discountPrice: null,
            unclassifiedPrice: null,
            discountKind: 'none',
            currency: 'CNY',
            unit: 'CNY_PER_LITER',
            fieldSource: { displayPrice: 'ocr' },
            evidence: [],
            capturedAt: input.capturedAt,
        }],
        fuelQuotes: [{
            quoteObservationId: 'quote-observation-rollback',
            quoteDedupKey: 'e'.repeat(64),
            gradeCode: '92',
            gradeLabel: '92#',
            selectedAmount: '200.00',
            grossDiscount: null,
            serviceFee: null,
            netDiscount: null,
            payableAmount: null,
            quoteEntry: 'inline',
            needsReview: false,
            capturedAt: input.capturedAt,
            raw: {},
        }],
    }];
    await assert.rejects(
        () => new MysqlMobileSourceStore({ pool }).ingest(input),
        error => error.code === 'ER_DATA_TOO_LONG'
    );
    assert.equal(statements.includes('COMMIT'), false);
    assert.deepEqual(
        statements.filter(item => ['BEGIN', 'ROLLBACK', 'RELEASE'].includes(item)),
        ['BEGIN', 'ROLLBACK', 'RELEASE']
    );
});
