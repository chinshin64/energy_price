#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {
    UNIFIED_OUTBOUND_PROXY_URL,
    buildCase,
    loadCorpusEntries,
    loadUserAgentMaterial,
    loadSigner,
    maskProxyUrl,
    pickCorpusPath,
    pickMobileUserAgent,
    publicUserAgentChoice,
    requestWithProxy,
    signCase,
} = require('./wsgsig-sdk-validation');
const { SecddSession } = require('./didi-secdd-client');

const PROJECT_ROOT = path.join(__dirname, '..');
const SOURCE_STAGE = process.env.SOURCE_STAGE || 'didi-batch-50';
const BOOTSTRAP_URL = 'https://energy.xiaojukeji.com/station-api/homePageLayout';
const AGENT_TEST_HTTP_LIMIT = 5;

function extractStationList(payload) {
    const components = Array.isArray(payload?.data?.components) ? payload.data.components : [];
    for (const component of components) {
        if (Array.isArray(component?.data)) return component.data;
    }
    return [];
}

function stationKey(station) {
    return String(station.stationId || station.fullStationId || station.id
        || `${station.stationName || station.displayName || ''}|${station.lat || ''}|${station.lng || ''}`);
}

function toNumber(value) {
    if (value === null || value === undefined || value === '' || typeof value === 'object') return null;
    const normalized = typeof value === 'string' ? value.replace(/[^\d.-]/g, '') : value;
    const number = Number(normalized);
    return Number.isFinite(number) ? number : null;
}

function toInt(value) {
    const number = toNumber(value);
    return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0;
}

function pickNumber(...values) {
    for (const value of values) {
        const number = toNumber(value);
        if (Number.isFinite(number)) return number;
    }
    return null;
}

function pickText(...values) {
    for (const value of values) {
        if (value === null || value === undefined) continue;
        const text = String(value).trim();
        if (text) return text;
    }
    return '';
}

function normalizeStation(station, context = {}) {
    const memberPrice = station?.memberAnchorPrice && typeof station.memberAnchorPrice === 'object'
        ? station.memberAnchorPrice
        : {};
    const totalPrice = pickNumber(
        memberPrice.totalSalePrice,
        memberPrice.totalSalePriceV,
        station.totalSalePrice,
        station.priceFast,
        station.price_fast
    );
    const servicePrice = pickNumber(memberPrice.servSalePrice, memberPrice.servMarketPrice, station.priceService);
    const fastTotal = toInt(station.fastChargeNum ?? station.fastTotalPorts);
    const fastIdle = toInt(station.fastChargeIdleNum ?? station.fastIdlePorts);
    const slowTotal = toInt(station.slowChargeNum ?? station.slowTotalPorts);
    const slowIdle = toInt(station.slowChargeIdleNum ?? station.slowIdlePorts);
    const superTotal = toInt(station.superChargeNum ?? station.superTotalPorts);
    const superIdle = toInt(station.superChargeIdleNum ?? station.superIdlePorts);
    const stationId = pickText(
        station.stationId,
        station.fullStationId,
        station.id,
        station.station_id,
        `${station.stationName || station.displayName || station.station_name || ''}|${station.lat || station.latitude || ''}|${station.lng || station.longitude || ''}`
    );
    const stationName = pickText(station.stationName, station.displayName, station.station_name, station.name);
    const rawStation = station.rawStation || station.raw?.didiStation || station;
    return {
        platform: 'didi-charging',
        stationId,
        stationName,
        address: station.address || null,
        latitude: pickNumber(station.lat, station.latitude),
        longitude: pickNumber(station.lng, station.longitude),
        priceFast: totalPrice,
        priceSlow: slowTotal > 0 ? totalPrice : null,
        priceSuper: superTotal > 0 ? totalPrice : null,
        priceService: servicePrice,
        fastIdlePorts: fastIdle,
        fastTotalPorts: fastTotal,
        slowIdlePorts: slowIdle,
        slowTotalPorts: slowTotal,
        superIdlePorts: superIdle,
        superTotalPorts: superTotal,
        onlineFastPorts: fastIdle + superIdle,
        onlineSlowPorts: slowIdle,
        availablePorts: fastIdle + slowIdle + superIdle,
        totalPorts: fastTotal + slowTotal + superTotal,
        operator: pickText(station.operatorId, station.operatorName, station.operator),
        confidence: 0.95,
        sourceType: 'api-wsgsig',
        sourceStage: SOURCE_STAGE,
        raw: {
            source: 'api-wsgsig',
            sourceType: 'api-wsgsig',
            sourceStage: SOURCE_STAGE,
            city: context.city || station.city || '',
            sourceSeed: context.seedName || station.sourceSeed || null,
            sourceLat: context.seedLat ?? station.sourceLat ?? null,
            sourceLng: context.seedLng ?? station.sourceLng ?? null,
            sourcePage: context.pageNo ?? station.sourcePage ?? null,
            proxy: {
                used: true,
                label: '配置出口',
                proxyUrl: context.proxyUrl ? maskProxyUrl(context.proxyUrl) : null,
            },
            userAgent: context.userAgent ? publicUserAgentChoice(context.userAgent) : null,
            didiStation: rawStation,
        },
    };
}

