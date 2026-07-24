#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const dotenv = require('dotenv');
const {
    SHARED_OWNER_OPT_IN,
    validateMigrationIdentityPolicy,
} = require('../services/mobile-source-migration-identity-policy');

function contractError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function requiredValue(values, key) {
    const value = String(values[key] || '').trim();
    if (!value) {
        throw contractError(
            'mobile_source_deployment_configuration_required',
            `required protected environment setting is missing: ${key}`
        );
    }
    return value;
}

function validateDeploymentEnvironment({
    runtime = {},
    migration = {},
    expectedHost,
    expectedPort,
} = {}) {
    const runtimeRequired = [
        'MOBILE_SOURCE_INGEST_TOKEN',
        'MOBILE_SOURCE_SYNC_TOKEN',
        'MOBILE_SOURCE_MYSQL_USER',
        'MOBILE_SOURCE_MYSQL_PASSWORD',
        'MOBILE_SOURCE_MYSQL_DATABASE',
    ];
    const migrationRequired = [
        'MOBILE_SOURCE_MIGRATION_MYSQL_USER',
        'MOBILE_SOURCE_MIGRATION_MYSQL_PASSWORD',
        'MOBILE_SOURCE_MIGRATION_MYSQL_DATABASE',
    ];
    for (const key of runtimeRequired) requiredValue(runtime, key);
    for (const key of migrationRequired) requiredValue(migration, key);

    if (String(runtime.MOBILE_SOURCE_HOST || '').trim() !== String(expectedHost || '').trim()) {
        throw contractError(
            'mobile_source_deployment_runtime_host_invalid',
            'runtime host must preserve the nginx loopback topology'
        );
    }
    if (String(runtime.MOBILE_SOURCE_PORT || '').trim() !== String(expectedPort || '').trim()) {
        throw contractError(
            'mobile_source_deployment_runtime_port_invalid',
            'runtime port must preserve the nginx upstream topology'
        );
    }
    if (
        String(runtime.MOBILE_SOURCE_FUEL_QUOTE_V1_ENABLED || '').trim().toLowerCase()
        !== 'false'
    ) {
        throw contractError(
            'mobile_source_deployment_fuel_quote_feature_invalid',
            'fuel-quote-v1 must be explicitly disabled during deployment'
        );
    }
    if (
        runtime.MOBILE_SOURCE_FUEL_QUOTE_V1_PLATFORMS
        && runtime.MOBILE_SOURCE_FUEL_QUOTE_V1_PLATFORMS !== 'tuanyou,amap-fuel'
    ) {
        throw contractError(
            'mobile_source_deployment_fuel_quote_allowlist_invalid',
            'fuel quote platform allowlist is invalid'
        );
    }
    if (
        Object.prototype.hasOwnProperty.call(runtime, SHARED_OWNER_OPT_IN)
        && String(runtime[SHARED_OWNER_OPT_IN] || '').trim()
    ) {
        throw contractError(
            'mobile_source_migration_shared_owner_opt_in_scope_invalid',
            `${SHARED_OWNER_OPT_IN} belongs only in the protected migration environment`
        );
    }

    const identity = validateMigrationIdentityPolicy({
        migrationUser: migration.MOBILE_SOURCE_MIGRATION_MYSQL_USER,
        runtimeUser: runtime.MOBILE_SOURCE_MYSQL_USER,
        migrationDatabase: migration.MOBILE_SOURCE_MIGRATION_MYSQL_DATABASE,
        runtimeDatabase: runtime.MOBILE_SOURCE_MYSQL_DATABASE,
        allowSharedOwnerMigration: migration[SHARED_OWNER_OPT_IN],
    });
    if (
        requiredValue(runtime, 'MOBILE_SOURCE_INGEST_TOKEN')
        === requiredValue(runtime, 'MOBILE_SOURCE_SYNC_TOKEN')
    ) {
        throw contractError(
            'mobile_source_deployment_token_separation_required',
            'ingest and source-sync tokens must be different'
        );
    }
    return Object.freeze({ identityMode: identity.mode });
}

function loadEnvironmentFile(pathname) {
    return dotenv.parse(fs.readFileSync(pathname));
}

function runCli({
    argv = process.argv.slice(2),
    logger = console.log,
} = {}) {
    if (argv.length !== 4) {
        throw contractError(
            'mobile_source_deployment_validator_argument_invalid',
            'expected runtime env, migration env, runtime host and runtime port'
        );
    }
    const [runtimePath, migrationPath, expectedHost, expectedPort] = argv;
    const result = validateDeploymentEnvironment({
        runtime: loadEnvironmentFile(runtimePath),
        migration: loadEnvironmentFile(migrationPath),
        expectedHost,
        expectedPort,
    });
    logger('Protected environment contract passed');
    return result;
}

if (require.main === module) {
    try {
        runCli();
    } catch (error) {
        const code = /^[a-z0-9_]+$/i.test(String(error?.code || ''))
            ? error.code
            : 'mobile_source_deployment_environment_invalid';
        console.error(`Protected environment contract failed [${code}]`);
        process.exitCode = 1;
    }
}

module.exports = {
    loadEnvironmentFile,
    runCli,
    validateDeploymentEnvironment,
};
