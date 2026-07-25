'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const SUPPORTED_PLATFORMS = Object.freeze([
    'didi',
    'teld',
    'star-charge',
    'kuaidian',
    'tuanyou',
    'xdt'
]);

const DEFAULT_CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEFAULT_SIGN_TIMEOUT_MS = 5000;

function envEnabled(value, fallback = true) {
    if (value === undefined || value === null || value === '') return fallback;
    return !['0', 'false', 'off', 'disabled'].includes(String(value).trim().toLowerCase());
}

function boundedError(error) {
    return String(error?.message || error || 'unknown error')
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/\s+/g, ' ')
        .slice(0, 240);
}

function normalizePathList(value) {
    if (Array.isArray(value)) return value.filter(Boolean).map(item => path.resolve(String(item)));
    if (!value) return [];
    return String(value)
        .split(path.delimiter)
        .map(item => item.trim())
        .filter(Boolean)
        .map(item => path.resolve(item));
}

function buildDefaultPlatformDefinitions(homeDir = os.homedir()) {
    const didiRoot = path.join(__dirname, '../resources/browser-signer/didi');
    return {
        didi: {
            moduleSystem: 'webpack',
            sourcePaths: [
                process.env.BROWSER_SIGNER_DIDI_MAIN_PATH
                    || path.join(didiRoot, 'APPAPPAPP/app-service.js'),
                process.env.BROWSER_SIGNER_DIDI_WSGSIG_PATH
                    || path.join(didiRoot, '_wsgsig_/wsgsig/app-service.js')
            ]
        },
        teld: {
            moduleSystem: 'define',
            sourcePaths: [process.env.BROWSER_SIGNER_TELD_PATH || path.join(homeDir, 'teld-app-service.js')]
        },
        'star-charge': {
            moduleSystem: 'webpack',
            sourcePaths: [
                process.env.BROWSER_SIGNER_STARCHARGE_PATH || path.join(homeDir, 'starcharge-app-service.js')
            ]
        },
        kuaidian: {
            moduleSystem: 'webpack',
            sourcePaths: [
                process.env.BROWSER_SIGNER_KUAIDIAN_PATH || path.join(homeDir, 'kuaidian-app-service.js')
            ]
        },
        tuanyou: {
            moduleSystem: 'define',
            sourcePaths: [
                process.env.BROWSER_SIGNER_TUANYOU_PATH || path.join(homeDir, 'tuanyou-app-service.js')
            ]
        },
        xdt: {
            moduleSystem: 'webpack',
            sourcePaths: [process.env.BROWSER_SIGNER_XDT_PATH || path.join(homeDir, 'xdt-app-service.js')]
        }
    };
}

