#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REQUEST_BUDGET = 45;
const DEFAULT_REMOTE_ROOT = '/Users/didi/fyl/data_for_didi';
const RISK_TEXT = /风控|风险|重新登录|登录失效|验证码|设备校验|challenge|captcha|verify|risk/i;

const XIAN_ANCHORS = [
    { id: 'bell-tower', name: '钟楼', lat: 34.261005, lng: 108.942336 },
    { id: 'gaoxin', name: '高新', lat: 34.220600, lng: 108.884200 },
    { id: 'qujiang', name: '曲江', lat: 34.196800, lng: 108.980700 },
    { id: 'jingkai', name: '经开', lat: 34.341500, lng: 108.946900 },
    { id: 'chanba', name: '浐灞', lat: 34.319800, lng: 109.058500 },
    { id: 'changan', name: '长安', lat: 34.157600, lng: 108.906900 },
    { id: 'weiyang', name: '未央', lat: 34.308300, lng: 108.946800 },
    { id: 'baqiao', name: '灞桥', lat: 34.273900, lng: 109.064700 },
    { id: 'yanta', name: '雁塔', lat: 34.222500, lng: 108.948700 },
];

const SHALLOW_OFFSETS = [
    { id: 'center', name: '中心', dLat: 0, dLng: 0 },
    { id: 'north', name: '北', dLat: 0.012, dLng: 0 },
    { id: 'south', name: '南', dLat: -0.012, dLng: 0 },
    { id: 'east', name: '东', dLat: 0, dLng: 0.015 },
    { id: 'west', name: '西', dLat: 0, dLng: -0.015 },
];

const ANDROID_DEVICES = [
    ['pixel-8-pro', 'Pixel 8 Pro', '14', 'husky', 'AP2A.240305.019'],
    ['pixel-8', 'Pixel 8', '14', 'shiba', 'AP2A.240305.019'],
    ['pixel-7-pro', 'Pixel 7 Pro', '14', 'cheetah', 'AP2A.240305.019'],
    ['galaxy-s24-ultra', 'Galaxy S24 Ultra', '14', 'SM-S9280', 'UP1A.231005.007'],
    ['galaxy-s24', 'Galaxy S24', '14', 'SM-S9210', 'UP1A.231005.007'],
    ['galaxy-s23', 'Galaxy S23', '14', 'SM-S9110', 'UP1A.231005.007'],
    ['galaxy-s22', 'Galaxy S22', '13', 'SM-S9010', 'TP1A.220624.014'],
    ['xiaomi-14', 'Xiaomi 14', '14', '23127PN0CC', 'UKQ1.231003.002'],
    ['xiaomi-13', 'Xiaomi 13', '13', '2211133C', 'TKQ1.221114.001'],
    ['xiaomi-12', 'Xiaomi 12', '13', '2201123C', 'TKQ1.220829.002'],
    ['redmi-k70-pro', 'Redmi K70 Pro', '14', '23113RKC6C', 'UKQ1.231003.002'],
    ['redmi-k60', 'Redmi K60', '13', '23013RK75C', 'TKQ1.221114.001'],
    ['oneplus-12', 'OnePlus 12', '14', 'PJD110', 'UKQ1.231003.002'],
    ['oneplus-11', 'OnePlus 11', '13', 'PHB110', 'TP1A.220905.001'],
    ['oppo-find-x7', 'OPPO Find X7', '14', 'PHZ110', 'UKQ1.231003.002'],
    ['oppo-find-x6', 'OPPO Find X6', '13', 'PGFM10', 'TP1A.220905.001'],
    ['vivo-x100', 'vivo X100', '14', 'V2309A', 'UP1A.231005.007'],
    ['vivo-x90', 'vivo X90', '13', 'V2241A', 'TP1A.220624.014'],
    ['honor-magic6', 'HONOR Magic6', '14', 'BVL-AN00', 'UP1A.231005.007'],
    ['honor-magic5', 'HONOR Magic5', '13', 'PGT-AN00', 'TP1A.220624.014'],
    ['huawei-mate60', 'HUAWEI Mate 60', '14', 'BRA-AL00', 'HUAWEIBRA-AL00'],
    ['huawei-p60', 'HUAWEI P60', '13', 'MNA-AL00', 'HUAWEIMNA-AL00'],
    ['huawei-nova12', 'HUAWEI nova 12', '14', 'ADA-AL00', 'HUAWEIADA-AL00'],
];

