#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_BASE_URL = 'http://127.0.0.1:3000/api';
const DEFAULT_FILTER_HOSTS = 'xiaojukeji.com,didichuxing.com,didiglobal.com,energy.xiaojukeji.com';

const CITY_COORDS = {
    '西安': { lat: 34.3416, lng: 108.9398 },
    '上海': { lat: 31.2304, lng: 121.4737 },
    '北京': { lat: 39.9042, lng: 116.4074 },
    '广州': { lat: 23.1291, lng: 113.2644 },
    '深圳': { lat: 22.5431, lng: 114.0579 }
};

function parseArgs(argv) {
    const cityDefault = '西安';
    const coordDefault = CITY_COORDS[cityDefault];
    const options = {
        baseUrl: process.env.METHOD1_BASE_URL || DEFAULT_BASE_URL,
        city: cityDefault,
        lat: coordDefault.lat,
        lng: coordDefault.lng,
        platform: 'didi-charging',
        runId: `method1-virtual-${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}`,
        listenHost: '0.0.0.0',
        listenPort: 8899,
        filterHosts: DEFAULT_FILTER_HOSTS,
        upstreamProxy: '',
        proxyServices: process.env.CAPTURE_PROXY_SERVICES || 'Wi-Fi',
        refreshModes: ['open', 'command-r', 'adaptive'],
        openWaitMs: 5000,
        settleMs: 2500,
        keyWaitMs: 5000,
        adaptiveScrolls: 1,
        probeOnly: false,
        targetDistinct: 100,
        pagesPerLandmark: 40,
        maxCaptures: 180,
        noInsertLimit: 10,
        batchScript: path.join(ROOT, 'scripts/method1-desktop-city-batch.js'),
        logDir: path.join(ROOT, 'logs')
    };

    for (let i = 2; i < argv.length; i += 1) {
        const arg = argv[i];
        const next = argv[i + 1];
        if (arg === '--base-url') {
            options.baseUrl = next; i += 1;
        } else if (arg === '--city') {
            options.city = next; i += 1;
            if (CITY_COORDS[options.city]) {
                options.lat = CITY_COORDS[options.city].lat;
                options.lng = CITY_COORDS[options.city].lng;
            }
        } else if (arg === '--lat') {
            options.lat = Number(next); i += 1;
        } else if (arg === '--lng') {
            options.lng = Number(next); i += 1;
        } else if (arg === '--platform') {
            options.platform = next; i += 1;
        } else if (arg === '--run-id') {
            options.runId = String(next || '').trim() || options.runId; i += 1;
        } else if (arg === '--listen-port') {
            options.listenPort = Math.max(1, Number(next) || options.listenPort); i += 1;
        } else if (arg === '--listen-host') {
            options.listenHost = next; i += 1;
        } else if (arg === '--filter-hosts') {
            options.filterHosts = next; i += 1;
        } else if (arg === '--upstream-proxy') {
            options.upstreamProxy = next; i += 1;
        } else if (arg === '--proxy-services') {
            options.proxyServices = next; i += 1;
        } else if (arg === '--refresh') {
            options.refreshModes = splitList(next); i += 1;
        } else if (arg === '--open-wait-ms') {
            options.openWaitMs = Math.max(0, Number(next) || options.openWaitMs); i += 1;
        } else if (arg === '--settle-ms') {
            options.settleMs = Math.max(0, Number(next) || options.settleMs); i += 1;
        } else if (arg === '--key-wait-ms') {
            options.keyWaitMs = Math.max(0, Number(next) || options.keyWaitMs); i += 1;
        } else if (arg === '--adaptive-scrolls') {
            options.adaptiveScrolls = Math.max(0, Number(next) || 0); i += 1;
        } else if (arg === '--probe-only') {
            options.probeOnly = true;
        } else if (arg === '--target-distinct') {
            options.targetDistinct = Math.max(1, Number(next) || options.targetDistinct); i += 1;
        } else if (arg === '--pages-per-landmark') {
            options.pagesPerLandmark = Math.max(1, Number(next) || options.pagesPerLandmark); i += 1;
        } else if (arg === '--max-captures') {
            options.maxCaptures = Math.max(1, Number(next) || options.maxCaptures); i += 1;
        } else if (arg === '--no-insert-limit') {
            options.noInsertLimit = Math.max(1, Number(next) || options.noInsertLimit); i += 1;
        } else if (arg === '--batch-script') {
            options.batchScript = path.resolve(next); i += 1;
        } else if (arg === '--log-dir') {
            options.logDir = path.resolve(next); i += 1;
        } else if (arg === '-h' || arg === '--help') {
            printHelp();
            process.exit(0);
        } else {
            throw new Error(`Unknown option: ${arg}`);
        }
    }

    if (!Number.isFinite(options.lat) || !Number.isFinite(options.lng)) {
        throw new Error('valid --lat and --lng are required');
    }
    options.baseUrl = String(options.baseUrl || '').replace(/\/+$/, '');
    if (!options.baseUrl.endsWith('/api')) {
        options.baseUrl += '/api';
    }
    options.proxyServices = splitList(options.proxyServices);
    return options;
}

