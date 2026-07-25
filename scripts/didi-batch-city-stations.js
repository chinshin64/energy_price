#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {
    UNIFIED_OUTBOUND_PROXY_URL,
    DEFAULT_USER_AGENT_FILE,
    buildCase,
    loadCorpusEntries,
    loadUserAgentMaterial,
    loadSigner,
    maskProxyUrl,
    pickCorpusPath,
    pickMobileUserAgent,
    publicUserAgentChoice,
    requestWithProxy,
    setHeader,
    signCase,
} = require('./wsgsig-sdk-validation');

const PROJECT_ROOT = path.join(__dirname, '..');
let StationModel;
const DEFAULT_CITY_GROUPS = [
    {
        city: '北京市',
        seeds: [
            { name: '朝阳区', lat: 39.860826, lng: 116.35905 },
            { name: '海淀区', lat: 39.950786, lng: 116.405822 },
            { name: '西城区', lat: 39.915663, lng: 116.449147 },
            { name: '东城区', lat: 39.912604, lng: 116.440501 },
            { name: '丰台区', lat: 39.909681, lng: 116.438853 },
            { name: '石景山区', lat: 39.940618, lng: 116.400161 },
            { name: '通州区', lat: 39.901221, lng: 116.405607 },
            { name: '顺义区', lat: 39.932872, lng: 116.421279 },
            { name: '大兴区', lat: 39.946379, lng: 116.445775 },
            { name: '昌平区', lat: 39.890532, lng: 116.363485 },
            { name: '房山区', lat: 39.879351, lng: 116.473972 },
            { name: '门头沟区', lat: 39.887682, lng: 116.354891 },
            { name: '怀柔区', lat: 39.867477, lng: 116.418507 },
            { name: '密云区', lat: 39.926242, lng: 116.417816 },
        ],
    },
    {
        city: '西安市',
        seeds: [
            { name: '主城钟楼', lat: 34.261005, lng: 108.942336 },
            { name: '高新', lat: 34.2206, lng: 108.8842 },
            { name: '曲江', lat: 34.1968, lng: 108.9807 },
            { name: '经开', lat: 34.3415, lng: 108.9469 },
            { name: '浐灞', lat: 34.3198, lng: 109.0585 },
            { name: '长安', lat: 34.1576, lng: 108.9069 },
            { name: '未央', lat: 34.3083, lng: 108.9468 },
            { name: '咸阳东', lat: 34.3296, lng: 108.7089 },
        ],
    },
    {
        city: '广州市',
        seeds: [
            { name: '天河', lat: 23.12911, lng: 113.264385 },
            { name: '珠江新城', lat: 23.1193, lng: 113.3237 },
            { name: '番禺', lat: 22.9376, lng: 113.3842 },
            { name: '黄埔', lat: 23.1814, lng: 113.4807 },
            { name: '白云', lat: 23.1823, lng: 113.2732 },
            { name: '花都', lat: 23.4037, lng: 113.2202 },
            { name: '南沙', lat: 22.8016, lng: 113.5252 },
            { name: '增城', lat: 23.2615, lng: 113.8109 },
        ],
    },
    {
        city: '武汉市',
        seeds: [
            { name: '武昌', lat: 30.5503, lng: 114.3162 },
            { name: '汉口', lat: 30.5928, lng: 114.3055 },
            { name: '汉阳', lat: 30.5542, lng: 114.2185 },
            { name: '光谷', lat: 30.5053, lng: 114.4145 },
            { name: '东西湖', lat: 30.6199, lng: 114.1371 },
            { name: '江夏', lat: 30.3756, lng: 114.3221 },
            { name: '黄陂', lat: 30.8813, lng: 114.3771 },
            { name: '蔡甸', lat: 30.5822, lng: 114.0292 },
        ],
    },
];

