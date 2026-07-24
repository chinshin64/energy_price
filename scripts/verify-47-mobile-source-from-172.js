#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const EXPECTED_SOURCE_HOST = '47.111.139.230';
const EXPECTED_SOURCE_PORT = '50080';
const EXECUTION_IP_ALLOWLIST_ENV = 'MOBILE_SOURCE_VERIFIER_EXECUTION_IP_ALLOWLIST';
const FUEL_QUOTE_FEATURE = 'fuel-quote-v1';
const REQUIRED_FUEL_PLATFORMS = Object.freeze(['tuanyou', 'amap-fuel']);
const CLIENT_SERIALIZER_AGENTS = Object.freeze({
    'android-production-java': 'android-ocr-agent',
    'ios-product-swift': 'ios-ocr-agent',
});
const MAX_CLIENT_FIXTURE_BYTES = 1024 * 1024;
const MAX_CLIENT_FIXTURES = 8;

function localAddresses() {
    return Object.values(os.networkInterfaces())
        .flatMap(entries => entries || [])
        .filter(entry => !entry.internal)
        .map(entry => entry.address);
}

function requiredEnv(name, env = process.env) {
    const value = String(env[name] || '').trim();
    if (!value) throw new Error(`${name} is required`);
    return value;
}

function isControlled172Address(value) {
    if (net.isIP(value) !== 4) return false;
    const octets = value.split('.').map(Number);
    return octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31;
}

function executionIpAllowlist(env = process.env) {
    const raw = requiredEnv(EXECUTION_IP_ALLOWLIST_ENV, env);
    const values = [...new Set(raw.split(',').map(value => value.trim()).filter(Boolean))];
    if (values.length === 0 || values.length > 8 || values.some(value => !isControlled172Address(value))) {
        throw new Error(
            `${EXECUTION_IP_ALLOWLIST_ENV} must contain 1-8 explicit private 172.16.0.0/12 IPv4 addresses`
        );
    }
    return values;
}

function assertExecutionNode(addresses = localAddresses(), env = process.env) {
    const allowlist = executionIpAllowlist(env);
    const local = new Set(addresses.filter(address => net.isIP(address) === 4));
    const executionIp = allowlist.find(address => local.has(address));
    if (!executionIp) {
        throw new Error(
            `refusing external-link verification: no local address matches ${EXECUTION_IP_ALLOWLIST_ENV}`
        );
    }
    return executionIp;
}

function sourceOrigin(env = process.env) {
    const raw = String(
        env.MOBILE_SOURCE_BASE_URL || `https://${EXPECTED_SOURCE_HOST}:${EXPECTED_SOURCE_PORT}`
    ).trim();
    const url = new URL(raw);
    if (url.protocol !== 'https:'
            || url.hostname !== EXPECTED_SOURCE_HOST
            || url.port !== EXPECTED_SOURCE_PORT
            || url.username
            || url.password
            || url.pathname !== '/'
            || url.search
            || url.hash) {
        throw new Error(
            `MOBILE_SOURCE_BASE_URL must be https://${EXPECTED_SOURCE_HOST}:${EXPECTED_SOURCE_PORT}`
        );
    }
    return url.toString().replace(/\/$/, '');
}

function loadSerializedClientFixtures(fixturePaths) {
    if (!Array.isArray(fixturePaths)
            || fixturePaths.length === 0
            || fixturePaths.length > MAX_CLIENT_FIXTURES) {
        throw new Error(`1-${MAX_CLIENT_FIXTURES} mobile client fixture files are required`);
    }
    const fixtures = [];
    for (const filePath of fixturePaths) {
        const resolved = path.resolve(String(filePath || ''));
        const stat = fs.statSync(resolved);
        if (!stat.isFile() || stat.size < 2 || stat.size > MAX_CLIENT_FIXTURE_BYTES) {
            throw new Error('mobile client fixture file has an invalid size');
        }
        const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
        const rows = Array.isArray(parsed) ? parsed : [parsed];
        if (fixtures.length + rows.length > MAX_CLIENT_FIXTURES) {
            throw new Error(`mobile client fixtures exceed ${MAX_CLIENT_FIXTURES} records`);
        }
        fixtures.push(...rows);
    }
    return fixtures.map((fixture, index) => {
        if (!fixture || typeof fixture !== 'object' || Array.isArray(fixture)) {
            throw new Error(`mobile client fixture[${index}] must be an object`);
        }
        const unknown = Object.keys(fixture).filter(key => ![
            'serializer', 'sourceAgent', 'idempotencyKey', 'payload',
        ].includes(key));
        if (unknown.length > 0) {
            throw new Error(`mobile client fixture[${index}] contains unknown fields`);
        }
        const serializer = String(fixture.serializer || '').trim();
        const expectedAgent = CLIENT_SERIALIZER_AGENTS[serializer];
        const sourceAgent = String(fixture.sourceAgent || '').trim();
        const idempotencyKey = String(fixture.idempotencyKey || '').trim().toLowerCase();
        if (!expectedAgent || sourceAgent !== expectedAgent) {
            throw new Error(`mobile client fixture[${index}] serializer/sourceAgent is invalid`);
        }
        if (!/^[a-f0-9]{64}$/.test(idempotencyKey)) {
            throw new Error(`mobile client fixture[${index}] idempotencyKey is invalid`);
        }
        if (!fixture.payload || typeof fixture.payload !== 'object' || Array.isArray(fixture.payload)) {
            throw new Error(`mobile client fixture[${index}] payload must be an object`);
        }
        if (fixture.payload.sourceAgent !== sourceAgent || Number(fixture.payload.schemaVersion) !== 3) {
            throw new Error(`mobile client fixture[${index}] payload identity is invalid`);
        }
        return { serializer, sourceAgent, idempotencyKey, payload: fixture.payload };
    });
}

