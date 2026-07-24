'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blue-team-template-test-'));
process.env.DATABASE_PATH = path.join(tempDir, 'templates.db');
process.env.SETTINGS_ENCRYPTION_KEY = Buffer.alloc(32, 11).toString('base64');

const db = require('../database/init');
const ApiTemplateModel = require('../models/api-template');

test.after(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
});

test('可重放请求材料整体加密保存，运行时可解密', () => {
    const result = ApiTemplateModel.save({
        name: 'encrypted-template',
        platform: 'commercial-test',
        method: 'POST',
        baseUrl: 'https://api.example.test/stations',
        templateScope: 'list',
        queryParams: { accessToken: 'query-secret' },
        bodyParams: { city: 'xian', wsgsig: 'body-secret' },
        variableParams: { city: 'body.city' },
        headers: { Authorization: 'Bearer header-secret' }
    });

    const stored = db.prepare('SELECT * FROM api_templates WHERE id = ?').get(result.lastInsertRowid);
    const storedText = JSON.stringify(stored);
    for (const secret of ['query-secret', 'body-secret', 'header-secret']) {
        assert.equal(storedText.includes(secret), false, `模板存储泄露 ${secret}`);
    }
    for (const column of ['query_params', 'body_params', 'variable_params', 'headers']) {
        assert.equal(stored[column].startsWith('enc:v1:'), true, `${column} 未加密`);
    }

    const runtime = ApiTemplateModel.getById(result.lastInsertRowid);
    assert.equal(runtime.queryParams.accessToken, 'query-secret');
    assert.equal(runtime.bodyParams.wsgsig, 'body-secret');
    assert.equal(runtime.headers.Authorization, 'Bearer header-secret');
});

test('模板公共视图保留结构但不返回签名和凭据原文', () => {
    const runtime = ApiTemplateModel.getAll()[0];
    const publicValue = ApiTemplateModel.publicTemplate(runtime);
    assert.equal(publicValue.queryParams.accessToken, '**redacted**');
    assert.equal(publicValue.bodyParams.wsgsig, '**redacted**');
    assert.equal(publicValue.headers.Authorization, '**redacted**');
    assert.equal(publicValue.sensitiveMaterialConfigured, true);
    assert.equal(JSON.stringify(publicValue).includes('header-secret'), false);
});

test('更新请求材料后仍保持密文存储', () => {
    const current = ApiTemplateModel.getAll()[0];
    ApiTemplateModel.update(current.id, {
        headers: { Authorization: 'Bearer rotated-secret' }
    });
    const stored = db.prepare('SELECT headers FROM api_templates WHERE id = ?').get(current.id);
    assert.equal(stored.headers.startsWith('enc:v1:'), true);
    assert.equal(stored.headers.includes('rotated-secret'), false);
    assert.equal(ApiTemplateModel.getById(current.id).headers.Authorization, 'Bearer rotated-secret');
});

test('提交公共脱敏视图不会用占位符覆盖已有凭据', () => {
    const runtime = ApiTemplateModel.getAll()[0];
    const publicValue = ApiTemplateModel.publicTemplate(runtime);
    publicValue.bodyParams.city = 'shanghai';
    ApiTemplateModel.update(runtime.id, {
        queryParams: publicValue.queryParams,
        bodyParams: publicValue.bodyParams,
        headers: publicValue.headers
    });

    const updated = ApiTemplateModel.getById(runtime.id);
    assert.equal(updated.queryParams.accessToken, 'query-secret');
    assert.equal(updated.bodyParams.wsgsig, 'body-secret');
    assert.equal(updated.bodyParams.city, 'shanghai');
    assert.equal(updated.headers.Authorization, 'Bearer rotated-secret');
});

test('历史明文模板支持扫描并迁移为密文', () => {
    const legacy = db.prepare(`
        INSERT INTO api_templates (
            name, platform, method, base_url, template_scope,
            query_params, body_params, variable_params, headers
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        'legacy-template',
        'commercial-test',
        'GET',
        'https://api.example.test/legacy',
        'list',
        JSON.stringify({ token: 'legacy-query-secret' }),
        '{}',
        '{}',
        JSON.stringify({ Cookie: 'legacy-cookie-secret' })
    );
    assert.ok(ApiTemplateModel.getMaterialStorageStatus().legacyFields >= 4);
    const result = ApiTemplateModel.migrateStoredMaterials({ dryRun: false });
    assert.ok(result.migratedFields >= 4);
    const stored = db.prepare('SELECT * FROM api_templates WHERE id = ?').get(legacy.lastInsertRowid);
    assert.equal(stored.query_params.startsWith('enc:v1:'), true);
    assert.equal(JSON.stringify(stored).includes('legacy-query-secret'), false);
    assert.equal(ApiTemplateModel.getById(legacy.lastInsertRowid).headers.Cookie, 'legacy-cookie-secret');
});

test('智能保存明确返回新建和合并的模板 ID', () => {
    const first = ApiTemplateModel.saveSmart({
        name: 'smart-template',
        platform: 'commercial-test',
        method: 'POST',
        baseUrl: 'https://api.example.test/smart',
        templateScope: 'list',
        queryParams: {},
        bodyParams: { city: 'xian' },
        variableParams: {},
        headers: {},
    });
    assert.equal(first.created, true);
    assert.ok(first.templateId > 0);

    const merged = ApiTemplateModel.saveSmart({
        name: 'smart-template-new-sample',
        platform: 'commercial-test',
        method: 'POST',
        baseUrl: 'https://api.example.test/smart',
        templateScope: 'list',
        queryParams: {},
        bodyParams: { city: 'xian' },
        variableParams: {},
        headers: {},
    });
    assert.equal(merged.created, false);
    assert.equal(merged.merged, true);
    assert.equal(merged.templateId, first.templateId);
});
