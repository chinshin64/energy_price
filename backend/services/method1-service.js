const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const WechatPageStateDetector = require('./wechat-page-state');

const REASONS = {
    READY: 'ready',
    WECHAT_WINDOW_FOUND: 'wechat_window_found',
    WECHAT_NOT_RUNNING: 'wechat_not_running',
    TARGET_WINDOW_FOUND: 'target_window_found',
    TARGET_WINDOW_MISSING: 'target_window_missing',
    SCREENSHOT_READY: 'screenshot_ready',
    SCREENSHOT_FAILED: 'screenshot_failed',
    OCR_READY: 'ocr_ready',
    OCR_UNAVAILABLE: 'ocr_unavailable',
    SCROLL_SCRIPT_READY: 'scroll_script_ready',
    SCROLL_SCRIPT_MISSING: 'scroll_script_missing',
    SCROLL_FAILED: 'scroll_failed',
    LOGIN_PROMPT_DETECTED: 'login_prompt_detected',
    LOGIN_PROMPT_DISMISSED: 'login_prompt_dismissed',
    LOGIN_PROMPT_MANUAL_REQUIRED: 'login_prompt_manual_required',
    PAGE_NOT_RECOGNIZED: 'page_not_recognized',
    PERMISSION_DENIED: 'permission_denied',
    OPEN_SCRIPT_MISSING: 'open_script_missing',
    MINIAPP_OPEN_FAILED: 'miniapp_open_failed',
    CITY_SELECTOR_NOT_FOUND: 'city_selector_not_found',
    CITY_INPUT_FAILED: 'city_input_failed',
    CITY_RESULT_NOT_FOUND: 'city_result_not_found',
    CITY_SWITCH_SUCCESS: 'city_switch_success',
    CITY_SWITCH_VERIFY_FAILED: 'city_switch_verify_failed',
    TAP_TARGET_NOT_FOUND: 'tap_target_not_found',
    TAP_FAILED: 'tap_failed',
    BACK_FAILED: 'back_failed',
    BOTTOM_REACHED: 'bottom_reached',
    MAX_STEPS_REACHED: 'max_steps_reached',
    MAX_SCROLLS_REACHED: 'max_scrolls_reached',
    MAX_DURATION_REACHED: 'max_duration_reached',
    NO_NEW_ITEMS_AFTER_SCROLL: 'no_new_items_after_scroll',
    HUMAN_VERIFICATION_DETECTED: 'human_verification_detected',
    EMPTY_RESULT: 'empty_result',
    UNKNOWN_ERROR: 'unknown_error'
};

class Method1Service {
    constructor(options = {}) {
        this.projectRoot = options.projectRoot;
        this.smartController = options.smartController;
        this.reader = options.reader;
        this.getMiniProgram = options.getMiniProgram;
        this.pageStateDetector = options.pageStateDetector || new WechatPageStateDetector();
        this.scriptDir = path.join(this.projectRoot, 'automation');
    }

    async getStatus(options = {}) {
        const platform = this.normalizePlatform(options.platform);
        const miniProgram = this.resolveMiniProgram(platform);
        const checks = this.emptyChecks();
        let targetWindow = null;

        try {
            const wechatStatus = await this.checkWechatWindow();
            checks.wechatWindow = wechatStatus.check;
            if (wechatStatus.check.status !== 'ready') {
                return this.statusResult(false, wechatStatus.check.reason, checks);
            }

            const targetStatus = await this.checkTargetWindow(miniProgram);
            checks.targetWindow = targetStatus.check;
            targetWindow = targetStatus.window;
            if (targetStatus.check.status !== 'ready') {
                return this.statusResult(false, targetStatus.check.reason, checks);
            }

            const screenshotStatus = this.checkScreenshot(miniProgram);
            checks.screenshot = screenshotStatus.check;
            if (screenshotStatus.check.status !== 'ready') {
                return this.statusResult(false, screenshotStatus.check.reason, checks);
            }

            const ocrStatus = this.checkOcr();
            checks.ocr = ocrStatus.check;
            if (ocrStatus.check.status !== 'ready') {
                return this.statusResult(false, ocrStatus.check.reason, checks);
            }

            const scrollScriptStatus = this.checkScrollScript();
            checks.scrollScript = scrollScriptStatus.check;
            if (scrollScriptStatus.check.status !== 'ready') {
                return this.statusResult(false, scrollScriptStatus.check.reason, checks);
            }

            return this.statusResult(true, REASONS.READY, checks, {
                platform,
                targetWindow: this.formatWindow(targetWindow)
            });
        } catch (error) {
            const reason = this.classifyError(error);
            return this.statusResult(false, reason, checks, {
                error: error.message
            });
        }
    }

