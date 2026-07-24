'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-source-e2e-'));
process.env.DATABASE_PATH = path.join(tempDir, 'main-product.db');
process.env.DATA_ROOT = path.join(tempDir, 'data');

const db = require('../database/init');
const StationModel = require('../models/station');
const { createMobileSourceNodeApp } = require('../mobile-source-node');
const { MobileSourceNodeService } = require('../services/mobile-source-node-service');
const { RemoteMobileSourceSync } = require('../services/remote-mobile-source-sync');

class DurableContractStore {
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

        const acknowledgement = {
            ingestId: batch.ingestId,
            idempotencyKey: batch.idempotencyKey,
            sourceNode: '47-mysql',
            sourceAgent: batch.sourceAgent,
            persisted: true,
            duplicate: false,
            acceptedCount: batch.stations.length,
            firstSourceRecordId: this.records.length + 1,
            lastSourceRecordId: this.records.length + batch.stations.length,
        };
        this.batches.set(batch.idempotencyKey, acknowledgement);
        batch.stations.forEach((station, recordIndex) => {
            this.records.push({
                ...station,
                sourceRecordId: this.records.length + 1,
                ingestId: batch.ingestId,
                recordIndex,
                sourceNode: '47-mysql',
                sourceAgent: batch.sourceAgent,
                sourceType: 'mobile-ocr',
                sourceStage: station.sourceStage || batch.sourceStage,
                platform: batch.platform,
                city: batch.city,
                capturedAt: batch.capturedAt.toISOString(),
            });
        });
        return acknowledgement;
    }

    async listAfter(afterId, limit) {
        this.lastListArgs = { afterId, limit };
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

test.after(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
});

