'use strict';

const SHARED_OWNER_OPT_IN = 'MOBILE_SOURCE_ALLOW_SHARED_DB_OWNER_MIGRATION';

function policyError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function normalizeRequiredIdentity(value, label) {
    const normalized = String(value || '').trim();
    if (!normalized) {
        throw policyError(
            'mobile_source_migration_identity_configuration_required',
            `required migration identity setting is missing: ${label}`
        );
    }
    return normalized;
}

function parseSharedOwnerOptIn(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized || normalized === 'false') return false;
    if (normalized === 'true') return true;
    throw policyError(
        'mobile_source_migration_shared_owner_opt_in_invalid',
        `${SHARED_OWNER_OPT_IN} must be true or false`
    );
}

function validateMigrationIdentityPolicy(options = {}) {
    const migrationUser = normalizeRequiredIdentity(
        options.migrationUser,
        'migration MySQL user'
    );
    const runtimeUser = normalizeRequiredIdentity(
        options.runtimeUser,
        'runtime MySQL user'
    );
    const migrationDatabase = normalizeRequiredIdentity(
        options.migrationDatabase,
        'migration MySQL database'
    );
    const runtimeDatabase = normalizeRequiredIdentity(
        options.runtimeDatabase,
        'runtime MySQL database'
    );
    const allowSharedOwner = parseSharedOwnerOptIn(options.allowSharedOwnerMigration);
    const sameUser = migrationUser === runtimeUser;
    const sameDatabase = migrationDatabase === runtimeDatabase;

    if (!sameUser) {
        if (allowSharedOwner) {
            throw policyError(
                'mobile_source_migration_shared_owner_opt_in_not_applicable',
                `${SHARED_OWNER_OPT_IN}=true requires the same migration and runtime account`
            );
        }
        if (!sameDatabase) {
            throw policyError(
                'mobile_source_migration_database_mismatch',
                'migration and runtime MySQL databases must match'
            );
        }
        return Object.freeze({ mode: 'isolated', sameDatabase: true });
    }

    if (!allowSharedOwner) {
        throw policyError(
            'mobile_source_migration_account_not_separated',
            `migration and runtime MySQL accounts must be different unless ${SHARED_OWNER_OPT_IN}=true`
        );
    }
    if (!sameDatabase) {
        throw policyError(
            'mobile_source_migration_shared_owner_database_mismatch',
            'shared database-owner migration requires the same migration and runtime database'
        );
    }
    return Object.freeze({ mode: 'shared-db-owner', sameDatabase: true });
}

module.exports = {
    SHARED_OWNER_OPT_IN,
    parseSharedOwnerOptIn,
    validateMigrationIdentityPolicy,
};