const CITY_SEEDS = [
    { city: '北京市', seeds: [{ name: '朝阳区', lat: 39.860826, lng: 116.35905 }, { name: '海淀区', lat: 39.950786, lng: 116.405822 }, { name: '西城区', lat: 39.915663, lng: 116.449147 }, { name: '丰台区', lat: 39.909681, lng: 116.438853 }] },
    { city: '上海市', seeds: [{ name: '人民广场', lat: 31.2336, lng: 121.4691 }, { name: '陆家嘴', lat: 31.2397, lng: 119.4998 }, { name: '虹桥', lat: 31.1953, lng: 121.3354 }, { name: '徐汇', lat: 31.1844, lng: 121.4366 }] },
    { city: '杭州市', seeds: [{ name: '西湖', lat: 30.2592, lng: 120.1303 }, { name: '滨江', lat: 30.2083, lng: 120.2118 }, { name: '未来科技城', lat: 30.2939, lng: 119.9648 }] },
    { city: '广州市', seeds: [{ name: '天河', lat: 23.12911, lng: 113.264385 }, { name: '珠江新城', lat: 23.1193, lng: 113.3237 }, { name: '番禺', lat: 22.9376, lng: 113.3842 }] },
    { city: '深圳市', seeds: [{ name: '福田', lat: 22.5410, lng: 114.0583 }, { name: '南山', lat: 22.5333, lng: 113.9302 }, { name: '宝安', lat: 22.5536, lng: 113.8831 }] },
    { city: '西安市', seeds: [{ name: '钟楼', lat: 34.261005, lng: 108.942336 }, { name: '高新', lat: 34.2206, lng: 108.8842 }, { name: '曲江', lat: 34.1968, lng: 108.9807 }] },
    { city: '成都市', seeds: [{ name: '锦江', lat: 30.6595, lng: 104.0651 }, { name: '高新', lat: 30.5430, lng: 104.0715 }, { name: '天府广场', lat: 30.6570, lng: 104.0660 }] },
    { city: '武汉市', seeds: [{ name: '武昌', lat: 30.5503, lng: 114.3162 }, { name: '汉口', lat: 30.5928, lng: 114.3055 }, { name: '光谷', lat: 30.5053, lng: 114.4145 }] },
];

