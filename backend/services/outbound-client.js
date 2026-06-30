const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { HttpProxyAgent } = require('http-proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');

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
    }
};

const SENSITIVE_QUERY_KEYS = new Set([
    'ak',
    'api_key',
    'apikey',
    'appkey',
    'auth',
    'authorization',
    'cookie',
    'key',
    'password',
    'pass',
    'secret',
    'sign',
    'signature',
    'token',
    'access_token',
    'refresh_token'
]);

class OutboundClient {
    constructor(options = {}) {
        this.getProxySettings = typeof options.getProxySettings === 'function'
            ? options.getProxySettings
            : (() => DEFAULT_PROXY_SETTINGS);
        this.evidenceDir = options.evidenceDir || path.join(__dirname, '../../data/outbound-evidence');
        this.logger = typeof options.logger === 'function' ? options.logger : null;
        this.proxyAgentCache = new Map();
        this.providerProxyCache = new Map();
    }

    async request(config = {}, options = {}) {
        const startedAt = Date.now();
        const requestConfig = {
            ...config,
            method: String(config.method || 'GET').toUpperCase(),
            headers: { ...(config.headers || {}) },
            timeout: Number(config.timeout) > 0 ? Number(config.timeout) : 10000
        };

        let proxyMatch = options.proxyMatch || null;
        let response = null;
        try {
            if (options.skipProxy === true) {
                proxyMatch = { type: 'direct', label: '直连', proxyUrl: '' };
            } else if (!proxyMatch) {
                proxyMatch = options.useConfiguredProxy === true
                    ? await this.resolveProxyMatch(options.proxyContext || null)
                    : { type: 'direct', label: '直连', proxyUrl: '' };
            }
            this.applyProxyMatch(requestConfig, proxyMatch);

            response = await axios(requestConfig);
            const meta = this.buildRequestMeta({
                config: requestConfig,
                options,
                proxyMatch,
                startedAt,
                response,
                success: true
            });
            response.outboundMeta = meta;
            this.recordEvidence(meta);
            return response;
        } catch (error) {
            const meta = this.buildRequestMeta({
                config: requestConfig,
                options,
                proxyMatch,
                startedAt,
                response: error?.response || response,
                success: false,
                error
            });
            error.outboundMeta = meta;
            this.recordEvidence(meta);
            throw error;
        }
    }

    async fetchJson(url, options = {}) {
        const response = await this.request({
            method: options.method || 'GET',
            url,
            headers: options.headers || {},
            timeout: options.timeout || 10000,
            params: options.params || undefined
        }, options);
        return response.data;
    }

    async resolveProxyMatch(proxyContext = null) {
        const settings = this.normalizeProxySettings(this.getProxySettings() || {});
        if (!settings.enabled) {
            return { type: 'direct', label: '直连', proxyUrl: '' };
        }

        if (settings.autoCityProxyEnabled) {
            const cityProxy = this.findManualProxy(settings.cityProxyPool, proxyContext, 'city');
            if (cityProxy) {
                return cityProxy;
            }

            const provinceProxy = this.findManualProxy(settings.cityProxyPool, proxyContext, 'province');
            if (provinceProxy) {
                return provinceProxy;
            }

            const providerProxyUrl = await this.fetchProviderProxy(settings.providerProxy, proxyContext, settings);
            if (providerProxyUrl) {
                return {
                    type: 'provider',
                    label: '代理商城市代理',
                    proxyUrl: providerProxyUrl,
                    province: proxyContext?.province || '',
                    city: proxyContext?.city || ''
                };
            }
        }

        if (settings.defaultProxyUrl) {
            return {
                type: 'default',
                label: '默认代理',
                proxyUrl: settings.defaultProxyUrl
            };
        }

        return { type: 'direct', label: '直连', proxyUrl: '' };
    }

    applyProxyMatch(config, proxyMatch = {}) {
        config.proxy = false;
        if (!proxyMatch.proxyUrl) {
            return proxyMatch;
        }

        const agents = this.getProxyAgents(proxyMatch.proxyUrl);
        config.httpAgent = agents.http;
        config.httpsAgent = agents.https;
        return proxyMatch;
    }

