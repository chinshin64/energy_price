'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blue-team-station-test-'));
process.env.DATABASE_PATH = path.join(tempDir, 'stations.db');
process.env.DATA_ROOT = path.join(tempDir, 'data');
process.env.RAW_DATA_MAX_BYTES = '1000';

const db = require('../database/init');
const StationModel = require('../models/station');
const MobileSyncService = require('../services/mobile-sync');

test.after(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
});

test('全新数据库具备完整场站结构和生产运行 pragma', () => {
    const columns = new Set(db.prepare('PRAGMA table_info(stations)').all().map(item => item.name));
    for (const required of [
        'operator',
        'source_agent',
        'source_node',
        'source_record_id',
        'provider_name',
        'needs_review',
        'confidence_score',
        'confidence_dimensions'
    ]) {
        assert.equal(columns.has(required), true, `缺少字段 ${required}`);
    }
    assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
    assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
    assert.equal(db.pragma('busy_timeout', { simple: true }), 5000);
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'fuel_offers'").get());
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'fuel_quotes'").get());
});

test('移动 OCR 来源 Agent 作为一等字段写入并参与视图归并', () => {
    const result = StationModel.insert({
        platform: 'didi-charging',
        stationId: 'agent-station-1',
        stationName: 'Agent 测试站',
        sourceType: 'mobile-ocr',
        sourceAgent: 'android-agent',
        raw: { mobileSync: { meta: { sourceAgent: 'android-agent' } } },
    });
    const stored = db.prepare('SELECT source_type, source_agent FROM stations WHERE id = ?').get(result.lastInsertRowid);
    assert.equal(stored.source_type, 'mobile-ocr');
    assert.equal(stored.source_agent, 'android-agent');
    const row = StationModel.normalizeRowForView({ id: result.lastInsertRowid, ...stored });
    assert.deepEqual(row.source_agents, ['android-agent']);
});

test('手机逐页 payload 经本地同步服务合并并保留来源元数据', () => {
    const service = new MobileSyncService({
        supportedPlatforms: ['didi-charging'],
        insertStations: stations => StationModel.insertBatch(stations),
    });
    const result = service.ingestStationPayload({
        platform: 'didi-charging',
        city: '西安',
        sessionId: 'ios-e2e-session',
        sourceAgent: 'ios-agent',
        _transport: { mobileAgent: 'ios-agent', relayNode: '47.111.139.230' },
        stations: [{
            stationId: 'ios-agent-station-1',
            stationName: '小桔充电西安软件新城充电站',
            address: '陕西省西安市雁塔区云水一路88号停车场',
            priceFast: 0.85,
            availablePorts: 3,
            totalPorts: 8,
        }],
    });

    assert.equal(result.sourceAgent, 'ios-agent');
    assert.equal(result.relayNode, '47.111.139.230');
    const stored = db.prepare(`
        SELECT source_type, source_agent, raw_data
        FROM stations
        WHERE station_id = 'ios-agent-station-1'
    `).get();
    assert.equal(stored.source_type, 'mobile-ocr');
    assert.equal(stored.source_agent, 'ios-agent');
    const raw = JSON.parse(stored.raw_data);
    assert.equal(raw.mobileSync.meta.sourceAgent, 'ios-agent');
    assert.equal(raw.mobileSync.meta.relayNode, '47.111.139.230');
});

test('Android 与 iOS 同站快照合并名称地址枪数价格并保留两个 Agent', () => {
    const platform = 'agent-merge-contract';
    const stationId = 'shared-agent-station-1';
    StationModel.insert({
        platform,
        stationId,
        stationName: '软件新城站',
        address: '陕西省西安市雁塔区云水一路88号停车场',
        priceFast: 0.85,
        priceSlow: 0.65,
        availablePorts: 4,
        busyPorts: 1,
        totalPorts: 5,
        portSemantics: 'charging-gun',
        sourceType: 'mobile-ocr',
        sourceAgent: 'android-agent',
        sourceNode: '47-mysql',
        sourceRecordId: 9201,
        snapshotAt: '2026-07-24T01:00:00.000Z',
        snapshotMode: 'append',
        raw: { snapshotMode: 'append' },
    });
    StationModel.insert({
        platform,
        stationId,
        stationName: '小桔充电西安软件新城充电站',
        address: null,
        priceFast: 0.88,
        priceSlow: null,
        availablePorts: 0,
        busyPorts: 5,
        totalPorts: 5,
        portSemantics: 'charging-gun',
        sourceType: 'mobile-ocr',
        sourceAgent: 'ios-agent',
        sourceNode: '47-mysql',
        sourceRecordId: 9202,
        snapshotAt: '2026-07-24T01:05:00.000Z',
        snapshotMode: 'append',
        raw: { snapshotMode: 'append' },
    });

    const view = StationModel.getRecent(20, platform)
        .find(item => item.station_id === stationId);
    assert.equal(view.station_name, '小桔充电西安软件新城充电站');
    assert.equal(view.address, '陕西省西安市雁塔区云水一路88号停车场');
    assert.equal(view.price_fast, 0.88);
    assert.equal(view.price_slow, 0.65);
    assert.equal(view.available_ports, 0);
    assert.equal(view.busy_ports, 5);
    assert.equal(view.total_ports, 5);
    assert.deepEqual([...view.source_agents].sort(), ['android-agent', 'ios-agent']);
});