    async runBasicCheck(options = {}) {
        const platform = this.normalizePlatform(options.platform);
        const miniProgram = this.resolveMiniProgram(platform);
        const status = await this.getStatus({ platform });
        if (!status.available) {
            return {
                ...status,
                before: null,
                after: null,
                scroll: { status: 'unavailable', reason: status.reason },
                citySwitch: null
            };
        }

        const cityName = String(options.targetCity || options.city || '').trim();
        const maxScrolls = Math.min(Math.max(1, Number(options.maxScrolls) || 1), 3);
        const result = {
            success: true,
            available: true,
            reason: REASONS.READY,
            checks: status.checks,
            citySwitch: null,
            before: null,
            after: null,
            scroll: { status: 'unavailable', reason: 'not_started', scrollCount: 0 }
        };

        // 第一步：城市切换
        if (cityName && this.smartController && typeof this.smartController.switchCityWithLiveOcr === 'function') {
            try {
                const scrollProfile = this.smartController.getScrollProfile(miniProgram);
                const fakeSession = {
                    id: `method1-check-${Date.now()}`,
                    platform: platform,
                    platformId: miniProgram.id,
                    logs: [],
                    pushLog(_s, level, msg) { console.log(`[method1][${level}] ${msg}`); }
                };
                await this.smartController.switchCityWithLiveOcr(fakeSession, miniProgram, cityName, scrollProfile);
                result.citySwitch = { success: true, city: cityName };
            } catch (error) {
                result.citySwitch = { success: false, city: cityName, error: error.message };
            }
        } else if (cityName) {
            result.citySwitch = { success: false, city: cityName, error: 'smartController unavailable' };
        }

        // 第二步：截图 before
        try {
            result.before = await this.captureAndRecognize(miniProgram, 'before-scroll', options);
        } catch (error) {
            return this.failedRunResult(status.checks, this.classifyCaptureOrOcrError(error), error, {
                before: null, after: null, citySwitch: result.citySwitch
            });
        }

        // 第二步半：检测登录弹窗，尝试自动关闭
        const beforeState = result.before?.pageState || {};
        if (beforeState.state === 'login-prompt') {
            result.loginPrompt = { detected: true, state: 'login-prompt' };
            const dismissed = await this.dismissLoginPrompt(miniProgram, result.before, options);
            result.loginPrompt.dismissed = dismissed;
            if (dismissed) {
                result.loginPrompt.state = 'dismissed';
                await this.sleep(2000);
                try {
                    result.before = await this.captureAndRecognize(miniProgram, 'after-dismiss', options);
                } catch (_) {}
            } else {
                result.loginPrompt.state = 'manual_required';
                result.loginPrompt.reason = REASONS.LOGIN_PROMPT_MANUAL_REQUIRED;
                result.loginPrompt.message = 'WeChat mini program login popup blocks automation. Please manually click "暂不登录/注册" to dismiss.';
            }
        }

        // 第三步：持续下滑
        let totalScrollCount = 0;
        let lastScrollError = null;
        for (let i = 0; i < maxScrolls; i++) {
            try {
                await this.scrollOnce(miniProgram, options);
                totalScrollCount++;
                await this.sleep(1000);
            } catch (error) {
                lastScrollError = error.message;
                break;
            }
        }
        result.scroll = {
            status: totalScrollCount > 0 ? 'ready' : 'unavailable',
            reason: totalScrollCount > 0 ? 'scroll_ready' : REASONS.SCROLL_FAILED,
            scrollCount: totalScrollCount,
            ...(lastScrollError ? { error: lastScrollError } : {})
        };

        // 第四步：截图 after
        try {
            result.after = await this.captureAndRecognize(miniProgram, 'after-scroll', options);
        } catch (error) {
            result.after = { status: 'unavailable', reason: this.classifyCaptureOrOcrError(error) };
        }

        const runPass = this.isBasicCheckPass(result, cityName);
        result.success = runPass.success;
        result.available = true;
        result.reason = runPass.reason;
        result.status = runPass.success ? 'passed' : 'failed';
        result.diagnostics = runPass.success ? [] : [{
            code: runPass.reason,
            message: runPass.message
        }];

        return result;
    }

    isBasicCheckPass(result = {}, cityName = '') {
        if (cityName && result.citySwitch?.success !== true) {
            return {
                success: false,
                reason: REASONS.CITY_SWITCH_VERIFY_FAILED,
                message: result.citySwitch?.error || 'target city was not verified'
            };
        }
        if (result.loginPrompt?.state === 'manual_required') {
            return {
                success: false,
                reason: REASONS.LOGIN_PROMPT_MANUAL_REQUIRED,
                message: result.loginPrompt.message || 'login prompt blocks automation'
            };
        }
        if (result.before?.status !== 'ready') {
            return {
                success: false,
                reason: result.before?.reason || REASONS.PAGE_NOT_RECOGNIZED,
                message: 'before-scroll screenshot/OCR was not recognized'
            };
        }
        if (result.scroll?.status !== 'ready' || Number(result.scroll?.scrollCount || 0) < 1) {
            return {
                success: false,
                reason: result.scroll?.reason || REASONS.SCROLL_FAILED,
                message: result.scroll?.error || 'scroll action did not complete'
            };
        }
        if (result.after?.status !== 'ready') {
            return {
                success: false,
                reason: result.after?.reason || REASONS.PAGE_NOT_RECOGNIZED,
                message: 'after-scroll screenshot/OCR was not recognized'
            };
        }
        return { success: true, reason: REASONS.READY, message: 'basic check passed' };
    }

    async openMiniApp(options = {}) {
        const platform = this.normalizePlatform(options.platform);
        const miniProgram = this.resolveMiniProgram(platform);
        const script = path.join(this.scriptDir, 'open-miniprogram.applescript');
        if (!fs.existsSync(script)) {
            return { success: false, available: false, reason: REASONS.OPEN_SCRIPT_MISSING, script };
        }
        try {
            const result = await this.execFile('/usr/bin/osascript', [script, miniProgram.name], 30000);
            await this.sleep(Number(options.waitMs || 3000));
            const status = await this.getStatus({ platform });
            return {
                success: true,
                available: status.available,
                reason: status.available ? REASONS.READY : REASONS.MINIAPP_OPEN_FAILED,
                platform,
                miniProgram: miniProgram.name,
                output: String(result.stdout || '').trim(),
                status
            };
        } catch (error) {
            return { success: false, available: false, reason: REASONS.MINIAPP_OPEN_FAILED, platform, miniProgram: miniProgram.name, error: error.message };
        }
    }

    async screenshotAction(options = {}) {
        const platform = this.normalizePlatform(options.platform);
        const miniProgram = this.resolveMiniProgram(platform);
        try {
            const capture = await this.captureAndRecognize(miniProgram, options.stage || 'action-screenshot', options);
            return { success: capture.status === 'ready', available: capture.status === 'ready', reason: capture.reason, action: 'screenshot', capture };
        } catch (error) {
            return { success: false, available: false, reason: this.classifyCaptureOrOcrError(error), action: 'screenshot', error: error.message };
        }
    }

    async observeAction(options = {}) {
        const result = await this.screenshotAction({ ...options, stage: options.stage || 'observe' });
        const capture = result.capture || null;
        return { ...result, action: 'observe', observation: capture ? this.buildObservation(capture, options) : null };
    }

    async scrollAction(options = {}) {
        const platform = this.normalizePlatform(options.platform);
        const miniProgram = this.resolveMiniProgram(platform);
        try {
            const result = await this.scrollOnce(miniProgram, options);
            return { success: true, available: true, reason: result.reason, action: 'scroll', scroll: result };
        } catch (error) {
            return { success: false, available: false, reason: this.classifyScrollError(error), action: 'scroll', error: error.message };
        }
    }

