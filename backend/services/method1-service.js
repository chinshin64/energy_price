const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const WechatPageStateDetector = require('./wechat-page-state');
const { resolveMiniProgramProfile } = require('../automation/mini-program-profiles');

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
    CITY_INPUT_NOT_APPLIED: 'city_input_not_applied',
    INPUT_PERMISSION_DENIED: 'input_permission_denied',
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
    LOGIN_REQUIRED_FOR_MORE_RESULTS: 'login_required_for_more_results',
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

    async getWindowStatus(options = {}) {
        try {
            const platform = this.normalizePlatform(options.platform);
            const miniProgram = this.resolveMiniProgram(platform);
            const wechatStatus = await this.checkWechatWindow();
            if (wechatStatus.check.status !== 'ready') {
                return {
                    hasWechatWindow: false,
                    hasTargetWindow: false,
                    reason: wechatStatus.check.reason,
                };
            }

            const targetStatus = await this.checkTargetWindow(miniProgram);
            return {
                hasWechatWindow: true,
                hasTargetWindow: targetStatus.check.status === 'ready',
                reason: targetStatus.check.reason,
                targetWindow: targetStatus.window ? this.formatWindow(targetStatus.window) : null,
            };
        } catch (error) {
            return {
                hasWechatWindow: false,
                hasTargetWindow: false,
                reason: this.classifyError(error),
            };
        }
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

            const textInputStatus = await this.checkTextInputCapability();
            checks.textInput = textInputStatus.check;

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

    async getWorkflowReadiness(options = {}) {
        const platform = this.normalizePlatform(options.platform);
        const status = await this.getStatus({ platform });
        const checks = status.checks || {};
        const textInputReady = checks.textInput?.status === 'ready';
        const workflowAvailable = Boolean(status.available) && textInputReady;
        const workflowReason = workflowAvailable
            ? REASONS.READY
            : (!textInputReady && status.available ? REASONS.INPUT_PERMISSION_DENIED : status.reason);
        const stage = this.workflowStageForReason(workflowReason, workflowAvailable);
        const diagnostics = this.workflowDiagnosticsFromChecks(checks, workflowReason, status.error);

        return {
            success: workflowAvailable,
            available: workflowAvailable,
            stage,
            reason: workflowReason || REASONS.UNKNOWN_ERROR,
            nextAction: this.workflowNextAction(workflowReason, stage),
            diagnostics,
            checks,
            platform,
            targetWindow: status.targetWindow || null
        };
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
        if (cityName) {
            try {
                const citySwitch = await this.switchCityAction({ ...options, platform, city: cityName, targetCity: cityName });
                result.citySwitch = citySwitch;
            } catch (error) {
                result.citySwitch = { success: false, city: cityName, error: error.message };
            }
        }

        // 第二步：截图 before
        try {
            result.before = await this.captureAndRecognize(miniProgram, 'before-scroll', options);
        } catch (error) {
            return this.failedRunResult(status.checks, this.classifyCaptureOrOcrError(error), error, {
                before: null, after: null, citySwitch: result.citySwitch
            });
        }

        // 第二步半：检测阻塞页，按 profile 决策动作尝试处理。
        const beforeState = result.before?.pageState || {};
        if (this.isBlockingPageState(beforeState.state)) {
            const dismissed = await this.dismissBlockingState(miniProgram, result.before, options);
            result.decisionTrace = dismissed.trace;
            result.before = dismissed.capture || result.before;
            if (beforeState.state === 'login-prompt') {
                result.loginPrompt = {
                    detected: true,
                    state: dismissed.dismissed ? 'dismissed' : 'manual_required',
                    dismissed: dismissed.dismissed,
                    reason: dismissed.dismissed ? REASONS.LOGIN_PROMPT_DISMISSED : REASONS.LOGIN_PROMPT_MANUAL_REQUIRED,
                    message: dismissed.dismissed
                        ? 'login prompt was dismissed by Method1 decision layer'
                        : 'WeChat mini program login popup blocks automation. Please manually click "暂不登录/注册" to dismiss.'
                };
            }
        }

        if (result.before?.pageState?.state === 'station-detail') {
            result.detailRecovery = await this.returnToListFromDetail(miniProgram, result.before, options);
            if (result.detailRecovery?.capture) {
                result.before = result.detailRecovery.capture;
            }
            if (result.before?.pageState?.state === 'station-detail') {
                result.success = false;
                result.available = true;
                result.reason = 'station_detail_not_list';
                result.status = 'failed';
                result.scroll = { status: 'unavailable', reason: 'station_detail_not_list', scrollCount: 0 };
                result.after = result.before;
                result.diagnostics = [{
                    code: 'station_detail_not_list',
                    message: 'Method1 basic check requires a list page; station detail page must return to list first'
                }];
                return result;
            }
        }
        if (this.isRecoverableNonMainlineState(result.before?.pageState?.state)) {
            result.mainlineRecovery = await this.recoverToMainList(miniProgram, result.before, options);
            if (result.mainlineRecovery?.capture) {
                result.before = result.mainlineRecovery.capture;
            }
            if (!this.isListLikePageState(result.before?.pageState || {})) {
                result.success = false;
                result.available = true;
                result.reason = result.mainlineRecovery?.reason || REASONS.PAGE_NOT_RECOGNIZED;
                result.status = 'failed';
                result.scroll = { status: 'unavailable', reason: result.reason, scrollCount: 0 };
                result.after = result.before;
                result.diagnostics = [{
                    code: result.reason,
                    message: 'Method1 decision layer could not recover the current page back to station list'
                }];
                return result;
            }
        }
        if (!this.isListLikePageState(result.before?.pageState || {})) {
            result.success = false;
            result.available = true;
            result.reason = result.before?.pageState?.state === 'login-prompt'
                ? REASONS.LOGIN_PROMPT_MANUAL_REQUIRED
                : (result.before?.reason || REASONS.PAGE_NOT_RECOGNIZED);
            result.status = 'failed';
            result.scroll = { status: 'unavailable', reason: result.reason, scrollCount: 0 };
            result.after = result.before;
            result.diagnostics = [{
                code: result.reason,
                message: 'Method1 basic check requires a recognized station list before scrolling'
            }];
            return result;
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
        if (this.isBlockingPageState(result.after?.pageState?.state)) {
            result.afterBlockingRecovery = await this.dismissBlockingState(miniProgram, result.after, options);
            if (result.afterBlockingRecovery?.capture) {
                result.after = result.afterBlockingRecovery.capture;
            }
        }
        if (result.after?.pageState?.state === 'station-detail') {
            result.afterDetailRecovery = await this.returnToListFromDetail(miniProgram, result.after, options);
            if (result.afterDetailRecovery?.capture) {
                result.after = result.afterDetailRecovery.capture;
            }
        }
        if (this.isRecoverableNonMainlineState(result.after?.pageState?.state)) {
            result.afterMainlineRecovery = await this.recoverToMainList(miniProgram, result.after, options);
            if (result.afterMainlineRecovery?.capture) {
                result.after = result.afterMainlineRecovery.capture;
            }
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
        if (result.before?.pageState?.state === 'station-detail') {
            return {
                success: false,
                reason: 'station_detail_not_list',
                message: 'Method1 basic check requires a list page; station detail page must return to list first'
            };
        }
        if (result.before?.pageState?.state === 'unknown') {
            return {
                success: false,
                reason: REASONS.PAGE_NOT_RECOGNIZED,
                message: 'before-scroll page is not recognized as a station list'
            };
        }
        if (!this.isListLikePageState(result.before?.pageState || {})) {
            return {
                success: false,
                reason: result.before?.pageState?.state || REASONS.PAGE_NOT_RECOGNIZED,
                message: 'before-scroll page is not a station list'
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
        if (['login-prompt', 'human-verification'].includes(result.after?.pageState?.state)) {
            return {
                success: false,
                reason: result.after.pageState.state === 'login-prompt' ? REASONS.LOGIN_PROMPT_MANUAL_REQUIRED : REASONS.HUMAN_VERIFICATION_DETECTED,
                message: `after-scroll page is blocked by ${result.after.pageState.state}`
            };
        }
        if (result.after?.pageState?.state === 'station-detail') {
            return {
                success: false,
                reason: 'station_detail_not_list',
                message: 'after-scroll page opened a station detail page and did not return to list'
            };
        }
        if (result.after?.pageState?.state === 'unknown') {
            return {
                success: false,
                reason: REASONS.PAGE_NOT_RECOGNIZED,
                message: 'after-scroll page is not recognized as a station list'
            };
        }
        if (!this.isListLikePageState(result.after?.pageState || {})) {
            return {
                success: false,
                reason: result.after?.pageState?.state || REASONS.PAGE_NOT_RECOGNIZED,
                message: 'after-scroll page is not a station list'
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

    async keyAction(options = {}) {
        try {
            const keyCode = Math.floor(Number(options.keyCode));
            if (!Number.isFinite(keyCode) || keyCode < 0 || keyCode > 127) {
                return { success: false, available: false, reason: REASONS.UNKNOWN_ERROR, action: 'key', error: 'keyCode must be an integer between 0 and 127' };
            }

            const modifierMap = {
                command: 'command down',
                cmd: 'command down',
                shift: 'shift down',
                option: 'option down',
                alt: 'option down',
                control: 'control down',
                ctrl: 'control down'
            };
            const modifiers = Array.from(new Set(
                (Array.isArray(options.modifiers) ? options.modifiers : String(options.modifiers || '').split(/[,，\s]+/))
                    .map(item => modifierMap[String(item || '').trim().toLowerCase()])
                    .filter(Boolean)
            ));
            const repeat = Math.max(1, Math.min(5, Number(options.repeat) || 1));
            const keyLine = modifiers.length > 0
                ? `    key code ${keyCode} using {${modifiers.join(', ')}}`
                : `    key code ${keyCode}`;
            const lines = [
                'tell application "System Events"',
                '  tell process "WeChat"'
            ];
            for (let i = 0; i < repeat; i += 1) {
                lines.push(keyLine);
            }
            lines.push('  end tell', 'end tell');

            await this.activateWechat();
            await this.execFile('/usr/bin/osascript', ['-e', lines.join('\n')], 5000);
            await this.sleep(Number(options.waitMs || 800));
            return {
                success: true,
                available: true,
                reason: 'key_success',
                action: 'key',
                keyCode,
                modifiers,
                repeat
            };
        } catch (error) {
            return { success: false, available: false, reason: REASONS.UNKNOWN_ERROR, action: 'key', error: error.message };
        }
    }

    async tapAction(options = {}) {
        const platform = this.normalizePlatform(options.platform);
        const miniProgram = this.resolveMiniProgram(platform);
        try {
            const capture = await this.captureAndRecognize(miniProgram, 'tap-before', options);
            const point = this.normalizeTapPoint(options, capture.rawWindow || {});
            const click = await this.clickAbsolute(point.x, point.y);
            await this.sleep(Number(options.waitMs || 800));
            return { success: true, available: true, reason: 'tap_success', action: 'tap', point: { ...point, clickBackend: click.backend }, before: this.buildObservation(capture, options) };
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
        const isLandmarkSearch = this.isLandmarkSearchRequest(options, city);
        const trace = [];
        if (!city) return { success: false, available: false, reason: 'city_required', actionTrace: trace };
        const status = await this.getStatus({ platform });
        if (!status.available) return { success: false, available: false, reason: status.reason, checks: status.checks, actionTrace: trace };
        try {
            const before = await this.captureAndRecognize(miniProgram, 'switch-city-before', { ...options, targetCity: city });
            trace.push(this.traceFromCapture('observe_before', before, { city }));
            const beforeCity = this.extractCityEvidence(before, city);
            const beforeWasListLike = this.isListLikePageState(before.pageState || {});
            if (!isLandmarkSearch && beforeCity.verified && this.isListLikePageState(before.pageState || {})) {
                return { success: true, available: true, reason: REASONS.CITY_SWITCH_SUCCESS, city, verifiedCity: beforeCity.text, alreadySelected: true, actionTrace: trace };
            }
            let entryCapture = before;
            entryCapture = await this.dismissBlockingOverlayIfNeeded(miniProgram, entryCapture, { ...options, targetCity: city }, trace);
            if (this.isBlockingPageState(entryCapture.pageState?.state)) {
                const dismissed = await this.dismissBlockingState(miniProgram, entryCapture, { ...options, targetCity: city }, trace);
                entryCapture = dismissed.capture || entryCapture;
                if (!isLandmarkSearch && beforeWasListLike && beforeCity.verified && this.isListLikePageState(entryCapture.pageState || {})) {
                    return { success: true, available: true, reason: REASONS.CITY_SWITCH_SUCCESS, city, verifiedCity: beforeCity.text, alreadySelected: true, recovered: true, actionTrace: trace };
                }
            }
            if (entryCapture.pageState?.state === 'station-detail') {
                const returned = await this.returnToListFromDetail(miniProgram, entryCapture, { ...options, targetCity: city });
                trace.push(...(returned.trace || []));
                entryCapture = returned.capture || entryCapture;
                entryCapture = await this.dismissBlockingOverlayIfNeeded(miniProgram, entryCapture, { ...options, targetCity: city }, trace);
                const recoveredCity = this.extractCityEvidence(entryCapture, city);
                if (!isLandmarkSearch && returned.success && this.isListLikePageState(entryCapture.pageState || {})
                    && (recoveredCity.verified || this.containsNormalizedCity(entryCapture.textLines, city))) {
                    return {
                        success: true,
                        available: true,
                        reason: REASONS.CITY_SWITCH_SUCCESS,
                        city,
                        verifiedCity: recoveredCity.text || '',
                        alreadySelected: true,
                        recovered: true,
                        actionTrace: trace
                    };
                }
            }
            if (this.isRecoverableNonMainlineState(entryCapture.pageState?.state)) {
                const recovered = await this.recoverToMainList(miniProgram, entryCapture, { ...options, targetCity: city }, trace);
                entryCapture = recovered.capture || entryCapture;
                const recoveredCity = this.extractCityEvidence(entryCapture, city);
                if (!isLandmarkSearch && ((beforeWasListLike && beforeCity.verified) || recoveredCity.verified || this.containsNormalizedCity(entryCapture.textLines, city)) && this.isListLikePageState(entryCapture.pageState || {})) {
                    return { success: true, available: true, reason: REASONS.CITY_SWITCH_SUCCESS, city, verifiedCity: recoveredCity.text || beforeCity.text || '', alreadySelected: true, recovered: true, actionTrace: trace };
                }
            }
            const allowSearchTrigger = !['station-detail', 'popup', 'marketing'].includes(entryCapture.pageState?.state);
            const cityEntry = entryCapture.pageState?.targets?.cityEntry
                || entryCapture.pageState?.targets?.citySelector
                || (allowSearchTrigger ? entryCapture.pageState?.targets?.searchTrigger : null)
                || (allowSearchTrigger ? entryCapture.pageState?.targets?.searchInput : null)
                || (allowSearchTrigger ? entryCapture.pageState?.targets?.searchBox : null);
            if (!cityEntry) return { success: false, available: false, reason: REASONS.CITY_SELECTOR_NOT_FOUND, city, actionTrace: trace };
            const hasCityEntryTarget = Boolean(entryCapture.pageState?.targets?.cityEntry || entryCapture.pageState?.targets?.citySelector);
            const shouldUseListSearchHotspot = allowSearchTrigger
                && this.isListLikePageState(entryCapture.pageState || {})
                && (isLandmarkSearch || !hasCityEntryTarget);
            if (shouldUseListSearchHotspot) {
                const point = this.profileActionPoint({ xRatio: 0.5, yRatio: 0.095, jitterX: 6, jitterY: 4 }, entryCapture.rawWindow || {});
                const click = await this.clickAbsolute(point.x, point.y);
                trace.push({ step: trace.length + 1, action: 'tap_city_selector', status: 'success', target: { label: 'list-search-hotspot', ...point, clickBackend: click.backend } });
            } else {
                await this.clickTarget(cityEntry, entryCapture.rawWindow || {});
                trace.push({ step: trace.length + 1, action: 'tap_city_selector', status: 'success', target: cityEntry });
            }
            await this.sleep(Number(options.afterTapWaitMs || 1200));
            let search = await this.captureAndRecognize(miniProgram, 'switch-city-search', { ...options, targetCity: city });
            trace.push(this.traceFromCapture('observe_city_search', search, { city }));
            if (isLandmarkSearch && this.isListLikePageState(search.pageState || {})) {
                const opened = await this.openSearchFromListLike(miniProgram, search, city, options, trace);
                if (!opened.success) {
                    return { success: false, available: false, reason: opened.reason || REASONS.CITY_SELECTOR_NOT_FOUND, city, selectedCity: options.selectedCity || '', actionTrace: trace };
                }
                search = opened.capture || search;
            }
            if (isLandmarkSearch) {
                const selectedCity = String(options.selectedCity || options.baseCity || options.contextCity || '').trim();
                if (selectedCity) {
                    const selected = await this.selectSearchPageCity(miniProgram, search, selectedCity, options, trace);
                    if (!selected.success) {
                        return { success: false, available: false, reason: selected.reason || REASONS.CITY_RESULT_NOT_FOUND, city, selectedCity, actionTrace: trace };
                    }
                    search = selected.capture || search;
                }
            }
            if (!isLandmarkSearch && search.pageState?.targets?.citySelector && !search.pageState?.targets?.cityOption) {
                await this.clickTarget(search.pageState.targets.citySelector, search.rawWindow || {});
                trace.push({ step: trace.length + 1, action: 'tap_city_list_selector', status: 'success', target: search.pageState.targets.citySelector });
                await this.sleep(Number(options.afterCityListTapWaitMs || 1200));
                search = await this.captureAndRecognize(miniProgram, 'switch-city-list', { ...options, targetCity: city });
                trace.push(this.traceFromCapture('observe_city_list', search, { city }));
            }
            let resultPage = null;
            if (!isLandmarkSearch && search.pageState?.targets?.cityOption) {
                resultPage = search;
            }
            if (!resultPage) {
                resultPage = await this.focusInputPasteAndVerify(miniProgram, search, city, options, trace, isLandmarkSearch);
                if (!resultPage) {
                    return { success: false, available: false, reason: REASONS.CITY_INPUT_NOT_APPLIED, city, actionTrace: trace };
                }
                if (!isLandmarkSearch && resultPage.pageState?.targets?.citySelector && !resultPage.pageState?.targets?.cityOption) {
                    const selected = await this.selectSearchPageCity(miniProgram, resultPage, city, options, trace);
                    if (!selected.success) {
                        return { success: false, available: false, reason: selected.reason || REASONS.CITY_RESULT_NOT_FOUND, city, actionTrace: trace };
                    }
                    resultPage = selected.capture || resultPage;
                }
                if (isLandmarkSearch && resultPage.pageState?.targets?.searchAction) {
                    await this.clickTarget(resultPage.pageState.targets.searchAction, resultPage.rawWindow || {});
                    trace.push({ step: trace.length + 1, action: 'submit_landmark_search', status: 'success', target: resultPage.pageState.targets.searchAction });
                    await this.sleep(Number(options.afterSearchSubmitWaitMs || 2200));
                    resultPage = await this.waitForLandmarkSearchSettled(miniProgram, { ...options, targetCity: city }, trace);
                    if (this.isBlockingPageState(resultPage.pageState?.state)) {
                        const dismissed = await this.dismissBlockingState(miniProgram, resultPage, { ...options, targetCity: city }, trace);
                        resultPage = dismissed.capture || resultPage;
                        if (!this.isBlockingPageState(resultPage.pageState?.state)) {
                            resultPage = await this.waitForLandmarkSearchSettled(miniProgram, { ...options, targetCity: city }, trace);
                        }
                    }
                    trace.push(this.traceFromCapture('observe_landmark_result', resultPage, { city }));
                }
            }
            if (isLandmarkSearch) {
                if (resultPage.pageState?.state === 'empty-search') {
                    return { success: false, available: false, reason: REASONS.EMPTY_RESULT, city, selectedCity: options.selectedCity || '', actionTrace: trace };
                }
                if (this.isListLikePageState(resultPage.pageState || {}) && Number(resultPage.pageState?.stationCount || 0) > 0) {
                    return {
                        success: true,
                        available: true,
                        reason: REASONS.CITY_SWITCH_SUCCESS,
                        city,
                        selectedCity: options.selectedCity || '',
                        verifiedCity: this.extractCityEvidence(resultPage, city).text || '',
                        after: this.buildObservation(resultPage, { ...options, targetCity: city }),
                        actionTrace: trace
                    };
                }
                if (!resultPage.pageState?.targets?.stationOption) {
                    return { success: false, available: false, reason: REASONS.CITY_RESULT_NOT_FOUND, city, selectedCity: options.selectedCity || '', actionTrace: trace };
                }
            }
            const cityOption = isLandmarkSearch
                ? (resultPage.pageState?.targets?.stationOption || this.findTextTarget(resultPage.ocrRows, city))
                : resultPage.pageState?.targets?.cityOption;
            if (!cityOption) return { success: false, available: false, reason: REASONS.CITY_RESULT_NOT_FOUND, city, actionTrace: trace };
            await this.clickTarget(cityOption, resultPage.rawWindow || {});
            trace.push({ step: trace.length + 1, action: 'select_city_result', status: 'success', target: cityOption });
            await this.sleep(Number(options.afterSelectWaitMs || 2500));
            let after = await this.captureAndRecognize(miniProgram, 'switch-city-verify', { ...options, targetCity: city });
            if (this.isRecoverableNonMainlineState(after.pageState?.state)) {
                const recovered = await this.recoverToMainList(miniProgram, after, { ...options, targetCity: city }, trace);
                after = recovered.capture || after;
            }
            trace.push(this.traceFromCapture('verify_city', after, { city }));
            const verifiedCity = this.extractCityEvidence(after, city);
            const ok = this.isListLikePageState(after.pageState || {})
                && (verifiedCity.verified || this.containsNormalizedCity(after.textLines, city) || (isLandmarkSearch && Number(after.pageState?.stationCount || 0) > 0));
            return { success: ok, available: ok, reason: ok ? REASONS.CITY_SWITCH_SUCCESS : REASONS.CITY_SWITCH_VERIFY_FAILED, city, verifiedCity: verifiedCity.text || '', before: this.buildObservation(before, { ...options, targetCity: city }), after: this.buildObservation(after, { ...options, targetCity: city }), actionTrace: trace };
        } catch (error) {
            return { success: false, available: false, reason: this.classifyCaptureOrOcrError(error), city, error: error.message, actionTrace: trace };
        }
    }

    async openSearchFromListLike(miniProgram, listCapture, city, options = {}, trace = []) {
        const target = listCapture.pageState?.targets?.searchInput
            || listCapture.pageState?.targets?.searchBox
            || listCapture.pageState?.targets?.searchTrigger
            || listCapture.pageState?.targets?.cityEntry;
        const attempts = [];
        if (target) {
            attempts.push({ type: 'target', target, label: 'existing-search-entry' });
        }
        attempts.push({ type: 'point', target: { xRatio: 0.5, yRatio: 0.095, jitterX: 6, jitterY: 4 }, label: 'list-search-hotspot' });
        if (attempts.length === 0) {
            return { success: false, reason: REASONS.CITY_SELECTOR_NOT_FOUND, capture: listCapture };
        }

        let current = listCapture;
        for (const attempt of attempts) {
            if (attempt.type === 'target') {
                await this.clickTarget(attempt.target, current.rawWindow || {});
                trace.push({ step: trace.length + 1, action: 'tap_existing_search_entry', status: 'success', city, target: attempt.target });
            } else {
                const point = this.profileActionPoint(attempt.target, current.rawWindow || {});
                const click = await this.clickAbsolute(point.x, point.y);
                trace.push({ step: trace.length + 1, action: 'tap_search_hotspot_entry', status: 'success', city, target: { label: attempt.label, ...point, clickBackend: click.backend } });
            }
            await this.sleep(Number(options.afterTapWaitMs || 1200));
            let after = await this.captureAndRecognize(miniProgram, `switch-city-search-from-list-${attempt.label}`, { ...options, targetCity: city });
            trace.push(this.traceFromCapture('observe_search_from_list_entry', after, { city, label: attempt.label }));
            if (this.isBlockingPageState(after.pageState?.state)) {
                const dismissed = await this.dismissBlockingState(miniProgram, after, { ...options, targetCity: city }, trace);
                after = dismissed.capture || after;
                if (this.isBlockingPageState(after.pageState?.state)) {
                    current = after;
                    continue;
                }
            }
            if (after.pageState?.state === 'station-search' || after.pageState?.state === 'city-search') {
                return { success: true, reason: after.pageState.state, capture: after };
            }
            if (this.isListLikePageState(after.pageState || {})) {
                current = after;
                continue;
            }
            return {
                success: false,
                reason: after.pageState?.state || REASONS.CITY_SELECTOR_NOT_FOUND,
                capture: after
            };
        }

        return {
            success: false,
            reason: current.pageState?.state || REASONS.CITY_SELECTOR_NOT_FOUND,
            capture: current
        };
    }

    async selectSearchPageCity(miniProgram, searchCapture, selectedCity, options = {}, trace = []) {
        const currentCityTarget = searchCapture.pageState?.targets?.citySelector || searchCapture.pageState?.targets?.cityEntry;
        const currentCityText = String(currentCityTarget?.text || '').trim();
        const currentCitySelected = this.normalizeCityName(currentCityText) === this.normalizeCityName(selectedCity);
        if (currentCitySelected && searchCapture.pageState?.state === 'station-search') {
            trace.push({ step: trace.length + 1, action: 'select_search_page_city', status: 'skipped', selectedCity, reason: 'already_selected', verifiedCity: currentCityText });
            return { success: true, capture: searchCapture, alreadySelected: true };
        }

        let cityList = searchCapture;
        if (!cityList.pageState?.targets?.cityOption) {
            const selector = searchCapture.pageState?.targets?.citySelector || searchCapture.pageState?.targets?.cityEntry;
            if (!selector) {
                return { success: false, reason: REASONS.CITY_SELECTOR_NOT_FOUND };
            }
            await this.clickTarget(selector, searchCapture.rawWindow || {});
            trace.push({ step: trace.length + 1, action: 'tap_search_page_city_selector', status: 'success', selectedCity, target: selector });
            await this.sleep(Number(options.afterCityListTapWaitMs || 1200));
            cityList = await this.captureAndRecognize(miniProgram, 'switch-city-select-base-city', { ...options, targetCity: selectedCity });
            trace.push(this.traceFromCapture('observe_search_page_city_list', cityList, { selectedCity }));
        }

        let option = cityList.pageState?.targets?.cityOption;
        if (!option) {
            const typedCityList = await this.focusInputPasteAndVerify(miniProgram, cityList, selectedCity, options, trace, false);
            if (typedCityList) {
                cityList = typedCityList;
                trace.push(this.traceFromCapture('observe_search_page_city_list_after_input', cityList, { selectedCity }));
                option = cityList.pageState?.targets?.cityOption;
            }
        }
        if (!option) {
            return { success: false, reason: REASONS.CITY_RESULT_NOT_FOUND, capture: cityList };
        }
        await this.clickTarget(option, cityList.rawWindow || {});
        trace.push({ step: trace.length + 1, action: 'select_search_page_city', status: 'success', selectedCity, target: option });
        await this.sleep(Number(options.afterBaseCitySelectWaitMs || 1600));
        const after = await this.captureAndRecognize(miniProgram, 'switch-city-after-base-city', { ...options, targetCity: selectedCity });
        trace.push(this.traceFromCapture('observe_after_base_city', after, { selectedCity }));
        return { success: true, capture: after };
    }

    async waitForLandmarkSearchSettled(miniProgram, options = {}, trace = []) {
        const attempts = Math.max(1, Math.min(8, Number(options.searchSettleAttempts || 5)));
        const waitMs = Math.max(300, Math.min(3000, Number(options.searchSettleWaitMs || 1000)));
        let capture = null;
        for (let i = 0; i < attempts; i += 1) {
            capture = await this.captureAndRecognize(miniProgram, `switch-city-result-submitted-${i + 1}`, options);
            const text = String(capture.text || '');
            const loading = /正在搜索/.test(text);
            if (!loading || capture.pageState?.state !== 'station-search') {
                return capture;
            }
            trace.push(this.traceFromCapture('wait_landmark_result', capture, { settleAttempt: i + 1, loading: true }));
            await this.sleep(waitMs);
        }
        return capture;
    }

    async focusInputPasteAndVerify(miniProgram, searchCapture, city, options = {}, trace = [], isLandmarkSearch = false) {
        const searchInputTargets = [
            searchCapture.pageState?.targets?.searchBox,
            searchCapture.pageState?.targets?.searchTrigger,
            searchCapture.pageState?.targets?.searchInput
        ].filter(target => this.isUsableTextInputTarget(target));
        const focusTargets = [];
        searchInputTargets.forEach((target, index) => {
            focusTargets.push({ type: 'target', target, label: `ocr-search-input-${index + 1}` });
        });
        [
            { xRatio: 0.36, yRatio: 0.095, label: 'input-hotspot-top-left' },
            { xRatio: 0.46, yRatio: 0.095, label: 'input-hotspot-top-mid-left' },
            { xRatio: 0.56, yRatio: 0.095, label: 'input-hotspot-top-mid' },
            { xRatio: 0.66, yRatio: 0.095, label: 'input-hotspot-top-mid-right' },
            { xRatio: 0.36, yRatio: 0.12, label: 'input-hotspot-row-left' },
            { xRatio: 0.50, yRatio: 0.12, label: 'input-hotspot-row-mid' },
            { xRatio: 0.64, yRatio: 0.12, label: 'input-hotspot-row-right' },
            { xRatio: 0.44, yRatio: 0.145, label: 'input-hotspot-low-left' },
            { xRatio: 0.56, yRatio: 0.145, label: 'input-hotspot-low-mid' }
        ].forEach(target => focusTargets.push({ type: 'point', target }));

        for (let i = 0; i < focusTargets.length; i += 1) {
            const focusTarget = focusTargets[i];
            try {
                if (focusTarget.type === 'target') {
                    const point = await this.clickTarget(focusTarget.target, searchCapture.rawWindow || {});
                    trace.push({ step: trace.length + 1, action: 'tap_city_input', status: 'success', attempt: i + 1, target: { label: focusTarget.label, ...focusTarget.target }, point });
                } else {
                    const point = this.profileActionPoint({ ...focusTarget.target, jitterX: 5, jitterY: 4 }, searchCapture.rawWindow || {});
                    const click = await this.clickAbsolute(point.x, point.y);
                    trace.push({ step: trace.length + 1, action: 'tap_city_input', status: 'success', attempt: i + 1, target: { ...focusTarget.target, ...point, clickBackend: click.backend } });
                }
                await this.sleep(Number(options.afterInputFocusWaitMs || 250));
                await this.clearInputAndPaste(city);
                trace.push({ step: trace.length + 1, action: 'input_city', status: 'success', attempt: i + 1, city });
            } catch (error) {
                trace.push({ step: trace.length + 1, action: 'input_city', status: 'failed', attempt: i + 1, city, reason: REASONS.CITY_INPUT_FAILED, error: error.message });
                continue;
            }
            await this.sleep(Number(options.afterInputWaitMs || 1200));
            let resultPage = await this.captureAndRecognize(miniProgram, `switch-city-result-attempt-${i + 1}`, { ...options, targetCity: city });
            if (this.isBlockingPageState(resultPage.pageState?.state)) {
                const dismissed = await this.dismissBlockingState(miniProgram, resultPage, { ...options, targetCity: city }, trace);
                resultPage = dismissed.capture || resultPage;
                if (this.isBlockingPageState(resultPage.pageState?.state)) {
                    trace.push(this.traceFromCapture('observe_city_result_after_blocking_dismiss', resultPage, { city, inputAttempt: i + 1, dismissed: false }));
                    continue;
                }
                searchCapture = resultPage;
                trace.push(this.traceFromCapture('observe_city_result_after_blocking_dismiss', resultPage, { city, inputAttempt: i + 1, dismissed: dismissed.dismissed }));
            }
            const textPreview = String(resultPage.text || '').slice(0, 240);
            const inputApplied = this.containsNormalizedQuery(resultPage.textLines, city)
                || this.findStrictTextTarget(resultPage.ocrRows, city)
                || textPreview.includes(city);
            trace.push(this.traceFromCapture('observe_city_result', resultPage, { city, inputAttempt: i + 1, inputApplied: Boolean(inputApplied) }));
            if (inputApplied) {
                return resultPage;
            }
        }

        return null;
    }

    isUsableTextInputTarget(target) {
        if (!target) return false;
        const text = String(target.text || '').trim();
        if (/^[•·.\-\s一〇]+$/.test(text)) return false;
        if (Number(target.y) > 0.88) return false;
        return true;
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
            context.actionTrace.push({ step: context.steps + 1, action: 'observe_decide', pageType: observation.pageType, confidence: observation.confidence, decision: decision.action, reason: decision.reason, visibleItemCount: observation.visibleItemKeys.length, newItemCount: decision.newItemCount || 0, loginLimitedList: Boolean(observation.loginLimitedList), screenshotPath: observation.screenshotPath });
            if (decision.action === 'stop') return this.finishAdaptive(decision.success, decision.reason, context);
            if (decision.action === 'scroll') {
                const scroll = await this.scrollAction({ ...options, platform });
                context.actionTrace.push({ step: context.steps + 1, action: 'scroll', status: scroll.success ? 'success' : 'failed', reason: scroll.reason });
                if (!scroll.success) return this.finishAdaptive(false, scroll.reason, context);
                context.scrolls += 1;
            } else if (decision.action === 'dismiss') {
                const dismissed = await this.dismissBlockingState(miniProgram, capture, options, context.actionTrace);
                context.actionTrace.push({ step: context.steps + 1, action: 'dismiss', status: dismissed.dismissed ? 'success' : 'failed', reason: dismissed.reason });
                if (!dismissed.dismissed) return this.finishAdaptive(false, dismissed.reason || REASONS.TAP_FAILED, context);
            } else if (decision.action === 'back') {
                const back = observation.pageType === 'station-detail'
                    ? await this.returnToListFromDetail(miniProgram, capture, options)
                    : await this.backAction({ ...options, platform });
                if (Array.isArray(back.trace)) {
                    context.actionTrace.push(...back.trace);
                }
                context.actionTrace.push({ step: context.steps + 1, action: 'back', status: back.success ? 'success' : 'failed', reason: back.reason });
                if (!back.success) return this.finishAdaptive(false, back.reason, context);
                context.backs += 1;
            } else if (decision.action === 'recover') {
                const recovered = await this.recoverToMainList(miniProgram, capture, options, context.actionTrace);
                context.actionTrace.push({ step: context.steps + 1, action: 'recover', status: recovered.success ? 'success' : 'failed', reason: recovered.reason });
                if (!recovered.success) return this.finishAdaptive(false, recovered.reason || REASONS.PAGE_NOT_RECOGNIZED, context);
            } else {
                return this.finishAdaptive(false, REASONS.UNKNOWN_ERROR, context);
            }
            context.steps += 1;
            const settleMs = decision.action === 'scroll'
                ? Number(options.afterScrollWaitMs || options.stepWaitMs || 2600)
                : Number(options.stepWaitMs || 1000);
            await this.sleep(settleMs);
        }
        return this.finishAdaptive(false, REASONS.MAX_STEPS_REACHED, context);
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async dismissLoginPrompt(miniProgram, beforeCapture, options = {}) {
        const dismissed = await this.dismissBlockingState(miniProgram, beforeCapture, options);
        return dismissed.dismissed;
    }

    async dismissBlockingState(miniProgram, capture, options = {}, trace = []) {
        const profile = resolveMiniProgramProfile(miniProgram);
        const maxActions = Math.max(1, Number(options.maxDismissActions || 4));
        let currentCapture = capture;
        let currentState = currentCapture?.pageState?.state || 'unknown';
        const attempted = new Set();
        const result = {
            dismissed: false,
            reason: this.dismissReasonForState(currentState),
            state: currentState,
            actionsTried: 0,
            trace,
            capture: currentCapture
        };

        if (!this.isBlockingPageState(currentState)) {
            result.reason = 'not_blocking_state';
            return result;
        }

        while (result.actionsTried < maxActions && this.isBlockingPageState(currentState)) {
            const dynamicActions = this.dynamicDismissActions(currentCapture, currentState);
            const profileActions = Array.isArray(profile.dismissActions)
                ? profile.dismissActions
                    .filter(action => this.actionSupportsState(action, currentState))
                    .filter(action => this.shouldUseProfileDismissAction(action, currentState, options))
                : [];
            const action = [...dynamicActions, ...profileActions].find(candidate => {
                const key = `${currentState}:${candidate.label || candidate.type}`;
                return !attempted.has(key);
            });
            if (!action) {
                result.reason = 'dismiss_action_not_configured';
                return result;
            }
            attempted.add(`${currentState}:${action.label || action.type}`);
            result.actionsTried += 1;
            try {
                const actionResult = await this.executeDismissAction(action, currentCapture?.rawWindow || {});
                trace.push({
                    step: trace.length + 1,
                    action: 'dismiss_decision_action',
                    status: 'success',
                    state: currentState,
                    label: action.label || action.type,
                    point: actionResult.point || null,
                    clickBackend: actionResult.clickBackend || null
                });
                await this.sleep(Number(action.delayMs || options.afterDismissWaitMs || 1000));
                let after = await this.captureAndRecognize(miniProgram, `after-dismiss-${action.label || action.type}`, options);
                after = await this.waitForListLikePage(miniProgram, after, options, trace, action.label || action.type);
                result.capture = after;
                trace.push(this.traceFromCapture('observe_after_dismiss', after, { dismissedFrom: currentState, label: action.label || action.type }));
                if (this.isDismissedState(currentState, after?.pageState || {})) {
                    result.dismissed = true;
                    result.reason = this.dismissedReasonForState(currentState);
                    return result;
                }
                currentCapture = after;
                currentState = currentCapture?.pageState?.state || 'unknown';
                result.state = currentState;
                result.reason = this.dismissReasonForState(currentState);
            } catch (error) {
                trace.push({
                    step: trace.length + 1,
                    action: 'dismiss_decision_action',
                    status: 'failed',
                    state: currentState,
                    label: action.label || action.type,
                    reason: REASONS.TAP_FAILED,
                    error: error.message
                });
            }
        }

        return result;
    }

    dynamicDismissActions(capture = {}, state = '') {
        const actions = [];
        const ocrRows = capture?.ocrRows || [];
        const pageState = capture?.pageState || {};
        const hasConsentPrompt = this.containsAnyText(capture.textLines, ['温馨提示', '服务协议', '个人信息处理规则']);
        const hasPhoneLoginPage = this.containsAnyText(capture.textLines, ['请输入手机号', '手机号', '下一步']);
        if (state === 'login-prompt') {
            const closeTarget = pageState.targets?.close || this.findTextTarget(ocrRows, '暂不登录') || this.findTextTarget(ocrRows, '稍后');
            if (closeTarget) {
                actions.push({ type: 'target', target: closeTarget, label: 'dismiss-login-text-target', states: ['login-prompt'] });
            }
        }
        if (state === 'login-prompt' && hasPhoneLoginPage) {
            actions.push(
                { type: 'tap', xRatio: 0.053, yRatio: 0.053, jitterX: 3, jitterY: 3, delayMs: 900, label: 'dismiss-phone-login-header-back', states: ['login-prompt'] },
                { type: 'commandBack', delayMs: 900, label: 'dismiss-phone-login-command-back', states: ['login-prompt'] }
            );
        }
        if (state === 'login-prompt' && hasConsentPrompt) {
            const disagreeTarget = this.findTextTarget(ocrRows, '不同意');
            if (disagreeTarget) {
                actions.push({ type: 'target', target: disagreeTarget, label: 'dismiss-consent-disagree', states: ['login-prompt'] });
            }
        }
        if ((state === 'popup' || state === 'marketing') && pageState.targets?.close) {
            actions.push({ type: 'target', target: pageState.targets.close, label: 'dismiss-close-target', states: [state] });
        }
        return actions;
    }

    shouldUseProfileDismissAction(action = {}, state = '', options = {}) {
        if (state !== 'login-prompt') return true;
        if (options.allowBackDismiss === true) return true;
        const label = String(action.label || '');
        const type = String(action.type || '');
        return type !== 'commandBack'
            && type !== 'keyCode'
            && !/back|escape/i.test(label);
    }

    actionSupportsState(action = {}, state = '') {
        const states = Array.isArray(action.states) ? action.states : [];
        return states.length === 0 || states.includes(state);
    }

    isBlockingPageState(state = '') {
        return ['login-prompt', 'popup', 'marketing', 'human-verification'].includes(String(state || ''));
    }

    isDismissedState(previousState = '', pageState = {}) {
        const nextState = pageState.state || 'unknown';
        if (nextState && nextState !== previousState && !this.isBlockingPageState(nextState)) {
            return true;
        }
        if (previousState === 'login-prompt') {
            return this.isListLikePageState(pageState) || nextState === 'station-detail';
        }
        return nextState !== previousState;
    }

    dismissReasonForState(state = '') {
        const reasons = {
            'login-prompt': REASONS.LOGIN_PROMPT_MANUAL_REQUIRED,
            popup: REASONS.TAP_FAILED,
            marketing: REASONS.TAP_FAILED,
            'human-verification': REASONS.HUMAN_VERIFICATION_DETECTED
        };
        return reasons[state] || REASONS.TAP_FAILED;
    }

    dismissedReasonForState(state = '') {
        if (state === 'login-prompt') return REASONS.LOGIN_PROMPT_DISMISSED;
        return 'blocking_state_dismissed';
    }

    async executeDismissAction(action = {}, rawWindow = {}) {
        const type = String(action.type || 'tap');
        if (type === 'target') {
            const point = await this.clickTarget(action.target, rawWindow);
            return { point, clickBackend: point.clickBackend || null };
        }
        if (type === 'tap') {
            const point = this.profileActionPoint(action, rawWindow);
            const click = await this.clickAbsolute(point.x, point.y);
            return { point, clickBackend: click.backend };
        }
        if (type === 'commandBack') {
            await this.activateWechat();
            const script = [
                'tell application "System Events"',
                '  tell process "WeChat"',
                '    key code 33 using command down',
                '  end tell',
                'end tell'
            ].join('\n');
            await this.execFile('/usr/bin/osascript', ['-e', script], 5000);
            return {};
        }
        if (type === 'keyCode') {
            await this.activateWechat();
            const repeat = Math.max(1, Math.min(5, Number(action.repeat || 1)));
            const keyCode = Math.floor(Number(action.keyCode));
            if (!Number.isFinite(keyCode)) throw new Error(`invalid keyCode action: ${action.keyCode}`);
            const lines = [
                'tell application "System Events"',
                '  tell process "WeChat"'
            ];
            for (let i = 0; i < repeat; i++) {
                lines.push(`    key code ${keyCode}`);
            }
            lines.push('  end tell', 'end tell');
            await this.execFile('/usr/bin/osascript', ['-e', lines.join('\n')], 5000);
            return {};
        }
        throw new Error(`unsupported dismiss action type: ${type}`);
    }

    profileActionPoint(action = {}, rawWindow = {}) {
        const bounds = rawWindow.kCGWindowBounds || rawWindow.bounds || {};
        const left = Number(bounds.X ?? bounds.x ?? 0);
        const top = Number(bounds.Y ?? bounds.y ?? 0);
        const width = Number(bounds.Width ?? bounds.width ?? 0);
        const height = Number(bounds.Height ?? bounds.height ?? 0);
        if (!Number.isFinite(left) || !Number.isFinite(top) || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
            throw new Error('target window bounds unavailable');
        }
        const jitterX = this.randomJitter(Number(action.jitterX || 0));
        const jitterY = this.randomJitter(Number(action.jitterY || 0));
        return {
            x: Math.round(left + width * Number(action.xRatio || 0.5) + jitterX),
            y: Math.round(top + height * Number(action.yRatio || 0.5) + jitterY)
        };
    }

    randomJitter(range = 0) {
        const size = Math.max(0, Number(range) || 0);
        if (size <= 0) return 0;
        return Math.round((Math.random() * 2 - 1) * size);
    }

    async returnToListFromDetail(miniProgram, capture, options = {}) {
        const trace = [];
        let currentCapture = capture;
        const rawWindow = capture?.rawWindow || {};
        const candidates = [
            { type: 'target', target: capture?.pageState?.targets?.back, label: 'detail-back-target' },
            { type: 'tap', xRatio: 0.053, yRatio: 0.053, jitterX: 3, jitterY: 3, label: 'detail-back-header-left' },
            { type: 'tap', xRatio: 0.07, yRatio: 0.053, jitterX: 3, jitterY: 3, label: 'detail-back-header-wide' },
            { type: 'tap', xRatio: 0.053, yRatio: 0.075, jitterX: 3, jitterY: 3, label: 'detail-back-header-lower' },
            { type: 'commandBack', label: 'detail-back-command-left-bracket' },
            { type: 'keyCode', keyCode: 53, label: 'detail-back-escape' }
        ].filter(action => action.type !== 'target' || action.target);
        try {
            for (const action of candidates) {
                try {
                    const actionResult = await this.executeDismissAction(action, rawWindow);
                    trace.push({
                        action: 'return_detail_action',
                        status: 'success',
                        label: action.label,
                        point: actionResult.point || null,
                        clickBackend: actionResult.clickBackend || null
                    });
                    await this.sleep(Number(options.afterBackWaitMs || 1200));
                    currentCapture = await this.captureAndRecognize(miniProgram, `after-return-to-list-${action.label}`, options);
                    trace.push(this.traceFromCapture('observe_after_return_to_list', currentCapture, { label: action.label }));
                    currentCapture = await this.waitForListLikePage(miniProgram, currentCapture, options, trace, action.label);
                    if (this.isListLikePageState(currentCapture?.pageState || {})) {
                        return {
                            success: true,
                            reason: 'returned_to_list',
                            trace,
                            capture: currentCapture
                        };
                    }
                } catch (error) {
                    trace.push({
                        action: 'return_detail_action',
                        status: 'failed',
                        label: action.label,
                        reason: REASONS.BACK_FAILED,
                        error: error.message
                    });
                }
            }
            return {
                success: false,
                reason: 'still_station_detail',
                trace,
                capture: currentCapture
            };
        } catch (error) {
            trace.push({ action: 'return_detail_back', status: 'failed', reason: REASONS.BACK_FAILED, error: error.message });
            return { success: false, reason: REASONS.BACK_FAILED, trace, capture: currentCapture };
        }
    }

    isRecoverableNonMainlineState(state = '') {
        return ['station-search', 'city-search', 'empty-search', 'network-error', 'location-home', 'map-view'].includes(String(state || ''));
    }

    async recoverToMainList(miniProgram, capture, options = {}, trace = []) {
        let currentCapture = capture;
        let currentState = currentCapture?.pageState?.state || 'unknown';
        if (this.isListLikePageState(currentCapture?.pageState || {})) {
            return { success: true, reason: 'already_station_list', trace, capture: currentCapture };
        }
        if (this.isBlockingPageState(currentState)) {
            const dismissed = await this.dismissBlockingState(miniProgram, currentCapture, options, trace);
            currentCapture = dismissed.capture || currentCapture;
            currentState = currentCapture?.pageState?.state || currentState;
            if (this.isListLikePageState(currentCapture?.pageState || {})) {
                return { success: true, reason: 'returned_to_list_after_dismiss', trace, capture: currentCapture };
            }
        }
        if (currentState === 'station-detail') {
            const returned = await this.returnToListFromDetail(miniProgram, currentCapture, options);
            trace.push(...(returned.trace || []));
            return returned;
        }

        const attempted = new Set();
        for (let cycle = 0; cycle < 5; cycle += 1) {
            const stateAtCycleStart = currentState;
            const candidates = this.recoveryActionsForState(currentCapture, currentState)
                .filter(action => !attempted.has(`${currentState}:${action.label || action.type}`));
            if (candidates.length === 0) break;

            let shouldReplan = false;
            for (const action of candidates) {
                const actionState = currentState;
                const key = `${actionState}:${action.label || action.type}`;
                if (attempted.has(key)) continue;
                attempted.add(key);
                try {
                    const actionResult = await this.executeDismissAction(action, currentCapture?.rawWindow || {});
                    trace.push({
                        step: trace.length + 1,
                        action: 'recover_to_mainline_action',
                        status: 'success',
                        state: actionState,
                        label: action.label || action.type,
                        point: actionResult.point || null,
                        clickBackend: actionResult.clickBackend || null
                    });
                    await this.sleep(Number(action.delayMs || options.afterRecoveryActionWaitMs || 1400));
                    currentCapture = await this.captureAndRecognize(miniProgram, `after-recover-${action.label || action.type}`, options);
                    trace.push(this.traceFromCapture('observe_after_recover', currentCapture, { label: action.label || action.type }));
                    currentCapture = await this.waitForListLikePage(miniProgram, currentCapture, options, trace, action.label || action.type);
                    currentState = currentCapture?.pageState?.state || 'unknown';
                    if (this.isListLikePageState(currentCapture?.pageState || {})) {
                        return { success: true, reason: 'returned_to_list', trace, capture: currentCapture };
                    }
                    if (currentState === 'station-detail') {
                        const returned = await this.returnToListFromDetail(miniProgram, currentCapture, options);
                        trace.push(...(returned.trace || []));
                        if (returned.success) return returned;
                        currentCapture = returned.capture || currentCapture;
                        currentState = currentCapture?.pageState?.state || currentState;
                    }
                    if (this.isBlockingPageState(currentState)) {
                        const dismissed = await this.dismissBlockingState(miniProgram, currentCapture, options, trace);
                        currentCapture = dismissed.capture || currentCapture;
                        currentState = currentCapture?.pageState?.state || currentState;
                        if (this.isListLikePageState(currentCapture?.pageState || {})) {
                            return { success: true, reason: 'returned_to_list_after_dismiss', trace, capture: currentCapture };
                        }
                    }
                    if (currentState !== actionState) {
                        shouldReplan = true;
                        break;
                    }
                } catch (error) {
                    trace.push({
                        step: trace.length + 1,
                        action: 'recover_to_mainline_action',
                        status: 'failed',
                        state: actionState,
                        label: action.label || action.type,
                        reason: REASONS.TAP_FAILED,
                        error: error.message
                    });
                }
            }
            if (!shouldReplan && currentState === stateAtCycleStart) break;
        }
        return {
            success: false,
            reason: `${currentState || 'unknown'}_not_recovered_to_list`,
            trace,
            capture: currentCapture
        };
    }

    recoveryActionsForState(capture = {}, state = '') {
        const targets = capture?.pageState?.targets || {};
        const actions = [];
        const addTarget = (target, label, delayMs = 1400) => {
            if (target) actions.push({ type: 'target', target, label, delayMs });
        };
        if (state === 'station-search' || state === 'city-search') {
            addTarget(targets.nearbySearchAction, 'station-search-nearby-list', 2600);
            addTarget(targets.searchAction, 'station-search-submit', 2200);
            addTarget(targets.close, `${state}-close`, 1200);
            actions.push(
                { type: 'tap', xRatio: 0.053, yRatio: 0.053, jitterX: 3, jitterY: 3, delayMs: 1200, label: `${state}-header-back` },
                { type: 'commandBack', delayMs: 1200, label: `${state}-command-back` },
                { type: 'keyCode', keyCode: 53, delayMs: 1200, label: `${state}-escape` }
            );
        } else if (state === 'empty-search') {
            addTarget(targets.back, 'empty-search-back', 1200);
            addTarget(targets.close, 'empty-search-close', 1200);
            actions.push(
                { type: 'tap', xRatio: 0.165, yRatio: 0.104, jitterX: 4, jitterY: 4, delayMs: 1400, label: 'empty-search-mini-back' },
                { type: 'tap', xRatio: 0.185, yRatio: 0.104, jitterX: 4, jitterY: 4, delayMs: 1400, label: 'empty-search-mini-back-wide' },
                { type: 'commandBack', delayMs: 1200, label: 'empty-search-command-back' },
                { type: 'keyCode', keyCode: 53, delayMs: 1200, label: 'empty-search-escape' }
            );
        } else if (state === 'network-error') {
            addTarget(targets.refresh, 'network-refresh', 2600);
            actions.push(
                { type: 'commandBack', delayMs: 1200, label: 'network-command-back' },
                { type: 'keyCode', keyCode: 53, delayMs: 1200, label: 'network-escape' }
            );
        } else if (state === 'location-home') {
            addTarget(targets.enableLocationButton || targets.locationAuthorize, 'location-enable', 2200);
            addTarget(targets.searchTrigger, 'location-search-trigger', 1400);
            actions.push({ type: 'commandBack', delayMs: 1200, label: 'location-command-back' });
        } else if (state === 'map-view') {
            addTarget(targets.listButton, 'map-view-list-button', 1800);
            actions.push(
                { type: 'tap', xRatio: 0.09, yRatio: 0.032, jitterX: 4, jitterY: 3, delayMs: 1800, label: 'map-view-list-icon-top' },
                { type: 'tap', xRatio: 0.16, yRatio: 0.095, jitterX: 4, jitterY: 3, delayMs: 1800, label: 'map-view-list-button-row' },
                { type: 'commandBack', delayMs: 1400, label: 'map-view-command-back' }
            );
        } else {
            addTarget(targets.close, 'generic-close', 1200);
            actions.push(
                { type: 'commandBack', delayMs: 1200, label: 'generic-command-back' },
                { type: 'keyCode', keyCode: 53, delayMs: 1200, label: 'generic-escape' }
            );
        }
        return actions;
    }

    async waitForListLikePage(miniProgram, capture, options = {}, trace = [], label = '') {
        let current = capture;
        for (let i = 0; i < 3; i++) {
            if (this.isListLikePageState(current?.pageState || {}) || current?.pageState?.state === 'station-detail') {
                return current;
            }
            await this.sleep(Number(options.navigationSettleMs || 1200));
            current = await this.captureAndRecognize(miniProgram, `after-return-settle-${label}-${i + 1}`, options);
            trace.push(this.traceFromCapture('observe_after_return_settle', current, { label, settleAttempt: i + 1 }));
        }
        return current;
    }

    isListLikePageState(pageState = {}) {
        return pageState.state === 'station-list'
            || (pageState.state !== 'map-view' && Number(pageState.stationCount || 0) >= 2 && Number(pageState.listControlCount || 0) >= 2);
    }

    isLandmarkSearchRequest(options = {}, query = '') {
        if (String(options.searchMode || '').toLowerCase() === 'landmark') {
            return true;
        }
        return /(站|机场|航站楼|枢纽|广场|中心|园区|大厦|商场|万达|SOHO|公园|大学|新城|国贸|三里屯|西单|中关村|望京|四惠|五道口|亦庄|前海|华强北|车公庙|后海|坂田|蛇口|坪山|福田|南山|宝安|罗湖|龙岗|龙华|番禺|珠江|琶洲|客村|体育|天河|正佳|花城|白云|陆家嘴|徐家汇|静安寺|五角场|莘庄|张江|漕河泾|会展)/i.test(String(query || ''));
    }

    async dismissLoginPromptLegacy(miniProgram, beforeCapture, options = {}) {
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

    async checkTextInputCapability() {
        try {
            await this.execFile('/usr/bin/osascript', [
                '-e',
                'tell application "System Events" to key code 59'
            ], 3000);
            return {
                check: this.check('ready', 'text_input_ready', 'System Events keyboard automation is enabled')
            };
        } catch (error) {
            return {
                check: this.check(
                    'unavailable',
                    REASONS.INPUT_PERMISSION_DENIED,
                    error.message || 'System Events keyboard automation is not allowed for the current automation context'
                )
            };
        }
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
        const runtimeError = this.detectMiniProgramRuntimeError(textLines);
        const recognized = !runtimeError && this.isRecognized(pageState, textLines);

        return {
            status: recognized ? 'ready' : 'unavailable',
            reason: recognized ? REASONS.READY : REASONS.PAGE_NOT_RECOGNIZED,
            screenshotPath: screenshot.screenshotPath,
            window: this.formatWindow(screenshot.window),
            pageState: this.summarizePageState(pageState),
            textLines,
            text: textLines.join('\n'),
            ocrCount: textLines.length,
            runtimeError,
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
        const scrollProfile = resolveMiniProgramProfile(miniProgram);
        const targetStatus = await this.checkTargetWindow(miniProgram);
        const targetWindow = targetStatus.window ? this.formatWindow(targetStatus.window) : null;
        if (scrollProfile.inputMode === 'wheel') {
            const wheel = await this.scrollWithWheel(targetWindow, scrollProfile);
            return {
                status: 'ready',
                reason: 'scroll_ready',
                method: 'wheel',
                scrollCount: 1,
                wheel
            };
        }
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

    async scrollWithWheel(targetWindow = {}, profile = {}) {
        const bounds = targetWindow?.bounds || {};
        const left = Number(bounds.X ?? bounds.x ?? 0);
        const top = Number(bounds.Y ?? bounds.y ?? 0);
        const width = Number(bounds.Width ?? bounds.width ?? 0);
        const height = Number(bounds.Height ?? bounds.height ?? 0);
        if (!Number.isFinite(left) || !Number.isFinite(top) || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
            throw new Error('target window bounds unavailable');
        }
        const x = Math.round(left + width * Number(profile.wheelXRatio || 0.5));
        const y = Math.round(top + height * Number(profile.wheelYRatio || 0.52));
        const deltaY = Math.round(Number(profile.wheelDeltaY || -650));
        const repeat = Math.max(1, Math.min(10, Number(profile.wheelRepeat || 3)));
        const script = `
ObjC.import('ApplicationServices');
Application('WeChat').activate();
delay(0.15);
const point = $.CGPointMake(${x}, ${y});
const move = $.CGEventCreateMouseEvent(null, $.kCGEventMouseMoved, point, $.kCGMouseButtonLeft);
$.CGEventPost($.kCGHIDEventTap, move);
delay(0.08);
for (let i = 0; i < ${repeat}; i += 1) {
  const event = $.CGEventCreateScrollWheelEvent(null, $.kCGScrollEventUnitPixel, 1, ${deltaY});
  $.CGEventPost($.kCGHIDEventTap, event);
  delay(0.08);
}
delay(0.2);
`;
        await this.execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], 5000);
        return { x, y, deltaY, repeat };
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
        const click = await this.clickAbsolute(point.x, point.y);
        return { ...point, clickBackend: click.backend };
    }

    async clickAbsolute(x, y) {
        const point = this.normalizeAbsolutePoint(x, y);
        const backends = this.clickBackendOrder();
        const errors = [];
        for (const backend of backends) {
            try {
                await this.runClickBackend(backend, point.x, point.y);
                return { ...point, backend };
            } catch (error) {
                errors.push(`${backend}: ${error.message}`);
            }
        }
        throw new Error(`all click backends failed at (${point.x}, ${point.y}): ${errors.join(' | ')}`);
    }

    normalizeAbsolutePoint(x, y) {
        const point = {
            x: Math.round(Number(x)),
            y: Math.round(Number(y))
        };
        if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.y < 0) {
            throw new Error(`invalid click point: ${x}, ${y}`);
        }
        return point;
    }

    clickBackendOrder() {
        const configured = String(process.env.METHOD1_CLICK_BACKENDS || '')
            .split(',')
            .map(item => item.trim().toLowerCase())
            .filter(Boolean);
        const defaults = ['cgevent', 'cliclick', 'system_events'];
        return Array.from(new Set(configured.length ? configured : defaults));
    }

    async runClickBackend(backend, x, y) {
        switch (backend) {
            case 'system_events':
            case 'applescript':
                return this.clickWithSystemEvents(x, y);
            case 'cliclick':
                return this.clickWithCliclick(x, y);
            case 'cgevent':
            case 'jxa':
                return this.clickWithCgEvent(x, y);
            default:
                throw new Error(`unknown click backend: ${backend}`);
        }
    }

    async clickWithSystemEvents(x, y) {
        const script = `
tell application "WeChat" to activate
delay 0.2
tell application "System Events"
  click at {${Number(x)}, ${Number(y)}}
end tell
delay 0.15
`;
        await this.execFile('/usr/bin/osascript', ['-e', script], 5000);
    }

    async clickWithCliclick(x, y) {
        const binary = await this.resolveCliclickBinary();
        await this.execFile(binary, [
            `m:${Number(x)},${Number(y)}`,
            'w:120',
            `c:${Number(x)},${Number(y)}`
        ], 5000);
    }

    async resolveCliclickBinary() {
        const candidates = [
            process.env.CLICLICK_BIN,
            '/opt/homebrew/bin/cliclick',
            '/usr/local/bin/cliclick',
            '/usr/bin/cliclick'
        ].filter(Boolean);
        for (const candidate of candidates) {
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        }
        try {
            const result = await this.execFile('/usr/bin/which', ['cliclick'], 2000);
            const resolved = String(result.stdout || '').trim().split('\n')[0];
            if (resolved && fs.existsSync(resolved)) return resolved;
        } catch (_) {}
        throw new Error('cliclick binary not found');
    }

    async clickWithCgEvent(x, y) {
        const script = `
ObjC.import('ApplicationServices');
Application('WeChat').activate();
delay(0.18);
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
delay(0.15);
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
        const clipboardScript = `
on run argv
  set the clipboard to item 1 of argv
end run
`;
        await this.execFile('/usr/bin/osascript', ['-e', clipboardScript, String(text || '')], 5000);

        const keyScript = `
tell application "WeChat" to activate
delay 0.12
tell application "System Events"
  keystroke "a" using command down
  delay 0.08
  key code 51
  delay 0.08
  keystroke "v" using command down
  delay 0.18
end tell
`;
        await this.execFile('/usr/bin/osascript', ['-e', keyScript], 8000);
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
            scrollScript: this.check('unavailable', REASONS.SCROLL_SCRIPT_MISSING, ''),
            textInput: this.check('unavailable', REASONS.INPUT_PERMISSION_DENIED, '')
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

    workflowDiagnosticsFromChecks(checks = {}, fallbackReason = REASONS.UNKNOWN_ERROR, error = '') {
        const diagnostics = Object.entries(checks)
            .filter(([, check]) => check && check.status !== 'ready')
            .map(([name, check]) => ({
                code: check.reason || fallbackReason,
                component: name,
                status: check.status || 'unknown',
                message: check.message || ''
            }));
        if (diagnostics.length === 0 && fallbackReason && fallbackReason !== REASONS.READY) {
            diagnostics.push({
                code: fallbackReason,
                component: 'method1',
                status: 'unavailable',
                message: error || ''
            });
        }
        return diagnostics;
    }

    workflowStageForReason(reason, available) {
        if (available) return 'ready';
        const stageByReason = {
            [REASONS.WECHAT_NOT_RUNNING]: 'wechat',
            [REASONS.TARGET_WINDOW_MISSING]: 'miniapp_window',
            [REASONS.SCREENSHOT_FAILED]: 'screenshot',
            [REASONS.OCR_UNAVAILABLE]: 'ocr',
            [REASONS.SCROLL_SCRIPT_MISSING]: 'scroll_script',
            [REASONS.CITY_INPUT_NOT_APPLIED]: 'input_permission',
            [REASONS.INPUT_PERMISSION_DENIED]: 'input_permission',
            [REASONS.PERMISSION_DENIED]: 'permission'
        };
        return stageByReason[reason] || 'diagnose';
    }

    workflowNextAction(reason, stage) {
        const actions = {
            [REASONS.READY]: 'Method1 readiness is available; continue with observe, switch-city, scroll, or adaptive run under operator control.',
            [REASONS.WECHAT_NOT_RUNNING]: 'Open desktop WeChat and keep the mini program account state under normal user control.',
            [REASONS.TARGET_WINDOW_MISSING]: 'Open the target WeChat mini program window for the selected platform, then recheck readiness.',
            [REASONS.SCREENSHOT_FAILED]: 'Grant macOS Screen Recording permission and keep the target mini program window visible.',
            [REASONS.OCR_UNAVAILABLE]: 'Install or repair the local OCR helper, then recheck readiness.',
            [REASONS.SCROLL_SCRIPT_MISSING]: 'Restore the Method1 scroll automation script under the automation directory.',
            [REASONS.CITY_INPUT_NOT_APPLIED]: 'Keep the WeChat mini program search box focused and grant Accessibility/Input Monitoring permissions to the automation process if automated paste is ignored.',
            [REASONS.INPUT_PERMISSION_DENIED]: 'Grant macOS Accessibility permission to the automation context, or run the backend from an already-authorized desktop session, then recheck Method1 workflow readiness.',
            [REASONS.LOGIN_REQUIRED_FOR_MORE_RESULTS]: 'Complete or explicitly skip the Didi mini program login requirement in the desktop WeChat session, then rerun Method1 collection.',
            [REASONS.PERMISSION_DENIED]: 'Grant required macOS Accessibility and Screen Recording permissions, then recheck readiness.'
        };
        return actions[reason] || `Review Method1 ${stage || 'diagnose'} diagnostics and recheck readiness.`;
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
            loginLimitedList: this.hasLoginLimitedListSignal(pageState, visibleItemKeys),
            pageState,
            targetCity: options.targetCity || options.city || ''
        };
    }

    hasLoginLimitedListSignal(pageState = {}, visibleItems = []) {
        if (pageState.state !== 'station-list') {
            return false;
        }
        const text = (Array.isArray(visibleItems) ? visibleItems : []).join('\n');
        return /登录后，?使用完整充电功能|立即登录/.test(text);
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

    decideNextAdaptiveAction(observation = {}, context = {}) {
        const pageType = observation.pageType || 'unknown';
        const visibleItems = Array.isArray(observation.visibleItemKeys) ? observation.visibleItemKeys : [];
        const blockingStates = ['login-prompt', 'popup', 'marketing'];
        if (blockingStates.includes(pageType)) {
            return {
                action: 'dismiss',
                success: false,
                reason: `${pageType}_dismiss_required`,
                newItemCount: 0
            };
        }
        if (pageType === 'human-verification') {
            return {
                action: 'stop',
                success: false,
                reason: REASONS.HUMAN_VERIFICATION_DETECTED,
                newItemCount: 0
            };
        }
        if (pageType === 'station-detail') {
            return {
                action: 'back',
                success: false,
                reason: 'station_detail_return_to_list',
                newItemCount: 0
            };
        }
        if (this.isRecoverableNonMainlineState(pageType)) {
            return {
                action: 'recover',
                success: false,
                reason: `${pageType}_recover_to_list_required`,
                newItemCount: 0
            };
        }
        if (pageType === 'network-error' || pageType === 'empty-result') {
            return {
                action: 'stop',
                success: false,
                reason: pageType === 'network-error' ? 'network_error_detected' : REASONS.EMPTY_RESULT,
                newItemCount: 0
            };
        }

        const seenItems = context.seenItems instanceof Set ? context.seenItems : new Set();
        const beforeCount = seenItems.size;
        visibleItems.forEach(item => seenItems.add(item));
        context.seenItems = seenItems;
        const newItemCount = seenItems.size - beforeCount;
        const maxScrolls = Number(context.maxScrolls || 0);
        const scrolls = Number(context.scrolls || 0);
        if (observation.loginLimitedList) {
            context.loginLimitedList = true;
        }

        if (scrolls >= maxScrolls) {
            return {
                action: 'stop',
                success: seenItems.size > 0,
                reason: seenItems.size > 0 ? REASONS.MAX_SCROLLS_REACHED : REASONS.PAGE_NOT_RECOGNIZED,
                newItemCount
            };
        }
        if (pageType === 'station-list' || pageType === 'list' || Number(observation.pageState?.stationCount || 0) > 0) {
            if (scrolls > 0 && newItemCount === 0) {
                if (observation.loginLimitedList && scrolls < maxScrolls) {
                    return {
                        action: 'scroll',
                        success: false,
                        reason: 'logged_out_list_continue_scroll_probe',
                        newItemCount
                    };
                }
                return {
                    action: 'stop',
                    success: seenItems.size > 0,
                    reason: REASONS.NO_NEW_ITEMS_AFTER_SCROLL,
                    newItemCount
                };
            }
            return {
                action: 'scroll',
                success: false,
                reason: 'list_scroll_required',
                newItemCount
            };
        }
        if (visibleItems.length >= 3 && scrolls < maxScrolls) {
            return {
                action: 'scroll',
                success: false,
                reason: 'recognized_page_scroll_probe',
                newItemCount
            };
        }
        return {
            action: 'stop',
            success: false,
            reason: REASONS.PAGE_NOT_RECOGNIZED,
            newItemCount
        };
    }

    finishAdaptive(success, reason, context = {}) {
        return {
            success: Boolean(success),
            available: true,
            reason: reason || (success ? REASONS.READY : REASONS.UNKNOWN_ERROR),
            status: success ? 'passed' : 'failed',
            summary: this.adaptiveSummary(context),
            actionTrace: Array.isArray(context.actionTrace) ? context.actionTrace : []
        };
    }

    adaptiveSummary(context = {}) {
        const seenItems = context.seenItems instanceof Set ? Array.from(context.seenItems) : [];
        return {
            goal: context.goal || 'station_list_scroll',
            steps: Number(context.steps || 0),
            observations: Number(context.observations || 0),
            scrolls: Number(context.scrolls || 0),
            backs: Number(context.backs || 0),
            loginLimitedList: Boolean(context.loginLimitedList),
            visibleItemCount: seenItems.length,
            visibleItems: seenItems.slice(0, 30)
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

    containsNormalizedQuery(lines = [], query = '') {
        const expected = this.normalizeCityName(query);
        if (!expected || !Array.isArray(lines)) return false;
        return lines.some(line => this.normalizeCityName(line).includes(expected));
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

    findStrictTextTarget(ocrRows = [], text = '') {
        const expected = this.normalizeCityName(text) || this.normalizeText(text);
        if (!expected || !Array.isArray(ocrRows)) return null;
        for (const row of ocrRows) {
            const rowText = String(row.text || '');
            const normalized = this.normalizeCityName(rowText) || this.normalizeText(rowText);
            if (!normalized) continue;
            if (normalized.includes(expected) || rowText.includes(text)) {
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
        if (this.detectMiniProgramRuntimeError(textLines)) {
            return false;
        }
        return pageState.state !== 'unknown'
            || Number(pageState.stationCount || 0) > 0
            || Number(pageState.listControlCount || 0) > 0
            || Number(pageState.detailCount || 0) > 0
            || textLines.length >= 3;
    }

    detectMiniProgramRuntimeError(textLines = []) {
        const text = Array.isArray(textLines) ? textLines.join('\n') : String(textLines || '');
        const compact = text.replace(/\s+/g, ' ').trim();
        if (!compact) return '';
        const patterns = [
            /Cannot\s+read\s+properties\s+of\s+undefined/i,
            /Cannot\s+read\s+property/i,
            /TypeError|ReferenceError|SyntaxError/i,
            /MiniprogramError|MiniProgramError|小程序.*错误|页面.*异常/
        ];
        const matched = patterns.some(pattern => pattern.test(compact));
        return matched ? compact.slice(0, 240) : '';
    }

    summarizePageState(pageState = {}) {
        return {
            state: pageState.state || 'unknown',
            label: pageState.label || '未知页面',
            stationCount: Number(pageState.stationCount || 0),
            detailCount: Number(pageState.detailCount || 0),
            listControlCount: Number(pageState.listControlCount || 0),
            searchCount: Number(pageState.searchCount || 0),
            stationSearchCount: Number(pageState.stationSearchCount || 0),
            marketingCount: Number(pageState.marketingCount || 0),
            loginCount: Number(pageState.loginCount || 0),
            emptySearchCount: Number(pageState.emptySearchCount || 0),
            networkErrorCount: Number(pageState.networkErrorCount || 0),
            humanVerificationCount: Number(pageState.humanVerificationCount || 0),
            locationPrompt: pageState.locationPrompt || null,
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
