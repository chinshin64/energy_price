'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { createMobileSourceNodeApp } = require('../mobile-source-node');
const { MobileSourceNodeService } = require('../services/mobile-source-node-service');

class MemorySourceStore {
    constructor() {
        this.batches = new Map();
        this.records = [];
    }

    async health() { return true; }

    async ingest(batch) {
        const existing = this.batches.get(batch.idempotencyKey);
        if (existing) return { ...existing, duplicate: true };
        const acceptedQuoteCount = batch.stations.reduce(
            (total, station) => total + (station.fuelQuotes?.length || 0),
            0
        );
        const fuelIndexes = batch.stations
            .map((station, index) => station.stationType === 'fuel' ? this.records.length + index + 1 : null)
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
            firstSourceRecordId: this.records.length + 1,
            lastSourceRecordId: this.records.length + batch.stations.length,
            firstFuelSourceRecordId: fuelIndexes[0] || null,
            lastFuelSourceRecordId: fuelIndexes.at(-1) || null,
        };
        this.batches.set(batch.idempotencyKey, result);
        for (const station of batch.stations) {
            this.records.push({
                sourceRecordId: this.records.length + 1,
                ingestId: batch.ingestId,
                sourceNode: '47-mysql',
                sourceAgent: batch.sourceAgent,
                platform: batch.platform,
                city: batch.city,
                capturedAt: batch.capturedAt.toISOString(),
                ...station,
            });
        }
        return result;
    }

    async listAfter(afterId, limit) {
        this.lastListArgs = { afterId, limit };
        return this.records.filter(record => record.sourceRecordId > afterId).slice(0, limit);
    }
}

async function withServer(run, serviceOptions = {}) {
    const store = new MemorySourceStore();
    const service = new MobileSourceNodeService({ store, ...serviceOptions });
    const app = createMobileSourceNodeApp({
        service,
        mobileToken: 'mobile-secret',
        sourceSyncToken: 'sync-secret',
        requireAuth: true,
    });
    const server = await new Promise(resolve => {
        const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    try {
        const address = server.address();
        await run({ baseUrl: `http://127.0.0.1:${address.port}`, store });
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
}

function payload() {
    return {
        sourceAgent: 'android-agent',
        platform: 'didi-charging',
        city: '西安',
        deviceId: 'device-1',
        deviceSessionId: 'device-session-1',
        sessionId: 'session-1',
        pageIndex: 3,
        sourceStage: 'phone-auto-scroll',
        capturedAt: '2026-07-21T07:00:00.000Z',
        stations: [{
            stationName: '小桔充电软件新城站',
            address: '陕西省西安市雁塔区云水一路88号',
            fastIdlePorts: 3,
            fastTotalPorts: 8,
            slowIdlePorts: 1,
            slowTotalPorts: 2,
            priceFast: 0.85,
            priceSlow: 0.62,
            capturedAt: '2026-07-21T06:58:30.000Z',
        }],
    };
}

function fuelPayload() {
    return {
        schemaVersion: 2,
        stationType: 'fuel',
        sourceAgent: 'android-agent',
        platform: 'tuanyou',
        city: '杭州',
        deviceSessionId: 'device-session-fuel',
        sessionId: 'fuel-session-policy',
        pageIndex: 1,
        capturedAt: '2026-07-23T03:30:00.000Z',
        observations: [{
            schemaVersion: 2,
            stationType: 'fuel',
            fuelObservation: {
                stationName: '浙江石油测试加油站',
                capturedAt: '2026-07-23T03:29:59.000Z',
                raw: { sourceType: 'mobile-ocr' },
                fuelOffers: [{
                    fuelType: 'gasoline',
                    gradeCode: '92',
                    gradeLabel: '92#',
                    listPrice: 7.4,
                    discountPrice: 7.1234,
                    unclassifiedPrice: null,
                    discountKind: 'explicit',
                    currency: 'CNY',
                    unit: 'CNY_PER_LITER',
                    evidence: [{ kind: 'discount-price' }],
                    capturedAt: '2026-07-23T03:29:59.000Z',
                }],
            },
        }],
    };
}

function fuelQuotePayload() {
    const body = fuelPayload();
    body.feature = 'fuel-quote-v1';
    body.platform = 'amap-fuel';
    body.sessionId = 'fuel-quote-session';
    const fuel = body.observations[0].fuelObservation;
    fuel.platform = 'amap-fuel';
    fuel.city = '杭州';
    fuel.sourceStationKey = 'amap-fuel:station-1';
    fuel.providerName = '团油';
    fuel.providerEvidence = {
        kind: 'provider-attribution',
        text: '本次由服务商 团油 提供',
        confidence: 0.98,
        boundingBox: { x: 0.1, y: 0.8, width: 0.5, height: 0.05 },
    };
    Object.assign(fuel.fuelOffers[0], {
        displayPrice: '6.6300',
        stationPrice: '7.8600',
        nationalPrice: '8.1200',
        fieldSource: {
            displayPrice: 'ocr',
            stationPrice: 'ocr',
            nationalPrice: 'ocr',
        },
    });
    const quote = {
        quoteObservationId: 'quote-observation-0001',
        quoteDedupKey: '',
        gradeCode: '92',
        gradeLabel: '92#汽油',
        gunCode: '6',
        gunLabel: '6号枪',
        selectedAmount: '200.00',
        grossDiscount: '20.65',
        serviceFee: '3.30',
        netDiscount: '17.35',
        payableAmount: '182.65',
        quoteEntry: 'inline',
        capturedAt: '2026-07-23T03:29:59.000Z',
        raw: { evidence: '预计实付182.65元' },
    };
    fuel.fuelQuotes = [quote];
    refreshQuoteDedupKey(body);
    return body;
}

function refreshQuoteDedupKey(body) {
    const fuel = body.observations[0].fuelObservation;
    const quote = fuel.fuelQuotes[0];
    const offer = fuel.fuelOffers.find(item => item.gradeCode === quote.gradeCode);
    const price = value => value === null || value === undefined ? '' : Number(value).toFixed(4);
    const minor = value => value === null || value === undefined
        ? ''
        : String(Math.round(Number(value) * 100));
    quote.quoteDedupKey = crypto.createHash('sha256').update([
        '2',
        body.platform,
        fuel.sourceStationKey,
        quote.gradeCode,
        quote.gunCode || '',
        minor(quote.selectedAmount),
        quote.capturedAt,
        price(offer?.displayPrice),
        price(offer?.stationPrice),
        price(offer?.nationalPrice),
        minor(quote.grossDiscount),
        minor(quote.serviceFee),
        minor(quote.payableAmount),
        fuel.providerName || '',
    ].join('|')).digest('hex');
}

test('47 source node commits station batch and returns durable acknowledgement', async () => {
    await withServer(async ({ baseUrl, store }) => {
        const request = () => fetch(`${baseUrl}/api/mobile-sync/stations`, {
            method: 'POST',
            headers: {
                Authorization: 'Bearer mobile-secret',
                'Content-Type': 'application/json',
                'X-Mobile-Agent': 'android-agent',
                'Idempotency-Key': 'android-agent:device-1:session-1:3:phone-auto-scroll',
            },
            body: JSON.stringify(payload()),
        });
        const first = await request();
        const firstBody = await first.json();
        assert.equal(first.status, 201);
        assert.equal(firstBody.data.persisted, true);
        assert.equal(firstBody.data.sourceNode, '47-mysql');
        assert.equal(firstBody.data.acceptedCount, 1);
        assert.equal(firstBody.data.firstSourceRecordId, 1);
        assert.equal(firstBody.data.lastSourceRecordId, 1);
        assert.equal(store.records[0].availablePorts, 4);
        assert.equal(store.records[0].totalPorts, 10);
        assert.equal(store.records[0].capturedAt.toISOString(), '2026-07-21T06:58:30.000Z');

        const repeated = await request();
        const repeatedBody = await repeated.json();
        assert.equal(repeated.status, 200);
        assert.equal(repeatedBody.data.duplicate, true);
        assert.equal(repeatedBody.data.ingestId, firstBody.data.ingestId);
        assert.equal(store.records.length, 1);
    });
});

test('47 source node protects ingest and source export with separate tokens', async () => {
    await withServer(async ({ baseUrl }) => {
        const unauthorized = await fetch(`${baseUrl}/api/mobile-sync/stations`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload()),
        });
        assert.equal(unauthorized.status, 401);

        const wrongAgent = await fetch(`${baseUrl}/api/mobile-sync/stations`, {
            method: 'POST',
            headers: {
                Authorization: 'Bearer mobile-secret',
                'Content-Type': 'application/json',
                'X-Mobile-Agent': 'ios-agent',
            },
            body: JSON.stringify(payload()),
        });
        assert.equal(wrongAgent.status, 400);

        const exportUnauthorized = await fetch(`${baseUrl}/api/source-sync/stations?afterId=0`);
        assert.equal(exportUnauthorized.status, 401);
        const exported = await fetch(`${baseUrl}/api/source-sync/stations?afterId=0`, {
            headers: { Authorization: 'Bearer sync-secret' },
        });
        assert.equal(exported.status, 200);
    });
});

test('47 source export returns an authorized empty page with bounded cursor parameters', async () => {
    await withServer(async ({ baseUrl, store }) => {
        const response = await fetch(
            `${baseUrl}/api/source-sync/stations?afterId=37&limit=125`,
            { headers: { Authorization: 'Bearer sync-secret' } }
        );
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.data.afterId, 37);
        assert.equal(body.data.nextCursor, 37);
        assert.equal(body.data.count, 0);
        assert.deepEqual(body.data.records, []);
        assert.deepEqual(store.lastListArgs, { afterId: 37, limit: 125 });
    });
});

