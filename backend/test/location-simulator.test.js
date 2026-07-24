'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const LocationSimulator = require('../services/location-simulator');

function createSimulator(platform = 'darwin') {
    const calls = [];
    const simulator = new LocationSimulator({
        platform,
        execFile: (file, args, options) => {
            calls.push({ file, args, options });
            return Buffer.alloc(0);
        },
        sleep: () => {},
    });
    return { simulator, calls };
}

test('uses parameterized osascript calls for a valid city switch', () => {
    const { simulator, calls } = createSimulator();
    const result = simulator.setSimulatedLocation({
        city: '西安市',
        lat: 34.3416,
        lng: 108.9398,
        windowId: 12345,
        windowBounds: { X: 100, Y: 80, Width: 900, Height: 700 },
    });

    assert.equal(result.success, true);
    assert.equal(result.city, '西安市');
    assert.equal(calls.length, 4);
    assert.ok(calls.every(call => call.file === '/usr/bin/osascript'));
    assert.ok(calls.every(call => call.options.shell === undefined));
    assert.ok(calls.some(call => call.args.includes('西安市')));
});

test('rejects shell metacharacters before invoking the operating system', () => {
    const { simulator, calls } = createSimulator();
    const result = simulator.setSimulatedLocation({
        city: '西安$(touch injected)',
        windowId: 12345,
        windowBounds: { X: 100, Y: 80, Width: 900, Height: 700 },
    });

    assert.equal(result.success, false);
    assert.equal(result.reason, 'invalid_city');
    assert.equal(calls.length, 0);
});

test('rejects invalid coordinates and window bounds', () => {
    const { simulator, calls } = createSimulator();
    const invalidCoordinate = simulator.setSimulatedLocation({
        city: '西安市',
        lat: 91,
        lng: 108.9398,
        windowId: 12345,
        windowBounds: { X: 100, Y: 80, Width: 900, Height: 700 },
    });
    const invalidBounds = simulator.setSimulatedLocation({
        city: '西安市',
        windowId: 12345,
        windowBounds: { X: 100, Y: 80, Width: -1, Height: 700 },
    });

    assert.equal(invalidCoordinate.reason, 'invalid_latitude');
    assert.equal(invalidBounds.reason, 'invalid_window_bounds');
    assert.equal(calls.length, 0);
});

test('reports the macOS-only adapter as unavailable on other platforms', () => {
    const { simulator } = createSimulator('linux');
    assert.deepEqual(simulator.getStatus(), {
        currentLocation: null,
        available: false,
        capability: 'wechat_ui_city_switch',
    });
});