test('47 sourceRecordId 在本地主库形成幂等边界并进入统一视图', () => {
    const station = {
        platform: 'didi-charging',
        stationName: '47 MySQL 幂等测试站',
        sourceType: 'mobile-ocr',
        sourceAgent: 'ios-agent',
        sourceNode: '47-mysql',
        sourceRecordId: 9001,
        snapshotMode: 'append',
        raw: {
            snapshotMode: 'append',
            mobileSync: {
                meta: {
                    sourceAgent: 'ios-agent',
                    sourceNode: '47-mysql',
                    sourceRecordId: 9001,
                    city: '西安'
                }
            }
        }
    };
    const first = StationModel.insert(station);
    const repeated = StationModel.insert(station);
    assert.equal(first.changes, 1);
    assert.equal(repeated, null);
    const stored = db.prepare(`
        SELECT source_agent, source_node, source_record_id
        FROM stations
        WHERE source_node = '47-mysql' AND source_record_id = 9001
    `).get();
    assert.equal(stored.source_agent, 'ios-agent');
    assert.equal(stored.source_node, '47-mysql');
    assert.equal(stored.source_record_id, 9001);
    const row = StationModel.normalizeRowForView({ id: first.lastInsertRowid, ...stored });
    assert.deepEqual(row.source_nodes, ['47-mysql']);
});

test('场站和分时价格只保存脱敏后的原始数据', () => {
    const result = StationModel.insert({
        platform: 'commercial-test',
        stationId: 'station-1',
        stationName: '测试场站',
        operator: '测试运营商',
        raw: {
            sourceType: 'har',
            token: 'station-secret',
            headers: [{ name: 'Cookie', value: 'session=header-secret' }],
            request_url: 'https://example.test/list?access_token=url-secret&city=xian',
            schedules: [{
                startTime: '00:00',
                endTime: '01:00',
                price: 0.88,
                authToken: 'schedule-secret'
            }]
        }
    });

    assert.equal(result.changes, 1);
    const station = db.prepare('SELECT operator, raw_data FROM stations WHERE id = ?').get(result.lastInsertRowid);
    const raw = JSON.parse(station.raw_data);
    assert.equal(station.operator, '测试运营商');
    assert.equal(raw.token, '**redacted**');
    assert.equal(raw.headers[0].value, '**redacted**');
    assert.equal(new URL(raw.request_url).searchParams.get('access_token'), '**redacted**');
    assert.equal(station.raw_data.includes('station-secret'), false);
    assert.equal(station.raw_data.includes('header-secret'), false);
    assert.equal(station.raw_data.includes('url-secret'), false);

    const schedule = db.prepare('SELECT raw_data FROM price_schedules WHERE station_id = ?').get(result.lastInsertRowid);
    assert.ok(schedule);
    assert.equal(JSON.parse(schedule.raw_data).authToken, '**redacted**');
    assert.equal(schedule.raw_data.includes('schedule-secret'), false);
});

test('超限原始报文不直接写入 SQLite', () => {
    const result = StationModel.insert({
        platform: 'commercial-test',
        stationId: 'station-large',
        stationName: '大报文场站',
        raw: {
            platform: 'commercial-test',
            sourceType: 'api',
            content: 'z'.repeat(5000)
        }
    });
    const row = db.prepare('SELECT raw_data FROM stations WHERE id = ?').get(result.lastInsertRowid);
    const raw = JSON.parse(row.raw_data);
    assert.equal(raw._storagePolicy.truncated, true);
    assert.equal(raw._storagePolicy.maxBytes, 1000);
    assert.equal(row.raw_data.includes('z'.repeat(100)), false);
});