function parseArgs(argv) {
    const args = {
        corpusPath: '',
        targetCount: 300,
        maxPages: 12,
        pageSize: 10,
        timeoutMs: 12000,
        delayMs: 800,
        proxyUrl: UNIFIED_OUTBOUND_PROXY_URL,
        cityFilter: '',
        userAgent: '',
        userAgentFile: DEFAULT_USER_AGENT_FILE,
        userAgentPlatform: 'android',
        writeDb: true,
        importJsonPaths: [],
        importStage: 'didi-city-batch-file-backfill',
        sourceStage: 'city-batch-db-ingest',
    };

    for (let i = 2; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--corpus') {
            args.corpusPath = argv[++i] || '';
        } else if (arg === '--target-count') {
            args.targetCount = Math.max(1, Number(argv[++i]) || 300);
        } else if (arg === '--max-pages') {
            args.maxPages = Math.max(1, Number(argv[++i]) || 60);
        } else if (arg === '--page-size') {
            args.pageSize = Math.max(1, Math.min(50, Number(argv[++i]) || 10));
        } else if (arg === '--timeout-ms') {
            args.timeoutMs = Math.max(1000, Number(argv[++i]) || 12000);
        } else if (arg === '--delay-ms') {
            args.delayMs = Math.max(0, Number(argv[++i]) || 0);
        } else if (arg === '--proxy-url') {
            args.proxyUrl = argv[++i] || UNIFIED_OUTBOUND_PROXY_URL;
        } else if (arg === '--city') {
            args.cityFilter = argv[++i] || '';
        } else if (arg === '--user-agent') {
            args.userAgent = argv[++i] || '';
        } else if (arg === '--user-agent-file' || arg === '--ua-file') {
            args.userAgentFile = argv[++i] || DEFAULT_USER_AGENT_FILE;
        } else if (arg === '--ua-platform' || arg === '--user-agent-platform') {
            args.userAgentPlatform = argv[++i] || 'android';
        } else if (arg === '--no-db') {
            args.writeDb = false;
        } else if (arg === '--import-json' || arg === '--import-file') {
            args.importJsonPaths.push(argv[++i] || '');
        } else if (arg === '--import-stage') {
            args.importStage = argv[++i] || args.importStage;
        } else if (arg === '--source-stage') {
            args.sourceStage = argv[++i] || args.sourceStage;
        }
    }
    args.importJsonPaths = args.importJsonPaths.filter(Boolean);

    return args;
}

