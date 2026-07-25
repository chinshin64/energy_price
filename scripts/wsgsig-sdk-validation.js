#!/usr/bin/env node
'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const zlib = require('zlib');
const { UNIFIED_OUTBOUND_PROXY_URL } = require('../backend/config/unified-proxy');

const PROJECT_ROOT = path.join(__dirname, '..');
const APP_SERVICE = path.join(PROJECT_ROOT, 'data/wxapkg/decompiled/wxaf35009675aa0b2a/APPAPPAPP/app-service.js');
const WSGSIG_SERVICE = path.join(PROJECT_ROOT, 'data/wxapkg/decompiled/wxaf35009675aa0b2a/_wsgsig_/wsgsig/app-service.js');
const DEFAULT_CORPUS_CANDIDATES = [
    process.env.DIDI_SIGNATURE_CORPUS_PATH,
    path.join(PROJECT_ROOT, 'data/didi-signature-corpus.json'),
    '/Users/didi/fyl/data_for_didi/data/didi-signature-corpus.json',
].filter(Boolean);
const DEFAULT_USER_AGENT_FILE = path.join(PROJECT_ROOT, 'config/mobile-wechat-user-agents.json');
const FALLBACK_MOBILE_WECHAT_UA = 'Mozilla/5.0 (Linux; Android 13; 2211133C Build/TKQ1.221114.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.6099.144 Mobile Safari/537.36 XWEB/1200273 MMWEBSDK/20231202 MMWEBID/742 MicroMessenger/8.0.47.2560(0x28002F36) WeChat/arm64 Weixin NetType/WIFI Language/zh_CN ABI/arm64 MiniProgramEnv/android';
const ANDROID_WECHAT_MINIPROGRAM_HEADERS = {
    Accept: '*/*',
    'Accept-Encoding': 'gzip, deflate, br',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'Sec-Fetch-Site': 'cross-site',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty',
    xweb_xhr: '1',
};

const DEFAULT_TARGETS = [
    { city: '上海市', lat: 31.2304, lng: 121.4737 },
    { city: '杭州市', lat: 30.27873475699259, lng: 120.0485217919863 },
];

function parseArgs(argv) {
    const args = {
        network: false,
        corpusPath: '',
        maxCases: 2,
        timeoutMs: 12000,
        signatureCarrier: 'query',
        proxyUrl: UNIFIED_OUTBOUND_PROXY_URL,
        userAgent: '',
        userAgentFile: DEFAULT_USER_AGENT_FILE,
        userAgentPlatform: 'android',
    };
    for (let i = 2; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--network') {
            args.network = true;
        } else if (arg === '--corpus') {
            args.corpusPath = argv[++i] || '';
        } else if (arg === '--max-cases') {
            args.maxCases = Math.max(1, Math.min(3, Number(argv[++i]) || 2));
        } else if (arg === '--timeout-ms') {
            args.timeoutMs = Math.max(1000, Number(argv[++i]) || 12000);
        } else if (arg === '--signature-carrier') {
            args.signatureCarrier = argv[++i] || 'query';
        } else if (arg === '--proxy-url') {
            args.proxyUrl = argv[++i] || UNIFIED_OUTBOUND_PROXY_URL;
        } else if (arg === '--user-agent') {
            args.userAgent = argv[++i] || '';
        } else if (arg === '--user-agent-file' || arg === '--ua-file') {
            args.userAgentFile = argv[++i] || DEFAULT_USER_AGENT_FILE;
        } else if (arg === '--ua-platform' || arg === '--user-agent-platform') {
            args.userAgentPlatform = argv[++i] || 'android';
        }
    }
    if (args.signatureCarrier !== 'query') {
        throw new Error('--signature-carrier must be query when matching 66.har stationList request layout');
    }
    return args;
}

function requireProxyAgent(targetProtocol) {
    const moduleName = targetProtocol === 'https:' ? 'https-proxy-agent' : 'http-proxy-agent';
    try {
        return require(moduleName);
    } catch (error) {
        return require(path.join(PROJECT_ROOT, 'backend/node_modules', moduleName));
    }
}

function createProxyAgent(targetProtocol, proxyUrl) {
    if (!proxyUrl) return null;
    const agentModule = requireProxyAgent(targetProtocol);
    if (targetProtocol === 'https:') {
        return new agentModule.HttpsProxyAgent(proxyUrl);
    }
    return new agentModule.HttpProxyAgent(proxyUrl);
}

