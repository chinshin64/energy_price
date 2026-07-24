'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const express = require('express');
const {
    buildSmartCollectTrafficPolicy,
    createSmartCollectRouter,
    normalizeCollectTargets,
    normalizeFilterList
} = require('../routes/smart-collect');

async function withApp(dependencies, callback) {
    const app = express();
    app.use(express.json({ limit: '2mb' }));
    app.use((req, res, next) => {
        req.requestId = 'request-smart-collect-0001';
        next();
    });
    const smartCollectRoutes = createSmartCollectRouter(dependencies);
    app.use('/api', smartCollectRoutes.router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
    });
    try {
        await callback(`http://127.0.0.1:${server.address().port}`, smartCollectRoutes);
    } finally {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
}

function createDependencies(overrides = {}) {
    const calls = {
        preflight: [],
        startSmart: [],
        pageOcr: [],
        attached: [],
        scroll: [],
        finalized: [],
        analyses: [],
        startCapture: [],
        inserted: [],
        parsed: [],
        learned: [],
        templates: []
    };
    const sessions = {
        s1: {
            sessionId: 's1',
            captureSession: { id: 'cap-1' }
        }
    };
    const dependencies = {
        smartController: {
            runAutomationPreflight: async (platforms, options) => {
                calls.preflight.push({ platforms, options });
                return { canStart: true, checks: [{ status: 'pass', label: 'automation' }] };
            },
            startSmartSession: async (platforms, options) => {
                calls.startSmart.push({ platforms, options });
                sessions.s1.captureSession = options.captureSession;
                return { success: true, sessionId: 's1' };
            },
            attachCaptureSession: (sessionId, captureSession) => {
                calls.attached.push({ sessionId, captureSession });
                sessions[sessionId] = sessions[sessionId] || { sessionId };
                sessions[sessionId].captureSession = captureSession;
            },
            startPageOcrSession: async (platforms, options) => {
                calls.pageOcr.push({ platforms, options });
                return { success: true, sessionId: 'page-1' };
            },
            performAutoScroll: async (sessionId, scrollCount, scrollInterval) => {
                calls.scroll.push({ sessionId, scrollCount, scrollInterval });
                return { success: true, sessionId, scrollCount, scrollInterval };
            },
            getSession: sessionId => sessions[sessionId] || null,
            requestFinishSession: sessionId => ({ success: true, sessionId }),
            cancelSession: sessionId => ({ success: true, sessionId, cancelled: true }),
            getActiveSessions: () => Object.values(sessions),
            finalizeCaptureSession: (sessionId, result) => calls.finalized.push({ sessionId, result }),
            recordCaptureAnalysis: (sessionId, analysis) => {
                calls.analyses.push({ sessionId, analysis });
                sessions[sessionId] = sessions[sessionId] || { sessionId };
                sessions[sessionId].captureAnalysis = analysis;
            }
        },
        captureRecorderService: {
            getStatus: () => ({
                available: true,
                binary: '/usr/local/bin/mitmdump',
                activeSession: { id: 'cap-1', listenHost: '127.0.0.1', listenPort: 8899 }
            }),
            startSession: input => {
                calls.startCapture.push(input);
                return { id: 'cap-1', listenHost: '127.0.0.1', listenPort: 8899, ...input };
            },
            stopSession: () => ({ id: 'cap-1', captureSessionId: 'cap-1', status: 'stopped' }),
            waitForSession: async id => ({ id, status: 'stopped' })
        },
        harParser: {
            parseSessionFile: async harPath => {
                calls.parsed.push(harPath);
                return [{ platform: 'didi-charging', stationName: '滴滴测试站' }];
            }
        },
        stationModel: {
            insertBatch: stations => {
                calls.inserted.push(stations);
                return { successCount: stations.length, skipCount: 0 };
            }
        },
        smartCrawler: {
            learnFromHAR: async harPath => {
                calls.learned.push(harPath);
                return [{
                    platform: 'didi-charging',
                    method: 'POST',
                    baseUrl: 'https://energy.xiaojukeji.com/station-api/homepage/stationlist',
                    templateScope: 'list',
                    queryParams: {},
                    bodyParams: {},
                    variableParams: { lat: '31.2' },
                    headers: {}
                }];
            }
        },
        apiTemplateModel: {
            saveBatch: templates => {
                calls.templates.push(templates);
                return { successCount: templates.length };
            }
        },
        appSettingModel: {
            getSelfHealSettings: () => ({ enabled: true }),
            getProxySettings: () => ({})
        },
        taskSelfHealService: {
            buildPreflight: payload => ({
                canStart: true,
                summary: `self-heal:${payload.platforms.join(',')}`,
                checks: [{ status: 'pass', label: 'self-heal' }]
            })
        },
        buildAiFeatureStatus: () => ({ enabled: false }),
        findMissingRuntimePlatform: () => null,
        logger: { warn: () => {} },
        ...overrides
    };
    return { calls, dependencies, sessions };
}