function expandSeeds(seeds) {
    const offsets = [
        { suffix: '中心', dLat: 0, dLng: 0 },
        { suffix: '北', dLat: 0.035, dLng: 0 },
        { suffix: '南', dLat: -0.035, dLng: 0 },
        { suffix: '东', dLat: 0, dLng: 0.04 },
        { suffix: '西', dLat: 0, dLng: -0.04 },
        { suffix: '东北', dLat: 0.03, dLng: 0.035 },
        { suffix: '西北', dLat: 0.03, dLng: -0.035 },
        { suffix: '东南', dLat: -0.03, dLng: 0.035 },
        { suffix: '西南', dLat: -0.03, dLng: -0.035 },
    ];
    const expanded = [];
    const seen = new Set();
    for (const seed of seeds) {
        for (const offset of offsets) {
            const item = {
                name: `${seed.name}-${offset.suffix}`,
                lat: Number((seed.lat + offset.dLat).toFixed(6)),
                lng: Number((seed.lng + offset.dLng).toFixed(6)),
            };
            const key = `${item.lat},${item.lng}`;
            if (!seen.has(key)) {
                seen.add(key);
                expanded.push(item);
            }
        }
    }
    return expanded;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function extractStationList(payload) {
    const components = Array.isArray(payload?.data?.components) ? payload.data.components : [];
    for (const component of components) {
        if (Array.isArray(component?.data)) return component.data;
    }
    return [];
}

function stationKey(station) {
    return String(
        station.stationId
        || station.fullStationId
        || station.id
        || `${station.stationName || station.displayName || ''}|${station.lat || ''}|${station.lng || ''}`
    );
}

function toNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'object') return null;
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
    const feeList = Array.isArray(station?.occupyInfoVO?.feeVOList) ? station.occupyInfoVO.feeVOList : [];
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
    const fastTotal = toInt(station.fastChargeNum ?? station.fastTotalPorts ?? station.fast_total_ports);
    const fastIdle = toInt(station.fastChargeIdleNum ?? station.fastIdlePorts ?? station.fast_idle_ports);
    const slowTotal = toInt(station.slowChargeNum ?? station.slowTotalPorts ?? station.slow_total_ports);
    const slowIdle = toInt(station.slowChargeIdleNum ?? station.slowIdlePorts ?? station.slow_idle_ports);
    const superTotal = toInt(station.superChargeNum ?? station.superTotalPorts ?? station.super_total_ports);
    const superIdle = toInt(station.superChargeIdleNum ?? station.superIdlePorts ?? station.super_idle_ports);
    const stationId = pickText(
        station.stationId,
        station.fullStationId,
        station.id,
        station.station_id,
        `${station.stationName || station.displayName || station.station_name || ''}|${station.lat || station.latitude || ''}|${station.lng || station.longitude || ''}`
    );
    const stationName = pickText(station.stationName, station.displayName, station.station_name, station.name);
    const sourceStage = context.sourceStage || 'city-batch-db-ingest';
    const sourceType = 'api-wsgsig';
    const city = context.city || station.city || '';
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
        sourceType,
        sourceStage,
        raw: {
            source: sourceType,
            sourceType,
            sourceStage,
            city,
            sourceSeed: context.seedName || station.sourceSeed || null,
            sourceLat: context.seedLat ?? station.sourceLat ?? null,
            sourceLng: context.seedLng ?? station.sourceLng ?? null,
            sourcePage: context.pageNo ?? station.sourcePage ?? null,
            importPath: context.importPath || null,
            importIndex: context.importIndex ?? null,
            proxy: {
                used: true,
                label: '配置出口',
                proxyUrl: context.proxyUrl ? maskProxyUrl(context.proxyUrl) : null,
            },
            userAgent: context.userAgent ? publicUserAgentChoice(context.userAgent) : null,
            didiStation: rawStation,
            feeListCount: feeList.length,
            firstFeeUnitPrice: feeList[0]?.unitPrice ?? null,
            firstFeeCappedPrice: feeList[0]?.cappedPrice ?? null,
        },
    };
}

function buildSignedRequest({ sample, signer, target, pageNo, pageSize, args }) {
    const userAgentChoice = pickMobileUserAgent(args.userAgentMaterial, args.userAgent, args.userAgentPlatform);
    const requestCase = buildCase(sample, target, { userAgent: userAgentChoice.userAgent });
    requestCase.bodyParams.pageNo = pageNo;
    requestCase.bodyParams.pageSize = pageSize;
    requestCase.bodyParams.lat = target.lat;
    requestCase.bodyParams.lng = target.lng;
    requestCase.bodyParams.userlat = target.lat;
    requestCase.bodyParams.userlng = target.lng;

    const signed = signCase(signer, requestCase);
    const url = new URL(requestCase.baseUrl);
    for (const [key, value] of Object.entries(requestCase.queryParams || {})) {
        url.searchParams.set(key, String(value));
    }
    url.searchParams.set('wsgsig', signed.signature);
    const headers = { ...requestCase.headers };
    setHeader(headers, 'secdd-challenge', '3|2.0.34||||||');
    setHeader(headers, 'secdd-authentication', Math.round(Date.now() / 1000));

    return {
        url,
        method: requestCase.method,
        headers,
        body: JSON.stringify(requestCase.bodyParams || {}),
        signSummary: signed.summary,
        signatureCarrier: 'query',
        userAgent: publicUserAgentChoice(userAgentChoice),
    };
}

