'use strict';

const { execFileSync } = require('child_process');
const path = require('path');

const CITY_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}\s·._-]{0,63}$/u;
const MAX_SCREEN_COORDINATE = 100000;

function createInputError(code, message) {
    const error = new Error(message);
    error.code = code;
    error.statusCode = 400;
    return error;
}

function blockingSleep(ms) {
    const duration = Math.max(0, Math.floor(Number(ms) || 0));
    if (duration === 0) {
        return;
    }
    const state = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(state, 0, 0, duration);
}

class LocationSimulator {
    constructor(options = {}) {
        this.projectRoot = options.projectRoot || path.join(__dirname, '../..');
        this.scriptsDir = path.join(this.projectRoot, 'automation');
        this.currentLocation = null;
        this.execFile = options.execFile || execFileSync;
        this.sleep = options.sleep || blockingSleep;
        this.platform = options.platform || process.platform;
    }

    /**
     * 设置模拟定位坐标
     * 通过 JXA 自动化 WeChat 小程序 UI 来切换城市
     * 
     * 流程：
     * 1. 获取目标窗口信息
     * 2. 点击搜索框
     * 3. 输入城市名
     * 4. 选择搜索结果
     */
    setSimulatedLocation(options = {}) {
        const { city, lat, lng, windowId, windowBounds } = options;

        try {
            const normalizedCity = this.normalizeCity(city);
            const normalizedWindowId = this.normalizeWindowId(windowId);
            const bounds = this.normalizeWindowBounds(windowBounds);
            const coordinate = this.normalizeGeoCoordinate(lat, lng);
            const { X, Y, Width, Height } = bounds;

            // Step 1: Click on the search bar (middle-top of window)
            this._clickAt(X + Width * 0.5, Y + Height * 0.06);
            this._sleep(1500);

            // Step 2: Clear any existing text and type city name
            // Select all (Cmd+A) then type
            this._keyCombo('cmd', 'a');
            this._sleep(200);
            this._typeText(normalizedCity);
            this._sleep(2000);

            // Step 3: Click on the first search result
            this._clickAt(X + Width * 0.3, Y + Height * 0.22);
            this._sleep(1500);

            this.currentLocation = {
                city: normalizedCity,
                lat: coordinate?.lat ?? null,
                lng: coordinate?.lng ?? null,
                updatedAt: new Date().toISOString()
            };

            return {
                success: true,
                city: normalizedCity,
                method: 'jxa_search_automation',
                windowId: normalizedWindowId,
                bounds
            };
        } catch (error) {
            return {
                success: false,
                reason: error.code || 'automation_failed',
                error: error.message
            };
        }
    }

    /**
     * 通过搜索框切换城市（更可靠的路径）
     * 不依赖城市入口检测，直接操作搜索框
     */
    switchCityViaSearch(city, windowId, bounds) {
        const normalizedCity = this.normalizeCity(city);
        this.normalizeWindowId(windowId);
        const normalizedBounds = this.normalizeWindowBounds(bounds);
        const { X, Y, Width, Height } = normalizedBounds;

        // 1. Click search bar
        this._clickAt(X + Width * 0.5, Y + Height * 0.06);
        this._sleep(1000);

        // 2. Select all existing text
        this._keyCombo('cmd', 'a');
        this._sleep(200);

        // 3. Type city name
        this._typeText(normalizedCity);
        this._sleep(2000);

        // 4. Press Enter to search
        this._keyCombo('', 'return');
        this._sleep(1500);

        // 5. Click first result
        this._clickAt(X + Width * 0.3, Y + Height * 0.25);
        this._sleep(1000);

        return { success: true, city: normalizedCity, method: 'search_bar' };
    }

    /**
     * 点击"去授权"按钮开启定位
     */
    clickAuthorizeButton(windowId, bounds) {
        this.normalizeWindowId(windowId);
        const { X, Y, Width, Height } = this.normalizeWindowBounds(bounds);
        // "去授权>" typically at right side of the permission prompt
        this._clickAt(X + Width * 0.72, Y + Height * 0.13);
        this._sleep(2000);
        return { success: true };
    }

    getStatus() {
        return {
            currentLocation: this.currentLocation,
            available: this.platform === 'darwin',
            capability: 'wechat_ui_city_switch'
        };
    }

