'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 临时数据库，避免污染开发库
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tuanyou-collect-test-'));
process.env.DATABASE_PATH = path.join(tempDir, 'stations.db');
process.env.DATA_ROOT = path.join(tempDir, 'data');
process.env.NODE_ENV = 'test';

const db = require('../database/init');
const StationModel = require('../models/station');
const TuanyouCollector = require('../services/tuanyou-collector');
const { createCollectRouter } = require('../routes/collect');

const TEST_CREDENTIALS = Object.freeze({
    appKey: 'unit-test-key',
    appSecret: 'unit-test-secret',
    host: 'https://example.invalid',
    userAgent: 'unit-test-agent',
    referer: 'https://example.invalid/',
    shumeiID: 'unit-test-device-signal',
    mpVersion: '0.0-test',
    token: '',
    fromScanCode: '',
});

function configuredCollector(options = {}) {
    return new TuanyouCollector({
        ...TEST_CREDENTIALS,
        ...options,
    });
}

// 使用 mock express 对象，避免起真实 http server
function mockExpressReq(body = {}) {
    return { body, requestId: 'test-req-' + Math.random().toString(36).slice(2) };
}

function mockExpressRes() {
    const state = { statusCode: 200, payload: null, ended: false };
    return {
        status(code) { state.statusCode = code; return this; },
        json(data) { state.payload = data; state.ended = true; return this; },
        _state: state
    };
}

test.after(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
});

// ── 采集器单元测试：签名/参数/字段映射 ──

test('团油 sign() 与快电同构：MD5(appSecret+sorted(kv)+appSecret).toLowerCase()', () => {
    const collector = configuredCollector();
    const params = { app_key: TEST_CREDENTIALS.appKey, timestamp: '1783907204237', token: '', oilNo: '92' };
    const sig = collector.sign(params);
    // 手工复算
    const sorted = Object.keys(params).sort().map(k => `${k}${params[k]}`).join('');
    const crypto = require('crypto');
    const expected = crypto.createHash('md5')
        .update(`${TEST_CREDENTIALS.appSecret}${sorted}${TEST_CREDENTIALS.appSecret}`, 'utf8')
        .digest('hex').toLowerCase();
    assert.equal(sig, expected);
    assert.equal(sig, sig.toLowerCase(), '签名应为小写');
});

test('团油 buildSignedParams() 注入公共参数 app_key/timestamp/token/shumeiID/fromScanCode/mp_version', () => {
    const collector = configuredCollector();
    const params = collector.buildSignedParams({ oilNo: '92', userLatStr: '39.9' });
    assert.equal(params.app_key, TEST_CREDENTIALS.appKey);
    assert.ok(params.timestamp.length >= 13, 'timestamp 应为毫秒字符串');
    assert.equal(params.token, '');
    assert.ok(params.shumeiID.length > 0, 'shumeiID 应有值');
    assert.equal(params.fromScanCode, '');
    assert.ok(params.mp_version.length > 0);
    assert.ok(params.sign.length === 32, 'sign 应为 32 位 md5');
    // sign 不应参与自身签名
    const crypto = require('crypto');
    const { sign, ...rest } = params;
    const sorted = Object.keys(rest).sort().map(k => `${k}${rest[k]}`).join('');
    const expected = crypto.createHash('md5')
        .update(`${TEST_CREDENTIALS.appSecret}${sorted}${TEST_CREDENTIALS.appSecret}`, 'utf8')
        .digest('hex').toLowerCase();
    assert.equal(sign, expected);
});

test('团油 mapStation() 将 gasInfoList 项映射为 StationModel 字段(含油价)', () => {
    const collector = new TuanyouCollector();
    const raw = {
        gasId: 'WP000003536',
        gasName: '旺平东加油站',
        gasAddress: '某路口',
        gasAddressLongitude: 116.546623,
        gasAddressLatitude: 39.950062,
        distance: 1.5,
        oilNo: 92,
        oilName: '92#',
        price1: '7.18',
        price2: '6.63',
        gunPrice: '7.18',
        price2BigDecimal: 6.63
    };
    const station = collector.mapStation(raw, '92');
    assert.equal(station.platform, 'tuanyou');
    assert.equal(station.stationId, 'WP000003536');
    assert.equal(station.stationName, '旺平东加油站');
    assert.equal(station.address, '某路口');
    assert.equal(station.latitude, 39.950062);
    assert.equal(station.longitude, 116.546623);
    assert.equal(station.fuel92Price, 6.63, '92# 优惠价应映射到 fuel92Price');
    assert.equal(station.fuel95Price, null);
    assert.equal(station.fuel98Price, null);
    assert.equal(station.fuelDieselPrice, null);
    assert.equal(station.sourceType, 'api-collector');
    assert.equal(station.sourceStage, 'tuanyou');
    assert.equal(station.availablePorts, 0, '加油平台端口数为 0');
});