    async applyProxyConfig(config, proxyContext = null) {
        const proxyMatch = await this.resolveProxyMatch(proxyContext);
        return this.applyProxyMatch(config, proxyMatch);
    }

    getProxyAgents(proxyUrl) {
        const normalized = String(proxyUrl || '').trim();
        if (!this.proxyAgentCache.has(normalized)) {
            const protocol = new URL(normalized).protocol.toLowerCase();
            let agents;

            if (protocol === 'http:' || protocol === 'https:') {
                agents = {
                    http: new HttpProxyAgent(normalized),
                    https: new HttpsProxyAgent(normalized)
                };
            } else if (protocol.startsWith('socks')) {
                const socksAgent = new SocksProxyAgent(normalized);
                agents = {
                    http: socksAgent,
                    https: socksAgent
                };
            } else {
                throw new Error(`Unsupported proxy protocol: ${protocol}`);
            }

            this.proxyAgentCache.set(normalized, agents);
        }

        return this.proxyAgentCache.get(normalized);
    }

    async fetchProviderProxy(providerProxy = {}, proxyContext = null, settings = null) {
        const provider = providerProxy && typeof providerProxy === 'object' ? providerProxy : {};
        if (!provider.enabled || !provider.apiUrl) {
            return null;
        }

        const context = proxyContext && typeof proxyContext === 'object' ? proxyContext : {};
        const cacheKey = [
            provider.apiUrl,
            context.province || '',
            context.city || '',
            context.district || '',
            context.keyword || context.name || ''
        ].join('|');
        const cached = this.providerProxyCache.get(cacheKey);
        if (cached && cached.expiresAt > Date.now()) {
            return cached.proxyUrl;
        }

        try {
            const url = this.buildProviderProxyUrl(provider.apiUrl, context);
            const headers = {};
            if (provider.authHeader && provider.authToken) {
                headers[provider.authHeader] = provider.authToken;
            }

            const response = await this.request({
                method: 'GET',
                url,
                headers,
                timeout: 8000
            }, {
                reason: 'proxy-provider',
                platform: 'proxy-provider',
                chain: 'outbound-proxy',
                evidenceType: 'proxy-provider',
                proxyContext: context,
                skipProxy: true
            });
            const proxyUrl = this.extractProviderProxyUrl(response.data);
            if (!proxyUrl) {
                return null;
            }

            const ttlMs = Math.max(1, Number(provider.ttlMinutes) || 10) * 60 * 1000;
            this.providerProxyCache.set(cacheKey, {
                proxyUrl,
                expiresAt: Date.now() + ttlMs
            });
            return proxyUrl;
        } catch (error) {
            return null;
        }
    }

    buildProviderProxyUrl(apiUrl, context = {}) {
        let urlText = String(apiUrl || '').trim();
        const replacements = {
            province: context.province || '',
            city: context.city || '',
            district: context.district || '',
            keyword: context.keyword || context.name || ''
        };

        for (const [key, value] of Object.entries(replacements)) {
            urlText = urlText.replace(new RegExp(`\\{${key}\\}`, 'g'), encodeURIComponent(value));
        }

        const url = new URL(urlText);
        const hasPlaceholder = /\{(province|city|district|keyword)\}/.test(String(apiUrl || ''));
        if (!hasPlaceholder) {
            Object.entries(replacements).forEach(([key, value]) => {
                if (value && !url.searchParams.has(key)) {
                    url.searchParams.set(key, value);
                }
            });
        }
        return url.toString();
    }

    extractProviderProxyUrl(payload) {
        const visited = new Set();
        const walk = (value) => {
            if (value === null || value === undefined) {
                return null;
            }
            if (typeof value === 'string' || typeof value === 'number') {
                return this.normalizeProxyUrlCandidate(value);
            }
            if (typeof value !== 'object') {
                return null;
            }
            if (visited.has(value)) {
                return null;
            }
            visited.add(value);

            const priorityKeys = ['proxyUrl', 'proxy_url', 'proxy', 'url', 'http', 'https', 'socks'];
            for (const key of priorityKeys) {
                if (value[key] !== undefined) {
                    const hit = walk(value[key]);
                    if (hit) return hit;
                }
            }

            if (Array.isArray(value)) {
                for (const item of value) {
                    const hit = walk(item);
                    if (hit) return hit;
                }
            }

            for (const item of Object.values(value)) {
                const hit = walk(item);
                if (hit) return hit;
            }
            return null;
        };

        return walk(payload);
    }

