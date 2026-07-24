'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const Database = require('better-sqlite3');
const { MIGRATIONS } = require('../database/migrations');

const backendRoot = path.resolve(__dirname, '..');

function runNode(args, env) {
    return spawnSync(process.execPath, args, {
        cwd: backendRoot,
        env: { ...process.env, ...env },
        encoding: 'utf8',
    });
}

test('生产启动拒绝待迁移数据库，CLI 备份应用后允许启动', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'blue-team-schema-cli-'));
    const databasePath = path.join(tempRoot, 'legacy.db');
    const commonEnv = { DATABASE_PATH: databasePath };
    try {
        const bootstrap = runNode(['-e', "const db=require('./database/init'); db.close();"], {
            ...commonEnv,
            NODE_ENV: 'test',
            DATABASE_MIGRATION_MODE: 'apply',
        });
        assert.equal(bootstrap.status, 0, bootstrap.stderr);

        const legacy = new Database(databasePath);
        legacy.exec('DROP TABLE schema_migrations; PRAGMA user_version = 0;');
        legacy.close();

        const rejected = runNode(['-e', "require('./database/init');"], {
            ...commonEnv,
            NODE_ENV: 'production',
            DATABASE_MIGRATION_MODE: '',
        });
        assert.notEqual(rejected.status, 0);
        assert.match(rejected.stderr, /Database migrations are pending/);

        const dryRun = runNode(['scripts/migrate-database.js'], {
            ...commonEnv,
            NODE_ENV: 'production',
        });
        assert.equal(dryRun.status, 0, dryRun.stderr);
        assert.match(dryRun.stdout, /"mode": "dry-run"/);
        assert.match(dryRun.stdout, /commercial_schema_normalization/);

        const applied = runNode(['scripts/migrate-database.js', '--apply'], {
            ...commonEnv,
            NODE_ENV: 'production',
        });
        assert.equal(applied.status, 0, applied.stderr);
        assert.match(applied.stdout, /"changed": true/);
        const backups = fs.readdirSync(tempRoot).filter(file => file.endsWith('.bak'));
        assert.equal(backups.length, 1);
        assert.equal(fs.statSync(path.join(tempRoot, backups[0])).mode & 0o777, 0o600);

        const ready = runNode(['-e', "const db=require('./database/init'); db.close();"], {
            ...commonEnv,
            NODE_ENV: 'production',
            DATABASE_MIGRATION_MODE: '',
        });
        assert.equal(ready.status, 0, ready.stderr);
        assert.match(ready.stdout, new RegExp(`schema v${MIGRATIONS.at(-1).version}, validate`));
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});
