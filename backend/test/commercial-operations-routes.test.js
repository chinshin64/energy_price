'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');
const { createTemplatesRouter } = require('../routes/templates');
const { createSchedulesRouter } = require('../routes/schedules');
const { createExportRouter } = require('../routes/export');

async function withApp(configure, callback) {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.requestId = 'request-commercial-ops-0001';
        next();
    });
    configure(app);
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
    });
    try {
        await callback(`http://127.0.0.1:${server.address().port}`);
    } finally {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
}

test('模板固定平台路由优先于动态 ID，并返回稳定 400/404', async () => {
    const calls = [];
    const service = {
        create: () => ({ templateId: 1, created: true }),
        createBatch: () => ({ successCount: 1 }),
        list: () => [],
        deduplicate: () => ({ dryRun: true, removedCount: 0, duplicateGroupCount: 0 }),
        listByPlatform: platform => {
            calls.push(['platform', platform]);
            return [{ platform }];
        },
        get: id => {
            calls.push(['id', id]);
            return id === 1 ? { id } : null;
        },
        update: () => ({ changes: 1 }),
        delete: () => {},
        use: async () => ({ stationCount: 0 }),
    };
    await withApp(app => app.use('/api/templates', createTemplatesRouter({ service })), async baseUrl => {
        const platform = await fetch(`${baseUrl}/api/templates/platform/didi-charging`);
        assert.equal(platform.status, 200);
        assert.deepEqual(calls, [['platform', 'didi-charging']]);

        const invalid = await fetch(`${baseUrl}/api/templates/not-an-id`);
        assert.equal(invalid.status, 400);
        assert.equal((await invalid.json()).code, 'template_id_invalid');
        const missing = await fetch(`${baseUrl}/api/templates/2`);
        assert.equal(missing.status, 404);
        assert.equal((await missing.json()).code, 'template_not_found');
    });
});

test('调度 Router 提供创建、立即运行、演练、启停和删除契约', async () => {
    const calls = [];
    const service = {
        list: () => [],
        create: body => ({ id: 1, ...body }),
        startNow: id => {
            calls.push(['run', id]);
            return { scheduleId: id, status: 'accepted' };
        },
        drill: id => ({ schedule: { id }, diagnosis: {} }),
        delete: id => calls.push(['delete', id]),
        toggle: (id, enabled) => {
            calls.push(['toggle', id, enabled]);
            return { id, enabled };
        },
    };
    await withApp(app => app.use('/api/schedules', createSchedulesRouter({ service })), async baseUrl => {
        const created = await fetch(`${baseUrl}/api/schedules`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: '任务' }),
        });
        assert.equal(created.status, 201);
        assert.equal((await fetch(`${baseUrl}/api/schedules/1/run`, { method: 'POST' })).status, 202);
        assert.equal((await fetch(`${baseUrl}/api/schedules/1/drill`, { method: 'POST' })).status, 200);
        assert.equal((await fetch(`${baseUrl}/api/schedules/1/toggle`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ enabled: false }),
        })).status, 200);
        assert.equal((await fetch(`${baseUrl}/api/schedules/1`, { method: 'DELETE' })).status, 200);
        assert.equal((await fetch(`${baseUrl}/api/schedules/0/run`, { method: 'POST' })).status, 400);
        assert.deepEqual(calls, [['run', 1], ['toggle', 1, false], ['delete', 1]]);
    });
});

test('导出 Router 流式返回总数、行数和截断状态', async () => {
    const service = {
        prepare: () => ({
            filename: 'stations-all-2026-07-10.csv',
            totalRows: 2,
            exportRows: 1,
            truncated: true,
            lines: ['\uFEFFA,B\r\n', '1,2\r\n'],
        }),
    };
    await withApp(app => app.use('/api/export', createExportRouter({ service })), async baseUrl => {
        const response = await fetch(`${baseUrl}/api/export/csv`);
        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-type'), /text\/csv/);
        assert.equal(response.headers.get('x-export-total-rows'), '2');
        assert.equal(response.headers.get('x-export-row-count'), '1');
        assert.equal(response.headers.get('x-export-truncated'), 'true');
        assert.match(await response.text(), /A,B/);
    });
});