test('燃油快照双写兼容 JSON、规范 offers/quotes 并保留脱敏证据', () => {
    const result = StationModel.insert({
        platform: 'amap-fuel',
        stationName: '高德测试加油站',
        stationType: 'fuel',
        address: '浙江省杭州市测试大道9100号',
        availablePorts: 2,
        busyPorts: 1,
        totalPorts: 3,
        portSemantics: 'fuel-gun',
        missingFields: [],
        qualityStatus: 'valid',
        providerName: '=测试服务商',
        providerEvidence: {
            kind: 'provider-attribution',
            text: '本服务由测试服务商提供',
            confidence: null,
            boundingBox: null,
        },
        sourceType: 'mobile-ocr',
        sourceAgent: 'android-ocr-agent',
        sourceNode: '47-mysql',
        sourceRecordId: 9100,
        sourceStationKey: '47-mysql:9100',
        capturedAt: '2026-07-23T12:00:00.000Z',
        fuelOffers: [{
            fuelType: 'gasoline',
            gradeCode: '92',
            gradeLabel: '92#汽油',
            displayPrice: '6.6300',
            stationPrice: '7.8600',
            nationalPrice: '8.1200',
            currency: 'CNY',
            unit: 'CNY_PER_LITER',
            evidence: [{
                kind: 'display-price',
                boundingBox: { x: 0.1, y: 0.3, width: 0.2, height: 0.04 },
            }],
            fieldSource: {
                displayPrice: 'ocr',
                stationPrice: 'ocr',
                nationalPrice: 'ocr',
            },
            capturedAt: '2026-07-23T12:00:00.000Z',
        }],
        fuelQuotes: [{
            quoteObservationId: 'quote-storage-1',
            quoteDedupKey: 'b'.repeat(64),
            gradeCode: '92',
            gradeLabel: '92#汽油',
            selectedAmount: '200.00',
            grossDiscount: '8.39',
            serviceFee: '1.34',
            netDiscount: '7.05',
            payableAmount: '190.00',
            quoteEntry: 'explanation_popup',
            needsReview: true,
            capturedAt: '2026-07-23T12:00:00.000Z',
            raw: { evidence: '预计实付190.00', token: 'must-redact' },
        }],
        raw: {
            fuelObservation: {
                providerEvidence: {
                    kind: 'provider-attribution',
                    text: '本服务由测试服务商提供',
                    confidence: null,
                    boundingBox: null,
                },
            },
            token: 'station-fuel-secret',
        },
    });

    const station = db.prepare(`
        SELECT provider_name, fuel_offers, raw_data, address,
               available_ports, busy_ports, total_ports,
               port_semantics, missing_fields, quality_status, source_agent
        FROM stations
        WHERE id = ?
    `).get(result.lastInsertRowid);
    const offer = db.prepare(`
        SELECT display_price, station_price, national_price, evidence, raw_data
        FROM fuel_offers
        WHERE station_id = ?
    `).get(result.lastInsertRowid);
    const quote = db.prepare(`
        SELECT payable_amount, needs_review, raw_data
        FROM fuel_quotes
        WHERE station_id = ?
    `).get(result.lastInsertRowid);

    assert.equal(station.provider_name, '=测试服务商');
    assert.equal(station.address, '浙江省杭州市测试大道9100号');
    assert.equal(station.available_ports, 2);
    assert.equal(station.busy_ports, 1);
    assert.equal(station.total_ports, 3);
    assert.equal(station.port_semantics, 'fuel-gun');
    assert.equal(station.quality_status, 'valid');
    assert.equal(station.source_agent, 'android-ocr-agent');
    assert.equal(JSON.parse(station.fuel_offers)[0].displayPrice, '6.6300');
    assert.equal(Number(offer.display_price), 6.63);
    assert.deepEqual(JSON.parse(offer.evidence), [{
        kind: 'display-price',
        boundingBox: { x: 0.1, y: 0.3, width: 0.2, height: 0.04 },
    }]);
    assert.equal(quote.payable_amount, '190.00');
    assert.equal(quote.needs_review, 1);
    assert.equal(station.raw_data.includes('station-fuel-secret'), false);
    assert.equal(quote.raw_data.includes('must-redact'), false);

    const view = StationModel.getRecent(20, 'amap-fuel')
        .find(item => Number(item.source_record_id) === 9100);
    assert.equal(view.fuel_offers_normalized[0].displayPrice, 6.63);
    assert.equal(view.fuel_quotes[0].needsReview, true);
    assert.equal(view.address, '浙江省杭州市测试大道9100号');
    assert.equal(view.busy_ports, 1);
    assert.deepEqual(view.source_agents, ['android-ocr-agent']);
});

test('燃油子记录失败时回滚 station 主记录', () => {
    assert.throws(() => StationModel.insert({
        platform: 'tuanyou',
        stationName: '事务回滚加油站',
        stationType: 'fuel',
        sourceNode: '47-mysql',
        sourceRecordId: 9101,
        fuelOffers: [{
            fuelType: 'gasoline',
            gradeCode: '95',
            gradeLabel: '95#',
            displayPrice: '7.10',
            discountKind: 'none',
            currency: 'CNY',
            unit: 'CNY_PER_LITER',
            fieldSource: { displayPrice: 'ocr' },
            evidence: [],
            capturedAt: '2026-07-23T12:00:00.000Z',
        }],
        fuelQuotes: [{
            quoteObservationId: 'quote-invalid',
            quoteDedupKey: 'not-a-sha256',
            gradeCode: '95',
            gradeLabel: '95#',
            selectedAmount: '200.00',
            quoteEntry: 'inline',
            needsReview: false,
            capturedAt: '2026-07-23T12:00:00.000Z',
            raw: {},
        }],
    }), /fuel station quotes are invalid/);
    assert.equal(
        db.prepare('SELECT COUNT(*) AS count FROM stations WHERE source_record_id = 9101').get().count,
        0
    );
});

