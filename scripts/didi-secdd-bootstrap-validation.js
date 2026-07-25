#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_REMOTE_ROOT = '/Users/didi/fyl/data_for_didi';
const DEFAULT_PROXY_URL = 'http://47.111.139.230:50181';
const BOOTSTRAP_URL = 'https://energy.xiaojukeji.com/station-api/homePageLayout';
const STATION_URL = 'https://energy.xiaojukeji.com/station-api/homepage/stationList';
const SECDD_CHALLENGE = '3|2.0.34||||||';
const REQUEST_BUDGET = 2;
const XIAN_TARGET = {
    city: '西安市',
    anchor: '钟楼',
    lat: 34.261005,
    lng: 108.942336,
};
const MOBILE_WECHAT_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro Build/AP2A.240305.019; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.6099.230 Mobile Safari/537.36 XWEB/1200317 MMWEBSDK/20240104 MicroMessenger/8.0.47.2560(0x28002F36) WeChat/arm64 Weixin NetType/WIFI Language/zh_CN ABI/arm64 MiniProgramEnv/android';
const RISK_TEXT = /风控|风险|重新登录|登录失效|验证码|设备校验|challenge|captcha|verify|risk/i;

function parseArgs(argv) {
    const args = {
        network: false,
        projectRoot: process.env.DATA_TEST_ROOT || DEFAULT_REMOTE_ROOT,
        corpusPath: process.env.DIDI_SIGNATURE_CORPUS_PATH || '',
        proxyUrl: process.env.UNIFIED_OUTBOUND_PROXY_URL || DEFAULT_PROXY_URL,
        outputPath: '',
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
        else if (arg === '--timeout-ms') args.timeoutMs = Math.max(3000, Number(argv[++index]) || 15000);
        else throw new Error(`unknown argument: ${arg}`);
    }
    return args;
}

function publicPlan() {
    return {
        success: true,
        mode: 'dry-run',
        requestBudget: REQUEST_BUDGET,
        executionNode: '172-only-for-network',
        signerInit: {
            bizId: '14e45fa0cf5847992ce53495573d1994',
            appVer: '6.10.59',
            os: '1',
        },
        requests: [
            {
                sequence: 1,
                purpose: 'dclg-bootstrap',
                method: 'GET',
                path: new URL(BOOTSTRAP_URL).pathname,
                queryKeys: ['source', 'ttid', 'wsgsig'],
                secddAuthenticationSource: 'current_epoch_seconds',
            },
            {
                sequence: 2,
                purpose: 'xian-station-list',
                method: 'POST',
                path: new URL(STATION_URL).pathname,
                city: XIAN_TARGET.city,
                anchor: XIAN_TARGET.anchor,
                lat: XIAN_TARGET.lat,
                lng: XIAN_TARGET.lng,
                secddAuthenticationSource: 'bootstrap_response_header_in_memory',
                precondition: 'bootstrap_http_200_code_10000_and_new_authentication_value',
            },
        ],
        sensitiveDataPolicy: 'secdd-authentication value is neither logged nor persisted',
    };
}

