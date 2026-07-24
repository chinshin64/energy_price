'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { RemoteMobileSourceSync } = require('../services/remote-mobile-source-sync');

function sourceRecord(id = 1) {
    return {
        sourceRecordId: id,
        ingestId: '00000000-0000-4000-8000-000000000001',
        sourceNode: '47-mysql',
        sourceAgent: 'ios-agent',
        sourceType: 'mobile-ocr',
        sourceStage: 'phone-user-scroll',
        platform: 'didi-charging',
        city: '西安',
        stationName: `软件新城站${id}`,
        address: '陕西省西安市雁塔区',
        availablePorts: 3,
        totalPorts: 8,
        fastIdlePorts: 3,
        fastTotalPorts: 8,
        capturedAt: '2026-07-21T07:00:00.000Z',
        raw: {},
    };
}

test('local product pulls 47 records, merges them, then advances cursor', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-source-sync-'));
    const inserted = [];
    const requests = [];
    const service = new RemoteMobileSourceSync({
        stationModel: {
            insertBatch(rows) {
                inserted.push(...rows);
                return { successCount: rows.length, yellowCount: 0, redCount: 0, skipCount: 0 };
            },
        },
        httpClient: {
            async get(url, config) {
                requests.push({ url, config });
                return { data: { success: true, data: { records: [sourceRecord(11), sourceRecord(12)] } } };
            },
        },
        baseUrl: 'http://47.111.139.230:50080',
        allowHttp: true,
        allowedHosts: ['47.111.139.230'],
        token: 'sync-secret',
        statePath: path.join(root, 'state.json'),
    });

    const result = await service.pullOnce();
    assert.equal(result.cursor, 12);
    assert.equal(inserted.length, 2);
    assert.equal(inserted[0].sourceAgent, 'ios-agent');
    assert.equal(inserted[0].raw.mobileSync.meta.sourceNode, '47-mysql');
    assert.equal(inserted[0].raw.mobileSync.meta.sourceRecordId, 11);
    assert.equal(requests[0].config.params.afterId, 0);
    assert.equal(requests[0].config.proxy, false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8')).cursor, 12);
    fs.rmSync(root, { recursive: true, force: true });
});

test('local cursor does not advance when local database transaction fails', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-source-sync-fail-'));
    const statePath = path.join(root, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({ cursor: 8 }));
    const service = new RemoteMobileSourceSync({
        stationModel: { insertBatch() { throw new Error('sqlite transaction failed'); } },
        httpClient: {
            async get() {
                return { data: { success: true, data: { records: [sourceRecord(9)] } } };
            },
        },
        baseUrl: 'http://47.111.139.230:50080',
        allowHttp: true,
        allowedHosts: ['47.111.139.230'],
        token: 'sync-secret',
        statePath,
    });

    await assert.rejects(() => service.pullOnce(), /sqlite transaction failed/);
    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).cursor, 8);
    fs.rmSync(root, { recursive: true, force: true });
});

test('local source adapter rejects non-monotonic or foreign source records', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-source-sync-invalid-'));
    const service = new RemoteMobileSourceSync({
        stationModel: { insertBatch() { throw new Error('must not insert'); } },
        httpClient: {
            async get() {
                return { data: { success: true, data: { records: [sourceRecord(2), sourceRecord(2)] } } };
            },
        },
        baseUrl: 'http://47.111.139.230:50080',
        allowHttp: true,
        allowedHosts: ['47.111.139.230'],
        token: 'sync-secret',
        statePath: path.join(root, 'state.json'),
    });
    await assert.rejects(() => service.pullOnce(), /sourceRecordId must increase/);
    assert.equal(fs.existsSync(path.join(root, 'state.json')), false);
    fs.rmSync(root, { recursive: true, force: true });
});