function parseArgs(argv, env = process.env) {
    const args = {
        total: Math.max(1, Math.min(Number(env.MAX_REQ || 50) || 50, 50)),
        city: String(env.DIDI_CITY || '').trim(),
        agentTest: env.DIDI_AGENT_TEST === '1',
        agentHttpLimit: Math.max(1, Math.min(Number(env.DIDI_AGENT_HTTP_LIMIT || AGENT_TEST_HTTP_LIMIT) || AGENT_TEST_HTTP_LIMIT, AGENT_TEST_HTTP_LIMIT)),
        proxyUrl: env.PROXY_URL || env.WSGSIG_PROXY_URL || UNIFIED_OUTBOUND_PROXY_URL || 'http://127.0.0.1:18080',
        timeoutMs: Math.max(3000, Number(env.TIMEOUT_MS || 15000) || 15000),
        delayMs: Math.max(0, Number(env.DELAY_MS || 1500) || 0),
        pageSize: Math.max(1, Number(env.PAGE_SIZE || 10) || 10),
        userAgentFile: path.join(PROJECT_ROOT, 'config/mobile-wechat-user-agents.json'),
        userAgentPlatform: 'android',
        writeDb: env.DIDI_AGENT_TEST === '1' ? env.WRITE_DB === '1' : env.NO_DB !== '1',
    };
    for (let index = 2; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === '--agent-test') args.agentTest = true;
        else if (arg === '--total') args.total = Math.max(1, Math.min(Number(argv[++index]) || 50, 50));
        else if (arg === '--city') args.city = String(argv[++index] || '').trim();
        else if (arg === '--agent-http-limit') args.agentHttpLimit = Math.max(1, Math.min(Number(argv[++index]) || AGENT_TEST_HTTP_LIMIT, AGENT_TEST_HTTP_LIMIT));
        else if (arg === '--proxy-url') args.proxyUrl = argv[++index] || '';
        else if (arg === '--timeout-ms') args.timeoutMs = Math.max(3000, Number(argv[++index]) || 15000);
        else throw new Error(`unknown argument: ${arg}`);
    }
    if (args.agentTest && env.WRITE_DB !== '1') args.writeDb = false;
    if (!args.proxyUrl) throw new Error('proxy_url_required');
    return args;
}

function buildPlan(options = {}) {
    const maximum = Math.max(1, Math.min(Number(options.total || 50), 50));
    const citySeeds = options.city ? CITY_SEEDS.filter(item => item.city === options.city) : CITY_SEEDS;
    if (citySeeds.length === 0) throw new Error(`unsupported_city_${options.city}`);
    const plan = [];
    const pagesPerSeed = 2;
    for (let pageNo = 1; pageNo <= pagesPerSeed; pageNo++) {
        for (const city of citySeeds) {
            for (const seed of city.seeds) {
                plan.push({ city: city.city, seedName: seed.name, lat: seed.lat, lng: seed.lng, pageNo });
                if (plan.length >= maximum) return plan;
            }
        }
    }
    return plan.slice(0, maximum);
}