function verifySerializedClientFixtures(service, fixturePaths) {
    if (!service || typeof service.normalizeBatch !== 'function') {
        throw new TypeError('strict mobile source service is required');
    }
    return loadSerializedClientFixtures(fixturePaths).map(fixture => {
        const normalized = service.normalizeBatch(fixture.payload, {
            mobileAgent: fixture.sourceAgent,
            idempotencyKey: fixture.idempotencyKey,
            remoteAddress: '127.0.0.1',
            userAgent: `offline-contract/${fixture.serializer}`,
        });
        assert.equal(normalized.schemaVersion, 3);
        assert.equal(normalized.sourceAgent, fixture.sourceAgent);
        assert.ok(normalized.stations.length > 0);
        return {
            serializer: fixture.serializer,
            sourceAgent: normalized.sourceAgent,
            stationType: normalized.stationType,
            acceptedCount: normalized.stations.length,
            normalized,
        };
    });
}

async function requestJson(url, options = {}, fetchImpl = globalThis.fetch) {
    const response = await fetchImpl(url, {
        ...options,
        signal: options.signal || AbortSignal.timeout(20000),
    });
    const text = await response.text();
    let body;
    try {
        body = JSON.parse(text);
    } catch (error) {
        throw new Error(`non-JSON response from ${new URL(url).pathname} (HTTP ${response.status})`);
    }
    if (!response.ok || !body.success) {
        throw new Error(`${body.code || 'source_request_failed'} at ${new URL(url).pathname} (HTTP ${response.status})`);
    }
    return { status: response.status, body };
}

function moneyMinor(value) {
    if (value === null || value === undefined || value === '') return '';
    return String(Math.round(Number(value) * 100));
}

function priceFixed(value) {
    if (value === null || value === undefined || value === '') return '';
    return Number(value).toFixed(4);
}

function quoteDedupKey({ platform, sourceStationKey, providerName, offer, quote }) {
    const seed = [
        '2',
        platform,
        sourceStationKey,
        quote.gradeCode,
        quote.gunCode || '',
        moneyMinor(quote.selectedAmount),
        new Date(quote.capturedAt).toISOString(),
        priceFixed(offer?.displayPrice),
        priceFixed(offer?.stationPrice),
        priceFixed(offer?.nationalPrice),
        moneyMinor(quote.grossDiscount),
        moneyMinor(quote.serviceFee),
        moneyMinor(quote.payableAmount),
        providerName || '',
    ].join('|');
    return crypto.createHash('sha256').update(seed, 'utf8').digest('hex');
}

function buildLegacyChargingCase(unique, capturedAt, sourceAgent = 'verification-agent') {
    const stationName = `47移动OCR旧版充电兼容验收站-${unique}`;
    return {
        key: 'legacy-charging',
        schemaVersion: 1,
        sourceAgent,
        stationName,
        idempotencyKey: `${sourceAgent}:${unique}:legacy-charging`,
        payload: {
            clientVersion: '172-verifier-3.0',
            sourceAgent,
            platform: 'didi-charging',
            city: '西安',
            deviceId: `verification-${unique}`,
            deviceSessionId: `verification-${unique}`,
            sessionId: `verification-${unique}-legacy-charging`,
            pageIndex: 1,
            sourceStage: 'verification',
            capturedAt,
            stations: [{
                stationId: `verification-${unique}-legacy-charging`,
                stationName,
                address: '陕西省西安市验收数据隔离区1号',
                priceFast: 0.85,
                priceSlow: 0.62,
                fastIdlePorts: 3,
                fastTotalPorts: 8,
                slowIdlePorts: 1,
                slowTotalPorts: 2,
                raw: { verificationRun: unique },
            }],
        },
    };
}

