#!/bin/bash

SCROLL_COUNT=${1:-10}
SCROLL_INTERVAL=${2:-8}

export AUTO_SCROLL_COUNT="$SCROLL_COUNT"
export AUTO_SCROLL_INTERVAL="$SCROLL_INTERVAL"

osascript -l JavaScript <<'EOF'
ObjC.import('Cocoa');
ObjC.import('ApplicationServices');

function mouseEvent(type, x, y) {
    const point = $.CGPointMake(x, y);
    const event = $.CGEventCreateMouseEvent(null, type, point, $.kCGMouseButtonLeft);
    $.CGEventPost($.kCGHIDEventTap, event);
}

function keyboardTap(keyCode, flags) {
    const down = $.CGEventCreateKeyboardEvent(null, keyCode, true);
    const up = $.CGEventCreateKeyboardEvent(null, keyCode, false);
    if (flags) {
        $.CGEventSetFlags(down, flags);
        $.CGEventSetFlags(up, flags);
    }
    $.CGEventPost($.kCGHIDEventTap, down);
    $.CGEventPost($.kCGHIDEventTap, up);
}

function moveTo(x, y) {
    mouseEvent($.kCGEventMouseMoved, x, y);
}

function clickAt(x, y) {
    moveTo(x, y);
    delay(0.05);
    mouseEvent($.kCGEventLeftMouseDown, x, y);
    delay(0.04);
    mouseEvent($.kCGEventLeftMouseUp, x, y);
}

function drag(fromX, fromY, toX, toY, steps) {
    moveTo(fromX, fromY);
    delay(0.05);
    mouseEvent($.kCGEventLeftMouseDown, fromX, fromY);
    delay(0.08);

    for (let i = 1; i <= steps; i++) {
        const progress = i / steps;
        const eased = 1 - Math.pow(1 - progress, 2);
        const x = Math.round(fromX + (toX - fromX) * eased);
        const y = Math.round(fromY + (toY - fromY) * eased);
        mouseEvent($.kCGEventLeftMouseDragged, x, y);
        delay(0.012);
    }

    delay(0.05);
    mouseEvent($.kCGEventLeftMouseUp, toX, toY);
}

function randomOffset(size) {
    return Math.floor(Math.random() * (size * 2 + 1)) - size;
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function readContext() {
    const env = $.NSProcessInfo.processInfo.environment;
    const encoded = ObjC.unwrap(env.objectForKey('AUTO_SCROLL_CONTEXT_BASE64') || '');
    if (!encoded) {
        return {};
    }

    const data = $.NSData.alloc.initWithBase64EncodedStringOptions($(encoded), 0);
    if (!data) {
        return {};
    }

    const decoded = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding);
    const raw = decoded ? ObjC.unwrap(decoded) : '';
    if (!raw) {
        return {};
    }

    try {
        return JSON.parse(raw);
    } catch (error) {
        return {};
    }
}

function readNumberEnv(name, fallbackValue) {
    const env = $.NSProcessInfo.processInfo.environment;
    const raw = ObjC.unwrap(env.objectForKey(name) || '');
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : fallbackValue;
}

function setClipboardText(text) {
    const pasteboard = $.NSPasteboard.generalPasteboard;
    pasteboard.clearContents;
    pasteboard.setStringForType($(String(text || '')), $.NSPasteboardTypeString);
}

function buildFrame(window) {
    const position = window.position();
    const size = window.size();
    return {
        left: position[0],
        top: position[1],
        width: size[0],
        height: size[1]
    };
}

function frameFromBounds(bounds) {
    if (!bounds) {
        return null;
    }
    const left = Number(bounds.X);
    const top = Number(bounds.Y);
    const width = Number(bounds.Width);
    const height = Number(bounds.Height);
    if (!Number.isFinite(left) || !Number.isFinite(top)
        || !Number.isFinite(width) || !Number.isFinite(height)
        || width <= 0 || height <= 0) {
        return null;
    }
    return { left, top, width, height };
}

function pointFromRatio(frame, xRatio, yRatio, jitterX, jitterY) {
    return {
        x: clamp(
            Math.round(frame.left + frame.width * xRatio + randomOffset(jitterX || 0)),
            frame.left + 20,
            frame.left + frame.width - 20
        ),
        y: clamp(
            Math.round(frame.top + frame.height * yRatio + randomOffset(jitterY || 0)),
            frame.top + 20,
            frame.top + frame.height - 20
        )
    };
}