const IOS_VARIANTS = [
    ['iphone-15-pro-max', 'iPhone 15 Pro Max', '15_7'],
    ['iphone-15-pro', 'iPhone 15 Pro', '15_7_1'],
    ['iphone-15-plus', 'iPhone 15 Plus', '15_7_2'],
    ['iphone-15', 'iPhone 15', '16_0'],
    ['iphone-14-pro-max', 'iPhone 14 Pro Max', '16_1'],
    ['iphone-14-pro', 'iPhone 14 Pro', '16_2'],
    ['iphone-14-plus', 'iPhone 14 Plus', '16_3'],
    ['iphone-14', 'iPhone 14', '16_4'],
    ['iphone-13-pro-max', 'iPhone 13 Pro Max', '16_5'],
    ['iphone-13-pro', 'iPhone 13 Pro', '16_6'],
    ['iphone-13-mini', 'iPhone 13 mini', '16_7'],
    ['iphone-13', 'iPhone 13', '17_0'],
    ['iphone-12-pro-max', 'iPhone 12 Pro Max', '17_1'],
    ['iphone-12-pro', 'iPhone 12 Pro', '17_2'],
    ['iphone-12-mini', 'iPhone 12 mini', '17_3'],
    ['iphone-12', 'iPhone 12', '17_4'],
    ['iphone-11-pro-max', 'iPhone 11 Pro Max', '17_5'],
    ['iphone-11-pro', 'iPhone 11 Pro', '17_6'],
    ['iphone-11', 'iPhone 11', '18_0'],
    ['iphone-xs-max', 'iPhone XS Max', '18_1'],
    ['iphone-xs', 'iPhone XS', '18_2'],
    ['iphone-xr', 'iPhone XR', '18_3'],
];

function parseArgs(argv) {
    const args = {
        network: false,
        projectRoot: process.env.DATA_TEST_ROOT || DEFAULT_REMOTE_ROOT,
        corpusPath: process.env.DIDI_SIGNATURE_CORPUS_PATH || '',
        proxyUrl: process.env.UNIFIED_OUTBOUND_PROXY_URL || 'http://47.111.139.230:50181',
        outputPath: '',
        delayMs: 2000,
        timeoutMs: 15000,
    };

    for (let index = 2; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === '--network') args.network = true;
        else if (arg === '--dry-run') args.network = false;
        else if (arg === '--project-root') args.projectRoot = argv[++index] || args.projectRoot;
        else if (arg === '--corpus') args.corpusPath = argv[++index] || '';
        else if (arg === '--proxy-url') args.proxyUrl = argv[++index] || '';
        else if (arg === '--output') args.outputPath = argv[++index] || '';
        else if (arg === '--delay-ms') args.delayMs = Math.max(1500, Number(argv[++index]) || 2000);
        else if (arg === '--timeout-ms') args.timeoutMs = Math.max(3000, Number(argv[++index]) || 15000);
        else throw new Error(`unknown argument: ${arg}`);
    }
    return args;
}