function maskProxyUrl(proxyUrl = '') {
    const text = String(proxyUrl || '').trim();
    if (!text) return '';
    try {
        const url = new URL(text);
        if (url.username) url.username = '***';
        if (url.password) url.password = '***';
        return url.toString();
    } catch {
        return text.replace(/\/\/([^:@/]+):([^@/]+)@/, '//***:***@');
    }
}

function extractModules(code, source) {
    const modules = {};
    const re = /(\d+):function\(([^)]*)\)\{/g;
    let match;
    while ((match = re.exec(code))) {
        const id = Number(match[1]);
        const params = match[2].split(',').map(item => item.trim()).filter(Boolean);
        const bodyStart = match.index + match[0].length;
        let depth = 1;
        let pos = bodyStart;
        let inString = false;
        let stringChar = '';
        let escaped = false;
        while (depth > 0 && pos < code.length) {
            const char = code[pos];
            if (escaped) {
                escaped = false;
                pos++;
                continue;
            }
            if (char === '\\') {
                escaped = true;
                pos++;
                continue;
            }
            if (inString) {
                if (char === stringChar) inString = false;
                pos++;
                continue;
            }
            if (char === '"' || char === "'" || char === '`') {
                inString = true;
                stringChar = char;
                pos++;
                continue;
            }
            if (char === '{') depth++;
            if (char === '}') depth--;
            pos++;
        }
        modules[id] = {
            params,
            body: code.slice(bodyStart, pos - 1),
            source,
        };
    }
    return modules;
}

function createWebpackRuntime() {
    const modules = {
        ...extractModules(fs.readFileSync(APP_SERVICE, 'utf8'), APP_SERVICE),
        ...extractModules(fs.readFileSync(WSGSIG_SERVICE, 'utf8'), WSGSIG_SERVICE),
    };
    const cache = {};
    const loadErrors = [];

    function req(id) {
        if (cache[id]) return cache[id].exports;
        const mod = { exports: {} };
        cache[id] = mod;
        const def = modules[id];
        if (!def) {
            loadErrors.push({ id, reason: 'missing_module' });
            return mod.exports;
        }
        try {
            const fn = new Function(...def.params, def.body);
            fn(mod, mod.exports, req);
        } catch (error) {
            loadErrors.push({ id, reason: error.message });
        }
        return mod.exports;
    }

    req.o = (object, property) => Object.prototype.hasOwnProperty.call(object, property);
    req.r = exports => {
        if (typeof Symbol !== 'undefined' && Symbol.toStringTag) {
            Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
        }
        Object.defineProperty(exports, '__esModule', { value: true });
    };
    req.d = (exports, name, getter) => {
        if (name && typeof name === 'object') {
            for (const key of Object.keys(name)) {
                if (!req.o(exports, key)) {
                    Object.defineProperty(exports, key, { enumerable: true, get: name[key] });
                }
            }
            return;
        }
        if (!req.o(exports, name)) {
            Object.defineProperty(exports, name, { enumerable: true, get: getter });
        }
    };
    req.n = moduleValue => {
        const getter = moduleValue && moduleValue.__esModule
            ? () => moduleValue.default
            : () => moduleValue;
        req.d(getter, { a: getter });
        return getter;
    };
    req.t = value => value;
    req.hmd = moduleValue => moduleValue;

    return { req, modules, loadErrors };
}

function loadSigner() {
    const runtime = createWebpackRuntime();
    const signer = runtime.req(2582);
    if (typeof signer.initSign !== 'function' || typeof signer.getSign !== 'function') {
        throw new Error('wsgsig signer exports are incomplete');
    }
    signer.initSign({
        bizId: '14e45fa0cf5847992ce53495573d1994',
        appVer: '6.10.59',
        os: '1',
    });
    return {
        signer,
        moduleCount: Object.keys(runtime.modules).length,
        loadErrors: runtime.loadErrors,
    };
}

function pickCorpusPath(explicitPath) {
    const candidates = explicitPath ? [explicitPath] : DEFAULT_CORPUS_CANDIDATES;
    for (const candidate of candidates) {
        if (candidate && fs.existsSync(candidate)) return candidate;
    }
    throw new Error('signature corpus file not found');
}