    async backAction(options = {}) {
        try {
            await this.activateWechat();
            if (options.windowBounds) {
                await this.clickAbsolute(
                    Number(options.windowBounds.X || 0) + 24,
                    Number(options.windowBounds.Y || 0) + 24
                );
            } else {
                const script = [
                    'tell application "System Events"',
                    '  tell process "WeChat"',
                    '    key code 53',
                    '  end tell',
                    'end tell'
                ].join('\n');
                await this.execFile('/usr/bin/osascript', ['-e', script], 5000);
            }
            await this.sleep(Number(options.waitMs || 1000));
            return { success: true, available: true, reason: 'back_success', action: 'back' };
        } catch (error) {
            return { success: false, available: false, reason: REASONS.BACK_FAILED, action: 'back', error: error.message };
        }
    }

    async tapAction(options = {}) {
        const platform = this.normalizePlatform(options.platform);
        const miniProgram = this.resolveMiniProgram(platform);
        try {
            const capture = await this.captureAndRecognize(miniProgram, 'tap-before', options);
            const point = this.normalizeTapPoint(options, capture.rawWindow || {});
            await this.clickAbsolute(point.x, point.y);
            await this.sleep(Number(options.waitMs || 800));
            return { success: true, available: true, reason: 'tap_success', action: 'tap', point, before: this.buildObservation(capture, options) };
        } catch (error) {
            return { success: false, available: false, reason: REASONS.TAP_FAILED, action: 'tap', error: error.message };
        }
    }

    normalizeTapPoint(options = {}, rawWindow = {}) {
        if (Number.isFinite(Number(options.absoluteX)) && Number.isFinite(Number(options.absoluteY))) {
            return { x: Math.round(Number(options.absoluteX)), y: Math.round(Number(options.absoluteY)) };
        }
        const bounds = rawWindow.kCGWindowBounds || rawWindow.bounds || {};
        const left = Number(bounds.X ?? bounds.x ?? 0);
        const top = Number(bounds.Y ?? bounds.y ?? 0);
        const width = Number(bounds.Width ?? bounds.width ?? 0);
        const height = Number(bounds.Height ?? bounds.height ?? 0);
        if (!Number.isFinite(left) || !Number.isFinite(top) || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
            throw new Error('target window bounds unavailable');
        }
        const xRatio = Number(options.xRatio ?? options.x ?? 0.5);
        const yRatio = Number(options.yRatio ?? options.y ?? 0.5);
        return {
            x: Math.round(left + width * xRatio),
            y: Math.round(top + height * yRatio)
        };
    }

    async tapByTextAction(options = {}) {
        const platform = this.normalizePlatform(options.platform);
        const miniProgram = this.resolveMiniProgram(platform);
        const text = String(options.text || '').trim();
        if (!text) return { success: false, available: false, reason: REASONS.TAP_TARGET_NOT_FOUND, action: 'tap-by-text', error: 'text required' };
        try {
            const capture = await this.captureAndRecognize(miniProgram, 'tap-by-text-before', options);
            const target = this.findTextTarget(capture.ocrRows, text);
            if (!target) return { success: false, available: false, reason: REASONS.TAP_TARGET_NOT_FOUND, action: 'tap-by-text', text, before: this.buildObservation(capture, options) };
            const point = this.targetToAbsolutePoint(target, capture.rawWindow || {});
            await this.clickAbsolute(point.x, point.y);
            await this.sleep(Number(options.waitMs || 1000));
            return { success: true, available: true, reason: 'tap_success', action: 'tap-by-text', text, point, target, before: this.buildObservation(capture, options) };
        } catch (error) {
            return { success: false, available: false, reason: REASONS.TAP_FAILED, action: 'tap-by-text', error: error.message };
        }
    }