test('请求采集工具函数规范化目标、过滤项和滴滴默认流量策略', () => {
    assert.deepEqual(normalizeCollectTargets([
        { city: '上海', landmark: '虹桥站' },
        '北京, 广州|深圳',
        { keyword: '上海虹桥站' }
    ]), ['上海虹桥站', '北京', '广州', '深圳']);
    assert.deepEqual(normalizeFilterList(' A.com, a.COM  b.com '), ['a.com', 'b.com']);
    const policy = buildSmartCollectTrafficPolicy(['didi-charging'], {
        trafficPolicy: { allowUrlKeywords: 'stationlist', blockUrlKeywords: 'custom-block' }
    });
    assert.equal(policy.blockUrlKeywords.includes('power-marketing'), true);
    assert.equal(policy.blockUrlKeywords.includes('custom-block'), true);
    assert.deepEqual(policy.allowUrlKeywords, ['stationlist']);
});

test('请求采集预检合并自动化、录包和自愈状态', async () => {
    const { calls, dependencies } = createDependencies({
        captureRecorderService: {
            getStatus: () => ({ available: false, binary: '', activeSession: null })
        },
        aiFeaturesEnabled: true,
        buildAiFeatureStatus: () => ({ enabled: true })
    });

    await withApp(dependencies, async baseUrl => {
        const result = await (await fetch(`${baseUrl}/api/smart-collect/preflight`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ platform: 'didi-charging', cities: '上海,北京' })
        })).json();

        assert.equal(result.success, true);
        assert.equal(result.data.canStart, false);
        assert.equal(result.data.captureRecorder.available, false);
        assert.equal(result.data.selfHeal.summary, 'self-heal:didi-charging');
        assert.equal(result.data.aiFeatures.enabled, true);
    });

    assert.deepEqual(calls.preflight[0], {
        platforms: ['didi-charging'],
        options: { cities: ['上海', '北京'], collectionMode: 'har' }
    });
});

test('请求采集启动会创建录包会话、规范化目标并附加到 smart session', async () => {
    const { calls, dependencies } = createDependencies();

    await withApp(dependencies, async baseUrl => {
        const missingPlatform = await fetch(`${baseUrl}/api/smart-collect/start`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ targets: ['上海'] })
        });
        assert.equal(missingPlatform.status, 400);
        assert.equal((await missingPlatform.json()).error, 'platforms required');

        const started = await (await fetch(`${baseUrl}/api/smart-collect/start`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                platform: 'didi-charging',
                targets: ['上海', '北京|广州'],
                scrollCount: 3,
                captureFilters: {
                    hosts: 'Energy.XiaoJuKeJi.com',
                    trafficPolicy: { blockUrlKeywords: 'custom-block' }
                }
            })
        })).json();

        assert.equal(started.success, true);
        assert.equal(started.sessionId, 's1');
        assert.equal(started.captureSession.id, 'cap-1');
    });

    assert.deepEqual(calls.startCapture[0].platforms, ['didi-charging']);
    assert.deepEqual(calls.startCapture[0].targets, ['上海', '北京', '广州']);
    assert.deepEqual(calls.startCapture[0].filters.hosts, ['energy.xiaojukeji.com']);
    assert.equal(calls.startCapture[0].trafficPolicy.blockUrlKeywords.includes('power-marketing'), true);
    assert.equal(calls.startCapture[0].trafficPolicy.blockUrlKeywords.includes('custom-block'), true);
    assert.deepEqual(calls.startSmart[0].options.cities, ['上海', '北京', '广州']);
    assert.equal(calls.startSmart[0].options.captureDuringScroll, true);
    assert.equal(calls.startSmart[0].options.scrollCount, 3);
    assert.equal(calls.attached[0].sessionId, 's1');
});