function splitList(value) {
    return String(value || '')
        .split(/[,，;；|\s]+/)
        .map(item => item.trim())
        .filter(Boolean);
}

function printHelp() {
    console.log(`Usage: node scripts/method1-virtual-location-capture.js [options]

Starts request-level virtual location, refreshes desktop WeChat Method1, then
optionally runs the existing OCR current-page batch.

Options:
  --city NAME                 Default: 西安
  --lat N --lng N             Override coordinates
  --probe-only                Only refresh/observe/analyze HAR; do not OCR batch
  --refresh LIST              open,command-r,adaptive; default all three
  --proxy-services LIST       macOS network services; default Wi-Fi
  --upstream-proxy HOST:PORT  Optional mitmproxy upstream
  --target-distinct N         Default: 100 for OCR batch
  --run-id ID                 Default: method1-virtual-<timestamp>
`);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function requestJson(baseUrl, apiPath, body, timeoutMs = 90000, allowHttpError = false) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(`${baseUrl}${apiPath}`, {
            method: body ? 'POST' : 'GET',
            headers: body ? { 'content-type': 'application/json' } : {},
            body: body ? JSON.stringify(body) : undefined,
            signal: controller.signal
        });
        const text = await response.text();
        let parsed = {};
        try {
            parsed = text ? JSON.parse(text) : {};
        } catch (error) {
            throw new Error(`Invalid JSON from ${apiPath}: ${text.slice(0, 300)}`);
        }
        if (!response.ok && !allowHttpError) {
            throw new Error(`HTTP ${response.status} ${apiPath}: ${parsed.error || parsed.message || text.slice(0, 300)}`);
        }
        return { httpStatus: response.status, ...parsed };
    } finally {
        clearTimeout(timer);
    }
}

function appendLog(stream, event) {
    const row = { at: new Date().toISOString(), ...event };
    stream.write(`${JSON.stringify(row)}\n`);
    console.log(JSON.stringify(row));
}

function summarizeObservation(result = {}) {
    const capture = result.capture || {};
    const pageState = capture.pageState || {};
    const textLines = Array.isArray(capture.textLines) ? capture.textLines : [];
    return {
        success: Boolean(result.success),
        reason: result.reason || '',
        state: pageState.state || '',
        stationCount: Number(pageState.stationCount || 0),
        textSample: textLines.slice(0, 18),
        screenshotPath: capture.screenshotPath || ''
    };
}

async function startRecorder(options, log) {
    const body = {
        label: `${options.runId}-virtual-location`,
        scope: 'method1-virtual-location',
        platforms: [options.platform],
        cities: [options.city],
        targets: [options.city],
        listenHost: options.listenHost,
        listenPort: options.listenPort,
        filterHosts: options.filterHosts,
        overrideCity: options.city,
        overrideLat: options.lat,
        overrideLng: options.lng,
        manageSystemProxy: true,
        proxyServices: options.proxyServices
    };
    if (options.upstreamProxy) {
        body.upstreamProxy = options.upstreamProxy;
    }
    const response = await requestJson(options.baseUrl, '/capture-recorder/start', body, 30000);
    const session = response.data || response;
    appendLog(log, {
        event: 'recorder_started',
        success: response.success !== false,
        id: session.id || '',
        reused: Boolean(session.reused),
        listenPort: session.listenPort,
        locationOverride: session.locationOverride || null,
        upstreamProxy: session.upstreamProxy || '',
        systemProxy: session.systemProxy || null
    });
    if (session.reused) {
        throw new Error(`capture recorder already running: ${session.id}`);
    }
    return session;
}

async function stopRecorder(options, log, started) {
    if (!started) return null;
    const response = await requestJson(options.baseUrl, '/capture-recorder/stop', {}, 30000, true);
    const session = response.data || response;
    appendLog(log, {
        event: 'recorder_stopped',
        success: response.success !== false,
        id: session.id || '',
        status: session.status || '',
        harPath: session.harPath || '',
        logPath: session.logPath || '',
        systemProxy: session.systemProxy || null
    });
    return session;
}