function buildAndroidChargingV3Case(
    unique,
    capturedAt,
    sourceAgent = 'verification-agent'
) {
    const sourceStationKey = `didi-charging:verification-${unique}-android-v3`;
    const stationName = `Android OCR v3充电验收站-${unique}`;
    const stationObservation = {
        sourceStationKey,
        stationName,
        address: '陕西省西安市高新区移动端验收路3号',
        availablePorts: null,
        busyPorts: null,
        totalPorts: null,
        portSemantics: 'charging-gun',
        capturedAt,
        quality: {
            needsReview: true,
            missingFields: ['availablePorts', 'busyPorts', 'totalPorts'],
            status: 'incomplete',
        },
    };
    const chargingObservation = {
        priceFast: '0.8500',
        priceSlow: '0.6200',
        priceSuper: null,
        priceService: '0.2000',
        fastIdlePorts: null,
        fastTotalPorts: null,
        slowIdlePorts: null,
        slowTotalPorts: null,
        superIdlePorts: null,
        superTotalPorts: null,
        capturedAt,
        sourceStage: 'screen-ocr-user-driven',
        raw: { verificationRun: unique, clientContract: 'android-v3' },
    };
    return {
        key: 'android-charging-v3',
        schemaVersion: 3,
        sourceAgent,
        stationName,
        sourceStationKey,
        stationObservation,
        chargingObservation,
        idempotencyKey: `${sourceAgent}:${unique}:android-charging-v3`,
        payload: {
            schemaVersion: 3,
            stationType: 'charging',
            clientVersion: 'android-verifier-3.0',
            sourceAgent,
            platform: 'didi-charging',
            city: '西安',
            deviceId: `verification-${unique}`,
            deviceSessionId: `verification-${unique}-android-v3`,
            sessionId: `verification-${unique}-android-charging-v3`,
            pageIndex: 2,
            sourceStage: 'screen-ocr-user-driven',
            capturedAt,
            appPackage: 'com.datafordidi.mobilecollector',
            observations: [{
                schemaVersion: 3,
                stationType: 'charging',
                stationObservation,
                chargingObservation,
            }],
        },
    };
}

