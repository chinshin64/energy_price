'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blue-team-export-test-'));
process.env.DATABASE_PATH = path.join(tempDir, 'export.db');
process.env.DATA_ROOT = path.join(tempDir, 'data');

const db = require('../database/init');
const StationModel = require('../models/station');
const { StationExportService, escapeCsvCell } = require('../services/station-export-service');

test.before(() => {
    const insert = db.prepare(`
        INSERT INTO stations (
            platform, station_id, station_name, address, price_fast,
            source_type, source_stage, collected_at, snapshot_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    db.transaction(() => {
        for (let index = 0; index < 1205; index += 1) {
            insert.run(
                'didi-charging',
                `station-${index}`,
                index === 0 ? '=cmd("calc")' : `场站 "${index}"`,
                index === 1 ? '地址,一行\n二行' : `地址 ${index}`,
                0.8,
                'api',
                'list',
                `2026-07-10 10:${String(index % 60).padStart(2, '0')}:00`,
                `2026-07-10 10:${String(index % 60).padStart(2, '0')}:00`
            );
        }
    })();
    StationModel.insert({
        platform: 'amap-fuel',
        stationName: '扩展导出加油站',
        stationType: 'fuel',
        providerName: '=cmd("provider")',
        providerEvidence: {
            kind: 'provider-attribution',
            text: '本服务由测试服务商提供',
            confidence: null,
            boundingBox: null,
        },
        sourceNode: '47-mysql',
        sourceRecordId: 9200,
        capturedAt: '2026-07-23T12:00:00.000Z',
        fuelOffers: [{
            fuelType: 'gasoline',
            gradeCode: '92',
            gradeLabel: '92#汽油',
            displayPrice: '6.6300',
            stationPrice: '7.8600',
            nationalPrice: '8.1200',
            discountKind: 'none',
            currency: 'CNY',
            unit: 'CNY_PER_LITER',
            fieldSource: {
                displayPrice: 'ocr',
                stationPrice: 'ocr',
                nationalPrice: 'ocr',
            },
            evidence: [{ kind: 'display-price' }],
            capturedAt: '2026-07-23T12:00:00.000Z',
        }],
        fuelQuotes: [{
            quoteObservationId: 'quote-export-1',
            quoteDedupKey: 'c'.repeat(64),
            gradeCode: '92',
            gradeLabel: '92#汽油',
            selectedAmount: '200.00',
            grossDiscount: '20.65',
            serviceFee: '3.30',
            netDiscount: '17.35',
            payableAmount: '182.65',
            quoteEntry: 'inline',
            needsReview: false,
            capturedAt: '2026-07-23T12:00:00.000Z',
            raw: {},
        }],
    });
});

test.after(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
});

test('CSV 导出不再受 1000 条最近查询上限影响', () => {
    const service = new StationExportService({ stationModel: StationModel, maxRows: 5000 });
    const prepared = service.prepare({ platform: 'didi-charging', limit: 2000 });
    assert.equal(prepared.totalRows, 1205);
    assert.equal(prepared.exportRows, 1205);
    assert.equal(prepared.truncated, false);
    const csv = Array.from(prepared.lines).join('');
    assert.equal(csv.split('\r\n').filter(Boolean).length, 1206);
    assert.match(csv, /'=cmd/);
    assert.match(csv, /"地址,一行\n二行"/);
});

test('CSV 单元格处理公式、引号、换行并明确截断', () => {
    assert.equal(escapeCsvCell(' =SUM(A1:A2)'), "' =SUM(A1:A2)");
    assert.equal(escapeCsvCell('a"b'), '"a""b"');
    assert.equal(escapeCsvCell('a,b'), '"a,b"');
    const service = new StationExportService({ stationModel: StationModel, maxRows: 100 });
    const prepared = service.prepare({ limit: 100 });
    assert.equal(prepared.exportRows, 100);
    assert.equal(prepared.truncated, true);
    assert.throws(() => service.prepare({ limit: 101 }), error => error.code === 'export_limit_invalid');
    assert.throws(() => service.prepare({ platform: '../secret' }), error => error.code === 'export_platform_invalid');
});

test('燃油扩展导出包含 provider、公共枪状态、规范 offers/quotes 和来源 Agent', () => {
    const service = new StationExportService({ stationModel: StationModel, maxRows: 100 });
    const legacy = Array.from(service.prepare({ platform: 'amap-fuel' }).lines).join('');
    const extended = Array.from(service.prepareFuelExtended({ platform: 'amap-fuel' }).lines).join('');

    assert.match(
        legacy.split('\r\n')[0],
        /Platform,Station ID,Station Name,Address,Available Ports,Busy Ports,Total Ports,Port Semantics,Missing Fields,Quality Status,Price Fast/
    );
    assert.equal(legacy.split('\r\n')[0].includes('Provider Name'), false);
    assert.match(extended.split('\r\n')[0], /Address,Available Ports,Busy Ports,Total Ports,Port Semantics,Missing Fields,Quality Status,Provider Name,Fuel Offers,Fuel Quotes/);
    assert.match(extended.split('\r\n')[0], /Source Agent/);
    assert.match(extended, /'=cmd\(\"\"provider\"\"\)/);
    assert.match(extended, /displayPrice/);
    assert.match(extended, /quoteObservationId/);
    assert.match(extended, /182\.65/);
});
