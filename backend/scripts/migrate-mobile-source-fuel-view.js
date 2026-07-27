#!/usr/bin/env node
'use strict';

const mysql = require('mysql2/promise');
const {
    MIGRATION_NAME,
    MobileSourceFuelViewMigrator,
    TARGET_SCHEMA_VERSION,
} = require('../services/mobile-source-fuel-view-migrator');
const {
    SHARED_OWNER_OPT_IN,
    validateMigrationIdentityPolicy,
} = require('../services/mobile-source-migration-identity-policy');

function required(env, key) {
    const value = String(env[key] || '').trim();
    if (!value) throw new Error(`required migration setting is missing: ${key}`);
    return value;
}

function connectionConfig(env) {
    const user = required(env, 'MOBILE_SOURCE_MIGRATION_MYSQL_USER');
    const database = required(env, 'MOBILE_SOURCE_MIGRATION_MYSQL_DATABASE');
    validateMigrationIdentityPolicy({
        migrationUser: user,
        runtimeUser: required(env, 'MOBILE_SOURCE_RUNTIME_MYSQL_USER'),
        migrationDatabase: database,
        runtimeDatabase: required(env, 'MOBILE_SOURCE_RUNTIME_MYSQL_DATABASE'),
        allowSharedOwnerMigration: env[SHARED_OWNER_OPT_IN],
    });
    const port = Number(env.MOBILE_SOURCE_MIGRATION_MYSQL_PORT || 3306);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('migration MySQL port is invalid');
    }
    return {
        host: String(env.MOBILE_SOURCE_MIGRATION_MYSQL_HOST || '127.0.0.1').trim(),
        port,
        user,
        password: required(env, 'MOBILE_SOURCE_MIGRATION_MYSQL_PASSWORD'),
        database,
        charset: 'utf8mb4',
        timezone: 'Z',
        multipleStatements: false,
    };
}

async function runCli(options = {}) {
    const argv = options.argv || process.argv.slice(2);
    const env = options.env || process.env;
    const logger = options.logger || console.log;
    const mode = argv.includes('--validate-only')
        ? 'validate'
        : (argv.includes('--plan') || argv.includes('--dry-run') ? 'plan' : 'apply');
    if (argv.some(value => !['--validate-only', '--plan', '--dry-run', '--apply'].includes(value))) {
        throw new Error('unsupported migration argument');
    }
    if (mode === 'plan') {
        connectionConfig(env);
        logger(`${MIGRATION_NAME}: create or validate read-only view, schema v${TARGET_SCHEMA_VERSION}`);
        return { mode, schemaVersion: TARGET_SCHEMA_VERSION };
    }

    const connection = await (options.mysqlModule || mysql).createConnection(connectionConfig(env));
    try {
        const migrator = new MobileSourceFuelViewMigrator({ connection });
        const result = mode === 'validate'
            ? await migrator.validate()
            : await migrator.migrate();
        logger(`mobile-source fuel view ${mode} passed`);
        return { mode, ...result };
    } finally {
        await connection.end();
    }
}

if (require.main === module) {
    runCli().catch(error => {
        console.error(`47 fuel view migration failed [${String(error.code || 'migration_failed')}]`);
        process.exitCode = 1;
    });
}

module.exports = { connectionConfig, runCli };