function resolveOutputPath(args, runId) {
    if (args.agentTest) return path.join('/private/tmp', `didi-batch-agent-test-${runId}.json`);
    return path.join(PROJECT_ROOT, `outputs/didi-batch-50-${runId}.json`);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function createNetworkSender(args, networkUsage) {
    return async (url, request) => {
        if (args.agentTest && networkUsage.count >= args.agentHttpLimit) {
            throw new Error('agent_test_http_request_limit_exceeded');
        }
        networkUsage.count++;
        return requestWithProxy(url, {
            ...request,
            timeoutMs: args.timeoutMs,
            proxyUrl: args.proxyUrl,
        });
    };
}

function buildSignedUrl(signer, requestCase, signLengths = []) {
    const signed = signCase(signer, requestCase);
    if (!signed.summary.generated) throw new Error('wsgsig_generation_failed');
    signLengths.push(signed.summary.length);
    const url = new URL(requestCase.baseUrl);
    for (const [key, value] of Object.entries(requestCase.queryParams || {})) {
        if (value !== null && value !== undefined) url.searchParams.set(key, String(value));
    }
    url.searchParams.set('wsgsig', signed.signature);
    return url;
}

function buildBootstrapCase(sample, target, userAgent) {
    const requestCase = buildCase(sample, target, { userAgent });
    requestCase.method = 'GET';
    requestCase.baseUrl = BOOTSTRAP_URL;
    requestCase.queryParams = {
        source: String(sample.queryParams?.source ?? '2'),
        ttid: String(sample.queryParams?.ttid ?? 'wx'),
    };
    requestCase.bodyParams = undefined;
    return requestCase;
}

async function sendSecddRequest(secdd, signer, requestCase, send) {
    const signLengths = [];
    const chain = await secdd.request({
        buildSignedUrl: () => buildSignedUrl(signer, requestCase, signLengths),
        method: requestCase.method,
        headers: requestCase.headers,
        body: requestCase.bodyParams === undefined ? undefined : JSON.stringify(requestCase.bodyParams),
        send,
    });
    return { ...chain, signLengths };
}

async function main() {
    const args = parseArgs(process.argv);
    const networkUsage = { count: 0 };
    const send = createNetworkSender(args, networkUsage);
    const { signer, moduleCount, loadErrors } = loadSigner();
    const corpusPath = pickCorpusPath();
    const entries = loadCorpusEntries(corpusPath);
    if (entries.length === 0) throw new Error('no_corpus_entries');
    const sample = entries[0];
    const userAgentMaterial = loadUserAgentMaterial(args.userAgentFile);
    const plan = buildPlan(args);
    const runId = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    const outPath = resolveOutputPath(args, runId);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });

    const secdd = new SecddSession();
    const bootstrapUa = pickMobileUserAgent(userAgentMaterial, '', args.userAgentPlatform);
    const bootstrapCase = buildBootstrapCase(sample, plan[0], bootstrapUa.userAgent);
    const bootstrap = await sendSecddRequest(secdd, signer, bootstrapCase, send);
    let bootstrapPayload;
    try {
        bootstrapPayload = JSON.parse(bootstrap.response.bodyText || '{}');
    } catch {
        throw new Error(`secdd_bootstrap_non_json_http_${bootstrap.response.status}`);
    }
    const bootstrapCode = Number(bootstrapPayload.code ?? bootstrapPayload.errno ?? 0);
    if (bootstrap.response.status !== 200 || bootstrapCode !== 10000) {
        throw new Error(`secdd_bootstrap_failed_http_${bootstrap.response.status}_code_${bootstrapCode}`);
    }

    const results = [];
    const allStations = [];
    let success = 0;
    let fail = 0;
    let stationsCollected = 0;
    const uaUsage = {};
    const failReasons = {};
    const cityCoverage = {};

    for (let index = 0; index < plan.length; index++) {
        const target = plan[index];
        const uaChoice = pickMobileUserAgent(userAgentMaterial, '', args.userAgentPlatform);
        uaUsage[uaChoice.id] = (uaUsage[uaChoice.id] || 0) + 1;
        const requestCase = buildCase(sample, target, { userAgent: uaChoice.userAgent });
        requestCase.bodyParams.pageNo = target.pageNo;
        requestCase.bodyParams.pageSize = args.pageSize;
        requestCase.bodyParams.lat = target.lat;
        requestCase.bodyParams.lng = target.lng;
        requestCase.bodyParams.userlat = target.lat;
        requestCase.bodyParams.userlng = target.lng;

        const entry = {
            index: index + 1,
            city: target.city,
            seedName: target.seedName,
            lat: target.lat,
            lng: target.lng,
            pageNo: target.pageNo,
            userAgentId: uaChoice.id,
        };
        let chain;
        try {
            chain = await sendSecddRequest(secdd, signer, requestCase, send);
        } catch (error) {
            fail++;
            const reason = /timeout/i.test(error.message) ? 'timeout' : error.message === 'agent_test_http_request_limit_exceeded' ? 'request_budget' : 'request_error';
            failReasons[reason] = (failReasons[reason] || 0) + 1;
            Object.assign(entry, { status: 'fail', reason, error: error.message });
            results.push(entry);
            console.log(JSON.stringify(entry));
            if (reason === 'request_budget') break;
            if (args.delayMs > 0) await sleep(args.delayMs);
            continue;
        }

        const response = chain.response;
        Object.assign(entry, {
            signLength: chain.signLengths[chain.signLengths.length - 1] || null,
            secddPath: chain.path,
            secddAttempts: chain.attemptCount,
            secddChallengeHandled: chain.challengeHandled,
            secddSessionRuleCount: chain.sessionRuleCount,
        });
        let payload;
        try {
            payload = JSON.parse(response.bodyText);
        } catch {
            fail++;
            const reason = 'non_json';
            failReasons[reason] = (failReasons[reason] || 0) + 1;
            Object.assign(entry, { status: 'fail', reason, httpStatus: response.status, bodyPreview: String(response.bodyText || '').slice(0, 200) });
            results.push(entry);
            console.log(JSON.stringify(entry));
            if (args.delayMs > 0) await sleep(args.delayMs);
            continue;
        }

        const code = Number(payload.code ?? payload.errno ?? 0);
        const stations = extractStationList(payload);
        Object.assign(entry, {
            httpStatus: response.status,
            businessCode: code,
            message: payload.message || payload.errmsg || '',
            returnedCount: stations.length,
        });
        if (response.status === 200 && code === 10000) {
            success++;
            entry.status = 'success';
            cityCoverage[target.city] = (cityCoverage[target.city] || 0) + stations.length;
            for (const station of stations) {
                allStations.push(normalizeStation(station, {
                    city: target.city,
                    seedName: target.seedName,
                    seedLat: target.lat,
                    seedLng: target.lng,
                    pageNo: target.pageNo,
                    userAgent: uaChoice,
                    proxyUrl: args.proxyUrl,
                }));
            }
            stationsCollected += stations.length;
        } else {
            fail++;
            const reason = `http_${response.status}_code_${code}`;
            failReasons[reason] = (failReasons[reason] || 0) + 1;
            Object.assign(entry, { status: 'fail', reason, bodyPreview: String(response.bodyText || '').slice(0, 300) });
        }
        results.push(entry);
        console.log(JSON.stringify(entry));
        if (args.delayMs > 0 && index < plan.length - 1) await sleep(args.delayMs);
    }

    const seen = new Map();
    for (const station of allStations) {
        const key = stationKey(station);
        if (key && !seen.has(key)) seen.set(key, station);
    }
    const uniqueStations = Array.from(seen.values());
    let dbResult = null;
    if (args.writeDb && uniqueStations.length > 0) {
        try {
            const StationModel = require('../backend/models/station');
            dbResult = StationModel.insertBatch(uniqueStations);
        } catch (error) {
            dbResult = { error: error.message };
        }
    }

    const summary = {
        success: true,
        runId,
        mode: args.agentTest ? 'agent-test' : 'batch-50-network-db',
        moduleCount,
        signerLoadErrorCount: loadErrors.length,
        corpusPath,
        userAgentPolicy: {
            mode: 'random-mobile-material',
            materialPath: userAgentMaterial.sourcePath,
            materialCount: userAgentMaterial.items.length,
            eligible: userAgentMaterial.items.filter(item => item.platform === 'android').length,
            platform: 'android',
        },
        outboundProxy: { required: true, used: true, proxyUrl: maskProxyUrl(args.proxyUrl) },
        requestBudget: {
            networkRequestsUsed: networkUsage.count,
            networkRequestLimit: args.agentTest ? args.agentHttpLimit : null,
        },
        secddBootstrap: {
            path: bootstrap.path,
            attempts: bootstrap.attemptCount,
            challengeHandled: bootstrap.challengeHandled,
            authenticationLength: bootstrap.authenticationLength,
            sessionRuleCount: bootstrap.sessionRuleCount,
        },
        plan: {
            totalRequests: plan.length,
            citiesCovered: [...new Set(plan.map(item => item.city))],
            pagesPerSeedMax: Math.max(...plan.map(item => item.pageNo)),
        },
        stats: {
            requestsTotal: results.length,
            success,
            fail,
            stationsCollectedRaw: stationsCollected,
            uniqueStations: uniqueStations.length,
        },
        uaUsage,
        failReasons,
        cityCoverage,
        dbResult: dbResult ? {
            enabled: true,
            inputCount: dbResult.inputCount ?? uniqueStations.length,
            successCount: dbResult.successCount,
            skipCount: dbResult.skipCount,
            redCount: dbResult.redCount,
            yellowCount: dbResult.yellowCount,
            scoreSummary: dbResult.scoreSummary,
            error: dbResult.error,
        } : { enabled: false },
        results,
    };
    fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
    console.log('\n=== SUMMARY ===');
    console.log(JSON.stringify({
        success,
        fail,
        stationsCollectedRaw: stationsCollected,
        uniqueStations: uniqueStations.length,
        networkRequestsUsed: networkUsage.count,
        uaUsage,
        failReasons,
        cityCoverage,
        dbResult: summary.dbResult,
        outPath,
    }, null, 2));
    return summary;
}

if (require.main === module) {
    main()
        .then(() => process.exit(0))
        .catch(error => {
            console.error(JSON.stringify({ success: false, error: error.message, stack: error.stack }, null, 2));
            process.exit(1);
        });
}

module.exports = {
    AGENT_TEST_HTTP_LIMIT,
    buildBootstrapCase,
    buildPlan,
    buildSignedUrl,
    createNetworkSender,
    extractStationList,
    main,
    normalizeStation,
    parseArgs,
    resolveOutputPath,
    sendSecddRequest,
};