function buildIosFuelV3Case(unique, capturedAt, options = {}) {
    const {
        platform,
        stationLabel,
        providerName,
        providerText,
        gradeCode,
        gradeLabel,
        gunCode,
        gunLabel,
        displayPrice,
        stationPrice,
        nationalPrice,
        grossDiscount,
        serviceFee,
        netDiscount,
        payableAmount,
        quoteEntry,
        sourceAgent = 'verification-agent',
        city = '武汉',
        address = '湖北省武汉市验收数据隔离大道5号',
        availablePorts = 3,
        busyPorts = 2,
        totalPorts = 5,
    } = options;
    const sourceStationKey = `${platform}:verification-${unique}`;
    const stationName = `${stationLabel}-${unique}`;
    const offer = {
        fuelType: 'gasoline',
        gradeCode,
        gradeLabel,
        displayPrice,
        stationPrice,
        nationalPrice,
        listPrice: null,
        discountPrice: null,
        unclassifiedPrice: null,
        discountKind: 'explicit',
        currency: 'CNY',
        unit: 'CNY_PER_LITER',
        fieldSource: {
            displayPrice: 'ocr',
            stationPrice: 'ocr',
            nationalPrice: 'ocr',
        },
        evidence: [
            { kind: 'display-price', text: `外显价${displayPrice}元/升`, confidence: 0.99 },
            { kind: 'station-price', text: `油站价${stationPrice}元/升`, confidence: 0.99 },
            { kind: 'national-price', text: `国标价${nationalPrice}元/升`, confidence: 0.99 },
        ],
        capturedAt,
    };
    const quote = {
        quoteObservationId: `verification-quote-${platform}-${unique}`,
        quoteDedupKey: '',
        gradeCode,
        gradeLabel,
        gunCode,
        gunLabel,
        selectedAmount: '200.00',
        grossDiscount,
        serviceFee,
        netDiscount,
        payableAmount,
        quoteEntry,
        capturedAt,
        raw: { evidence: `预计实付${payableAmount}元` },
    };
    quote.quoteDedupKey = quoteDedupKey({
        platform,
        sourceStationKey,
        providerName,
        offer,
        quote,
    });
    const fuelObservation = {
        raw: {
            verificationRun: unique,
            confidence: 0.99,
            clientContract: 'ios-v3',
        },
        fuelOffers: [offer],
        fuelQuotes: [quote],
    };
    if (providerName) {
        fuelObservation.providerName = providerName;
        fuelObservation.providerEvidence = {
            kind: 'provider-attribution',
            text: providerText,
            confidence: 0.99,
            boundingBox: { x: 0.1, y: 0.8, width: 0.5, height: 0.05 },
        };
    }
    return {
        key: platform,
        stationName,
        sourceStationKey,
        providerName: providerName || null,
        offer,
        quote,
        schemaVersion: 3,
        sourceAgent,
        stationObservation: {
            sourceStationKey,
            stationName,
            address,
            capturedAt,
            quality: {
                needsReview: false,
                missingFields: [],
                status: 'valid',
            },
        },
        idempotencyKey: `${sourceAgent}:${unique}:ios-${platform}-v3`,
        payload: {
            schemaVersion: 3,
            feature: FUEL_QUOTE_FEATURE,
            stationType: 'fuel',
            clientVersion: 'ios-verifier-3.0',
            sourceAgent,
            platform,
            city,
            deviceId: `verification-${unique}`,
            deviceSessionId: `verification-${unique}-ios-v3`,
            sessionId: `verification-${unique}-ios-${platform}-v3`,
            pageIndex: 3,
            sourceStage: 'screen-ocr-user-driven',
            capturedAt,
            appPackage: 'com.datafordidi.information-auto-recognition',
            observations: [{
                schemaVersion: 3,
                stationType: 'fuel',
                stationObservation: {
                    sourceStationKey,
                    stationName,
                    address,
                    capturedAt,
                    quality: {
                        needsReview: false,
                        missingFields: [],
                        status: 'valid',
                    },
                },
                fuelObservation,
            }],
        },
    };
}

function buildVerificationCases(unique, capturedAt = new Date().toISOString()) {
    return [
        buildLegacyChargingCase(unique, capturedAt),
        buildAndroidChargingV3Case(unique, capturedAt),
        buildIosFuelV3Case(unique, capturedAt, {
            platform: 'amap-fuel',
            stationLabel: 'iOS高德燃油v3链路验收加油站',
            providerName: '团油',
            providerText: '本次由服务商 团油 提供',
            gradeCode: '95',
            gradeLabel: '95#汽油',
            gunCode: '8',
            gunLabel: '8号枪',
            displayPrice: '6.0800',
            stationPrice: '6.7800',
            nationalPrice: '7.7300',
            grossDiscount: '20.65',
            serviceFee: '3.30',
            netDiscount: '17.35',
            payableAmount: '182.65',
            quoteEntry: 'inline',
        }),
        buildIosFuelV3Case(unique, capturedAt, {
            platform: 'tuanyou',
            stationLabel: 'iOS团油燃油v3链路验收加油站',
            providerName: null,
            providerText: null,
            gradeCode: '92',
            gradeLabel: '92#汽油',
            gunCode: null,
            gunLabel: null,
            displayPrice: '6.8500',
            stationPrice: '7.1500',
            nationalPrice: '7.3500',
            grossDiscount: '8.39',
            serviceFee: '1.34',
            netDiscount: '7.05',
            payableAmount: '192.95',
            quoteEntry: 'explanation_popup',
        }),
    ];
}

function assertHealth(health) {
    assert.equal(health.body.data.sourceNode, '47-mysql');
    assert.equal(health.body.data.role, 'mobile-ocr-mysql-source');
    assert.equal(health.body.data.capabilities?.schemaVersion, 2);
    assert.equal(health.body.data.capabilities?.latestSchemaVersion, 3);
    assert.deepEqual(
        health.body.data.capabilities?.supportedSchemaVersions,
        [1, 2, 3]
    );
    assert.equal(health.body.data.capabilities?.observationEnvelope, true);
    assert.equal(health.body.data.capabilities?.stationObservation, true);
    const feature = health.body.data.capabilities?.features?.[FUEL_QUOTE_FEATURE];
    assert.equal(feature?.enabled, true);
    assert.equal(feature?.captureMode, 'user-driven-ocr');
    assert.equal(feature?.maxOffersPerStation, 8);
    assert.equal(feature?.maxQuotesPerObservation, 128);
    assert.ok(Array.isArray(feature?.platforms));
    for (const platform of REQUIRED_FUEL_PLATFORMS) {
        assert.ok(feature.platforms.includes(platform), `${platform} must be enabled`);
    }
}