test('47 source node rejects impossible idle and total port counts', async () => {
    await withServer(async ({ baseUrl }) => {
        const invalid = payload();
        invalid.stations[0].fastIdlePorts = 9;
        const response = await fetch(`${baseUrl}/api/mobile-sync/stations`, {
            method: 'POST',
            headers: {
                Authorization: 'Bearer mobile-secret',
                'Content-Type': 'application/json',
                'X-Mobile-Agent': 'android-agent',
            },
            body: JSON.stringify(invalid),
        });
        assert.equal(response.status, 400);
        assert.equal((await response.json()).code, 'mobile_source_ports_invalid');
    });
});

test('47 source node scopes supplied idempotency keys by city and platform', async () => {
    await withServer(async ({ baseUrl, store }) => {
        const send = body => fetch(`${baseUrl}/api/mobile-sync/stations`, {
            method: 'POST',
            headers: {
                Authorization: 'Bearer mobile-secret',
                'Content-Type': 'application/json',
                'X-Mobile-Agent': 'android-agent',
                'Idempotency-Key': 'same-client-key',
            },
            body: JSON.stringify(body),
        });
        const xian = await send(payload());
        const wuhanPayload = payload();
        wuhanPayload.city = '武汉';
        const wuhan = await send(wuhanPayload);

        assert.equal(xian.status, 201);
        assert.equal(wuhan.status, 201);
        assert.equal(store.records.length, 2);
    });
});

test('47 source node requires and scopes device session and idempotency key', async () => {
    await withServer(async ({ baseUrl, store }) => {
        const send = (body, idempotencyKey) => fetch(`${baseUrl}/api/mobile-sync/stations`, {
            method: 'POST',
            headers: {
                Authorization: 'Bearer mobile-secret',
                'Content-Type': 'application/json',
                'X-Mobile-Agent': 'android-agent',
                ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
            },
            body: JSON.stringify(body),
        });
        const missingSession = payload();
        delete missingSession.deviceSessionId;
        assert.equal((await send(missingSession, 'required-key')).status, 400);
        assert.equal((await send(payload(), '')).status, 400);

        const first = payload();
        first.deviceSessionId = 'device-session-a';
        const second = payload();
        second.deviceSessionId = 'device-session-b';
        assert.equal((await send(first, 'same-client-key')).status, 201);
        assert.equal((await send(second, 'same-client-key')).status, 201);
        assert.equal(store.records.length, 2);
    });
});