async function analyzeHar(options, harPath, log) {
    if (!harPath) return null;
    const response = await requestJson(options.baseUrl, '/method2/analyze-har', {
        harPath,
        writeToDb: false
    }, 60000, true);
    appendLog(log, {
        event: 'har_analyzed',
        success: Boolean(response.success),
        httpStatus: response.httpStatus,
        reason: response.reason || '',
        sessionId: response.sessionId || '',
        summary: response.summary || null,
        importSummary: response.importSummary || null
    });
    return response;
}

async function refreshMiniProgram(options, log) {
    for (const mode of options.refreshModes) {
        if (mode === 'open') {
            const result = await requestJson(options.baseUrl, '/method1/open-miniapp', {
                platform: options.platform,
                waitMs: options.openWaitMs
            }, Math.max(45000, options.openWaitMs + 20000), true);
            appendLog(log, {
                event: 'refresh_open',
                success: Boolean(result.success),
                available: Boolean(result.available),
                reason: result.reason || ''
            });
        } else if (mode === 'command-r') {
            const result = await requestJson(options.baseUrl, '/method1/actions/key', {
                platform: options.platform,
                keyCode: 15,
                modifiers: ['command'],
                waitMs: options.keyWaitMs
            }, Math.max(20000, options.keyWaitMs + 10000), true);
            appendLog(log, {
                event: 'refresh_command_r',
                success: Boolean(result.success),
                reason: result.reason || '',
                error: result.error || ''
            });
        } else if (mode === 'adaptive') {
            const result = await requestJson(options.baseUrl, '/method1/actions/run-adaptive', {
                platform: options.platform,
                city: options.city,
                maxSteps: 10,
                maxScrolls: options.adaptiveScrolls,
                maxDurationSeconds: 120,
                maxDismissActions: 5,
                afterScrollWaitMs: 3000
            }, 160000, true);
            appendLog(log, {
                event: 'refresh_adaptive',
                success: Boolean(result.success),
                reason: result.reason || '',
                status: result.status || '',
                summary: result.summary || null
            });
        } else if (mode) {
            appendLog(log, { event: 'refresh_skipped', mode, reason: 'unsupported_refresh_mode' });
        }
        await sleep(options.settleMs);
    }
}

async function observe(options, log) {
    const response = await requestJson(options.baseUrl, '/method1/actions/observe', {
        platform: options.platform
    }, 60000, true);
    const summary = summarizeObservation(response);
    appendLog(log, { event: 'observe_after_virtual_location', ...summary });
    return summary;
}

function runOcrBatch(options, log) {
    const args = [
        options.batchScript,
        '--base-url', options.baseUrl,
        '--cities', options.city,
        '--target-total', String(options.targetDistinct),
        '--target-per-city', String(options.targetDistinct),
        '--pages-per-landmark', String(options.pagesPerLandmark),
        '--max-captures-per-city', String(options.maxCaptures),
        '--no-insert-limit', String(options.noInsertLimit),
        '--current-page',
        '--run-id', options.runId
    ];
    appendLog(log, { event: 'ocr_batch_started', command: ['node', ...args].join(' ') });
    const result = spawnSync('node', args, {
        cwd: ROOT,
        stdio: 'inherit',
        encoding: 'utf8'
    });
    appendLog(log, {
        event: 'ocr_batch_finished',
        status: result.status,
        signal: result.signal || '',
        error: result.error ? result.error.message : ''
    });
    if (result.status !== 0) {
        throw new Error(`OCR batch failed with status ${result.status}`);
    }
}

async function main() {
    const options = parseArgs(process.argv);
    fs.mkdirSync(options.logDir, { recursive: true });
    const logPath = path.join(options.logDir, `${options.runId}-virtual-location.jsonl`);
    const log = fs.createWriteStream(logPath, { flags: 'a' });
    let recorderStarted = false;
    let stoppedSession = null;

    appendLog(log, {
        event: 'run_start',
        runId: options.runId,
        baseUrl: options.baseUrl,
        city: options.city,
        lat: options.lat,
        lng: options.lng,
        proxyServices: options.proxyServices,
        refreshModes: options.refreshModes,
        probeOnly: options.probeOnly,
        targetDistinct: options.targetDistinct
    });

    try {
        await startRecorder(options, log);
        recorderStarted = true;
        await sleep(options.settleMs);
        await refreshMiniProgram(options, log);
        const observation = await observe(options, log);
        if (options.probeOnly) {
            appendLog(log, { event: 'probe_done', observation });
        } else {
            runOcrBatch(options, log);
        }
    } finally {
        stoppedSession = await stopRecorder(options, log, recorderStarted);
        if (stoppedSession?.harPath) {
            await sleep(2000);
        }
        await analyzeHar(options, stoppedSession?.harPath || '', log);
        appendLog(log, { event: 'run_finish', runId: options.runId, logPath });
        log.end();
    }
}

main().catch(error => {
    console.error(error.stack || error.message);
    process.exit(1);
});
