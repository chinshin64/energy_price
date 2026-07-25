#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_BASE_URL = 'http://127.0.0.1:3000/api';

const LANDMARKS = {
    上海: ['上海虹桥站', '上海人民广场', '上海静安寺', '上海陆家嘴', '上海徐家汇', '上海五角场', '上海莘庄', '上海南站', '上海中山公园', '上海世纪公园', '上海张江高科', '上海漕河泾', '上海大宁国际', '上海宝山万达', '上海嘉定新城', '上海松江大学城'],
    北京: ['北京国贸', '北京三里屯', '北京朝阳门', '北京西单', '北京中关村', '北京望京SOHO', '北京朝阳大悦城', '北京四惠', '北京五道口', '北京亦庄', '北京丰台科技园', '北京上地', '北京奥林匹克公园', '北京大兴机场', '北京通州万达', '北京回龙观'],
    广州: ['广州珠江新城', '广州体育西路', '广州天河城', '广州正佳广场', '广州广州塔', '广州琶洲', '广州北京路', '广州东站', '广州白云新城', '广州番禺广场', '广州大学城', '广州黄埔科学城', '广州金融城', '广州客村', '广州嘉禾望岗', '广州花城广场'],
    深圳: ['深圳福田中心', '深圳会展中心', '深圳车公庙', '深圳华强北', '深圳南山科技园', '深圳后海', '深圳宝安中心', '深圳北站', '深圳前海', '深圳龙华壹方天地', '深圳坂田', '深圳龙岗中心城', '深圳罗湖万象城', '深圳蛇口', '深圳光明城', '深圳坪山高铁站'],
    西安: ['西安钟楼', '西安北站', '西安火车站', '西安小寨', '西安大雁塔', '西安曲江新区', '西安高新区', '西安软件园', '西安行政中心', '西安浐灞', '西安大明宫', '西安纺织城', '西安长安大学城', '西安西咸新区', '西安咸阳国际机场', '西安赛格国际购物中心', '西安大悦城', '西安丈八'],
    青岛: ['青岛五四广场', '青岛万象城', '青岛台东步行街', '青岛李村', '青岛金狮广场', '青岛奥帆中心'],
    武汉: ['武汉江汉路', '武汉国际广场', '武汉天地', '武汉楚河汉街', '武汉光谷广场', '武汉王家湾']
};

function parseArgs(argv) {
    const options = {
        baseUrl: process.env.METHOD1_BASE_URL || DEFAULT_BASE_URL,
        cities: ['上海', '北京', '广州', '深圳'],
        targetTotal: 400,
        targetPerCity: null,
        maxCapturesPerCity: 180,
        pagesPerLandmark: 28,
        noInsertLimit: 10,
        adaptiveEvery: 8,
        fastScroll: false,
        waitLoginMs: 0,
        loginPollMs: 5000,
        currentPage: false,
        cityOnly: false,
        platform: 'didi-charging',
        runId: `method1-desktop-${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}`,
        logDir: path.join(ROOT, 'logs')
    };

    for (let i = 2; i < argv.length; i += 1) {
        const arg = argv[i];
        const next = argv[i + 1];
        if (arg === '--base-url') {
            options.baseUrl = next;
            i += 1;
        } else if (arg === '--cities') {
            options.cities = String(next || '').split(/[,，\s]+/).filter(Boolean);
            i += 1;
        } else if (arg === '--target-total') {
            options.targetTotal = Math.max(1, Number(next) || options.targetTotal);
            i += 1;
        } else if (arg === '--target-per-city') {
            options.targetPerCity = Math.max(1, Number(next) || 0);
            i += 1;
        } else if (arg === '--max-captures-per-city') {
            options.maxCapturesPerCity = Math.max(1, Number(next) || options.maxCapturesPerCity);
            i += 1;
        } else if (arg === '--pages-per-landmark') {
            options.pagesPerLandmark = Math.max(1, Number(next) || options.pagesPerLandmark);
            i += 1;
        } else if (arg === '--no-insert-limit') {
            options.noInsertLimit = Math.max(1, Number(next) || options.noInsertLimit);
            i += 1;
        } else if (arg === '--adaptive-every') {
            options.adaptiveEvery = Math.max(0, Number(next) || 0);
            i += 1;
        } else if (arg === '--fast-scroll') {
            options.fastScroll = true;
        } else if (arg === '--wait-login-ms') {
            options.waitLoginMs = Math.max(0, Number(next) || 0);
            i += 1;
        } else if (arg === '--login-poll-ms') {
            options.loginPollMs = Math.max(1000, Number(next) || options.loginPollMs);
            i += 1;
        } else if (arg === '--current-page') {
            options.currentPage = true;
        } else if (arg === '--city-only') {
            options.cityOnly = true;
        } else if (arg === '--run-id') {
            options.runId = String(next || '').trim() || options.runId;
            i += 1;
        } else if (arg === '-h' || arg === '--help') {
            printHelp();
            process.exit(0);
        } else {
            throw new Error(`Unknown option: ${arg}`);
        }
    }

    options.baseUrl = String(options.baseUrl || '').replace(/\/+$/, '');
    if (options.baseUrl.endsWith('/api')) {
        return options;
    }
    options.baseUrl += '/api';
    return options;
}