function loadCorpusEntries(corpusPath) {
    const payload = JSON.parse(fs.readFileSync(corpusPath, 'utf8'));
    const entries = Array.isArray(payload) ? payload : payload.entries;
    return (Array.isArray(entries) ? entries : [])
        .filter(entry => entry.platform === 'didi-charging')
        .filter(entry => /station-api\/homepage\/stationList/i.test(String(entry.baseUrl || '')))
        .filter(entry => entry.queryParams && entry.bodyParams);
}

function normalizeUserAgentMaterial(payload, sourcePath) {
    const items = Array.isArray(payload) ? payload : payload.items;
    return (Array.isArray(items) ? items : [])
        .map((item, index) => {
            if (typeof item === 'string') {
                return {
                    id: `ua-${index + 1}`,
                    platform: '',
                    device: '',
                    wechatVersion: '',
                    userAgent: item.trim(),
                    sourcePath,
                };
            }
            return {
                id: String(item?.id || `ua-${index + 1}`),
                platform: String(item?.platform || ''),
                device: String(item?.device || ''),
                wechatVersion: String(item?.wechatVersion || ''),
                userAgent: String(item?.userAgent || '').trim(),
                sourcePath,
            };
        })
        .filter(item => item.userAgent);
}

function loadUserAgentMaterial(userAgentFile = DEFAULT_USER_AGENT_FILE) {
    const sourcePath = userAgentFile || DEFAULT_USER_AGENT_FILE;
    try {
        const payload = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
        const items = normalizeUserAgentMaterial(payload, sourcePath);
        if (items.length > 0) {
            return { sourcePath, items };
        }
    } catch (error) {
        if (userAgentFile && userAgentFile !== DEFAULT_USER_AGENT_FILE) {
            throw new Error(`failed to load user agent material: ${error.message}`);
        }
    }

    return {
        sourcePath: 'fallback',
        items: [{
            id: 'fallback-android-wechat',
            platform: 'android',
            device: '',
            wechatVersion: '',
            userAgent: FALLBACK_MOBILE_WECHAT_UA,
            sourcePath: 'fallback',
        }],
    };
}

function pickMobileUserAgent(material = loadUserAgentMaterial(), explicitUserAgent = '', platform = 'android') {
    if (explicitUserAgent) {
        return {
            id: 'cli-user-agent',
            platform: 'custom',
            device: '',
            wechatVersion: '',
            userAgent: explicitUserAgent,
            sourcePath: 'cli',
        };
    }

    const normalizedPlatform = String(platform || '').trim().toLowerCase();
    const items = (Array.isArray(material.items) ? material.items : [])
        .filter(item => !normalizedPlatform || normalizedPlatform === 'any' || String(item.platform || '').toLowerCase() === normalizedPlatform);
    const index = Math.floor(Math.random() * items.length);
    return items[index] || {
        id: 'fallback-android-wechat',
        platform: 'android',
        device: '',
        wechatVersion: '',
        userAgent: FALLBACK_MOBILE_WECHAT_UA,
        sourcePath: 'fallback',
    };
}

function publicUserAgentChoice(choice = {}) {
    return {
        id: choice.id || null,
        platform: choice.platform || null,
        device: choice.device || null,
        wechatVersion: choice.wechatVersion || null,
        sourcePath: choice.sourcePath || null,
    };
}

function normalizeHeaders(headers = {}) {
    const out = {};
    for (const [key, value] of Object.entries(headers || {})) {
        if (/^(host|content-length|cookie|authorization|wsgsig)$/i.test(key)) continue;
        out[key] = value;
    }
    if (!Object.keys(out).some(key => /^content-type$/i.test(key))) {
        out['content-type'] = 'application/json';
    }
    return out;
}

function encodeParam(value) {
    return encodeURIComponent(value)
        .replace(/%40/gi, '@')
        .replace(/%3A/gi, ':')
        .replace(/%24/g, '$')
        .replace(/%2C/gi, ',')
        .replace(/%5B/gi, '[')
        .replace(/%5D/gi, ']');
}

