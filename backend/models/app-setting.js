const db = require('../database/init');
const crypto = require('crypto');
const { UNIFIED_OUTBOUND_PROXY_URL } = require('../config/unified-proxy');
const { defaultSecretCrypto } = require('../services/secret-crypto');
const { isSensitiveKey } = require('../services/sensitive-redactor');

const NETWORK_PROXY_KEY = 'network.proxy';
const CRAWLER_PER_RUN_LIMIT_KEY = 'crawler.per_run_limit';
const CRAWLER_DAILY_STATS_KEY = 'crawler.daily_stats';
const SELF_HEAL_SETTINGS_KEY = 'self_heal.settings';
const SELF_HEAL_RUNS_KEY = 'self_heal.runs';
const SELF_HEAL_SCHEDULE_RECOVERY_KEY = 'self_heal.schedule_recovery';
const AI_AGENT_SETTINGS_KEY = 'ai_agent.settings';
const DEFAULT_PROXY_SETTINGS = {
    enabled: Boolean(UNIFIED_OUTBOUND_PROXY_URL),
    defaultProxyUrl: UNIFIED_OUTBOUND_PROXY_URL,
    proxyUrl: UNIFIED_OUTBOUND_PROXY_URL,
    autoCityProxyEnabled: false,
    cityProxyPool: [],
    providerProxy: {
        enabled: false,
        apiUrl: '',
        authHeader: '',
        authToken: '',
        ttlMinutes: 10
    },
    updatedAt: null
};
const DEFAULT_CRAWLER_PER_RUN_LIMIT = 100;
const UNLIMITED_CRAWLER_PER_RUN_LIMIT = 'unlimited';
const DEFAULT_SELF_HEAL_SETTINGS = {
    enabled: true,
    autoFallbackEnabled: false,
    autoTemplateSwitch: true,
    autoProxyRotate: true,
    autoUaRotate: true,
    autoRefreshLearning: true,
    resumeFromBreakpoint: true,
    maxAttemptsPerRun: 3,
    manualEscalationThreshold: 3,
    failureSignals: {
        fail501Threshold: 2,
        emptyResponseThreshold: 1,
        parseEmptyThreshold: 1,
        stallMinutes: 8
    },
    chainPriority: ['api', 'har', 'page'],
    updatedAt: null
};
const DEFAULT_AI_AGENT_SETTINGS = {
    mode: 'dry_run',
    type: 'openai_compatible',
    baseUrl: '',
    apiKey: '',
    modelId: '',
    timeoutMs: 60000,
    applyLowRiskPatches: false,
    saveEvents: true,
    temperature: 0,
    maxTokens: 1200,
    updatedAt: null
};

