const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

class WechatLiveOCRService {
    constructor(options = {}) {
        this.projectRoot = options.projectRoot;
        this.parsers = options.parsers || {};
        this.defaultParser = options.defaultParser || null;
        this.windowHelperSource = path.join(this.projectRoot, 'automation/list-mac-windows.m');
        this.windowHelperBinary = '/tmp/list-mac-windows';
        this.ocrHelperSource = path.join(this.projectRoot, 'automation/ocr-image.m');
        this.ocrHelperBinary = '/tmp/ocr-image';
        this.captureDir = path.join(this.projectRoot, 'data/page-ocr');
    }

    captureCurrentWindow(options = {}) {
        const platform = String(options.platform || '').trim();
        const parser = this.parsers[platform] || this.defaultParser;
        if (!parser || typeof parser.extractStations !== 'function') {
            throw new Error(`未找到页面识别解析器: ${platform || 'unknown'}`);
        }

        this.ensureWindowHelper();
        this.ensureOcrHelper();

        const timestamp = Date.now();
        const platformDir = path.join(this.captureDir, platform || 'unknown');
        const ocrPath = path.join(platformDir, `ocr-${timestamp}.json`);
        const capturePath = path.join(platformDir, `capture-${timestamp}.json`);

        if (!fs.existsSync(platformDir)) {
            fs.mkdirSync(platformDir, { recursive: true });
        }

        const screenshot = this.captureWindowScreenshot({
            ...options,
            platform,
            timestamp
        });
        const ocrRows = this.runOcrOnScreenshot(screenshot.screenshotPath);

        const meta = {
            source: 'page-ocr',
            platform,
            stage: options.stage || null,
            capturedAt: new Date(timestamp).toISOString(),
            screenshotPath: screenshot.screenshotPath,
            capture: screenshot.capture,
            window: {
                id: screenshot.window.kCGWindowNumber,
                ownerName: screenshot.window.kCGWindowOwnerName,
                name: screenshot.window.kCGWindowName,
                bounds: screenshot.window.kCGWindowBounds,
                selectionScore: screenshot.window.__selectionScore,
                selectionReason: screenshot.window.__selectionReason
            }
        };

        const stations = parser.extractStations(ocrRows, meta);

        fs.writeFileSync(ocrPath, JSON.stringify(ocrRows, null, 2), 'utf8');
        fs.writeFileSync(capturePath, JSON.stringify({ meta, stations }, null, 2), 'utf8');

        return {
            meta,
            screenshotPath: screenshot.screenshotPath,
            ocrPath,
            capturePath,
            ocrRows,
            stations
        };
    }

    testWindowCapture(options = {}) {
        this.ensureWindowHelper();

        const window = this.findWechatWindow(options);
        const screenshotPath = path.join('/private/tmp', `capture-check-${Date.now()}.png`);

        try {
            execFileSync('/usr/sbin/screencapture', ['-x', '-l', String(window.kCGWindowNumber), screenshotPath], { stdio: 'pipe' });
            try {
                fs.unlinkSync(screenshotPath);
            } catch (error) {
                // Ignore cleanup errors for short-lived diagnostic files.
            }
            return {
                capturable: true,
                window
            };
        } catch (error) {
            // 窗口截图失败（如 Screen Recording 权限不足），尝试全屏截图+裁剪
            const fullScreenshotPath = path.join('/private/tmp', `capture-check-full-${Date.now()}.png`);
            try {
                execFileSync('/usr/sbin/screencapture', ['-x', fullScreenshotPath], { stdio: 'pipe' });
                try { fs.unlinkSync(fullScreenshotPath); } catch (_) {}
                return {
                    capturable: true,
                    window,
                    fallback: true,
                    mode: 'full-screen-crop'
                };
            } catch (fullError) {
                return {
                    capturable: false,
                    window,
                    error: this.formatCommandError(error)
                };
            }
        }
    }