function requireNetworkGuards(args) {
    if (process.env.ALLOW_DIDI_SECDD_BOOTSTRAP_VALIDATION !== '1') {
        throw new Error('network run requires ALLOW_DIDI_SECDD_BOOTSTRAP_VALIDATION=1');
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

function getHeader(headers, name) {
    const pair = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === name.toLowerCase());
    if (!pair) return '';
    const value = pair[1];
    if (Array.isArray(value)) return String(value[0] || '');
    return String(value || '');
}

function parsePayload(text) {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

function businessCode(payload) {
    return payload?.code ?? payload?.errno ?? payload?.errorCode ?? payload?.infocode ?? null;
}

function boundedMessage(payload) {
    const value = payload?.message || payload?.errmsg || payload?.msg || payload?.info || '';
    return String(value).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').slice(0, 160);
}

function extractStations(payload) {
    const components = Array.isArray(payload?.data?.components) ? payload.data.components : [];
    for (const component of components) {
        if (Array.isArray(component?.data)) return component.data;
    }
    if (Array.isArray(payload?.data?.stationList)) {
        const groups = payload.data.stationList;
        return groups.flatMap(group => Array.isArray(group?.stationList) ? group.stationList : [group]);
    }
    return [];
}

function buildBaseCase(deps, sample) {
    const requestCase = deps.buildCase(sample, XIAN_TARGET, { userAgent: MOBILE_WECHAT_UA });
    deps.setHeader(requestCase.headers, 'user-agent', MOBILE_WECHAT_UA);
    deps.setHeader(requestCase.headers, 'secdd-challenge', SECDD_CHALLENGE);
    return requestCase;
}

function buildSignedUrl(deps, signer, requestCase) {
    const signed = deps.signCase(signer, requestCase);
    if (!signed.summary.generated) throw new Error('wsgsig generation failed');
    const url = new URL(requestCase.baseUrl);
    for (const [key, value] of Object.entries(requestCase.queryParams || {})) {
        if (value !== null && value !== undefined) url.searchParams.set(key, String(value));
    }
    url.searchParams.set('wsgsig', signed.signature);
    return { url, signSummary: signed.summary };
}

function buildBootstrapCase(deps, sample) {
    const base = buildBaseCase(deps, sample);
    return {
        ...base,
        method: 'GET',
        baseUrl: BOOTSTRAP_URL,
        queryParams: {
            source: String(sample.queryParams?.source ?? '2'),
            ttid: String(sample.queryParams?.ttid ?? 'wx'),
        },
        bodyParams: undefined,
    };
}

function buildStationCase(deps, sample) {
    const requestCase = buildBaseCase(deps, sample);
    requestCase.method = 'POST';
    requestCase.baseUrl = STATION_URL;
    requestCase.bodyParams = {
        ...requestCase.bodyParams,
        lat: XIAN_TARGET.lat,
        lng: XIAN_TARGET.lng,
        userlat: XIAN_TARGET.lat,
        userlng: XIAN_TARGET.lng,
        pageNo: 1,
        pageSize: 10,
    };
    return requestCase;
}

function writeEvidence(outputPath, evidence) {
    fs.writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
    });
}

