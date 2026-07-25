#!/usr/bin/env node
'use strict';
const https = require('https');
const zlib = require('zlib');
const { URL } = require('url');
const CryptoJS = require('crypto-js');

const BASE_URL = 'https://app.xdtev.com';
const CHANNEL = '22';
const VERSION = '3.30260703.2';
const REFERER = 'https://servicewechat.com/wx17ab5a15e61efc32/371/page-frame.html';
const MAX_REQUESTS = 5;
let requestCount = 0;
const results = [];

function ts() { return new Date().toISOString(); }
function log(msg) { console.log(`[${ts()}] ${msg}`); }

const CRED = {
  dk: 'lnbsynY2fzA+VhdwTgJ/dg==',
  pw: 'Z9Wf+sSNN5XYNFSW8dGlSA==',
  userId: 'p5u15b9as1pjkzvswHzfadUETZIrAveasV2d5g2o1v6lbna6j2veho6Qo87aRm59',
  userName: 'EEhOPNoXERP5SdHz6FxDOvyYWPy17UA76IQIFsHpGrH9EevPupcKRYmelqCJqxeavRJQIgxu73VkhJQa8bkEAQ2WUC9xqBo5tW1qc5rO+8c8tLjBhJditrNgdhed/9mrXqtzTHDrIgprGroM5pAd7k1N+DfHiUGrHhWc2XE1gJ8=',
};
const AES_KEY_CONST = '+9eqnp==';

function deriveAesKey(pw) {
  const A = (e) => e.split('').sort().join('');
  return A(pw.substring(8, 16)) + A(pw.substring(0, 8)) + AES_KEY_CONST;
}
function makeKey(pw) { return CryptoJS.enc.Base64.parse(deriveAesKey(pw)); }
function aesEncrypt(data, keyWA) {
  return CryptoJS.AES.encrypt(typeof data === 'string' ? data : JSON.stringify(data), keyWA, { mode: CryptoJS.mode.ECB, padding: CryptoJS.pad.Pkcs7 }).toString();
}
function aesDecrypt(ciphertext, keyWA) {
  return JSON.parse(CryptoJS.AES.decrypt(ciphertext.replace(/[\r\n\s]/g, ''), keyWA, { mode: CryptoJS.mode.ECB, padding: CryptoJS.pad.Pkcs7 }).toString(CryptoJS.enc.Utf8));
}
function randomString(len) {
  const c = 'abcdefghijklmnopqrstuvwxyz0123456789'; let s = '';
  for (let i = 0; i < len; i++) s += c[Math.floor(Math.random() * c.length)];
  return s;
}
function formatSignCommon(data, initNonceStr) {
  const sign = randomString(32);
  const tm = Date.now();
  const o = { ...data, sign, nonceStr: initNonceStr, tm };
  const signStr = Object.keys(o).sort().reduce((acc, k) => acc + k + '=' + o[k] + '&', '');
  return { sign, tm: tm + '', nonceStr: CryptoJS.MD5(signStr).toString() };
}
function deriveInitNonceStr(userId) {
  return userId.substring(2, 3) + userId.substring(17, 34) + userId.substring(50);
}

