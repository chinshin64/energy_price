const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

class TeldLiveOCRService {
    constructor(options = {}) {
        this.projectRoot = options.projectRoot;
        this.parser = options.parser;
        this.windowHelperSource = path.join(this.projectRoot, 'automation/list-mac-windows.m');
        this.windowHelperBinary = '/tmp/list-mac-windows';
        this.ocrHelperSource = path.join(this.projectRoot, 'automation/ocr-image.m');
        this.ocrHelperBinary = '/tmp/ocr-image';
        this.captureDir = path.join(this.projectRoot, 'data/teld-ocr');
    }

    captureCurrentWindow(options = {}) {
        this.ensureHelper(
            this.windowHelperSource,
            this.windowHelperBinary,
            ['/usr/bin/clang', '-framework', 'Foundation', '-framework', 'CoreGraphics']
        );
        this.ensureHelper(
            this.ocrHelperSource,
            this.ocrHelperBinary,
            ['/usr/bin/clang', '-framework', 'Foundation', '-framework', 'Vision', '-framework', 'ImageIO', '-framework', 'CoreGraphics']
        );

        const window = this.findTeldWindow(options);
        const timestamp = Date.now();
        const screenshotPath = path.join('/private/tmp', `teld-window-${timestamp}.png`);
        const ocrPath = path.join(this.captureDir, `ocr-${timestamp}.json`);
        const capturePath = path.join(this.captureDir, `capture-${timestamp}.json`);

        if (!fs.existsSync(this.captureDir)) {
            fs.mkdirSync(this.captureDir, { recursive: true });
        }

        execFileSync('/usr/sbin/screencapture', ['-x', '-l', String(window.kCGWindowNumber), screenshotPath], { stdio: 'pipe' });
        const ocrRaw = execFileSync(this.ocrHelperBinary, [screenshotPath], { encoding: 'utf8', stdio: 'pipe' });
        const ocrRows = JSON.parse(ocrRaw);

        const meta = {
            source: 'teld-live-ocr',
            capturedAt: new Date(timestamp).toISOString(),
            screenshotPath,
            window: {
                id: window.kCGWindowNumber,
                ownerName: window.kCGWindowOwnerName,
                name: window.kCGWindowName,
                bounds: window.kCGWindowBounds,
                selectionScore: window.__selectionScore,
                selectionReason: window.__selectionReason
            }
        };

        const stations = this.parser.extractStations(ocrRows, meta);

        fs.writeFileSync(ocrPath, JSON.stringify(ocrRows, null, 2), 'utf8');
        fs.writeFileSync(capturePath, JSON.stringify({ meta, stations }, null, 2), 'utf8');

        return {
            meta,
            screenshotPath,
            ocrPath,
            capturePath,
            ocrRows,
            stations
        };
    }

    ensureHelper(sourcePath, binaryPath, compilerArgs) {
        const sourceStat = fs.statSync(sourcePath);
        const binaryExists = fs.existsSync(binaryPath);
        const binaryStat = binaryExists ? fs.statSync(binaryPath) : null;

        if (!binaryExists || sourceStat.mtimeMs > binaryStat.mtimeMs) {
            execFileSync(compilerArgs[0], [...compilerArgs.slice(1), sourcePath, '-o', binaryPath], { stdio: 'pipe' });
        }
    }

    findTeldWindow(options = {}) {
        const output = execFileSync(this.windowHelperBinary, { encoding: 'utf8', stdio: 'pipe' });
        const windows = output
            .split('\n')
            .map(line => line.trim())
            .filter(Boolean)
            .map(line => JSON.parse(line));

        const titleKeywords = Array.isArray(options.titleKeywords) && options.titleKeywords.length > 0
            ? options.titleKeywords.filter(Boolean)
            : ['特来电'];

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

    isWechatWindow(window) {
        const ownerName = String(window.kCGWindowOwnerName || '');
        const windowName = String(window.kCGWindowName || '');
        return ['WeApp', 'WeChat', 'WeChatAppEx'].includes(ownerName) || /特来电/.test(windowName);
    }

    decorateWindowCandidate(window, index, titleKeywords) {
        const ownerName = String(window.kCGWindowOwnerName || '');
        const windowName = String(window.kCGWindowName || '');
        const bounds = window.kCGWindowBounds || {};
        const width = Number(bounds.Width || 0);
        const height = Number(bounds.Height || 0);
        const area = width * height;
        const normalizedKeywords = titleKeywords
            .map(keyword => String(keyword || '').trim())
            .filter(Boolean);

        let selectionScore = 0;
        let selectionReason = 'fallback';

        if (normalizedKeywords.some(keyword => windowName.includes(keyword))) {
            selectionScore += 1000;
            selectionReason = 'title_keyword';
        }

        if (['WeApp', 'WeChat', 'WeChatAppEx'].includes(ownerName)) {
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

module.exports = TeldLiveOCRService;
