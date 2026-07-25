#!/usr/bin/env node
'use strict';
// 滴滴充电 8城市批量采集 — 集成完整secdd挑战应答链路
// 全国随机8城市, 每城50-150站, 总量800-840, 完整站数据落盘+入库
// 出口: 47.111.139.230 (直连)  UA: 随机轮换  secdd: 完整挑战应答(522自动应答)

const fs = require('fs');
const path = require('path');
const {
    loadSigner, buildCase, buildSignerPayload, pickMobileUserAgent,
    loadUserAgentMaterial, loadCorpusEntries, pickCorpusPath,
} = require('./wsgsig-sdk-validation');
// 复用secdd-challenge.js的完整挑战应答
const { secddChallengeRequest } = require('./secdd-challenge');

const PROJECT_ROOT = path.join(__dirname, '..');
const INTERVAL_MS = 1200;

// 全国城市池(随机挑8个)
const CITY_POOL = [
    { city: '北京市', lat: 39.9042, lng: 116.4074 },
    { city: '上海市', lat: 31.2304, lng: 121.4737 },
    { city: '广州市', lat: 23.1291, lng: 113.2644 },
    { city: '深圳市', lat: 22.5431, lng: 114.0579 },
    { city: '杭州市', lat: 30.2741, lng: 120.1551 },
    { city: '南京市', lat: 32.0603, lng: 118.7969 },
    { city: '苏州市', lat: 31.2989, lng: 120.5853 },
    { city: '成都市', lat: 30.5728, lng: 104.0668 },
    { city: '武汉市', lat: 30.5928, lng: 114.3055 },
    { city: '西安市', lat: 34.3416, lng: 108.9398 },
    { city: '重庆市', lat: 29.5630, lng: 106.5516 },
    { city: '天津市', lat: 39.0851, lng: 117.1994 },
    { city: '青岛市', lat: 36.0671, lng: 120.3826 },
    { city: '长沙市', lat: 28.2282, lng: 112.9388 },
    { city: '郑州市', lat: 34.7466, lng: 113.6253 },
    { city: '沈阳市', lat: 41.8057, lng: 123.4315 },
    { city: '大连市', lat: 38.9140, lng: 121.6147 },
    { city: '厦门市', lat: 24.4798, lng: 118.0894 },
    { city: '福州市', lat: 26.0745, lng: 119.2965 },
    { city: '昆明市', lat: 24.8801, lng: 102.8329 },
    { city: '贵阳市', lat: 26.6470, lng: 106.6302 },
    { city: '南宁市', lat: 22.8170, lng: 108.3669 },
    { city: '海口市', lat: 20.0440, lng: 110.1990 },
    { city: '合肥市', lat: 31.8206, lng: 117.2272 },
    { city: '南昌市', lat: 28.6820, lng: 115.8579 },
    { city: '太原市', lat: 37.8706, lng: 112.5489 },
    { city: '石家庄市', lat: 38.0428, lng: 114.5149 },
    { city: '济南市', lat: 36.6512, lng: 117.1201 },
    { city: '哈尔滨市', lat: 45.8038, lng: 126.5350 },
    { city: '长春市', lat: 43.8171, lng: 125.3235 },
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function pickRandom(arr, n) {
    const copy = [...arr];
    const out = [];
    for (let i = 0; i < n && copy.length; i++) {
        out.push(copy.splice(Math.floor(Math.random() * copy.length), 1)[0]);
    }
    return out;
}

// 分配每城目标站数: 总量800-840, 每城50-150
function allocateTargets(cities) {
    const min = 50, max = 150;
    const totalMin = cities.length * min;       // 400
    const totalMax = cities.length * max;       // 1200
    const targetTotal = 800 + Math.floor(Math.random() * 41); // 800-840
    let remaining = targetTotal;
    const targets = [];
    for (let i = 0; i < cities.length; i++) {
        const citiesLeft = cities.length - i;
        // 该城可选范围, 同时保证后续城市至少min, 不超过max
        const lo = Math.max(min, remaining - (citiesLeft - 1) * max);
        const hi = Math.min(max, remaining - (citiesLeft - 1) * min);
        const t = lo + Math.floor(Math.random() * (hi - lo + 1));
        targets.push(t);
        remaining -= t;
    }
    return { targets, total: targetTotal };
}

function extractStations(bodyText) {
    try {
        const body = JSON.parse(bodyText);
        const comps = body?.data?.components || [];
        const stations = [];
        for (const c of comps) {
            for (const st of (c.data || [])) {
                const fee = st?.occupyInfoVO?.feeVOList || [];
                stations.push({
                    stationId: st.stationId,
                    stationName: st.stationName,
                    fullStationId: st.fullStationId,
                    lat: st.lat, lng: st.lng,
                    address: st.address,
                    unitPrice: fee[0]?.unitPrice,
                    cappedPrice: fee[0]?.cappedPrice,
                });
            }
        }
        return { code: body?.code, stations };
    } catch (e) { return { code: null, stations: [] }; }
}

(async () => {
    console.log('=== 加载签名器 + secdd挑战应答模块 ===');
    const { signer } = loadSigner();
    const corpusPath = pickCorpusPath();
    const entries = loadCorpusEntries(corpusPath);
    const sample = entries[0];
    const uaMaterial = loadUserAgentMaterial();
    console.log(`签名器就绪, 语料${entries.length}条, UA池${uaMaterial.items.length}个`);

    // 随机选8城市 + 分配目标
    const cities = pickRandom(CITY_POOL, 8);
    const { targets, total } = allocateTargets(cities);
    console.log(`\n=== 8城市采集计划 (总量目标${total}) ===`);
    cities.forEach((c, i) => console.log(`  ${i + 1}. ${c.city} 目标${targets[i]}站`));

    const allStations = [];
    let totalReq = 0, successReq = 0, failReq = 0;
    const uaUsed = new Set();
    const secddPaths = { direct_200: 0, header_auth_replay: 0, challenge_522: 0, other: 0 };

    for (let ci = 0; ci < cities.length; ci++) {
        const city = cities[ci];
        const target = targets[ci];
        let collected = 0;
        let pageNo = 1;
        const pageSize = 20;
        let cityFail = 0;

        console.log(`\n--- [${ci + 1}/8] ${city.city} (目标${target}站) ---`);

        while (collected < target && pageNo <= 12 && cityFail < 3) {
            const ua = pickMobileUserAgent(uaMaterial, '', 'android');
            uaUsed.add(ua.id);
            const requestCase = buildCase(sample, city, { userAgent: ua.userAgent });
            requestCase.bodyParams.pageNo = pageNo;
            requestCase.bodyParams.pageSize = pageSize;
            requestCase.bodyParams.lat = city.lat;
            requestCase.bodyParams.lng = city.lng;
            requestCase.bodyParams.userlat = city.lat;
            requestCase.bodyParams.userlng = city.lng;

            const signPayload = buildSignerPayload(requestCase);
            const url = new URL(requestCase.baseUrl);
            for (const [k, v] of Object.entries(requestCase.queryParams || {})) url.searchParams.set(k, String(v));
            const headers = { ...requestCase.headers };

            totalReq++;
            // 走完整secdd挑战应答链路(secddChallengeRequest内部会调signer.getSign现算wsgsig)
            const secddResult = await secddChallengeRequest({
                url: url.href,
                method: requestCase.method,
                headers,
                body: JSON.stringify(requestCase.bodyParams || {}),
                signer,
                signPayload,
                timeoutMs: 15000,
                os: '3', version: '2.0.34',
            });

            const secddPath = secddResult.path || 'other';
            secddPaths[secddPath] = (secddPaths[secddPath] || 0) + 1;
            const finalResp = secddResult.final || {};
            const ext = extractStations(finalResp.body || '');

            const ok = finalResp.httpStatus === 200 && ext.code === 10000;
            if (ok && ext.stations.length > 0) {
                successReq++;
                for (const st of ext.stations) {
                    allStations.push({
                        ...st,
                        city: city.city,
                        pageNo,
                        uaId: ua.id,
                        secddPath: secddPath,
                        collectedAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
                    });
                }
                collected += ext.stations.length;
                console.log(`  p${pageNo} ✓ ${path} ${ext.stations.length}站 (累计${collected}/${target}) UA=${ua.id}`);
            } else {
                failReq++;
                cityFail++;
                console.log(`  p${pageNo} ✗ ${path} HTTP${finalResp.httpStatus} code${ext.code} ${ext.stations.length}站`);
            }
            // 增量落盘
            fs.writeFileSync(path.join(PROJECT_ROOT, 'data', 'didi-8city-stations.json'), JSON.stringify(allStations, null, 1));
            pageNo++;
            if (collected < target) await sleep(INTERVAL_MS);
        }
        console.log(`  ${city.city} 完成: 采集${collected}/${target}站`);
    }

    const summary = {
        cities: cities.map((c, i) => ({ city: c.city, target: targets[i] })),
        targetTotal: total,
        actualTotal: allStations.length,
        requests: { total: totalReq, success: successReq, fail: failReq },
        secddPaths,
        uaRotated: uaUsed.size,
        uaUsed: Array.from(uaUsed),
        exitIp: '47.111.139.230 (direct)',
    };
    fs.writeFileSync(path.join(PROJECT_ROOT, 'data', 'didi-8city-results.json'), JSON.stringify(summary, null, 2));
    fs.writeFileSync(path.join(PROJECT_ROOT, 'data', 'didi-8city-stations.json'), JSON.stringify(allStations, null, 1));
    console.log(`\n=== 完成 ===`);
    console.log(`总量: ${allStations.length}/${total} (目标${total})`);
    console.log(`请求: ${successReq}成功/${failReq}失败/${totalReq}总`);
    console.log(`secdd路径:`, secddPaths);
    console.log(`UA轮换: ${uaUsed.size}个`);
    console.log(`明细: data/didi-8city-stations.json`);
})();