test('47 source node rejects oversized per-station raw extensions', async () => {
    await withServer(async ({ baseUrl }) => {
        const invalid = payload();
        invalid.stations[0].raw = { debug: 'x'.repeat(70 * 1024) };
        const response = await fetch(`${baseUrl}/api/mobile-sync/stations`, {
            method: 'POST',
            headers: {
                Authorization: 'Bearer mobile-secret',
                'Content-Type': 'application/json',
                'X-Mobile-Agent': 'android-agent',
            },
            body: JSON.stringify(invalid),
        });
        assert.equal(response.status, 413);
        assert.equal((await response.json()).code, 'mobile_source_raw_too_large');
    });
});

test('47 source node advertises v2 fuel capability and accepts exclusive fuel observations', async () => {
    await withServer(async ({ baseUrl, store }) => {
        const health = await (await fetch(`${baseUrl}/health`)).json();
        assert.equal(health.data.capabilities.schemaVersion, 2);
        assert.deepEqual(health.data.capabilities.stationTypes, ['charging', 'fuel']);

        const body = {
            schemaVersion: 2,
            stationType: 'fuel',
            sourceAgent: 'android-agent',
            platform: 'tuanyou',
            city: '杭州',
            deviceSessionId: 'fuel-device-session-1',
            sessionId: 'fuel-session-1',
            pageIndex: 1,
            capturedAt: '2026-07-23T03:30:00.000Z',
            observations: [{
                schemaVersion: 2,
                stationType: 'fuel',
                fuelObservation: {
                    stationName: '浙江石油测试加油站',
                    capturedAt: '2026-07-23T03:29:59.000Z',
                    fuelOffers: [{
                        fuelType: 'gasoline',
                        gradeCode: '92',
                        gradeLabel: '92#',
                        listPrice: 7.4,
                        discountPrice: 7.1,
                        unclassifiedPrice: null,
                        discountKind: 'explicit',
                        currency: 'CNY',
                        unit: 'CNY_PER_LITER',
                        evidence: [{ kind: 'discount-price' }],
                        capturedAt: '2026-07-23T03:29:59.000Z',
                    }],
                },
            }],
        };
        const response = await fetch(`${baseUrl}/api/mobile-sync/stations`, {
            method: 'POST',
            headers: {
                Authorization: 'Bearer mobile-secret',
                'Content-Type': 'application/json',
                'X-Mobile-Agent': 'android-agent',
                'Idempotency-Key': 'fuel-exclusive-1',
            },
            body: JSON.stringify(body),
        });
        assert.equal(response.status, 201);
        assert.equal(store.records.length, 1);
        assert.equal(store.records[0].stationType, 'fuel');
        assert.equal(store.records[0].fuelOffers[0].gradeCode, '92');
        assert.equal(store.records[0].address, null);
        assert.equal(store.records[0].totalPorts, 0);
    });
});

test('API v3 accepts Android charging golden payload and preserves nullable station fields', async () => {
    await withServer(async ({ baseUrl, store }) => {
        const body = {
            schemaVersion: 3,
            stationType: 'charging',
            sourceAgent: 'android-ocr-agent',
            platform: 'didi-charging',
            city: '西安',
            deviceSessionId: 'android-device-session-v3',
            sessionId: 'android-session-v3',
            capturedAt: '2026-07-24T01:00:00.000Z',
            observations: [{
                schemaVersion: 3,
                stationType: 'charging',
                stationObservation: {
                    sourceStationKey: 'didi:xian:001',
                    stationName: '小桔充电高新站',
                    address: '陕西省西安市高新区测试路1号',
                    availablePorts: null,
                    busyPorts: null,
                    totalPorts: null,
                    portSemantics: 'charging-gun',
                    capturedAt: '2026-07-24T00:59:00.000Z',
                    quality: {
                        status: 'incomplete',
                        needsReview: true,
                        missingFields: ['availablePorts', 'busyPorts', 'totalPorts'],
                    },
                },
                chargingObservation: {
                    priceFast: 0.85,
                    priceSlow: null,
                    priceSuper: null,
                    priceService: 0.2,
                    fastIdlePorts: null,
                    fastTotalPorts: null,
                    sourceStage: 'phone-user-scroll',
                    raw: { extraction: 'ocr' },
                },
            }],
        };
        const response = await fetch(`${baseUrl}/api/mobile-sync/stations`, {
            method: 'POST',
            headers: {
                Authorization: 'Bearer mobile-secret',
                'Content-Type': 'application/json',
                'X-Mobile-Agent': 'android-ocr-agent',
                'Idempotency-Key': 'android-v3-golden',
            },
            body: JSON.stringify(body),
        });
        assert.equal(response.status, 201);
        assert.equal(store.records[0].address, body.observations[0].stationObservation.address);
        assert.equal(store.records[0].availablePorts, null);
        assert.equal(store.records[0].busyPorts, null);
        assert.equal(store.records[0].totalPorts, null);
        assert.equal(store.records[0].sourceAgent, 'android-ocr-agent');
        assert.equal(store.records[0].qualityStatus, 'incomplete');
        assert.ok(store.records[0].missingFields.includes('priceSlow'));
    });
});