test('quote-only 可落库，未知 provider/offer/quote 字段全部拒绝', () => {
    const quoteOnly = {
        platform: 'amap-fuel',
        stationName: '严格契约测试加油站',
        stationType: 'fuel',
        sourceNode: '47-mysql',
        sourceRecordId: 9102,
        sourceStationKey: 'amap-fuel:strict-9102',
        providerName: null,
        providerEvidence: null,
        fuelOffers: [],
        fuelQuotes: [{
            quoteObservationId: 'quote-strict-9102',
            quoteDedupKey: 'd'.repeat(64),
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
            capturedAt: '2026-07-23T13:00:00.000Z',
            raw: {},
        }],
        raw: {},
    };
    const inserted = StationModel.insert(quoteOnly);
    assert.equal(inserted.changes, 1);
    assert.equal(
        db.prepare('SELECT COUNT(*) AS count FROM fuel_quotes WHERE station_id = ?')
            .get(inserted.lastInsertRowid).count,
        1
    );

    const unknownQuote = structuredClone(quoteOnly);
    unknownQuote.sourceRecordId = 9103;
    unknownQuote.fuelQuotes[0].quoteObservationId = 'quote-strict-9103';
    unknownQuote.fuelQuotes[0].quoteDedupKey = 'e'.repeat(64);
    unknownQuote.fuelQuotes[0].unsupported = true;
    assert.throws(() => StationModel.insert(unknownQuote), /fuel station quotes are invalid/);

    const unknownProvider = structuredClone(quoteOnly);
    unknownProvider.sourceRecordId = 9104;
    unknownProvider.providerName = '测试服务商';
    unknownProvider.providerEvidence = {
        kind: 'provider-attribution',
        text: '本服务由测试服务商提供',
        unsupported: true,
    };
    assert.throws(() => StationModel.insert(unknownProvider), /provider evidence is invalid/);
    assert.equal(
        db.prepare('SELECT COUNT(*) AS count FROM stations WHERE source_record_id IN (9103, 9104)').get().count,
        0
    );
});

test('证据文件只写入并读取当前 DATA_ROOT', () => {
    const sourcePath = path.join(tempDir, 'source.png');
    fs.writeFileSync(sourcePath, Buffer.from('test-image-content'));

    const managed = StationModel.copyManagedEvidenceFile(sourcePath, {
        stationId: 'station-evidence',
        capturedAt: '2026-07-10T00:00:00.000Z',
        evidenceType: 'ocr-screenshot',
    });
    assert.ok(managed);
    assert.equal(managed.relativePath.startsWith(`data-center${path.sep}evidence${path.sep}`), true);

    const evidenceId = StationModel.upsertEvidenceAsset({
        stationId: null,
        platform: 'commercial-test',
        evidenceType: 'ocr-screenshot',
        assetPath: managed.relativePath,
        contentHash: managed.hash,
    });
    const evidence = StationModel.getEvidenceAssetFilePath(evidenceId);
    assert.ok(evidence);
    assert.equal(evidence.filePath.startsWith(`${fs.realpathSync(process.env.DATA_ROOT)}${path.sep}`), true);
    assert.equal(fs.readFileSync(evidence.filePath, 'utf8'), 'test-image-content');
    assert.equal(fs.statSync(evidence.filePath).mode & 0o777, 0o600);

    const escapedId = StationModel.upsertEvidenceAsset({
        stationId: null,
        platform: 'commercial-test',
        evidenceType: 'ocr-screenshot',
        assetPath: path.join('..', 'source.png'),
        contentHash: 'outside-root',
    });
    assert.equal(StationModel.getEvidenceAssetFilePath(escapedId), null);

    const linkPath = path.join(StationModel.getDataCenterEvidenceRoot(), 'outside-link.png');
    fs.symlinkSync(sourcePath, linkPath);
    const linkedId = StationModel.upsertEvidenceAsset({
        stationId: null,
        platform: 'commercial-test',
        evidenceType: 'ocr-screenshot',
        assetPath: path.relative(process.env.DATA_ROOT, linkPath),
        contentHash: 'symlink-outside-root',
    });
    assert.equal(StationModel.getEvidenceAssetFilePath(linkedId), null);
});