test('页面采集、滚动、状态和会话列表保留原路径契约', async () => {
    const { calls, dependencies } = createDependencies();

    await withApp(dependencies, async baseUrl => {
        const pageStarted = await (await fetch(`${baseUrl}/api/page-collect/start`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ platform: 'didi-charging', city: '西安', scrollIntervalMin: 1000 })
        })).json();
        assert.equal(pageStarted.success, true);

        const scrollMissing = await fetch(`${baseUrl}/api/smart-collect/scroll`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}'
        });
        assert.equal(scrollMissing.status, 400);

        const scroll = await (await fetch(`${baseUrl}/api/smart-collect/scroll`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: 's1', scrollCount: 2, scrollInterval: 5 })
        })).json();
        assert.equal(scroll.success, true);

        const status = await (await fetch(`${baseUrl}/api/smart-collect/status/s1`)).json();
        assert.equal(status.success, true);
        const sessions = await (await fetch(`${baseUrl}/api/smart-collect/sessions`)).json();
        assert.equal(sessions.data.length >= 1, true);
    });

    assert.deepEqual(calls.pageOcr[0].platforms, ['didi-charging']);
    assert.equal(calls.pageOcr[0].options.pageCollectionMode, 'page-assisted');
    assert.deepEqual(calls.pageOcr[0].options.cities, '西安');
    assert.deepEqual(calls.scroll[0], { sessionId: 's1', scrollCount: 2, scrollInterval: 5 });
});

test('完成请求采集会停止录包并完成 HAR 自动分析、入库和模板保存', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-collect-har-'));
    const harPath = path.join(tempDir, 'session.har');
    fs.writeFileSync(harPath, JSON.stringify({
        log: {
            entries: [{
                request: {
                    url: 'https://energy.xiaojukeji.com/station-api/homepage/stationList'
                },
                response: {
                    content: { text: '{"stationName":"滴滴测试站","fastChargeNum":3}' }
                }
            }]
        }
    }));
    const { calls, dependencies, sessions } = createDependencies();
    sessions.s1.captureSession = { id: 'cap-1', platforms: ['didi-charging'], harPath };
    dependencies.captureRecorderService.stopSession = () => ({
        id: 'cap-1',
        captureSessionId: 'cap-1',
        platforms: ['didi-charging'],
        status: 'stopped',
        harPath
    });
    dependencies.captureRecorderService.waitForSession = async id => ({
        id,
        platforms: ['didi-charging'],
        status: 'stopped',
        harPath,
        stats: { requestCount: 1, recordedCount: 1 }
    });

    await withApp(dependencies, async baseUrl => {
        const finished = await (await fetch(`${baseUrl}/api/smart-collect/finish`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: 's1' })
        })).json();

        assert.equal(finished.success, true);
        assert.equal(finished.captureAnalysis.status, 'success');
        assert.equal(finished.captureAnalysis.entryCount, 1);
        assert.equal(finished.captureAnalysis.stationCount, 1);
        assert.equal(finished.captureAnalysis.learnedPatternCount, 1);
        assert.equal(finished.captureAnalysis.savedTemplateCount, 1);
    });

    assert.equal(calls.finalized[0].result.stopReason, 'finish');
    assert.equal(calls.parsed[0], harPath);
    assert.equal(calls.learned[0], harPath);
    assert.equal(calls.inserted[0][0].stationName, '滴滴测试站');
    assert.equal(calls.templates[0][0].name, 'didi-charging [list] - 方式二自动录包 #1');
    assert.equal(calls.analyses[0].analysis.status, 'success');
});