function buildParamsString(baseUrl, params = {}) {
    const url = new URL(baseUrl);
    const parts = [];
    const existingQuery = url.searchParams.toString();
    if (existingQuery) parts.push(existingQuery);
    for (const [key, rawValue] of Object.entries(params || {})) {
        if (rawValue === null || rawValue === undefined) continue;
        const values = Array.isArray(rawValue) ? rawValue : [rawValue];
        const paramKey = Array.isArray(rawValue) ? `${key}[]` : key;
        for (const value of values) {
            const normalized = value instanceof Date
                ? value.toISOString()
                : value && typeof value === 'object'
                    ? JSON.stringify(value)
                    : value;
            parts.push(`${encodeParam(paramKey)}=${encodeParam(normalized)}`);
        }
    }
    return parts.filter(Boolean).join('&');
}

function getHeader(headers, name) {
    const pair = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === name.toLowerCase());
    return pair ? pair[1] : undefined;
}

function setHeader(headers, name, value) {
    const existing = Object.keys(headers || {}).find(key => key.toLowerCase() === name.toLowerCase());
    headers[existing || name] = value;
}

function applyAndroidMiniProgramHeaders(headers = {}) {
    for (const [name, value] of Object.entries(ANDROID_WECHAT_MINIPROGRAM_HEADERS)) {
        setHeader(headers, name, value);
    }
    return headers;
}

function getContentType(requestCase) {
    return String(getHeader(requestCase.headers, 'content-type') || 'application/json').toLowerCase();
}

function buildSignerPayload(requestCase) {
    const contentType = getContentType(requestCase);
    const method = String(requestCase.method || 'GET').toUpperCase();
    let body;
    let bodyString;

    if (method === 'POST' || method === 'PUT') {
        if (typeof requestCase.bodyParams === 'string') {
            bodyString = requestCase.bodyParams;
        } else if (requestCase.bodyParams && typeof requestCase.bodyParams === 'object') {
            body = { ...requestCase.bodyParams };
            if (contentType === 'application/x-www-form-urlencoded') {
                for (const key of Object.keys(body)) {
                    if (body[key] === null || body[key] === undefined) delete body[key];
                }
            }
        }
    }

    return {
        contentType,
        paramsString: buildParamsString(requestCase.baseUrl, requestCase.queryParams),
        body,
        bodyString,
        noDomainCheck: true,
        signUpgrade: false,
    };
}

function buildCase(sample, target, options = {}) {
    const queryParams = { ...(sample.queryParams || {}) };
    delete queryParams.wsgsig;
    delete queryParams._wsgsig;

    const bodyParams = {
        ...(sample.bodyParams || {}),
        lat: target.lat,
        lng: target.lng,
        userlat: target.lat,
        userlng: target.lng,
        pageNo: 1,
    };
    const headers = normalizeHeaders(sample.headers || {});
    applyAndroidMiniProgramHeaders(headers);
    const userAgent = typeof options === 'string' ? options : options.userAgent;
    if (userAgent) {
        setHeader(headers, 'user-agent', userAgent);
    }

    return {
        city: target.city,
        method: String(sample.method || 'POST').toUpperCase(),
        baseUrl: sample.baseUrl || 'https://energy.xiaojukeji.com/station-api/homepage/stationList',
        queryParams,
        bodyParams,
        headers,
    };
}

function signCase(signer, requestCase) {
    const payload = buildSignerPayload(requestCase);
    const signature = signer.getSign(payload);
    const text = String(signature || '');
    return {
        signature,
        summary: {
            generated: Boolean(signature),
            length: text.length,
            format: /^dd\d*-/.test(text) || /^dd/.test(text) ? 'wsgsig_like' : 'unknown',
            inputShape: Object.keys(payload).filter(key => payload[key] !== undefined).sort(),
        },
    };
}