    captureWindowScreenshot(options = {}) {
        this.ensureWindowHelper();
        const platform = String(options.platform || '').trim();
        const timestamp = Number(options.timestamp) || Date.now();
        const window = options.window || this.findWechatWindow(options);
        const screenshotPath = options.screenshotPath
            || path.join('/private/tmp', `${platform || 'unknown'}-window-${timestamp}.png`);
        const capture = this.captureWindowImage(window, screenshotPath, platform, timestamp);

        return {
            window,
            screenshotPath,
            capture
        };
    }

    runOcrOnScreenshot(screenshotPath) {
        this.ensureOcrHelper();
        const ocrRaw = execFileSync(this.ocrHelperBinary, [screenshotPath], { encoding: 'utf8', stdio: 'pipe' });
        return JSON.parse(ocrRaw);
    }

    captureWindowImage(window, screenshotPath, platform, timestamp) {
        const windowId = String(window.kCGWindowNumber);
        const info = {
            mode: 'window',
            fallback: false,
            windowId
        };

        try {
            execFileSync('/usr/sbin/screencapture', ['-x', '-l', windowId, screenshotPath], { stdio: 'pipe', timeout: 5000 });
            return info;
        } catch (windowError) {
            info.fallback = true;
            info.windowCaptureError = this.formatCommandError(windowError);
        }

        const fullScreenshotPath = path.join('/private/tmp', `${platform || 'unknown'}-full-${timestamp}.png`);
        try {
            execFileSync('/usr/sbin/screencapture', ['-x', fullScreenshotPath], { stdio: 'pipe', timeout: 8000 });
            const bounds = this.normalizeBounds(window.kCGWindowBounds);

            if (!bounds) {
                fs.copyFileSync(fullScreenshotPath, screenshotPath);
                return {
                    ...info,
                    mode: 'full-screen',
                    fullScreenshotPath
                };
            }

            try {
                execFileSync('/usr/bin/sips', [
                    '--cropToHeightWidth',
                    String(bounds.height),
                    String(bounds.width),
                    '--cropOffset',
                    String(bounds.y),
                    String(bounds.x),
                    fullScreenshotPath,
                    '--out',
                    screenshotPath
                ], { stdio: 'pipe' });

                return {
                    ...info,
                    mode: 'full-screen-crop',
                    fullScreenshotPath,
                    cropBounds: bounds
                };
            } catch (cropError) {
                fs.copyFileSync(fullScreenshotPath, screenshotPath);
                return {
                    ...info,
                    mode: 'full-screen',
                    fullScreenshotPath,
                    cropError: this.formatCommandError(cropError)
                };
            }
        } catch (fallbackError) {
            const error = new Error(this.buildCaptureFailureMessage(window, info.windowCaptureError, fallbackError));
            error.cause = fallbackError;
            throw error;
        }
    }