test('local product advances past verification records without merging them by default', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-source-sync-verification-'));
    const inserted = [];
    const record = sourceRecord(21);
    record.sourceAgent = 'verification-agent';
    const service = new RemoteMobileSourceSync({
        stationModel: {
            insertBatch(rows) {
                inserted.push(...rows);
                return { successCount: rows.length, yellowCount: 0, redCount: 0, skipCount: 0 };
            },
        },
        httpClient: {
            async get() {
                return { data: { success: true, data: { records: [record] } } };
            },
        },
        baseUrl: 'http://47.111.139.230:50080',
        allowHttp: true,
        allowedHosts: ['47.111.139.230'],
        token: 'sync-secret',
        statePath: path.join(root, 'state.json'),
    });

    const result = await service.pullOnce();
    assert.equal(result.cursor, 21);
    assert.equal(result.lastFetchedCount, 1);
    assert.equal(result.lastMergedCount, 0);
    assert.equal(inserted.length, 0);
    fs.rmSync(root, { recursive: true, force: true });
});

test('local source adapter maps fuel details plus public station address and gun status atomically', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-source-sync-fuel-'));
    const inserted = [];
    const fuel = {
        sourceRecordId: 31,
        ingestId: '00000000-0000-4000-8000-000000000031',
        sourceNode: '47-mysql',
        sourceAgent: 'ios-agent',
        sourceType: 'mobile-ocr',
        sourceStage: 'phone-user-scroll',
        city: '杭州',
        capturedAt: '2026-07-23T03:30:00.000Z',
        raw: {},
        stationType: 'fuel',
        platform: 'amap-fuel',
        stationName: '浙江石油测试加油站',
        address: '浙江省杭州市测试路31号',
        availablePorts: 2,
        busyPorts: 1,
        totalPorts: 3,
        portSemantics: 'fuel-gun',
        sourceStationKey: 'amap-fuel:station-31',
        fuelObservation: {
            providerName: '=测试服务商',
            providerEvidence: {
                kind: 'provider-attribution',
                text: '本服务由测试服务商提供',
                confidence: null,
                boundingBox: { x: 0.1, y: 0.2, width: 0.3, height: 0.04 },
            },
            fuelOffers: [{
                fuelType: 'gasoline',
                gradeCode: '92',
                gradeLabel: '92#',
                displayPrice: '6.6300',
                stationPrice: '7.8600',
                nationalPrice: '8.1200',
                listPrice: null,
                discountPrice: null,
                unclassifiedPrice: null,
                discountKind: 'none',
                currency: 'CNY',
                unit: 'CNY_PER_LITER',
                fieldSource: {
                    displayPrice: 'ocr',
                    stationPrice: 'ocr',
                    nationalPrice: 'ocr',
                },
                evidence: [{
                    kind: 'display-price',
                    boundingBox: { x: 0.1, y: 0.3, width: 0.2, height: 0.04 },
                }],
                capturedAt: '2026-07-23T03:30:00.000Z',
            }],
            fuelQuotes: [{
                quoteObservationId: 'quote-31',
                quoteDedupKey: 'a'.repeat(64),
                gradeCode: '92',
                gradeLabel: '92#',
                gunCode: null,
                gunLabel: null,
                selectedAmount: '200.00',
                grossDiscount: '20.65',
                serviceFee: '3.30',
                netDiscount: '17.35',
                payableAmount: '182.65',
                quoteEntry: 'inline',
                needsReview: false,
                capturedAt: '2026-07-23T03:30:00.000Z',
                raw: {},
            }],
        },
    };
    fuel.raw = {
        providerEvidence: structuredClone(
            fuel.fuelObservation.providerEvidence
        ),
    };
    const service = new RemoteMobileSourceSync({
        stationModel: {
            insertBatch(rows) {
                inserted.push(...rows);
                return { successCount: rows.length, yellowCount: 0, redCount: 0, skipCount: 0 };
            },
        },
        httpClient: {
            async get() {
                return { data: { success: true, data: { records: [fuel] } } };
            },
        },
        baseUrl: 'https://mobile-source.example.test',
        allowedHosts: ['mobile-source.example.test'],
        token: 'test-token',
        statePath: path.join(root, 'state.json'),
    });
    await service.pullOnce();
    assert.equal(inserted[0].stationType, 'fuel');
    assert.equal(inserted[0].sourceStationKey, 'amap-fuel:station-31');
    assert.equal(inserted[0].fuelOffers[0].gradeCode, '92');
    assert.equal(inserted[0].fuelOffers[0].displayPrice, '6.6300');
    assert.equal(inserted[0].fuelQuotes[0].payableAmount, '182.65');
    assert.equal(inserted[0].providerName, '=测试服务商');
    assert.deepEqual(
        inserted[0].raw.fuelObservation.providerEvidence,
        fuel.fuelObservation.providerEvidence
    );
    assert.equal(
        Object.prototype.hasOwnProperty.call(inserted[0].raw, 'providerEvidence'),
        false
    );
    assert.equal(Object.prototype.hasOwnProperty.call(inserted[0], 'priceFast'), false);
    assert.equal(inserted[0].address, '浙江省杭州市测试路31号');
    // 燃油侧无枪数据：即使 47 store 残留 ports，toLocalStation 也不映射到本地燃油记录。
    assert.equal(inserted[0].availablePorts, undefined);
    assert.equal(inserted[0].busyPorts, undefined);
    assert.equal(inserted[0].totalPorts, undefined);
    const mismatchedEvidence = structuredClone(fuel);
    mismatchedEvidence.raw.providerEvidence.text = '不一致的服务商证据';
    assert.throws(
        () => service.normalizeRecords([mismatchedEvidence], 0),
        /provider evidence mismatch/
    );
    fs.rmSync(root, { recursive: true, force: true });
});

