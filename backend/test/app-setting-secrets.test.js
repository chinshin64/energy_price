'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blue-team-settings-test-'));
process.env.DATABASE_PATH = path.join(tempDir, 'settings.db');
process.env.SETTINGS_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
process.env.UNIFIED_OUTBOUND_PROXY_URL = '';
delete process.env.METHOD3_UPSTREAM_PROXY;
delete process.env.ALLOW_PLAINTEXT_SECRETS;

const db = require('../database/init');
const AppSettingModel = require('../models/app-setting');
const { UNIFIED_OUTBOUND_PROXY_URL } = require('../config/unified-proxy');

test.after(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
});

test('源代码不再提供固定外部代理默认值', () => {
    assert.equal(UNIFIED_OUTBOUND_PROXY_URL, '');
    const settings = AppSettingModel.getProxySettings();
    assert.equal(settings.enabled, false);
    assert.equal(settings.defaultProxyUrl, '');
});

test('AI Agent 密钥加密保存且公共视图不回传原文', () => {
    const saved = AppSettingModel.saveAiAgentSettings({
        mode: 'enabled',
        type: 'openai_compatible',
        baseUrl: 'https://models.example.test/v1',
        apiKey: 'ai-agent-secret',
        modelId: 'glm-5.2'
    });
    assert.equal(saved.apiKey, 'ai-agent-secret');

    const stored = JSON.parse(AppSettingModel.get('ai_agent.settings'));
    assert.equal(stored.apiKey.startsWith('enc:v1:'), true);
    assert.equal(JSON.stringify(stored).includes('ai-agent-secret'), false);
    assert.equal(AppSettingModel.getAiAgentSettings().apiKey, 'ai-agent-secret');

    const publicValue = AppSettingModel.publicAiAgentSettings(saved);
    assert.equal(publicValue.apiKey, undefined);
    assert.equal(publicValue.apiKeyConfigured, true);
    assert.equal(publicValue.secretStorage.encryptionConfigured, true);
});

test('代理凭据加密保存、公共接口隐藏并支持留空保留', () => {
    const saved = AppSettingModel.saveProxySettings({
        enabled: true,
        defaultProxyUrl: 'http://proxy-user:proxy-pass@proxy.example.test:8080',
        autoCityProxyEnabled: true,
        cityProxyPool: [{
            enabled: true,
            province: '陕西',
            city: '西安',
            proxyUrl: 'socks5://city-user:city-pass@city-proxy.example.test:1080'
        }],
        providerProxy: {
            enabled: true,
            apiUrl: 'https://provider.example.test/proxy',
            authHeader: 'Authorization',
            authToken: 'provider-secret',
            ttlMinutes: 10
        }
    });
    assert.equal(saved.providerProxy.authToken, 'provider-secret');

    const stored = JSON.parse(AppSettingModel.get('network.proxy'));
    const storedText = JSON.stringify(stored);
    for (const secret of ['proxy-user', 'proxy-pass', 'city-user', 'city-pass', 'provider-secret']) {
        assert.equal(storedText.includes(secret), false, `存储中泄露 ${secret}`);
    }
    assert.equal(stored.defaultProxyUrl.startsWith('enc:v1:'), true);
    assert.equal(stored.cityProxyPool[0].proxyUrl.startsWith('enc:v1:'), true);
    assert.equal(stored.providerProxy.authToken.startsWith('enc:v1:'), true);

    const publicValue = AppSettingModel.publicProxySettings(AppSettingModel.getProxySettings());
    assert.equal(publicValue.defaultProxyUrl, '');
    assert.equal(publicValue.defaultProxyUrlSecret, true);
    assert.equal(publicValue.defaultProxyUrlPreview.includes('proxy-pass'), false);
    assert.equal(publicValue.cityProxyPool[0].proxyUrl, '');
    assert.equal(publicValue.providerProxy.authToken, undefined);
    assert.equal(publicValue.providerProxy.authTokenConfigured, true);

    AppSettingModel.saveProxySettings(publicValue);
    const preserved = AppSettingModel.getProxySettings();
    assert.equal(preserved.defaultProxyUrl.includes('proxy-pass'), true);
    assert.equal(preserved.cityProxyPool[0].proxyUrl.includes('city-pass'), true);
    assert.equal(preserved.providerProxy.authToken, 'provider-secret');
});

test('历史明文设置可扫描并迁移为密文', () => {
    AppSettingModel.setJson('ai_agent.settings', {
        mode: 'enabled',
        baseUrl: 'https://models.example.test/v1',
        apiKey: 'legacy-ai-secret',
        modelId: 'glm-5.2'
    });
    const before = AppSettingModel.getCredentialStorageStatus();
    assert.ok(before.legacyFields >= 1);
    const result = AppSettingModel.migrateStoredCredentials({ dryRun: false });
    assert.ok(result.migratedFields >= 1);
    const stored = JSON.parse(AppSettingModel.get('ai_agent.settings'));
    assert.equal(stored.apiKey.startsWith('enc:v1:'), true);
    assert.equal(JSON.stringify(stored).includes('legacy-ai-secret'), false);
    assert.equal(AppSettingModel.getAiAgentSettings().apiKey, 'legacy-ai-secret');
});
