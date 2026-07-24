'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('47 source runtime keeps a minimal pinned production dependency set', () => {
    const packagePath = path.join(__dirname, '../mobile-source-runtime/package.json');
    const runtimePackage = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    assert.deepEqual(runtimePackage.dependencies, {
        dotenv: '16.6.1',
        express: '4.22.2',
        mysql2: '3.23.1',
    });
    assert.equal(runtimePackage.overrides['body-parser'], '1.20.6');
    assert.deepEqual(runtimePackage.engines, { node: '>=22 <23' });
});