async function fetchCity({ sample, signer, group, args }) {
    const seen = new Map();
    const seedSummaries = [];

    for (const seed of group.seeds) {
        const pages = [];
        let totalFromServer = null;
        const target = { city: group.city, lat: seed.lat, lng: seed.lng };

        for (let pageNo = 1; pageNo <= args.maxPages && seen.size < args.targetCount; pageNo++) {
            const signedRequest = buildSignedRequest({
                sample,
                signer,
                target,
                pageNo,
                pageSize: args.pageSize,
                args,
            });

            const response = await requestWithProxy(signedRequest.url, {
                method: signedRequest.method,
                headers: signedRequest.headers,
                body: signedRequest.body,
                timeoutMs: args.timeoutMs,
                proxyUrl: args.proxyUrl,
            });
            let payload;
            try {
                payload = JSON.parse(response.bodyText);
            } catch (error) {
                pages.push({ pageNo, httpStatus: response.status, parseError: error.message, count: 0 });
                break;
            }

            const stations = extractStationList(payload);
            if (Number.isFinite(Number(payload?.data?.total))) {
                totalFromServer = Number(payload.data.total);
            }
            const before = seen.size;
            for (const station of stations) {
                const key = stationKey(station);
                if (key && !seen.has(key)) {
                    seen.set(key, normalizeStation(station, {
                        city: group.city,
                        seedName: seed.name,
                        seedLat: seed.lat,
                        seedLng: seed.lng,
                        pageNo,
                        sourceStage: args.sourceStage,
                        userAgent: signedRequest.userAgent,
                        proxyUrl: args.proxyUrl,
                    }));
                }
            }
            const added = seen.size - before;
            pages.push({
                pageNo,
                httpStatus: response.status,
                businessCode: payload.code ?? payload.errno ?? payload.errorCode,
                message: payload.message || payload.errmsg || payload.msg || '',
                returnedCount: stations.length,
                addedCount: added,
                totalUnique: seen.size,
                signLength: signedRequest.signSummary.length,
                userAgentId: signedRequest.userAgent.id,
            });

            if (response.status !== 200 || Number(payload.code ?? payload.errno ?? 0) !== 10000) break;
            if (stations.length === 0) break;
            if (args.delayMs > 0) await sleep(args.delayMs);
        }

        seedSummaries.push({
            seedName: seed.name,
            lat: seed.lat,
            lng: seed.lng,
            pagesRequested: pages.length,
            totalFromServer,
            addedCount: pages.reduce((total, page) => total + Number(page.addedCount || 0), 0),
            lastPage: pages[pages.length - 1] || null,
        });

        if (seen.size >= args.targetCount) break;
    }

    return {
        city: group.city,
        targetCount: args.targetCount,
        success: seen.size >= args.targetCount,
        uniqueStationCount: seen.size,
        pagesRequested: seedSummaries.reduce((total, seed) => total + seed.pagesRequested, 0),
        seedSummaries,
        stations: Array.from(seen.values()),
    };
}

function getStationModel() {
    if (!StationModel) {
        StationModel = require('../backend/models/station');
    }
    return StationModel;
}

function insertStations(stations, args) {
    if (!args.writeDb) {
        return {
            enabled: false,
            inputCount: stations.length,
            successCount: 0,
            skipCount: 0,
            redCount: 0,
            yellowCount: 0,
        };
    }
    const result = getStationModel().insertBatch(stations);
    const details = Array.isArray(result.details) ? result.details : [];
    const scoreSummary = details.reduce((summary, item) => {
        const light = item.light || 'unknown';
        summary[light] = (summary[light] || 0) + 1;
        return summary;
    }, {});
    return {
        enabled: true,
        inputCount: stations.length,
        successCount: result.successCount || 0,
        skipCount: result.skipCount || 0,
        redCount: result.redCount || 0,
        yellowCount: result.yellowCount || 0,
        scoreSummary,
    };
}

function parseJsonStationFile(filePath, args) {
    const absolutePath = path.resolve(filePath);
    const payload = JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
    const rows = Array.isArray(payload) ? payload : payload.stations;
    if (!Array.isArray(rows)) {
        throw new Error(`station file must contain an array: ${absolutePath}`);
    }
    const cityMatch = path.basename(absolutePath).match(/^(.+?)-\d+\.json$/);
    const fallbackCity = cityMatch ? cityMatch[1] : '';
    const stations = rows
        .filter(row => row && typeof row === 'object')
        .map((row, index) => normalizeStation(row.rawStation || row, {
            city: row.city || fallbackCity,
            seedName: row.sourceSeed || null,
            seedLat: row.sourceLat ?? null,
            seedLng: row.sourceLng ?? null,
            pageNo: row.sourcePage ?? null,
            sourceStage: args.importStage,
            importPath: absolutePath,
            importIndex: index,
            proxyUrl: args.proxyUrl,
            userAgent: row.userAgentId ? {
                id: row.userAgentId,
                platform: row.userAgentPlatform || null,
                device: row.userAgentDevice || null,
                wechatVersion: null,
                sourcePath: args.userAgentFile,
            } : null,
        }));
    return {
        filePath: absolutePath,
        parsedCount: rows.length,
        stations,
    };
}