function assertFuelRecord(record, verificationCase) {
    assert.equal(record.stationType, 'fuel');
    assert.equal(record.platform, verificationCase.payload.platform);
    assert.equal(record.sourceStationKey, verificationCase.sourceStationKey);
    assert.equal(record.address, verificationCase.stationObservation.address);
    // 燃油侧无枪数据：record 的 ports/portSemantics 一律为 null。
    assert.equal(record.availablePorts, null);
    assert.equal(record.busyPorts, null);
    assert.equal(record.totalPorts, null);
    assert.equal(record.portSemantics, null);
    assert.deepEqual(record.missingFields, []);
    assert.equal(record.qualityStatus, 'valid');
    assert.equal(record.needsReview, false);
    assert.equal(record.providerName, verificationCase.providerName);
    if (verificationCase.providerName) {
        assert.equal(
            record.providerEvidence?.text,
            verificationCase.payload.observations[0].fuelObservation.providerEvidence.text
        );
    }
    assert.equal(record.fuelOffers?.length, 1);
    assert.equal(record.fuelQuotes?.length, 1);
    const offer = record.fuelOffers[0];
    assert.equal(offer.gradeCode, verificationCase.offer.gradeCode);
    assert.equal(Number(offer.displayPrice), Number(verificationCase.offer.displayPrice));
    assert.equal(Number(offer.stationPrice), Number(verificationCase.offer.stationPrice));
    assert.equal(Number(offer.nationalPrice), Number(verificationCase.offer.nationalPrice));
    assert.deepEqual(offer.fieldSource, verificationCase.offer.fieldSource);
    const quote = record.fuelQuotes[0];
    for (const field of [
        'quoteObservationId', 'quoteDedupKey', 'gradeCode', 'gradeLabel',
        'gunCode', 'gunLabel', 'selectedAmount', 'grossDiscount',
        'serviceFee', 'netDiscount', 'payableAmount', 'quoteEntry',
    ]) {
        assert.equal(quote[field], verificationCase.quote[field], field);
    }
    assert.equal(quote.needsReview, false);
}

function assertChargingV3Record(record, verificationCase) {
    assert.equal(record.stationType, 'charging');
    assert.equal(record.platform, 'didi-charging');
    assert.equal(record.sourceStationKey, verificationCase.sourceStationKey);
    assert.equal(record.address, verificationCase.stationObservation.address);
    assert.equal(record.availablePorts, null);
    assert.equal(record.busyPorts, null);
    assert.equal(record.totalPorts, null);
    assert.equal(record.portSemantics, 'charging-gun');
    assert.equal(record.qualityStatus, 'incomplete');
    assert.equal(record.needsReview, true);
    for (const field of [
        'availablePorts', 'busyPorts', 'priceSuper', 'totalPorts',
    ]) {
        assert.ok(record.missingFields.includes(field), `${field} must remain missing`);
    }
    assert.equal(Number(record.priceFast), 0.85);
    assert.equal(Number(record.priceSlow), 0.62);
    assert.equal(record.priceSuper, null);
    assert.equal(Number(record.priceService), 0.2);
}

