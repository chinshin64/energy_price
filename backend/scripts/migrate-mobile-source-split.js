#!/usr/bin/env node
'use strict';

// v5 拆表迁移 CLI：在 v4 迁移完成后执行，创建充电/燃油拆分表 + 全局游标表，
// 并将子表 fuel_offers/fuel_quotes 的 FK 改指向 fuel_snapshots。
// 47 全清重建场景：先 DROP 所有 mobile_ocr_* 表，再依次跑 v4 + v5。

const mysql = require('mysql2/promise');
const {
    MIGRATION_NAME,
    MIGRATION_PLAN,
    MobileSourceSplitMigrator,
    TARGET_SCHEMA_VERSION,
} = require('../services/mobile-source-split-migrator');
const {
    SHARED_OWNER_OPT_IN,
    validateMigrationIdentityPolicy,
} = require('../services/mobile-source-migration-identity-policy');

function cliError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function parseMode(argv = []) {
    const flags = new Set(argv);
    const allowed = new Set(['--dry-run', '--plan', '--validate-only', '--apply']);
    for (const flag of flags) {
        if (!allowed.has(flag)) {
            throw cliError('mobile_source_split_argument_invalid', 'unsupported split migration argument');
        }
    }
    if (flags.has('--dry-run') || flags.has('--plan')) return 'plan';
    if (flags.has('--validate-only')) return 'validate';
    return 'apply';
}

function requiredEnvironment(env, key) {
    const value = String(env[key] || '').trim();
    if (!value) {
        throw cliError(
            'mobile_source_split_configuration_required',
            `required split migration setting is missing: ${key}`
        );
    }
    return value;
}

function validateMigrationIdentityEnvironment(env = process.env) {
    return validateMigrationIdentityPolicy({
        migrationUser: requiredEnvironment(env, 'MOBILE_SOURCE_MIGRATION_MYSQL_USER'),
        runtimeUser: requiredEnvironment(env, 'MOBILE_SOURCE_RUNTIME_MYSQL_USER'),
        migrationDatabase: requiredEnvironment(env, 'MOBILE_SOURCE_MIGRATION_MYSQL_DATABASE'),
        runtimeDatabase: requiredEnvironment(env, 'MOBILE_SOURCE_RUNTIME_MYSQL_DATABASE'),
        allowSharedOwnerMigration: env[SHARED_OWNER_OPT_IN],
    });
}

function buildMigrationConnectionConfig(env = process.env) {
    const port = Number(
        env.MOBILE_SOURCE_MIGRATION_MYSQL_PORT
        || env.MOBILE_SOURCE_MYSQL_PORT
        || 3306
    );
    const migrationUser = requiredEnvironment(env, 'MOBILE_SOURCE_MIGRATION_MYSQL_USER');
    validateMigrationIdentityEnvironment(env);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        throw cliError(
            'mobile_source_split_configuration_invalid',
            'split migration MySQL port is invalid'
        );
    }
    return {
        host: String(
            env.MOBILE_SOURCE_MIGRATION_MYSQL_HOST
            || env.MOBILE_SOURCE_MYSQL_HOST
            || '127.0.0.1'
        ).trim(),
        port,
        user: migrationUser,
        password: requiredEnvironment(env, 'MOBILE_SOURCE_MIGRATION_MYSQL_PASSWORD'),
        database: requiredEnvironment(env, 'MOBILE_SOURCE_MIGRATION_MYSQL_DATABASE'),
        charset: 'utf8mb4',
        timezone: 'Z',
        multipleStatements: false,
    };
}

function writePlan(logger = console.log) {
    logger(
        `mobile-source split migration plan: ${MIGRATION_NAME}, target schema v${TARGET_SCHEMA_VERSION}`
    );
    for (const step of MIGRATION_PLAN) logger(`- ${step}`);
}

async function runCli(options = {}) {
    const argv = options.argv || process.argv.slice(2);
    const env = options.env || process.env;
    const mysqlModule = options.mysqlModule || mysql;
    const logger = options.logger || console.log;
    const mode = parseMode(argv);
    if (mode === 'plan') {
        validateMigrationIdentityEnvironment(env);
        writePlan(logger);
        return { mode, schemaVersion: TARGET_SCHEMA_VERSION };
    }

    const connection = await mysqlModule.createConnection(buildMigrationConnectionConfig(env));
    try {
        const migrator = new MobileSourceSplitMigrator({ connection });
        if (mode === 'validate') {
            const result = await migrator.validate();
            logger(`mobile-source split schema v${result.schemaVersion} validation passed`);
            return { mode, ...result };
        }
        const result = await migrator.migrate();
        logger(`mobile-source split schema v${result.schemaVersion} migration passed`);
        return { mode, ...result };
    } finally {
        await connection.end();
    }
}

if (require.main === module) {
    runCli().catch(error => {
        const code = /^[a-z0-9_]+$/i.test(String(error?.code || ''))
            ? error.code
            : 'mobile_source_split_migration_failed';
        console.error(`47 split migration failed [${code}]`);
        process.exitCode = 1;
    });
}

module.exports = {
    buildMigrationConnectionConfig,
    parseMode,
    runCli,
    validateMigrationIdentityEnvironment,
    writePlan,
};