test('local cursor does not advance when persistence reports any rejected record', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-source-sync-rejected-'));
    const statePath = path.join(root, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({ cursor: 50 }));
    const service = new RemoteMobileSourceSync({
        stationModel: {
            insertBatch() {
                return { successCount: 0, yellowCount: 0, redCount: 1, skipCount: 0 };
            },
        },
        httpClient: {
            async get() {
                return { data: { success: true, data: { records: [sourceRecord(51)] } } };
            },
        },
        baseUrl: 'https://mobile-source.example.test',
        allowedHosts: ['mobile-source.example.test'],
        token: 'test-token',
        statePath,
    });

    await assert.rejects(
        () => service.pullOnce(),
        error => error.code === 'mobile_source_persistence_incomplete'
    );
    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).cursor, 50);
    fs.rmSync(root, { recursive: true, force: true });
});

test('local source adapter allows public fuel gun fields but rejects charging detail, nested raw and high precision', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-source-sync-fuel-invalid-'));
    const service = new RemoteMobileSourceSync({
        stationModel: { insertBatch() { throw new Error('must not insert'); } },
        baseUrl: 'https://mobile-source.example.test',
        allowedHosts: ['mobile-source.example.test'],
        token: 'test-token',
        statePath: path.join(root, 'state.json'),
    });
    const valid = {
        sourceRecordId: 41,
        ingestId: '00000000-0000-4000-8000-000000000041',
        sourceNode: '47-mysql',
        sourceAgent: 'ios-agent',
        sourceType: 'mobile-ocr',
        sourceStage: 'phone-user-scroll',
        city: '杭州',
        capturedAt: '2026-07-23T03:30:00.000Z',
        raw: {},
        stationType: 'fuel',
        platform: 'tuanyou',
        stationName: '测试加油站',
        fuelOffers: [{
            fuelType: 'gasoline',
            gradeCode: '95',
            gradeLabel: '95#',
            discountPrice: 7.1234,
            discountKind: 'explicit',
            currency: 'CNY',
            unit: 'CNY_PER_LITER',
            fieldSource: {},
            evidence: [],
            capturedAt: '2026-07-23T03:30:00.000Z',
        }],
        fuelQuotes: [],
    };
    assert.doesNotThrow(() => service.normalizeRecords([valid], 0));
    const richEvidence = structuredClone(valid);
    richEvidence.fuelOffers[0].evidence = [{
        kind: 'display-price',
        text: '外显价6.63元/升',
        format: 'currency-per-liter',
        type: 'ocr-row',
        confidence: 0.97,
        boundingBox: { x: 0.1, y: 0.2, width: 0.3, height: 0.04 },
    }];
    assert.doesNotThrow(() => service.normalizeRecords([richEvidence], 0));
    assert.doesNotThrow(
        () => service.normalizeRecords([{
            ...valid,
            address: '测试地址',
            availablePorts: 0,
            busyPorts: 2,
            totalPorts: 2,
        }], 0)
    );
    assert.throws(
        () => service.normalizeRecords([{ ...valid, priceFast: 1 }], 0),
        /fuel record contains charging fields/
    );
    assert.throws(
        () => service.normalizeRecords([{ ...valid, raw: { nested: { fastAvailablePorts: 1 } } }], 0),
        /fuel record contains charging fields/
    );
    const precise = structuredClone(valid);
    precise.fuelOffers[0].discountPrice = 7.12345;
    assert.throws(() => service.normalizeRecords([precise], 0), /fuel offers invalid/);
    const unknown = structuredClone(valid);
    unknown.fuelOffers[0].unsupported = true;
    assert.throws(() => service.normalizeRecords([unknown], 0), /fuel offers invalid/);
    const unknownEvidence = structuredClone(richEvidence);
    unknownEvidence.fuelOffers[0].evidence[0].ocrPayload = 'must-not-be-persisted';
    assert.throws(() => service.normalizeRecords([unknownEvidence], 0), /fuel offers invalid/);
    const longEvidence = structuredClone(richEvidence);
    longEvidence.fuelOffers[0].evidence[0].text = '价'.repeat(257);
    assert.throws(() => service.normalizeRecords([longEvidence], 0), /fuel offers invalid/);
    const badConfidence = structuredClone(richEvidence);
    badConfidence.fuelOffers[0].evidence[0].confidence = 1.01;
    assert.throws(() => service.normalizeRecords([badConfidence], 0), /fuel offers invalid/);
    const badBox = structuredClone(richEvidence);
    badBox.fuelOffers[0].evidence[0].boundingBox = {
        x: 0.8, y: 0.2, width: 0.3, height: 0.04,
    };
    assert.throws(() => service.normalizeRecords([badBox], 0), /fuel offers invalid/);
    const tooManyRows = structuredClone(richEvidence);
    tooManyRows.fuelOffers[0].evidence = Array.from(
        { length: 9 },
        () => ({ kind: 'display-price' })
    );
    assert.throws(() => service.normalizeRecords([tooManyRows], 0), /fuel offers invalid/);
    const oversizedEvidence = structuredClone(richEvidence);
    oversizedEvidence.fuelOffers[0].evidence[0].confidence = '0'.repeat(17000);
    assert.throws(() => service.normalizeRecords([oversizedEvidence], 0), /fuel offers invalid/);
    const sensitiveEvidence = structuredClone(richEvidence);
    sensitiveEvidence.fuelOffers[0].evidence[0].text = 'token=secret-value';
    assert.throws(() => service.normalizeRecords([sensitiveEvidence], 0), /fuel offers invalid/);
    fs.rmSync(root, { recursive: true, force: true });
});