function installMiniProgramRuntime(mockOptions = {}) {
    const storage = new Map();
    const localStorageMock = {
        getItem: key => storage.has(String(key)) ? String(storage.get(String(key))) : null,
        setItem: (key, value) => storage.set(String(key), String(value)),
        removeItem: key => storage.delete(String(key)),
        clear: () => storage.clear(),
        key: index => Array.from(storage.keys())[Number(index)] || null,
        get length() { return storage.size; }
    };
    const definedModules = Object.create(null);
    const moduleCache = Object.create(null);
    const noop = () => undefined;
    const asyncSuccess = (options, payload = {}) => {
        if (options && typeof options.success === 'function') options.success(payload);
        if (options && typeof options.complete === 'function') options.complete(payload);
    };

    const wxBase = {
        env: { USER_DATA_PATH: '/tmp' },
        canIUse: () => false,
        getAccountInfoSync: () => ({
            miniProgram: {
                appId: mockOptions.appId || '',
                envVersion: 'release',
                version: mockOptions.appVersion || ''
            }
        }),
        getSystemInfoSync: () => ({
            platform: 'android',
            system: 'Android 14',
            brand: 'Google',
            model: 'Pixel 8 Pro',
            SDKVersion: '3.3.5',
            language: 'zh_CN',
            version: '8.0.55'
        }),
        getDeviceInfo: () => ({ platform: 'android', brand: 'Google', model: 'Pixel 8 Pro' }),
        getAppBaseInfo: () => ({ SDKVersion: '3.3.5', language: 'zh_CN', version: '8.0.55' }),
        getWindowInfo: () => ({ pixelRatio: 3, screenWidth: 393, screenHeight: 852 }),
        getStorageSync: key => storage.get(String(key)),
        setStorageSync: (key, value) => storage.set(String(key), value),
        removeStorageSync: key => storage.delete(String(key)),
        clearStorageSync: () => storage.clear(),
        getNetworkType: options => asyncSuccess(options, { networkType: 'wifi' }),
        request: options => asyncSuccess(options, { statusCode: 599, data: null, header: {} }),
        login: options => asyncSuccess(options, { code: '' }),
        getLocation: options => asyncSuccess(options, { latitude: 0, longitude: 0 }),
        onNetworkStatusChange: noop,
        onAppShow: noop,
        onAppHide: noop,
        onError: noop,
        onUnhandledRejection: noop
    };
    window.wx = new Proxy(wxBase, {
        get(target, property) {
            if (property in target) return target[property];
            return noop;
        }
    });

    function resolveModule(request, currentModule) {
        let resolved = String(request || '');
        if (resolved.startsWith('.')) {
            const parts = String(currentModule || '__root__').split('/');
            parts.pop();
            for (const piece of resolved.split('/')) {
                if (!piece || piece === '.') continue;
                if (piece === '..') parts.pop();
                else parts.push(piece);
            }
            resolved = parts.join('/');
        }
        const candidates = [resolved, `${resolved}.js`];
        for (const candidate of candidates) {
            if (definedModules[candidate]) return candidate;
        }
        for (const key of Object.keys(definedModules)) {
            if (key === resolved || key.endsWith(`/${resolved}`) || resolved.endsWith(key)) return key;
        }
        const tail = resolved.split('/').pop();
        return Object.keys(definedModules).find(key => key.split('/').pop() === tail) || '';
    }

    function makeRequire(currentModule) {
        return function miniRequire(request) {
            const resolved = resolveModule(request, currentModule);
            if (!resolved) throw new Error(`mini program module not found: ${request}`);
            if (moduleCache[resolved]) return moduleCache[resolved].exports;
            const moduleObject = { exports: {} };
            moduleCache[resolved] = moduleObject;
            const factory = definedModules[resolved];
            try {
                factory(
                    makeRequire(resolved),
                    moduleObject,
                    moduleObject.exports,
                    window,
                    document,
                    window.frames,
                    window,
                    window.location,
                    window.navigator,
                    localStorageMock,
                    window.history,
                    window.caches,
                    window.screen,
                    window.alert,
                    window.confirm,
                    window.prompt,
                    window.XMLHttpRequest,
                    window.WebSocket,
                    window.Reporter,
                    window.webkit,
                    window.WeixinJSCore
                );
            } catch {
                // Some dependencies touch unavailable UI APIs. Validation below decides whether
                // the target signer export was still initialized successfully.
            }
            return moduleObject.exports;
        };
    }

    window.define = (name, factory) => {
        if (typeof name === 'string' && typeof factory === 'function') definedModules[name] = factory;
    };
    window.__miniRequire = makeRequire('__root__');
    window.require = window.__miniRequire;
    window.__definedModules = definedModules;
    window.__moduleCache = moduleCache;
    window.__browserSignerUnwrapExports = value => {
        let current = value;
        for (let depth = 0; depth < 4; depth++) {
            if (!current || (typeof current !== 'object' && typeof current !== 'function')) break;
            if (current.exports && current.exports !== current) {
                current = current.exports;
                continue;
            }
            if (current.default && current.default !== current) {
                current = current.default;
                continue;
            }
            break;
        }
        return current;
    };
    window.__browserSignerFindFunction = (value, names = []) => {
        const candidates = [value, value?.exports, value?.default, value?.exports?.default].filter(Boolean);
        for (const candidate of candidates) {
            for (const name of names) {
                if (typeof candidate?.[name] === 'function') return candidate[name].bind(candidate);
            }
            if (typeof candidate === 'function' && names.includes('default')) return candidate;
        }
        return null;
    };
    window.global = window;
    window.globalThis = window;
    window.self = window;
    window.__wxAppData = {};
    window.__wxAppCode__ = {};
    window.__WXML_GLOBAL__ = { entrys: {}, defines: {}, modules: {}, ops: [], total_ops: 0 };
    window.__GWX_GLOBAL__ = {};
    window.__vd_version_info__ = {};
    window.getApp = () => ({ globalData: {} });
    window.getCurrentPages = () => [];
    window.App = value => value;
    window.Page = value => value;
    window.Component = value => value;
    window.Behavior = value => value;
    window.definePlugin = noop;
    window.requirePlugin = () => ({});
    window.WeixinJSCore = window.WeixinJSCore || {};
    window.Reporter = window.Reporter || { report: noop, errorReport: noop };
}

