#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawnSync } = require('child_process');

const API_BASE = (process.env.API_BASE || 'http://127.0.0.1:50080/api').replace(/\/$/, '');
const PROJECT_ROOT = path.join(__dirname, '..');
const CORPUS_PATH = process.env.DIDI_SIGNATURE_CORPUS_PATH
    || path.join(PROJECT_ROOT, 'data/didi-signature-corpus.json');

const DEFAULT_TARGET = {
    platform: process.env.CHAIN_PLATFORM || 'didi-charging',
    city: process.env.CHAIN_CITY || '杭州',
    lat: numberEnv('CHAIN_LAT', 30.2741),
    lng: numberEnv('CHAIN_LNG', 120.1551),
    radiusKm: numberEnv('CHAIN_RADIUS_KM', 20),
    maxPages: numberEnv('CHAIN_MAX_PAGES', 1),
    maxRequestCount: numberEnv('CHAIN_MAX_REQUEST_COUNT', 1),
    maxQps: numberEnv('CHAIN_MAX_QPS', 1),
};

const ITERATIONS = Math.max(1, numberEnv('CHAIN_ITERATIONS', 1));
const INTERVAL_MS = Math.max(0, numberEnv('CHAIN_INTERVAL_MS', 3000));
const CONTINUOUS = process.env.CHAIN_CONTINUOUS === '1';
const RUN_METHOD1 = process.env.CHAIN_SKIP_METHOD1 !== '1';
const RUN_METHOD2 = process.env.CHAIN_SKIP_METHOD2 !== '1';
const RUN_METHOD3 = process.env.CHAIN_SKIP_METHOD3 !== '1';
const METHOD2_SYNTHETIC = process.env.METHOD2_SYNTHETIC !== '0';
const METHOD2_ATTEMPTS = Math.max(1, numberEnv('METHOD2_ATTEMPTS', 2));
const METHOD2_AFTER_SYNTHETIC_WAIT_MS = Math.max(0, numberEnv('METHOD2_AFTER_SYNTHETIC_WAIT_MS', 3000));

function numberEnv(name, fallback) {
    const value = Number(process.env[name]);
    return Number.isFinite(value) ? value : fallback;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function api(pathname, options = {}) {
    const controller = new AbortController();
    const timeoutMs = options.timeoutMs || 90000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const headers = { ...(options.headers || {}) };
        if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
        const res = await fetch(`${API_BASE}${pathname}`, {
            method: options.method || 'GET',
            headers,
            body: options.body ? JSON.stringify(options.body) : undefined,
            signal: controller.signal,
        });
        const raw = await res.text();
        let body = raw;
        try { body = JSON.parse(raw); } catch {}
        return { ok: res.ok, status: res.status, body };
    } catch (err) {
        return {
            ok: false,
            status: 0,
            body: { success: false, reason: err.name === 'AbortError' ? 'request_timeout' : 'request_failed', message: err.message },
        };
    } finally {
        clearTimeout(timer);
    }
}

function loadCorpusEntries() {
    try {
        const raw = JSON.parse(fs.readFileSync(CORPUS_PATH, 'utf8'));
        const entries = Array.isArray(raw) ? raw : (raw.entries || []);
        return entries.filter(entry => entry && entry.active !== false);
    } catch {
        return [];
    }
}

function pickListSample(target) {
    const entries = loadCorpusEntries();
    const platform = normalizePlatform(target.platform);
    const listEntries = entries.filter(entry => {
        return normalizePlatform(entry.platform) === platform
            && String(entry.scope || 'list') === 'list'
            && /stationList/i.test(String(entry.baseUrl || ''));
    });
    if (listEntries.length === 0) return null;
    const withDistance = listEntries.map(entry => ({
        entry,
        distanceKm: distanceKm(target.lat, target.lng, Number(entry.lat || entry.targetLat), Number(entry.lng || entry.targetLng)),
    })).filter(item => Number.isFinite(item.distanceKm));
    const inRadius = withDistance
        .filter(item => item.distanceKm <= Number(target.radiusKm || 20))
        .sort((a, b) => a.distanceKm - b.distanceKm);
    return (inRadius[0] || withDistance.sort((a, b) => a.distanceKm - b.distanceKm)[0] || {}).entry || listEntries[0];
}

function normalizePlatform(value) {
    const normalized = String(value || '').trim().toLowerCase().replace(/_/g, '-');
    if (['didi', 'didicharging', 'didi-charging', '滴滴充电'].includes(normalized)) return 'didi-charging';
    return normalized;
}

