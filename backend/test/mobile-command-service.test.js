'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const MobileCommandService = require('../services/mobile-command');

function assertClose(actual, expected, tolerance = 0.000001) {
    assert.ok(
        Math.abs(actual - expected) <= tolerance,
        `expected ${actual} to be within ${tolerance} of ${expected}`
    );
}

function withService(callback, options = {}) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blue-team-mobile-command-'));
    try {
        const service = new MobileCommandService({
            dataDir,
            countCityStats: () => ({ total: 0, distinct: 0 }),
            ...options,
        });
        return callback(service);
    } finally {
        fs.rmSync(dataDir, { recursive: true, force: true });
    }
}

test('collect_landmark 命令由服务端补齐地标坐标', () => withService(service => {
    const command = service.enqueueCommand({
        type: 'collect_landmark',
        payload: { city: '上海', keyword: '上海虹桥站' },
    });

    assert.equal(command.payload.city, '上海');
    assert.equal(command.payload.keyword, '上海虹桥站');
    assert.equal(command.payload.lat, 31.194);
    assert.equal(command.payload.lng, 121.318);
    assert.equal(command.payload.coordinateSystem, 'WGS84');
    assert.equal(command.payload.coordinateSource, 'operator_curated_landmark_table_v1');
}));

test('移动工作流自动推进时下发服务端配置地标坐标', () => withService(service => {
    service.startCityIncrementWorkflow({
        cities: ['西安'],
        targetIncrement: 100,
        pagesPerLandmark: 10,
    });

    const [command] = service.listCommands(1);
    assert.equal(command.type, 'collect_landmark');
    assert.equal(command.payload.city, '西安');
    assert.equal(command.payload.keyword, '西安凤城五路');
    assert.equal(command.payload.lat, 34.335);
    assert.equal(command.payload.lng, 108.947);
    assert.equal(command.payload.coordinateSystem, 'WGS84');
    assert.equal(command.payload.coordinateSource, 'operator_curated_landmark_table_v1');
}));

test('显式坐标优先于服务端预设坐标', () => withService(service => {
    const command = service.enqueueCommand({
        type: 'collect_landmark',
        payload: {
            city: '上海',
            keyword: '上海虹桥站',
            lat: 31.2,
            lng: 121.4,
            coordinateSystem: 'GCJ02',
        },
    });

    assertClose(command.payload.lat, 31.201849743434813);
    assertClose(command.payload.lng, 121.39535131951578);
    assert.equal(command.payload.coordinateSystem, 'WGS84');
    assert.equal(command.payload.inputLat, 31.2);
    assert.equal(command.payload.inputLng, 121.4);
    assert.equal(command.payload.inputCoordinateSystem, 'GCJ02');
    assert.equal(command.payload.coordinateTransform, 'GCJ02_TO_WGS84');
    assert.equal(command.payload.coordinateSource, 'explicit_payload');
}));

test('模拟定位命令必须携带有效经纬度并统一下发 WGS84 provider 坐标', () => withService(service => {
    const command = service.enqueueCommand({
        type: 'set_mock_location',
        payload: {
            city: '西安',
            keyword: '西安钟楼',
            lat: 34.261,
            lng: 108.9425,
            accuracy: 25,
            coordinateSystem: 'gcj02',
        },
    });

    assert.equal(command.type, 'set_mock_location');
    assert.equal(command.payload.city, '西安');
    assert.equal(command.payload.keyword, '西安钟楼');
    assertClose(command.payload.lat, 34.26258660615878);
    assertClose(command.payload.lng, 108.93784357350997);
    assert.equal(command.payload.accuracy, 25);
    assert.equal(command.payload.coordinateSystem, 'WGS84');
    assert.equal(command.payload.inputLat, 34.261);
    assert.equal(command.payload.inputLng, 108.9425);
    assert.equal(command.payload.inputCoordinateSystem, 'GCJ02');
    assert.equal(command.payload.coordinateTransform, 'GCJ02_TO_WGS84');
    assert.equal(command.payload.coordinateSource, 'operator_app_manual');

    const bd09Command = service.enqueueCommand({
        type: 'set_mock_location',
        payload: {
            city: '西安',
            keyword: '西安钟楼',
            lat: 34.267,
            lng: 108.949,
            coordinateSystem: 'BD09',
        },
    });

    assertClose(bd09Command.payload.lat, 34.26290380747167);
    assertClose(bd09Command.payload.lng, 108.93772880762592);
    assert.equal(bd09Command.payload.coordinateSystem, 'WGS84');
    assert.equal(bd09Command.payload.inputCoordinateSystem, 'BD09');
    assert.equal(bd09Command.payload.coordinateTransform, 'BD09_TO_GCJ02_TO_WGS84');

    const clearCommand = service.enqueueCommand({ type: 'clear_mock_location' });
    assert.equal(clearCommand.type, 'clear_mock_location');
    assert.deepEqual(clearCommand.payload, {});

    assert.throws(
        () => service.enqueueCommand({
            type: 'set_mock_location',
            payload: { city: '西安', lat: 0, lng: 0 },
        }),
        /valid lat\/lng/
    );
}));

test('移动地标配置覆盖每个工作流地标且未知地标失败关闭', () => withService(service => {
    const config = MobileCommandService.loadMobileLandmarkConfig();
    assert.equal(Object.keys(config.cities).length, 7);
    assert.equal(Object.values(config.cities).reduce((sum, city) => sum + city.landmarks.length, 0), 225);

    for (const [city, cityConfig] of Object.entries(config.cities)) {
        for (const landmark of cityConfig.landmarks) {
            const target = service.resolveLandmarkTarget(city, landmark.name);
            assert.equal(target.coordinateSource, 'operator_curated_landmark_table_v1');
            assert.ok(Number.isFinite(target.lat), `${city} ${landmark.name} lat`);
            assert.ok(Number.isFinite(target.lng), `${city} ${landmark.name} lng`);
        }
    }

    assert.throws(
        () => service.enqueueCommand({
            type: 'collect_landmark',
            payload: { city: '西安', keyword: '西安不存在地标' },
        }),
        /missing configured coordinates/
    );
}));

test('移动地标配置非法时服务启动失败关闭', () => {
    assert.throws(
        () => withService(() => {}, {
            landmarkConfig: {
                coordinateSystem: 'WGS84',
                cities: {
                    上海: {
                        center: { lat: 31.2304, lng: 121.4737 },
                        landmarks: [{ name: '上海错误地标', lat: 999, lng: 121.4 }],
                    },
                },
            },
        }),
        /invalid mobile landmark coordinate/
    );
});

test('设备在线状态只由心跳有效期判定', () => withService(service => {
    service.state.devices = [
        {
            id: 'dev-recent',
            deviceId: 'recent',
            commandServiceRunning: true,
            lastSeenAt: '2026-07-16T10:00:20.000Z',
        },
        {
            id: 'dev-stale',
            deviceId: 'stale',
            commandServiceRunning: true,
            lastSeenAt: '2026-07-16T09:58:00.000Z',
        },
    ];

    const devices = service.listDevices();
    assert.equal(devices[0].deviceId, 'recent');
    assert.equal(devices[0].online, true);
    assert.equal(devices[0].status, 'online');
    assert.equal(devices[0].lastSeenAgeMs, 10000);
    assert.equal(devices[1].online, false);
    assert.equal(devices[1].status, 'offline');
    assert.equal(service.getControlStatus().counts.onlineDevices, 1);
}, {
    deviceOnlineTtlMs: 30000,
    now: () => Date.parse('2026-07-16T10:00:30.000Z'),
}));