test('API v3 rejects sensitive station name or address without echoing the original value', async () => {
    await withServer(async ({ baseUrl, store }) => {
        const baseBody = () => ({
            schemaVersion: 3,
            stationType: 'charging',
            sourceAgent: 'android-ocr-agent',
            platform: 'didi-charging',
            city: '西安',
            deviceSessionId: 'android-sensitive-device-v3',
            sessionId: 'android-sensitive-session-v3',
            capturedAt: '2026-07-24T01:10:00.000Z',
            observations: [{
                schemaVersion: 3,
                stationType: 'charging',
                stationObservation: {
                    stationName: '小桔充电科技二路站',
                    address: '陕西省西安市高新区科技二路88号A座',
                    availablePorts: 4,
                    busyPorts: 2,
                    totalPorts: 6,
                    capturedAt: '2026-07-24T01:09:00.000Z',
                    quality: { status: 'valid', needsReview: false, missingFields: [] },
                },
                chargingObservation: {
                    priceFast: '0.85',
                    priceSlow: null,
                    priceSuper: null,
                    priceService: '0.10',
                },
            }],
        });
        const send = (body, key) => fetch(`${baseUrl}/api/mobile-sync/stations`, {
            method: 'POST',
            headers: {
                Authorization: 'Bearer mobile-secret',
                'Content-Type': 'application/json',
                'X-Mobile-Agent': body.sourceAgent,
                'Idempotency-Key': key,
            },
            body: JSON.stringify(body),
        });
        const cases = [
            ['stationName', `测试充电站 手机号：${'138'}${'0000'}${'0000'}`],
            ['stationName', '测试站 账号=user_20260724'],
            ['address', `陕西省西安市测试路8号 身份证号 ${'110105'}${'19491231'}${'002X'}`],
            ['address', `湖北省武汉市测试大道5号 银行卡号 ${'622202'}${'020202'}${'0202020'}`],
            ['address', '浙江省杭州市测试街6号 订单号 ORDER123456'],
            ['address', '四川省成都市测试路7号 验证码 9527'],
            ['address', '广东省深圳市测试路9号 支付密码 123456'],
        ];
        for (const [index, [field, sensitiveValue]] of cases.entries()) {
            const body = baseBody();
            body.sessionId = `sensitive-common-${field}-${index}`;
            body.observations[0].stationObservation[field] = sensitiveValue;
            const response = await send(body, `sensitive-common-${field}-${index}`);
            assert.equal(response.status, 400, field);
            const responseBody = await response.json();
            assert.equal(responseBody.code, 'mobile_source_sensitive_data_forbidden', field);
            assert.equal(JSON.stringify(responseBody).includes(sensitiveValue), false, field);
        }
        assert.equal(store.records.length, 0);
        assert.equal(store.batches.size, 0);
    });
});

test('API v3 sensitive-text guard preserves ordinary station names and numeric addresses', async () => {
    await withServer(async ({ baseUrl, store }) => {
        const body = {
            schemaVersion: 3,
            stationType: 'charging',
            sourceAgent: 'android-ocr-agent',
            platform: 'didi-charging',
            city: '西安',
            deviceSessionId: 'ordinary-address-device-v3',
            sessionId: 'ordinary-address-session-v3',
            capturedAt: '2026-07-24T01:20:00.000Z',
            observations: [{
                schemaVersion: 3,
                stationType: 'charging',
                stationObservation: {
                    stationName: 'G30高速92号能源充电站',
                    address: '陕西省西安市高新区科技二路88号A座地下2层95号车位',
                    availablePorts: 4,
                    busyPorts: 2,
                    totalPorts: 6,
                    capturedAt: '2026-07-24T01:19:00.000Z',
                    quality: { status: 'valid', needsReview: false, missingFields: [] },
                },
                chargingObservation: {
                    priceFast: '0.85',
                    priceSlow: null,
                    priceSuper: null,
                    priceService: '0.10',
                },
            }],
        };
        const response = await fetch(`${baseUrl}/api/mobile-sync/stations`, {
            method: 'POST',
            headers: {
                Authorization: 'Bearer mobile-secret',
                'Content-Type': 'application/json',
                'X-Mobile-Agent': body.sourceAgent,
                'Idempotency-Key': 'ordinary-numeric-address-v3',
            },
            body: JSON.stringify(body),
        });
        assert.equal(response.status, 201);
        assert.equal(store.records.length, 1);
        assert.equal(store.records[0].stationName, body.observations[0].stationObservation.stationName);
        assert.equal(store.records[0].address, body.observations[0].stationObservation.address);
    });
});

test('API v3 accepts iOS fuel golden payload with public address and no gun data', async () => {
    await withServer(async ({ baseUrl, store }) => {
        const body = {
            schemaVersion: 3,
            stationType: 'fuel',
            sourceAgent: 'ios-ocr-agent',
            platform: 'tuanyou',
            city: '武汉',
            deviceSessionId: 'ios-device-session-v3',
            sessionId: 'ios-session-v3',
            capturedAt: '2026-07-24T02:00:00.000Z',
            observations: [{
                schemaVersion: 3,
                stationType: 'fuel',
                stationObservation: {
                    stationId: 'tuanyou:wuhan:001',
                    stationName: '团油武汉测试站',
                    address: '湖北省武汉市测试大道2号',
                    capturedAt: '2026-07-24T01:59:00.000Z',
                    quality: { status: 'valid', missingFields: [] },
                },
                fuelObservation: {
                    fuelOffers: [{
                        fuelType: 'gasoline',
                        gradeCode: '92',
                        gradeLabel: '92#',
                        listPrice: 7.4,
                        discountPrice: 7.1,
                        discountKind: 'explicit',
                        currency: 'CNY',
                        unit: 'CNY_PER_LITER',
                        evidence: [{ kind: 'discount-price' }],
                    }],
                    raw: { extraction: 'ocr' },
                },
            }],
        };
        const response = await fetch(`${baseUrl}/api/mobile-sync/stations`, {
            method: 'POST',
            headers: {
                Authorization: 'Bearer mobile-secret',
                'Content-Type': 'application/json',
                'X-Mobile-Agent': 'ios-ocr-agent',
                'Idempotency-Key': 'ios-v3-golden',
            },
            body: JSON.stringify(body),
        });
        assert.equal(response.status, 201);
        const acknowledgement = (await response.json()).data;
        assert.equal(acknowledgement.persisted, true);
        assert.equal(acknowledgement.sourceNode, '47-mysql');
        assert.equal(acknowledgement.sourceAgent, 'ios-ocr-agent');
        assert.equal(acknowledgement.acceptedCount, 1);
        assert.equal(acknowledgement.acceptedStationCount, 1);
        assert.equal(acknowledgement.firstSourceRecordId, 1);
        assert.equal(acknowledgement.lastSourceRecordId, 1);
        assert.equal(store.records[0].stationType, 'fuel');
        assert.equal(store.records[0].address, body.observations[0].stationObservation.address);
        // 燃油侧无枪数据，ports/portSemantics 一律为 null。
        assert.equal(store.records[0].availablePorts, null);
        assert.equal(store.records[0].busyPorts, null);
        assert.equal(store.records[0].totalPorts, null);
        assert.equal(store.records[0].portSemantics, null);
        assert.equal(store.records[0].sourceAgent, 'ios-ocr-agent');
    });
});