    async switchCityAction(options = {}) {
        const platform = this.normalizePlatform(options.platform);
        const miniProgram = this.resolveMiniProgram(platform);
        const city = String(options.city || options.targetCity || '').trim();
        const trace = [];
        if (!city) return { success: false, available: false, reason: 'city_required', actionTrace: trace };
        const status = await this.getStatus({ platform });
        if (!status.available) return { success: false, available: false, reason: status.reason, checks: status.checks, actionTrace: trace };
        try {
            const before = await this.captureAndRecognize(miniProgram, 'switch-city-before', { ...options, targetCity: city });
            trace.push(this.traceFromCapture('observe_before', before, { city }));
            const beforeCity = this.extractCityEvidence(before, city);
            if (beforeCity.verified) return { success: true, available: true, reason: REASONS.CITY_SWITCH_SUCCESS, city, verifiedCity: beforeCity.text, alreadySelected: true, actionTrace: trace };
            let entryCapture = before;
            entryCapture = await this.dismissBlockingOverlayIfNeeded(miniProgram, entryCapture, { ...options, targetCity: city }, trace);
            if (entryCapture.pageState?.state === 'station-detail') {
                const back = await this.backAction({ ...options, platform, waitMs: Number(options.afterBackWaitMs || 1200), windowBounds: entryCapture.rawWindow?.kCGWindowBounds });
                trace.push({ step: trace.length + 1, action: 'back_from_detail', status: back.success ? 'success' : 'failed', reason: back.reason });
                if (back.success) {
                    entryCapture = await this.captureAndRecognize(miniProgram, 'switch-city-after-back', { ...options, targetCity: city });
                    trace.push(this.traceFromCapture('observe_after_back', entryCapture, { city }));
                    entryCapture = await this.dismissBlockingOverlayIfNeeded(miniProgram, entryCapture, { ...options, targetCity: city }, trace);
                }
            }
            const allowSearchTrigger = !['station-detail', 'popup', 'marketing'].includes(entryCapture.pageState?.state);
            const cityEntry = entryCapture.pageState?.targets?.cityEntry
                || entryCapture.pageState?.targets?.citySelector
                || (allowSearchTrigger ? entryCapture.pageState?.targets?.searchTrigger : null);
            if (!cityEntry) return { success: false, available: false, reason: REASONS.CITY_SELECTOR_NOT_FOUND, city, actionTrace: trace };
            await this.clickTarget(cityEntry, entryCapture.rawWindow || {});
            trace.push({ step: trace.length + 1, action: 'tap_city_selector', status: 'success', target: cityEntry });
            await this.sleep(Number(options.afterTapWaitMs || 1200));
            const search = await this.captureAndRecognize(miniProgram, 'switch-city-search', { ...options, targetCity: city });
            trace.push(this.traceFromCapture('observe_city_search', search, { city }));
            const searchInput = search.pageState?.targets?.searchInput || search.pageState?.targets?.searchBox || search.pageState?.targets?.searchTrigger;
            if (searchInput) {
                await this.clickTarget(searchInput, search.rawWindow || {});
                trace.push({ step: trace.length + 1, action: 'tap_city_input', status: 'success', target: searchInput });
            }
            try {
                await this.clearInputAndPaste(city);
            } catch (error) {
                return { success: false, available: false, reason: REASONS.CITY_INPUT_FAILED, city, error: error.message, actionTrace: trace };
            }
            trace.push({ step: trace.length + 1, action: 'input_city', status: 'success', city });
            await this.sleep(Number(options.afterInputWaitMs || 1500));
            const resultPage = await this.captureAndRecognize(miniProgram, 'switch-city-result', { ...options, targetCity: city });
            trace.push(this.traceFromCapture('observe_city_result', resultPage, { city }));
            const cityOption = resultPage.pageState?.targets?.cityOption || resultPage.pageState?.targets?.stationOption || this.findTextTarget(resultPage.ocrRows, city);
            if (!cityOption) return { success: false, available: false, reason: REASONS.CITY_RESULT_NOT_FOUND, city, actionTrace: trace };
            await this.clickTarget(cityOption, resultPage.rawWindow || {});
            trace.push({ step: trace.length + 1, action: 'select_city_result', status: 'success', target: cityOption });
            await this.sleep(Number(options.afterSelectWaitMs || 2500));
            const after = await this.captureAndRecognize(miniProgram, 'switch-city-verify', { ...options, targetCity: city });
            trace.push(this.traceFromCapture('verify_city', after, { city }));
            const verifiedCity = this.extractCityEvidence(after, city);
            const ok = verifiedCity.verified || this.containsNormalizedCity(after.textLines, city);
            return { success: ok, available: ok, reason: ok ? REASONS.CITY_SWITCH_SUCCESS : REASONS.CITY_SWITCH_VERIFY_FAILED, city, verifiedCity: verifiedCity.text || '', before: this.buildObservation(before, { ...options, targetCity: city }), after: this.buildObservation(after, { ...options, targetCity: city }), actionTrace: trace };
        } catch (error) {
            return { success: false, available: false, reason: this.classifyCaptureOrOcrError(error), city, error: error.message, actionTrace: trace };
        }
    }