function printHelp() {
    console.log(`Usage: node scripts/method1-desktop-city-batch.js [options]

Options:
  --base-url URL                 Default: ${DEFAULT_BASE_URL}
  --cities "上海 北京 广州 深圳"    Four desktop WeChat collection cities
  --target-total N               Default: 400 distinct OCR station names total
  --target-per-city N            Optional distinct OCR station names per city
  --pages-per-landmark N         Default: 28 capture/scroll rounds per landmark
  --max-captures-per-city N      Default: 180
  --no-insert-limit N            Default: 10 consecutive zero-insert captures
  --adaptive-every N             Default: 8 pages; 0 disables periodic adaptive recovery
  --fast-scroll                  Use raw scroll action before adaptive scroll
  --wait-login-ms N              Wait up to N ms when Didi login blocks more results
  --login-poll-ms N              Default: 5000 ms while waiting for login clearance
  --current-page                 Capture the currently visible mini-program page; skip city/landmark switching
  --city-only                    Switch by city hot-list only; do not search landmarks
  --run-id ID                    Default: method1-desktop-<timestamp>
`);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function requestJson(baseUrl, apiPath, body, timeoutMs = 90000) {
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
        if (!response.ok) {
            throw new Error(`HTTP ${response.status} ${apiPath}: ${parsed.error || text.slice(0, 300)}`);
        }
        return parsed;
    } finally {
        clearTimeout(timer);
    }
}

function appendLog(stream, event) {
    const row = { at: new Date().toISOString(), ...event };
    stream.write(`${JSON.stringify(row)}\n`);
    console.log(JSON.stringify(row));
}

function perCityTarget(options) {
    if (options.targetPerCity) {
        return options.targetPerCity;
    }
    return Math.ceil(options.targetTotal / Math.max(1, options.cities.length));
}

function normalizeStationName(name) {
    return String(name || '')
        .replace(/[【】\[\]（）()]/g, '')
        .replace(/\s+/g, '')
        .trim();
}

function extractStationNames(result) {
    return (Array.isArray(result?.data) ? result.data : [])
        .map(station => station.stationName || station.station_name || station.name || '')
        .map(normalizeStationName)
        .filter(Boolean);
}

function extractOcrTexts(result) {
    const texts = [];
    for (const station of Array.isArray(result?.data) ? result.data : []) {
        const rawTexts = station?.raw?.ocrTexts || station?.raw?.textLines || station?.raw?.lines;
        if (Array.isArray(rawTexts)) {
            texts.push(...rawTexts.map(item => String(item || '')));
        }
    }
    return texts;
}

function captureHasBottom(result) {
    return extractOcrTexts(result).some(text => /到底了|已经到底|没有更多/.test(text));
}

function hasLoginLimitedText(textLines = []) {
    const text = (Array.isArray(textLines) ? textLines : []).join('\n');
    return /登录后，?使用完整充电功能|立即登录/.test(text);
}

function hasLoginPromptText(textLines = []) {
    const text = (Array.isArray(textLines) ? textLines : []).join('\n');
    return /快速登录|暂不登录|输入手机号码登录|服务协议|个人信息处理规则|微信授权|手机号/.test(text);
}