async function executeNetwork(args) {
    requireNetworkGuards(args);
    const dependencyPath = path.join(args.projectRoot, 'scripts/wsgsig-sdk-validation.js');
    const deps = require(dependencyPath);
    const { signer, moduleCount, loadErrors } = deps.loadSigner();
    const corpusPath = deps.pickCorpusPath(args.corpusPath);
    const entries = deps.loadCorpusEntries(corpusPath);
    if (entries.length === 0) throw new Error('no authorized stationList corpus entry is available');

    const startedAt = new Date().toISOString();
    const evidence = {
        success: false,
        mode: '172-network-validation',
        runId: `didi-secdd-bootstrap-${startedAt.replace(/[-:.TZ]/g, '').slice(0, 14)}`,
        startedAt,
        completedAt: null,
        execution: {
            requestedNodeRole: process.env.BLUE_TEAM_TEST_NODE_ROLE,
            hostname: os.hostname(),
            projectRoot: args.projectRoot,
            proxyRequired: true,
            proxy: deps.maskProxyUrl(args.proxyUrl),
            requestBudget: REQUEST_BUDGET,
        },
        signer: {
            moduleCount,
            loadErrorCount: loadErrors.length,
            corpusPath,
            initFieldsPresent: true,
        },
        bootstrap: null,
        stationList: null,
        stopReason: null,
    };

    const sample = entries[0];
    const initialAuthentication = String(Math.round(Date.now() / 1000));
    const bootstrapCase = buildBootstrapCase(deps, sample);
    deps.setHeader(bootstrapCase.headers, 'secdd-authentication', initialAuthentication);
    const bootstrapSigned = buildSignedUrl(deps, signer, bootstrapCase);
    const bootstrapStarted = Date.now();
    const bootstrapResponse = await deps.requestWithProxy(bootstrapSigned.url, {
        method: bootstrapCase.method,
        headers: bootstrapCase.headers,
        body: undefined,
        timeoutMs: args.timeoutMs,
        proxyUrl: args.proxyUrl,
    });
    const bootstrapPayload = parsePayload(bootstrapResponse.bodyText);
    const bootstrapCode = businessCode(bootstrapPayload);
    const bootstrapMessage = boundedMessage(bootstrapPayload);
    const issuedAuthentication = getHeader(bootstrapResponse.headers, 'secdd-authentication');
    const issuedShapeValid = issuedAuthentication.length > initialAuthentication.length
        && issuedAuthentication.length <= 4096
        && issuedAuthentication !== initialAuthentication;
    const bootstrapOk = bootstrapResponse.status === 200
        && Number(bootstrapCode) === 10000
        && issuedShapeValid
        && !RISK_TEXT.test(bootstrapMessage);

    evidence.bootstrap = {
        method: 'GET',
        path: new URL(BOOTSTRAP_URL).pathname,
        httpStatus: bootstrapResponse.status,
        businessCode: bootstrapCode,
        message: bootstrapMessage,
        durationMs: Date.now() - bootstrapStarted,
        signLength: bootstrapSigned.signSummary.length,
        initialAuthenticationLength: initialAuthentication.length,
        issuedAuthenticationPresent: Boolean(issuedAuthentication),
        issuedAuthenticationLength: issuedAuthentication.length,
        issuedAuthenticationPersisted: false,
        success: bootstrapOk,
    };

    if (!bootstrapOk) {
        evidence.stopReason = `bootstrap_rejected_http_${bootstrapResponse.status}_code_${String(bootstrapCode)}`;
        evidence.completedAt = new Date().toISOString();
        writeEvidence(args.outputPath, evidence);
        return evidence;
    }

    const stationCase = buildStationCase(deps, sample);
    deps.setHeader(stationCase.headers, 'secdd-authentication', issuedAuthentication);
    const stationSigned = buildSignedUrl(deps, signer, stationCase);
    const stationStarted = Date.now();
    const stationResponse = await deps.requestWithProxy(stationSigned.url, {
        method: stationCase.method,
        headers: stationCase.headers,
        body: JSON.stringify(stationCase.bodyParams),
        timeoutMs: args.timeoutMs,
        proxyUrl: args.proxyUrl,
    });
    const stationPayload = parsePayload(stationResponse.bodyText);
    const stationCode = businessCode(stationPayload);
    const stationMessage = boundedMessage(stationPayload);
    const stations = extractStations(stationPayload);
    const stationOk = stationResponse.status === 200
        && Number(stationCode) === 10000
        && !RISK_TEXT.test(stationMessage);
    const rotatedAuthentication = getHeader(stationResponse.headers, 'secdd-authentication');

    evidence.stationList = {
        method: 'POST',
        path: new URL(STATION_URL).pathname,
        city: XIAN_TARGET.city,
        anchor: XIAN_TARGET.anchor,
        lat: XIAN_TARGET.lat,
        lng: XIAN_TARGET.lng,
        httpStatus: stationResponse.status,
        businessCode: stationCode,
        message: stationMessage,
        stationCount: stations.length,
        durationMs: Date.now() - stationStarted,
        signLength: stationSigned.signSummary.length,
        authenticationSource: 'bootstrap_response_header_in_memory',
        authenticationLength: issuedAuthentication.length,
        responseRotatedAuthenticationPresent: Boolean(rotatedAuthentication),
        responseRotatedAuthenticationLength: rotatedAuthentication.length,
        authenticationPersisted: false,
        success: stationOk,
    };
    evidence.success = stationOk;
    evidence.stopReason = stationOk
        ? null
        : `station_list_rejected_http_${stationResponse.status}_code_${String(stationCode)}`;
    evidence.completedAt = new Date().toISOString();
    writeEvidence(args.outputPath, evidence);
    return evidence;
}

async function main() {
    const args = parseArgs(process.argv);
    if (!args.network) {
        process.stdout.write(`${JSON.stringify(publicPlan(), null, 2)}\n`);
        return;
    }
    const evidence = await executeNetwork(args);
    process.stdout.write(`${JSON.stringify({
        success: evidence.success,
        runId: evidence.runId,
        bootstrap: evidence.bootstrap,
        stationList: evidence.stationList,
        stopReason: evidence.stopReason,
        outputPath: args.outputPath,
    }, null, 2)}\n`);
}

main().catch(error => {
    process.stderr.write(`${JSON.stringify({
        success: false,
        error: String(error.message || error).replace(/[\r\n\t]+/g, ' ').slice(0, 300),
    })}\n`);
    process.exitCode = 1;
});