test('ingress rejects Header/body agent mismatch before durable storage', async () => {
    await withServer(async ({ baseUrl, store }) => {
        const body = payload();
        body.sourceAgent = 'android-ocr-agent';
        const response = await fetch(`${baseUrl}/api/mobile-sync/stations`, {
            method: 'POST',
            headers: {
                Authorization: 'Bearer mobile-secret',
                'Content-Type': 'application/json',
                'X-Mobile-Agent': 'ios-ocr-agent',
                'Idempotency-Key': 'agent-mismatch-v3',
            },
            body: JSON.stringify(body),
        });
        assert.equal(response.status, 400);
        assert.equal((await response.json()).code, 'mobile_source_agent_mismatch');
        assert.equal(store.records.length, 0);
    });
});

test('47 source node rejects mixed fuel and charging fields', async () => {
    await withServer(async ({ baseUrl }) => {
        const body = {
            schemaVersion: 2,
            stationType: 'fuel',
            sourceAgent: 'android-agent',
            platform: 'tuanyou',
            city: '杭州',
            deviceSessionId: 'fuel-device-session-invalid',
            sessionId: 'fuel-session-invalid',
            capturedAt: '2026-07-23T03:30:00.000Z',
            observations: [{
                schemaVersion: 2,
                stationType: 'fuel',
                fuelObservation: {
                    stationName: '测试加油站',
                    totalPorts: 2,
                    fuelOffers: [],
                },
            }],
        };
        const response = await fetch(`${baseUrl}/api/mobile-sync/stations`, {
            method: 'POST',
            headers: {
                Authorization: 'Bearer mobile-secret',
                'Content-Type': 'application/json',
                'X-Mobile-Agent': 'android-agent',
                'Idempotency-Key': 'fuel-invalid-mixed',
            },
            body: JSON.stringify(body),
        });
        assert.equal(response.status, 400);
        assert.equal((await response.json()).code, 'mobile_source_fuel_field_forbidden');
    });
});

test('47 source node rejects unknown schema versions while keeping v1 charging compatible', async () => {
    await withServer(async ({ baseUrl }) => {
        const unknown = payload();
        unknown.schemaVersion = 4;
        const rejected = await fetch(`${baseUrl}/api/mobile-sync/stations`, {
            method: 'POST',
            headers: {
                Authorization: 'Bearer mobile-secret',
                'Content-Type': 'application/json',
                'X-Mobile-Agent': 'android-agent',
                'Idempotency-Key': 'schema-unknown',
            },
            body: JSON.stringify(unknown),
        });
        assert.equal(rejected.status, 400);
        assert.equal((await rejected.json()).code, 'mobile_source_schema_version_invalid');

        const legacy = payload();
        legacy.schemaVersion = 1;
        const accepted = await fetch(`${baseUrl}/api/mobile-sync/stations`, {
            method: 'POST',
            headers: {
                Authorization: 'Bearer mobile-secret',
                'Content-Type': 'application/json',
                'X-Mobile-Agent': 'android-agent',
                'Idempotency-Key': 'schema-v1-compatible',
            },
            body: JSON.stringify(legacy),
        });
        assert.equal(accepted.status, 201);
    });
});

test('47 source node rejects every charging field at fuel top-level and nested raw', async () => {
    const forbidden = [
        'priceFast', 'priceSlow', 'priceSuper', 'priceService',
        'availablePorts', 'totalPorts', 'busyPorts',
        'onlineFast', 'onlineSlow', 'onlineSuper',
        'onlineFastPorts', 'onlineSlowPorts', 'onlineSuperPorts',
        'fastIdlePorts', 'fastAvailablePorts', 'fastTotalPorts', 'fastBusyPorts',
        'slowIdlePorts', 'slowAvailablePorts', 'slowTotalPorts', 'slowBusyPorts',
        'superIdlePorts', 'superAvailablePorts', 'superTotalPorts', 'superBusyPorts',
        'fast_available_ports', 'slow_total_ports', 'super_busy_guns',
    ];
    await withServer(async ({ baseUrl }) => {
        for (const [index, key] of forbidden.entries()) {
            const body = fuelPayload();
            body.sessionId = `fuel-forbidden-top-${index}`;
            body.observations[0][key] = 1;
            const top = await fetch(`${baseUrl}/api/mobile-sync/stations`, {
                method: 'POST',
                headers: {
                    Authorization: 'Bearer mobile-secret',
                    'Content-Type': 'application/json',
                    'X-Mobile-Agent': 'android-agent',
                },
                body: JSON.stringify(body),
            });
            assert.equal(top.status, 400, `top-level ${key}`);
            assert.equal((await top.json()).code, 'mobile_source_fuel_field_forbidden');

            const nestedBody = fuelPayload();
            nestedBody.sessionId = `fuel-forbidden-raw-${index}`;
            nestedBody.observations[0].fuelObservation.raw = { nested: { [key]: 1 } };
            const nested = await fetch(`${baseUrl}/api/mobile-sync/stations`, {
                method: 'POST',
                headers: {
                    Authorization: 'Bearer mobile-secret',
                    'Content-Type': 'application/json',
                    'X-Mobile-Agent': 'android-agent',
                },
                body: JSON.stringify(nestedBody),
            });
            assert.equal(nested.status, 400, `raw ${key}`);
            assert.equal((await nested.json()).code, 'mobile_source_fuel_field_forbidden');
        }
    });
});

