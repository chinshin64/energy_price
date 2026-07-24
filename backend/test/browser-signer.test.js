'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const BrowserSigner = require('../services/browser-signer');
const DidiSignatureProvider = require('../services/didi-signature-provider');
const KuaidianCollector = require('../services/kuaidian-collector');
const TuanyouCollector = require('../services/tuanyou-collector');
const TeldCollector = require('../services/teld-collector');
const StarchargeCollector = require('../services/starcharge-collector');
const XdtCollector = require('../services/xdt-collector');

class FakePage {
    constructor(signHandler) {
        this.signHandler = signHandler;
        this.closed = false;
    }

    async setRequestInterception() {}

    on() {}

    async close() {
        this.closed = true;
    }

    async evaluate(fn, ...args) {
        if (fn.name === 'extractWebpackRequire') return true;
        if (fn.name === 'executePlatformSign') return this.signHandler(...args);
        return undefined;
    }
}

class FakeBrowser {
    constructor(signHandler) {
        this.signHandler = signHandler;
        this.pages = [];
        this.closeCount = 0;
    }

    async newPage() {
        const page = new FakePage(this.signHandler);
        this.pages.push(page);
        return page;
    }

    async close() {
        this.closeCount += 1;
    }
}

function createFakePuppeteer(signHandler) {
    const state = { launchCount: 0, browser: null };
    return {
        state,
        async launch() {
            state.launchCount += 1;
            state.browser = new FakeBrowser(signHandler);
            return state.browser;
        }
    };
}

function createSigner(options = {}) {
    const puppeteer = options.puppeteer || createFakePuppeteer(async platform => `signed-${platform}`);
    const signer = new BrowserSigner({
        puppeteer,
        fileExists: options.fileExists || (() => true),
        sourceLoader: options.sourceLoader || (() => '/* offline test source */'),
        platforms: options.platforms || {
            didi: { moduleSystem: 'webpack', sourcePaths: ['/tmp/didi-main.js', '/tmp/didi-wsgsig.js'] },
            teld: { moduleSystem: 'define', sourcePaths: ['/tmp/teld.js'] }
        }
    });
    return { signer, puppeteer };
}

test('BrowserSigner init 复用单 browser，并为平台创建隔离 page', async () => {
    const { signer, puppeteer } = createSigner();
    const [first, second] = await Promise.all([signer.init(), signer.init()]);

    assert.equal(puppeteer.state.launchCount, 1);
    assert.equal(puppeteer.state.browser.pages.length, 2);
    assert.equal(first.platforms.didi.available, true);
    assert.equal(second.platforms.teld.available, true);

    await signer.close();
    await signer.close();
    assert.equal(puppeteer.state.browser.closeCount, 1);
});

test('BrowserSigner 同平台签名串行、不同调用复用已加载 page', async () => {
    let active = 0;
    let maxActive = 0;
    let callCount = 0;
    const puppeteer = createFakePuppeteer(async (platform, params) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise(resolve => setTimeout(resolve, 20));
        active -= 1;
        callCount += 1;
        return `${platform}-${params.id}`;
    });
    const { signer } = createSigner({ puppeteer });

    const results = await Promise.all([
        signer.sign('didi', { id: 1 }),
        signer.sign('didi', { id: 2 })
    ]);

    assert.deepEqual(results, ['didi-1', 'didi-2']);
    assert.equal(callCount, 2);
    assert.equal(maxActive, 1);
    assert.equal(puppeteer.state.launchCount, 1);
    await signer.close();
});

test('BrowserSigner 单个平台加载失败不会影响其他平台', async () => {
    const { signer } = createSigner({
        sourceLoader: filePath => {
            if (filePath.endsWith('teld.js')) throw new Error('broken teld source');
            return '/* valid source */';
        }
    });

    const status = await signer.init();
    assert.equal(status.platforms.didi.available, true);
    assert.equal(status.platforms.teld.available, false);
    assert.match(status.platforms.teld.error, /broken teld source/);
    await assert.rejects(() => signer.sign('teld', { sts: '1' }), /unavailable for teld/);
    await signer.close();
});

