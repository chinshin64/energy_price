'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blue-team-audit-test-'));
process.env.DATABASE_PATH = path.join(tempDir, 'audit.db');

const db = require('../database/init');
const AuditEventModel = require('../models/audit-event');

test.after(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
});

test('审计事件可查询且元数据统一脱敏', () => {
    AuditEventModel.record({
        eventId: 'event-12345678',
        requestId: 'request-12345678',
        actorId: 'operator-1',
        authMode: 'oidc',
        roles: ['operator'],
        action: 'POST',
        resource: 'global-agent/actions/execute',
        method: 'POST',
        path: '/api/global-agent/actions/execute',
        statusCode: 200,
        outcome: 'success',
        durationMs: 12,
        metadata: { token: 'must-not-store', actionId: 'action-1' }
    });

    const rows = AuditEventModel.list({ actorId: 'operator-1' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].requestId, 'request-12345678');
    assert.deepEqual(rows[0].roles, ['operator']);
    assert.equal(rows[0].metadata.token, '**redacted**');
    assert.equal(JSON.stringify(rows[0]).includes('must-not-store'), false);
});
