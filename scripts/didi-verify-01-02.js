#!/usr/bin/env node
'use strict';

/**
 * DIDI-01 + DIDI-02 验证脚本
 * 
 * 通过浏览器渲染获取 wsgsig 签名，然后发起真实请求做对照：
 * 1. 正常基线（有效签名）
 * 2. 退出登录（无 token）
 * 3. 篡改签名
 * 4. 设备标识不匹配
 * 5. 正常基线复验
 * 
 * 执行节点: 172 (172.28.170.239)
 * 约束: 最多 5 次业务请求
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const { URL } = require('url');
const puppeteer = require('puppeteer-core');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const HOME = process.env.HOME;

const FILES = {
    didi_main: `${HOME}/fyl/data_for_didi/data/wxapkg/decompiled/wxaf35009675aa0b2a/APPAPPAPP/app-service.js`,
    didi_wsgsig: `${HOME}/fyl/data_for_didi/data/wxapkg/decompiled/wxaf35009675aa0b2a/_wsgsig_/wsgsig/app-service.js`,
};

const STATION_API = 'https://energy.xiaojukeji.com/station-api/homepage/stationList';
const MAX_REQUESTS = 5;
let requestCount = 0;
const results = [];

function ts() { return new Date().toISOString(); }
function log(msg) { console.log(`[${ts()}] ${msg}`); }

// ============ 微信运行时 mock (从 browser-signer-all.js 复制) ============
const WX_MOCK_JS = `
if (!window.localStorage) {
    var _lsData = {};
    window.localStorage = { getItem: function(k) { return _lsData[k] !== undefined ? _lsData[k] : null; }, setItem: function(k, v) { _lsData[k] = String(v); }, removeItem: function(k) { delete _lsData[k]; }, clear: function() { _lsData = {}; }, key: function(i) { var keys = Object.keys(_lsData); return keys[i] || null; }, get length() { return Object.keys(_lsData).length; } };
}
if (!window.sessionStorage) {
    var _ssData = {};
    window.sessionStorage = { getItem: function(k) { return _ssData[k] !== undefined ? _ssData[k] : null; }, setItem: function(k, v) { _ssData[k] = String(v); }, removeItem: function(k) { delete _ssData[k]; }, clear: function() { _ssData = {}; }, key: function(i) { var keys = Object.keys(_ssData); return keys[i] || null; }, get length() { return Object.keys(_ssData).length; } };
}
window.global = window;
window.wx = window.wx || {
    getSystemInfoSync: function() { return {platform: 'android', system: 'Android 13', brand: 'Xiaomi', model: '23090RA98C', SDKVersion: '3.3.5', language: 'zh_CN', version: '8.0.55', screenWidth: 393, screenHeight: 873, pixelRatio: 2.75, windowWidth: 393, windowHeight: 873, statusBarHeight: 24, safeArea: {bottom: 873, height: 849, left: 0, right: 393, top: 24, width: 393}}; },
    getSystemInfo: function(o) { if (o && o.success) o.success(wx.getSystemInfoSync()); },
    getStorageSync: function(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch(e) { return localStorage.getItem(k); } },
    setStorageSync: function(k, v) { localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v)); },
    removeStorageSync: function(k) { localStorage.removeItem(k); },
    request: function(o) { if (o && o.fail) o.fail({errMsg: 'request:fail'}); },
    getAccountInfoSync: function() { return {miniProgram: {appId: 'wx0000000000000000', envVersion: 'release', version: '1.0.0'}}; },
    getNetworkType: function(o) { if (o && o.success) o.success({networkType: 'wifi'}); },
    getLocation: function(o) { if (o && o.success) o.success({latitude: 30.274150848388672, longitude: 120.15515}); },
    showToast: function() {}, showLoading: function() {}, hideLoading: function() {},
    showModal: function(o) { if (o && o.success) o.success({confirm: false}); },
    navigateTo: function() {}, navigateBack: function() {}, redirectTo: function() {}, switchTab: function() {}, reLaunch: function() {},
    createSelectorQuery: function() { return {select: function() { return {boundingClientRect: function(cb) { if (cb) cb(null); }}; }, exec: function() {}}; },
    getMenuButtonBoundingClientRect: function() { return {top: 24, right: 393, bottom: 56, left: 313, width: 80, height: 32}; },
    nextTick: function(cb) { setTimeout(cb, 0); },
    env: {USER_DATA_PATH: '/tmp'},
    canIUse: function() { return true; },
    onUnhandledRejection: function() {}, onError: function() {},
    base64ToArrayBuffer: function(b) { var s = atob(b); var buf = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) buf[i] = s.charCodeAt(i); return buf; },
    arrayBufferToBase64: function(buf) { var s = ''; var arr = new Uint8Array(buf); for (var i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]); return btoa(s); },
    getLaunchOptionsSync: function() { return {scene: 1001, path: 'pages/home/index', query: {}}; },
    getEnterOptionsSync: function() { return {scene: 1001, path: 'pages/home/index', query: {}}; },
    getUpdateManager: function() { return {onCheckForUpdate: function(){}, onUpdateReady: function(){}, onUpdateFailed: function(){}, applyUpdate: function(){}}; },
    getExptInfo: function() { return {}; },
    getAppBaseInfo: function() { return {SDKVersion: '3.3.5', enableDebug: false, host: {appId: 'wx0000000000000000'}}; },
    getDeviceInfo: function() { return {brand: 'Xiaomi', model: '23090RA98C', system: 'Android 13', platform: 'android', abi: 'arm64-v8a'}; },
    getWindowInfo: function() { return {pixelRatio: 2.75, screenWidth: 393, screenHeight: 873, windowWidth: 393, windowHeight: 873, statusBarHeight: 24, safeArea: {bottom: 873, height: 849, left: 0, right: 393, top: 24, width: 393}}; },
};
window.getApp = window.getApp || function() { return {globalData: {}, $store: {getters: {}, commit: function(){}, dispatch: function(){}}}; };
window.getCurrentPages = window.getCurrentPages || function() { return []; };
window.App = window.App || function(o) { if (o) { window.__appInstance = o; if (o.onLaunch) { try { o.onLaunch({scene: 1001}); } catch(e) {} } } return o; };
window.Page = window.Page || function(o) { return o; };
window.Component = window.Component || function(o) { return o; };
window.Behavior = window.Behavior || function(o) { return o; };
window.definePlugin = window.definePlugin || function() {};
window.requirePlugin = window.requirePlugin || function(name) { return {}; };
window.getAppBaseInfo = window.getAppBaseInfo || function() { return {}; };
window.__wxAppCode__ = window.__wxAppCode__ || {};
window.__wxAppData = window.__wxAppData__ || {};
window.__WXML_GLOBAL__ = window.__WXML_GLOBAL__ || {entrys: {}, defines: {}, modules: {}, ops: [], wxs_nf_init: undefined, total_ops: 0};
window.__wxCodeSpaceGlobal__ = window.__wxCodeSpaceGlobal__ || {};
window.__wxConfig = window.__wxConfig || {accountInfo: {appId: 'wx0000000000000000'}, envVersion: 'release'};
window.__wxModules = {};
window.__wxModuleCache = {};
window.define = function(name, factory) { window.__wxModules[name] = factory; };
window.require = function(req) {
    var resolvedName = null;
    if (window.__wxModules[req]) resolvedName = req;
    if (!resolvedName && window.__wxModules[req + '.js']) resolvedName = req + '.js';
    if (!resolvedName && req.charAt(0) === '.') {
        var stripped = req;
        while (stripped.charAt(0) === '.') { if (stripped.substring(0, 3) === '../') stripped = stripped.substring(3); else if (stripped.substring(0, 2) === './') stripped = stripped.substring(2); else break; }
        if (window.__wxModules[stripped]) resolvedName = stripped;
        if (!resolvedName && window.__wxModules[stripped + '.js']) resolvedName = stripped + '.js';
    }
    if (!resolvedName) {
        var lastSeg = req.split('/').pop();
        var lastSegNoExt = lastSeg.endsWith('.js') ? lastSeg.substring(0, lastSeg.length - 3) : lastSeg;
        for (var k in window.__wxModules) { var kLast = k.split('/').pop(); var kLastNoExt = kLast.endsWith('.js') ? kLast.substring(0, kLast.length - 3) : kLast; if (kLast === lastSeg || kLastNoExt === lastSegNoExt) { resolvedName = k; break; } }
    }
    if (!resolvedName) {
        var cleanReq = req;
        while (cleanReq.charAt(0) === '.') { if (cleanReq.substring(0, 3) === '../') cleanReq = cleanReq.substring(3); else if (cleanReq.substring(0, 2) === './') cleanReq = cleanReq.substring(2); else break; }
        for (var k2 in window.__wxModules) { if (k2.endsWith('/' + cleanReq) || k2.endsWith('/' + cleanReq + '.js') || k2 === cleanReq) { resolvedName = k2; break; } }
    }
    if (!resolvedName || !window.__wxModules[resolvedName]) return undefined;
    if (window.__wxModuleCache[resolvedName]) return window.__wxModuleCache[resolvedName];
    var m = {exports: {}};
    window.__wxModuleCache[resolvedName] = m.exports;
    window.__wxModuleCache[req] = m.exports;
    try { window.__wxModules[resolvedName](window.require, m, m.exports, window, document, undefined, self, location, navigator, localStorage, history, undefined, screen, alert, confirm, prompt, XMLHttpRequest, WebSocket, undefined, undefined, undefined); } catch(e) { console.error('Module load error [' + resolvedName + ']:', e.message); }
    window.__wxModuleCache[resolvedName] = m.exports;
    window.__wxModuleCache[req] = m.exports;
    return m.exports;
};
`;

async function createPage(browser) {
    const page = await browser.newPage();
    page.on('console', msg => {
        const text = msg.text();
        if (text.includes('Module load error') || text.includes('pageerror')) {
            console.log('  [browser]', text.substring(0, 150));
        }
    });
    page.on('pageerror', err => { console.log('  [pageerror]', err.message.substring(0, 150)); });
    await page.evaluateOnNewDocument(WX_MOCK_JS);
    const os = require('os');
    const tmpHtml = path.join(os.tmpdir(), 'didi-verify.html');
    fs.writeFileSync(tmpHtml, '<html><body></body></html>');
    await page.goto('file://' + tmpHtml);
    return page;
}

async function getWsgsigSign(page, apiUrl, method, query) {
    // 和 browser-signer-all.js signDidiWsgsig 完全一致的加载方式
    const mainCode = fs.readFileSync(FILES.didi_main, 'utf8');
    await page.evaluate((c) => { try { (0, eval)(c); } catch(e) {} }, mainCode);
    const wsgsigCode = fs.readFileSync(FILES.didi_wsgsig, 'utf8');
    await page.evaluate((c) => { try { (0, eval)(c); } catch(e) {} }, wsgsigCode);

    const result = await page.evaluate((p) => {
        try { window.require('bundle.js'); } catch(e) {}
        try { window.require('wsgsig/export/index6b3b12ea.js'); } catch(e) {}

        let wpRequire = null;
        try {
            const chunkArr = window.__wxModuleCache['bundle.js'];
            chunkArr.push([['__sign_extract__'], {}, function(req) { wpRequire = req; window.__wpRequire = req; }]);
        } catch(e) {}

        let getSign = null, initSign = null;
        if (wpRequire) {
            try {
                const mod = wpRequire(2582);
                getSign = mod.getSign || mod.default;
                initSign = mod.initSign;
            } catch(e) {}
        }

        let sign = null;
        if (getSign && initSign) {
            try {
                initSign({bizId: 'f68afecafe0587d40fa615b896e9aa64', appVer: '6.10.59', os: '1'});
                sign = getSign({url: p.url, method: p.method, query: p.query});
            } catch(e) { sign = 'ERROR: ' + e.message; }
        }
        return { sign, found: !!getSign };
    }, { url: apiUrl, method, query });

    return result;
}

function httpsPost(url, bodyStr, headers) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const req = https.request({
            hostname: u.hostname, port: 443,
            path: u.pathname + u.search, method: 'POST',
            headers: { ...headers, 'Content-Length': Buffer.byteLength(bodyStr) },
            timeout: 15000,
        }, (res) => {
            let chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                let buf = Buffer.concat(chunks);
                const enc = (res.headers['content-encoding'] || '').toLowerCase();
                if (enc.includes('gzip')) { try { buf = zlib.gunzipSync(buf); } catch(e) {} }
                else if (enc.includes('br')) { try { buf = zlib.brotliDecompressSync(buf); } catch(e) {} }
                resolve({ statusCode: res.statusCode, headers: res.headers, body: buf.toString('utf8'), bodyLength: buf.length });
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        req.write(bodyStr);
        req.end();
    });
}

function summarize(resp) {
    let bizCode = null, bizMsg = null, stationCount = 0;
    try {
        const j = JSON.parse(resp.body);
        bizCode = j.code !== undefined ? j.code : (j.errno !== undefined ? j.errno : null);
        bizMsg = j.msg || j.message || j.errmsg || null;
        if (j.data?.components) {
            for (const c of j.data.components) {
                if (Array.isArray(c.data)) { stationCount = c.data.length; break; }
            }
        } else if (j.data?.list) stationCount = j.data.list.length;
        else if (Array.isArray(j.data)) stationCount = j.data.length;
    } catch(e) {}
    return {
        httpStatus: resp.statusCode,
        bodyLength: resp.bodyLength,
        bizCode, bizMsg, stationCount,
        bodyPreview: resp.body.slice(0, 400),
    };
}

async function main() {
    console.log('='.repeat(60));
    console.log('DIDI-01 + DIDI-02 验证');
    console.log(`执行节点: 172 (172.28.170.239)`);
    console.log(`时间: ${ts()}`);
    console.log(`请求预算: ${MAX_REQUESTS}`);
    console.log('='.repeat(60));

    const browser = await puppeteer.launch({
        executablePath: CHROME, headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });

    const corpus = JSON.parse(fs.readFileSync(`${HOME}/fyl/data_for_didi/data/didi-signature-corpus.json`, 'utf8'));
    const template = corpus.entries[0];

    const baseBody = {
        ...template.bodyParams,
        lat: 31.2304, lng: 121.4737, userlat: 31.2304, userlng: 121.4737,
    };
    const baseHeaders = {
        ...template.headers,
        'User-Agent': 'Mozilla/5.0 (Linux; Android 13; 2211133C Build/TKQ1.221114.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.6099.144 Mobile Safari/537.36 XWEB/1200273 MMWEBSDK/20231202 MMWEBID/742 MicroMessenger/8.0.47.2560(0x28002F36) WeChat/arm64 Weixin NetType/WIFI Language/zh_CN ABI/arm64 MiniProgramEnv/android',
        'Referer': 'https://servicewechat.com/wx06cb940499986937/513/page-frame.html',
    };

    const apiUrl = '/station-api/homepage/stationList';
    const apiQuery = 'source=2&ttid=wx';
    const fullUrl = STATION_API + '?' + apiQuery;

    // === 请求 1: 正常基线 ===
    log('--- 请求 1/5: 正常基线 ---');
    const page = await createPage(browser);
    const sign1 = await getWsgsigSign(page, apiUrl, 'POST', apiQuery);
    log(`签名获取: found=${sign1.found}, sign=${sign1.sign ? String(sign1.sign).slice(0, 40) + '...' : 'null'}`);

    const headers1 = { ...baseHeaders };
    if (sign1.sign && typeof sign1.sign === 'string') headers1['wsgsig'] = sign1.sign;

    requestCount++;
    const resp1 = await httpsPost(fullUrl, JSON.stringify(baseBody), headers1);
    const s1 = summarize(resp1);
    log(`HTTP ${s1.httpStatus} | bizCode=${s1.bizCode} | stations=${s1.stationCount} | body=${s1.bodyLength}B`);
    log(`preview: ${s1.bodyPreview}`);
    results.push({ step: 1, desc: '正常基线', ...s1 });
    await page.close();

    // === 请求 2: 退出登录（无 token / 清除用户标识）===
    log('--- 请求 2/5: 退出登录状态 ---');
    const page2 = await createPage(browser);
    const sign2 = await getWsgsigSign(page2, apiUrl, 'POST', apiQuery);
    const headers2 = { ...baseHeaders };
    delete headers2['Cookie'];
    delete headers2['token'];
    delete headers2['Authorization'];
    if (sign2.sign && typeof sign2.sign === 'string') headers2['wsgsig'] = sign2.sign;

    requestCount++;
    const resp2 = await httpsPost(fullUrl, JSON.stringify(baseBody), headers2);
    const s2 = summarize(resp2);
    log(`HTTP ${s2.httpStatus} | bizCode=${s2.bizCode} | stations=${s2.stationCount} | body=${s2.bodyLength}B`);
    log(`preview: ${s2.bodyPreview}`);
    results.push({ step: 2, desc: '退出登录（无token）', ...s2 });
    await page2.close();

    // === 请求 3: 篡改签名 ===
    log('--- 请求 3/5: 篡改签名 ---');
    const headers3 = { ...baseHeaders };
    headers3['wsgsig'] = 'dd05-INVALID_SIGNATURE_TEST_VALUE_0000000000000000000';

    requestCount++;
    const resp3 = await httpsPost(fullUrl, JSON.stringify(baseBody), headers3);
    const s3 = summarize(resp3);
    log(`HTTP ${s3.httpStatus} | bizCode=${s3.bizCode} | stations=${s3.stationCount} | body=${s3.bodyLength}B`);
    log(`preview: ${s3.bodyPreview}`);
    results.push({ step: 3, desc: '篡改签名', ...s3 });

    // === 请求 4: 设备标识不匹配 ===
    log('--- 请求 4/5: 设备标识不匹配 ---');
    const page4 = await createPage(browser);
    const sign4 = await getWsgsigSign(page4, apiUrl, 'POST', apiQuery);
    const headers4 = { ...baseHeaders };
    headers4['User-Agent'] = baseHeaders['User-Agent']
        .replace('2211133C', 'FAKE_DEVICE_999')
        .replace('Xiaomi', 'UnknownBrand');
    if (sign4.sign && typeof sign4.sign === 'string') headers4['wsgsig'] = sign4.sign;

    requestCount++;
    const resp4 = await httpsPost(fullUrl, JSON.stringify(baseBody), headers4);
    const s4 = summarize(resp4);
    log(`HTTP ${s4.httpStatus} | bizCode=${s4.bizCode} | stations=${s4.stationCount} | body=${s4.bodyLength}B`);
    log(`preview: ${s4.bodyPreview}`);
    results.push({ step: 4, desc: '设备标识不匹配', ...s4 });
    await page4.close();

    // === 请求 5: 正常基线复验 ===
    log('--- 请求 5/5: 正常基线复验 ---');
    const page5 = await createPage(browser);
    const sign5 = await getWsgsigSign(page5, apiUrl, 'POST', apiQuery);
    const headers5 = { ...baseHeaders };
    if (sign5.sign && typeof sign5.sign === 'string') headers5['wsgsig'] = sign5.sign;

    requestCount++;
    const resp5 = await httpsPost(fullUrl, JSON.stringify(baseBody), headers5);
    const s5 = summarize(resp5);
    log(`HTTP ${s5.httpStatus} | bizCode=${s5.bizCode} | stations=${s5.stationCount} | body=${s5.bodyLength}B`);
    log(`preview: ${s5.bodyPreview}`);
    results.push({ step: 5, desc: '正常基线复验', ...s5 });
    await page5.close();

    await browser.close();

    // ========== 汇总 ==========
    console.log('\n' + '='.repeat(60));
    console.log('验证汇总');
    console.log('='.repeat(60));
    console.log(`执行节点: 172.28.170.239 | 出口IP: 36.28.192.239`);
    console.log(`执行时间: ${ts()} | 实际请求: ${requestCount}/${MAX_REQUESTS}`);
    console.log('');
    for (const r of results) {
        console.log(`[步骤${r.step}] ${r.desc}`);
        console.log(`  HTTP=${r.httpStatus} bizCode=${r.bizCode} stations=${r.stationCount} body=${r.bodyLength}B`);
        if (r.bizMsg) console.log(`  msg=${r.bizMsg}`);
        console.log('');
    }

    // ========== DIDI-01 判定 ==========
    console.log('='.repeat(60));
    console.log('DIDI-01 判定: 核心查询是否强制确认真实用户');
    console.log('='.repeat(60));
    const bl = results[0], nt = results[1], bs = results[2];
    if (bl.bizCode !== nt.bizCode || bl.stationCount !== nt.stationCount) {
        console.log(`✅ 退出登录与正常状态结果不同: bizCode ${bl.bizCode}→${nt.bizCode}, stations ${bl.stationCount}→${nt.stationCount}`);
    } else {
        console.log(`⚠️ 退出登录与正常状态结果相同: bizCode=${bl.bizCode}, stations=${bl.stationCount}`);
    }
    if (bs.bizCode !== bl.bizCode || bs.httpStatus !== bl.httpStatus) {
        console.log(`✅ 篡改签名被识别: HTTP ${bl.httpStatus}→${bs.httpStatus}, bizCode ${bl.bizCode}→${bs.bizCode}`);
    } else {
        console.log(`⚠️ 篡改签名未被拒绝: 与基线相同`);
    }

    // ========== DIDI-02 判定 ==========
    console.log('');
    console.log('='.repeat(60));
    console.log('DIDI-02 判定: 核心查询是否使用真实设备风险结果');
    console.log('='.repeat(60));
    const dt = results[3];
    if (dt.bizCode !== bl.bizCode || dt.stationCount !== bl.stationCount) {
        console.log(`✅ 设备标识不匹配时结果不同: bizCode ${bl.bizCode}→${dt.bizCode}, stations ${bl.stationCount}→${dt.stationCount}`);
    } else {
        console.log(`⚠️ 设备标识不匹配时结果相同: bizCode=${bl.bizCode}, stations=${bl.stationCount}`);
        console.log('   5次内未观察到设备风险处置 → 未验证');
    }

    // JSON 输出
    const jsonResult = {
        testId: 'DIDI-01-02',
        executedAt: ts(),
        executionNode: '172.28.170.239',
        outboundIP: '36.28.192.239',
        requestBudget: MAX_REQUESTS,
        actualRequests: requestCount,
        results,
        stopReason: '验证完成',
    };
    console.log('\n--- JSON 结果 ---');
    console.log(JSON.stringify(jsonResult, null, 2));
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
