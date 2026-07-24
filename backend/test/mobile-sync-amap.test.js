'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const AmapOcrParser = require('../parser/amap-ocr-parser');
const MobileSyncService = require('../services/mobile-sync');

test('移动同步服务接受高德未登录页面记录并保持平台归属', () => {
    let inserted = [];
    const service = new MobileSyncService({
        parsers: { 'amap-charging': new AmapOcrParser() },
        supportedPlatforms: ['amap-charging'],
        insertStations: stations => {
            inserted = stations;
            return { successCount: 0, yellowCount: stations.length, redCount: 0, skipCount: 0 };
        }
    });

    const result = service.ingestStationPayload({
        platform: 'amap-charging',
        city: '西安',
        sessionId: 'amap-anonymous-test',
        sourceAgent: 'android-agent',
        _transport: { mobileAgent: 'android-agent', relayNode: '47-relay' },
        sourceStage: 'phone-auto-scroll',
        stations: [{
            platform: 'amap-charging',
            stationName: '比亚迪闪充汽车充电站(西安城市运动公园)',
            address: '西安城市运动公园东门',
            priceFast: 0.85,
            sourceType: 'mobile-ocr'
        }]
    });

    assert.equal(result.insertedCount, 1);
    assert.equal(result.reviewCount, 1);
    assert.equal(inserted.length, 1);
    assert.equal(inserted[0].platform, 'amap-charging');
    assert.equal(inserted[0].sourceType, 'mobile-ocr');
    assert.equal(inserted[0].sourceAgent, 'android-agent');
    assert.equal(inserted[0].raw.mobileSync.meta.city, '西安');
    assert.equal(inserted[0].raw.mobileSync.meta.relayNode, '47-relay');
    assert.equal(result.sourceAgent, 'android-agent');
    assert.equal(result.relayNode, '47-relay');
});

test('移动同步服务拒绝请求体与请求头不一致或非法的 Agent 来源', () => {
    const service = new MobileSyncService({
        supportedPlatforms: ['didi-charging'],
        insertStations: () => ({ successCount: 0, skipCount: 0 }),
    });
    const base = {
        platform: 'didi-charging',
        stations: [{ stationName: '测试充电站' }],
    };

    assert.throws(() => service.ingestStationPayload({
        ...base,
        sourceAgent: 'android-agent',
        _transport: { mobileAgent: 'ios-agent' },
    }), /does not match/);
    assert.throws(() => service.ingestStationPayload({
        ...base,
        sourceAgent: 'android',
    }), /invalid sourceAgent/);
});