test('local source adapter accepts quote-only fuel and rejects unknown nested fields', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-source-sync-quote-only-'));
    const service = new RemoteMobileSourceSync({
        stationModel: { insertBatch() { throw new Error('not used'); } },
        baseUrl: 'https://mobile-source.example.test',
        allowedHosts: ['mobile-source.example.test'],
        token: 'test-token',
        statePath: path.join(root, 'state.json'),
    });
    const record = {
        sourceRecordId: 61,
        ingestId: '00000000-0000-4000-8000-000000000061',
        sourceNode: '47-mysql',
        sourceAgent: 'android-agent',
        sourceType: 'mobile-ocr',
        sourceStage: 'user-driven-ocr',
        city: '西安',
        capturedAt: '2026-07-23T03:30:00.000Z',
        raw: {},
        stationType: 'fuel',
        platform: 'amap-fuel',
        stationName: '测试加油站',
        sourceStationKey: 'amap-fuel:station-61',
        providerName: null,
        providerEvidence: null,
        fuelOffers: [],
        fuelQuotes: [{
            quoteObservationId: 'quote-only-00000061',
            quoteDedupKey: 'b'.repeat(64),
            gradeCode: '92',
            gradeLabel: '92#汽油',
            gunCode: null,
            gunLabel: null,
            selectedAmount: '200.00',
            grossDiscount: '20.65',
            serviceFee: '3.30',
            netDiscount: '17.35',
            payableAmount: '182.65',
            quoteEntry: 'inline',
            needsReview: false,
            capturedAt: '2026-07-23T03:30:00.000Z',
            raw: {},
        }],
    };
    assert.equal(service.normalizeRecords([record], 0)[0].fuelOffers.length, 0);
    const maxProvider = structuredClone(record);
    maxProvider.providerName = '服'.repeat(128);
    maxProvider.providerEvidence = {
        kind: 'provider-attribution',
        text: '本服务由测试服务商提供',
        confidence: null,
        boundingBox: null,
    };
    assert.doesNotThrow(() => service.normalizeRecords([maxProvider], 0));
    const oversizedProvider = structuredClone(maxProvider);
    oversizedProvider.providerName = '服'.repeat(129);
    assert.throws(() => service.normalizeRecords([oversizedProvider], 0), /provider invalid/);

    const unknownQuote = structuredClone(record);
    unknownQuote.fuelQuotes[0].unsupported = true;
    assert.throws(() => service.normalizeRecords([unknownQuote], 0), /fuel quotes invalid/);

    const unknownEvidence = structuredClone(record);
    unknownEvidence.providerName = '测试服务商';
    unknownEvidence.providerEvidence = {
        kind: 'provider-attribution',
        text: '本服务由测试服务商提供',
        bounds: [1, 2, 3, 4],
    };
    assert.throws(() => service.normalizeRecords([unknownEvidence], 0), /provider evidence invalid/);
    fs.rmSync(root, { recursive: true, force: true });
});