test('47 source node accepts four fuel decimals and rejects higher precision or scientific notation', async () => {
    await withServer(async ({ baseUrl }) => {
        const send = body => fetch(`${baseUrl}/api/mobile-sync/stations`, {
            method: 'POST',
            headers: {
                Authorization: 'Bearer mobile-secret',
                'Content-Type': 'application/json',
                'X-Mobile-Agent': 'android-agent',
                'Idempotency-Key': `fuel-price-${body.sessionId}`,
            },
            body: JSON.stringify(body),
        });
        assert.equal((await send(fuelPayload())).status, 201);

        const tooPrecise = fuelPayload();
        tooPrecise.sessionId = 'fuel-too-precise';
        tooPrecise.observations[0].fuelObservation.fuelOffers[0].discountPrice = 7.12345;
        const rejectedPrecision = await send(tooPrecise);
        assert.equal(rejectedPrecision.status, 400);
        assert.equal((await rejectedPrecision.json()).code, 'mobile_source_fuel_price_invalid');

        const scientific = fuelPayload();
        scientific.sessionId = 'fuel-scientific';
        scientific.observations[0].fuelObservation.fuelOffers[0].discountPrice = '7.1e0';
        const rejectedScientific = await send(scientific);
        assert.equal(rejectedScientific.status, 400);
        assert.equal((await rejectedScientific.json()).code, 'mobile_source_fuel_price_invalid');
    });
});

test('legacy fuel payload may carry empty v1 projection fields while capability is disabled', async () => {
    await withServer(async ({ baseUrl }) => {
        const body = fuelPayload();
        body.sessionId = 'fuel-empty-v1-projection-fields';
        const fuel = body.observations[0].fuelObservation;
        fuel.providerName = null;
        fuel.providerEvidence = null;
        fuel.fuelQuotes = [];
        Object.assign(fuel.fuelOffers[0], {
            displayPrice: null,
            stationPrice: null,
            nationalPrice: null,
            fieldSource: {},
        });
        const response = await fetch(`${baseUrl}/api/mobile-sync/stations`, {
            method: 'POST',
            headers: {
                Authorization: 'Bearer mobile-secret',
                'Content-Type': 'application/json',
                'X-Mobile-Agent': 'android-agent',
                'Idempotency-Key': 'fuel-empty-v1-projection-fields',
            },
            body: JSON.stringify(body),
        });
        assert.equal(response.status, 201);
    });
});

test('fuel-quote-v1 capability is advertised but defaults to disabled', async () => {
    await withServer(async ({ baseUrl }) => {
        const health = await (await fetch(`${baseUrl}/health`)).json();
        assert.deepEqual(health.data.capabilities.features['fuel-quote-v1'], {
            enabled: false,
            platforms: ['tuanyou', 'amap-fuel'],
            captureMode: 'user-driven-ocr',
            maxOffersPerStation: 8,
            maxQuotesPerObservation: 128,
        });
        const response = await fetch(`${baseUrl}/api/mobile-sync/stations`, {
            method: 'POST',
            headers: {
                Authorization: 'Bearer mobile-secret',
                'Content-Type': 'application/json',
                'X-Mobile-Agent': 'android-agent',
                'Idempotency-Key': 'fuel-quote-disabled',
            },
            body: JSON.stringify(fuelQuotePayload()),
        });
        assert.equal(response.status, 409);
        assert.equal((await response.json()).code, 'mobile_source_feature_disabled');
    });
});

test('enabled fuel-quote-v1 normalizes CP evidence, three prices, quotes and exact ACK counts', async () => {
    await withServer(async ({ baseUrl, store }) => {
        const health = await (await fetch(`${baseUrl}/health`)).json();
        assert.equal(health.data.capabilities.schemaVersion, 2);
        assert.equal(health.data.capabilities.features['fuel-quote-v1'].enabled, true);
        const response = await fetch(`${baseUrl}/api/mobile-sync/stations`, {
            method: 'POST',
            headers: {
                Authorization: 'Bearer mobile-secret',
                'Content-Type': 'application/json',
                'X-Mobile-Agent': 'android-agent',
                'Idempotency-Key': 'fuel-quote-enabled',
            },
            body: JSON.stringify(fuelQuotePayload()),
        });
        const result = await response.json();
        assert.equal(response.status, 201);
        assert.equal(result.data.acceptedCount, 1);
        assert.equal(result.data.acceptedStationCount, 1);
        assert.equal(result.data.acceptedQuoteCount, 1);
        assert.equal(result.data.firstFuelSourceRecordId, 1);
        assert.equal(result.data.lastFuelSourceRecordId, 1);
        assert.equal(store.records[0].providerName, '团油');
        assert.equal(store.records[0].providerEvidence.text, '本次由服务商 团油 提供');
        assert.equal(
            Object.prototype.hasOwnProperty.call(store.records[0].raw, 'providerEvidence'),
            false
        );
        assert.deepEqual(
            store.records[0].raw.fuelObservation.providerEvidence,
            store.records[0].providerEvidence
        );
        assert.equal(store.records[0].sourceStationKey, 'amap-fuel:station-1');
        assert.equal(store.records[0].fuelOffers[0].displayPrice, 6.63);
        assert.equal(store.records[0].fuelOffers[0].stationPrice, 7.86);
        assert.equal(store.records[0].fuelOffers[0].nationalPrice, 8.12);
        assert.deepEqual(store.records[0].fuelOffers[0].fieldSource, {
            displayPrice: 'ocr',
            stationPrice: 'ocr',
            nationalPrice: 'ocr',
        });
        assert.equal(store.records[0].fuelQuotes[0].selectedAmount, '200.00');
        assert.equal(store.records[0].fuelQuotes[0].netDiscount, '17.35');
        assert.equal(store.records[0].fuelQuotes[0].needsReview, false);

        const exported = await fetch(
            `${baseUrl}/api/source-sync/stations?afterId=0&limit=1`,
            { headers: { Authorization: 'Bearer sync-secret' } }
        );
        const record = (await exported.json()).data.records[0];
        assert.equal(record.providerName, '团油');
        assert.equal(record.providerEvidence.text, '本次由服务商 团油 提供');
        assert.equal(record.fuelOffers.length, 1);
        assert.equal(record.fuelQuotes.length, 1);
    }, { fuelQuoteV1Enabled: true });
});