function summarizeBody(text) {
    try {
        const payload = JSON.parse(text);
        const groups = Array.isArray(payload?.data?.stationList) ? payload.data.stationList : [];
        const stationCount = groups.reduce((total, group) => {
            return total + (Array.isArray(group.stationList) ? group.stationList.length : 0);
        }, 0);
        const listCounts = {};
        const stationCandidates = [];
        const visited = new Set();
        const visit = (value, pathName = 'root') => {
            if (!value || typeof value !== 'object' || visited.has(value)) return;
            visited.add(value);
            if (Array.isArray(value)) {
                if (/station|list|items|records|data/i.test(pathName)) {
                    listCounts[pathName] = value.length;
                }
                const firstObject = value.find(item => item && typeof item === 'object' && !Array.isArray(item));
                if (firstObject && /station|list|items|records|data/i.test(pathName)) {
                    const keys = Object.keys(firstObject).sort();
                    const fieldHints = keys.filter(key => {
                        return /station|name|title|price|fee|distance|lat|lng|addr|address|pile|park|tag|label/i.test(key);
                    });
                    if (fieldHints.length || pathName.endsWith('.data')) {
                        stationCandidates.push({
                            path: pathName,
                            count: value.length,
                            firstItemKeys: keys.slice(0, 40),
                            fieldHints: fieldHints.slice(0, 24),
                        });
                    }
                }
                value.slice(0, 3).forEach((item, index) => visit(item, `${pathName}[${index}]`));
                return;
            }
            for (const [key, child] of Object.entries(value)) {
                visit(child, pathName === 'root' ? key : `${pathName}.${key}`);
            }
        };
        visit(payload);
        return {
            code: payload.code ?? payload.errno ?? payload.errorCode,
            errno: payload.errno,
            message: payload.message || payload.errmsg || payload.msg,
            traceId: payload.traceId,
            dataKeys: payload?.data && typeof payload.data === 'object' ? Object.keys(payload.data).slice(0, 12) : undefined,
            listCounts: Object.keys(listCounts).length ? listCounts : undefined,
            stationCandidates: stationCandidates.slice(0, 5),
            stationGroupCount: groups.length || undefined,
            stationCount: stationCount || undefined,
        };
    } catch (error) {
        return {
            parseError: 'non_json_body',
            bodyPreviewLength: String(text || '').length,
        };
    }
}

function requestWithProxy(url, { method, headers, body, timeoutMs, proxyUrl }) {
    return new Promise((resolve, reject) => {
        const transport = url.protocol === 'https:' ? https : http;
        const requestHeaders = { ...headers };
        if (body !== undefined && !Object.keys(requestHeaders).some(key => /^content-length$/i.test(key))) {
            requestHeaders['content-length'] = Buffer.byteLength(body);
        }
        const request = transport.request(url, {
            method,
            headers: requestHeaders,
            agent: createProxyAgent(url.protocol, proxyUrl),
            timeout: timeoutMs,
        }, response => {
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('end', () => {
                const bodyBuffer = Buffer.concat(chunks);
                resolve({
                    status: response.statusCode,
                    headers: response.headers,
                    bodyText: decodeResponseBody(bodyBuffer, response.headers),
                });
            });
        });
        request.on('timeout', () => {
            request.destroy(new Error(`request_timeout_${timeoutMs}ms`));
        });
        request.on('error', reject);
        if (body !== undefined) request.write(body);
        request.end();
    });
}

function decodeResponseBody(buffer, headers = {}) {
    const encoding = String(headers['content-encoding'] || '').toLowerCase();
    try {
        if (encoding.includes('br')) {
            return zlib.brotliDecompressSync(buffer).toString('utf8');
        }
        if (encoding.includes('gzip')) {
            return zlib.gunzipSync(buffer).toString('utf8');
        }
        if (encoding.includes('deflate')) {
            return zlib.inflateSync(buffer).toString('utf8');
        }
    } catch {
        return buffer.toString('utf8');
    }
    return buffer.toString('utf8');
}

async function sendRequest(requestCase, signature, timeoutMs, proxyUrl) {
    const url = new URL(requestCase.baseUrl);
    for (const [key, value] of Object.entries(requestCase.queryParams || {})) {
        url.searchParams.set(key, String(value));
    }
    const headers = { ...requestCase.headers };
    url.searchParams.set('wsgsig', signature);
    setHeader(headers, 'secdd-challenge', '3|2.0.34||||||');
    setHeader(headers, 'secdd-authentication', Math.round(Date.now() / 1000));
    // 直连模式: 当运行机器本身就是受控出口(如47公网服务器)时,允许不走代理。
    // 由环境变量 WSGSIG_ALLOW_DIRECT=1 显式开启,否则保留统一出口策略。
    if (!proxyUrl && process.env.WSGSIG_ALLOW_DIRECT !== '1') {
        throw new Error('proxyUrl is required by unified outbound policy (set WSGSIG_ALLOW_DIRECT=1 to allow direct)');
    }

    const response = await requestWithProxy(url, {
        method: requestCase.method,
        headers,
        body: JSON.stringify(requestCase.bodyParams || {}),
        timeoutMs,
        proxyUrl,
    });
    return {
        httpStatus: response.status,
        proxy: {
            used: true,
            label: '配置出口',
            proxyUrl: maskProxyUrl(proxyUrl),
        },
        business: summarizeBody(response.bodyText),
    };
}

