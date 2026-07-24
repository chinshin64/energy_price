'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const AmapOcrParser = require('../parser/amap-ocr-parser');

function row(text, x, y, width) {
    return { text, confidence: 1, boundingBox: { x, y, width, height: 0.035 } };
}

test('高德未登录双列卡片只提取场站列并保留基础字段', () => {
    const parser = new AmapOcrParser();
    const stations = parser.extractStations([
        row('比亚迪闪充汽车充电站(西安城市运动公园)', 0.04, 0.40, 0.43),
        row('充电站', 0.04, 0.45, 0.18),
        row('快充桩', 0.04, 0.49, 0.18),
        row('¥', 0.04, 0.53, 0.04),
        row('0.85', 0.09, 0.53, 0.10),
        row('/度', 0.20, 0.53, 0.08),
        row('西安城市运动公园东门 578米', 0.04, 0.58, 0.42),
        row('庭院江南菜北京烤鸭', 0.54, 0.40, 0.40),
        row('¥103/人', 0.54, 0.49, 0.20),
        row('星星充电汽车充电站(未央区银池广场充电站)', 0.54, 0.67, 0.42),
        row('¥0.64/度', 0.54, 0.77, 0.22)
    ], {
        platform: 'amap-charging',
        sourceType: 'mobile-ocr',
        sourceStage: 'phone-auto-scroll',
        city: '西安'
    });

    assert.equal(stations.length, 2);
    assert.equal(stations[0].platform, 'amap-charging');
    assert.equal(stations[0].priceFast, 0.85);
    assert.equal(stations[0].address, '西安城市运动公园东门');
    assert.equal(stations[0].raw.distanceMeters, 578);
    assert.equal(stations[1].priceFast, 0.64);
    assert.equal(stations[1].address, null);
});

test('高德 OCR 合并括号未闭合的两行场站名称', () => {
    const parser = new AmapOcrParser();
    const stations = parser.extractStations([
        row('奥迪汽车充电站(西安', 0.53, 0.56, 0.34),
        row('CITYON熙地港)', 0.53, 0.59, 0.25),
        row('充电站', 0.53, 0.62, 0.09),
        row('电¥0.94/度', 0.53, 0.66, 0.19)
    ], { platform: 'amap-charging', city: '西安' });

    assert.equal(stations.length, 1);
    assert.equal(stations[0].stationName, '奥迪汽车充电站(西安CITYON熙地港)');
    assert.equal(stations[0].priceFast, 0.94);
});