    normalizeProxyUrlCandidate(value) {
        const text = String(value || '').trim();
        if (/^(http|https|socks4|socks5):\/\//i.test(text)) {
            return text;
        }
        if (/^[\w.-]+:\d{2,5}$/.test(text)) {
            return `http://${text}`;
        }
        return null;
    }

    normalizeProxySettings(settings = {}) {
        const provider = settings.providerProxy && typeof settings.providerProxy === 'object'
            ? settings.providerProxy
            : {};
        return {
            enabled: Boolean(settings.enabled),
            defaultProxyUrl: String(settings.defaultProxyUrl || settings.proxyUrl || '').trim(),
            proxyUrl: String(settings.defaultProxyUrl || settings.proxyUrl || '').trim(),
            autoCityProxyEnabled: Boolean(settings.autoCityProxyEnabled),
            cityProxyPool: Array.isArray(settings.cityProxyPool) ? settings.cityProxyPool : [],
            providerProxy: {
                enabled: Boolean(provider.enabled),
                apiUrl: String(provider.apiUrl || '').trim(),
                authHeader: String(provider.authHeader || '').trim(),
                authToken: String(provider.authToken || '').trim(),
                ttlMinutes: Math.max(1, Math.floor(Number(provider.ttlMinutes) || 10))
            }
        };
    }

    findManualProxy(pool = [], proxyContext = null, matchType = 'city') {
        const target = this.buildProxyTarget(proxyContext);
        if (!target.hasSignal) {
            return null;
        }

        for (const item of pool) {
            if (!item || item.enabled === false || !item.proxyUrl) {
                continue;
            }

            const province = this.normalizeLocationToken(item.province);
            const city = this.normalizeLocationToken(item.city);
            if (matchType === 'city' && city && this.locationMatches(city, target)) {
                if (province && target.province && province !== target.province) {
                    continue;
                }
                return {
                    type: 'city',
                    label: '城市代理',
                    province: item.province || '',
                    city: item.city || '',
                    proxyUrl: String(item.proxyUrl).trim()
                };
            }

            if (matchType === 'province' && province && !city && this.locationMatches(province, target)) {
                return {
                    type: 'province',
                    label: '省级代理',
                    province: item.province || '',
                    city: '',
                    proxyUrl: String(item.proxyUrl).trim()
                };
            }
        }

        return null;
    }

    buildProxyTarget(proxyContext = null) {
        const context = proxyContext && typeof proxyContext === 'object' ? proxyContext : {};
        const values = [
            context.keyword,
            context.name,
            context.province,
            context.city,
            context.district
        ].filter(Boolean).map(value => this.normalizeLocationToken(value));

        return {
            province: this.normalizeLocationToken(context.province),
            city: this.normalizeLocationToken(context.city),
            values,
            hasSignal: values.some(Boolean)
        };
    }

    locationMatches(token, target) {
        if (!token || !target?.hasSignal) {
            return false;
        }

        return target.values.some(value => value === token || value.includes(token) || token.includes(value));
    }

    normalizeLocationToken(value) {
        return String(value || '')
            .trim()
            .toLowerCase()
            .replace(/\s+/g, '')
            .replace(/(特别行政区|壮族自治区|回族自治区|维吾尔自治区|自治区|省|市|区|县)$/g, '');
    }

