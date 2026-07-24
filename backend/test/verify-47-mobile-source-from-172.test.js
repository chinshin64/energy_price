'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const { createMobileSourceNodeApp } = require('../mobile-source-node');
const { MobileSourceNodeService } = require('../services/mobile-source-node-service');
const {
    EXECUTION_IP_ALLOWLIST_ENV,
    assertExecutionNode,
    buildAndroidChargingV3Case,
    buildIosFuelV3Case,
    buildVerificationCases,
    ingestAndReadBack,
    loadSerializedClientFixtures,
    mergeIntoTemporaryProduct,
    quoteDedupKey,
    runVerification,
    sourceOrigin,
    verifySerializedClientFixtures,
} = require('../../scripts/verify-47-mobile-source-from-172');

class VerificationStore {
    constructor() {
        this.batches = new Map();
        this.records = [];
    }

    async health() {
        return true;
    }

    async ingest(batch) {
        const existing = this.batches.get(batch.idempotencyKey);
        if (existing) return { ...existing, duplicate: true };
        const firstSourceRecordId = this.records.length + 1;
        const acceptedQuoteCount = batch.stations.reduce(
            (total, station) => total + (station.fuelQuotes?.length || 0),
            0
        );
        const fuelRecordIds = batch.stations
            .map((station, index) => (
                station.stationType === 'fuel' ? firstSourceRecordId + index : null
            ))
            .filter(Boolean);
        const result = {
            ingestId: batch.ingestId,
            idempotencyKey: batch.idempotencyKey,
            sourceNode: '47-mysql',
            sourceAgent: batch.sourceAgent,
            persisted: true,
            duplicate: false,
            acceptedCount: batch.stations.length,
            acceptedStationCount: batch.stations.length,
            acceptedQuoteCount,
            firstSourceRecordId,
            lastSourceRecordId: firstSourceRecordId + batch.stations.length - 1,
            firstFuelSourceRecordId: fuelRecordIds[0] || null,
            lastFuelSourceRecordId: fuelRecordIds.at(-1) || null,
        };
        this.batches.set(batch.idempotencyKey, result);
        for (const [recordIndex, station] of batch.stations.entries()) {
            const common = {
                sourceRecordId: this.records.length + 1,
                ingestId: batch.ingestId,
                recordIndex,
                sourceNode: '47-mysql',
                sourceAgent: batch.sourceAgent,
                sourceType: 'mobile-ocr',
                sourceStage: station.sourceStage || batch.sourceStage,
                platform: batch.platform,
                city: batch.city,
                capturedAt: (station.capturedAt || batch.capturedAt).toISOString(),
                address: station.address ?? null,
                availablePorts: station.availablePorts ?? null,
                busyPorts: station.busyPorts ?? null,
                totalPorts: station.totalPorts ?? null,
                portSemantics: station.portSemantics ?? null,
                missingFields: station.missingFields || [],
                qualityStatus: station.qualityStatus ?? null,
                needsReview: station.needsReview === true,
                raw: station.raw || {},
            };
            this.records.push(station.stationType === 'fuel'
                ? {
                    ...common,
                    stationType: 'fuel',
                    stationId: station.stationId,
                    sourceStationKey: station.sourceStationKey,
                    stationName: station.stationName,
                    providerName: station.providerName,
                    providerEvidence: station.providerEvidence,
                    fuelOffers: station.fuelOffers,
                    fuelQuotes: station.fuelQuotes,
                }
                : { ...common, ...station });
        }
        return result;
    }

    async listAfter(afterId, limit) {
        return this.records
            .filter(record => record.sourceRecordId > afterId)
            .slice(0, limit);
    }
}

async function listen(app) {
    return new Promise(resolve => {
        const server = app.listen(0, '127.0.0.1', () => resolve(server));
    });
}

test('execution node allowlist defaults to deny and only accepts explicitly listed private 172 nodes', () => {
    assert.throws(
        () => assertExecutionNode(['172.28.170.239'], {}),
        new RegExp(`${EXECUTION_IP_ALLOWLIST_ENV} is required`)
    );
    assert.throws(
        () => assertExecutionNode(
            ['172.28.170.239'],
            { [EXECUTION_IP_ALLOWLIST_ENV]: '203.0.113.10' }
        ),
        /private 172\.16\.0\.0\/12/
    );
    assert.throws(
        () => assertExecutionNode(
            ['172.28.170.239'],
            { [EXECUTION_IP_ALLOWLIST_ENV]: '172.23.25.54' }
        ),
        /no local address matches/
    );
    assert.equal(
        assertExecutionNode(
            ['172.28.170.239'],
            { [EXECUTION_IP_ALLOWLIST_ENV]: '172.28.170.239,172.23.25.54' }
        ),
        '172.28.170.239'
    );
    assert.equal(
        assertExecutionNode(
            ['172.23.25.54'],
            { [EXECUTION_IP_ALLOWLIST_ENV]: '172.28.170.239,172.23.25.54' }
        ),
        '172.23.25.54'
    );
});