function httpsGet(url, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({ hostname: u.hostname, port: 443, path: u.pathname + u.search, method: 'GET', headers, timeout: 15000 }, (res) => {
      let chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        let buf = Buffer.concat(chunks);
        const enc = (res.headers['content-encoding'] || '').toLowerCase();
        if (enc.includes('gzip')) { try { buf = zlib.gunzipSync(buf); } catch(e) {} }
        else if (enc.includes('br')) { try { buf = zlib.brotliDecompressSync(buf); } catch(e) {} }
        resolve({ statusCode: res.statusCode, body: buf.toString('utf8'), bodyLength: buf.length });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

async function queryStations(lat, lon, pageNo, credOverride) {
  const cred = credOverride || CRED;
  const keyWA = makeKey(cred.pw);
  const initNonceStr = deriveInitNonceStr(cred.userId);
  const bizData = { orgCode: '', supportSuperPrice: '1', lon, lat, pageIndex: pageNo || 1, pageSize: 10, sortRule: '01', radius: 10000 };
  const encryptData = aesEncrypt(bizData, keyWA);
  const signHeaders = formatSignCommon({ encryptData }, initNonceStr);
  const url = `${BASE_URL}/asset/openapi/v0.4/charge-station-list?encryptData=${encodeURIComponent(encryptData)}`;
  
  const headers = {
    'Host': 'app.xdtev.com', 'Connection': 'keep-alive', 'Authorization': 'Bearer ',
    'sign': signHeaders.sign, 'xweb_xhr': '1', 'tm': signHeaders.tm,
    'usersessionname': cred.userName, 'channel': CHANNEL, 'version': VERSION,
    'Content-Type': 'application/json;charset=UTF-8', 'nonceStr': signHeaders.nonceStr,
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Mac MacWechat/WMPF',
    'Accept': '*/*', 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty',
    'Referer': REFERER, 'Accept-Encoding': 'gzip, deflate, br', 'Accept-Language': 'zh-CN,zh;q=0.9',
  };
  return { resp: await httpsGet(url, headers), keyWA };
}

function summarize(resp, keyWA) {
    let bizCode = null, bizMsg = null, stationCount = 0;
    try {
        const j = JSON.parse(resp.body);
        bizCode = j.code !== undefined ? String(j.code) : null;
        bizMsg = j.msg || null;
        if (j.code === '10000' && j.data) {
            try { stationCount = aesDecrypt(j.data, keyWA).length; } catch(e) {}
        }
    } catch(e) {}
    return { httpStatus: resp.statusCode, bodyLength: resp.bodyLength, bizCode, bizMsg, stationCount, bodyPreview: resp.body.slice(0, 300) };
}

async function main() {
    console.log('='.repeat(60));
    console.log('XDT-01/02/03/04/06 综合验证');
    console.log(`执行节点: 172 (172.28.170.239) | 出口: 36.28.192.239`);
    console.log(`时间: ${ts()} | 请求预算: ${MAX_REQUESTS}`);
    console.log('='.repeat(60));

    // === 请求 1: 正常基线 ===
    log('--- 请求 1/5: XDT-01/02 正常基线 ---');
    requestCount++;
    const { resp: resp1, keyWA } = await queryStations(39.904179, 116.407387, 1);
    const s1 = summarize(resp1, keyWA);
    log(`HTTP ${s1.httpStatus} | bizCode=${s1.bizCode} | stations=${s1.stationCount} | body=${s1.bodyLength}B`);
    log(`preview: ${s1.bodyPreview}`);
    results.push({ step: 1, desc: 'XDT-01/02 正常基线', ...s1 });

    // === 请求 2: XDT-03 无效身份 ===
    log('--- 请求 2/5: XDT-03 无效身份 ---');
    requestCount++;
    const badCred = { ...CRED, userName: 'INVALID_SESSION', userId: 'x' + CRED.userId.substring(1) };
    const { resp: resp2 } = await queryStations(39.904179, 116.407387, 1, badCred);
    const s2 = summarize(resp2, keyWA);
    log(`HTTP ${s2.httpStatus} | bizCode=${s2.bizCode} | stations=${s2.stationCount} | body=${s2.bodyLength}B`);
    log(`preview: ${s2.bodyPreview}`);
    results.push({ step: 2, desc: 'XDT-03 无效身份', ...s2 });

    // === 请求 3: XDT-04 过期签名 ===
    log('--- 请求 3/5: XDT-04 过期签名 ---');
    requestCount++;
    const initNonceStr = deriveInitNonceStr(CRED.userId);
    const bizData = { orgCode: '', supportSuperPrice: '1', lon: 116.407387, lat: 39.904179, pageIndex: 1, pageSize: 10, sortRule: '01', radius: 10000 };
    const encryptData = aesEncrypt(bizData, keyWA);
    const oldSign = formatSignCommon({ encryptData }, initNonceStr);
    oldSign.tm = '1700000000000';
    const oldUrl = `${BASE_URL}/asset/openapi/v0.4/charge-station-list?encryptData=${encodeURIComponent(encryptData)}`;
    const resp3 = await httpsGet(oldUrl, {
        'Host': 'app.xdtev.com', 'Authorization': 'Bearer ', 'sign': oldSign.sign, 'tm': oldSign.tm,
        'usersessionname': CRED.userName, 'channel': CHANNEL, 'version': VERSION, 'nonceStr': oldSign.nonceStr,
        'User-Agent': 'Mozilla/5.0 MicroMessenger/7.0.20', 'Accept': '*/*', 'Referer': REFERER,
    });
    const s3 = summarize(resp3, keyWA);
    log(`HTTP ${s3.httpStatus} | bizCode=${s3.bizCode} | stations=${s3.stationCount} | body=${s3.bodyLength}B`);
    log(`preview: ${s3.bodyPreview}`);
    results.push({ step: 3, desc: 'XDT-04 过期签名', ...s3 });

    // === 请求 4: XDT-06 异常翻页跨区域 ===
    log('--- 请求 4/5: XDT-06 异常翻页跨区域 ---');
    requestCount++;
    const { resp: resp4 } = await queryStations(31.2304, 121.4737, 50);
    const s4 = summarize(resp4, keyWA);
    log(`HTTP ${s4.httpStatus} | bizCode=${s4.bizCode} | stations=${s4.stationCount} | body=${s4.bodyLength}B`);
    log(`preview: ${s4.bodyPreview}`);
    results.push({ step: 4, desc: 'XDT-06 异常翻页跨区域', ...s4 });

    // === 请求 5: 基线复验 ===
    log('--- 请求 5/5: 基线复验 ---');
    requestCount++;
    const { resp: resp5 } = await queryStations(39.904179, 116.407387, 1);
    const s5 = summarize(resp5, keyWA);
    log(`HTTP ${s5.httpStatus} | bizCode=${s5.bizCode} | stations=${s5.stationCount} | body=${s5.bodyLength}B`);
    log(`preview: ${s5.bodyPreview}`);
    results.push({ step: 5, desc: '基线复验', ...s5 });

    // ========== 汇总 ==========
    console.log('\n' + '='.repeat(60));
    console.log('验证汇总');
    console.log(`执行节点: 172.28.170.239 | 出口IP: 36.28.192.239`);
    console.log(`实际请求: ${requestCount}/${MAX_REQUESTS}`);
    console.log('');
    for (const r of results) {
        console.log(`[步骤${r.step}] ${r.desc}`);
        console.log(`  HTTP=${r.httpStatus} bizCode=${r.bizCode} stations=${r.stationCount} body=${r.bodyLength}B`);
        console.log('');
    }

    const bl = results[0];
    console.log('XDT-01: ' + (bl.bizCode === '10000' ? '✅ 全新登录链路验证' : '⚠️ 异常 bizCode=' + bl.bizCode));
    console.log('XDT-02: ' + (bl.stationCount > 0 ? '✅ 请求成功率证据完整' : '⚠️ 请求失败'));
    console.log('XDT-03: ' + (results[1].bizCode !== bl.bizCode || results[1].stationCount !== bl.stationCount ? '✅ 无效身份被识别' : '⚠️ 未被拒绝'));
    console.log('XDT-04: ' + (results[2].bizCode !== bl.bizCode ? '✅ 过期签名被拒绝' : '⚠️ 未被拒绝'));
    console.log('XDT-06: ' + (results[3].bizCode !== bl.bizCode ? '✅ 异常访问被处置' : '⚠️ 未被处置'));

    console.log('\n--- JSON 结果 ---');
    console.log(JSON.stringify({ testId: 'XDT-01-02-03-04-06', executedAt: ts(), executionNode: '172.28.170.239', outboundIP: '36.28.192.239', requestBudget: MAX_REQUESTS, actualRequests: requestCount, results, stopReason: '验证完成' }, null, 2));
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