    normalizeBounds(bounds = {}) {
        const x = Math.max(0, Math.round(Number(bounds.X)));
        const y = Math.max(0, Math.round(Number(bounds.Y)));
        const width = Math.round(Number(bounds.Width));
        const height = Math.round(Number(bounds.Height));

        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)
            || width <= 0 || height <= 0) {
            return null;
        }

        return { x, y, width, height };
    }

    buildCaptureFailureMessage(window, windowCaptureError, fallbackError) {
        const ownerName = String(window.kCGWindowOwnerName || '未知应用');
        const windowName = String(window.kCGWindowName || '无标题窗口');
        const fallbackMessage = this.formatCommandError(fallbackError);
        return [
            `无法截取微信小程序窗口: ${ownerName} / ${windowName}`,
            `窗口截图失败: ${windowCaptureError || 'unknown'}`,
            `全屏兜底截图失败: ${fallbackMessage || 'unknown'}`,
            '请确认远端桌面已授予运行服务的 Terminal/iTerm/SSH 屏幕录制权限，并且微信小程序窗口在当前桌面可见'
        ].join('；');
    }

    formatCommandError(error) {
        const stderr = error?.stderr ? String(error.stderr).trim() : '';
        const message = String(error?.message || '').trim();
        return stderr || message || 'unknown error';
    }

    ensureHelper(sourcePath, binaryPath, compilerArgs) {
        const sourceStat = fs.statSync(sourcePath);
        const binaryExists = fs.existsSync(binaryPath);
        const binaryStat = binaryExists ? fs.statSync(binaryPath) : null;

        if (!binaryExists || sourceStat.mtimeMs > binaryStat.mtimeMs) {
            execFileSync(compilerArgs[0], [...compilerArgs.slice(1), sourcePath, '-o', binaryPath], { stdio: 'pipe' });
        }
    }

    ensureWindowHelper() {
        this.ensureHelper(
            this.windowHelperSource,
            this.windowHelperBinary,
            ['/usr/bin/clang', '-framework', 'Foundation', '-framework', 'CoreGraphics']
        );
    }

    ensureOcrHelper() {
        this.ensureHelper(
            this.ocrHelperSource,
            this.ocrHelperBinary,
            ['/usr/bin/clang', '-framework', 'Foundation', '-framework', 'Vision', '-framework', 'ImageIO', '-framework', 'CoreGraphics']
        );
    }

    findWechatWindow(options = {}) {
        const windows = this.listWechatWindows();

        const titleKeywords = Array.isArray(options.titleKeywords) && options.titleKeywords.length > 0
            ? options.titleKeywords.filter(Boolean)
            : [];

        const candidates = windows
            .filter(window => this.isWechatWindow(window))
            .map((window, index) => this.decorateWindowCandidate(window, index, titleKeywords))
            .sort((a, b) => {
                if (b.__selectionScore !== a.__selectionScore) {
                    return b.__selectionScore - a.__selectionScore;
                }
                return a.__windowIndex - b.__windowIndex;
            });

        if (candidates.length > 0) {
            return candidates[0];
        }

        throw new Error('未找到微信小程序窗口，请先在微信中打开对应页面');
    }

    listWechatWindows() {
        this.ensureWindowHelper();
        const output = execFileSync(this.windowHelperBinary, { encoding: 'utf8', stdio: 'pipe' });
        return output
            .split('\n')
            .map(line => line.trim())
            .filter(Boolean)
            .map(line => JSON.parse(line))
            .filter(window => this.isWechatWindow(window));
    }

    isWechatWindow(window) {
        const ownerName = String(window.kCGWindowOwnerName || '');
        return ['WeApp', 'WeChat', 'WeChatAppEx', '微信'].includes(ownerName)
            || ownerName.includes('WeChat')
            || ownerName.includes('微信');
    }

    decorateWindowCandidate(window, index, titleKeywords) {
        const ownerName = String(window.kCGWindowOwnerName || '');
        const windowName = String(window.kCGWindowName || '');
        const bounds = window.kCGWindowBounds || {};
        const width = Number(bounds.Width || 0);
        const height = Number(bounds.Height || 0);
        const area = width * height;

        let selectionScore = 0;
        let selectionReason = 'fallback';

        if (titleKeywords.some(keyword => windowName.includes(keyword))) {
            selectionScore += 1000;
            selectionReason = 'title_keyword';
        }

        if (['WeApp', 'WeChat', 'WeChatAppEx', '微信'].includes(ownerName)
            || ownerName.includes('WeChat')
            || ownerName.includes('微信')) {
            selectionScore += 200;
            if (selectionReason === 'fallback') {
                selectionReason = 'wechat_owner';
            }
        }

        if (windowName) {
            selectionScore += 40;
        }

        if (width >= 500 && height >= 500) {
            selectionScore += 120;
            if (selectionReason === 'fallback') {
                selectionReason = 'large_window';
            }
        }

        selectionScore += Math.min(120, Math.round(area / 10000));
        selectionScore += Math.max(0, 30 - index);

        return {
            ...window,
            __windowIndex: index,
            __selectionScore: selectionScore,
            __selectionReason: selectionReason
        };
    }
}

module.exports = WechatLiveOCRService;