test('快电和团油实际请求参数优先使用 browser signer，异常时保留 fallback', async () => {
    const browserSigner = {
        async sign(platform) {
            return platform === 'kuaidian'
                ? { sign: 'a'.repeat(32) }
                : 'b'.repeat(32);
        }
    };
    const kuaidianCredentials = {
        appKey: 'unit-test-kuaidian-key',
        appSecret: 'unit-test-kuaidian-secret',
        appTerminal: 'unit-test-terminal',
        appName: 'unit-test-app',
        platformType: 'unit-test-platform',
        terminalType: 'unit-test-terminal-type',
        host: 'https://example.invalid',
        userAgent: 'unit-test-agent',
        referer: 'https://example.invalid/',
        token: '',
        sensorId: '',
        deviceId: '',
        saDistinctId: '',
        saAnonymousId: '',
    };
    const kuaidian = new KuaidianCollector({ browserSigner, ...kuaidianCredentials });
    const tuanyou = new TuanyouCollector({
        browserSigner,
        appKey: 'unit-test-key',
        appSecret: 'unit-test-secret',
        host: 'https://example.invalid',
        userAgent: 'unit-test-agent',
        referer: 'https://example.invalid/',
        shumeiID: 'unit-test-device-signal',
        mpVersion: '0.0-test',
        token: '',
        fromScanCode: '',
    });

    const kuaidianParams = await kuaidian.buildSignedParamsWithBrowser({ pageIndex: 1 });
    const tuanyouParams = await tuanyou.buildSignedParamsWithBrowser({ oilNo: '92' });
    assert.equal(kuaidianParams.sign, 'a'.repeat(32));
    assert.equal(kuaidian.lastSignatureSource, 'browser');
    assert.equal(tuanyouParams.sign, 'b'.repeat(32));
    assert.equal(tuanyou.lastSignatureSource, 'browser');

    const fallback = new KuaidianCollector({
        ...kuaidianCredentials,
        browserSigner: { sign: async () => { throw new Error('browser unavailable'); } }
    });
    const fallbackParams = await fallback.buildSignedParamsWithBrowser({ pageIndex: 1 });
    assert.match(fallbackParams.sign, /^[a-f\d]{32}$/);
    assert.equal(fallback.lastSignatureSource, 'manual-fallback');
});

test('特来电、星星充电和新电途消费平台特定 browser signer 返回结构', async () => {
    const browserSigner = {
        async sign(platform) {
            if (platform === 'teld') return 'c'.repeat(40);
            if (platform === 'star-charge') {
                return { signature: 'd'.repeat(32), encryptedData: `04${'e'.repeat(192)}` };
            }
            if (platform === 'xdt') {
                return { sign: 'random-sign', tm: '1784000000000', nonceStr: 'f'.repeat(32) };
            }
            throw new Error('unexpected platform');
        }
    };
    const teld = new TeldCollector({ browserSigner });
    const starCharge = new StarchargeCollector({ browserSigner });
    const xdt = new XdtCollector({ browserSigner });

    assert.equal(await teld.resolveSver('1784000000'), 'c'.repeat(40));
    assert.equal(teld.lastSignatureSource, 'browser');

    const starRequest = await starCharge.buildSignedRequestWithBrowser({
        page: 1,
        pagecount: 10,
        lat: 31.23,
        lng: 121.47
    });
    assert.equal(starRequest.headers['X-Ca-Signature'], 'D'.repeat(32));
    assert.match(starRequest.body, /^data=04/);
    assert.equal(starCharge.lastSignatureSource, 'browser');

    const xdtResult = await xdt.resolveFormatSignCommon({ encryptData: 'cipher' }, 'nonce-seed');
    assert.deepEqual(xdtResult, {
        sign: 'random-sign',
        tm: '1784000000000',
        nonceStr: 'f'.repeat(32)
    });
    assert.equal(xdt.lastSignatureSource, 'browser');
});

test('DidiSignatureProvider 用最终请求参数生成并覆盖 wsgsig', async () => {
    let capturedPayload = null;
    const provider = new DidiSignatureProvider({
        browserSigner: {
            async sign(platform, payload) {
                assert.equal(platform, 'didi');
                capturedPayload = payload;
                return `dd05-${'a'.repeat(208)}`;
            }
        }
    });
    const pattern = {
        platform: 'didi-charging',
        method: 'POST',
        baseUrl: 'https://energy.xiaojukeji.com/station-api/homepage/stationList'
    };
    const params = {
        query: { source: '2', ttid: 'wx', wsgsig: 'stale' },
        body: { lat: 34.261005, lng: 108.942336, pageNo: 1 }
    };
    const meta = await provider.refreshBrowserSignature(
        pattern,
        params,
        { 'content-type': 'application/json' },
        { provider: 'didi-signature-corpus' }
    );

    assert.equal(meta.provider, 'browser-signer');
    assert.equal(meta.fallbackProvider, 'didi-signature-corpus');
    assert.match(params.query.wsgsig, /^dd05-/);
    assert.equal(capturedPayload.paramsString, 'source=2&ttid=wx');
    assert.deepEqual(capturedPayload.body, params.body);
    assert.equal(capturedPayload.signUpgrade, false);
});
