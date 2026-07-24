'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { MobileSourceNodeService } = require('../services/mobile-source-node-service');
const { StationExportService } = require('../services/station-export-service');

const projectRoot = path.resolve(__dirname, '../..');
const matrixPath = path.join(__dirname, 'fixtures/cross-platform-ocr-evidence-matrix.json');

function readJson(relativePath) {
    return JSON.parse(fs.readFileSync(path.join(projectRoot, relativePath), 'utf8'));
}

function transport(sourceAgent, suffix) {
    return {
        mobileAgent: sourceAgent,
        idempotencyKey: suffix.repeat(64),
        remoteAddress: '127.0.0.1',
        userAgent: 'completion-audit/1.0',
    };
}

test('completion audit matrix has exactly eight traceable requirements', () => {
    const matrix = JSON.parse(fs.readFileSync(matrixPath, 'utf8'));
    assert.equal(matrix.schemaVersion, 1);
    assert.deepEqual(
        matrix.requirements.map(item => item.id),
        [
            'android',
            'ios',
            'ocr_fields',
            'local_display',
            'per_capture_upload',
            'source_47',
            'main_product_merge',
            'source_agent',
        ]
    );
    assert.equal(new Set(matrix.requirements.map(item => item.id)).size, 8);

    for (const requirement of matrix.requirements) {
        assert.ok(requirement.implementationEvidence.length > 0, requirement.id);
        assert.ok(requirement.testEvidence.length > 0, requirement.id);
        assert.equal(requirement.externalEvidence.status, 'missing', requirement.id);
        assert.ok(requirement.externalEvidence.required.length > 0, requirement.id);
        for (const evidence of [
            ...requirement.implementationEvidence,
            ...requirement.testEvidence,
        ]) {
            const absolute = path.join(projectRoot, evidence.path);
            assert.equal(fs.statSync(absolute).isFile(), true, evidence.path);
            const source = fs.readFileSync(absolute, 'utf8');
            for (const marker of evidence.contains) {
                assert.equal(
                    source.includes(marker),
                    true,
                    `${evidence.path} must contain ${marker}`
                );
            }
        }
    }
});

test('default-disabled 47 contract accepts ordinary iOS v3 fixtures and rejects extended fuel', async () => {
    const store = {
        async health() {
            return true;
        },
    };
    const service = new MobileSourceNodeService({ store });
    const health = await service.health();
    const feature = health.capabilities.features['fuel-quote-v1'];
    assert.equal(feature.enabled, false);

    const charging = readJson('mobile/ios/Fixtures/ios-v3-charging.json');
    const normalizedCharging = service.normalizeBatch(
        charging,
        transport('ios-ocr-agent', 'a')
    );
    assert.equal(normalizedCharging.sourceAgent, 'ios-ocr-agent');
    assert.equal(normalizedCharging.stations[0].stationName, '小桔充电西安软件新城充电站');
    assert.equal(normalizedCharging.stations[0].address, '陕西省西安市雁塔区云水一路88号停车场');
    assert.equal(normalizedCharging.stations[0].availablePorts, 6);
    assert.equal(normalizedCharging.stations[0].busyPorts, 8);
    assert.equal(normalizedCharging.stations[0].totalPorts, 14);
    assert.equal(normalizedCharging.stations[0].priceFast, 0.85);

    const ordinaryFuel = readJson('mobile/ios/Fixtures/ios-v3-fuel-basic.json');
    const normalizedFuel = service.normalizeBatch(
        ordinaryFuel,
        transport('ios-ocr-agent', 'b')
    );
    assert.equal(normalizedFuel.sourceAgent, 'ios-ocr-agent');
    assert.equal(normalizedFuel.stations[0].stationName, '中石化西安普通报价加油站');
    assert.equal(normalizedFuel.stations[0].address, '陕西省西安市雁塔区科技路20号');
    assert.equal(normalizedFuel.stations[0].fuelOffers[0].gradeCode, '95');
    assert.equal(normalizedFuel.stations[0].fuelOffers[0].discountPrice, 7.18);

    const extendedFuel = readJson('mobile/ios/Fixtures/ios-v3-fuel-extended.json');
    assert.throws(
        () => service.normalizeBatch(extendedFuel, transport('ios-ocr-agent', 'c')),
        error => error.code === 'mobile_source_feature_disabled'
    );
});

test('main-product CSV projection preserves both controlled mobile source agents', () => {
    const rows = [
        {
            platform: 'didi-charging',
            station_id: 'android-1',
            station_name: 'Android审计充电站',
            source_agent: 'android-ocr-agent',
            collected_at: '2026-07-24 10:00:00',
        },
        {
            platform: 'didi-charging',
            station_id: 'ios-1',
            station_name: 'iOS审计充电站',
            source_agent: 'ios-ocr-agent',
            collected_at: '2026-07-24 10:01:00',
        },
    ];
    const service = new StationExportService({
        stationModel: {
            countSnapshotsForExport() {
                return rows.length;
            },
            *iterateSnapshotsForExport() {
                yield* rows;
            },
        },
        maxRows: 10,
    });
    const csv = Array.from(service.prepare({ limit: 10 }).lines).join('');
    assert.match(csv, /Source Agent/);
    assert.match(csv, /android-ocr-agent/);
    assert.match(csv, /ios-ocr-agent/);
});
