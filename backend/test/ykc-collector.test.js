'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 临时数据库，避免污染开发库
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ykc-collect-test-'));
process.env.DATABASE_PATH = path.join(tempDir, 'stations.db');
process.env.DATA_ROOT = path.join(tempDir, 'data');
process.env.NODE_ENV = 'test';

const db = require('../database/init');
const StationModel = require('../models/station');
const YkcCollector = require('../services/ykc-collector');
const { createCollectRouter } = require('../routes/collect');

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

// ── 采集器单元测试：字段映射 ──

test('云快充 mapStation() 将 terminalCount 映射为各类型枪口(type1=super/type2=fast/type3=slow)', () => {
    const collector = new YkcCollector();
    const raw = {
        stationId: '450575',
        name: '逸安启超充-上海人民广场来福士',
        terminalCount: [{ total: 7, free: 7, type: 1 }],
        tags: ['480kW'],
        lng: '121.476002',
        lat: '31.232937',
        firstPrice: '1.4900',
        secondPrice: '1.2756'
    };
    const station = collector.mapStation(raw, { lat: 31.2304, lng: 121.4737 });
    assert.equal(station.platform, 'ykc');
    assert.equal(station.stationId, '450575');
    assert.equal(station.stationName, '逸安启超充-上海人民广场来福士');
    assert.equal(station.latitude, 31.232937);
    assert.equal(station.longitude, 121.476002);
    // type=1 -> 超充(super)
    assert.equal(station.superIdlePorts, 7);
    assert.equal(station.superTotalPorts, 7);
    assert.equal(station.fastIdlePorts, 0);
    assert.equal(station.slowIdlePorts, 0);
    assert.equal(station.priceFast, 1.49);
    assert.equal(station.priceService, 1.2756);
    assert.equal(station.sourceType, 'api-collector');
    assert.equal(station.sourceStage, 'ykc');
    assert.equal(station.availablePorts, 7);
    assert.equal(station.totalPorts, 7);
});

test('云快充 mapStation() 多类型 terminalCount 汇总(快充+慢充)', () => {
    const collector = new YkcCollector();
    // 特来电来福士: type2(快充) total20/free20 + type3(慢充) total44/free37
    const raw = {
        stationId: '2241',
        name: '特来电上海黄浦来福士广场充电站',
        terminalCount: [
            { total: 20, free: 20, type: 2 },
            { total: 44, free: 37, type: 3 }
        ],
        tags: ['60kW'],
        lng: '121.476615',
        lat: '31.232450',
        firstPrice: '1.9'
    };
    const station = collector.mapStation(raw);
    assert.equal(station.fastIdlePorts, 20, 'type2=fast 空闲');
    assert.equal(station.fastTotalPorts, 20);
    assert.equal(station.slowIdlePorts, 37, 'type3=slow 空闲');
    assert.equal(station.slowTotalPorts, 44);
    assert.equal(station.superIdlePorts, 0);
    assert.equal(station.availablePorts, 57);
    assert.equal(station.totalPorts, 64);
    assert.equal(station.operator, '特来电');
});

test('云快充 mapStation() 缺 terminalCount 时端口为 0', () => {
    const collector = new YkcCollector();
    const station = collector.mapStation({ stationId: 'X', name: '站X', lng: '1', lat: '2' });
    assert.equal(station.fastIdlePorts, 0);
    assert.equal(station.slowIdlePorts, 0);
    assert.equal(station.superIdlePorts, 0);
    assert.equal(station.availablePorts, 0);
    assert.equal(station.totalPorts, 0);
});

test('云快充 mapStation() 站点无坐标时回退查询坐标', () => {
    const collector = new YkcCollector();
    const station = collector.mapStation({ stationId: 'Y', name: '站Y' }, { lat: 31.23, lng: 121.47 });
    assert.equal(station.latitude, 31.23);
    assert.equal(station.longitude, 121.47);
});

test('云快充 extractOperator() 识别已知运营商前缀', () => {
    const collector = new YkcCollector();
    assert.equal(collector.extractOperator({ name: '特来电XX站' }), '特来电');
    assert.equal(collector.extractOperator({ name: '逸安启超充' }), '逸安启');
    assert.equal(collector.extractOperator({ name: '星星充电站' }), '星星充电');
    assert.equal(collector.extractOperator({ name: '未知站', source: 0 }), '逸安启');
    assert.equal(collector.extractOperator({ name: '未知站', source: 2 }), '特来电');
    assert.equal(collector.extractOperator({ name: '未知站' }), null);
});

// ── 路由 mock 测试：验证 agent-test 预算 + 入库 ──