function extractWebpackRequire() {
    if (typeof window.__wpRequire === 'function') return true;
    const chunkId = `__browser_signer_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const candidateKeys = Object.keys(window).filter(key => {
        try {
            return Array.isArray(window[key]) && typeof window[key].push === 'function';
        } catch {
            return false;
        }
    });
    candidateKeys.sort((left, right) => {
        const leftRank = /webpack|chunk|jsonp/i.test(left) ? 0 : 1;
        const rightRank = /webpack|chunk|jsonp/i.test(right) ? 0 : 1;
        return leftRank - rightRank;
    });
    for (const key of candidateKeys) {
        try {
            window[key].push([
                [chunkId],
                {},
                webpackRequire => {
                    window.__wpRequire = webpackRequire;
                }
            ]);
        } catch {
            // Try the next chunk array.
        }
        if (typeof window.__wpRequire === 'function') return true;
    }
    return false;
}

function validatePlatform(platform, didiOptions = {}) {
    const findFunction = window.__browserSignerFindFunction;
    if (platform === 'didi') {
        const exportsObject = window.__wpRequire(2582);
        const initSign = findFunction(exportsObject, ['initSign']);
        const getSign = findFunction(exportsObject, ['getSign']);
        if (!initSign || !getSign) throw new Error('didi signer exports are incomplete');
        initSign(didiOptions);
        window.__didiSigner = exportsObject;
        return;
    }
    if (platform === 'teld') {
        const exportsObject = window.__miniRequire('utils/api/web/ajax/index.js');
        if (!findFunction(exportsObject, ['TESDecrypt'])) throw new Error('teld TESDecrypt is unavailable');
        return;
    }
    if (platform === 'star-charge') {
        if (!window.__wpRequire(80427) || !window.__wpRequire(37208)) {
            throw new Error('star-charge signer dependencies are unavailable');
        }
        return;
    }
    if (platform === 'kuaidian') {
        const exportsObject = window.__wpRequire(35659);
        if (!findFunction(exportsObject, ['generate', 'default'])) {
            throw new Error('kuaidian generate is unavailable');
        }
        return;
    }
    if (platform === 'tuanyou') {
        const exportsObject = window.__miniRequire('utils/sign.js');
        if (!findFunction(exportsObject, ['generate', 'sign', 'default'])) {
            throw new Error('tuanyou sign is unavailable');
        }
        return;
    }
    if (platform === 'xdt') {
        const exportsObject = window.__wpRequire(3401);
        if (!findFunction(exportsObject, ['formatSignCommon', 'default'])) {
            throw new Error('xdt formatSignCommon is unavailable');
        }
    }
}

function executePlatformSign(platform, params = {}) {
    const findFunction = window.__browserSignerFindFunction;
    if (platform === 'didi') {
        const getSign = findFunction(window.__didiSigner || window.__wpRequire(2582), ['getSign']);
        return getSign(params);
    }
    if (platform === 'teld') {
        const exportsObject = window.__miniRequire('utils/api/web/ajax/index.js');
        const tesDecrypt = findFunction(exportsObject, ['TESDecrypt']);
        return tesDecrypt(String(params.key || 'yBb6fQbbiHx3g6Me'), String(params.sts));
    }
    if (platform === 'kuaidian') {
        const exportsObject = window.__wpRequire(35659);
        const generate = findFunction(exportsObject, ['generate', 'default']);
        return generate(params);
    }
    if (platform === 'tuanyou') {
        const exportsObject = window.__miniRequire('utils/sign.js');
        const sign = findFunction(exportsObject, ['generate', 'sign', 'default']);
        return sign(params);
    }
    if (platform === 'xdt') {
        const exportsObject = window.__wpRequire(3401);
        const formatSignCommon = findFunction(exportsObject, ['formatSignCommon', 'default']);
        return formatSignCommon(params.data || {}, String(params.initNonceStr || ''));
    }
    if (platform === 'star-charge') {
        const md5Exports = window.__wpRequire(80427);
        const sm2Exports = window.__wpRequire(37208);
        const md5 = findFunction(md5Exports, ['md5', 'default']);
        const sm2Root = window.__browserSignerUnwrapExports(sm2Exports);
        const sm2Container = sm2Root?.sm2 || sm2Root;
        const doEncrypt = findFunction(sm2Container, ['doEncrypt', 'encrypt', 'default']);
        if (!md5 || !doEncrypt) throw new Error('star-charge crypto functions are incomplete');
        const payload = params.signatureParams || {};
        let serialized = '';
        for (const key in payload) serialized += `${key}=${payload[key]}&`;
        serialized = serialized.slice(0, -1);
        const inner = String(md5(serialized));
        const signature = String(md5(`${inner}${payload.timestamp}`)).toUpperCase();
        const encryptedData = `04${doEncrypt(
            String(params.plaintext || ''),
            String(params.publicKey || ''),
            Number(params.cipherMode ?? 0)
        )}`;
        return { signature, encryptedData };
    }
    throw new Error(`unsupported browser signer platform: ${platform}`);
}

class BrowserSigner {
    constructor(options = {}) {
        this.enabled = options.enabled ?? envEnabled(process.env.BROWSER_SIGNER_ENABLED, true);
        this.chromePath = options.chromePath || process.env.BROWSER_SIGNER_CHROME_PATH || DEFAULT_CHROME_PATH;
        this.launchOptions = options.launchOptions || {};
        this.signTimeoutMs = Math.max(
            500,
            Number(options.signTimeoutMs || process.env.BROWSER_SIGNER_SIGN_TIMEOUT_MS) || DEFAULT_SIGN_TIMEOUT_MS
        );
        this.puppeteer = options.puppeteer || null;
        this.sourceLoader = options.sourceLoader || (filePath => fs.readFileSync(filePath, 'utf8'));
        this.fileExists = options.fileExists || fs.existsSync;
        this.platformDefinitions = this.normalizeDefinitions(
            options.platforms || buildDefaultPlatformDefinitions(options.homeDir || os.homedir())
        );
        this.didiOptions = {
            bizId: options.didi?.bizId || process.env.BROWSER_SIGNER_DIDI_BIZ_ID || 'f68afecafe0587d40fa615b896e9aa64',
            appVer: options.didi?.appVer || process.env.BROWSER_SIGNER_DIDI_APP_VERSION || '6.10.59',
            os: options.didi?.os || process.env.BROWSER_SIGNER_DIDI_OS || '1'
        };
        this.browser = null;
        this.pages = new Map();
        this.platformStatus = new Map();
        this.queues = new Map();
        this.initPromise = null;
        this.initError = null;
        this.closePromise = null;
        this.closed = false;
    }

    normalizeDefinitions(definitions = {}) {
        const normalized = {};
        for (const platform of SUPPORTED_PLATFORMS) {
            const definition = definitions[platform];
            if (!definition) continue;
            normalized[platform] = {
                moduleSystem: definition.moduleSystem || 'webpack',
                sourcePaths: normalizePathList(definition.sourcePaths || definition.sourcePath),
                mockOptions: { ...(definition.mockOptions || {}) }
            };
        }
        return normalized;
    }

    async init() {
        if (!this.enabled) return this.getStatus();
        if (this.browser && !this.closed) return this.getStatus();
        if (this.initError) throw this.initError;
        if (this.initPromise) return this.initPromise;
        this.closed = false;
        this.initPromise = this.initializeBrowser()
            .then(status => {
                this.initError = null;
                return status;
            })
            .catch(error => {
                this.initError = error;
                throw error;
            })
            .finally(() => {
                this.initPromise = null;
            });
        return this.initPromise;
    }

    async initializeBrowser() {
        const puppeteer = this.puppeteer || require('puppeteer-core');
        const entries = Object.entries(this.platformDefinitions);
        const loadableEntries = [];
        for (const [platform, definition] of entries) {
            const missingPaths = definition.sourcePaths.filter(filePath => !this.fileExists(filePath));
            if (definition.sourcePaths.length === 0 || missingPaths.length > 0) {
                this.platformStatus.set(platform, {
                    available: false,
                    error: missingPaths.length > 0 ? 'app-service.js not found' : 'app-service.js path is empty'
                });
            } else {
                loadableEntries.push([platform, definition]);
            }
        }
        if (loadableEntries.length === 0) {
            throw new Error('no browser signer app-service.js source is available');
        }
        this.browser = await puppeteer.launch({
            executablePath: this.chromePath,
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
            handleSIGINT: false,
            handleSIGTERM: false,
            handleSIGHUP: false,
            ...this.launchOptions
        });
        await Promise.all(loadableEntries.map(([platform, definition]) => this.loadPlatform(platform, definition)));
        if (this.pages.size === 0) {
            await this.browser.close();
            this.browser = null;
            throw new Error('all browser signer platforms failed to initialize');
        }
        return this.getStatus();
    }

    async loadPlatform(platform, definition) {
        const missingPaths = definition.sourcePaths.filter(filePath => !this.fileExists(filePath));
        if (definition.sourcePaths.length === 0 || missingPaths.length > 0) {
            this.platformStatus.set(platform, {
                available: false,
                error: missingPaths.length > 0 ? 'app-service.js not found' : 'app-service.js path is empty'
            });
            return;
        }

        let page = null;
        try {
            page = await this.browser.newPage();
            if (typeof page.setRequestInterception === 'function') {
                await page.setRequestInterception(true);
                page.on('request', request => {
                    const requestUrl = String(request.url?.() || '');
                    if (/^https?:/i.test(requestUrl)) request.abort();
                    else request.continue();
                });
            }
            await page.evaluate(installMiniProgramRuntime, definition.mockOptions);
            for (const sourcePath of definition.sourcePaths) {
                const source = this.sourceLoader(sourcePath);
                await page.evaluate(code => {
                    try {
                        (0, eval)(code);
                    } catch {
                        // Mini-program bundles often continue to expose registered modules even
                        // when an unrelated page bootstrap touches an unmocked UI API.
                    }
                }, source);
            }
            if (definition.moduleSystem === 'webpack') {
                const extracted = await page.evaluate(extractWebpackRequire);
                if (!extracted) throw new Error('webpack require extraction failed');
            }
            await page.evaluate(validatePlatform, platform, this.didiOptions);
            this.pages.set(platform, page);
            this.platformStatus.set(platform, { available: true, error: null });
        } catch (error) {
            if (page) await page.close().catch(() => undefined);
            this.platformStatus.set(platform, { available: false, error: boundedError(error) });
        }
    }

    async sign(platform, params = {}) {
        const normalizedPlatform = String(platform || '').trim().toLowerCase();
        if (!SUPPORTED_PLATFORMS.includes(normalizedPlatform)) {
            throw new Error(`unsupported browser signer platform: ${normalizedPlatform || 'empty'}`);
        }
        if (!this.enabled) throw new Error('browser signer is disabled');
        await this.init();
        const status = this.platformStatus.get(normalizedPlatform);
        const page = this.pages.get(normalizedPlatform);
        if (!status?.available || !page) {
            throw new Error(`browser signer unavailable for ${normalizedPlatform}: ${status?.error || 'not loaded'}`);
        }

        const previous = this.queues.get(normalizedPlatform) || Promise.resolve();
        const task = previous
            .catch(() => undefined)
            .then(() => this.withTimeout(
                page.evaluate(executePlatformSign, normalizedPlatform, params),
                this.signTimeoutMs,
                normalizedPlatform
            ));
        this.queues.set(normalizedPlatform, task.catch(() => undefined));
        return task;
    }

    withTimeout(promise, timeoutMs, platform) {
        let timeoutId;
        const timeout = new Promise((resolve, reject) => {
            timeoutId = setTimeout(() => reject(new Error(`browser signer timeout for ${platform}`)), timeoutMs);
        });
        return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
    }

    getStatus() {
        const platforms = {};
        for (const platform of SUPPORTED_PLATFORMS) {
            const status = this.platformStatus.get(platform);
            platforms[platform] = status
                ? { available: Boolean(status.available), error: status.error || null }
                : { available: false, error: this.enabled ? 'not initialized' : 'disabled' };
        }
        return {
            enabled: Boolean(this.enabled),
            initialized: Boolean(this.browser && !this.closed),
            platforms
        };
    }

    async close() {
        if (this.closePromise) return this.closePromise;
        this.closePromise = (async () => {
            if (this.initPromise) await this.initPromise.catch(() => undefined);
            await this.closeBrowser();
        })().finally(() => {
            this.closePromise = null;
        });
        return this.closePromise;
    }

    async closeBrowser() {
        const browser = this.browser;
        this.browser = null;
        this.closed = true;
        this.initError = null;
        this.pages.clear();
        this.queues.clear();
        if (browser) await browser.close();
    }
}

BrowserSigner.SUPPORTED_PLATFORMS = SUPPORTED_PLATFORMS;

module.exports = BrowserSigner;