test('invalid fuel structure is rejected before Station and leaves cursor unchanged', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-source-sync-structure-fail-'));
    const statePath = path.join(root, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({ cursor: 70 }));
    let insertCalls = 0;
    const service = new RemoteMobileSourceSync({
        stationModel: {
            insertBatch() {
                insertCalls += 1;
                return { successCount: 1, yellowCount: 0, redCount: 0, skipCount: 0 };
            },
        },
        httpClient: {
            async get() {
                return {
                    data: {
                        success: true,
                        data: {
                            records: [{
                                sourceRecordId: 71,
                                ingestId: '00000000-0000-4000-8000-000000000071',
                                sourceNode: '47-mysql',
                                sourceAgent: 'android-agent',
                                sourceType: 'mobile-ocr',
                                sourceStage: 'user-driven-ocr',
                                city: '西安',
                                capturedAt: '2026-07-23T03:30:00.000Z',
                                raw: {},
                                stationType: 'fuel',
                                platform: 'amap-fuel',
                                stationName: '测试加油站',
                                sourceStationKey: 'amap-fuel:station-71',
                                providerName: null,
                                providerEvidence: null,
                                fuelOffers: [{
                                    fuelType: 'gasoline',
                                    gradeCode: '92',
                                    gradeLabel: '92#汽油',
                                    displayPrice: '6.6300',
                                    stationPrice: null,
                                    nationalPrice: null,
                                    listPrice: null,
                                    discountPrice: null,
                                    unclassifiedPrice: null,
                                    discountKind: 'none',
                                    currency: 'CNY',
                                    unit: 'CNY_PER_LITER',
                                    fieldSource: { displayPrice: 'ocr' },
                                    evidence: [{
                                        kind: 'display-price',
                                        text: '外显价6.63元/升',
                                        unsupported: true,
                                    }],
                                    capturedAt: '2026-07-23T03:30:00.000Z',
                                }],
                                fuelQuotes: [{
                                    quoteObservationId: 'quote-only-00000071',
                                    quoteDedupKey: 'f'.repeat(64),
                                    gradeCode: '92',
                                    gradeLabel: '92#汽油',
                                    gunCode: null,
                                    gunLabel: null,
                                    selectedAmount: '200.00',
                                    grossDiscount: '20.65',
                                    serviceFee: '3.30',
                                    netDiscount: '17.35',
                                    payableAmount: '182.65',
                                    quoteEntry: 'inline',
                                    needsReview: false,
                                    capturedAt: '2026-07-23T03:30:00.000Z',
                                    raw: {},
                                }],
                            }],
                        },
                    },
                };
            },
        },
        baseUrl: 'https://mobile-source.example.test',
        allowedHosts: ['mobile-source.example.test'],
        token: 'test-token',
        statePath,
    });
    await assert.rejects(() => service.pullOnce(), /fuel offers invalid/);
    assert.equal(insertCalls, 0);
    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).cursor, 70);
    fs.rmSync(root, { recursive: true, force: true });
});