test('source origin is pinned to TLS on the dedicated 47 port', () => {
    assert.equal(sourceOrigin({}), 'https://47.111.139.230:50080');
    assert.equal(
        sourceOrigin({ MOBILE_SOURCE_BASE_URL: 'https://47.111.139.230:50080' }),
        'https://47.111.139.230:50080'
    );
    for (const invalid of [
        'http://47.111.139.230:50080',
        'https://47.111.139.230',
        'https://47.111.139.230:443',
        'https://user:password@47.111.139.230:50080',
        'https://47.111.139.230:50080/api',
        'https://47.111.139.230:50080/?token=value',
    ]) {
        assert.throws(
            () => sourceOrigin({ MOBILE_SOURCE_BASE_URL: invalid }),
            /must be https:\/\/47\.111\.139\.230:50080/
        );
    }
});

test('fuel verification payloads contain the v3 quote contract and share a cross-entry dedup seed', () => {
    const capturedAt = '2026-07-24T12:00:00.000Z';
    const cases = buildVerificationCases('unit-1', capturedAt);
    assert.deepEqual(
        cases.map(item => item.key),
        ['legacy-charging', 'android-charging-v3', 'amap-fuel', 'tuanyou']
    );
    assert.ok(cases.every(item => item.sourceAgent === 'verification-agent'));
    assert.ok(cases.every(item => item.payload.sourceAgent === 'verification-agent'));
    assert.equal(cases[0].schemaVersion, 1);
    const android = cases[1];
    assert.equal(android.payload.schemaVersion, 3);
    assert.equal(android.payload.observations[0].schemaVersion, 3);
    assert.equal(android.stationObservation.address, '陕西省西安市高新区移动端验收路3号');
    assert.equal(android.stationObservation.availablePorts, null);
    assert.equal(android.stationObservation.busyPorts, null);
    assert.equal(android.stationObservation.totalPorts, null);
    assert.equal(android.stationObservation.portSemantics, 'charging-gun');
    assert.deepEqual(
        android.stationObservation.quality.missingFields,
        ['availablePorts', 'busyPorts', 'totalPorts']
    );
    assert.equal(android.chargingObservation.priceFast, '0.8500');
    assert.equal(android.chargingObservation.priceSlow, '0.6200');

    const amap = cases[2];
    assert.equal(amap.payload.schemaVersion, 3);
    assert.equal(amap.payload.observations[0].schemaVersion, 3);
    assert.equal(amap.payload.feature, 'fuel-quote-v1');
    assert.equal(amap.providerName, '团油');
    assert.equal(amap.stationObservation.address, '湖北省武汉市验收数据隔离大道5号');
    // 燃油侧无枪数据：stationObservation 不携带 ports/portSemantics。
    assert.equal(amap.stationObservation.availablePorts, undefined);
    assert.equal(amap.stationObservation.busyPorts, undefined);
    assert.equal(amap.stationObservation.totalPorts, undefined);
    assert.equal(amap.stationObservation.portSemantics, undefined);
    assert.deepEqual(
        [
            amap.offer.displayPrice,
            amap.offer.stationPrice,
            amap.offer.nationalPrice,
        ],
        ['6.0800', '6.7800', '7.7300']
    );
    assert.deepEqual(
        [
            amap.quote.selectedAmount,
            amap.quote.grossDiscount,
            amap.quote.serviceFee,
            amap.quote.netDiscount,
            amap.quote.payableAmount,
        ],
        ['200.00', '20.65', '3.30', '17.35', '182.65']
    );

    const tuanyou = cases[3];
    const sameQuoteFromInlineEntry = {
        ...tuanyou.quote,
        quoteEntry: 'inline',
    };
    assert.equal(
        quoteDedupKey({
            platform: tuanyou.payload.platform,
            sourceStationKey: tuanyou.sourceStationKey,
            providerName: tuanyou.providerName,
            offer: tuanyou.offer,
            quote: sameQuoteFromInlineEntry,
        }),
        tuanyou.quote.quoteDedupKey
    );
    assert.equal(tuanyou.quote.quoteEntry, 'explanation_popup');
    assert.equal(JSON.stringify(cases).includes('MYSQL_PASSWORD'), false);
    assert.equal(JSON.stringify(cases).includes('MOBILE_SOURCE_INGEST_TOKEN'), false);
});