function sha256(value) {
    return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function buildAndroidUserAgents() {
    return ANDROID_DEVICES.map((item, index) => {
        const [id, device, androidVersion, model, build] = item;
        const wechatVersion = index % 2 === 0 ? '8.0.47' : '8.0.48';
        const wechatBuild = index % 2 === 0 ? '2560(0x28002F36)' : '2580(0x2800303A)';
        return {
            id: `android-${id}`,
            platform: 'android',
            device,
            wechatVersion,
            userAgent: `Mozilla/5.0 (Linux; Android ${androidVersion}; ${model} Build/${build}; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.6099.230 Mobile Safari/537.36 XWEB/1200317 MMWEBSDK/20240104 MicroMessenger/${wechatVersion}.${wechatBuild} WeChat/arm64 Weixin NetType/WIFI Language/zh_CN ABI/arm64 MiniProgramEnv/android`,
        };
    });
}

function buildIosUserAgents() {
    return IOS_VARIANTS.map((item, index) => {
        const [id, device, osVersion] = item;
        const wechatVersion = index % 2 === 0 ? '8.0.47' : '8.0.48';
        const wechatBuild = index % 2 === 0 ? '0x18002f35' : '0x18003036';
        return {
            id: `ios-${id}`,
            platform: 'ios',
            device,
            wechatVersion,
            userAgent: `Mozilla/5.0 (iPhone; CPU iPhone OS ${osVersion} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/${wechatVersion}(${wechatBuild}) NetType/WIFI Language/zh_CN MiniProgramEnv/iOS`,
        };
    });
}

function buildUserAgents() {
    const android = buildAndroidUserAgents();
    const ios = buildIosUserAgents();
    const result = [];
    for (let index = 0; index < REQUEST_BUDGET; index++) {
        result.push(index % 2 === 0 ? android[index / 2] : ios[(index - 1) / 2]);
    }
    return result;
}

function buildTasks() {
    const userAgents = buildUserAgents();
    const tasks = [];
    let index = 0;
    for (const anchor of XIAN_ANCHORS) {
        for (const offset of SHALLOW_OFFSETS) {
            const userAgent = userAgents[index];
            tasks.push({
                index: index + 1,
                requestId: `xian-${String(index + 1).padStart(2, '0')}-${anchor.id}-${offset.id}`,
                city: '西安市',
                anchor: `${anchor.name}-${offset.name}`,
                lat: Number((anchor.lat + offset.dLat).toFixed(6)),
                lng: Number((anchor.lng + offset.dLng).toFixed(6)),
                pageNo: 1,
                pageSize: 10,
                userAgent,
            });
            index++;
        }
    }
    return tasks;
}

function validatePlan(tasks) {
    const coordinates = new Set(tasks.map(item => `${item.lat},${item.lng}`));
    const userAgentValues = new Set(tasks.map(item => item.userAgent.userAgent));
    const userAgentIds = new Set(tasks.map(item => item.userAgent.id));
    const androidCount = tasks.filter(item => item.userAgent.platform === 'android').length;
    const iosCount = tasks.filter(item => item.userAgent.platform === 'ios').length;
    const checks = {
        requestCount: tasks.length,
        uniqueCoordinateCount: coordinates.size,
        uniqueUserAgentCount: userAgentValues.size,
        uniqueUserAgentIdCount: userAgentIds.size,
        androidCount,
        iosCount,
    };
    if (checks.requestCount !== REQUEST_BUDGET
        || checks.uniqueCoordinateCount !== REQUEST_BUDGET
        || checks.uniqueUserAgentCount !== REQUEST_BUDGET
        || checks.uniqueUserAgentIdCount !== REQUEST_BUDGET
        || checks.androidCount !== 23
        || checks.iosCount !== 22) {
        throw new Error(`invalid request plan: ${JSON.stringify(checks)}`);
    }
    return checks;
}

function publicPlan(tasks, checks) {
    return {
        success: true,
        mode: 'dry-run',
        city: '西安市',
        requestBudget: REQUEST_BUDGET,
        checks,
        userAgentMaterial: 'synthetic-mobile-wechat-ua-variants-not-physical-devices',
        tasks: tasks.map(item => ({
            index: item.index,
            requestId: item.requestId,
            anchor: item.anchor,
            lat: item.lat,
            lng: item.lng,
            pageNo: item.pageNo,
            uaId: item.userAgent.id,
            uaPlatform: item.userAgent.platform,
            uaDevice: item.userAgent.device,
            uaWechatVersion: item.userAgent.wechatVersion,
            uaSha256: sha256(item.userAgent.userAgent),
        })),
    };
}

function requireNetworkGuards(args) {
    if (process.env.ALLOW_DIDI_XIAN_45_VALIDATION !== '1') {
        throw new Error('network run requires ALLOW_DIDI_XIAN_45_VALIDATION=1');
    }
    if (String(process.env.BLUE_TEAM_TEST_NODE_ROLE || '').toLowerCase() !== '172') {
        throw new Error('network run requires BLUE_TEAM_TEST_NODE_ROLE=172');
    }
    if (!args.proxyUrl) throw new Error('network run requires a controlled proxy');
    if (!args.outputPath || !path.resolve(args.outputPath).startsWith('/private/tmp/')) {
        throw new Error('network result must use --output under /private/tmp');
    }
    if (!path.isAbsolute(args.projectRoot) || !fs.existsSync(args.projectRoot)) {
        throw new Error(`remote project root is unavailable: ${args.projectRoot}`);
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function extractStationList(payload) {
    const components = Array.isArray(payload?.data?.components) ? payload.data.components : [];
    for (const component of components) {
        if (Array.isArray(component?.data)) return component.data;
    }
    if (Array.isArray(payload?.data?.stationList)) return payload.data.stationList;
    return [];
}

function stationId(station) {
    return String(station?.stationId || station?.fullStationId || station?.id || '');
}

function boundedMessage(payload) {
    const value = payload?.message || payload?.errmsg || payload?.msg || payload?.info || '';
    return String(value).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').slice(0, 160);
}

function businessCode(payload) {
    return payload?.code ?? payload?.errno ?? payload?.errorCode ?? payload?.infocode ?? null;
}

function buildSignedRequest(deps, sample, signer, task) {
    const requestCase = deps.buildCase(sample, {
        city: task.city,
        lat: task.lat,
        lng: task.lng,
    }, { userAgent: task.userAgent.userAgent });
    requestCase.bodyParams.pageNo = task.pageNo;
    requestCase.bodyParams.pageSize = task.pageSize;
    requestCase.bodyParams.lat = task.lat;
    requestCase.bodyParams.lng = task.lng;
    requestCase.bodyParams.userlat = task.lat;
    requestCase.bodyParams.userlng = task.lng;

    const signed = deps.signCase(signer, requestCase);
    if (!signed.summary.generated) throw new Error(`signature generation failed for ${task.requestId}`);
    const url = new URL(requestCase.baseUrl);
    for (const [key, value] of Object.entries(requestCase.queryParams || {})) {
        url.searchParams.set(key, String(value));
    }
    url.searchParams.set('wsgsig', signed.signature);
    const headers = { ...requestCase.headers };
    deps.setHeader(headers, 'secdd-challenge', '3|2.0.34||||||');
    deps.setHeader(headers, 'secdd-authentication', Math.round(Date.now() / 1000));
    deps.setHeader(headers, 'user-agent', task.userAgent.userAgent);
    return {
        url,
        method: requestCase.method,
        headers,
        body: JSON.stringify(requestCase.bodyParams || {}),
        signSummary: signed.summary,
    };
}

async function executeNetwork(args, tasks, checks) {
    requireNetworkGuards(args);
    const dependencyPath = path.join(args.projectRoot, 'scripts/wsgsig-sdk-validation.js');
    const deps = require(dependencyPath);
    const { signer, moduleCount, loadErrors } = deps.loadSigner();
    const corpusPath = deps.pickCorpusPath(args.corpusPath);
    const entries = deps.loadCorpusEntries(corpusPath);
    if (entries.length === 0) throw new Error('no authorized stationList corpus entry is available');
    const sample = entries[0];
    const results = [];
    const uniqueStations = new Set();
    const startedAt = new Date().toISOString();
    let stopReason = '';

    for (const task of tasks) {
        const requestStarted = Date.now();
        let row;
        try {
            const request = buildSignedRequest(deps, sample, signer, task);
            const response = await deps.requestWithProxy(request.url, {
                method: request.method,
                headers: request.headers,
                body: request.body,
                timeoutMs: args.timeoutMs,
                proxyUrl: args.proxyUrl,
            });
            let payload;
            try {
                payload = JSON.parse(response.bodyText);
            } catch (error) {
                payload = null;
            }
            const code = businessCode(payload);
            const message = boundedMessage(payload);
            const stations = payload ? extractStationList(payload) : [];
            for (const station of stations) {
                const id = stationId(station);
                if (id) uniqueStations.add(id);
            }
            const ok = response.status === 200 && Number(code) === 10000 && !RISK_TEXT.test(message);
            row = {
                index: task.index,
                requestId: task.requestId,
                anchor: task.anchor,
                lat: task.lat,
                lng: task.lng,
                pageNo: task.pageNo,
                uaId: task.userAgent.id,
                uaPlatform: task.userAgent.platform,
                uaDevice: task.userAgent.device,
                uaWechatVersion: task.userAgent.wechatVersion,
                uaSha256: sha256(task.userAgent.userAgent),
                httpStatus: response.status,
                businessCode: code,
                message,
                stationCount: stations.length,
                durationMs: Date.now() - requestStarted,
                signLength: request.signSummary.length,
                success: ok,
            };
            if (!ok) {
                stopReason = `stopped_at_${task.requestId}_http_${response.status}_code_${String(code)}`;
            }
        } catch (error) {
            row = {
                index: task.index,
                requestId: task.requestId,
                anchor: task.anchor,
                uaId: task.userAgent.id,
                uaPlatform: task.userAgent.platform,
                uaSha256: sha256(task.userAgent.userAgent),
                success: false,
                error: String(error.message || error).replace(/[\r\n\t]+/g, ' ').slice(0, 200),
                durationMs: Date.now() - requestStarted,
            };
            stopReason = `request_error_at_${task.requestId}`;
        }
        results.push(row);
        process.stderr.write(`[${task.index}/${REQUEST_BUDGET}] ${task.requestId} ${row.success ? 'success' : 'stop'} http=${row.httpStatus ?? '-'} code=${row.businessCode ?? '-'} stations=${row.stationCount ?? 0} ua=${row.uaId}\n`);
        if (stopReason) break;
        if (task.index < REQUEST_BUDGET) await sleep(args.delayMs);
    }

    const completedAt = new Date().toISOString();
    const summary = {
        success: results.length === REQUEST_BUDGET && results.every(item => item.success),
        mode: '172-network-validation',
        runId: `didi-xian-45-${startedAt.replace(/[-:.TZ]/g, '').slice(0, 14)}`,
        startedAt,
        completedAt,
        execution: {
            requestedNodeRole: process.env.BLUE_TEAM_TEST_NODE_ROLE,
            hostname: os.hostname(),
            projectRoot: args.projectRoot,
            proxyRequired: true,
            proxy: deps.maskProxyUrl(args.proxyUrl),
            concurrency: 1,
            delayMs: args.delayMs,
            timeoutMs: args.timeoutMs,
        },
        signer: {
            moduleCount,
            loadErrorCount: loadErrors.length,
            corpusPath,
        },
        planChecks: checks,
        requestBudget: REQUEST_BUDGET,
        executedCount: results.length,
        successCount: results.filter(item => item.success).length,
        failureCount: results.filter(item => !item.success).length,
        stopReason: stopReason || null,
        uniqueExecutedUserAgentCount: new Set(results.map(item => item.uaSha256)).size,
        androidExecutedCount: results.filter(item => item.uaPlatform === 'android').length,
        iosExecutedCount: results.filter(item => item.uaPlatform === 'ios').length,
        totalStationRows: results.reduce((total, item) => total + Number(item.stationCount || 0), 0),
        uniqueStationIdCount: uniqueStations.size,
        results,
    };
    fs.writeFileSync(args.outputPath, `${JSON.stringify(summary, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    return summary;
}

async function main() {
    const args = parseArgs(process.argv);
    const tasks = buildTasks();
    const checks = validatePlan(tasks);
    if (!args.network) {
        process.stdout.write(`${JSON.stringify(publicPlan(tasks, checks), null, 2)}\n`);
        return;
    }
    const summary = await executeNetwork(args, tasks, checks);
    process.stdout.write(`${JSON.stringify({
        success: summary.success,
        runId: summary.runId,
        executedCount: summary.executedCount,
        successCount: summary.successCount,
        failureCount: summary.failureCount,
        stopReason: summary.stopReason,
        uniqueExecutedUserAgentCount: summary.uniqueExecutedUserAgentCount,
        androidExecutedCount: summary.androidExecutedCount,
        iosExecutedCount: summary.iosExecutedCount,
        totalStationRows: summary.totalStationRows,
        uniqueStationIdCount: summary.uniqueStationIdCount,
        outputPath: args.outputPath,
    }, null, 2)}\n`);
}

main().catch(error => {
    process.stderr.write(`${JSON.stringify({ success: false, error: String(error.message || error).slice(0, 300) })}\n`);
    process.exitCode = 1;
});
