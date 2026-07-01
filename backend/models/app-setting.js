const db = require('../database/init');

const NETWORK_PROXY_KEY = 'network.proxy';
const CRAWLER_PER_RUN_LIMIT_KEY = 'crawler.per_run_limit';
const CRAWLER_DAILY_STATS_KEY = 'crawler.daily_stats';
const SELF_HEAL_SETTINGS_KEY = 'self_heal.settings';
const SELF_HEAL_RUNS_KEY = 'self_heal.runs';
const SELF_HEAL_SCHEDULE_RECOVERY_KEY = 'self_heal.schedule_recovery';
const AI_AGENT_SETTINGS_KEY = 'ai_agent.settings';
const DEFAULT_PROXY_SETTINGS = {
    enabled: false,
    defaultProxyUrl: '',
    proxyUrl: '',
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
        const value = this.getJson(NETWORK_PROXY_KEY, null);
        if (!value || typeof value !== 'object') {
            return this.normalizeProxySettings(DEFAULT_PROXY_SETTINGS);
        }

        return this.normalizeProxySettings(value);
    }

    static saveProxySettings(settings = {}) {
        const value = this.normalizeProxySettings({
            ...settings,
            updatedAt: new Date().toLocaleString('zh-CN')
        });

        this.setJson(NETWORK_PROXY_KEY, value);
        return value;
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
        const type = String(source.type ?? base.type ?? 'openai_compatible').trim().toLowerCase() || 'openai_compatible';
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
        const saved = this.getJson(AI_AGENT_SETTINGS_KEY, null);
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
        this.setJson(AI_AGENT_SETTINGS_KEY, value);
        return value;
    }

    static publicAiAgentSettings(settings = {}) {
        const normalized = this.normalizeAiAgentSettings(settings);
        return {
            ...normalized,
            apiKey: undefined,
            apiKeyConfigured: Boolean(normalized.apiKey),
            apiKeyPreview: this.maskSecret(normalized.apiKey),
            configured: Boolean(normalized.baseUrl && normalized.apiKey && normalized.modelId)
        };
    }

    static maskSecret(value) {
        const text = String(value || '');
        if (!text) return '';
        if (text.length <= 8) return '********';
        return `${'*'.repeat(Math.min(12, text.length - 4))}${text.slice(-4)}`;
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

    static normalizeProxySettings(settings = {}) {
        const defaultProxyUrl = String(settings.defaultProxyUrl || settings.proxyUrl || '').trim();
        const cityProxyPool = Array.isArray(settings.cityProxyPool)
            ? settings.cityProxyPool.map(item => ({
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
            enabled: Boolean(settings.enabled),
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