class AppSettingModel {
    static getTodayKey() {
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    static get(key, defaultValue = null) {
        const row = db.prepare(`SELECT value FROM app_settings WHERE key = ?`).get(key);
        return row ? row.value : defaultValue;
    }

    static set(key, value) {
        return db.prepare(`
            INSERT INTO app_settings (key, value, updated_at)
            VALUES (?, ?, datetime('now', 'localtime'))
            ON CONFLICT(key) DO UPDATE SET
                value = excluded.value,
                updated_at = datetime('now', 'localtime')
        `).run(key, value);
    }

    static getJson(key, defaultValue = null) {
        const value = this.get(key, null);
        if (!value) {
            return defaultValue;
        }

        try {
            return JSON.parse(value);
        } catch (error) {
            return defaultValue;
        }
    }

    static setJson(key, value) {
        return this.set(key, JSON.stringify(value || {}));
    }

    static getProxySettings() {
        const stored = this.getJson(NETWORK_PROXY_KEY, null);
        const value = this.decryptProxySettings(stored);
        if (!value || typeof value !== 'object') {
            return this.normalizeProxySettings(DEFAULT_PROXY_SETTINGS);
        }

        return this.normalizeProxySettings(value);
    }

    static saveProxySettings(settings = {}) {
        const current = this.getProxySettings();
        const stored = this.getJson(NETWORK_PROXY_KEY, {}) || {};
        const currentById = new Map((current.cityProxyPool || []).map(item => [item.id, item]));
        const providerInput = settings.providerProxy && typeof settings.providerProxy === 'object'
            ? settings.providerProxy
            : {};
        const providerToken = providerInput.clearAuthToken === true
            ? ''
            : (providerInput.keepAuthToken === true && !providerInput.authToken
                ? current.providerProxy.authToken
                : String(providerInput.authToken ?? current.providerProxy.authToken ?? ''));
        const defaultProxyUrl = settings.keepDefaultProxyUrl === true && !settings.defaultProxyUrl
            ? current.defaultProxyUrl
            : String(settings.defaultProxyUrl ?? settings.proxyUrl ?? current.defaultProxyUrl ?? '');
        const cityProxyPool = Array.isArray(settings.cityProxyPool)
            ? settings.cityProxyPool.map(item => {
                const existing = currentById.get(String(item?.id || ''));
                return {
                    ...item,
                    proxyUrl: item?.keepProxyUrl === true && !item?.proxyUrl
                        ? String(existing?.proxyUrl || '')
                        : String(item?.proxyUrl || '')
                };
            })
            : current.cityProxyPool;
        const value = this.normalizeProxySettings({
            ...settings,
            defaultProxyUrl,
            cityProxyPool,
            providerProxy: {
                ...providerInput,
                authToken: providerToken
            },
            updatedAt: new Date().toLocaleString('zh-CN')
        });

        const storedPoolById = new Map(
            (Array.isArray(stored.cityProxyPool) ? stored.cityProxyPool : [])
                .map(item => [String(item?.id || ''), item])
        );
        const protectedValue = {
            ...value,
            defaultProxyUrl: this.protectUrlSecret(value.defaultProxyUrl, stored.defaultProxyUrl),
            proxyUrl: this.protectUrlSecret(value.defaultProxyUrl, stored.proxyUrl || stored.defaultProxyUrl),
            cityProxyPool: value.cityProxyPool.map(item => ({
                ...item,
                proxyUrl: this.protectUrlSecret(item.proxyUrl, storedPoolById.get(item.id)?.proxyUrl)
            })),
            providerProxy: {
                ...value.providerProxy,
                authToken: this.protectSecret(value.providerProxy.authToken, stored.providerProxy?.authToken)
            }
        };
        this.setJson(NETWORK_PROXY_KEY, protectedValue);
        return value;
    }

    static publicProxySettings(settings = {}) {
        const normalized = this.normalizeProxySettings(settings);
        const defaultIsSecret = this.urlContainsSecret(normalized.defaultProxyUrl);
        return {
            ...normalized,
            defaultProxyUrl: defaultIsSecret ? '' : normalized.defaultProxyUrl,
            proxyUrl: defaultIsSecret ? '' : normalized.defaultProxyUrl,
            defaultProxyUrlConfigured: Boolean(normalized.defaultProxyUrl),
            defaultProxyUrlSecret: defaultIsSecret,
            defaultProxyUrlPreview: this.maskUrlSecret(normalized.defaultProxyUrl),
            keepDefaultProxyUrl: defaultIsSecret,
            cityProxyPool: normalized.cityProxyPool.map(item => {
                const secret = this.urlContainsSecret(item.proxyUrl);
                return {
                    ...item,
                    proxyUrl: secret ? '' : item.proxyUrl,
                    proxyUrlConfigured: Boolean(item.proxyUrl),
                    proxyUrlSecret: secret,
                    proxyUrlPreview: this.maskUrlSecret(item.proxyUrl),
                    keepProxyUrl: secret
                };
            }),
            providerProxy: {
                ...normalized.providerProxy,
                authToken: undefined,
                authTokenConfigured: Boolean(normalized.providerProxy.authToken),
                authTokenPreview: this.maskSecret(normalized.providerProxy.authToken),
                keepAuthToken: Boolean(normalized.providerProxy.authToken)
            },
            secretStorage: {
                encryptionConfigured: defaultSecretCrypto.isConfigured(),
                plaintextAllowed: defaultSecretCrypto.allowPlaintext
            }
        };
    }

    static decryptProxySettings(stored) {
        if (!stored || typeof stored !== 'object') return stored;
        const provider = stored.providerProxy && typeof stored.providerProxy === 'object'
            ? stored.providerProxy
            : {};
        return {
            ...stored,
            defaultProxyUrl: this.decryptSecret(stored.defaultProxyUrl),
            proxyUrl: this.decryptSecret(stored.proxyUrl),
            cityProxyPool: Array.isArray(stored.cityProxyPool)
                ? stored.cityProxyPool.map(item => ({
                    ...item,
                    proxyUrl: this.decryptSecret(item?.proxyUrl)
                }))
                : [],
            providerProxy: {
                ...provider,
                authToken: this.decryptSecret(provider.authToken)
            }
        };
    }

    static normalizeSelfHealSettings(settings = {}) {
        const signals = settings.failureSignals && typeof settings.failureSignals === 'object'
            ? settings.failureSignals
            : {};
        const normalizePositiveInt = (value, fallback) => {
            const num = Number(value);
            return Number.isFinite(num) && num > 0 ? Math.max(1, Math.floor(num)) : fallback;
        };
        const chainPriority = Array.isArray(settings.chainPriority) && settings.chainPriority.length > 0
            ? settings.chainPriority
            : DEFAULT_SELF_HEAL_SETTINGS.chainPriority;

        return {
            enabled: settings.enabled !== false,
            autoFallbackEnabled: settings.autoFallbackEnabled === true,
            autoTemplateSwitch: settings.autoTemplateSwitch !== false,
            autoProxyRotate: settings.autoProxyRotate !== false,
            autoUaRotate: settings.autoUaRotate !== false,
            autoRefreshLearning: settings.autoRefreshLearning !== false,
            resumeFromBreakpoint: settings.resumeFromBreakpoint !== false,
            maxAttemptsPerRun: normalizePositiveInt(settings.maxAttemptsPerRun, DEFAULT_SELF_HEAL_SETTINGS.maxAttemptsPerRun),
            manualEscalationThreshold: normalizePositiveInt(
                settings.manualEscalationThreshold,
                DEFAULT_SELF_HEAL_SETTINGS.manualEscalationThreshold
            ),
            failureSignals: {
                fail501Threshold: normalizePositiveInt(
                    signals.fail501Threshold,
                    DEFAULT_SELF_HEAL_SETTINGS.failureSignals.fail501Threshold
                ),
                emptyResponseThreshold: normalizePositiveInt(
                    signals.emptyResponseThreshold,
                    DEFAULT_SELF_HEAL_SETTINGS.failureSignals.emptyResponseThreshold
                ),
                parseEmptyThreshold: normalizePositiveInt(
                    signals.parseEmptyThreshold,
                    DEFAULT_SELF_HEAL_SETTINGS.failureSignals.parseEmptyThreshold
                ),
                stallMinutes: normalizePositiveInt(
                    signals.stallMinutes,
                    DEFAULT_SELF_HEAL_SETTINGS.failureSignals.stallMinutes
                )
            },
            chainPriority,
            updatedAt: settings.updatedAt || null
        };
    }

    static getSelfHealSettings() {
        const value = this.getJson(SELF_HEAL_SETTINGS_KEY, null);
        if (!value || typeof value !== 'object') {
            return this.normalizeSelfHealSettings(DEFAULT_SELF_HEAL_SETTINGS);
        }

        return this.normalizeSelfHealSettings(value);
    }

    static saveSelfHealSettings(settings = {}) {
        const value = this.normalizeSelfHealSettings({
            ...settings,
            updatedAt: new Date().toLocaleString('zh-CN')
        });

        this.setJson(SELF_HEAL_SETTINGS_KEY, value);
        return value;
    }

    static normalizeAiAgentSettings(settings = {}, fallback = DEFAULT_AI_AGENT_SETTINGS) {
        const source = settings && typeof settings === 'object' ? settings : {};
        const base = fallback && typeof fallback === 'object' ? fallback : DEFAULT_AI_AGENT_SETTINGS;
        const modeValue = String(source.mode ?? base.mode ?? 'disabled').trim().toLowerCase();
        const normalizedMode = modeValue === 'dry-run' ? 'dry_run' : modeValue;
        const typeValue = String(source.type ?? base.type ?? 'openai_compatible').trim().toLowerCase();
        const type = ['anthropic', 'anthropic-native', 'claude', 'claude_native'].includes(typeValue)
            ? 'anthropic_native'
            : (typeValue || 'openai_compatible');
        const timeoutMs = Math.max(1000, Math.floor(Number(source.timeoutMs ?? base.timeoutMs ?? 60000) || 60000));
        const temperature = Number(source.temperature ?? base.temperature ?? 0);
        const maxTokens = Math.max(1, Math.floor(Number(source.maxTokens ?? base.maxTokens ?? 1200) || 1200));

        return {
            mode: ['disabled', 'dry_run', 'enabled'].includes(normalizedMode) ? normalizedMode : 'disabled',
            type,
            baseUrl: String(source.baseUrl ?? base.baseUrl ?? '').trim(),
            apiKey: String(source.apiKey ?? base.apiKey ?? ''),
            modelId: String(source.modelId ?? source.model ?? base.modelId ?? base.model ?? '').trim(),
            timeoutMs,
            applyLowRiskPatches: source.applyLowRiskPatches !== undefined
                ? source.applyLowRiskPatches === true
                : Boolean(base.applyLowRiskPatches),
            saveEvents: source.saveEvents !== undefined
                ? source.saveEvents !== false
                : base.saveEvents !== false,
            temperature: Number.isFinite(temperature) ? temperature : 0,
            maxTokens,
            updatedAt: source.updatedAt || base.updatedAt || null
        };
    }

    static getAiAgentSettings(baseSettings = {}) {
        const base = this.normalizeAiAgentSettings({
            ...DEFAULT_AI_AGENT_SETTINGS,
            ...(baseSettings || {})
        });
        const stored = this.getJson(AI_AGENT_SETTINGS_KEY, null);
        const saved = stored && typeof stored === 'object'
            ? { ...stored, apiKey: this.decryptSecret(stored.apiKey) }
            : stored;
        if (!saved || typeof saved !== 'object') {
            return base;
        }
        return this.normalizeAiAgentSettings({
            ...base,
            ...saved
        }, base);
    }

    static saveAiAgentSettings(settings = {}, baseSettings = {}) {
        const current = this.getAiAgentSettings(baseSettings);
        const stored = this.getJson(AI_AGENT_SETTINGS_KEY, {}) || {};
        const wantsToKeepKey = settings.keepApiKey === true && !settings.apiKey;
        const nextInput = {
            ...current,
            ...settings,
            apiKey: wantsToKeepKey ? current.apiKey : String(settings.apiKey ?? current.apiKey ?? ''),
            updatedAt: new Date().toLocaleString('zh-CN')
        };
        if (settings.clearApiKey === true) {
            nextInput.apiKey = '';
        }
        delete nextInput.keepApiKey;
        delete nextInput.clearApiKey;

        const value = this.normalizeAiAgentSettings(nextInput, current);
        this.setJson(AI_AGENT_SETTINGS_KEY, {
            ...value,
            apiKey: this.protectSecret(value.apiKey, stored.apiKey)
        });
        return value;
    }

    static publicAiAgentSettings(settings = {}) {
        const normalized = this.normalizeAiAgentSettings(settings);
        return {
            ...normalized,
            apiKey: undefined,
            apiKeyConfigured: Boolean(normalized.apiKey),
            apiKeyPreview: this.maskSecret(normalized.apiKey),
            configured: Boolean(normalized.baseUrl && normalized.apiKey && normalized.modelId),
            secretStorage: {
                encryptionConfigured: defaultSecretCrypto.isConfigured(),
                plaintextAllowed: defaultSecretCrypto.allowPlaintext
            }
        };
    }

    static getCredentialStorageStatus() {
        const ai = this.getJson(AI_AGENT_SETTINGS_KEY, {}) || {};
        const network = this.getJson(NETWORK_PROXY_KEY, {}) || {};
        const fields = [
            { name: 'aiAgent.apiKey', value: ai.apiKey, secret: Boolean(ai.apiKey) },
            {
                name: 'network.defaultProxyUrl',
                value: network.defaultProxyUrl,
                secret: defaultSecretCrypto.isEncrypted(network.defaultProxyUrl)
                    || this.urlContainsSecret(network.defaultProxyUrl)
            },
            {
                name: 'network.providerProxy.authToken',
                value: network.providerProxy?.authToken,
                secret: Boolean(network.providerProxy?.authToken)
            },
            ...(Array.isArray(network.cityProxyPool) ? network.cityProxyPool.map((item, index) => ({
                name: `network.cityProxyPool[${index}].proxyUrl`,
                value: item?.proxyUrl,
                secret: defaultSecretCrypto.isEncrypted(item?.proxyUrl) || this.urlContainsSecret(item?.proxyUrl)
            })) : [])
        ].filter(item => item.secret);
        return {
            secretFields: fields.length,
            encryptedFields: fields.filter(item => defaultSecretCrypto.isEncrypted(item.value)).length,
            legacyFields: fields.filter(item => !defaultSecretCrypto.isEncrypted(item.value)).length,
            fields: fields.map(item => ({
                name: item.name,
                state: defaultSecretCrypto.storageState(item.value)
            }))
        };
    }

    static migrateStoredCredentials(options = {}) {
        const dryRun = options.dryRun !== false;
        const status = this.getCredentialStorageStatus();
        if (dryRun || status.legacyFields === 0) return { dryRun, migratedFields: 0, ...status };
        if (!defaultSecretCrypto.isConfigured()) {
            const error = new Error('SETTINGS_ENCRYPTION_KEY is required for settings migration');
            error.code = 'settings_encryption_key_required';
            error.statusCode = 503;
            throw error;
        }

        const aiStored = this.getJson(AI_AGENT_SETTINGS_KEY, null);
        if (aiStored && typeof aiStored === 'object') {
            const ai = this.getAiAgentSettings();
            this.saveAiAgentSettings({ ...ai, apiKey: ai.apiKey, keepApiKey: false });
        }
        const networkStored = this.getJson(NETWORK_PROXY_KEY, null);
        if (networkStored && typeof networkStored === 'object') {
            this.saveProxySettings(this.getProxySettings());
        }
        const next = this.getCredentialStorageStatus();
        return {
            dryRun: false,
            migratedFields: Math.max(0, status.legacyFields - next.legacyFields),
            ...next
        };
    }

    static maskSecret(value) {
        const text = String(value || '');
        if (!text) return '';
        if (text.length <= 8) return '********';
        return `${'*'.repeat(Math.min(12, text.length - 4))}${text.slice(-4)}`;
    }

    static protectSecret(value, existingStored = '') {
        const plaintext = String(value || '');
        if (!plaintext) return '';
        const existing = String(existingStored || '');
        if (!defaultSecretCrypto.isConfigured() && existing) {
            const existingPlaintext = defaultSecretCrypto.decrypt(existing);
            if (existingPlaintext === plaintext) return existing;
        }
        return defaultSecretCrypto.encrypt(plaintext);
    }

    static decryptSecret(value) {
        return defaultSecretCrypto.decrypt(String(value || ''));
    }

    static protectUrlSecret(value, existingStored = '') {
        const url = String(value || '').trim();
        return this.urlContainsSecret(url) ? this.protectSecret(url, existingStored) : url;
    }

    static urlContainsSecret(value) {
        const text = String(value || '').trim();
        if (!text) return false;
        try {
            const url = new URL(text);
            if (url.username || url.password) return true;
            return Array.from(url.searchParams.keys()).some(key => isSensitiveKey(key));
        } catch {
            return false;
        }
    }

    static maskUrlSecret(value) {
        const text = String(value || '').trim();
        if (!text) return '';
        try {
            const url = new URL(text);
            if (url.username) url.username = '***';
            if (url.password) url.password = '***';
            for (const key of Array.from(url.searchParams.keys())) {
                if (isSensitiveKey(key)) url.searchParams.set(key, '***');
            }
            return url.toString();
        } catch {
            return this.maskSecret(text);
        }
    }

    static getSelfHealRuns(limit = 40) {
        const rows = this.getJson(SELF_HEAL_RUNS_KEY, []);
        if (!Array.isArray(rows)) {
            return [];
        }

        return rows.slice(0, Math.max(1, Math.min(200, Math.floor(Number(limit) || 40))));
    }

    static recordSelfHealRun(run = {}) {
        const rows = this.getSelfHealRuns(200);
        const nextId = rows.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1;
        const record = {
            id: nextId,
            createdAt: new Date().toLocaleString('zh-CN'),
            ...run
        };

        this.setJson(SELF_HEAL_RUNS_KEY, [record, ...rows].slice(0, 80));
        return record;
    }

    static getScheduleRecoveryMap() {
        const value = this.getJson(SELF_HEAL_SCHEDULE_RECOVERY_KEY, {});
        return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    }

    static getScheduleRecovery(scheduleId) {
        const map = this.getScheduleRecoveryMap();
        return map[String(scheduleId)] || null;
    }

    static saveScheduleRecovery(scheduleId, recovery = {}) {
        const map = this.getScheduleRecoveryMap();
        const key = String(scheduleId);
        map[key] = {
            status: recovery.status || '未执行',
            summary: recovery.summary || '',
            at: recovery.at || new Date().toLocaleString('zh-CN')
        };
        this.setJson(SELF_HEAL_SCHEDULE_RECOVERY_KEY, map);
        return map[key];
    }

    static deleteScheduleRecovery(scheduleId) {
        const map = this.getScheduleRecoveryMap();
        const key = String(scheduleId);
        if (!Object.prototype.hasOwnProperty.call(map, key)) return false;
        delete map[key];
        this.setJson(SELF_HEAL_SCHEDULE_RECOVERY_KEY, map);
        return true;
    }

    static normalizeProxySettings(settings = {}) {
        const defaultProxyUrl = String(settings.defaultProxyUrl || settings.proxyUrl || UNIFIED_OUTBOUND_PROXY_URL).trim();
        const cityProxyPool = Array.isArray(settings.cityProxyPool)
            ? settings.cityProxyPool.map((item, index) => ({
                id: String(item?.id || '').trim() || this.proxyEntryId(item, index),
                enabled: item?.enabled !== false,
                province: String(item?.province || '').trim(),
                city: String(item?.city || '').trim(),
                proxyUrl: String(item?.proxyUrl || '').trim()
            })).filter(item => item.province || item.city || item.proxyUrl)
            : [];
        const provider = settings.providerProxy && typeof settings.providerProxy === 'object'
            ? settings.providerProxy
            : {};
        const ttlMinutes = Math.max(1, Math.floor(Number(provider.ttlMinutes) || 10));

        return {
            enabled: settings.enabled !== false,
            defaultProxyUrl,
            // proxyUrl 保留给旧代码和旧前端兼容，真实含义等同 defaultProxyUrl。
            proxyUrl: defaultProxyUrl,
            autoCityProxyEnabled: Boolean(settings.autoCityProxyEnabled),
            cityProxyPool,
            providerProxy: {
                enabled: Boolean(provider.enabled),
                apiUrl: String(provider.apiUrl || '').trim(),
                authHeader: String(provider.authHeader || '').trim(),
                authToken: String(provider.authToken || '').trim(),
                ttlMinutes
            },
            updatedAt: settings.updatedAt || null
        };
    }

    static proxyEntryId(item = {}, index = 0) {
        const identity = [item.province, item.city, index].map(value => String(value || '').trim()).join('|');
        return `proxy-${crypto.createHash('sha256').update(identity).digest('hex').slice(0, 12)}`;
    }

    static isUnlimitedCrawlerPerRunLimit(value) {
        const normalized = String(value ?? '').trim().toLowerCase();
        return value === null || ['unlimited', 'none', 'no-limit', 'infinity', '∞'].includes(normalized);
    }

    static normalizeCrawlerPerRunLimit(value, fallback = DEFAULT_CRAWLER_PER_RUN_LIMIT) {
        if (this.isUnlimitedCrawlerPerRunLimit(value)) {
            return null;
        }

        const raw = Number(value);
        if (!Number.isFinite(raw) || raw <= 0) {
            return fallback;
        }
        return Math.max(1, Math.floor(raw));
    }

    static getCrawlerPerRunLimit() {
        const raw = this.get(CRAWLER_PER_RUN_LIMIT_KEY, DEFAULT_CRAWLER_PER_RUN_LIMIT);
        return this.normalizeCrawlerPerRunLimit(raw);
    }

    static getCrawlerTestRequestLimit() {
        return 5;
    }

    static saveCrawlerPerRunLimit(limit) {
        if (this.isUnlimitedCrawlerPerRunLimit(limit)) {
            this.set(CRAWLER_PER_RUN_LIMIT_KEY, UNLIMITED_CRAWLER_PER_RUN_LIMIT);
            return this.getCrawlerRunQuotaStatus();
        }

        const perRunLimit = this.normalizeCrawlerPerRunLimit(limit, null);
        if (!perRunLimit) {
            throw new Error('perRunLimit must be a positive number');
        }

        this.set(CRAWLER_PER_RUN_LIMIT_KEY, String(perRunLimit));
        return this.getCrawlerRunQuotaStatus();
    }

    static getCrawlerDailyStats() {
        const today = this.getTodayKey();
        const saved = this.getJson(CRAWLER_DAILY_STATS_KEY, null);
        if (!saved || typeof saved !== 'object' || saved.date !== today) {
            const reset = {
                date: today,
                totalRequests: 0,
                successRequests: 0,
                fail501Requests: 0,
                updatedAt: new Date().toLocaleString('zh-CN')
            };
            this.setJson(CRAWLER_DAILY_STATS_KEY, reset);
            return reset;
        }

        return {
            date: today,
            totalRequests: Math.max(0, Math.floor(Number(saved.totalRequests) || 0)),
            successRequests: Math.max(0, Math.floor(Number(saved.successRequests) || 0)),
            fail501Requests: Math.max(0, Math.floor(Number(saved.fail501Requests) || 0)),
            updatedAt: saved.updatedAt || null
        };
    }

    static getCrawlerRunQuotaStatus() {
        const stats = this.getCrawlerDailyStats();
        const perRunLimit = this.getCrawlerPerRunLimit();

        return {
            date: stats.date,
            perRunLimit,
            perRunUnlimited: perRunLimit === null,
            totalRequests: stats.totalRequests,
            successRequests: stats.successRequests,
            fail501Requests: stats.fail501Requests,
            updatedAt: stats.updatedAt
        };
    }

    static recordCrawlerDailyRequest({ success = false, statusCode = null } = {}) {
        const current = this.getCrawlerDailyStats();
        const next = {
            date: current.date,
            totalRequests: current.totalRequests + 1,
            successRequests: current.successRequests + (success ? 1 : 0),
            fail501Requests: current.fail501Requests + (Number(statusCode) === 501 ? 1 : 0),
            updatedAt: new Date().toLocaleString('zh-CN')
        };

        this.setJson(CRAWLER_DAILY_STATS_KEY, next);
        const perRunLimit = this.getCrawlerPerRunLimit();

        return {
            ...next,
            perRunLimit,
            perRunUnlimited: perRunLimit === null
        };
    }

}

module.exports = AppSettingModel;