    async runAdaptive(options = {}) {
        const platform = this.normalizePlatform(options.platform);
        const miniProgram = this.resolveMiniProgram(platform);
        const limits = options.limits || {};
        const maxSteps = Math.min(Math.max(1, Number(limits.maxSteps || options.maxSteps || 20)), 50);
        const maxScrolls = Math.min(Math.max(0, Number(limits.maxScrolls || options.maxScrolls || 5)), 10);
        const maxDurationSeconds = Math.min(Math.max(10, Number(limits.maxDurationSeconds || options.maxDurationSeconds || 180)), 600);
        const startedAt = Date.now();
        const context = { goal: options.goal || 'station_list_scroll', maxSteps, maxScrolls, maxDurationSeconds, steps: 0, scrolls: 0, backs: 0, observations: 0, seenItems: new Set(), actionTrace: [] };
        const status = await this.getStatus({ platform });
        if (!status.available) return { success: false, available: false, reason: status.reason, checks: status.checks, summary: this.adaptiveSummary(context), actionTrace: context.actionTrace };
        while (context.steps < maxSteps) {
            if ((Date.now() - startedAt) / 1000 > maxDurationSeconds) return this.finishAdaptive(false, REASONS.MAX_DURATION_REACHED, context);
            let capture;
            try {
                capture = await this.captureAndRecognize(miniProgram, `adaptive-step-${context.steps + 1}`, options);
            } catch (error) {
                const reason = this.classifyCaptureOrOcrError(error);
                context.actionTrace.push({ step: context.steps + 1, action: 'observe', status: 'failed', reason, error: error.message });
                return this.finishAdaptive(false, reason, context);
            }
            context.observations += 1;
            const observation = this.buildObservation(capture, options);
            const decision = this.decideNextAdaptiveAction(observation, context);
            context.actionTrace.push({ step: context.steps + 1, action: 'observe_decide', pageType: observation.pageType, confidence: observation.confidence, decision: decision.action, reason: decision.reason, visibleItemCount: observation.visibleItemKeys.length, newItemCount: decision.newItemCount || 0, screenshotPath: observation.screenshotPath });
            if (decision.action === 'stop') return this.finishAdaptive(decision.success, decision.reason, context);
            if (decision.action === 'scroll') {
                const scroll = await this.scrollAction({ ...options, platform });
                context.actionTrace.push({ step: context.steps + 1, action: 'scroll', status: scroll.success ? 'success' : 'failed', reason: scroll.reason });
                if (!scroll.success) return this.finishAdaptive(false, scroll.reason, context);
                context.scrolls += 1;
            } else if (decision.action === 'back') {
                const back = await this.backAction({ ...options, platform });
                context.actionTrace.push({ step: context.steps + 1, action: 'back', status: back.success ? 'success' : 'failed', reason: back.reason });
                if (!back.success) return this.finishAdaptive(false, back.reason, context);
                context.backs += 1;
            } else {
                return this.finishAdaptive(false, REASONS.UNKNOWN_ERROR, context);
            }
            context.steps += 1;
            await this.sleep(Number(options.stepWaitMs || 1000));
        }
        return this.finishAdaptive(false, REASONS.MAX_STEPS_REACHED, context);
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async dismissLoginPrompt(miniProgram, beforeCapture, options = {}) {
        const ocrRows = beforeCapture?.ocrRows || [];
        const window = beforeCapture?.window || {};
        const bounds = window.bounds || window.kCGWindowBounds || {};

        if (!bounds.Width || !bounds.Height) {
            return false;
        }

        // Find "暂不登录" in OCR rows and calculate click position
        let clickX = 0, clickY = 0;
        let found = false;
        for (const row of ocrRows) {
            const text = String(row.text || '').trim();
            if (text.includes('暂不登录')) {
                const bb = row.boundingBox || {};
                const centerX = (bb.x || 0) + (bb.width || 0) / 2;
                const centerY = 1 - (bb.y || 0) - (bb.height || 0) / 2; // Vision: origin bottom-left
                clickX = Math.round((bounds.X || 0) + centerX * (bounds.Width || 0));
                clickY = Math.round((bounds.Y || 0) + centerY * (bounds.Height || 0));
                found = true;
                break;
            }
        }

        if (!found) {
            return false;
        }

        // Attempt 1: CGEvent click via JXA
        try {
            const jxaScript = [
                'ObjC.import("Cocoa");',
                'ObjC.import("ApplicationServices");',
                'var app = $.NSRunningApplication.runningApplicationsWithBundleIdentifier("com.tencent.xinWeChat").objectAtIndex(0);',
                'app.activateWithOptions($.NSApplicationActivateIgnoringOtherApps);',
                '$.NSThread.sleepForTimeInterval(1);',
                'var point = $.CGPointMake(' + clickX + ', ' + clickY + ');',
                'var down = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseDown, point, $.kCGMouseButtonLeft);',
                '$.CGEventPost($.kCGHIDEventTap, down);',
                '$.NSThread.sleepForTimeInterval(0.1);',
                'var up = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseUp, point, $.kCGMouseButtonLeft);',
                '$.CGEventPost($.kCGHIDEventTap, up);',
                '"OK";'
            ].join('\n');
            const tmpScript = '/tmp/dismiss-login-' + Date.now() + '.js';
            const fs = require('fs');
            fs.writeFileSync(tmpScript, jxaScript);
            await this.execFile('/usr/bin/osascript', ['-l', 'JavaScript', tmpScript], 5000);
            await this.sleep(2000);
            try { fs.unlinkSync(tmpScript); } catch (_) {}
        } catch (_) {}

        // All automated attempts failed - WeChat filters synthetic events
        return false;
    }

    async checkWechatWindow() {
        try {
            await this.execFile('/usr/bin/pgrep', ['-x', 'WeChat'], 2000);
        } catch (error) {
            return {
                check: this.check('unavailable', REASONS.WECHAT_NOT_RUNNING, 'WeChat 进程未运行')
            };
        }

        try {
            const windows = this.reader.listWechatWindows();
            if (windows.length === 0) {
                return {
                    check: this.check('unavailable', REASONS.WECHAT_NOT_RUNNING, '未识别到微信窗口')
                };
            }
            return {
                check: this.check('ready', REASONS.WECHAT_WINDOW_FOUND, `识别到 ${windows.length} 个微信窗口`),
                windows
            };
        } catch (error) {
            return {
                check: this.check('unavailable', this.classifyError(error), error.message)
            };
        }
    }

    async checkTargetWindow(miniProgram) {
        try {
            const windows = this.reader.listWechatWindows();
            const window = windows.find(item => this.matchesTargetWindow(item.kCGWindowName || '', miniProgram))
                || this.findWindowBySize(windows, miniProgram);
            const windowNames = windows
                .map(item => item.kCGWindowName || '(无标题窗口)')
                .join('、');
            if (!window || (!this.matchesTargetWindow(window.kCGWindowName || '', miniProgram) && !window.__sizeMatched)) {
                return {
                    check: this.check(
                        'unavailable',
                        REASONS.TARGET_WINDOW_MISSING,
                        `未找到目标小程序窗口，当前窗口: ${windowNames || '未识别到微信窗口'}`
                    )
                };
            }
            const windowName = window.kCGWindowName || miniProgram.name || '';
            return {
                check: this.check('ready', REASONS.TARGET_WINDOW_FOUND, 
                    window.__sizeMatched ? `已找到(尺寸匹配): ${miniProgram.name}` : `已找到: ${windowName}`),
                window
            };
        } catch (error) {
            return {
                check: this.check('unavailable', this.classifyError(error), error.message)
            };
        }
    }

    checkScreenshot(miniProgram) {
        try {
            const result = this.reader.testWindowCapture({
                platform: miniProgram.id,
                titleKeywords: this.titleKeywords(miniProgram)
            });
            if (result.capturable) {
                return {
                    check: this.check('ready', REASONS.SCREENSHOT_READY, '目标窗口可截图')
                };
            }
            return {
                check: this.check('unavailable', REASONS.SCREENSHOT_FAILED, result.error || '截图失败')
            };
        } catch (error) {
            return {
                check: this.check('unavailable', this.classifyCaptureOrOcrError(error), error.message)
            };
        }
    }

    checkOcr() {
        try {
            this.reader.ensureOcrHelper();
            return {
                check: this.check('ready', REASONS.OCR_READY, this.reader.ocrHelperBinary)
            };
        } catch (error) {
            return {
                check: this.check('unavailable', REASONS.OCR_UNAVAILABLE, error.message)
            };
        }
    }

    checkScrollScript() {
        const candidates = this.scrollMethodCandidates();
        const existing = candidates.find(item => fs.existsSync(item.script));
        if (!existing) {
            return {
                check: this.check('unavailable', REASONS.SCROLL_SCRIPT_MISSING, '未找到可用下滑脚本')
            };
        }
        return {
            check: this.check('ready', REASONS.SCROLL_SCRIPT_READY, existing.script),
            method: existing
        };
    }

    async captureAndRecognize(miniProgram, stage, options = {}) {
        const screenshot = this.reader.captureWindowScreenshot({
            platform: miniProgram.id,
            titleKeywords: this.titleKeywords(miniProgram),
            stage
        });
        const ocrRows = this.reader.runOcrOnScreenshot(screenshot.screenshotPath);
        const pageState = this.pageStateDetector.detect({ ocrRows }, {
            platform: miniProgram.id,
            targetCity: options.targetCity || options.city || ''
        });
        const textLines = ocrRows
            .map(row => String(row.text || '').trim())
            .filter(Boolean);
        const recognized = this.isRecognized(pageState, textLines);

        return {
            status: recognized ? 'ready' : 'unavailable',
            reason: recognized ? REASONS.READY : REASONS.PAGE_NOT_RECOGNIZED,
            screenshotPath: screenshot.screenshotPath,
            window: this.formatWindow(screenshot.window),
            pageState: this.summarizePageState(pageState),
            textLines,
            text: textLines.join('\n'),
            ocrCount: textLines.length,
            ocrRows,
            rawWindow: {
                ...(screenshot.window || {}),
                __screenshotSize: this.readPngSize(screenshot.screenshotPath)
            }
        };
    }

    readPngSize(filePath) {
        try {
            const fd = fs.openSync(filePath, 'r');
            const buffer = Buffer.alloc(24);
            fs.readSync(fd, buffer, 0, 24, 0);
            fs.closeSync(fd);
            if (buffer.toString('ascii', 1, 4) !== 'PNG') return null;
            return {
                width: buffer.readUInt32BE(16),
                height: buffer.readUInt32BE(20)
            };
        } catch {
            return null;
        }
    }

    async scrollOnce(miniProgram, options = {}) {
        const scrollScriptStatus = this.checkScrollScript();
        if (scrollScriptStatus.check.status !== 'ready') {
            return {
                status: 'unavailable',
                reason: REASONS.SCROLL_SCRIPT_MISSING,
                error: scrollScriptStatus.check.message
            };
        }

        const method = scrollScriptStatus.method;
        const scrollProfile = this.smartController.getScrollProfile(miniProgram);
        const targetStatus = await this.checkTargetWindow(miniProgram);
        const targetWindow = targetStatus.window ? this.formatWindow(targetStatus.window) : null;
        const context = Buffer.from(JSON.stringify({
            platformId: miniProgram.id,
            platformName: miniProgram.name,
            cityName: String(options.targetCity || options.city || ''),
            scrollProfile,
            targetWindowName: miniProgram.name,
            targetWindowBounds: targetWindow?.bounds || null
        }), 'utf8').toString('base64');
        const env = {
            ...process.env,
            AUTO_SCROLL_CONTEXT_BASE64: context,
            AUTO_SCROLL_INTERVAL_MIN: '800',
            AUTO_SCROLL_INTERVAL_MAX: '1200'
        };
        const args = ['1', '1'];
        await this.spawnScroll(method, args, env);
        return {
            status: 'ready',
            reason: 'scroll_ready',
            method: method.name,
            scrollCount: 1
        };
    }

    async activateWechat() {
        await this.execFile('/usr/bin/osascript', ['-e', 'tell application "WeChat" to activate'], 5000);
    }

    targetToAbsolutePoint(target = {}, rawWindow = {}) {
        const box = target.boundingBox || target.box || target;
        const bounds = rawWindow.kCGWindowBounds || rawWindow.bounds || {};
        const left = Number(bounds.X ?? bounds.x ?? 0);
        const top = Number(bounds.Y ?? bounds.y ?? 0);
        const width = Number(bounds.Width ?? bounds.width ?? 0);
        const height = Number(bounds.Height ?? bounds.height ?? 0);
        if (!Number.isFinite(left) || !Number.isFinite(top) || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
            throw new Error('target window bounds unavailable');
        }
        const x = Number(box.x ?? 0);
        const y = Number(box.y ?? 0);
        const w = Number(box.width ?? 0);
        const h = Number(box.height ?? 0);
        const screenshotSize = rawWindow.__screenshotSize || {};
        const imageWidth = Number(screenshotSize.width || 0);
        const imageHeight = Number(screenshotSize.height || 0);
        if (imageWidth > width && imageHeight > height) {
            const scale = Math.max(1, Math.round(Math.min(imageWidth / width, imageHeight / height)));
            const offsetX = Math.max(0, (imageWidth - width * scale) / 2);
            const offsetY = Math.max(0, (imageHeight - height * scale) / 2);
            const pixelX = imageWidth * (x + Math.max(w, 0.02) / 2);
            const pixelY = imageHeight * (1 - y - Math.max(h, 0.02) / 2);
            return {
                x: Math.round(left + (pixelX - offsetX) / scale),
                y: Math.round(top + (pixelY - offsetY) / scale)
            };
        }
        return {
            x: Math.round(left + width * (x + Math.max(w, 0.02) / 2)),
            // Vision OCR rows are normalized from the bottom-left coordinate space.
            y: Math.round(top + height * (1 - y - Math.max(h, 0.02) / 2))
        };
    }

    async clickTarget(target, rawWindow = {}) {
        const point = this.targetToAbsolutePoint(target, rawWindow);
        await this.clickAbsolute(point.x, point.y);
        return point;
    }

    async clickAbsolute(x, y) {
        const script = `
ObjC.import('ApplicationServices');
Application('WeChat').activate();
delay(0.12);
function post(type, x, y) {
  const point = $.CGPointMake(Number(x), Number(y));
  const event = $.CGEventCreateMouseEvent(null, type, point, $.kCGMouseButtonLeft);
  $.CGEventPost($.kCGHIDEventTap, event);
}
function click(x, y) {
  post($.kCGEventMouseMoved, x, y);
  delay(0.06);
  post($.kCGEventLeftMouseDown, x, y);
  delay(0.08);
  post($.kCGEventLeftMouseUp, x, y);
}
click(${Number(x)}, ${Number(y)});
delay(0.12);
click(${Number(x)}, ${Number(y)});
delay(0.08);
click(${Number(x) + 4}, ${Number(y)});
`;
        await this.execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], 5000);
    }

    async dismissBlockingOverlayIfNeeded(miniProgram, capture, options = {}, trace = []) {
        const closeTarget = capture?.pageState?.targets?.close;
        const isOverlay = ['popup', 'marketing'].includes(capture?.pageState?.state)
            || (closeTarget && this.containsAnyText(capture.textLines, ['价格说明', '滴滴站点价', '跨时段计费']));
        if (!isOverlay || !closeTarget) {
            return capture;
        }
        try {
            const point = await this.clickTarget(closeTarget, capture.rawWindow || {});
            trace.push({ step: trace.length + 1, action: 'dismiss_overlay', status: 'success', target: closeTarget, point });
            await this.sleep(Number(options.afterDismissWaitMs || 1200));
            const after = await this.captureAndRecognize(miniProgram, 'switch-city-after-dismiss-overlay', options);
            trace.push(this.traceFromCapture('observe_after_dismiss_overlay', after, { city: options.targetCity || options.city || '' }));
            return after;
        } catch (error) {
            trace.push({ step: trace.length + 1, action: 'dismiss_overlay', status: 'failed', reason: REASONS.TAP_FAILED, error: error.message });
            return capture;
        }
    }

    containsAnyText(lines = [], keywords = []) {
        const text = Array.isArray(lines) ? lines.join('\n') : String(lines || '');
        return keywords.some(keyword => text.includes(keyword));
    }

    async clearInputAndPaste(text = '') {
        const script = `
ObjC.import('AppKit');
const pb = $.NSPasteboard.generalPasteboard;
pb.clearContents;
pb.setStringForType($(${JSON.stringify(String(text || ''))}), $.NSPasteboardTypeString);
const app = Application('System Events');
app.includeStandardAdditions = true;
app.keystroke('a', { using: 'command down' });
delay(0.08);
app.keystroke('v', { using: 'command down' });
`;
        await this.execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], 8000);
    }

    spawnScroll(method, args, env) {
        return new Promise((resolve, reject) => {
            const child = method.script.endsWith('.sh')
                ? spawn(method.script, args, { stdio: ['ignore', 'pipe', 'pipe'], env })
                : spawn('osascript', [method.script, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env });
            const chunks = [];
            child.stdout?.on('data', chunk => chunks.push(Buffer.from(chunk).toString('utf8')));
            child.stderr?.on('data', chunk => chunks.push(Buffer.from(chunk).toString('utf8')));
            child.on('error', reject);
            child.on('exit', code => {
                if (code === 0) {
                    resolve();
                    return;
                }
                const output = chunks.join('\n').trim();
                reject(new Error(`下滑脚本退出码 ${code}${output ? `: ${output}` : ''}`));
            });
        });
    }

    execFile(file, args, timeoutMs) {
        return new Promise((resolve, reject) => {
            execFile(file, args, { timeout: timeoutMs }, (error, stdout, stderr) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve({ stdout, stderr });
            });
        });
    }

    emptyChecks() {
        return {
            wechatWindow: this.check('unavailable', REASONS.WECHAT_NOT_RUNNING, ''),
            targetWindow: this.check('unavailable', REASONS.TARGET_WINDOW_MISSING, ''),
            screenshot: this.check('unavailable', REASONS.SCREENSHOT_FAILED, ''),
            ocr: this.check('unavailable', REASONS.OCR_UNAVAILABLE, ''),
            scrollScript: this.check('unavailable', REASONS.SCROLL_SCRIPT_MISSING, '')
        };
    }

    statusResult(available, reason, checks, extra = {}) {
        return {
            success: Boolean(available),
            available,
            reason,
            checks,
            ...extra
        };
    }

    failedRunResult(checks, reason, error, extra = {}) {
        return {
            success: false,
            available: false,
            reason,
            checks,
            error: error.message,
            ...extra
        };
    }

    buildObservation(capture = {}, options = {}) {
        const pageState = capture.pageState || {};
        const visibleItemKeys = Array.isArray(capture.textLines)
            ? capture.textLines
                .map(line => String(line || '').trim())
                .filter(Boolean)
                .slice(0, 80)
            : [];
        return {
            status: capture.status || 'unknown',
            reason: capture.reason || '',
            pageType: pageState.state || 'unknown',
            pageLabel: pageState.label || '',
            confidence: visibleItemKeys.length > 0 ? 0.8 : 0,
            screenshotPath: capture.screenshotPath || '',
            ocrCount: Number(capture.ocrCount || 0),
            textPreview: String(capture.text || '').slice(0, 500),
            textLines: visibleItemKeys,
            visibleItemKeys,
            pageState,
            targetCity: options.targetCity || options.city || ''
        };
    }

    traceFromCapture(action, capture = {}, extra = {}) {
        return {
            step: 0,
            action,
            status: capture.status || 'unknown',
            reason: capture.reason || '',
            pageState: capture.pageState || null,
            screenshotPath: capture.screenshotPath || '',
            ocrCount: Number(capture.ocrCount || 0),
            textPreview: String(capture.text || '').slice(0, 240),
            ...extra
        };
    }

    extractCityEvidence(capture = {}, city = '') {
        const expected = this.normalizeCityName(city);
        const lines = Array.isArray(capture.textLines) ? capture.textLines : [];
        if (!expected) return { verified: false, text: '' };
        for (const line of lines) {
            const normalized = this.normalizeCityName(line);
            if (normalized === expected || normalized.includes(expected) || expected.includes(normalized)) {
                return { verified: true, text: line };
            }
        }
        return { verified: false, text: '' };
    }

    containsNormalizedCity(lines = [], city = '') {
        const expected = this.normalizeCityName(city);
        if (!expected || !Array.isArray(lines)) return false;
        return lines.some(line => {
            const normalized = this.normalizeCityName(line);
            return normalized === expected || normalized.includes(expected) || expected.includes(normalized);
        });
    }

    normalizeCityName(value = '') {
        return String(value || '')
            .replace(/[市县区省\s,，、:：|｜·.。>＞<＜]/g, '')
            .trim()
            .toLowerCase();
    }

    findTextTarget(ocrRows = [], text = '') {
        const expected = this.normalizeCityName(text) || this.normalizeText(text);
        if (!expected || !Array.isArray(ocrRows)) return null;
        for (const row of ocrRows) {
            const rowText = String(row.text || '');
            const normalized = this.normalizeCityName(rowText) || this.normalizeText(rowText);
            if (!normalized) continue;
            if (normalized.includes(expected) || expected.includes(normalized)) {
                return {
                    text: rowText,
                    boundingBox: row.boundingBox || row.box || null,
                    confidence: row.confidence,
                };
            }
        }
        return null;
    }

    check(status, reason, message = '') {
        return { status, reason, message };
    }

    normalizePlatform(platform) {
        const normalized = String(platform || 'didi-charging').trim().toLowerCase();
        const aliases = {
            didi: 'didi-charging',
            'didi_charging': 'didi-charging',
            didicharging: 'didi-charging',
            '滴滴充电': 'didi-charging'
        };
        return aliases[normalized] || normalized || 'didi-charging';
    }

    resolveMiniProgram(platform) {
        const miniProgram = this.getMiniProgram(platform);
        if (!miniProgram) {
            const error = new Error(`Platform not found: ${platform}`);
            error.reason = REASONS.TARGET_WINDOW_MISSING;
            throw error;
        }
        return miniProgram;
    }

    titleKeywords(miniProgram) {
        return [miniProgram.name, miniProgram.searchKeyword].filter(Boolean);
    }

    matchesTargetWindow(windowName = '', miniProgram = {}) {
        const normalizedWindow = this.normalizeText(windowName);
        if (!normalizedWindow) {
            return false;
        }
        return this.titleKeywords(miniProgram)
            .map(value => this.normalizeText(value))
            .filter(Boolean)
            .some(keyword => normalizedWindow.includes(keyword) || keyword.includes(normalizedWindow));
    }

    normalizeText(value) {
        return String(value || '').trim().toLowerCase().replace(/\s+/g, '');
    }

    scrollMethodCandidates() {
        return [
            { name: 'gesture', script: path.join(this.scriptDir, 'auto-scroll-cliclick.sh') },
            { name: 'improved', script: path.join(this.scriptDir, 'auto-scroll-improved.applescript') },
            { name: 'basic', script: path.join(this.scriptDir, 'auto-scroll.applescript') }
        ];
    }

    isRecognized(pageState = {}, textLines = []) {
        if (textLines.length === 0) {
            return false;
        }
        return pageState.state !== 'unknown'
            || Number(pageState.stationCount || 0) > 0
            || Number(pageState.listControlCount || 0) > 0
            || Number(pageState.detailCount || 0) > 0
            || textLines.length >= 3;
    }

    summarizePageState(pageState = {}) {
        return {
            state: pageState.state || 'unknown',
            label: pageState.label || '未知页面',
            stationCount: Number(pageState.stationCount || 0),
            detailCount: Number(pageState.detailCount || 0),
            listControlCount: Number(pageState.listControlCount || 0),
            loginCount: Number(pageState.loginCount || 0),
            networkErrorCount: Number(pageState.networkErrorCount || 0),
            humanVerificationCount: Number(pageState.humanVerificationCount || 0),
            targets: pageState.targets || {}
        };
    }

    formatWindow(window = {}) {
        return {
            id: window.kCGWindowNumber || null,
            ownerName: window.kCGWindowOwnerName || '',
            name: window.kCGWindowName || '',
            bounds: window.kCGWindowBounds || null,
            selectionScore: window.__selectionScore || 0,
            selectionReason: window.__selectionReason || ''
        };
    }

    classifyCaptureOrOcrError(error) {
        const message = String(error?.message || '');
        if (/Vision|ocr|OCR|\/tmp\/ocr-image|clang.*Vision|JSON/.test(message)) {
            return REASONS.OCR_UNAVAILABLE;
        }
        if (/权限|not authorized|denied|Screen Recording|Operation not permitted|不可被系统共享/.test(message)) {
            return REASONS.PERMISSION_DENIED;
        }
        if (/截取|screencapture|截图|capture/i.test(message)) {
            return REASONS.SCREENSHOT_FAILED;
        }
        if (/未找到微信|未找到.*窗口|小程序窗口/.test(message)) {
            return REASONS.TARGET_WINDOW_MISSING;
        }
        return REASONS.UNKNOWN_ERROR;
    }

    classifyScrollError(error) {
        const message = String(error?.message || '');
        if (/缺少脚本|not found|ENOENT/.test(message)) {
            return REASONS.SCROLL_SCRIPT_MISSING;
        }
        if (/权限|not authorized|denied|Operation not permitted/.test(message)) {
            return REASONS.PERMISSION_DENIED;
        }
        return REASONS.SCROLL_FAILED;
    }

    classifyError(error) {
        if (error?.reason) {
            return error.reason;
        }
        const message = String(error?.message || '');
        if (/pgrep|WeChat.*未运行|微信.*未运行|未识别到微信窗口/.test(message)) {
            return REASONS.WECHAT_NOT_RUNNING;
        }
        if (/未找到微信小程序窗口|未找到.*小程序窗口|未找到目标小程序/.test(message)) {
            return REASONS.TARGET_WINDOW_MISSING;
        }
        if (/权限|not authorized|denied|Operation not permitted/.test(message)) {
            return REASONS.PERMISSION_DENIED;
        }
        return REASONS.UNKNOWN_ERROR;
    }

    /**
     * 当窗口标题为空（macOS 未授权屏幕录制）时，按窗口尺寸兜底匹配。
     * 滴滴充电小程序特征：宽度 400-500，高度 700-850，ownerName 包含微信
     */
    findWindowBySize(windows, miniProgram) {
        const platform = (miniProgram.id || '').toLowerCase();
        const sizeProfiles = {
            'didi-charging': { minWidth: 390, maxWidth: 500, minHeight: 680, maxHeight: 880 },
        };
        const profile = sizeProfiles[platform];
        if (!profile) return null;

        const candidates = windows.filter(w => {
            const bounds = w.kCGWindowBounds || {};
            const width = Number(bounds.Width || 0);
            const height = Number(bounds.Height || 0);
            const name = String(w.kCGWindowName || '').trim();
            // 只匹配无标题的微信窗口
            if (name) return false;
            if (width >= profile.minWidth && width <= profile.maxWidth
                && height >= profile.minHeight && height <= profile.maxHeight) {
                return true;
            }
            return false;
        });

        if (candidates.length === 1) {
            const matched = candidates[0];
            matched.__selectionScore = 800;
            matched.__selectionReason = 'size_fallback';
            matched.__sizeMatched = true;
            return matched;
        }
        if (candidates.length > 1) {
            // 多个候选时选面积最大的
            candidates.sort((a, b) => {
                const aA = (a.kCGWindowBounds?.Width || 0) * (a.kCGWindowBounds?.Height || 0);
                const bA = (b.kCGWindowBounds?.Width || 0) * (b.kCGWindowBounds?.Height || 0);
                return bA - aA;
            });
            const matched = candidates[0];
            matched.__selectionScore = 800;
            matched.__selectionReason = 'size_fallback_best';
            matched.__sizeMatched = true;
            return matched;
        }
        return null;
    }
}

module.exports = Method1Service;