async function main() {
    const args = parseArgs(process.argv);
    if (args.network && process.env.ALLOW_WSGSIG_SDK_VALIDATION !== '1') {
        throw new Error('network validation requires ALLOW_WSGSIG_SDK_VALIDATION=1');
    }

    const { signer, moduleCount, loadErrors } = loadSigner();
    const corpusPath = pickCorpusPath(args.corpusPath);
    const entries = loadCorpusEntries(corpusPath);
    if (entries.length === 0) {
        throw new Error('no didi stationList corpus entries available');
    }

    const results = [];
    const sample = entries[0];
    const userAgentMaterial = loadUserAgentMaterial(args.userAgentFile);
    for (const target of DEFAULT_TARGETS.slice(0, args.maxCases)) {
        const userAgentChoice = pickMobileUserAgent(userAgentMaterial, args.userAgent, args.userAgentPlatform);
        const requestCase = buildCase(sample, target, { userAgent: userAgentChoice.userAgent });
        const signed = signCase(signer, requestCase);
        const result = {
            city: target.city,
            lat: target.lat,
            lng: target.lng,
            sign: signed.summary,
            request: {
                method: requestCase.method,
                path: new URL(requestCase.baseUrl).pathname,
                signatureCarrier: args.signatureCarrier,
                queryKeys: Object.keys(requestCase.queryParams)
                    .concat(['wsgsig'])
                    .sort(),
                bodyKeys: Object.keys(requestCase.bodyParams).sort(),
                headerKeys: Object.keys(requestCase.headers)
                    .concat(['secdd-challenge', 'secdd-authentication'])
                    .sort(),
                userAgent: publicUserAgentChoice(userAgentChoice),
            },
        };
        if (args.network) {
            result.response = await sendRequest(requestCase, signed.signature, args.timeoutMs, args.proxyUrl);
        }
        results.push(result);
    }

    console.log(JSON.stringify({
        success: true,
        mode: args.network ? 'network' : 'local-sign-only',
        moduleCount,
        signerLoadErrorCount: loadErrors.length,
        corpusPath,
        corpusEntries: entries.length,
        userAgentPolicy: {
            mode: args.userAgent ? 'fixed-cli' : 'random-mobile-material',
            materialPath: userAgentMaterial.sourcePath,
            materialCount: userAgentMaterial.items.length,
            eligibleMaterialCount: args.userAgent
                ? 1
                : userAgentMaterial.items.filter(item => {
                    const platform = String(args.userAgentPlatform || '').toLowerCase();
                    return !platform || platform === 'any' || String(item.platform || '').toLowerCase() === platform;
                }).length,
            platform: args.userAgent ? 'custom' : args.userAgentPlatform,
        },
        outboundProxy: args.network ? {
            required: true,
            label: '配置出口',
            proxyUrl: maskProxyUrl(args.proxyUrl),
        } : undefined,
        results,
    }, null, 2));
}

if (require.main === module) {
    main()
        .then(() => process.exit(0))
        .catch(error => {
            console.error(JSON.stringify({
                success: false,
                error: error.message,
            }, null, 2));
            process.exit(1);
        });
}

module.exports = {
    UNIFIED_OUTBOUND_PROXY_URL,
    buildCase,
    buildSignerPayload,
    DEFAULT_USER_AGENT_FILE,
    FALLBACK_MOBILE_WECHAT_UA,
    ANDROID_WECHAT_MINIPROGRAM_HEADERS,
    applyAndroidMiniProgramHeaders,
    loadCorpusEntries,
    loadSigner,
    loadUserAgentMaterial,
    maskProxyUrl,
    pickCorpusPath,
    pickMobileUserAgent,
    publicUserAgentChoice,
    requestWithProxy,
    setHeader,
    signCase,
    summarizeBody,
};
