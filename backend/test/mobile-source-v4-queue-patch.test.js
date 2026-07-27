'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
    patchFile,
    patchSource,
    validateJavaScript,
} = require('../scripts/patch-mobile-source-v4-queue');

function productionV4StoreSource() {
    return `
'use strict';
const mysql = require('mysql2/promise');
const SNAPSHOT_TABLE = 'mobile_ocr_station_snapshots';
function createMysqlPool(env = process.env) {
    const connectionLimit = Number(env.MOBILE_SOURCE_MYSQL_POOL_SIZE || 10);
    return mysql.createPool({
        waitForConnections: true,
        connectionLimit: Number.isInteger(connectionLimit) && connectionLimit > 0 ? connectionLimit : 10,
        queueLimit: 100,
    });
}
module.exports = { createMysqlPool, SNAPSHOT_TABLE };
`;
}

test('v4 queue patch changes only the bounded queue configuration', () => {
    const result = patchSource(productionV4StoreSource());
    assert.equal(result.changed, true);
    assert.match(result.source, /MOBILE_SOURCE_MYSQL_QUEUE_LIMIT/);
    assert.match(result.source, /requestedQueueLimit <= 5000/);
    assert.match(result.source, /queueLimit,/);
    assert.doesNotMatch(result.source, /queueLimit: 100/);
    assert.match(result.source, /connectionLimit: Number\.isInteger/);
    assert.match(result.source, /mobile_ocr_station_snapshots/);
    validateJavaScript(result.source);
    assert.equal(patchSource(result.source).changed, false);
});

test('v4 queue patch refuses local v5 split store and ambiguous anchors', () => {
    assert.throws(
        () => patchSource(`${productionV4StoreSource()}\nconst x = 'MobileSourceSplitMigrator';`),
        error => error.code === 'mobile_source_v4_queue_patch_wrong_schema'
    );
    assert.throws(
        () => patchSource(productionV4StoreSource().replace('queueLimit: 100,', 'queueLimit: 99,')),
        error => error.code === 'mobile_source_v4_queue_patch_anchor_invalid'
    );
});

test('v4 queue patch check is read-only and apply creates a protected backup', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-v4-patch-test-'));
    const target = path.join(directory, 'mysql-mobile-source-store.js');
    try {
        fs.writeFileSync(target, productionV4StoreSource(), { encoding: 'utf8', mode: 0o640 });
        const checked = patchFile(target, { apply: false });
        assert.equal(checked.changed, true);
        assert.equal(fs.readFileSync(target, 'utf8'), productionV4StoreSource());

        const applied = patchFile(target, { apply: true });
        assert.equal(applied.applied, true);
        assert.equal(fs.statSync(applied.backup).mode & 0o777, 0o600);
        assert.equal(fs.statSync(target).mode & 0o777, 0o640);
        assert.match(fs.readFileSync(target, 'utf8'), /MOBILE_SOURCE_MYSQL_QUEUE_LIMIT/);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