function importExistingStationFiles(args) {
    const files = args.importJsonPaths.map(filePath => parseJsonStationFile(filePath, args));
    const stations = files.flatMap(file => file.stations);
    const dbResult = insertStations(stations, args);
    return {
        success: true,
        mode: 'db-import',
        storage: {
            database: 'data/stations.db',
            filesWritten: false,
        },
        sourceFiles: files.map(file => ({
            filePath: file.filePath,
            parsedCount: file.parsedCount,
            normalizedCount: file.stations.length,
        })),
        importStage: args.importStage,
        dbResult,
    };
}

async function main() {
    const args = parseArgs(process.argv);
    if (!args.proxyUrl) throw new Error('proxyUrl is required by unified outbound policy');
    if (args.importJsonPaths.length > 0) {
        console.log(JSON.stringify(importExistingStationFiles(args), null, 2));
        return;
    }
    if (process.env.ALLOW_DIDI_BATCH_CITY_FETCH !== '1') {
        throw new Error('batch city fetch requires ALLOW_DIDI_BATCH_CITY_FETCH=1');
    }

    const { signer, moduleCount, loadErrors } = loadSigner();
    const corpusPath = pickCorpusPath(args.corpusPath);
    const entries = loadCorpusEntries(corpusPath);
    if (entries.length === 0) throw new Error('no didi stationList corpus entries available');
    args.userAgentMaterial = loadUserAgentMaterial(args.userAgentFile);

    const sample = entries[0];
    const runId = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    const summaries = [];
    const groups = DEFAULT_CITY_GROUPS
        .filter(group => !args.cityFilter || group.city.includes(args.cityFilter) || args.cityFilter.includes(group.city.replace(/市$/, '')))
        .map(group => ({ ...group, seeds: expandSeeds(group.seeds) }));

    if (groups.length === 0) throw new Error(`no city matched: ${args.cityFilter}`);

    for (const group of groups) {
        const result = await fetchCity({ sample, signer, group, args });
        const dbResult = insertStations(result.stations, args);
        summaries.push({
            city: result.city,
            success: result.success,
            uniqueStationCount: result.uniqueStationCount,
            targetCount: result.targetCount,
            pagesRequested: result.pagesRequested,
            seedSummaries: result.seedSummaries,
            dbResult,
        });
    }

    const summary = {
        success: summaries.every(item => item.success),
        mode: 'network-db-ingest',
        runId,
        moduleCount,
        signerLoadErrorCount: loadErrors.length,
        corpusPath,
        userAgentPolicy: {
            mode: args.userAgent ? 'fixed-cli' : 'random-mobile-material',
            materialPath: args.userAgentMaterial.sourcePath,
            materialCount: args.userAgentMaterial.items.length,
            eligibleMaterialCount: args.userAgent
                ? 1
                : args.userAgentMaterial.items.filter(item => {
                    const platform = String(args.userAgentPlatform || '').toLowerCase();
                    return !platform || platform === 'any' || String(item.platform || '').toLowerCase() === platform;
                }).length,
            platform: args.userAgent ? 'custom' : args.userAgentPlatform,
        },
        outboundProxy: {
            required: true,
            used: true,
            label: '配置出口',
            proxyUrl: maskProxyUrl(args.proxyUrl),
        },
        storage: {
            database: 'data/stations.db',
            filesWritten: false,
        },
        pageSize: args.pageSize,
        targetCount: args.targetCount,
        sourceStage: args.sourceStage,
        cities: summaries,
    };
    console.log(JSON.stringify(summary, null, 2));
}

main()
    .then(() => process.exit(0))
    .catch(error => {
        console.error(JSON.stringify({ success: false, error: error.message }, null, 2));
        process.exit(1);
    });
