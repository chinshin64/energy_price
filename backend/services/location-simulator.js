'use strict';

const { execFileSync, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

class LocationSimulator {
    constructor(options = {}) {
        this.projectRoot = options.projectRoot || path.join(__dirname, '../..');
        this.scriptsDir = path.join(this.projectRoot, 'automation');
        this.currentLocation = null;
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
        
        if (!city) {
            return { success: false, reason: 'city_required' };
        }

        if (!windowId || !windowBounds) {
            return { success: false, reason: 'window_info_required' };
        }

        const { X, Y, Width, Height } = windowBounds;

        try {
            // Step 1: Click on the search bar (middle-top of window)
            this._clickAt(X + Width * 0.5, Y + Height * 0.06);
            this._sleep(1500);

            // Step 2: Clear any existing text and type city name
            // Select all (Cmd+A) then type
            this._keyCombo('cmd', 'a');
            this._sleep(200);
            this._typeText(city);
            this._sleep(2000);

            // Step 3: Click on the first search result
            this._clickAt(X + Width * 0.3, Y + Height * 0.22);
            this._sleep(1500);

            this.currentLocation = { city, lat, lng, updatedAt: new Date().toISOString() };

            return {
                success: true,
                city,
                method: 'jxa_search_automation',
                windowId,
                bounds: windowBounds
            };
        } catch (error) {
            return {
                success: false,
                reason: 'automation_failed',
                error: error.message
            };
        }
    }

    /**
     * 通过搜索框切换城市（更可靠的路径）
     * 不依赖城市入口检测，直接操作搜索框
     */
    switchCityViaSearch(city, windowId, bounds) {
        const { X, Y, Width, Height } = bounds;

        // 1. Click search bar
        this._clickAt(X + Width * 0.5, Y + Height * 0.06);
        this._sleep(1000);

        // 2. Select all existing text
        this._keyCombo('cmd', 'a');
        this._sleep(200);

        // 3. Type city name
        this._typeText(city);
        this._sleep(2000);

        // 4. Press Enter to search
        this._keyCombo('', 'return');
        this._sleep(1500);

        // 5. Click first result
        this._clickAt(X + Width * 0.3, Y + Height * 0.25);
        this._sleep(1000);

        return { success: true, city, method: 'search_bar' };
    }

    /**
     * 点击"去授权"按钮开启定位
     */
    clickAuthorizeButton(windowId, bounds) {
        const { X, Y, Width, Height } = bounds;
        // "去授权>" typically at right side of the permission prompt
        this._clickAt(X + Width * 0.72, Y + Height * 0.13);
        this._sleep(2000);
        return { success: true };
    }

    getStatus() {
        return {
            currentLocation: this.currentLocation,
            available: true
        };
    }

    // --- Low-level helpers ---

    _clickAt(x, y) {
        execSync(`osascript -l JavaScript -e '
            ObjC.import("Cocoa");
            var src = $.CGEventSourceCreate($.kCGEventSourceStateHIDSystemState);
            var down = $.CGEventCreateMouseEvent(src, $.kCGEventLeftMouseDown, $.CGPointMake(${x}, ${y}), $.kCGMouseButtonLeft);
            var up = $.CGEventCreateMouseEvent(src, $.kCGEventLeftMouseUp, $.CGPointMake(${x}, ${y}), $.kCGMouseButtonLeft);
            $.CGEventPost($.kCGHIDEventTap, down);
            $.CGEventPost($.kCGHIDEventTap, up);
        '`, { stdio: 'pipe', timeout: 5000 });
    }

    _typeText(text) {
        // Use clipboard for reliable text input
        execSync(`osascript -e 'set the clipboard to "${text.replace(/"/g, '\\"')}"'`, { stdio: 'pipe', timeout: 3000 });
        this._sleep(100);
        execSync(`osascript -e 'tell application "System Events" to keystroke "v" using command down'`, { stdio: 'pipe', timeout: 3000 });
    }

    _keyCombo(modifier, key) {
        let cmd = 'osascript -e \'tell application "System Events"';
        if (modifier === 'cmd') {
            cmd += ` to keystroke "${key}" using command down`;
        } else {
            cmd += ` to key code ${key === 'return' ? 36 : 36}`;
        }
        cmd += "'";
        execSync(cmd, { stdio: 'pipe', timeout: 3000 });
    }

    _sleep(ms) {
        execSync(`sleep ${Math.ceil(ms / 1000)}`, { stdio: 'pipe', timeout: ms + 2000 });
    }
}

module.exports = LocationSimulator;
