#!/usr/bin/env node
'use strict';

/**
 * STAR-01/02/04/05/06 综合验证
 * 签名: 精确复刻源码 h(t)+x.encode，使用 Node.js crypto + sm-crypto
 * 执行节点: 172 (172.28.170.239)
 * 约束: 最多 5 次业务请求
 */

const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');
const sm2 = require('sm-crypto').sm2;

const PUBKEY = '04BF7E8F5399634458895E49D71CD042C32BA22773EC929DCD8E9228BDF877F0929AAE8B12B7FCDF25D2BF63517CD23AC2737A9C78958BB0849C767DE4FC1A29CA';
const OPENID = 'ozGb50AawtgjUsfr5T6lYLv41IT4';
const BASE = 'https://gateway.sccncdn.com/apph5/xcxApiV2/wechat';
const MAX_REQUESTS = 5;
let requestCount = 0;
const results = [];

function ts() { return new Date().toISOString(); }
function log(msg) { console.log(`[${ts()}] ${msg}`); }

// === 精确复刻源码签名函数 ===
function v(t) { var e = ''; for (var n in t) e += n + '=' + t[n] + '&'; return e.slice(0, -1); }
function X(t) { var e = Object.keys(t).sort(), n = {}; for (var r = 0; r < e.length; r++) n[e[r]] = t[e[r]]; return n; }
function J(t, e) { var n = ''; for (var r in t) n += r + '=' + (e ? encodeURIComponent(t[r]) : t[r]) + '&'; return n.substr(0, n.length - 1); }
function h(t) { var e = crypto.createHash('md5').update(v(t)).digest('hex'); e = crypto.createHash('md5').update(String(e) + String(t.timestamp)).digest('hex'); return e.toUpperCase(); }
function x_encode(t) { return '04' + sm2.doEncrypt(t, PUBKEY, 0); }
function genNonce() { return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(t) { var e = 16 * Math.random() | 0; return ('x' == t ? e : 3 & e | 8).toString(16); }); }

function buildAndSend(apiPath, dataObj, openId, userAgent) {
    const t = Date.now();
    const nonce = genNonce();
    let d = Object.assign({}, dataObj, { timestamp: t });
    delete d.userId;
    let g = X(Object.assign({}, d, { nonce: nonce }));
    for (let key in g) { if (g[key] === null || g[key] === undefined) delete g[key]; }
    const sig = h(g);
    const cipher = x_encode(J(g, true));
    const body = 'data=' + encodeURIComponent(cipher);
    const url = BASE + apiPath;
    const u = new URL(url);
    
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: u.hostname, path: u.pathname, method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'channel-id': '100', 'Authorization': '',
                'X-Encrypted': 'true', 'X-Ca-Timestamp': String(t),
                'appVersion': '8.8.0.2', 'X-Ca-Signature': sig,
                'x-uid': openId, 'userId': '', 'positCity': '',
                'User-Agent': userAgent || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Mac MacWechat/WMPF',
            },
            timeout: 15000,
        }, (res) => {
            let chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), bodyLength: Buffer.concat(chunks).length }));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        req.write(body);
        req.end();
    });
}

function summarize(resp) {
    let bizCode = null, bizMsg = null, stationCount = 0;
    try {
        const j = JSON.parse(resp.body);
        bizCode = j.code !== undefined ? String(j.code) : null;
        bizMsg = j.msg || j.message || null;
        if (Array.isArray(j.data)) stationCount = j.data.length;
    } catch(e) {}
    return {
        httpStatus: resp.statusCode, bodyLength: resp.bodyLength,
        bizCode, bizMsg, stationCount,
        bodyPreview: resp.body.slice(0, 400),
    };
}