test('团油 mapStation() 按 oilNo 映射到对应油价字段(95#/98#/柴油)', () => {
    const collector = new TuanyouCollector();
    const s95 = collector.mapStation({
        gasName: '站A', gasAddress: '址', gasAddressLongitude: 1, gasAddressLatitude: 2,
        oilNo: 95, price1: '7.8', price2: '7.3'
    }, '95');
    assert.equal(s95.fuel95Price, 7.3);
    assert.equal(s95.fuel92Price, null);

    const s98 = collector.mapStation({
        gasName: '站B', gasAddress: '址', gasAddressLongitude: 1, gasAddressLatitude: 2,
        oilNo: 98, price1: '8.5', price2: '8.0'
    }, '98');
    assert.equal(s98.fuel98Price, 8.0);

    const sDiesel = collector.mapStation({
        gasName: '站C', gasAddress: '址', gasAddressLongitude: 1, gasAddressLatitude: 2,
        oilNo: 0, price1: '7.5', price2: '7.1'
    }, '0');
    assert.equal(sDiesel.fuelDieselPrice, 7.1);
});

test('团油 mapStation() gasId 为 null 时回退 channelGasId 或 gasName 前缀', () => {
    const collector = new TuanyouCollector();
    const station = collector.mapStation({
        gasId: null,
        gasName: 'AJ423578934_中国国际能源朝平加油站',
        gasAddress: '黄杉木店路',
        gasAddressLongitude: 116.527348,
        gasAddressLatitude: 39.924043,
        oilNo: 92,
        price1: '7.18',
        price2: '6.68'
    }, '92');
    // gasId=null + channelGasId 不存在 -> 用 gasName 前缀 AJ423578934
    assert.equal(station.stationId, 'AJ423578934');
    assert.equal(station.stationName, 'AJ423578934_中国国际能源朝平加油站');
    assert.equal(station.fuel92Price, 6.68);
});

test('团油 oilNoToKey() 识别 92/95/98/0#', () => {
    const collector = new TuanyouCollector();
    assert.equal(collector.oilNoToKey('92'), 'fuel92Price');
    assert.equal(collector.oilNoToKey('92#'), 'fuel92Price');
    assert.equal(collector.oilNoToKey('95'), 'fuel95Price');
    assert.equal(collector.oilNoToKey('98#'), 'fuel98Price');
    assert.equal(collector.oilNoToKey('0'), 'fuelDieselPrice');
    assert.equal(collector.oilNoToKey('柴油'), 'fuelDieselPrice');
    assert.equal(collector.oilNoToKey('未知'), null);
});

// ── 路由 mock 测试：验证 agent-test 预算 + 入库 ──

// mock collector：不真实请求，直接返回固定结果
class MockTuanyouCollector {
    constructor() { this.platform = 'tuanyou'; }
    async collectByLocation(lat, lng, options = {}) {
        return {
            platform: 'tuanyou',
            endpoint: 'gas/mapGasInfoListPage/4.0',
            oilNo: options.oilNo || '92',
            totalCount: 2,
            collectedCount: 2,
            stations: [
                {
                    platform: 'tuanyou',
                    stationId: 'MOCK-001',
                    stationName: '团油测试站1',
                    address: '测试地址1',
                    latitude: 31.23,
                    longitude: 121.47,
                    fuel92Price: 6.68,
                    fuel95Price: null,
                    fuel98Price: null,
                    fuelDieselPrice: null,
                    operator: '测试运营商',
                    sourceType: 'api-collector',
                    sourceStage: 'tuanyou',
                    raw: { stationName: '团油测试站1', source: 'api-collector', sourceStage: 'tuanyou', platform: 'tuanyou' }
                },
                {
                    platform: 'tuanyou',
                    stationId: 'MOCK-002',
                    stationName: '团油测试站2',
                    address: '测试地址2',
                    latitude: 31.24,
                    longitude: 121.48,
                    fuel92Price: 6.33,
                    fuel95Price: null,
                    fuel98Price: null,
                    fuelDieselPrice: null,
                    operator: null,
                    sourceType: 'api-collector',
                    sourceStage: 'tuanyou',
                    raw: { stationName: '团油测试站2', source: 'api-collector', sourceStage: 'tuanyou', platform: 'tuanyou' }
                }
            ]
        };
    }
}