async function ingestAndReadBack({
    baseUrl,
    ingestToken,
    syncToken,
    verificationCase,
    fetchImpl,
}) {
    const isFuel = verificationCase.payload.stationType === 'fuel';
    const ingestHeaders = {
        Authorization: `Bearer ${ingestToken}`,
        'Content-Type': 'application/json',
        'X-Mobile-Agent': verificationCase.sourceAgent,
        'Idempotency-Key': verificationCase.idempotencyKey,
    };
    const send = () => requestJson(`${baseUrl}/api/mobile-sync/stations`, {
        method: 'POST',
        headers: ingestHeaders,
        body: JSON.stringify(verificationCase.payload),
    }, fetchImpl);
    const first = await send();
    assert.equal(first.status, 201);
    assert.equal(first.body.data.persisted, true);
    assert.equal(first.body.data.sourceNode, '47-mysql');
    assert.equal(first.body.data.sourceAgent, verificationCase.sourceAgent);
    assert.equal(first.body.data.duplicate, false);
    assert.match(first.body.data.ingestId, /^[a-f0-9-]{36}$/);
    assert.equal(first.body.data.acceptedCount, 1);
    assert.equal(first.body.data.acceptedStationCount, 1);
    assert.equal(
        first.body.data.acceptedQuoteCount,
        isFuel ? 1 : 0
    );
    assert.ok(Number.isSafeInteger(first.body.data.firstSourceRecordId));
    assert.equal(first.body.data.firstSourceRecordId, first.body.data.lastSourceRecordId);
    if (isFuel) {
        assert.equal(first.body.data.firstFuelSourceRecordId, first.body.data.firstSourceRecordId);
        assert.equal(first.body.data.lastFuelSourceRecordId, first.body.data.lastSourceRecordId);
    } else {
        assert.equal(first.body.data.firstFuelSourceRecordId, null);
        assert.equal(first.body.data.lastFuelSourceRecordId, null);
    }

    const repeated = await send();
    assert.equal(repeated.status, 200);
    assert.equal(repeated.body.data.persisted, true);
    assert.equal(repeated.body.data.sourceNode, '47-mysql');
    assert.equal(repeated.body.data.sourceAgent, verificationCase.sourceAgent);
    assert.equal(repeated.body.data.duplicate, true);
    for (const field of [
        'ingestId', 'acceptedCount', 'acceptedStationCount', 'acceptedQuoteCount',
        'firstSourceRecordId', 'lastSourceRecordId',
        'firstFuelSourceRecordId', 'lastFuelSourceRecordId',
    ]) {
        assert.equal(repeated.body.data[field], first.body.data[field], field);
    }

    const sourceRecordId = first.body.data.firstSourceRecordId;
    const exported = await requestJson(
        `${baseUrl}/api/source-sync/stations?afterId=${sourceRecordId - 1}&limit=1`,
        { headers: { Authorization: `Bearer ${syncToken}` } },
        fetchImpl
    );
    assert.equal(exported.body.data.count, 1);
    assert.equal(exported.body.data.afterId, sourceRecordId - 1);
    assert.equal(exported.body.data.nextCursor, sourceRecordId);
    assert.equal(exported.body.data.records.length, 1);
    const record = exported.body.data.records[0];
    assert.equal(record.sourceRecordId, sourceRecordId);
    assert.equal(record.ingestId, first.body.data.ingestId);
    assert.equal(record.sourceNode, '47-mysql');
    assert.equal(record.sourceType, 'mobile-ocr');
    assert.equal(record.sourceAgent, verificationCase.sourceAgent);
    assert.equal(record.stationName, verificationCase.stationName);
    if (verificationCase.key === 'legacy-charging') {
        assert.equal(record.availablePorts, 4);
        assert.equal(record.totalPorts, 10);
    } else if (verificationCase.key === 'android-charging-v3') {
        assertChargingV3Record(record, verificationCase);
    } else {
        assertFuelRecord(record, verificationCase);
    }
    return {
        ...verificationCase,
        ingestId: first.body.data.ingestId,
        sourceRecordId,
    };
}

function assertLocalLegacyCharging(db, result) {
    const local = db.prepare(`
        SELECT station_name, address, price_fast, price_slow,
               available_ports, total_ports, source_agent, source_node, source_record_id
        FROM stations
        WHERE source_node = '47-mysql' AND source_record_id = ?
    `).get(result.sourceRecordId);
    assert.equal(local.station_name, result.stationName);
    assert.equal(local.address, result.payload.stations[0].address);
    assert.equal(local.price_fast, 0.85);
    assert.equal(local.price_slow, 0.62);
    assert.equal(local.available_ports, 4);
    assert.equal(local.total_ports, 10);
    assert.equal(local.source_agent, result.sourceAgent);
    assert.equal(local.source_node, '47-mysql');
    assert.equal(local.source_record_id, result.sourceRecordId);
}

function assertLocalChargingV3(db, result) {
    const local = db.prepare(`
        SELECT station_name, address, price_fast, price_slow, price_super,
               price_service, available_ports, busy_ports, total_ports,
               port_semantics, missing_fields, quality_status,
               source_agent, source_node, source_record_id
        FROM stations
        WHERE source_node = '47-mysql' AND source_record_id = ?
    `).get(result.sourceRecordId);
    assert.equal(local.station_name, result.stationName);
    assert.equal(local.address, result.stationObservation.address);
    assert.equal(local.price_fast, 0.85);
    assert.equal(local.price_slow, 0.62);
    assert.equal(local.price_super, null);
    assert.equal(local.price_service, 0.2);
    assert.equal(local.available_ports, null);
    assert.equal(local.busy_ports, null);
    assert.equal(local.total_ports, null);
    assert.equal(local.port_semantics, 'charging-gun');
    assert.deepEqual(
        JSON.parse(local.missing_fields),
        ['availablePorts', 'busyPorts', 'priceSuper', 'totalPorts']
    );
    assert.equal(local.quality_status, 'incomplete');
    assert.equal(local.source_agent, result.sourceAgent);
    assert.equal(local.source_node, '47-mysql');
    assert.equal(local.source_record_id, result.sourceRecordId);
}