test('mobile page persists at the 47 contract boundary and incrementally merges into the main product', async () => {
    const store = new DurableContractStore();
    const sourceService = new MobileSourceNodeService({ store });
    const sourceApp = createMobileSourceNodeApp({
        service: sourceService,
        mobileToken: 'mobile-e2e-token',
        sourceSyncToken: 'source-e2e-token',
        requireAuth: true,
    });
    const server = await listen(sourceApp);
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
        const emptyExport = await fetch(
            `${baseUrl}/api/source-sync/stations?afterId=37&limit=125`,
            { headers: { Authorization: 'Bearer source-e2e-token' } }
        );
        assert.equal(emptyExport.status, 200);
        const emptyExportBody = await emptyExport.json();
        assert.deepEqual(emptyExportBody.data, {
            sourceNode: '47-mysql',
            afterId: 37,
            nextCursor: 37,
            count: 0,
            hasMore: false,
            records: [],
        });
        assert.deepEqual(store.lastListArgs, { afterId: 37, limit: 125 });

        const payload = {
            clientVersion: 'android-e2e',
            sourceAgent: 'android-agent',
            platform: 'didi-charging',
            city: '西安',
            deviceId: 'collector-installation-hash',
            deviceSessionId: 'device-session-1',
            sessionId: 'android-session-1',
            pageIndex: 4,
            sourceStage: 'phone-auto-scroll',
            capturedAt: '2026-07-21T09:00:00.000Z',
            stations: [{
                stationId: 'mobile-e2e-station-1',
                stationName: '小桔充电西安软件新城充电站',
                address: '陕西省西安市雁塔区云水一路88号停车场',
                priceFast: 0.85,
                priceSlow: 0.62,
                fastIdlePorts: 3,
                fastTotalPorts: 8,
                slowIdlePorts: 1,
                slowTotalPorts: 2,
            }],
        };
        const sendPage = () => fetch(`${baseUrl}/api/mobile-sync/stations`, {
            method: 'POST',
            headers: {
                Authorization: 'Bearer mobile-e2e-token',
                'Content-Type': 'application/json',
                'X-Mobile-Agent': 'android-agent',
                'Idempotency-Key': 'android-agent:device:session:4:phone-auto-scroll',
            },
            body: JSON.stringify(payload),
        });

        const first = await sendPage();
        const firstBody = await first.json();
        assert.equal(first.status, 201);
        assert.equal(firstBody.data.persisted, true);
        assert.equal(firstBody.data.sourceNode, '47-mysql');

        const repeated = await sendPage();
        const repeatedBody = await repeated.json();
        assert.equal(repeated.status, 200);
        assert.equal(repeatedBody.data.duplicate, true);
        assert.equal(repeatedBody.data.ingestId, firstBody.data.ingestId);
        assert.equal(store.records.length, 1);

        const sync = new RemoteMobileSourceSync({
            stationModel: StationModel,
            baseUrl,
            allowHttp: true,
            allowedHosts: ['127.0.0.1'],
            token: 'source-e2e-token',
            statePath: path.join(tempDir, 'source-cursor.json'),
        });
        const pulled = await sync.pullOnce();
        assert.equal(pulled.cursor, 1);
        assert.equal(pulled.lastFetchedCount, 1);

        const stored = db.prepare(`
            SELECT station_name, address, price_fast, price_slow,
                   available_ports, total_ports, source_type, source_agent,
                   source_node, source_record_id, raw_data
            FROM stations
            WHERE source_node = '47-mysql' AND source_record_id = 1
        `).get();
        assert.equal(stored.station_name, payload.stations[0].stationName);
        assert.equal(stored.address, payload.stations[0].address);
        assert.equal(stored.price_fast, 0.85);
        assert.equal(stored.price_slow, 0.62);
        assert.equal(stored.available_ports, 4);
        assert.equal(stored.total_ports, 10);
        assert.equal(stored.source_type, 'mobile-ocr');
        assert.equal(stored.source_agent, 'android-agent');
        assert.equal(stored.source_node, '47-mysql');
        assert.equal(stored.source_record_id, 1);
        const raw = JSON.parse(stored.raw_data);
        assert.equal(raw.mobileSync.meta.city, '西安');
        assert.equal(raw.mobileSync.meta.ingestId, firstBody.data.ingestId);

        const secondPull = await sync.pullOnce();
        assert.equal(secondPull.cursor, 1);
        assert.equal(secondPull.lastFetchedCount, 0);
        assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM stations WHERE source_node = '47-mysql'`).get().count, 1);
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});

test('main product atomically stores fuel station type, source key and offers JSON', () => {
    const fuelOffers = [{
        fuelType: 'gasoline',
        gradeCode: '95',
        gradeLabel: '95#',
        listPrice: 7.9,
        discountPrice: 7.5,
        unclassifiedPrice: null,
        discountKind: 'explicit',
        currency: 'CNY',
        unit: 'CNY_PER_LITER',
        evidence: [{ kind: 'discount-price' }, { kind: 'list-price' }],
        capturedAt: '2026-07-23T03:29:59.000Z',
        fieldSource: {},
    }];
    const result = StationModel.insertBatch([{
        platform: 'tuanyou',
        stationType: 'fuel',
        sourceStationKey: '47-mysql:1001',
        stationName: '浙江石油测试加油站',
        sourceType: 'mobile-ocr',
        sourceStage: 'screen-ocr-auto-scroll',
        sourceAgent: 'android-ocr-agent',
        sourceNode: '47-mysql',
        sourceRecordId: 1001,
        snapshotMode: 'append',
        capturedAt: '2026-07-23T03:29:59.000Z',
        confidence: 0.95,
        fuelOffers,
        fuelQuotes: [],
        raw: { sourceType: 'mobile-ocr', snapshotMode: 'append' },
    }]);
    assert.equal(result.successCount, 1);
    const stored = db.prepare(`
        SELECT station_type, source_station_key, fuel_offers,
               price_fast, available_ports, busy_ports, total_ports, address
        FROM stations
        WHERE source_node = '47-mysql' AND source_record_id = 1001
    `).get();
    assert.equal(stored.station_type, 'fuel');
    assert.equal(stored.source_station_key, '47-mysql:1001');
    assert.deepEqual(JSON.parse(stored.fuel_offers), fuelOffers);
    assert.equal(stored.price_fast, null);
    assert.equal(stored.available_ports, null);
    assert.equal(stored.busy_ports, null);
    assert.equal(stored.total_ports, null);
    assert.equal(stored.address, null);
});

test('47 listAfter quote-only record reaches Station, confidence and cursor without offers', async () => {
    const store = new DurableContractStore();
    store.records.push({
        sourceRecordId: 2001,
        ingestId: '00000000-0000-4000-8000-000000002001',
        recordIndex: 0,
        sourceNode: '47-mysql',
        sourceAgent: 'android-agent',
        sourceType: 'mobile-ocr',
        sourceStage: 'user-driven-ocr',
        platform: 'amap-fuel',
        city: '西安',
        stationType: 'fuel',
        stationId: 'amap-fuel:quote-only-2001',
        sourceStationKey: 'amap-fuel:quote-only-2001',
        stationName: '高德报价测试加油站',
        capturedAt: '2026-07-23T13:00:00.000Z',
        raw: {},
        providerName: null,
        providerEvidence: null,
        fuelOffers: [],
        fuelQuotes: [{
            quoteObservationId: 'quote-list-after-2001',
            quoteDedupKey: 'c'.repeat(64),
            gradeCode: '95',
            gradeLabel: '95#汽油',
            gunCode: null,
            gunLabel: null,
            selectedAmount: '200.00',
            grossDiscount: '20.65',
            serviceFee: '3.30',
            netDiscount: '17.35',
            payableAmount: '182.65',
            quoteEntry: 'inline',
            needsReview: false,
            capturedAt: '2026-07-23T13:00:00.000Z',
            raw: { evidence: '预计实付182.65元' },
        }],
    });
    const sourceApp = createMobileSourceNodeApp({
        service: new MobileSourceNodeService({ store }),
        mobileToken: 'mobile-e2e-token',
        sourceSyncToken: 'source-e2e-token',
        requireAuth: true,
    });
    const server = await listen(sourceApp);
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const statePath = path.join(tempDir, 'quote-only-source-cursor.json');

    try {
        const exported = await fetch(
            `${baseUrl}/api/source-sync/stations?afterId=0&limit=10`,
            { headers: { Authorization: 'Bearer source-e2e-token' } }
        );
        const exportedBody = await exported.json();
        assert.equal(exported.status, 200);
        assert.equal(exportedBody.data.records[0].fuelOffers.length, 0);
        assert.equal(exportedBody.data.records[0].fuelQuotes.length, 1);

        const sync = new RemoteMobileSourceSync({
            stationModel: StationModel,
            baseUrl,
            allowHttp: true,
            allowedHosts: ['127.0.0.1'],
            token: 'source-e2e-token',
            statePath,
        });
        const pulled = await sync.pullOnce();
        assert.equal(pulled.cursor, 2001);
        assert.equal(pulled.lastDbResult.successCount, 1);
        assert.equal(pulled.lastDbResult.rejectedCount, 0);

        const station = db.prepare(`
            SELECT id, source_station_key, fuel_offers, source_record_id
            FROM stations
            WHERE source_node = '47-mysql' AND source_record_id = 2001
        `).get();
        assert.equal(station.source_station_key, 'amap-fuel:quote-only-2001');
        assert.equal(station.fuel_offers, null);
        assert.equal(
            db.prepare('SELECT COUNT(*) AS count FROM fuel_offers WHERE station_id = ?')
                .get(station.id).count,
            0
        );
        const quote = db.prepare(`
            SELECT quote_observation_id, payable_amount, raw_data
            FROM fuel_quotes
            WHERE station_id = ?
        `).get(station.id);
        assert.equal(quote.quote_observation_id, 'quote-list-after-2001');
        assert.equal(quote.payable_amount, '182.65');
        assert.equal(JSON.parse(quote.raw_data).evidence, '预计实付182.65元');
        assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).cursor, 2001);
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});

test('47 listAfter rich offer evidence passes remote sync and is stored without field loss', async () => {
    const store = new DurableContractStore();
    const evidence = {
        kind: 'display-price',
        text: '外显价6.63元/升',
        format: 'currency-per-liter',
        type: 'ocr-row',
        confidence: 0.97,
        boundingBox: { x: 0.1, y: 0.2, width: 0.3, height: 0.04 },
    };
    store.records.push({
        sourceRecordId: 2002,
        ingestId: '00000000-0000-4000-8000-000000002002',
        recordIndex: 0,
        sourceNode: '47-mysql',
        sourceAgent: 'android-agent',
        sourceType: 'mobile-ocr',
        sourceStage: 'user-driven-ocr',
        platform: 'amap-fuel',
        city: '西安',
        stationType: 'fuel',
        stationId: 'amap-fuel:rich-evidence-2002',
        sourceStationKey: 'amap-fuel:rich-evidence-2002',
        stationName: '高德富证据测试加油站',
        capturedAt: '2026-07-23T13:10:00.000Z',
        raw: {},
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
            evidence: [evidence],
            capturedAt: '2026-07-23T13:10:00.000Z',
        }],
        fuelQuotes: [],
    });
    const sourceApp = createMobileSourceNodeApp({
        service: new MobileSourceNodeService({ store }),
        mobileToken: 'mobile-e2e-token',
        sourceSyncToken: 'source-e2e-token',
        requireAuth: true,
    });
    const server = await listen(sourceApp);
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const statePath = path.join(tempDir, 'rich-evidence-source-cursor.json');

    try {
        const sync = new RemoteMobileSourceSync({
            stationModel: StationModel,
            baseUrl,
            allowHttp: true,
            allowedHosts: ['127.0.0.1'],
            token: 'source-e2e-token',
            statePath,
        });
        const pulled = await sync.pullOnce();
        assert.equal(pulled.cursor, 2002);
        assert.equal(pulled.lastDbResult.successCount, 1);

        const station = db.prepare(`
            SELECT id
            FROM stations
            WHERE source_node = '47-mysql' AND source_record_id = 2002
        `).get();
        const offer = db.prepare(`
            SELECT evidence
            FROM fuel_offers
            WHERE station_id = ?
        `).get(station.id);
        assert.deepEqual(JSON.parse(offer.evidence), [evidence]);
        assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).cursor, 2002);
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});