test('团油路由 /tuanyou 在 agent-test 模式下成功采集并入库', async () => {
    const router = createCollectRouter({
        stationModel: StationModel,
        KuaidianCollector: class {},
        TeldCollector: class {},
        TuanyouCollector: MockTuanyouCollector,
        logger: () => {}
    });
    // 直接调用 router.handle 不便，改为构造 express app 测试
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/collect', router);

    const req = mockExpressReq({
        lat: 31.2304,
        lng: 121.4737,
        city: '上海',
        oilNo: '92',
        pageIndex: 1,
        pageSize: 10,
        mode: 'agent-test'
    });
    const res = mockExpressRes();
    // 找到 /tuanyou 的 route handler
    const tuanyouRoute = router.stack.find(layer =>
        layer.route && layer.route.path === '/tuanyou' && layer.route.methods.post
    );
    assert.ok(tuanyouRoute, '应注册 /tuanyou POST 路由');
    const handler = tuanyouRoute.route.stack[0].handle;
    await new Promise((resolve) => {
        let resolved = false;
        const done = () => { if (!resolved) { resolved = true; resolve(); } };
        // mock res 结束后 done
        const origJson = res.json.bind(res);
        res.json = (data) => { const r = origJson(data); done(); return r; };
        res.status = (code) => { res._state.statusCode = code; return res; };
        handler(req, res, () => {});
        // 兜底
        setTimeout(done, 2000);
    });

    assert.equal(res._state.ended, true, '路由应返回响应');
    assert.equal(res._state.statusCode, 200, '状态码应为 200');
    assert.equal(res._state.payload.success, true);
    assert.equal(res._state.payload.data.platform, 'tuanyou');
    assert.equal(res._state.payload.data.collectedCount, 2);
    assert.ok(res._state.payload.data.insertedCount >= 1, '应至少入库 1 条');
});

test('团油路由 agent-test 模式下超过 5 次请求被限流(429)', async () => {
    const router = createCollectRouter({
        stationModel: StationModel,
        KuaidianCollector: class {},
        TeldCollector: class {},
        TuanyouCollector: MockTuanyouCollector,
        logger: () => {}
    });
    const tuanyouRoute = router.stack.find(layer =>
        layer.route && layer.route.path === '/tuanyou' && layer.route.methods.post
    );
    const handler = tuanyouRoute.route.stack[0].handle;

    const runOnce = () => {
        const req = mockExpressReq({ lat: 31.23, lng: 121.47, mode: 'agent-test' });
        const res = mockExpressRes();
        const origJson = res.json.bind(res);
        return new Promise((resolve) => {
            res.json = (data) => { const r = origJson(data); resolve({ res, req }); return r; };
            res.status = (code) => { res._state.statusCode = code; return res; };
            handler(req, res, () => resolve({ res, req }));
        });
    };

    // 前 5 次应成功
    for (let i = 0; i < 5; i++) {
        const { res } = await runOnce();
        assert.equal(res._state.statusCode, 200, `第 ${i + 1} 次应成功`);
    }
    // 第 6 次应被限流
    const { res } = await runOnce();
    assert.equal(res._state.statusCode, 429, '第 6 次应被限流 429');
    assert.equal(res._state.payload.code, 'AGENT_TEST_REQUEST_LIMIT_EXCEEDED');
});

test('团油路由缺 lat 参数返回 400', async () => {
    const router = createCollectRouter({
        stationModel: StationModel,
        KuaidianCollector: class {},
        TeldCollector: class {},
        TuanyouCollector: MockTuanyouCollector,
        logger: () => {}
    });
    const tuanyouRoute = router.stack.find(layer =>
        layer.route && layer.route.path === '/tuanyou' && layer.route.methods.post
    );
    const handler = tuanyouRoute.route.stack[0].handle;

    const req = mockExpressReq({ lng: 121.47, mode: 'agent-test' }); // 缺 lat
    const res = mockExpressRes();
    await new Promise((resolve) => {
        res.json = (data) => { res._state.payload = data; resolve(); return res; };
        res.status = (code) => { res._state.statusCode = code; return res; };
        handler(req, res, () => resolve());
    });
    assert.equal(res._state.statusCode, 400);
    assert.equal(res._state.payload.code, 'invalid_lat');
});

test('入库后 stations 表 platform=tuanyou 有数据', () => {
    const rows = db.prepare('SELECT * FROM stations WHERE platform = ?').all('tuanyou');
    assert.ok(rows.length >= 2, 'tuanyou 平台应至少有 2 条记录');
    const first = rows[0];
    assert.equal(first.platform, 'tuanyou');
    assert.equal(first.source_type, 'api-collector');
    assert.equal(first.source_stage, 'tuanyou');
    // 油价字段应被填充
    assert.ok(first.fuel_92_price !== null, 'fuel_92_price 应有值');
});