// mock collector：不真实请求，直接返回固定结果
class MockYkcCollector {
    constructor() { this.platform = 'ykc'; }
    async collectByLocation(lat, lng, options = {}) {
        return {
            platform: 'ykc',
            endpoint: 'station/queryStationList',
            totalCount: 2,
            collectedCount: 2,
            stations: [
                {
                    platform: 'ykc',
                    stationId: 'MOCK-YKC-001',
                    stationName: '云快充测试超充站',
                    address: '测试地址1',
                    latitude: 31.23,
                    longitude: 121.47,
                    priceFast: 1.49,
                    priceService: 1.28,
                    fastIdlePorts: 0,
                    fastTotalPorts: 0,
                    slowIdlePorts: 0,
                    slowTotalPorts: 0,
                    superIdlePorts: 7,
                    superTotalPorts: 7,
                    onlineFastPorts: 7,
                    onlineSlowPorts: 0,
                    availablePorts: 7,
                    totalPorts: 7,
                    operator: '逸安启',
                    sourceType: 'api-collector',
                    sourceStage: 'ykc',
                    raw: { name: '云快充测试超充站', source: 'api-collector', sourceStage: 'ykc', platform: 'ykc' }
                },
                {
                    platform: 'ykc',
                    stationId: 'MOCK-YKC-002',
                    stationName: '云快充测试快充站',
                    address: '测试地址2',
                    latitude: 31.24,
                    longitude: 121.48,
                    priceFast: 1.9,
                    priceService: null,
                    fastIdlePorts: 20,
                    fastTotalPorts: 20,
                    slowIdlePorts: 37,
                    slowTotalPorts: 44,
                    superIdlePorts: 0,
                    superTotalPorts: 0,
                    onlineFastPorts: 20,
                    onlineSlowPorts: 37,
                    availablePorts: 57,
                    totalPorts: 64,
                    operator: '特来电',
                    sourceType: 'api-collector',
                    sourceStage: 'ykc',
                    raw: { name: '云快充测试快充站', source: 'api-collector', sourceStage: 'ykc', platform: 'ykc' }
                }
            ]
        };
    }
}

test('云快充路由 /ykc 在 agent-test 模式下成功采集并入库', async () => {
    const router = createCollectRouter({
        stationModel: StationModel,
        KuaidianCollector: class {},
        TeldCollector: class {},
        TuanyouCollector: class {},
        StarchargeCollector: class {},
        YkcCollector: MockYkcCollector,
        logger: () => {}
    });
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/collect', router);

    const req = mockExpressReq({
        lat: 31.2304,
        lng: 121.4737,
        city: '上海',
        cityId: '021',
        pageIndex: 1,
        pageSize: 10,
        mode: 'agent-test'
    });
    const res = mockExpressRes();
    const ykcRoute = router.stack.find(layer =>
        layer.route && layer.route.path === '/ykc' && layer.route.methods.post
    );
    assert.ok(ykcRoute, '应注册 /ykc POST 路由');
    const handler = ykcRoute.route.stack[0].handle;
    await new Promise((resolve) => {
        let resolved = false;
        const done = () => { if (!resolved) { resolved = true; resolve(); } };
        const origJson = res.json.bind(res);
        res.json = (data) => { const r = origJson(data); done(); return r; };
        res.status = (code) => { res._state.statusCode = code; return res; };
        handler(req, res, () => {});
        setTimeout(done, 2000);
    });

    assert.equal(res._state.ended, true, '路由应返回响应');
    assert.equal(res._state.statusCode, 200, '状态码应为 200');
    assert.equal(res._state.payload.success, true);
    assert.equal(res._state.payload.data.platform, 'ykc');
    assert.equal(res._state.payload.data.collectedCount, 2);
    assert.ok(res._state.payload.data.insertedCount >= 1, '应至少入库 1 条');
});

test('云快充路由 agent-test 模式下超过 5 次请求被限流(429)', async () => {
    const router = createCollectRouter({
        stationModel: StationModel,
        KuaidianCollector: class {},
        TeldCollector: class {},
        TuanyouCollector: class {},
        StarchargeCollector: class {},
        YkcCollector: MockYkcCollector,
        logger: () => {}
    });
    const ykcRoute = router.stack.find(layer =>
        layer.route && layer.route.path === '/ykc' && layer.route.methods.post
    );
    const handler = ykcRoute.route.stack[0].handle;

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

test('云快充路由缺 lat 参数返回 400', async () => {
    const router = createCollectRouter({
        stationModel: StationModel,
        KuaidianCollector: class {},
        TeldCollector: class {},
        TuanyouCollector: class {},
        StarchargeCollector: class {},
        YkcCollector: MockYkcCollector,
        logger: () => {}
    });
    const ykcRoute = router.stack.find(layer =>
        layer.route && layer.route.path === '/ykc' && layer.route.methods.post
    );
    const handler = ykcRoute.route.stack[0].handle;

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

test('入库后 stations 表 platform=ykc 有数据', () => {
    const rows = db.prepare('SELECT * FROM stations WHERE platform = ?').all('ykc');
    assert.ok(rows.length >= 2, 'ykc 平台应至少有 2 条记录');
    const first = rows[0];
    assert.equal(first.platform, 'ykc');
    assert.equal(first.source_type, 'api-collector');
    assert.equal(first.source_stage, 'ykc');
    // 端口字段应被填充
    const totalPorts = first.fast_total_ports + first.slow_total_ports + first.super_total_ports;
    assert.ok(totalPorts > 0, '端口总数应大于 0');
});