test('offline verifier validates legacy charging plus v3 Android/iOS source round trips', async () => {
    const store = new VerificationStore();
    const service = new MobileSourceNodeService({
        store,
        fuelQuoteV1Enabled: true,
        fuelQuotePlatforms: ['tuanyou', 'amap-fuel'],
    });
    const app = createMobileSourceNodeApp({
        service,
        mobileToken: 'test-ingest-token',
        sourceSyncToken: 'test-sync-token',
        requireAuth: true,
    });
    const server = await listen(app);
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    try {
        const result = await runVerification({
            baseUrl,
            sourceHost: '127.0.0.1',
            executionNode: '172.23.25.54',
            ingestToken: 'test-ingest-token',
            syncToken: 'test-sync-token',
            unique: 'offline-integration-1',
            capturedAt: '2026-07-24T12:00:00.000Z',
        });
        assert.deepEqual(result, {
            success: true,
            executionNode: '172.23.25.54',
            sourceNode: '47-mysql',
            legacyChargingSourceRecordId: 1,
            androidChargingV3SourceRecordId: 2,
            iosAmapFuelV3SourceRecordId: 3,
            iosTuanyouFuelV3SourceRecordId: 4,
            duplicateRetryVerified: true,
            legacyChargingCompatibilityVerified: true,
            schemaVersion3Verified: true,
            fuelQuoteFeatureVerified: true,
            sourceSyncRoundTripVerified: true,
            localSqliteV8MergeVerified: true,
            tuanyouExplanationEntryVerified: true,
        });
        assert.equal(store.batches.size, 4);
        assert.equal(store.records.length, 4);
        assert.equal(store.records[1].address, '陕西省西安市高新区移动端验收路3号');
        assert.equal(store.records[1].availablePorts, null);
        assert.equal(store.records[1].priceFast, 0.85);
        assert.equal(store.records[2].providerName, '团油');
        assert.equal(store.records[2].address, '湖北省武汉市验收数据隔离大道5号');
        // 燃油侧无枪数据：amap-fuel record 不携带 availablePorts（null 占位）。
        assert.equal(store.records[2].availablePorts, null);
        assert.equal(store.records[2].fuelOffers.length, 1);
        assert.equal(store.records[2].fuelQuotes.length, 1);
        assert.equal(store.records[3].fuelQuotes[0].quoteEntry, 'explanation_popup');
        assert.ok(store.records.every(record => record.sourceAgent === 'verification-agent'));
        const serializedResult = JSON.stringify(result);
        assert.equal(serializedResult.includes('test-ingest-token'), false);
        assert.equal(serializedResult.includes('test-sync-token'), false);
        assert.equal(serializedResult.includes('fuelOffers'), false);
        assert.equal(serializedResult.includes('fuelQuotes'), false);
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});

test('local contract persists android-ocr-agent and ios-ocr-agent v3 fields into SQLite v8', async () => {
    const store = new VerificationStore();
    const service = new MobileSourceNodeService({
        store,
        fuelQuoteV1Enabled: true,
        fuelQuotePlatforms: ['tuanyou', 'amap-fuel'],
    });
    const app = createMobileSourceNodeApp({
        service,
        mobileToken: 'local-contract-ingest-token',
        sourceSyncToken: 'local-contract-sync-token',
        requireAuth: true,
    });
    const server = await listen(app);
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const capturedAt = '2026-07-24T13:00:00.000Z';
    const android = buildAndroidChargingV3Case(
        'local-agent-contract',
        capturedAt,
        'android-ocr-agent'
    );
    const ios = buildIosFuelV3Case('local-agent-contract', capturedAt, {
        platform: 'tuanyou',
        stationLabel: 'iOS OCR v3本地契约加油站',
        providerName: null,
        providerText: null,
        gradeCode: '92',
        gradeLabel: '92#汽油',
        gunCode: '5',
        gunLabel: '5号枪',
        displayPrice: '6.8500',
        stationPrice: '7.1500',
        nationalPrice: '7.3500',
        grossDiscount: '8.39',
        serviceFee: '1.34',
        netDiscount: '7.05',
        payableAmount: '192.95',
        quoteEntry: 'inline',
        sourceAgent: 'ios-ocr-agent',
    });
    try {
        const results = [];
        for (const verificationCase of [android, ios]) {
            results.push(await ingestAndReadBack({
                baseUrl,
                ingestToken: 'local-contract-ingest-token',
                syncToken: 'local-contract-sync-token',
                verificationCase,
            }));
        }
        await mergeIntoTemporaryProduct({
            baseUrl,
            sourceHost: '127.0.0.1',
            syncToken: 'local-contract-sync-token',
            results,
        });
        assert.equal(store.records[0].sourceAgent, 'android-ocr-agent');
        assert.equal(store.records[0].address, android.stationObservation.address);
        assert.equal(store.records[0].availablePorts, null);
        assert.equal(store.records[0].priceFast, 0.85);
        assert.equal(store.records[1].sourceAgent, 'ios-ocr-agent');
        assert.equal(store.records[1].address, ios.stationObservation.address);
        // 燃油侧无枪数据：ios-ocr-agent 燃油 record 不携带 ports（null 占位）。
        assert.equal(store.records[1].availablePorts, null);
        assert.equal(store.records[1].busyPorts, null);
        assert.equal(store.records[1].totalPorts, null);
        assert.equal(Number(store.records[1].fuelOffers[0].displayPrice), 6.85);
        assert.equal(Number(store.records[1].fuelOffers[0].stationPrice), 7.15);
        assert.equal(Number(store.records[1].fuelOffers[0].nationalPrice), 7.35);
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});

test('production Android Java and iOS Swift serializers feed the strict Node v3 contract', {
    timeout: 10 * 60 * 1000,
}, () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-production-contract-test-'));
    const output = path.join(tempRoot, 'mobile-client-fixtures.json');
    try {
        const generator = path.join(
            __dirname,
            '../scripts/generate-mobile-client-contract-fixtures.js'
        );
        const generated = spawnSync(process.execPath, [generator, '--output', output], {
            cwd: path.resolve(__dirname, '../..'),
            encoding: 'utf8',
            maxBuffer: 16 * 1024 * 1024,
        });
        assert.equal(
            generated.status,
            0,
            [generated.stderr, generated.stdout].filter(Boolean).join('\n')
        );
        const fixtures = loadSerializedClientFixtures([output]);
        assert.deepEqual(
            fixtures.map(item => item.serializer).sort(),
            ['android-production-java', 'ios-product-swift']
        );
        const service = new MobileSourceNodeService({
            store: new VerificationStore(),
            fuelQuoteV1Enabled: true,
            fuelQuotePlatforms: ['tuanyou', 'amap-fuel'],
        });
        const results = verifySerializedClientFixtures(service, [output]);
        const android = results.find(item => item.serializer === 'android-production-java');
        const ios = results.find(item => item.serializer === 'ios-product-swift');
        assert.equal(android.sourceAgent, 'android-ocr-agent');
        assert.equal(android.stationType, 'charging');
        assert.equal(android.normalized.stations[0].address, '陕西省西安市高新区科技二路88号A座');
        assert.equal(android.normalized.stations[0].availablePorts, 4);
        assert.equal(android.normalized.stations[0].busyPorts, 6);
        assert.equal(android.normalized.stations[0].totalPorts, 10);
        assert.equal(android.normalized.stations[0].priceFast, 0.85);

        assert.equal(ios.sourceAgent, 'ios-ocr-agent');
        assert.equal(ios.stationType, 'fuel');
        assert.equal(ios.normalized.stations[0].address, '湖北省武汉市江岸区测试大道5号');
        // 燃油侧无枪数据：iOS 燃油 fixture 序列化后 stationObservation 不携带 ports（null 占位）。
        assert.equal(ios.normalized.stations[0].availablePorts, null);
        assert.equal(ios.normalized.stations[0].busyPorts, null);
        assert.equal(ios.normalized.stations[0].totalPorts, null);
        assert.equal(ios.normalized.stations[0].fuelOffers[0].displayPrice, 6.85);
        assert.equal(ios.normalized.stations[0].fuelOffers[0].stationPrice, 7.15);
        assert.equal(ios.normalized.stations[0].fuelOffers[0].nationalPrice, 7.35);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('serialized client fixture loader fails closed on untrusted serializer identity', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-contract-identity-test-'));
    const output = path.join(tempRoot, 'forged-client-fixture.json');
    try {
        fs.writeFileSync(output, JSON.stringify({
            serializer: 'ios-product-swift',
            sourceAgent: 'android-ocr-agent',
            idempotencyKey: 'a'.repeat(64),
            payload: {
                schemaVersion: 3,
                sourceAgent: 'android-ocr-agent',
            },
        }), { encoding: 'utf8', mode: 0o600 });
        assert.throws(
            () => loadSerializedClientFixtures([output]),
            /serializer\/sourceAgent is invalid/
        );
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});
