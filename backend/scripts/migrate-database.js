'use strict';

const fs = require('node:fs');
const Database = require('better-sqlite3');
const { MIGRATIONS, getMigrationPlan } = require('../database/migrations');
const { resolveDatabasePath } = require('../database/path');

function timestamp() {
    return new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
}

function inspectPlan(databasePath) {
    if (!fs.existsSync(databasePath)) {
        return {
            currentVersion: 0,
            targetVersion: MIGRATIONS.at(-1)?.version || 0,
            applied: [],
            pending: MIGRATIONS.map(migration => ({ version: migration.version, name: migration.name })),
        };
    }
    const db = new Database(databasePath, { readonly: true, fileMustExist: true });
    try {
        return getMigrationPlan(db);
    } finally {
        db.close();
    }
}

async function createBackup(databasePath) {
    const backupPath = `${databasePath}.pre-schema-v${MIGRATIONS.at(-1)?.version || 0}-${timestamp()}.bak`;
    const db = new Database(databasePath, { fileMustExist: true });
    try {
        await db.backup(backupPath);
    } finally {
        db.close();
    }
    fs.chmodSync(backupPath, 0o600);
    return backupPath;
}

async function main(argv = process.argv.slice(2)) {
    const apply = argv.includes('--apply');
    const databasePath = resolveDatabasePath();
    if (databasePath === ':memory:') {
        throw new Error('Schema migration CLI requires a persistent SQLite database');
    }
    const before = inspectPlan(databasePath);
    if (!apply) {
        console.log(JSON.stringify({
            success: true,
            mode: 'dry-run',
            databasePath,
            currentVersion: before.currentVersion,
            targetVersion: before.targetVersion,
            pending: before.pending,
        }, null, 2));
        return;
    }
    if (before.pending.length === 0) {
        console.log(JSON.stringify({
            success: true,
            mode: 'apply',
            changed: false,
            databasePath,
            currentVersion: before.currentVersion,
            targetVersion: before.targetVersion,
        }, null, 2));
        return;
    }

    const backupPath = fs.existsSync(databasePath) ? await createBackup(databasePath) : null;
    process.env.DATABASE_MIGRATION_MODE = 'apply';
    const database = require('../database/init');
    try {
        console.log(JSON.stringify({
            success: true,
            mode: 'apply',
            changed: true,
            databasePath,
            backupPath,
            previousVersion: before.currentVersion,
            currentVersion: database.applicationSchemaVersion,
        }, null, 2));
    } finally {
        database.close();
    }
}

if (require.main === module) {
    main().catch(error => {
        console.error(JSON.stringify({
            success: false,
            error: error.message,
            code: error.code || 'database_migration_failed',
        }, null, 2));
        process.exitCode = 1;
    });
}

module.exports = { createBackup, inspectPlan, main, timestamp };
