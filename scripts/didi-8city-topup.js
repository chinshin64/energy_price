#!/usr/bin/env node
'use strict';
// 滴滴充电 补采脚本 — 把8城市总量从616补到800-840
// 针对未达标城市, 换周边坐标翻页采, 完整secdd链路
const fs = require('fs');
const path = require('path');
const {
    loadSigner, buildCase, buildSignerPayload, pickMobileUserAgent,
    loadUserAgentMaterial, loadCorpusEntries, pickCorpusPath,
} = require('./wsgsig-sdk-validation');
const { secddChallengeRequest } = require('./secdd-challenge');

const PROJECT_ROOT = path.join(__dirname, '..');
const INTERVAL_MS = 1200;

// 未达标城市的补采坐标(周边区域, 避开原坐标的分页限制)
// 太原明显数据少, 换成数据多的城市补
const TOPUP_TASKS = [
    // 杭州: 原98/127, 补30 → 换萧山/余杭坐标
    { city: '杭州市', lat: 30.18, lng: 120.25, target: 35 },   // 萧山
    // 西安: 原99/147, 补50 → 换高新/曲江坐标
    { city: '西安市', lat: 34.22, lng: 108.87, target: 30 },   // 高新
    { city: '西安市', lat: 34.21, lng: 108.96, target: 25 },   // 曲江
    // 南昌: 原100/125, 补30
    { city: '南昌市', lat: 28.68, lng: 115.92, target: 30 },   // 红谷滩
    // 太原换城市: 用郑州补(数据多)
    { city: '郑州市', lat: 34.75, lng: 113.63, target: 40 },   // 郑东新区
    { city: '郑州市', lat: 34.74, lng: 113.60, target: 35 },   // 二七区
    { city: '长沙市', lat: 28.23, lng: 112.94, target: 40 },   // 替代太原, 长沙数据多
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function extractStations(bodyText) {
    try {
        const body = JSON.parse(bodyText);
        const comps = body?.data?.components || [];
        const stations = [];
        for (const c of comps) {
            for (const st of (c.data || [])) {
                const fee = st?.occupyInfoVO?.feeVOList || [];
                stations.push({
                    stationId: st.stationId, stationName: st.stationName,
                    fullStationId: st.fullStationId, lat: st.lat, lng: st.lng,
                    address: st.address, unitPrice: fee[0]?.unitPrice, cappedPrice: fee[0]?.cappedPrice,
                });
            }
        }
        return { code: body?.code, stations };
    } catch { return { code: null, stations: [] }; }
}

(async () => {
    console.log('=== 补采: 把总量从616补到800-840 ===');
    const { signer } = loadSigner();
    const sample = loadCorpusEntries(pickCorpusPath())[0];
    const uaMaterial = loadUserAgentMaterial();

    // 读已有的616站(去重用)
    const existPath = path.join(PROJECT_ROOT, 'data', 'didi-8city-stations.json');
    const allStations = JSON.parse(fs.readFileSync(existPath, 'utf8'));
    const seen = new Set(allStations.map(s => s.fullStationId || s.stationId));
    console.log(`已有 ${allStations.length} 站, 补采目标 +${TOPUP_TASKS.reduce((a,b)=>a+b.target,0)}`);

    let added = 0, req = 0, fail = 0;
    const uaUsed = new Set();

    for (const task of TOPUP_TASKS) {
        let collected = 0;
        let pageNo = 1;
        let consecutiveFail = 0;
        console.log(`\n--- ${task.city} (${task.lat},${task.lng}) 目标+${task.target}站 ---`);
        while (collected < task.target && pageNo <= 6 && consecutiveFail < 2) {
            const ua = pickMobileUserAgent(uaMaterial, '', 'android');
            uaUsed.add(ua.id);
            const requestCase = buildCase(sample, task, { userAgent: ua.userAgent });
            requestCase.bodyParams.pageNo = pageNo;
            requestCase.bodyParams.pageSize = 20;
            requestCase.bodyParams.lat = task.lat;
            requestCase.bodyParams.lng = task.lng;
            requestCase.bodyParams.userlat = task.lat;
            requestCase.bodyParams.userlng = task.lng;

            const signPayload = buildSignerPayload(requestCase);
            const url = new URL(requestCase.baseUrl);
            for (const [k, v] of Object.entries(requestCase.queryParams || {})) url.searchParams.set(k, String(v));

            req++;
            const secddResult = await secddChallengeRequest({
                url: url.href, method: requestCase.method, headers: { ...requestCase.headers },
                body: JSON.stringify(requestCase.bodyParams || {}), signer, signPayload,
                timeoutMs: 15000, os: '3', version: '2.0.34',
            });
            const finalResp = secddResult.final || {};
            const ext = extractStations(finalResp.body || '');
            const ok = finalResp.httpStatus === 200 && ext.code === 10000;
            if (ok && ext.stations.length > 0) {
                consecutiveFail = 0;
                let newCount = 0;
                for (const st of ext.stations) {
                    const id = st.fullStationId || st.stationId;
                    if (seen.has(id)) continue;
                    seen.add(id);
                    allStations.push({ ...st, city: task.city, pageNo, uaId: ua.id,
                        collectedAt: new Date().toISOString().replace('T', ' ').slice(0, 19) });
                    newCount++; collected++; added++;
                }
                console.log(`  p${pageNo} ✓ ${ext.stations.length}站(新增${newCount}) 累计+${collected}/${task.target} UA=${ua.id}`);
            } else {
                fail++; consecutiveFail++;
                console.log(`  p${pageNo} ✗ HTTP${finalResp.httpStatus} code${ext.code}`);
            }
            fs.writeFileSync(existPath, JSON.stringify(allStations, null, 1));
            pageNo++;
            if (collected < task.target) await sleep(INTERVAL_MS);
        }
    }

    console.log(`\n=== 补采完成 ===`);
    console.log(`总量: ${allStations.length} 站 (补采+${added})`);
    console.log(`补采请求: ${req}次, 失败${fail}次`);
    console.log(`目标800-840: ${allStations.length >= 800 && allStations.length <= 840 ? '✓ 达标' : '✗ 未达标'}`);
    fs.writeFileSync(existPath, JSON.stringify(allStations, null, 1));
})();