    buildRequestMeta({ config, options, proxyMatch, startedAt, response = null, success = false, error = null }) {
        const durationMs = Date.now() - startedAt;
        const safeUrl = this.buildSafeUrl(config);
        const target = this.parseTarget(safeUrl);
        const responseHeaders = response?.headers || {};

        return {
            id: `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`,
            createdAt: new Date().toISOString(),
            evidenceType: options.evidenceType || options.chain || 'external-http',
            chain: options.chain || '',
            platform: options.platform || '',
            reason: options.reason || '',
            method: String(config.method || 'GET').toUpperCase(),
            url: safeUrl,
            targetHost: target.host,
            targetPath: target.pathname,
            request: {
                queryKeys: this.getQueryKeys(config),
                bodyKeys: this.getBodyKeys(config.data),
                headerKeys: Object.keys(config.headers || {}).sort(),
                hasBody: config.data !== undefined && config.data !== null
            },
            proxy: this.summarizeProxyMatch(proxyMatch),
            targetLocation: this.summarizeProxyContext(options.proxyContext),
            success: Boolean(success),
            statusCode: Number(response?.status) || null,
            durationMs,
            response: {
                contentType: responseHeaders['content-type'] || responseHeaders['Content-Type'] || '',
                contentLength: responseHeaders['content-length'] || responseHeaders['Content-Length'] || ''
            },
            error: error ? {
                code: error.code || '',
                message: String(error.message || '').slice(0, 500),
                statusCode: Number(error?.response?.status) || null
            } : null
        };
    }

    summarizeProxyMatch(proxyMatch = {}) {
        return {
            used: Boolean(proxyMatch?.proxyUrl),
            type: proxyMatch?.type || 'direct',
            label: proxyMatch?.label || (proxyMatch?.proxyUrl ? '代理' : '直连'),
            province: proxyMatch?.province || '',
            city: proxyMatch?.city || '',
            proxyUrl: this.maskProxyUrl(proxyMatch?.proxyUrl || '')
        };
    }

    summarizeProxyContext(proxyContext = null) {
        const context = proxyContext && typeof proxyContext === 'object' ? proxyContext : {};
        return {
            province: String(context.province || ''),
            city: String(context.city || ''),
            district: String(context.district || ''),
            keyword: String(context.keyword || context.name || '').slice(0, 120),
            lat: Number.isFinite(Number(context.lat)) ? Number(context.lat) : null,
            lng: Number.isFinite(Number(context.lng)) ? Number(context.lng) : null
        };
    }

    buildSafeUrl(config = {}) {
        const rawUrl = String(config.url || '');
        try {
            const url = new URL(rawUrl, config.baseURL || undefined);
            this.appendParams(url, config.params);
            return this.stripUrlQuery(url);
        } catch (error) {
            return this.stripRawUrlQuery(rawUrl);
        }
    }

    appendParams(url, params) {
        if (!params) {
            return;
        }

        if (params instanceof URLSearchParams) {
            for (const [key, value] of params.entries()) {
                url.searchParams.set(key, value);
            }
            return;
        }

        if (typeof params !== 'object') {
            return;
        }

        for (const [key, value] of Object.entries(params)) {
            if (value === undefined || value === null) {
                continue;
            }
            if (Array.isArray(value)) {
                value.forEach(item => url.searchParams.append(key, item));
            } else {
                url.searchParams.set(key, value);
            }
        }
    }

    getParamKeys(params) {
        if (!params) {
            return [];
        }
        if (params instanceof URLSearchParams) {
            return Array.from(new Set(Array.from(params.keys()))).sort();
        }
        if (typeof params === 'object') {
            return Object.keys(params).sort();
        }
        return ['<non-object>'];
    }

    getQueryKeys(config = {}) {
        return Array.from(new Set([
            ...this.getUrlQueryKeys(config.url, config.baseURL),
            ...this.getParamKeys(config.params)
        ])).sort();
    }

    getUrlQueryKeys(rawUrl, baseUrl = undefined) {
        const raw = String(rawUrl || '');
        if (!raw) {
            return [];
        }

        try {
            const url = new URL(raw, baseUrl || undefined);
            return Array.from(new Set(Array.from(url.searchParams.keys()))).sort();
        } catch (error) {
            const queryText = raw.split('?')[1]?.split('#')[0] || '';
            if (!queryText) {
                return [];
            }
            return Array.from(new Set(
                queryText
                    .split('&')
                    .map(part => decodeURIComponent(part.split('=')[0] || '').trim())
                    .filter(Boolean)
            )).sort();
        }
    }

    getBodyKeys(data) {
        if (data === undefined || data === null) {
            return [];
        }
        if (data instanceof URLSearchParams) {
            return Array.from(new Set(Array.from(data.keys()))).sort();
        }
        if (typeof data === 'object' && !Buffer.isBuffer(data)) {
            return Object.keys(data).sort();
        }
        if (typeof data === 'string') {
            try {
                return Array.from(new URLSearchParams(data).keys()).sort();
            } catch (error) {
                return ['<raw-string>'];
            }
        }
        return ['<non-object>'];
    }

