'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blue-team-schedule-test-'));
process.env.DATABASE_PATH = path.join(tempDir, 'schedules.db');
process.env.DATA_ROOT = path.join(tempDir, 'data');

const db = require('../database/init');
const ScheduleModel = require('../models/schedule');
const SchedulerManager = require('../scheduler/manager');
const ScheduleApplicationService = require('../services/schedule-application-service');
const ScheduledValidationExecutor = require('../services/scheduled-validation-executor');
const { normalizeExecutableSchedule } = require('../services/scheduled-validation-policy');

test.after(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
});

function fakeCron() {
    const created = [];
    return {
        created,
        validate: expression => expression === '*/5 * * * *',
        schedule(expression, callback, options) {
            const task = {
                expression,
                callback,
                options,
                destroyed: false,
                getNextRun: () => new Date('2026-07-10T08:05:00.000Z'),
                destroy() { this.destroyed = true; },
                execute: callback,
            };
            created.push(task);
            return task;
        },
    };
}

function validationDefinition(overrides = {}) {
    return {
        name: '五分钟验证',
        platforms: ['didi-charging'],
        cronExpression: '*/5 * * * *',
        timezone: 'Asia/Shanghai',
        taskType: 'validation',
        payload: {
            chain: 'method3',
            mode: 'list',
            target: {
                city: '西安',
                lat: 34.3416,
                lng: 108.9398,
                coordinateSystem: 'WGS84',
                radiusKm: 20,
            },
            maxPages: 1,
            maxRequestCount: 2,
            maxQps: 0.5,
        },
        enabled: true,
        ...overrides,
    };
}

test('持久化调度支持 cron 校验、重启恢复、启停和删除', async () => {
    const cron = fakeCron();
    const executions = [];
    const manager = new SchedulerManager({
        repository: ScheduleModel,
        executor: { execute: async schedule => {
            executions.push(schedule);
            return { status: 'success', count: 2 };
        } },
        cron,
        restoreOnStart: false,
    });

    assert.throws(() => manager.createSchedule({
        name: 'invalid', platforms: ['didi-charging'], cronExpression: 'bad', timezone: 'Asia/Shanghai',
    }), error => error.code === 'schedule_cron_invalid');
    assert.throws(() => manager.createSchedule({
        name: 'invalid', platforms: ['didi-charging'], cronExpression: '*/5 * * * *', timezone: 'Invalid/Zone',
    }), error => error.code === 'schedule_timezone_invalid');

    const created = manager.createSchedule(validationDefinition());
    assert.equal(created.id, 1);
    assert.equal(cron.created[0].options.noOverlap, true);
    assert.equal(cron.created[0].options.timezone, 'Asia/Shanghai');
    assert.equal(ScheduleModel.getById(1).nextRun, '2026-07-10T08:05:00.000Z');

    const run = await manager.runNow(1);
    assert.equal(run.result.status, 'success');
    assert.equal(ScheduleModel.getById(1).lastStatus, 'success');
    assert.equal(executions[0].triggerReason, 'manual');

    const disabled = manager.toggleSchedule(1, false);
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.nextRun, null);
    assert.equal(cron.created[0].destroyed, true);

    manager.toggleSchedule(1, true);
    manager.shutdown();
    const restoredCron = fakeCron();
    const restored = new SchedulerManager({
        repository: ScheduleModel,
        executor: { execute: async () => ({ status: 'success' }) },
        cron: restoredCron,
        restoreOnStart: true,
    });
    assert.equal(restored.tasks.size, 1);
    assert.equal(restoredCron.created.length, 1);
    restored.deleteSchedule(1);
    assert.equal(ScheduleModel.getById(1), null);
    restored.shutdown();
});

test('调度阻止重叠执行并持久化脱敏失败状态', async () => {
    const cron = fakeCron();
    let release;
    const manager = new SchedulerManager({
        repository: ScheduleModel,
        executor: { execute: () => new Promise(resolve => { release = resolve; }) },
        cron,
        restoreOnStart: false,
    });
    const schedule = manager.createSchedule(validationDefinition({ name: '重叠测试' }));
    const first = manager.runNow(schedule.id);
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(manager.runNow(schedule.id), error => error.code === 'schedule_already_running');
    release({ status: 'partial' });
    await first;

    manager.executor = { execute: async () => { throw new Error('Bearer schedule-secret-token'); } };
    await assert.rejects(manager.runNow(schedule.id), /schedule-secret-token/);
    const failed = ScheduleModel.getById(schedule.id);
    assert.equal(failed.lastStatus, 'failed');
    assert.equal(failed.lastError.includes('schedule-secret-token'), false);
    manager.deleteSchedule(schedule.id);
    manager.shutdown();
});

