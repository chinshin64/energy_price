'use strict';

const fs = require('fs');
const path = require('path');

const db = require('../database/init');
const ApiTemplateModel = require('../models/api-template');
const AppSettingModel = require('../models/app-setting');
const { defaultSecretCrypto } = require('../services/secret-crypto');

function timestamp() {
    return new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
}

function databasePath() {
    const row = db.prepare('PRAGMA database_list').all().find(item => item.name === 'main');
    return String(row?.file || '');
}

async function main(argv = process.argv.slice(2)) {
    const apply = argv.includes('--apply');
    const before = {
        templates: ApiTemplateModel.getMaterialStorageStatus(),
        settings: AppSettingModel.getCredentialStorageStatus()
    };
    if (!apply) {
        console.log(JSON.stringify({ success: true, mode: 'dry-run', before }, null, 2));
        return;
    }
    if (!defaultSecretCrypto.isConfigured()) {
        throw new Error('SETTINGS_ENCRYPTION_KEY is required with --apply');
    }

    const source = databasePath();
    if (!source || !fs.existsSync(source)) throw new Error('Cannot resolve SQLite database path for backup');
    const backupPath = `${source}.pre-secret-migration-${timestamp()}.bak`;
    await db.backup(backupPath);
    fs.chmodSync(backupPath, 0o600);

    const result = db.transaction(() => ({
        templates: ApiTemplateModel.migrateStoredMaterials({ dryRun: false }),
        settings: AppSettingModel.migrateStoredCredentials({ dryRun: false })
    }))();
    console.log(JSON.stringify({
        success: true,
        mode: 'apply',
        backupPath: path.basename(backupPath),
        before,
        result
    }, null, 2));
}

if (require.main === module) {
    main().then(() => db.close()).catch(error => {
        console.error(JSON.stringify({ success: false, error: error.message }, null, 2));
        db.close();
        process.exitCode = 1;
    });
}

module.exports = { main };