function assertLocalFuel(db, result) {
    const local = db.prepare(`
        SELECT id, station_name, station_type, provider_name, address,
               available_ports, busy_ports, total_ports, port_semantics,
               missing_fields, quality_status,
               source_agent, source_node, source_record_id
        FROM stations
        WHERE source_node = '47-mysql' AND source_record_id = ?
    `).get(result.sourceRecordId);
    assert.equal(local.station_name, result.stationName);
    assert.equal(local.station_type, 'fuel');
    assert.equal(local.provider_name, result.providerName);
    assert.equal(local.address, result.stationObservation.address);
    // 燃油侧无枪数据：DB 中 ports/port_semantics 一律为 NULL（读回 null），
    // stationObservation 不携带这些字段（undefined），两侧均不得出现充电枪语义。
    assert.equal(local.available_ports, null);
    assert.equal(local.busy_ports, null);
    assert.equal(local.total_ports, null);
    assert.equal(local.port_semantics, null);
    assert.deepEqual(local.missing_fields ? JSON.parse(local.missing_fields) : [], []);
    assert.equal(local.quality_status, 'valid');
    assert.equal(local.source_agent, result.sourceAgent);
    assert.equal(local.source_node, '47-mysql');
    assert.equal(local.source_record_id, result.sourceRecordId);

    const offers = db.prepare(`
        SELECT grade_code, display_price, station_price, national_price
        FROM fuel_offers
        WHERE station_id = ?
        ORDER BY offer_index
    `).all(local.id);
    assert.equal(offers.length, 1);
    assert.equal(offers[0].grade_code, result.offer.gradeCode);
    assert.equal(Number(offers[0].display_price), Number(result.offer.displayPrice));
    assert.equal(Number(offers[0].station_price), Number(result.offer.stationPrice));
    assert.equal(Number(offers[0].national_price), Number(result.offer.nationalPrice));

    const quotes = db.prepare(`
        SELECT quote_observation_id, quote_dedup_key, grade_code,
               selected_amount, gross_discount, service_fee,
               net_discount, payable_amount, quote_entry, needs_review
        FROM fuel_quotes
        WHERE station_id = ?
    `).all(local.id);
    assert.equal(quotes.length, 1);
    assert.equal(quotes[0].quote_observation_id, result.quote.quoteObservationId);
    assert.equal(quotes[0].quote_dedup_key, result.quote.quoteDedupKey);
    assert.equal(quotes[0].grade_code, result.quote.gradeCode);
    assert.equal(quotes[0].selected_amount, result.quote.selectedAmount);
    assert.equal(quotes[0].gross_discount, result.quote.grossDiscount);
    assert.equal(quotes[0].service_fee, result.quote.serviceFee);
    assert.equal(quotes[0].net_discount, result.quote.netDiscount);
    assert.equal(quotes[0].payable_amount, result.quote.payableAmount);
    assert.equal(quotes[0].quote_entry, result.quote.quoteEntry);
    assert.equal(quotes[0].needs_review, 0);
}