    parseTarget(safeUrl) {
        try {
            const url = new URL(safeUrl);
            return {
                host: url.host,
                pathname: url.pathname
            };
        } catch (error) {
            return { host: '', pathname: '' };
        }
    }

    recordEvidence(meta = {}) {
        try {
            fs.mkdirSync(this.evidenceDir, { recursive: true });
            const dateText = new Date().toISOString().slice(0, 10);
            const filePath = path.join(this.evidenceDir, `${dateText}.jsonl`);
            fs.appendFileSync(filePath, `${JSON.stringify(meta)}\n`, 'utf8');
        } catch (error) {
            if (this.logger) {
                this.logger(`记录外部请求证据失败: ${error.message}`);
            }
        }
    }

    getRecentEvidence(limit = 100) {
        const rows = [];
        const maxRows = Math.max(1, Math.min(1000, Math.floor(Number(limit) || 100)));

        try {
            if (!fs.existsSync(this.evidenceDir)) {
                return [];
            }

            const files = fs.readdirSync(this.evidenceDir)
                .filter(file => file.endsWith('.jsonl'))
                .sort()
                .reverse();

            for (const file of files) {
                const filePath = path.join(this.evidenceDir, file);
                const lines = fs.readFileSync(filePath, 'utf8')
                    .split(/\r?\n/)
                    .filter(Boolean)
                    .reverse();

                for (const line of lines) {
                    try {
                        rows.push(JSON.parse(line));
                    } catch (error) {
                        rows.push({ parseError: error.message, raw: line.slice(0, 500), file });
                    }
                    if (rows.length >= maxRows) {
                        return rows;
                    }
                }
            }
        } catch (error) {
            return [{ success: false, error: error.message }];
        }

        return rows;
    }

    getStatus(limit = 20) {
        const settings = this.normalizeProxySettings(this.getProxySettings() || {});
        return {
            proxyEnabled: settings.enabled,
            defaultProxyUrl: this.maskProxyUrl(settings.defaultProxyUrl),
            autoCityProxyEnabled: settings.autoCityProxyEnabled,
            cityProxyPoolCount: settings.cityProxyPool.length,
            providerProxyEnabled: settings.providerProxy.enabled,
            evidenceDir: this.evidenceDir,
            recentEvidence: this.getRecentEvidence(limit)
        };
    }

    describeProxyMatch(proxyMatch = {}) {
        if (!proxyMatch.proxyUrl) {
            return '直连';
        }

        const area = [proxyMatch.province, proxyMatch.city].filter(Boolean).join('/');
        const areaText = area ? `${area} ` : '';
        return `${proxyMatch.label || '代理'} ${areaText}${this.maskProxyUrl(proxyMatch.proxyUrl)}`;
    }

    maskUrl(rawUrl) {
        const raw = String(rawUrl || '').trim();
        if (!raw) {
            return '';
        }

        try {
            const url = new URL(raw);
            if (url.username) url.username = '***';
            if (url.password) url.password = '***';
            for (const key of Array.from(url.searchParams.keys())) {
                if (SENSITIVE_QUERY_KEYS.has(String(key).toLowerCase())) {
                    url.searchParams.set(key, '***');
                }
            }
            return url.toString();
        } catch (error) {
            return raw.replace(/\/\/([^:@/]+):([^@/]+)@/, '//***:***@');
        }
    }

    stripUrlQuery(url) {
        if (url.username) url.username = '***';
        if (url.password) url.password = '***';
        url.search = '';
        url.hash = '';
        return url.toString();
    }

    stripRawUrlQuery(rawUrl) {
        const raw = String(rawUrl || '').trim();
        if (!raw) {
            return '';
        }
        const withoutCredentials = raw.replace(/\/\/([^:@/]+):([^@/]+)@/, '//***:***@');
        return withoutCredentials.split('?')[0].split('#')[0];
    }

    maskProxyUrl(proxyUrl) {
        return this.maskUrl(proxyUrl);
    }
}

module.exports = OutboundClient;