test('启动恢复会隔离不完整的历史任务而不阻断其他任务', () => {
    const valid = ScheduleModel.create(validationDefinition({ name: '有效任务' }));
    const invalid = ScheduleModel.create(validationDefinition({
        name: '旧任务',
        payload: {},
    }));
    const warnings = [];
    const cron = fakeCron();
    const manager = new SchedulerManager({
        repository: ScheduleModel,
        executor: {
            validate: normalizeExecutableSchedule,
            execute: async () => ({ status: 'success' }),
        },
        cron,
        logger: {
            warn: message => warnings.push(message),
            error: () => {},
        },
        restoreOnStart: true,
    });

    assert.equal(manager.tasks.has(valid.id), true);
    assert.equal(manager.tasks.has(invalid.id), false);
    const quarantined = ScheduleModel.getById(invalid.id);
    assert.equal(quarantined.enabled, false);
    assert.equal(quarantined.lastStatus, 'configuration_required');
    assert.equal(warnings.length, 1);

    manager.deleteSchedule(valid.id);
    manager.deleteSchedule(invalid.id);
    manager.shutdown();
});

test('调度应用服务限制平台和载荷并完成诊断演练', () => {
    let deletedRecoveryId = null;
    const stored = {
        id: 9, name: '任务', platforms: ['didi-charging'], cronExpression: '*/5 * * * *', enabled: true,
    };
    const scheduler = {
        listSchedules: () => [stored],
        createSchedule: input => ({ ...stored, ...input }),
        getSchedule: id => id === 9 ? stored : null,
        toggleSchedule: (id, enabled) => ({ ...stored, enabled }),
        deleteSchedule: () => {},
        startNow: () => ({ scheduleId: 9, status: 'accepted' }),
    };
    const selfHealService = {
        enrichSchedule: value => value,
        diagnose: () => ({ status: 'recoverable', currentChainLabel: '页面采集' }),
        recordDiagnosis: () => ({ createdAt: '2026-07-10T00:00:00Z' }),
    };
    const service = new ScheduleApplicationService({
        scheduler,
        selfHealService,
        appSettingModel: {
            saveSelfHealSettings: () => {},
            saveScheduleRecovery: (id, recovery) => recovery,
            deleteScheduleRecovery: id => { deletedRecoveryId = id; },
        },
        getPlatformIds: () => ['didi-charging'],
    });
    assert.throws(() => service.create({
        name: '错误平台', platforms: ['unknown'], cronExpression: '*/5 * * * *',
        payload: { chain: 'method3', target: { city: '上海', lat: 31.2, lng: 121.4 } },
    }), error => error.code === 'schedule_platforms_invalid');
    const created = service.create({
        name: '任务', platforms: ['didi-charging'], cronExpression: '*/5 * * * *',
        payload: { chain: 'method3', target: { city: '上海', lat: 31.2, lng: 121.4 } },
    });
    assert.equal(created.timezone, 'Asia/Shanghai');
    assert.throws(() => service.create({
        name: '超预算任务', platforms: ['didi-charging'], cronExpression: '*/5 * * * *',
        payload: {
            chain: 'method3',
            target: { city: '上海', lat: 31.2, lng: 121.4 },
            maxRequestCount: 6,
        },
    }), error => error.code === 'schedule_request_limit_invalid');
    assert.equal(service.drill(9).diagnosis.status, 'recoverable');
    service.delete(9);
    assert.equal(deletedRecoveryId, 9);
});

test('定时验证执行器只运行 method3 并写入运行历史', async () => {
    const events = [];
    const orchestratorInputs = [];
    let startCount = 0;
    const executor = new ScheduledValidationExecutor({
        orchestrator: {
            run: async input => {
                orchestratorInputs.push(input);
                return input.target.platform === 'failed'
                    ? { success: false, run: { id: 'chain-failed', status: 'failed', reason: 'request_failed' } }
                    : { success: true, run: { id: 'chain-ok', status: 'passed', reason: 'chain_passed' } };
            },
        },
        runHistoryModel: {
            startRun: () => { startCount += 1; return 21; },
            appendLog: (...args) => events.push(['log', ...args]),
            finishRun: (...args) => events.push(['finish', ...args]),
        },
    });
    const result = await executor.execute({
        id: 1,
        name: '任务',
        taskType: 'validation',
        platforms: ['didi-charging', 'failed'],
        payload: {
            chain: 'method3',
            target: {
                city: '上海',
                lat: 31.2,
                lng: 121.4,
                coordinateSystem: 'GCJ02',
            },
            maxPages: 1,
            maxRequestCount: 2,
            maxQps: 0.5,
        },
    });
    assert.equal(result.status, 'partial');
    assert.equal(result.successCount, 1);
    assert.equal(result.failedCount, 1);
    assert.equal(events.at(-1)[0], 'finish');
    assert.equal(events.at(-1)[2], 'partial');
    assert.equal(orchestratorInputs[0].target.maxRequestCount, 2);
    assert.equal(orchestratorInputs[0].target.maxQps, 0.5);
    assert.equal(orchestratorInputs[0].target.coordinateSystem, 'GCJ02');

    await assert.rejects(executor.execute({
        taskType: 'validation',
        platforms: ['didi-charging'],
        payload: { chain: 'method3' },
    }), error => error.code === 'schedule_target_invalid');
    assert.equal(startCount, 1);
});