async function observePage(baseUrl, options, timeoutMs = 60000) {
    return requestJson(baseUrl, '/method1/actions/observe', {
        platform: options.platform
    }, timeoutMs);
}

async function waitForLoginClear(baseUrl, options, city, landmark, log) {
    const maxWaitMs = Math.max(0, Number(options.waitLoginMs || 0));
    if (maxWaitMs <= 0) {
        return { success: false, reason: 'login_wait_disabled' };
    }

    const startedAt = Date.now();
    appendLog(log, {
        event: 'login_wait_started',
        city,
        landmark,
        waitLoginMs: maxWaitMs,
        loginPollMs: options.loginPollMs
    });

    while (Date.now() - startedAt < maxWaitMs) {
        const observed = await observePage(baseUrl, options, Math.min(60000, Math.max(10000, Number(options.loginPollMs || 5000) + 5000)));
        const capture = observed.capture || {};
        const textLines = capture.textLines || [];
        const loginLimited = hasLoginLimitedText(textLines);
        const loginPrompt = capture.pageState?.state === 'login-prompt' || hasLoginPromptText(textLines);
        appendLog(log, {
            event: 'login_wait_poll',
            city,
            landmark,
            state: capture.pageState?.state || '',
            loginLimited,
            loginPrompt,
            screenshotPath: capture.screenshotPath || ''
        });
        if (!loginLimited && !loginPrompt) {
            return { success: true, reason: 'login_cleared', capture };
        }
        await sleep(Math.max(1000, Number(options.loginPollMs || 5000)));
    }

    return { success: false, reason: 'login_wait_timeout' };
}

function stationSignature(names) {
    return names.slice().sort().join('|');
}

async function recover(baseUrl, options, log) {
    const result = await requestJson(baseUrl, '/method1/actions/run-adaptive', {
        platform: options.platform,
        city: options.currentCity || '',
        maxSteps: 8,
        maxScrolls: 0,
        maxDurationSeconds: 90,
        maxDismissActions: 5
    }, 120000);
    appendLog(log, {
        event: 'recover',
        success: result.success,
        reason: result.reason,
        status: result.status,
        summary: result.summary
    });
    return result;
}

async function switchLandmark(baseUrl, options, city, landmark, log) {
    const body = {
        platform: options.platform,
        city: landmark,
        targetCity: landmark,
        selectedCity: city,
        maxDismissActions: 5,
        afterSelectWaitMs: 2600,
        navigationSettleMs: 1400
    };
    if (!options.cityOnly) {
        body.searchMode = 'landmark';
    }
    let result = await requestJson(baseUrl, '/method1/actions/switch-city', {
        ...body
    }, 120000);
    appendLog(log, {
        event: 'switch_landmark',
        city,
        landmark,
        success: result.success,
        reason: result.reason,
        verifiedCity: result.verifiedCity || ''
    });
    if (result.success) {
        return result;
    }

    await recover(baseUrl, { ...options, currentCity: city }, log);
    result = await requestJson(baseUrl, '/method1/actions/switch-city', {
        ...body
    }, 120000);
    appendLog(log, {
        event: 'switch_landmark_retry',
        city,
        landmark,
        success: result.success,
        reason: result.reason,
        verifiedCity: result.verifiedCity || ''
    });
    return result;
}

async function capture(baseUrl, options, city, landmark, phase, log) {
    const result = await requestJson(baseUrl, '/page-capture', {
        platform: options.platform,
        stage: `${options.runId}:${city}:${landmark}:${phase}`,
        sourceType: 'page-ocr',
        sourceStage: options.runId,
        runId: options.runId,
        city,
        landmark,
        operator: 'method1-desktop-city-batch'
    }, 90000);
    const stationNames = extractStationNames(result);
    const bottomReached = captureHasBottom(result);
    appendLog(log, {
        event: 'capture',
        city,
        landmark,
        phase,
        success: result.success,
        stationCount: Number(result.stationCount || 0),
        insertedCount: Number(result.insertedCount || 0),
        reviewInsertedCount: Number(result.reviewInsertedCount || 0),
        storedCount: Number(result.insertedCount || 0) + Number(result.reviewInsertedCount || 0),
        redCount: Number(result.redCount || 0),
        skippedCount: Number(result.skippedCount || 0),
        distinctOnPage: new Set(stationNames).size,
        bottomReached,
        stationNames,
        capturePath: result.capturePath || ''
    });
    result.stationNames = stationNames;
    result.bottomReached = bottomReached;
    return result;
}

