#!/usr/bin/env node
'use strict';

const mysql = require('mysql2/promise');
const {
    MIGRATION_NAME,
    MIGRATION_PLAN,
    MobileSourceFuelWideMigrator,
    TARGET_SCHEMA_VERSION,
} = require('../services/mobile-source-fuel-wide-migrator');
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
    const allowed = new Set([
        '--dry-run',
        '--plan',
        '--apply',
        '--backfill-only',
        '--validate-only',
    ]);
    for (const flag of flags) {
        if (!allowed.has(flag)) {
            throw cliError(
                'mobile_source_fuel_wide_argument_invalid',
                'unsupported fuel wide migration argument'
            );
        }
    }
    const selected = [
        flags.has('--apply') && 'apply',
        flags.has('--backfill-only') && 'backfill',
        flags.has('--validate-only') && 'validate',
    ].filter(Boolean);
    if (selected.length > 1) {
        throw cliError(
            'mobile_source_fuel_wide_argument_invalid',
            'fuel wide migration modes are mutually exclusive'
        );
    }
    return selected[0] || 'plan';
}

function requiredEnvironment(env, key) {
    const value = String(env[key] || '').trim();
    if (!value) {
        throw cliError(
            'mobile_source_fuel_wide_configuration_required',
            `required migration setting is missing: ${key}`
        );
    }
    return value;
}

function validateMigrationIdentityEnvironment(env = process.env) {
    return validateMigrationIdentityPolicy({
        migrationUser: requiredEnvironment(env, 'MOBILE_SOURCE_MIGRATION_MYSQL_USER'),
        runtimeUser: requiredEnvironment(env, 'MOBILE_SOURCE_RUNTIME_MYSQL_USER'),
        migrationDatabase: requiredEnvironment(
            env,
            'MOBILE_SOURCE_MIGRATION_MYSQL_DATABASE'
        ),
        runtimeDatabase: requiredEnvironment(
            env,
            'MOBILE_SOURCE_RUNTIME_MYSQL_DATABASE'
        ),
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
            'mobile_source_fuel_wide_configuration_invalid',
            'fuel wide migration MySQL port is invalid'
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
        `mobile-source fuel wide migration plan: ${MIGRATION_NAME}, component v${TARGET_SCHEMA_VERSION}`
    );
    for (const step of MIGRATION_PLAN) logger(`- ${step}`);
}

async function runCli(options = {}) {
    const argv = options.argv || process.argv.slice(2);
    const env = options.env || process.env;
    const logger = options.logger || console.log;
    const mysqlModule = options.mysqlModule || mysql;
    const mode = parseMode(argv);
    if (mode === 'plan') {
        validateMigrationIdentityEnvironment(env);
        writePlan(logger);
        return { mode, schemaVersion: TARGET_SCHEMA_VERSION };
    }
    const connection = await mysqlModule.createConnection(
        buildMigrationConnectionConfig(env)
    );
    try {
        const migrator = new MobileSourceFuelWideMigrator({ connection });
        if (mode === 'validate') {
            const result = await migrator.validate();
            logger(`mobile-source fuel wide component v${result.schemaVersion} validation passed`);
            return { mode, ...result };
        }
        if (mode === 'backfill') {
            const result = await migrator.backfill();
            logger(`mobile-source fuel wide backfill passed; affected rows: ${result.affectedRows}`);
            return { mode, schemaVersion: TARGET_SCHEMA_VERSION, ...result };
        }
        const result = await migrator.migrate();
        logger(`mobile-source fuel wide component v${result.schemaVersion} migration passed`);
        return { mode, ...result };
    } finally {
        await connection.end();
    }
}

if (require.main === module) {
    runCli().catch(error => {
        const code = /^[a-z0-9_]+$/i.test(String(error?.code || ''))
            ? error.code
            : 'mobile_source_fuel_wide_migration_failed';
        console.error(`fuel wide migration failed [${code}]`);
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
