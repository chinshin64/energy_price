'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');
const { createSystemRouter } = require('../routes/system');

async function withServer(router, callback, auth = {}) {
    const app = express();
    app.use((req, res, next) => {
        req.auth = {
            subject: 'operator-1',
            email: 'operator@example.test',
            roles: ['operator'],
            scopes: ['project:demo'],
            mode: 'trusted-proxy',
            ...auth
        };
        next();
    });
    app.use('/api', router);
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

function createDb(options = {}) {
    return {
        applicationSchemaVersion: options.schemaVersion || 3,
        applicationMigrationMode: options.migrationMode || 'apply',
        prepare(sql) {
            assert.equal(sql, 'SELECT 1 AS ready');
            if (options.throwOnPrepare) {
                throw new Error('database unavailable');
            }
            return { get: () => ({ ready: 1 }) };
        },
        pragma(sql, optionsArg) {
            assert.equal(sql, 'user_version');
            assert.deepEqual(optionsArg, { simple: true });
            return 3;
        }
    };
}

test('系统 Router 保留健康检查、readiness 和会话契约', async () => {
    const router = createSystemRouter({
        db: createDb({ schemaVersion: 7, migrationMode: 'validate' }),
        authConfig: { mode: 'trusted-proxy' },
        version: 'test-build',
        now: () => '2026-07-13T00:00:00.000Z'
    });

    await withServer(router, async baseUrl => {
        const health = await (await fetch(`${baseUrl}/api/health`)).json();
        assert.deepEqual(health, {
            status: 'ok',
            version: 'test-build',
            timestamp: '2026-07-13T00:00:00.000Z'
        });

        const readiness = await (await fetch(`${baseUrl}/api/readiness`)).json();
        assert.deepEqual(readiness, {
            status: 'ready',
            database: 'ready',
            schemaVersion: 7,
            migrationMode: 'validate',
            authMode: 'trusted-proxy',
            timestamp: '2026-07-13T00:00:00.000Z'
        });

        const session = await (await fetch(`${baseUrl}/api/auth/session`)).json();
        assert.deepEqual(session, {
            success: true,
            data: {
                subject: 'operator-1',
                email: 'operator@example.test',
                roles: ['operator'],
                scopes: ['project:demo'],
                mode: 'trusted-proxy'
            }
        });
    });
});

test('系统 Router 在数据库不可用时返回 not_ready', async () => {
    const router = createSystemRouter({
        db: createDb({ throwOnPrepare: true }),
        authConfig: { mode: 'disabled' },
        now: () => '2026-07-13T00:00:00.000Z'
    });

    await withServer(router, async baseUrl => {
        const response = await fetch(`${baseUrl}/api/readiness`);
        assert.equal(response.status, 503);
        assert.deepEqual(await response.json(), {
            status: 'not_ready',
            database: 'unavailable'
        });
    });
});