function distanceKm(lat1, lng1, lat2, lng2) {
    if (![lat1, lng1, lat2, lng2].every(Number.isFinite)) return Infinity;
    const rad = deg => deg * Math.PI / 180;
    const earth = 6371;
    const dLat = rad(lat2 - lat1);
    const dLng = rad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2
        + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
    return earth * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function redacted(value) {
    if (Array.isArray(value)) return value.map(redacted);
    if (!value || typeof value !== 'object') return value;
    const out = {};
    for (const [key, raw] of Object.entries(value)) {
        if (/wsgsig|token|ticket|openid|authorization|cookie|sid|signature|password|secret/i.test(key)) {
            out[key] = '***';
        } else if (typeof raw === 'object') {
            out[key] = redacted(raw);
        } else {
            out[key] = raw;
        }
    }
    return out;
}

function summarizeApiResult(result) {
    const body = result.body || {};
    const method1Summary = body.before || body.after ? {
        before: summarizeOcrStep(body.before),
        after: summarizeOcrStep(body.after),
    } : undefined;
    return redacted({
        httpStatus: result.status,
        success: body.success,
        available: body.available,
        reason: body.reason || body.status,
        message: body.message,
        checks: body.checks,
        summary: body.summary,
        result: body.result ? {
            success: body.result.success,
            totalAttempts: body.result.totalAttempts,
            successCount: body.result.successCount,
            status: body.result.status,
            reason: body.result.reason,
            firstResult: Array.isArray(body.result.results) ? summarizeMethod3Attempt(body.result.results[0]) : undefined,
        } : undefined,
        method1: method1Summary,
    });
}

function summarizeOcrStep(step) {
    if (!step || typeof step !== 'object') return step;
    return {
        status: step.status,
        reason: step.reason,
        screenshotPath: step.screenshotPath,
        pageState: step.pageState,
        ocrCount: step.ocrCount,
        textPreview: String(step.text || '').slice(0, 240),
    };
}

function summarizeMethod3Attempt(item = {}) {
    const responseBody = item.responseBody || {};
    const stationGroups = Array.isArray(responseBody.data?.stationList) ? responseBody.data.stationList : [];
    const stationCount = stationGroups.reduce((total, group) => {
        return total + (Array.isArray(group.stationList) ? group.stationList.length : 0);
    }, 0);
    return {
        success: item.success,
        httpStatus: item.httpStatus,
        businessCode: item.businessCode ?? responseBody.code,
        reason: item.reason,
        coordinateStrategy: item.coordinateStrategy,
        effectiveCoordinate: item.effectiveCoordinate,
        dataSize: item.dataSize,
        stationCount: stationCount || undefined,
        traceId: responseBody.traceId,
    };
}

async function analyzeFailure(step, request, response, context = {}) {
    const payload = {
        source: 'chain-smoke-test',
        request: redacted(request),
        response: summarizeApiResult(response),
        error: {
            reason: response.body?.reason || response.body?.status || `http_${response.status}`,
            message: response.body?.message || `${step} failed`,
        },
        context: {
            step,
            target: redacted(DEFAULT_TARGET),
            constraints: {
                noFakeSuccess: true,
                noSignatureBypass: true,
                noAuthBypass: true,
                signedCoordinateMayBeBoundToWsgsig: true,
                preferPreserveSignedSampleWithinRequestedRadius: true,
                refreshMaterialOnlyFromMethod2HarOrUserAuthorizedHar: true,
            },
            ...redacted(context),
        },
    };
    return api('/ai-agent/analyze-failure', { method: 'POST', body: payload, timeoutMs: 120000 });
}

async function runMethod1() {
    const request = { platform: DEFAULT_TARGET.platform, maxScrolls: 1 };
    const response = await api('/method1/run-basic-check', { method: 'POST', body: request, timeoutMs: 60000 });
    const body = response.body || {};
    const pass = response.ok && body.success === true && body.available !== false;
    return { pass, request, response, summary: summarizeApiResult(response) };
}

async function runMethod2() {
    const attempts = [];
    for (let attempt = 1; attempt <= METHOD2_ATTEMPTS; attempt++) {
        const result = await runMethod2Once(attempt);
        attempts.push(result);
        if (result.pass) return { ...result, attempts: attempts.map(publicStepResult) };
        await sleep(1000);
    }
    const last = attempts[attempts.length - 1] || {};
    return { ...last, attempts: attempts.map(publicStepResult) };
}

async function runMethod2Once(attempt) {
    const status = await api('/method2/status', { timeoutMs: 15000 });
    if (!status.ok || status.body?.available === false) {
        return { pass: false, attempt, stage: 'status', request: {}, response: status, summary: summarizeApiResult(status) };
    }

    const startRequest = { label: `chain-smoke-${Date.now()}-${attempt}` };
    const start = await api('/method2/start-capture', { method: 'POST', body: startRequest, timeoutMs: 20000 });
    if (!start.ok || start.body?.success !== true) {
        return { pass: false, attempt, stage: 'start-capture', request: startRequest, response: start, summary: summarizeApiResult(start) };
    }

    let synthetic = null;
    if (METHOD2_SYNTHETIC) {
        const sample = pickListSample(DEFAULT_TARGET);
        const port = start.body.listenPort || 8899;
        const portReady = await waitForTcpPort('127.0.0.1', port, 8000);
        synthetic = sample && portReady
            ? sendSyntheticDidiRequest(port, sample)
            : { success: false, reason: sample ? 'proxy_port_not_ready' : 'corpus_sample_missing', port };
        if (!portReady) await sleep(1200);
        await sleep(METHOD2_AFTER_SYNTHETIC_WAIT_MS);
    }

    const stop = await api('/method2/stop-and-analyze', { method: 'POST', body: {}, timeoutMs: 45000 });
    const targetRequests = Number(stop.body?.summary?.targetRequests || 0);
    const pass = stop.ok && stop.body?.success === true && targetRequests > 0;
    return {
        pass,
        attempt,
        stage: pass ? 'done' : 'stop-and-analyze',
        request: { start: startRequest, synthetic: synthetic ? redacted({ ...synthetic, body: undefined }) : null },
        response: stop,
        status: status.body,
        start: redacted(start.body),
        synthetic: redacted(synthetic),
        summary: summarizeApiResult(stop),
    };
}

function waitForTcpPort(host, port, timeoutMs) {
    const startedAt = Date.now();
    return new Promise(resolve => {
        const tryConnect = () => {
            const socket = net.createConnection({ host, port });
            socket.setTimeout(800);
            socket.once('connect', () => {
                socket.destroy();
                resolve(true);
            });
            const retry = () => {
                socket.destroy();
                if (Date.now() - startedAt >= timeoutMs) return resolve(false);
                setTimeout(tryConnect, 250);
            };
            socket.once('error', retry);
            socket.once('timeout', retry);
        };
        tryConnect();
    });
}

function sendSyntheticDidiRequest(proxyPort, sample) {
    const baseUrl = sample.baseUrl || 'https://energy.xiaojukeji.com/station-api/homepage/stationList';
    const url = new URL(baseUrl);
    for (const [key, value] of Object.entries(sample.queryParams || {})) {
        url.searchParams.set(key, String(value));
    }
    const body = JSON.stringify(sample.bodyParams || {});
    const headers = sample.headers || {};
    const args = [
        '--noproxy', '',
        '-x', `http://127.0.0.1:${proxyPort}`,
        '-k',
        '--max-time', '25',
        '-sS',
        '-o', '/tmp/data-test-method2-synthetic.out',
        '-w', '%{http_code}',
        '-X', String(sample.method || 'POST').toUpperCase(),
    ];
    for (const [key, value] of Object.entries(headers)) {
        if (/^(content-length|host)$/i.test(key)) continue;
        args.push('-H', `${key}: ${value}`);
    }
    if (!headers['content-type'] && !headers['Content-Type']) {
        args.push('-H', 'content-type: application/json');
    }
    args.push('--data-binary', body, String(url));
    const result = spawnSync('curl', args, { encoding: 'utf8', timeout: 30000 });
    return {
        success: result.status === 0,
        exitCode: result.status,
        httpStatus: Number(String(result.stdout || '').trim()) || 0,
        stderr: result.stderr ? result.stderr.trim().slice(0, 300) : '',
        sample: {
            city: sample.city,
            lat: sample.lat,
            lng: sample.lng,
            baseUrl: sample.baseUrl,
            queryKeys: Object.keys(sample.queryParams || {}),
            bodyKeys: Object.keys(sample.bodyParams || {}),
        },
    };
}

async function runMethod3() {
    const attempts = [];
    let target = { ...DEFAULT_TARGET };
    for (let i = 0; i < 2; i++) {
        const preflight = await api('/method3/preflight', { method: 'POST', body: target, timeoutMs: 20000 });
        const run = await api('/method3/run-basic-check', { method: 'POST', body: target, timeoutMs: 90000 });
        const pass = run.ok && run.body?.success === true && run.body?.result?.success === true;
        attempts.push({
            pass,
            target,
            preflight: summarizeApiResult(preflight),
            run: summarizeApiResult(run),
            response: run,
        });
        if (pass) {
            return { pass: true, attempts, request: target, response: run, summary: summarizeApiResult(run) };
        }
        const next = nextMethod3Target(target, run.body || preflight.body || {});
        if (!next || JSON.stringify(next) === JSON.stringify(target)) break;
        target = next;
    }
    const last = attempts[attempts.length - 1];
    return {
        pass: false,
        attempts,
        request: last?.target || target,
        response: last?.response || { status: 0, body: { reason: 'method3_not_attempted' } },
        summary: last?.run || {},
    };
}

function nextMethod3Target(target, body) {
    const reason = body.reason || body.status || body.result?.reason;
    if (['signed_template_target_mismatch', 'no_corpus_candidate', 'signature_corpus_missing'].includes(reason)) {
        const radiusKm = Math.min(50, Math.max(Number(target.radiusKm || 0), 20, Number(target.maxDistanceKm || 0), 30));
        return { ...target, radiusKm, maxDistanceKm: radiusKm };
    }
    return null;
}

async function runIteration(index) {
    const startedAt = new Date().toISOString();
    const result = {
        iteration: index,
        startedAt,
        apiBase: API_BASE,
        target: DEFAULT_TARGET,
        aiAgent: null,
        method1: { pass: true, skipped: !RUN_METHOD1 },
        method2: { pass: true, skipped: !RUN_METHOD2 },
        method3: { pass: true, skipped: !RUN_METHOD3 },
        chain: { pass: false, reason: 'not_evaluated' },
        agentAnalyses: [],
    };

    const aiStatus = await api('/ai-agent/status', { timeoutMs: 15000 });
    result.aiAgent = summarizeApiResult(aiStatus);

    if (RUN_METHOD1) {
        result.method1 = await runMethod1();
        if (!result.method1.pass) {
            const analysis = await analyzeFailure('method1', result.method1.request, result.method1.response, {
                expected: 'desktop WeChat mini-program window, screenshot, OCR, and one scroll',
            });
            result.agentAnalyses.push({ step: 'method1', result: summarizeApiResult(analysis), id: analysis.body?.analysisId });
        }
        result.method1 = publicStepResult(result.method1);
    }

    if (RUN_METHOD2) {
        result.method2 = await runMethod2();
        if (!result.method2.pass) {
            const analysis = await analyzeFailure('method2', result.method2.request, result.method2.response, {
                expected: 'mitmdump captures at least one target Didi request and HAR parser returns targetRequests > 0',
                method2Stage: result.method2.stage,
                synthetic: result.method2.synthetic,
            });
            result.agentAnalyses.push({ step: 'method2', result: summarizeApiResult(analysis), id: analysis.body?.analysisId });
        }
        result.method2 = publicStepResult(result.method2);
    }

    if (RUN_METHOD3) {
        result.method3 = await runMethod3();
        if (!result.method3.pass) {
            const analysis = await analyzeFailure('method3', result.method3.request, result.method3.response, {
                expected: 'direct backend request succeeds with signed material that matches requested radius',
                attempts: result.method3.attempts,
                signedCoordinateGuidance: 'If wsgsig is bound to lat/lng, preserve a signed sample inside radius or refresh material from Method2 HAR.',
            });
            result.agentAnalyses.push({ step: 'method3', result: summarizeApiResult(analysis), id: analysis.body?.analysisId });
        }
        result.method3 = publicStepResult(result.method3);
    }

    const passes = [result.method1, result.method2, result.method3]
        .filter(item => !item.skipped)
        .map(item => item.pass === true);
    result.chain = passes.every(Boolean)
        ? { pass: true, reason: 'all_methods_ready', evidence: ['method1_desktop_ocr_scroll', 'method2_har_target_request', 'method3_direct_signed_request'] }
        : { pass: false, reason: 'one_or_more_methods_failed' };
    result.finishedAt = new Date().toISOString();
    return redacted(result);
}

function publicStepResult(step = {}) {
    const copy = { ...step };
    delete copy.response;
    if (Array.isArray(copy.attempts)) {
        copy.attempts = copy.attempts.map(attempt => {
            const item = { ...attempt };
            delete item.response;
            return item;
        });
    }
    return copy;
}

(async () => {
    const all = [];
    let index = 1;
    do {
        const result = await runIteration(index);
        all.push(result);
        console.log(JSON.stringify(result, null, 2));
        if (result.chain.pass && !CONTINUOUS) break;
        index += 1;
        if (!CONTINUOUS && index > ITERATIONS) break;
        if (INTERVAL_MS > 0) await sleep(INTERVAL_MS);
    } while (CONTINUOUS || index <= ITERATIONS);

    const latest = all[all.length - 1];
    process.exitCode = latest?.chain?.pass ? 0 : 1;
})().catch(err => {
    console.error(JSON.stringify({ success: false, reason: 'chain_script_failed', message: err.message }, null, 2));
    process.exit(1);
});