async function main() {
    console.log('='.repeat(60));
    console.log('STAR-01/02/04/05/06 综合验证');
    console.log(`执行节点: 172 (172.28.170.239) | 出口: 36.28.192.239`);
    console.log(`时间: ${ts()} | 请求预算: ${MAX_REQUESTS}`);
    console.log('='.repeat(60));

    const baseParams = {
        stubGroupTypes: '0,1', page: 1, pagecount: 5,
        searchScene: 2, lat: 31.2304, lng: 121.4737,
        radius: 10000, orderType: 1, equipmentType: 0,
        preferredStationSearch: true,
    };

    // === 请求 1: STAR-01 正常基线 ===
    log('--- 请求 1/5: STAR-01 正常基线 ---');
    requestCount++;
    const resp1 = await buildAndSend('/stubGroup/list/query/noUser', baseParams, OPENID);
    const s1 = summarize(resp1);
    log(`HTTP ${s1.httpStatus} | bizCode=${s1.bizCode} | stations=${s1.stationCount} | body=${s1.bodyLength}B`);
    log(`preview: ${s1.bodyPreview}`);
    results.push({ step: 1, desc: 'STAR-01 正常基线', ...s1 });

    // === 请求 2: STAR-02 无效身份（篡改 openId）===
    log('--- 请求 2/5: STAR-02 篡改openId ---');
    requestCount++;
    const resp2 = await buildAndSend('/stubGroup/list/query/noUser', baseParams, 'INVALID_OPENID_TEST_000');
    const s2 = summarize(resp2);
    log(`HTTP ${s2.httpStatus} | bizCode=${s2.bizCode} | stations=${s2.stationCount} | body=${s2.bodyLength}B`);
    log(`preview: ${s2.bodyPreview}`);
    results.push({ step: 2, desc: 'STAR-02 篡改openId', ...s2 });

    // === 请求 3: STAR-04 设备标识不匹配 ===
    log('--- 请求 3/5: STAR-04 设备标识不匹配 ---');
    requestCount++;
    const resp3 = await buildAndSend('/stubGroup/list/query/noUser', baseParams, OPENID,
        'Mozilla/5.0 (Linux; Android 13; FAKE_DEVICE_999 Build/FAKE; wv) AppleWebKit/537.36 MicroMessenger/8.0.47 MiniProgramEnv/android');
    const s3 = summarize(resp3);
    log(`HTTP ${s3.httpStatus} | bizCode=${s3.bizCode} | stations=${s3.stationCount} | body=${s3.bodyLength}B`);
    log(`preview: ${s3.bodyPreview}`);
    results.push({ step: 3, desc: 'STAR-04 设备不匹配', ...s3 });

    // === 请求 4: STAR-06 异常翻页（跨区域+深翻页）===
    log('--- 请求 4/5: STAR-06 异常翻页跨区域 ---');
    requestCount++;
    const params4 = { ...baseParams, page: 50, lat: 39.9042, lng: 116.4074 };
    const resp4 = await buildAndSend('/stubGroup/list/query/noUser', params4, OPENID);
    const s4 = summarize(resp4);
    log(`HTTP ${s4.httpStatus} | bizCode=${s4.bizCode} | stations=${s4.stationCount} | body=${s4.bodyLength}B`);
    log(`preview: ${s4.bodyPreview}`);
    results.push({ step: 4, desc: 'STAR-06 异常翻页跨区域', ...s4 });

    // === 请求 5: STAR-01 基线复验 ===
    log('--- 请求 5/5: STAR-01 基线复验 ---');
    requestCount++;
    const resp5 = await buildAndSend('/stubGroup/list/query/noUser', baseParams, OPENID);
    const s5 = summarize(resp5);
    log(`HTTP ${s5.httpStatus} | bizCode=${s5.bizCode} | stations=${s5.stationCount} | body=${s5.bodyLength}B`);
    log(`preview: ${s5.bodyPreview}`);
    results.push({ step: 5, desc: 'STAR-01 基线复验', ...s5 });

    // ========== 汇总 ==========
    console.log('\n' + '='.repeat(60));
    console.log('验证汇总');
    console.log('='.repeat(60));
    console.log(`执行节点: 172.28.170.239 | 出口IP: 36.28.192.239`);
    console.log(`实际请求: ${requestCount}/${MAX_REQUESTS}`);
    console.log('');
    for (const r of results) {
        console.log(`[步骤${r.step}] ${r.desc}`);
        console.log(`  HTTP=${r.httpStatus} bizCode=${r.bizCode} stations=${r.stationCount} body=${r.bodyLength}B`);
        if (r.bizMsg) console.log(`  msg=${r.bizMsg}`);
        console.log('');
    }

    const bl = results[0];
    console.log('STAR-01: ' + (bl.bizCode === '200' ? '✅ 逐次请求证据完整' : '⚠️ 请求异常 bizCode=' + bl.bizCode));
    console.log('STAR-02: ' + (results[1].bizCode !== bl.bizCode || results[1].stationCount !== bl.stationCount ? '✅ 无效身份被识别' : '⚠️ 无效身份未被拒绝'));
    console.log('STAR-04: ' + (results[2].bizCode !== bl.bizCode || results[2].stationCount !== bl.stationCount ? '✅ 设备不匹配被识别' : '⚠️ 设备不匹配未被拒绝'));
    console.log('STAR-05: 登录材料有效时间需持续观察，当前 OPENID 仍可用 → ' + (bl.bizCode === '200' ? '材料仍有效' : '材料可能已失效'));
    console.log('STAR-06: ' + (results[3].bizCode !== bl.bizCode ? '✅ 异常访问被处置' : '⚠️ 异常访问未被处置'));

    console.log('\n--- JSON 结果 ---');
    console.log(JSON.stringify({
        testId: 'STAR-01-02-04-05-06',
        executedAt: ts(), executionNode: '172.28.170.239', outboundIP: '36.28.192.239',
        requestBudget: MAX_REQUESTS, actualRequests: requestCount, results, stopReason: '验证完成',
    }, null, 2));
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