function readWindowAttribute(window, attributeName, fallbackValue) {
    try {
        const attribute = window.attributes.byName(attributeName);
        if (!attribute) {
            return fallbackValue;
        }

        const value = attribute.value();
        return value === undefined || value === null ? fallbackValue : value;
    } catch (error) {
        return fallbackValue;
    }
}

function getWindowName(window) {
    try {
        return String(window.name() || '');
    } catch (error) {
        return '';
    }
}

function selectWechatWindow(wechat, context) {
    const windows = wechat.windows();
    if (!windows || windows.length === 0) {
        throw new Error('WeChat 窗口未找到');
    }

    const targetWindowName = String(context.targetWindowName || '').trim();
    const platformName = String(context.platformName || '').trim();
    const scoredWindows = windows.map((window, index) => {
        const name = getWindowName(window);
        let score = 0;

        if (targetWindowName && name === targetWindowName) {
            score += 1000;
        } else if (targetWindowName && name.includes(targetWindowName)) {
            score += 800;
        }

        if (platformName && name.includes(platformName)) {
            score += 400;
        }

        if (readWindowAttribute(window, 'AXMain', false)) {
            score += 200;
        }

        if (readWindowAttribute(window, 'AXFocused', false)) {
            score += 120;
        }

        if (name) {
            score += 40;
        }

        score += Math.max(0, 30 - index);

        return { window, score };
    }).sort((left, right) => right.score - left.score);

    return scoredWindows[0].window;
}

function runTapAction(step, frame) {
    const repeat = Math.max(1, Number(step.repeat) || 1);
    for (let i = 0; i < repeat; i++) {
        const point = pointFromRatio(
            frame,
            Number(step.xRatio),
            Number(step.yRatio),
            Number(step.jitterX) || 0,
            Number(step.jitterY) || 0
        );
        clickAt(point.x, point.y);
        delay(((Number(step.delayMs) || 100) / 1000));
    }
}

function runAction(step, frame, context) {
    if (!step || !step.type) {
        return;
    }

    switch (step.type) {
        case 'tap':
            runTapAction(step, frame);
            return;
        case 'wait':
            delay((Number(step.delayMs) || 200) / 1000);
            return;
        case 'selectAll':
            keyboardTap(0, $.kCGEventFlagMaskCommand);
            delay((Number(step.delayMs) || 100) / 1000);
            return;
        case 'pasteText':
            setClipboardText(step.valueFrom === 'cityName' ? context.cityName : (step.value || ''));
            keyboardTap(9, $.kCGEventFlagMaskCommand);
            delay((Number(step.delayMs) || 300) / 1000);
            return;
        case 'keyCode': {
            const repeat = Math.max(1, Number(step.repeat) || 1);
            for (let i = 0; i < repeat; i++) {
                keyboardTap(Number(step.keyCode), 0);
                delay((Number(step.delayMs) || 80) / 1000);
            }
            return;
        }
        case 'pressEnter':
            keyboardTap(36, 0);
            delay((Number(step.delayMs) || 300) / 1000);
            return;
        default:
            return;
    }
}

function buildSwipeLanes(frame, profile) {
    const contentLeft = frame.left + frame.width * Number(profile.contentLeftRatio || 0.24);
    const contentRight = frame.left + frame.width * Number(profile.contentRightRatio || 0.9);
    const laneWidth = Math.max(80, contentRight - contentLeft);
    const laneRatios = Array.isArray(profile.laneRatios) && profile.laneRatios.length > 0
        ? profile.laneRatios
        : [0.72, 0.6, 0.82, 0.68];

    return laneRatios.map(ratio =>
        Math.round(contentLeft + laneWidth * Number(ratio))
    );
}

function focusList(frame, profile) {
    if (profile && profile.focusTap === null) {
        return;
    }
    if (profile && profile.focusTap === false) {
        return;
    }

    const focusTap = profile.focusTap || {};
    const repeat = Math.max(1, Number(focusTap.repeat) || 1);
    const point = pointFromRatio(
        frame,
        Number(focusTap.xRatio || 0.74),
        Number(focusTap.yRatio || 0.58),
        Number(focusTap.jitterX) || 8,
        Number(focusTap.jitterY) || 8
    );

    for (let i = 0; i < repeat; i++) {
        clickAt(point.x, point.y);
        delay((Number(focusTap.delayMs) || 180) / 1000);
    }
}