async function scrollOnce(baseUrl, options, city, log) {
    if (options.fastScroll !== false) {
        const result = await requestJson(baseUrl, '/method1/actions/scroll', {
            platform: options.platform,
            city
        }, 60000);
        appendLog(log, {
            event: 'scroll_fast',
            city,
            success: result.success,
            reason: result.reason,
            status: result.success ? 'passed' : 'failed'
        });
        if (result.success) {
            return result;
        }
        appendLog(log, {
            event: 'scroll_fast_fallback',
            city,
            reason: result.reason || 'scroll_failed'
        });
    }

    const result = await requestJson(baseUrl, '/method1/actions/run-adaptive', {
        platform: options.platform,
        city,
        maxSteps: 8,
        maxScrolls: 1,
        maxDurationSeconds: 120,
        maxDismissActions: 5,
        afterScrollWaitMs: 3000
    }, 140000);
    appendLog(log, {
        event: 'scroll_adaptive',
        city,
        success: result.success,
        reason: result.reason,
        status: result.status,
        summary: result.summary
    });
    return result;
}

async function runCity(baseUrl, options, city, target, log) {
    const landmarks = options.currentPage ? ['current-visible-page'] : (options.cityOnly ? [city] : (LANDMARKS[city] || [city]));
    const cityStationNames = new Set();
    let storedRows = 0;
    let recognized = 0;
    let captures = 0;
    let consecutiveNoNewDistinct = 0;
    let blockedReason = '';

    for (const landmark of landmarks) {
        if (cityStationNames.size >= target || captures >= options.maxCapturesPerCity) {
            break;
        }
        if (!options.currentPage) {
            const switched = await switchLandmark(baseUrl, options, city, landmark, log);
            if (!switched.success) {
                appendLog(log, { event: 'landmark_skipped', city, landmark, reason: switched.reason || 'switch_failed' });
                continue;
            }
        } else {
            appendLog(log, { event: 'current_page_selected', city, landmark });
        }

        let lastSignature = '';
        let repeatedSignatureCount = 0;
        for (let page = 0; page < options.pagesPerLandmark; page += 1) {
            if (cityStationNames.size >= target || captures >= options.maxCapturesPerCity || consecutiveNoNewDistinct >= options.noInsertLimit) {
                break;
            }
            const cap = await capture(baseUrl, options, city, landmark, `page-${page + 1}`, log);
            captures += 1;
            const pageStoredRows = Number(cap.insertedCount || 0) + Number(cap.reviewInsertedCount || 0);
            storedRows += pageStoredRows;
            recognized += Number(cap.stationCount || 0);

            let newDistinct = 0;
            for (const stationName of cap.stationNames || []) {
                if (!cityStationNames.has(stationName)) {
                    cityStationNames.add(stationName);
                    newDistinct += 1;
                }
            }
            consecutiveNoNewDistinct = newDistinct > 0 ? 0 : consecutiveNoNewDistinct + 1;

            const signature = stationSignature(cap.stationNames || []);
            repeatedSignatureCount = signature && signature === lastSignature ? repeatedSignatureCount + 1 : 0;
            lastSignature = signature;

            appendLog(log, {
                event: 'city_progress',
                city,
                distinctStations: cityStationNames.size,
                newDistinct,
                storedRows,
                recognized,
                captures,
                target,
                consecutiveNoNewDistinct,
                bottomReached: cap.bottomReached,
                repeatedSignatureCount
            });
            if (cityStationNames.size >= target) {
                break;
            }
            if (cap.bottomReached || repeatedSignatureCount >= 1 || consecutiveNoNewDistinct >= 2) {
                appendLog(log, {
                    event: 'landmark_exhausted',
                    city,
                    landmark,
                    reason: cap.bottomReached
                        ? 'bottom_reached'
                        : repeatedSignatureCount >= 1
                            ? 'repeated_page_signature'
                            : 'no_new_distinct_stations',
                    distinctStations: cityStationNames.size,
                    storedRows,
                    captures
                });
                break;
            }
            if (newDistinct === 0 || pageStoredRows === 0) {
                await recover(baseUrl, { ...options, currentCity: city }, log);
                await sleep(800);
                continue;
            }
            if (options.adaptiveEvery > 0 && captures % options.adaptiveEvery === 0) {
                await recover(baseUrl, { ...options, currentCity: city }, log);
            }
            const scroll = await scrollOnce(baseUrl, options, city, log);
            if (!scroll.success) {
                if (scroll.reason === 'login_required_for_more_results') {
                    const loginRecovery = await recover(baseUrl, { ...options, currentCity: city }, log);
                    appendLog(log, {
                        event: 'login_prompt_recovery',
                        city,
                        landmark,
                        success: loginRecovery.success,
                        reason: loginRecovery.reason,
                        summary: loginRecovery.summary || null
                    });
                    if (loginRecovery.success) {
                        appendLog(log, {
                            event: 'login_prompt_skipped',
                            city,
                            landmark,
                            reason: loginRecovery.reason
                        });
                        await sleep(800);
                        continue;
                    }
                    const loginWait = await waitForLoginClear(baseUrl, options, city, landmark, log);
                    if (loginWait.success) {
                        appendLog(log, {
                            event: 'login_wait_resolved',
                            city,
                            landmark,
                            reason: loginWait.reason
                        });
                        await sleep(800);
                        continue;
                    }
                    blockedReason = loginRecovery.reason || loginWait.reason || scroll.reason || 'login_required_for_more_results';
                } else {
                    blockedReason = scroll.reason || 'scroll_failed';
                }
                appendLog(log, {
                    event: 'city_blocked',
                    city,
                    landmark,
                    reason: blockedReason,
                    distinctStations: cityStationNames.size,
                    storedRows,
                    captures
                });
                break;
            }
            await sleep(800);
        }
        if (blockedReason) {
            break;
        }
        consecutiveNoNewDistinct = 0;
    }

    return {
        city,
        distinctStations: cityStationNames.size,
        storedRows,
        recognized,
        captures,
        target,
        blockedReason,
        success: cityStationNames.size >= target
    };
}