async function mergeIntoTemporaryProduct({
    baseUrl,
    sourceHost,
    syncToken,
    results,
}) {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-source-172-verify-'));
    const originalDatabasePath = process.env.DATABASE_PATH;
    const originalDataRoot = process.env.DATA_ROOT;
    const databaseModulePath = require.resolve('../backend/database/init');
    const stationModulePath = require.resolve('../backend/models/station');
    process.env.DATABASE_PATH = path.join(tempRoot, 'main-product.db');
    process.env.DATA_ROOT = path.join(tempRoot, 'data');
    delete require.cache[databaseModulePath];
    delete require.cache[stationModulePath];
    const db = require(databaseModulePath);
    const StationModel = require(stationModulePath);
    const { RemoteMobileSourceSync } = require('../backend/services/remote-mobile-source-sync');
    try {
        assert.equal(db.pragma('user_version', { simple: true }), 8);
        for (const result of results) {
            const statePath = path.join(tempRoot, `source-cursor-${result.key}.json`);
            fs.writeFileSync(
                statePath,
                `${JSON.stringify({ cursor: result.sourceRecordId - 1 })}\n`,
                { mode: 0o600 }
            );
            const sync = new RemoteMobileSourceSync({
                stationModel: StationModel,
                baseUrl,
                allowHttp: new URL(baseUrl).protocol === 'http:',
                allowedHosts: [sourceHost],
                token: syncToken,
                statePath,
                batchSize: 1,
                includeVerificationAgent: true,
            });
            const merged = await sync.pullOnce();
            assert.equal(merged.cursor, result.sourceRecordId);
            assert.equal(merged.lastFetchedCount, 1);
            assert.equal(merged.lastMergedCount, 1);
        }
        for (const result of results) {
            if (result.key === 'legacy-charging') {
                assertLocalLegacyCharging(db, result);
            } else if (result.key === 'android-charging-v3') {
                assertLocalChargingV3(db, result);
            } else if (result.payload.stationType === 'fuel') {
                assertLocalFuel(db, result);
            } else {
                throw new Error(`unsupported verification case: ${result.key}`);
            }
        }
    } finally {
        db.close();
        delete require.cache[databaseModulePath];
        delete require.cache[stationModulePath];
        if (originalDatabasePath === undefined) delete process.env.DATABASE_PATH;
        else process.env.DATABASE_PATH = originalDatabasePath;
        if (originalDataRoot === undefined) delete process.env.DATA_ROOT;
        else process.env.DATA_ROOT = originalDataRoot;
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
}

async function runVerification(options) {
    const {
        baseUrl,
        sourceHost = EXPECTED_SOURCE_HOST,
        executionNode,
        ingestToken,
        syncToken,
        unique = `${Date.now()}-${process.pid}`,
        capturedAt = new Date().toISOString(),
        fetchImpl = globalThis.fetch,
        merge = mergeIntoTemporaryProduct,
    } = options;
    const health = await requestJson(`${baseUrl}/health`, {}, fetchImpl);
    assertHealth(health);
    const results = [];
    for (const verificationCase of buildVerificationCases(unique, capturedAt)) {
        results.push(await ingestAndReadBack({
            baseUrl,
            ingestToken,
            syncToken,
            verificationCase,
            fetchImpl,
        }));
    }
    await merge({
        baseUrl,
        sourceHost,
        syncToken,
        results,
    });
    return {
        success: true,
        executionNode,
        sourceNode: '47-mysql',
        legacyChargingSourceRecordId: results
            .find(result => result.key === 'legacy-charging').sourceRecordId,
        androidChargingV3SourceRecordId: results
            .find(result => result.key === 'android-charging-v3').sourceRecordId,
        iosAmapFuelV3SourceRecordId: results
            .find(result => result.key === 'amap-fuel').sourceRecordId,
        iosTuanyouFuelV3SourceRecordId: results
            .find(result => result.key === 'tuanyou').sourceRecordId,
        duplicateRetryVerified: true,
        legacyChargingCompatibilityVerified: true,
        schemaVersion3Verified: true,
        fuelQuoteFeatureVerified: true,
        sourceSyncRoundTripVerified: true,
        localSqliteV8MergeVerified: true,
        tuanyouExplanationEntryVerified: true,
    };
}

async function main() {
    if (Number(process.versions.node.split('.')[0]) !== 22) {
        throw new Error('verification requires Node.js 22 LTS');
    }
    const executionNode = assertExecutionNode();
    const baseUrl = sourceOrigin();
    const ingestToken = requiredEnv('MOBILE_SOURCE_INGEST_TOKEN');
    const syncToken = requiredEnv('MOBILE_SOURCE_SYNC_TOKEN');
    const result = await runVerification({
        baseUrl,
        executionNode,
        ingestToken,
        syncToken,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
    main().catch(error => {
        process.stderr.write(`47 mobile source verification failed: ${error.message}\n`);
        process.exitCode = 1;
    });
}

module.exports = {
    EXECUTION_IP_ALLOWLIST_ENV,
    EXPECTED_SOURCE_HOST,
    EXPECTED_SOURCE_PORT,
    assertExecutionNode,
    assertFuelRecord,
    assertHealth,
    buildAndroidChargingV3Case,
    buildIosFuelV3Case,
    buildLegacyChargingCase,
    buildVerificationCases,
    executionIpAllowlist,
    ingestAndReadBack,
    isControlled172Address,
    loadSerializedClientFixtures,
    mergeIntoTemporaryProduct,
    quoteDedupKey,
    requestJson,
    runVerification,
    sourceOrigin,
    verifySerializedClientFixtures,
};