function maybeSwitchCity(frame, profile, context) {
    if (!context.cityName || !profile.citySearch || !profile.citySearch.enabled) {
        return;
    }

    const steps = Array.isArray(profile.citySearch.steps) ? profile.citySearch.steps : [];
    steps.forEach(step => runAction(step, frame, context));
    delay((Number(profile.citySearch.settleMs) || 1000) / 1000);
}

function runInitialTaps(frame, profile, context) {
    const steps = Array.isArray(profile.initialTaps) ? profile.initialTaps : [];
    steps.forEach(step => runAction(step, frame, context));
    focusList(frame, profile);
}

function runPerScrollTaps(frame, profile, context, currentIndex) {
    const steps = Array.isArray(profile.perScrollTaps) ? profile.perScrollTaps : [];
    steps.forEach(step => {
        const every = Math.max(1, Number(step.every) || 1);
        if (currentIndex % every === 0) {
            runAction(step, frame, context);
        }
    });
}

function run(argv) {
    const scrollCount = parseInt(argv[0] || readNumberEnv('AUTO_SCROLL_COUNT', 10), 10);
    const scrollIntervalBase = Number(argv[1] || readNumberEnv('AUTO_SCROLL_INTERVAL', 2));
    const context = readContext();
    const profile = context.scrollProfile || {};

    const systemEvents = Application('System Events');
    systemEvents.includeStandardAdditions = true;

    const wechat = systemEvents.processes.byName('WeChat');
    if (!wechat.exists()) {
        throw new Error('WeChat 未运行，无法自动滑动');
    }

    wechat.frontmost = true;
    delay(1);

    let frame = null;
    try {
        const window = selectWechatWindow(wechat, context);
        frame = buildFrame(window);
    } catch (error) {
        frame = frameFromBounds(context.targetWindowBounds);
        if (!frame) {
            throw error;
        }
    }
    if (frame.width < 300 || frame.height < 300) {
        throw new Error('微信窗口过小，无法确定滑动区域');
    }

    maybeSwitchCity(frame, profile, context);
    runInitialTaps(frame, profile, context);

    const lanes = buildSwipeLanes(frame, profile);
    const startBaseY = Math.round(frame.top + frame.height * Number(profile.startYRatio || 0.82));
    const endBaseY = Math.round(frame.top + frame.height * Number(profile.endYRatio || 0.28));
    const laneJitter = Number(profile.laneJitter || 30);
    const startYJitter = Number(profile.startYJitter || 40);
    const endYJitter = Number(profile.endYJitter || 40);
    const dragStepsBase = Number(profile.dragStepsBase || 25);
    const dragStepsVariance = Number(profile.dragStepsVariance || 8);

    for (let i = 0; i < scrollCount; i++) {
        const currentIndex = i + 1;
        runPerScrollTaps(frame, profile, context, currentIndex);

        // 随机选择滑动轨道
        const randomLaneIndex = Math.floor(Math.random() * lanes.length);
        const laneX = lanes[randomLaneIndex];
        const fromX = laneX + randomOffset(laneJitter);
        const toX = laneX + randomOffset(laneJitter);

        // 随机起始和结束位置
        const fromY = clamp(startBaseY + randomOffset(startYJitter), frame.top + 120, frame.top + frame.height - 60);
        const toY = clamp(endBaseY + randomOffset(endYJitter), frame.top + 70, frame.top + frame.height - 180);

        // 随机滑动步数（影响滑动速度）
        const steps = dragStepsBase + Math.floor(Math.random() * dragStepsVariance);

        // 随机间隔时间：使用环境变量中的 min/max 或回退到基础时间的 50% ~ 150%
        const intervalMinMs = readNumberEnv('AUTO_SCROLL_INTERVAL_MIN', scrollIntervalBase * 500);
        const intervalMaxMs = readNumberEnv('AUTO_SCROLL_INTERVAL_MAX', scrollIntervalBase * 1500);
        const randomIntervalMs = intervalMinMs + Math.random() * (intervalMaxMs - intervalMinMs);
        const randomInterval = randomIntervalMs / 1000;

        focusList(frame, profile);
        delay(0.05 + Math.random() * 0.1);
        drag(fromX, fromY, toX, toY, steps);
        delay(randomInterval);
    }

    return 'SUCCESS: 完成 ' + scrollCount + ' 次自动点击/滑动';
}
EOF