async function main() {
    const options = parseArgs(process.argv);
    fs.mkdirSync(options.logDir, { recursive: true });
    const logPath = path.join(options.logDir, `${options.runId}.jsonl`);
    const log = fs.createWriteStream(logPath, { flags: 'a' });
    const target = perCityTarget(options);

    appendLog(log, {
        event: 'run_start',
        runId: options.runId,
        baseUrl: options.baseUrl,
        cities: options.cities,
        targetTotal: options.targetTotal,
        targetPerCity: target
    });

    const workflow = await requestJson(options.baseUrl, `/method1/workflow?platform=${encodeURIComponent(options.platform)}`, null, 30000);
    appendLog(log, {
        event: 'workflow',
        success: workflow.success,
        available: workflow.available,
        stage: workflow.stage,
        reason: workflow.reason,
        diagnostics: workflow.diagnostics || []
    });
    if (!workflow.success || workflow.available === false) {
        throw new Error(`Method1 workflow unavailable: ${workflow.reason || 'unknown'}; ${workflow.nextAction || ''}`);
    }

    const summaries = [];
    for (const city of options.cities) {
        const summary = await runCity(options.baseUrl, options, city, target, log);
        summaries.push(summary);
        appendLog(log, { event: 'city_done', ...summary });
    }

    const totalDistinctStations = summaries.reduce((sum, item) => sum + item.distinctStations, 0);
    const totalStoredRows = summaries.reduce((sum, item) => sum + item.storedRows, 0);
    const totalRecognized = summaries.reduce((sum, item) => sum + item.recognized, 0);
    appendLog(log, {
        event: 'run_done',
        runId: options.runId,
        success: totalDistinctStations >= options.targetTotal && summaries.every(item => item.distinctStations > 0),
        totalDistinctStations,
        totalStoredRows,
        totalRecognized,
        summaries,
        logPath
    });
    log.end();
}

main().catch(error => {
    console.error(error.stack || error.message);
    process.exit(1);
});