    normalizeCity(value) {
        const city = String(value || '').trim();
        if (!city) {
            throw createInputError('city_required', 'city is required');
        }
        if (!CITY_PATTERN.test(city)) {
            throw createInputError('invalid_city', 'city contains unsupported characters or exceeds 64 characters');
        }
        return city;
    }

    normalizeWindowId(value) {
        const windowId = Number(value);
        if (!Number.isSafeInteger(windowId) || windowId <= 0) {
            throw createInputError('window_info_required', 'windowId must be a positive integer');
        }
        return windowId;
    }

    normalizeWindowBounds(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            throw createInputError('window_info_required', 'windowBounds is required');
        }
        const bounds = {
            X: Number(value.X ?? value.x),
            Y: Number(value.Y ?? value.y),
            Width: Number(value.Width ?? value.width),
            Height: Number(value.Height ?? value.height)
        };
        const values = Object.values(bounds);
        if (values.some(item => !Number.isFinite(item) || Math.abs(item) > MAX_SCREEN_COORDINATE)) {
            throw createInputError('invalid_window_bounds', 'windowBounds must contain finite screen coordinates');
        }
        if (bounds.Width <= 0 || bounds.Height <= 0) {
            throw createInputError('invalid_window_bounds', 'window width and height must be positive');
        }
        return bounds;
    }

    normalizeGeoCoordinate(lat, lng) {
        const latMissing = lat === undefined || lat === null || lat === '';
        const lngMissing = lng === undefined || lng === null || lng === '';
        if (latMissing && lngMissing) {
            return null;
        }
        const normalizedLat = Number(lat);
        const normalizedLng = Number(lng);
        if (!Number.isFinite(normalizedLat) || normalizedLat < -90 || normalizedLat > 90) {
            throw createInputError('invalid_latitude', 'lat must be between -90 and 90');
        }
        if (!Number.isFinite(normalizedLng) || normalizedLng < -180 || normalizedLng > 180) {
            throw createInputError('invalid_longitude', 'lng must be between -180 and 180');
        }
        return { lat: normalizedLat, lng: normalizedLng };
    }

    // --- Low-level helpers ---

    _clickAt(x, y) {
        const normalizedX = Number(x);
        const normalizedY = Number(y);
        if (
            !Number.isFinite(normalizedX)
            || !Number.isFinite(normalizedY)
            || Math.abs(normalizedX) > MAX_SCREEN_COORDINATE
            || Math.abs(normalizedY) > MAX_SCREEN_COORDINATE
        ) {
            throw createInputError('invalid_click_coordinate', 'click coordinates must be finite screen coordinates');
        }
        const script = `
            ObjC.import("Cocoa");
            function run(argv) {
                const x = Number(argv[0]);
                const y = Number(argv[1]);
                const src = $.CGEventSourceCreate($.kCGEventSourceStateHIDSystemState);
                const down = $.CGEventCreateMouseEvent(src, $.kCGEventLeftMouseDown, $.CGPointMake(x, y), $.kCGMouseButtonLeft);
                const up = $.CGEventCreateMouseEvent(src, $.kCGEventLeftMouseUp, $.CGPointMake(x, y), $.kCGMouseButtonLeft);
                $.CGEventPost($.kCGHIDEventTap, down);
                $.CGEventPost($.kCGHIDEventTap, up);
            }
        `;
        this.execFile('/usr/bin/osascript', [
            '-l', 'JavaScript', '-e', script, String(normalizedX), String(normalizedY)
        ], { stdio: 'pipe', timeout: 5000 });
    }

    _typeText(text) {
        const normalizedText = this.normalizeCity(text);
        const script = [
            'on run argv',
            'set the clipboard to item 1 of argv',
            'tell application "System Events" to keystroke "v" using command down',
            'end run'
        ].join('\n');
        this.execFile('/usr/bin/osascript', ['-e', script, normalizedText], {
            stdio: 'pipe',
            timeout: 3000
        });
    }

    _keyCombo(modifier, key) {
        let script;
        if (modifier === 'cmd' && key === 'a') {
            script = 'tell application "System Events" to keystroke "a" using command down';
        } else if (!modifier && key === 'return') {
            script = 'tell application "System Events" to key code 36';
        } else {
            throw createInputError('invalid_key_action', 'unsupported keyboard action');
        }
        this.execFile('/usr/bin/osascript', ['-e', script], { stdio: 'pipe', timeout: 3000 });
    }

    _sleep(ms) {
        this.sleep(ms);
    }
}

module.exports = LocationSimulator;