test('fuel-quote-v1 rejects extensions without feature, unlisted platforms and missing CP evidence', async () => {
    await withServer(async ({ baseUrl }) => {
        const send = async (body, key) => fetch(`${baseUrl}/api/mobile-sync/stations`, {
            method: 'POST',
            headers: {
                Authorization: 'Bearer mobile-secret',
                'Content-Type': 'application/json',
                'X-Mobile-Agent': 'android-agent',
                'Idempotency-Key': key,
            },
            body: JSON.stringify(body),
        });

        const noFeature = fuelQuotePayload();
        delete noFeature.feature;
        let response = await send(noFeature, 'fuel-quote-feature-required');
        assert.equal(response.status, 400);
        assert.equal((await response.json()).code, 'mobile_source_feature_required');

        const wrongPlatform = fuelQuotePayload();
        wrongPlatform.platform = 'generic-fuel-test';
        wrongPlatform.observations[0].fuelObservation.platform = 'generic-fuel-test';
        response = await send(wrongPlatform, 'fuel-quote-platform-disabled');
        assert.equal(response.status, 409);
        assert.equal((await response.json()).code, 'mobile_source_feature_disabled');

        const noEvidence = fuelQuotePayload();
        delete noEvidence.observations[0].fuelObservation.providerEvidence;
        response = await send(noEvidence, 'fuel-quote-provider-evidence-required');
        assert.equal(response.status, 400);
        assert.equal((await response.json()).code, 'mobile_source_provider_evidence_required');
    }, { fuelQuoteV1Enabled: true });
});

test('fuel-quote-v1 rejects unknown fields instead of acknowledging and dropping them', async () => {
    await withServer(async ({ baseUrl }) => {
        const send = body => fetch(`${baseUrl}/api/mobile-sync/stations`, {
            method: 'POST',
            headers: {
                Authorization: 'Bearer mobile-secret',
                'Content-Type': 'application/json',
                'X-Mobile-Agent': 'android-agent',
                'Idempotency-Key': `strict-${Math.random()}`,
            },
            body: JSON.stringify(body),
        });
        for (const mutate of [
            body => { body.observations[0].fuelObservation.unknownProvider = 'x'; },
            body => { body.observations[0].fuelObservation.fuelOffers[0].providerName = '团油'; },
            body => { body.observations[0].fuelObservation.fuelQuotes[0].paidAmount = '182.65'; },
            body => { body.observations[0].fuelObservation.providerEvidence.ocrLine = '团油'; },
        ]) {
            const body = fuelQuotePayload();
            mutate(body);
            const response = await send(body);
            assert.equal(response.status, 400);
            assert.equal((await response.json()).code, 'mobile_source_field_unknown');
        }
    }, { fuelQuoteV1Enabled: true });
});

test('47 ingress rejects sensitive raw and evidence before invoking durable storage', async () => {
    await withServer(async ({ baseUrl, store }) => {
        const send = (body, key) => fetch(`${baseUrl}/api/mobile-sync/stations`, {
            method: 'POST',
            headers: {
                Authorization: 'Bearer mobile-secret',
                'Content-Type': 'application/json',
                'X-Mobile-Agent': body.sourceAgent,
                'Idempotency-Key': key,
            },
            body: JSON.stringify(body),
        });
        const cases = [];

        const chargingRaw = payload();
        chargingRaw.sessionId = 'sensitive-charging-raw';
        chargingRaw.stations[0].raw = { nested: { authorization: 'Bearer secret-value' } };
        cases.push(['sensitive-charging-raw', chargingRaw]);

        const stationRaw = fuelQuotePayload();
        stationRaw.sessionId = 'sensitive-fuel-station-raw';
        stationRaw.observations[0].fuelObservation.raw.orderNo = 'ORDER-123456';
        cases.push(['sensitive-fuel-station-raw', stationRaw]);

        const providerEvidence = fuelQuotePayload();
        providerEvidence.sessionId = 'sensitive-provider-evidence';
        providerEvidence.observations[0].fuelObservation.providerEvidence.text =
            '服务商团油，订单号:ORDER123456';
        cases.push(['sensitive-provider-evidence', providerEvidence]);

        const offerEvidence = fuelQuotePayload();
        offerEvidence.sessionId = 'sensitive-offer-evidence';
        offerEvidence.observations[0].fuelObservation.fuelOffers[0].evidence = [{
            kind: 'display-price',
            text: 'token=secret-value',
        }];
        cases.push(['sensitive-offer-evidence', offerEvidence]);

        const quoteRaw = fuelQuotePayload();
        quoteRaw.sessionId = 'sensitive-quote-raw';
        quoteRaw.observations[0].fuelObservation.fuelQuotes[0].raw = {
            evidence: 'Cookie: session=secret-value',
        };
        cases.push(['sensitive-quote-raw', quoteRaw]);

        for (const [key, body] of cases) {
            const response = await send(body, key);
            assert.equal(response.status, 400, key);
            assert.equal(
                (await response.json()).code,
                'mobile_source_sensitive_data_forbidden',
                key
            );
        }
        assert.equal(store.records.length, 0);
        assert.equal(store.batches.size, 0);
    }, { fuelQuoteV1Enabled: true });
});

test('47 ingress keeps bounded offer and provider evidence while rejecting evidence extensions', async () => {
    await withServer(async ({ baseUrl, store }) => {
        const valid = fuelQuotePayload();
        valid.sessionId = 'bounded-evidence-valid';
        valid.observations[0].fuelObservation.fuelOffers[0].evidence = [{
            kind: 'display-price',
            text: '外显价6.63元/升',
            confidence: 0.97,
            boundingBox: { x: 0.1, y: 0.2, width: 0.3, height: 0.04 },
        }];
        const accepted = await fetch(`${baseUrl}/api/mobile-sync/stations`, {
            method: 'POST',
            headers: {
                Authorization: 'Bearer mobile-secret',
                'Content-Type': 'application/json',
                'X-Mobile-Agent': 'android-agent',
                'Idempotency-Key': 'bounded-evidence-valid',
            },
            body: JSON.stringify(valid),
        });
        assert.equal(accepted.status, 201);
        assert.deepEqual(store.records[0].fuelOffers[0].evidence[0], {
            kind: 'display-price',
            text: '外显价6.63元/升',
            confidence: 0.97,
            boundingBox: { x: 0.1, y: 0.2, width: 0.3, height: 0.04 },
        });
        assert.equal(
            store.records[0].providerEvidence.kind,
            'provider-attribution'
        );

        const duplicate = fuelQuotePayload();
        duplicate.sessionId = 'bounded-evidence-duplicate';
        duplicate.observations[0].fuelObservation.raw = {
            fuelObservation: {
                providerEvidence: {
                    kind: 'provider-attribution',
                    text: '不得从 raw 重复提交',
                },
            },
        };
        const duplicateResponse = await fetch(`${baseUrl}/api/mobile-sync/stations`, {
            method: 'POST',
            headers: {
                Authorization: 'Bearer mobile-secret',
                'Content-Type': 'application/json',
                'X-Mobile-Agent': 'android-agent',
                'Idempotency-Key': 'bounded-evidence-duplicate',
            },
            body: JSON.stringify(duplicate),
        });
        assert.equal(duplicateResponse.status, 400);
        assert.equal(
            (await duplicateResponse.json()).code,
            'mobile_source_field_duplicate'
        );

        const unknown = fuelQuotePayload();
        unknown.sessionId = 'bounded-evidence-unknown';
        unknown.observations[0].fuelObservation.fuelOffers[0].evidence = [{
            kind: 'display-price',
            ocrPayload: 'must-not-be-persisted',
        }];
        const rejected = await fetch(`${baseUrl}/api/mobile-sync/stations`, {
            method: 'POST',
            headers: {
                Authorization: 'Bearer mobile-secret',
                'Content-Type': 'application/json',
                'X-Mobile-Agent': 'android-agent',
                'Idempotency-Key': 'bounded-evidence-unknown',
            },
            body: JSON.stringify(unknown),
        });
        assert.equal(rejected.status, 400);
        assert.equal((await rejected.json()).code, 'mobile_source_field_unknown');
        assert.equal(store.records.length, 1);
    }, { fuelQuoteV1Enabled: true });
});

test('fuel quote keeps observed money and marks inconsistent formulas for review', async () => {
    await withServer(async ({ baseUrl, store }) => {
        const body = fuelQuotePayload();
        body.observations[0].fuelObservation.fuelQuotes[0].payableAmount = '180.00';
        refreshQuoteDedupKey(body);
        const response = await fetch(`${baseUrl}/api/mobile-sync/stations`, {
            method: 'POST',
            headers: {
                Authorization: 'Bearer mobile-secret',
                'Content-Type': 'application/json',
                'X-Mobile-Agent': 'android-agent',
                'Idempotency-Key': 'fuel-quote-review',
            },
            body: JSON.stringify(body),
        });
        assert.equal(response.status, 201);
        assert.equal(store.records[0].fuelQuotes[0].payableAmount, '180.00');
        assert.equal(store.records[0].fuelQuotes[0].needsReview, true);
    }, { fuelQuoteV1Enabled: true });
});

test('fuel-quote-v1 accepts a quote-only observation and derives review state server-side', async () => {
    await withServer(async ({ baseUrl, store }) => {
        const body = fuelQuotePayload();
        const fuel = body.observations[0].fuelObservation;
        fuel.fuelOffers = [];
        fuel.fuelQuotes[0].serviceFee = null;
        fuel.fuelQuotes[0].netDiscount = null;
        refreshQuoteDedupKey(body);
        const response = await fetch(`${baseUrl}/api/mobile-sync/stations`, {
            method: 'POST',
            headers: {
                Authorization: 'Bearer mobile-secret',
                'Content-Type': 'application/json',
                'X-Mobile-Agent': 'android-agent',
                'Idempotency-Key': 'fuel-quote-only',
            },
            body: JSON.stringify(body),
        });
        assert.equal(response.status, 201);
        assert.equal(store.records[0].fuelOffers.length, 0);
        assert.equal(store.records[0].fuelQuotes.length, 1);
        assert.equal(store.records[0].fuelQuotes[0].needsReview, true);
    }, { fuelQuoteV1Enabled: true });
});

test('fuel-quote-v1 rejects malformed role prices, quote bounds and unknown batch fields', async () => {
    await withServer(async ({ baseUrl }) => {
        const send = body => fetch(`${baseUrl}/api/mobile-sync/stations`, {
            method: 'POST',
            headers: {
                Authorization: 'Bearer mobile-secret',
                'Content-Type': 'application/json',
                'X-Mobile-Agent': 'android-agent',
                'Idempotency-Key': `invalid-${Math.random()}`,
            },
            body: JSON.stringify(body),
        });

        const precision = fuelQuotePayload();
        precision.observations[0].fuelObservation.fuelOffers[0].displayPrice = '6.63001';
        let response = await send(precision);
        assert.equal(response.status, 400);
        assert.equal((await response.json()).code, 'mobile_source_fuel_price_invalid');

        const amount = fuelQuotePayload();
        amount.observations[0].fuelObservation.fuelQuotes[0].selectedAmount = '100000.01';
        response = await send(amount);
        assert.equal(response.status, 400);
        assert.equal((await response.json()).code, 'mobile_source_fuel_quote_invalid');

        const dedup = fuelQuotePayload();
        dedup.observations[0].fuelObservation.fuelQuotes[0].quoteDedupKey = 'f'.repeat(64);
        response = await send(dedup);
        assert.equal(response.status, 400);
        assert.equal((await response.json()).code, 'mobile_source_quote_dedup_mismatch');

        const unknownBatch = fuelQuotePayload();
        unknownBatch.callbackUrl = 'https://example.invalid';
        response = await send(unknownBatch);
        assert.equal(response.status, 400);
        assert.equal((await response.json()).code, 'mobile_source_field_unknown');
    }, { fuelQuoteV1Enabled: true });
});
