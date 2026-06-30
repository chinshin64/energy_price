const crypto = require('crypto');
const OutboundClient = require('../services/outbound-client');
const DidiSignatureProvider = require('../services/didi-signature-provider');

/**
 * 智能爬虫 - 分析 HAR 文件并自动爬取数据
 */
class SmartCrawler {
    constructor(parser, options = {}) {
        this.parser = parser;
        this.templates = new Map(); // 存储已识别的 API 模板
        this.didiCityIdCache = new Map();
        this.getProxySettings = typeof options.getProxySettings === 'function'
            ? options.getProxySettings
            : (() => ({ enabled: false, proxyUrl: '' }));
        this.getQuotaStatsStatus = typeof options.getQuotaStatsStatus === 'function'
            ? options.getQuotaStatsStatus
            : (() => ({
                date: null,
                totalRequests: 0,
                successRequests: 0,
                fail501Requests: 0,
                perRunLimit: 100
            }));
        this.getPerRunLimit = typeof options.getPerRunLimit === 'function'
            ? options.getPerRunLimit
            : (() => 100);
        this.getTestRequestLimit = typeof options.getTestRequestLimit === 'function'
            ? options.getTestRequestLimit
            : (() => Math.max(1, Math.floor(Number(options.testRequestLimitPerPlatform) || 5)));
        this.recordDailyRequest = typeof options.recordDailyRequest === 'function'
            ? options.recordDailyRequest
            : (() => null);
        this.outboundClient = options.outboundClient && typeof options.outboundClient.request === 'function'
            ? options.outboundClient
            : new OutboundClient({ getProxySettings: () => this.getProxySettings() });
        this.didiSignatureProvider = options.didiSignatureProvider || new DidiSignatureProvider(options.didiSignatureProviderOptions || {});
        this.userAgentPool = [
            'Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Mobile/15E148 Safari/604.1 MicroMessenger/8.0.55(0x18003738) NetType/WIFI Language/zh_CN',
            'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1 MicroMessenger/8.0.54(0x18003638) NetType/5G Language/zh_CN',
            'Mozilla/5.0 (Linux; Android 14; 23090RA98C Build/UKQ1.231003.002; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/124.0.6367.179 Mobile Safari/537.36 MicroMessenger/8.0.55.2800(0x28003739) WeChat/arm64 NetType/WIFI Language/zh_CN ABI/arm64 miniProgram',
            'Mozilla/5.0 (Linux; Android 15; V2407A Build/AP3A.240905.015.A2; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.6478.122 Mobile Safari/537.36 MicroMessenger/8.0.56.2800(0x2800383A) WeChat/arm64 NetType/4G Language/zh_CN ABI/arm64 miniProgram',
            'Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari/604.1',
            'Mozilla/5.0 (Linux; Android 14; 23113RKC6C Build/UKQ1.231207.002; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/125.0.6422.165 Mobile Safari/537.36'
        ];
    }

    normalizeTestRequestLimit(limit = null) {
        const raw = Number(limit ?? this.getTestRequestLimit());
        if (!Number.isFinite(raw) || raw <= 0) {
            return 5;
        }
        return Math.max(1, Math.floor(raw));
    }

    createTestRequestBudget(platform, options = {}) {
        const requestedLimit = Number(options.limit ?? options.maxRequests ?? this.normalizeTestRequestLimit());
        const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
            ? Math.max(1, Math.floor(requestedLimit))
            : this.normalizeTestRequestLimit();

        return {
            platform: String(platform || '').trim() || 'unknown',
            limit,
            used: 0,
            exhausted: false,
            requests: []
        };
    }

    normalizeTestRequestBudget(platform, requestBudget) {
        if (!requestBudget) {
            return null;
        }

        if (!requestBudget.platform) {
            requestBudget.platform = String(platform || '').trim() || 'unknown';
        }

        const requestedLimit = Number(requestBudget.limit ?? this.normalizeTestRequestLimit());
        requestBudget.limit = Number.isFinite(requestedLimit) && requestedLimit > 0
            ? Math.max(1, Math.floor(requestedLimit))
            : this.normalizeTestRequestLimit();
        requestBudget.used = Math.max(0, Math.floor(Number(requestBudget.used) || 0));
        if (!Array.isArray(requestBudget.requests)) {
            requestBudget.requests = [];
        }
        requestBudget.exhausted = requestBudget.used >= requestBudget.limit;
        return requestBudget;
    }

    hasTestRequestBudgetRemaining(requestBudget) {
        const budget = this.normalizeTestRequestBudget(requestBudget?.platform, requestBudget);
        return !budget || budget.used < budget.limit;
    }

    getTestRequestBudgetSummary(requestBudget) {
        const budget = this.normalizeTestRequestBudget(requestBudget?.platform, requestBudget);
        if (!budget) {
            return null;
        }

        return {
            platform: budget.platform,
            limit: budget.limit,
            used: budget.used,
            remaining: Math.max(0, budget.limit - budget.used),
            exhausted: Boolean(budget.exhausted),
            requests: budget.requests.map(item => ({ ...item }))
        };
    }

    formatTestRequestBudget(requestBudget) {
        const summary = this.getTestRequestBudgetSummary(requestBudget);
        if (!summary) {
            return '';
        }
        return `${summary.platform} ${summary.used}/${summary.limit}`;
    }

    createTestRequestBudgetExceededError(requestBudget, requestMeta = {}) {
        const budget = this.normalizeTestRequestBudget(requestBudget?.platform, requestBudget);
        const error = new Error(`调试请求保护已达上限：${budget.platform} 最多 ${budget.limit} 次`);
        error.code = 'TEST_REQUEST_LIMIT_EXCEEDED';
        error.requestBudget = this.getTestRequestBudgetSummary(budget);
        error.requestMeta = requestMeta;
        return error;
    }

    isTestRequestBudgetExceeded(error) {
        return error?.code === 'TEST_REQUEST_LIMIT_EXCEEDED';
    }

    normalizeQuotaStatsStatus(status = null) {
        if (!status || typeof status !== 'object') {
            const perRunLimit = this.normalizePerRunLimit();
            return {
                date: null,
                totalRequests: 0,
                successRequests: 0,
                fail501Requests: 0,
                perRunLimit,
                perRunUnlimited: perRunLimit === null
            };
        }

        const totalRequests = Math.max(0, Math.floor(Number(status.totalRequests) || 0));
        const successRequests = Math.max(0, Math.floor(Number(status.successRequests) || 0));
        const fail501Requests = Math.max(0, Math.floor(Number(status.fail501Requests) || 0));

        const perRunLimit = this.normalizePerRunLimit(status.perRunLimit);
        return {
            date: status.date || null,
            perRunLimit,
            perRunUnlimited: perRunLimit === null || Boolean(status.perRunUnlimited),
            totalRequests,
            successRequests,
            fail501Requests,
            updatedAt: status.updatedAt || null
        };
    }

    isUnlimitedRunLimit(limit) {
        const normalized = String(limit ?? '').trim().toLowerCase();
        return limit === null || ['unlimited', 'none', 'no-limit', 'infinity', '∞'].includes(normalized);
    }

    normalizePerRunLimit(limit = undefined) {
        const source = limit === undefined ? this.getPerRunLimit() : limit;
        if (this.isUnlimitedRunLimit(source)) {
            return null;
        }

        const raw = Number(source);
        if (!Number.isFinite(raw) || raw <= 0) {
            return 100;
        }
        return Math.max(1, Math.floor(raw));
    }

    createRunRequestQuota(limit = undefined) {
        const normalizedLimit = this.normalizePerRunLimit(limit);
        return {
            limit: normalizedLimit,
            unlimited: normalizedLimit === null,
            used: 0,
            success: 0,
            fail501: 0,
            exhausted: false,
            requests: []
        };
    }

    normalizeRunRequestQuota(runQuota) {
        if (!runQuota) {
            return null;
        }

        runQuota.limit = this.normalizePerRunLimit(runQuota.limit);
        runQuota.unlimited = runQuota.limit === null || Boolean(runQuota.unlimited);
        runQuota.used = Math.max(0, Math.floor(Number(runQuota.used) || 0));
        runQuota.success = Math.max(0, Math.floor(Number(runQuota.success) || 0));
        runQuota.fail501 = Math.max(0, Math.floor(Number(runQuota.fail501) || 0));
        if (!Array.isArray(runQuota.requests)) {
            runQuota.requests = [];
        }
        runQuota.exhausted = !runQuota.unlimited && runQuota.used >= runQuota.limit;
        return runQuota;
    }

    hasRunRequestQuotaRemaining(runQuota) {
        const quota = this.normalizeRunRequestQuota(runQuota);
        return !quota || quota.unlimited || quota.used < quota.limit;
    }

    getRunRequestQuotaSummary(runQuota, options = {}) {
        const quota = this.normalizeRunRequestQuota(runQuota);
        if (!quota) {
            return null;
        }

        const { includeRequests = true, tailRequestCount = 20 } = options;
        const summary = {
            limit: quota.limit,
            unlimited: Boolean(quota.unlimited),
            used: quota.used,
            success: quota.success,
            fail501: quota.fail501,
            remaining: quota.unlimited ? null : Math.max(0, quota.limit - quota.used),
            exhausted: Boolean(quota.exhausted)
        };

        if (includeRequests) {
            summary.requests = quota.requests.map(item => ({ ...item }));
        } else {
            summary.requestCount = quota.requests.length;
            summary.recentRequests = quota.requests
                .slice(-Math.max(0, Number(tailRequestCount) || 0))
                .map(item => ({ ...item }));
        }

        return summary;
    }

    formatRunRequestQuota(runQuota) {
        const summary = this.getRunRequestQuotaSummary(runQuota);
        if (!summary) {
            return '';
        }
        return summary.unlimited ? `${summary.used}/无上限` : `${summary.used}/${summary.limit}`;
    }

    createRunRequestLimitExceededError(pattern, runQuota, requestMeta = {}) {
        const summary = this.getRunRequestQuotaSummary(runQuota, { includeRequests: false });
        const platform = String(pattern?.platform || 'unknown');
        const error = new Error(`当次请求次数已达上限：${platform} ${this.formatRunRequestQuota(runQuota)}`);
        error.code = 'RUN_REQUEST_LIMIT_EXCEEDED';
        error.runQuota = summary;
        error.requestMeta = requestMeta;
        return error;
    }

    isRunRequestLimitExceeded(error) {
        return error?.code === 'RUN_REQUEST_LIMIT_EXCEEDED';
    }

    ensureRunRequestQuota(pattern, runQuota, requestMeta = {}) {
        const quota = this.normalizeRunRequestQuota(runQuota);
        if (!quota) {
            return null;
        }

        if (!quota.unlimited && quota.used >= quota.limit) {
            quota.exhausted = true;
            throw this.createRunRequestLimitExceededError(pattern, quota, requestMeta);
        }
        return quota;
    }

    recordRunRequest(runQuota, pattern, requestMeta = {}) {
        const quota = this.normalizeRunRequestQuota(runQuota);
        if (!quota) {
            return null;
        }

        quota.used += 1;
        if (requestMeta.success) {
            quota.success += 1;
        }
        if (Number(requestMeta.statusCode) === 501) {
            quota.fail501 += 1;
        }

        quota.requests.push({
            index: quota.used,
            at: new Date().toISOString(),
            method: String(pattern?.method || 'GET').toUpperCase(),
            url: pattern?.baseUrl || '',
            reason: requestMeta.reason || null,
            statusCode: Number(requestMeta.statusCode) || null,
            success: Boolean(requestMeta.success)
        });

        quota.exhausted = !quota.unlimited && quota.used >= quota.limit;
        return quota;
    }

    getQuotaStatsSummary() {
        try {
            const status = this.getQuotaStatsStatus();
            return this.normalizeQuotaStatsStatus(status);
        } catch (error) {
            return this.normalizeQuotaStatsStatus(null);
        }
    }

    consumeTestRequestBudget(pattern, requestBudget, requestMeta = {}) {
        const budget = this.normalizeTestRequestBudget(pattern?.platform, requestBudget);
        if (!budget) {
            return null;
        }

        if (budget.used >= budget.limit) {
            budget.exhausted = true;
            throw this.createTestRequestBudgetExceededError(budget, requestMeta);
        }

        budget.used += 1;
        budget.requests.push({
            index: budget.used,
            at: new Date().toISOString(),
            method: String(pattern?.method || 'GET').toUpperCase(),
            url: pattern?.baseUrl || '',
            reason: requestMeta.reason || null
        });
        budget.exhausted = budget.used >= budget.limit;
        return budget;
    }

    /**
     * 从 HAR 文件学习 API 模式
     */
    async learnFromHAR(harFilePath) {
        console.log(`\n🧠 分析 HAR 文件学习 API 模式...`);
        
        const fs = require('fs');
        const content = fs.readFileSync(harFilePath, 'utf8');
        const har = JSON.parse(content);
        
        const patterns = [];
        
        for (const entry of har.log.entries) {
            const url = entry.request.url;
            const method = entry.request.method;
            
            // 只关注充电站相关的 API
            if (!this.parser.isStationAPI(url)) {
                continue;
            }
            
            // 提取请求模式
            const pattern = this.extractPattern(entry);
            if (pattern && this.isUsefulPattern(entry, pattern)) {
                patterns.push(pattern);
            }
        }
        
        // 去重并保存
        const uniquePatterns = this.deduplicatePatterns(patterns);
        
        console.log(`✅ 学习完成，识别到 ${uniquePatterns.length} 个 API 模式\n`);
        
        uniquePatterns.forEach((p, i) => {
            console.log(`${i + 1}. ${p.platform} - ${p.method} ${p.baseUrl}`);
            if (p.variableParams && Object.keys(p.variableParams).length > 0) {
                console.log(`   可变参数: ${Object.keys(p.variableParams).join(', ')}`);
            } else {
                console.log(`   可变参数: 无`);
            }
        });
        
        return uniquePatterns;
    }

    /**
     * 提取请求模式
     */
    extractPattern(entry) {
        const url = entry.request.url;
        const method = entry.request.method;
        const headers = entry.request.headers;
        
        // 解析 URL
        let urlObj;
        try {
            urlObj = new URL(url);
        } catch (e) {
            return null;
        }
        
        const platform = this.parser.detectPlatform(url);
        
        // 提取请求体参数
        const bodyParams = this.parseRequestBody(entry.request.postData);
        
        // 提取查询参数
        const queryParams = this.extractQueryParams(urlObj, platform);
        
        // 识别可变参数
        const variableParams = this.identifyVariableParams(bodyParams, queryParams);
        const templateScope = this.classifyTemplateScope(urlObj.pathname, method, variableParams);

        return {
            platform,
            method,
            baseUrl: urlObj.origin + urlObj.pathname,
            templateScope,
            queryParams,
            bodyParams,
            variableParams,
            headers: this.extractEssentialHeaders(headers, platform, urlObj.pathname),
            sampleResponse: entry.response
        };
    }

    extractQueryParams(urlObj, platform) {
        const queryParams = {};
        const pathname = urlObj?.pathname || '';

        urlObj.searchParams.forEach((value, key) => {
            if (!this.shouldKeepQueryParam(platform, pathname, key)) {
                return;
            }
            queryParams[key] = value;
        });

        return queryParams;
    }

    shouldKeepQueryParam(platform, pathname, key) {
        return true;
    }

    parseRequestBody(postData) {
        if (!postData) {
            return {};
        }

        if (Array.isArray(postData.params) && postData.params.length > 0) {
            const params = {};
            for (const item of postData.params) {
                if (!item || !item.name) {
                    continue;
                }
                params[item.name] = item.value;
            }
            return params;
        }

        const text = String(postData.text || '').trim();
        if (!text) {
            return {};
        }

        try {
            return JSON.parse(text);
        } catch (error) {
            // Fall through to URL encoded parsing.
        }

        try {
            const params = {};
            const searchParams = new URLSearchParams(text);
            for (const [key, value] of searchParams.entries()) {
                params[key] = value;
            }
            return params;
        } catch (error) {
            return {};
        }
    }

    isUsefulPattern(entry, pattern) {
        if (!pattern) {
            return false;
        }

        if (pattern.platform === 'teld') {
            return false;
        }

        const responseText = this.extractResponseText(entry?.response);
        if (!responseText) {
            return false;
        }

        try {
            const parsed = this.parser.parseResponseByPlatform(pattern.platform, responseText) || [];
            return parsed.length > 0;
        } catch (error) {
            return false;
        }
    }

    extractResponseText(response) {
        const text = response?.content?.text;
        if (typeof text !== 'string' || !text.trim()) {
            return '';
        }

        if (response?.content?.encoding === 'base64') {
            try {
                return Buffer.from(text, 'base64').toString('utf8');
            } catch (error) {
                return '';
            }
        }

        return text;
    }

    /**
     * 识别可变参数（坐标、城市、页码等）
     */
    identifyVariableParams(bodyParams, queryParams) {
        const variable = {};
        
        // 确保参数是对象
        if (!bodyParams || typeof bodyParams !== 'object') {
            bodyParams = {};
        }
        if (!queryParams || typeof queryParams !== 'object') {
            queryParams = {};
        }
        
        // 常见的可变参数（扩展版）
        const fuzzyVariableKeys = [
            // 坐标相关
            'lat', 'lng', 'latitude', 'longitude',
            'userlat', 'userlng', 'user_lat', 'user_lng',
            'location_lat', 'location_lng',
            'center_lat', 'center_lng',
            'location', 'latlng', 'latLng',
            
            // 城市相关
            'city', 'cityId', 'cityCode', 'city_id', 'city_code',
            'cityname', 'city_name',
            'area', 'areaId', 'area_id',
            'region', 'regionId', 'region_id',
            
            // 分页相关
            'page', 'pageNum', 'pageSize', 'page_num', 'page_size',
            'limit', 'offset', 'size', 'count',
            'start', 'end', 'skip', 'take',
            'pageindex', 'pagecount',
            
            // 距离相关
            'distance', 'radius', 'range',
            'maxDistance', 'max_distance',
            'searchRadius', 'search_radius',
            
            // 其他常见可变参数
            'keyword', 'search', 'query', 'q',
            'filter', 'sort', 'order'
        ];

        const exactVariableTypes = new Map([
            ['stationid', 'station_identifier'],
            ['fullstationid', 'station_identifier'],
            ['stationcode', 'station_identifier'],
            ['czbstationid', 'station_identifier'],
            ['gasid', 'station_identifier'],
            ['stubgroupid', 'station_identifier'],
            ['oilno', 'detail_option'],
            ['id', 'station_identifier']
        ]);

        const shouldTrack = (key) => {
            const compactKey = String(key || '').replace(/[_-]/g, '').toLowerCase();
            if (exactVariableTypes.has(compactKey)) {
                return true;
            }
            return fuzzyVariableKeys.some(vk => compactKey.includes(vk.toLowerCase()));
        };

        const getParamType = (key, value) => {
            const compactKey = String(key || '').replace(/[_-]/g, '').toLowerCase();
            if (exactVariableTypes.has(compactKey)) {
                return exactVariableTypes.get(compactKey);
            }
            return this.guessParamType(key, value);
        };
        
        // 检查 body 参数
        try {
            for (const [key, value] of Object.entries(bodyParams)) {
                if (shouldTrack(key)) {
                    variable[key] = {
                        location: 'body',
                        type: getParamType(key, value),
                        sample: value
                    };
                }
            }
        } catch (e) {
            console.warn('解析 body 参数失败:', e.message);
        }
        
        // 检查 query 参数
        try {
            for (const [key, value] of Object.entries(queryParams)) {
                if (shouldTrack(key)) {
                    variable[key] = {
                        location: 'query',
                        type: getParamType(key, value),
                        sample: value
                    };
                }
            }
        } catch (e) {
            console.warn('解析 query 参数失败:', e.message);
        }
        
        return variable;
    }

    classifyTemplateScope(pathname, method, variableParams = {}) {
        const lowerPath = String(pathname || '').toLowerCase();
        const variableTypes = Object.values(variableParams).map(item => item.type);

        if (
            /getoneinfo|detail|info\/extra|price\/detail|getcombinedetail|getczbconnectorinfo|getgunoilinfo/i.test(lowerPath) ||
            variableTypes.includes('station_identifier')
        ) {
            return 'detail';
        }

        if (/list|search|around|mapgasinfolistpage|searchstation/i.test(lowerPath)) {
            return 'list';
        }

        if (variableTypes.includes('pagination')) {
            return 'list';
        }

        return method === 'GET' ? 'list' : 'detail';
    }

    /**
     * 猜测参数类型
     */
    guessParamType(key, value) {
        const k = key.toLowerCase();
        
        if (k.includes('lat') || k.includes('lng') || k.includes('longitude') || k.includes('latitude')) {
            return 'coordinate';
        }
        if (k.includes('city')) {
            return 'city';
        }
        if (k.includes('page') || k.includes('offset')) {
            return 'pagination';
        }
        if (k.includes('distance') || k.includes('radius')) {
            return 'distance';
        }
        
        return 'unknown';
    }

    /**
     * 提取关键请求头
     */
    extractEssentialHeaders(headers, platform, pathname = '') {
        const essential = {};
        const keepExact = new Set([
            'content-type',
            'user-agent',
            'accept',
            'accept-language',
            'referer',
            'origin',
            'authorization',
            'xweb_xhr',
            'appversion',
            'channel-id',
            'positcity',
            'sid',
            'did',
            'userid',
            'signature',
            'timestamp',
            'lmdtag',
            'x-uid',
            'x-tingyun'
        ]);
        const keepPrefixes = ['secdd-', 'x-ca-'];
        const blocked = new Set(['host', 'content-length', 'connection', 'accept-encoding']);

        headers.forEach(h => {
            const name = String(h?.name || '').toLowerCase();
            if (!name || name.startsWith(':') || blocked.has(name)) {
                return;
            }

            if (
                keepExact.has(name)
                || keepPrefixes.some(prefix => name.startsWith(prefix))
                || name.startsWith('x-')
            ) {
                essential[name] = h.value;
            }
        });
        
        return essential;
    }

    /**
     * 去重模式
     */
    deduplicatePatterns(patterns) {
        const seen = new Set();
        const unique = [];
        
        for (const p of patterns) {
            const key = this.buildPatternDedupKey(p);
            if (!seen.has(key)) {
                seen.add(key);
                unique.push(p);
            }
        }
        
        return unique;
    }

    /**
     * 使用学习到的模式爬取数据
     */
    async crawl(pattern, options = {}) {
        console.log(`\n🚀 开始爬取: ${pattern.platform} - ${pattern.baseUrl}`);
        
        const {
            coordinates = [],  // [{lat, lng}]
            cities = [],
            radiusKm = null,
            pageSize = 10,
            maxPages = 5,
            logger = null,
            requestBudget = null,
            runQuota = null,
            proxyContext = null,
            progressReporter = null
        } = options;
        
        const allStations = [];
        const activeRequestBudget = this.normalizeTestRequestBudget(pattern.platform, requestBudget);
        const activeRunQuota = this.normalizeRunRequestQuota(runQuota);
        const targetMismatch = this.getSignedTemplateTargetMismatch(pattern, proxyContext);
        if (targetMismatch) {
            if (logger) {
                logger(targetMismatch, 'warn');
            }
            return allStations;
        }

        const crawlCoordinates = this.planCoordinatesForPattern(pattern, coordinates, radiusKm, logger, proxyContext);
        const effectiveMaxPages = this.getEffectiveMaxPagesForPattern(pattern, maxPages, logger, proxyContext);
        const failureGuard = this.createCrawlFailureGuard(pattern);

        // 如果提供了坐标列表，遍历爬取
        if (crawlCoordinates.length > 0) {
            for (const coord of crawlCoordinates) {
                if (!this.hasTestRequestBudgetRemaining(activeRequestBudget)) {
                    if (logger) {
                        logger(`调试请求保护已达上限，停止后续坐标: ${this.formatTestRequestBudget(activeRequestBudget)}`, 'warn');
                    }
                    break;
                }
                if (!this.hasRunRequestQuotaRemaining(activeRunQuota)) {
                    if (logger) {
                        logger(`当次请求已达上限，停止后续坐标: ${this.formatRunRequestQuota(activeRunQuota)}`, 'warn');
                    }
                    break;
                }

                console.log(`  📍 爬取坐标: (${coord.lat}, ${coord.lng})`);
                if (logger) logger(`坐标 (${coord.lat}, ${coord.lng}) 开始爬取`);
                
                try {
                    const beforeQuota = this.snapshotRunQuota(activeRunQuota);
                    const stations = await this.crawlByCoordinate(
                        pattern,
                        coord,
                        radiusKm,
                        pageSize,
                        effectiveMaxPages,
                        logger,
                        activeRequestBudget,
                        activeRunQuota,
                        proxyContext,
                        progressReporter
                    );
                    allStations.push(...stations);
                    
                    console.log(`    ✅ 找到 ${stations.length} 个场站`);
                    if (logger) logger(`坐标 (${coord.lat}, ${coord.lng}) 完成，解析到 ${stations.length} 个场站`);
                    
                    // 延迟，避免请求过快
                    await this.sleep(1000);
                    const stopReason = this.updateCrawlFailureGuard(
                        failureGuard,
                        beforeQuota,
                        this.snapshotRunQuota(activeRunQuota),
                        stations.length,
                        allStations.length
                    );
                    if (stopReason) {
                        if (logger) {
                            logger(stopReason, 'warn');
                        }
                        break;
                    }
                } catch (error) {
                    console.error(`    ❌ 爬取失败: ${error.message}`);
                    if (this.isTestRequestBudgetExceeded(error) || this.isRunRequestLimitExceeded(error)) {
                        if (logger) {
                            logger(
                                this.isRunRequestLimitExceeded(error)
                                    ? `当次请求已达上限，停止后续坐标: ${this.formatRunRequestQuota(error.runQuota)}`
                                    : `调试请求保护已达上限，停止后续坐标: ${this.formatTestRequestBudget(activeRequestBudget)}`,
                                'warn'
                            );
                        }
                        break;
                    }
                    if (logger) logger(`坐标 (${coord.lat}, ${coord.lng}) 失败: ${error.message}`, 'error');
                }
            }
        }
        
        console.log(`\n✅ 爬取完成，共获取 ${allStations.length} 个场站\n`);
        
        return allStations;
    }

    isDidiSignedListPattern(pattern) {
        if (!pattern || pattern.platform !== 'didi-charging') {
            return false;
        }

        const scope = String(pattern.templateScope || pattern.template_scope || '').toLowerCase();
        if (scope && scope !== 'list') {
            return false;
        }

        const query = pattern.queryParams || {};
        const body = pattern.bodyParams || {};
        return query.wsgsig !== undefined || body.wsgsig !== undefined;
    }

    getEffectiveMaxPagesForPattern(pattern, maxPages, logger = null, proxyContext = null) {
        const parsedMaxPages = Math.max(1, Math.floor(Number(maxPages) || 1));
        if (!this.isDidiSignedListPattern(pattern)) {
            return parsedMaxPages;
        }

        const corpusMaxPage = this.getDidiSignatureMaxPageForTarget(pattern, proxyContext);
        if (corpusMaxPage > 1) {
            const effectiveMaxPages = Math.min(parsedMaxPages, corpusMaxPage);
            if (logger) {
                logger(
                    `滴滴签名语料分页覆盖 1-${corpusMaxPage} 页，本次执行 ${effectiveMaxPages} 页`,
                    effectiveMaxPages < parsedMaxPages ? 'warn' : 'info'
                );
            }
            return effectiveMaxPages;
        }

        if (parsedMaxPages > 1) {
            if (logger) {
                logger('滴滴签名列表模板启用单页探测：签名样本分页复用容易触发 501，已将本次模板分页限制为 1 页', 'warn');
            }
            return 1;
        }
        return 1;
    }

    planCoordinatesForPattern(pattern, coordinates, radiusKm, logger = null, proxyContext = null) {
        if (!Array.isArray(coordinates) || coordinates.length === 0) {
            return [];
        }
        if (!this.isDidiSignedListPattern(pattern)) {
            return coordinates;
        }

        if (this.hasDidiSignatureSampleForTarget(pattern, proxyContext)) {
            const target = this.extractTargetCoordinate(proxyContext);
            const first = target || coordinates[0];
            if (logger) {
                logger('滴滴签名语料已命中目标位置：本次使用语料坐标单点请求，避免网格坐标改签触发 501', 'warn');
            }
            return first ? [first] : coordinates.slice(0, 1);
        }

        const maxCount = this.getDidiSignedCoordinateCap(radiusKm);
        if (coordinates.length <= maxCount) {
            return coordinates;
        }

        const selected = this.sampleCoordinatesAcrossGrid(coordinates, maxCount);
        if (logger) {
            logger(`滴滴签名列表模板启用保守探测：坐标 ${coordinates.length} -> ${selected.length}，减少无效 501 请求`, 'warn');
        }
        return selected;
    }

    getDidiSignedCoordinateCap(radiusKm) {
        const radius = Math.max(0, Number(radiusKm) || 0);
        if (radius <= 1) return 25;
        if (radius <= 5) return 49;
        if (radius <= 10) return 81;
        return 121;
    }

    sampleCoordinatesAcrossGrid(coordinates, maxCount) {
        const normalized = coordinates
            .map((coord, index) => ({
                ...coord,
                __index: index,
                __distance: Number.isFinite(Number(coord.distanceKm)) ? Number(coord.distanceKm) : index
            }))
            .sort((a, b) => a.__distance - b.__distance || a.__index - b.__index);

        if (normalized.length <= maxCount) {
            return normalized.map(({ __index, __distance, ...coord }) => coord);
        }

        const picked = new Map();
        const add = item => {
            const key = `${Number(item.lat).toFixed(8)},${Number(item.lng).toFixed(8)}`;
            if (!picked.has(key)) {
                const { __index, __distance, ...coord } = item;
                picked.set(key, coord);
            }
        };

        add(normalized[0]);
        const slots = Math.max(1, maxCount - 1);
        for (let i = 1; i <= slots; i++) {
            const index = Math.min(
                normalized.length - 1,
                Math.round((i * (normalized.length - 1)) / slots)
            );
            add(normalized[index]);
        }

        for (const item of normalized) {
            if (picked.size >= maxCount) {
                break;
            }
            add(item);
        }

        return Array.from(picked.values());
    }

    createCrawlFailureGuard(pattern) {
        return {
            enabled: this.isDidiSignedListPattern(pattern),
            attempts: 0,
            consecutiveEmptyOr501: 0
        };
    }

    snapshotRunQuota(runQuota) {
        const quota = this.normalizeRunRequestQuota(runQuota);
        return {
            used: quota?.used || 0,
            success: quota?.success || 0,
            fail501: quota?.fail501 || 0
        };
    }

    updateCrawlFailureGuard(guard, beforeQuota, afterQuota, stationCount, totalStationCount) {
        if (!guard || !guard.enabled) {
            return null;
        }

        guard.attempts += 1;
        const deltaSuccess = Math.max(0, (afterQuota?.success || 0) - (beforeQuota?.success || 0));
        const delta501 = Math.max(0, (afterQuota?.fail501 || 0) - (beforeQuota?.fail501 || 0));
        const emptyOrFailed = stationCount === 0 && (delta501 > 0 || deltaSuccess === 0);
        guard.consecutiveEmptyOr501 = emptyOrFailed ? guard.consecutiveEmptyOr501 + 1 : 0;

        if (guard.attempts >= 120 && totalStationCount === 0 && (afterQuota?.fail501 || 0) >= Math.floor(guard.attempts * 0.8)) {
            return '滴滴签名列表模板连续探测未拿到有效数据，已停止后续坐标，避免继续产生 501 无效请求';
        }

        if (totalStationCount > 0 && guard.consecutiveEmptyOr501 >= 40) {
            return '滴滴签名列表模板已获取数据，随后连续 40 个探测点无有效返回，已停止后续坐标';
        }

        return null;
    }

    getSignedTemplateTargetMismatch(pattern, proxyContext = null) {
        if (!this.isDidiSignedListPattern(pattern)) {
            return null;
        }

        if (this.hasDidiSignatureSampleForTarget(pattern, proxyContext)) {
            return null;
        }

        const anchor = this.extractTemplateAnchorCoordinate(pattern);
        const target = this.extractTargetCoordinate(proxyContext);
        if (!anchor || !target) {
            return null;
        }

        const distanceKm = this.calculateDistanceKm(anchor.lat, anchor.lng, target.lat, target.lng);
        if (!Number.isFinite(distanceKm) || distanceKm <= 50) {
            return null;
        }

        const targetLabel = [
            proxyContext?.province,
            proxyContext?.city,
            proxyContext?.district,
            proxyContext?.keyword || proxyContext?.name
        ].filter(Boolean).join(' / ') || `${target.lat},${target.lng}`;

        return `滴滴签名列表模板样本坐标 ${anchor.lat},${anchor.lng} 与目标 ${targetLabel} 距离约 ${Math.round(distanceKm)}km，签名参数不可跨城复用，已跳过该模板；请补齐目标的实际请求参数或签名算法`;
    }

    extractTemplateAnchorCoordinate(pattern) {
        const body = pattern?.bodyParams || {};
        const query = pattern?.queryParams || {};
        const lat = this.pickCoordinateValue(body, query, ['lat', 'latitude', 'userlat', 'userLat', 'gdLat', 'centerLat']);
        const lng = this.pickCoordinateValue(body, query, ['lng', 'longitude', 'userlng', 'userLng', 'gdLng', 'centerLng']);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
            return null;
        }
        return { lat, lng };
    }

    extractTargetCoordinate(proxyContext = null) {
        const lat = Number(proxyContext?.lat);
        const lng = Number(proxyContext?.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
            return null;
        }
        return { lat, lng };
    }

    pickCoordinateValue(body, query, keys) {
        for (const key of keys) {
            if (body[key] !== undefined && Number.isFinite(Number(body[key]))) {
                return Number(body[key]);
            }
            if (query[key] !== undefined && Number.isFinite(Number(query[key]))) {
                return Number(query[key]);
            }
        }
        return NaN;
    }

    calculateDistanceKm(lat1, lng1, lat2, lng2) {
        const toRad = value => (Number(value) * Math.PI) / 180;
        const earthRadiusKm = 6371;
        const dLat = toRad(lat2 - lat1);
        const dLng = toRad(lng2 - lng1);
        const a = Math.sin(dLat / 2) ** 2
            + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
        return 2 * earthRadiusKm * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    hasDidiSignatureSampleForTarget(pattern, proxyContext = null) {
        if (!this.didiSignatureProvider || typeof this.didiSignatureProvider.hasListSample !== 'function') {
            return false;
        }
        const target = this.extractTargetCoordinate(proxyContext);
        if (!target) {
            return false;
        }
        return this.didiSignatureProvider.hasListSample(
            pattern,
            {
                body: {
                    lat: target.lat,
                    lng: target.lng,
                    userlat: target.lat,
                    userlng: target.lng,
                    pageNo: 1
                },
                query: {}
            },
            proxyContext
        );
    }

    getDidiSignatureMaxPageForTarget(pattern, proxyContext = null) {
        if (!this.didiSignatureProvider || typeof this.didiSignatureProvider.getMaxListPage !== 'function') {
            return 0;
        }
        const target = this.extractTargetCoordinate(proxyContext);
        if (!target) {
            return 0;
        }
        return Number(this.didiSignatureProvider.getMaxListPage(
            pattern,
            {
                body: {
                    lat: target.lat,
                    lng: target.lng,
                    userlat: target.lat,
                    userlng: target.lng,
                    pageNo: 1
                },
                query: {}
            },
            proxyContext
        )) || 0;
    }

    hasDidiDetailSignatureSample(pattern, seedStation, proxyContext = null) {
        if (!this.didiSignatureProvider || typeof this.didiSignatureProvider.hasDetailSample !== 'function') {
            return false;
        }
        if (!pattern || pattern.platform !== 'didi-charging' || !this.isDidiDetailPath(this.safePathname(pattern.baseUrl))) {
            return false;
        }
        const overrides = this.buildDetailOverrides(seedStation);
        const params = this.buildParams(pattern, overrides);
        return this.didiSignatureProvider.hasDetailSample(pattern, params, proxyContext);
    }

    async crawlDetail(pattern, options = {}) {
        const {
            seedStations = [],
            logger = null,
            requestBudget = null,
            runQuota = null,
            proxyContext = null,
            progressReporter = null
        } = options;
        const activeRequestBudget = this.normalizeTestRequestBudget(pattern.platform, requestBudget);
        const activeRunQuota = this.normalizeRunRequestQuota(runQuota);

        const resolvedSeeds = this.filterDetailSeedsForPattern(pattern, seedStations, proxyContext);
        if (
            logger
            && pattern?.platform === 'didi-charging'
            && this.isDidiDetailPath(this.safePathname(pattern.baseUrl))
            && seedStations.length !== resolvedSeeds.length
        ) {
            logger(`滴滴详情签名语料匹配 ${resolvedSeeds.length}/${seedStations.length} 个场站，未匹配的场站跳过详情请求`, 'warn');
        }
        if (seedStations.length > 0 && resolvedSeeds.length === 0 && this.shouldUseSampleBoundDetail(pattern)) {
            if (logger) {
                logger('详情模板未匹配到对应样本场站，跳过当前模板', 'warn');
            }
            return [];
        }

        const detailStations = [];
        let consecutiveDidiDetail501 = 0;

        for (const seedStation of resolvedSeeds) {
            if (!this.hasTestRequestBudgetRemaining(activeRequestBudget)) {
                if (logger) {
                    logger(`调试请求保护已达上限，停止后续详情: ${this.formatTestRequestBudget(activeRequestBudget)}`, 'warn');
                }
                break;
            }
            if (!this.hasRunRequestQuotaRemaining(activeRunQuota)) {
                if (logger) {
                    logger(`当次请求已达上限，停止后续详情: ${this.formatRunRequestQuota(activeRunQuota)}`, 'warn');
                }
                break;
            }

            const overrides = await this.enrichDetailOverrides(
                pattern,
                this.buildDetailOverrides(seedStation),
                seedStation,
                logger,
                activeRequestBudget,
                activeRunQuota,
                proxyContext
            );

            if (!this.hasResolvedDetailParams(pattern, overrides)) {
                if (logger) {
                    logger(`详情模板缺少必需参数，跳过: ${seedStation.station_name || seedStation.stationName || seedStation.station_id || seedStation.stationId}`, 'warn');
                }
                continue;
            }

            const signatureAttemptLimit = this.getDetailSignatureAttemptLimit(pattern);
            let shouldStopDetail = false;
            let handled = false;
            for (let signatureAttempt = 0; signatureAttempt < signatureAttemptLimit; signatureAttempt++) {
                try {
                    const params = this.buildParams(pattern, overrides);
                    const response = await this.sendRequest(pattern, params, {
                        requestBudget: activeRequestBudget,
                        runQuota: activeRunQuota,
                        reason: 'detail',
                        signatureAttempt,
                        proxyContext,
                        logger,
                        progressReporter
                    });
                    const parsed = this.parser.parseResponseByPlatform(
                        pattern.platform,
                        JSON.stringify(response.data),
                        this.buildParseContext(pattern, params, 'template-detail')
                    ) || [];

                    if (parsed.length > 0) {
                        detailStations.push(...parsed);
                        consecutiveDidiDetail501 = 0;
                        handled = true;
                        if (logger) {
                            logger(`详情请求成功: ${seedStation.station_name || seedStation.stationName || seedStation.station_id || seedStation.stationId}`);
                        }
                    } else if (logger) {
                        logger(`详情请求无可解析数据: ${seedStation.station_name || seedStation.stationName || seedStation.station_id || seedStation.stationId}`, 'warn');
                    }
                    break;
                } catch (error) {
                    if (this.isTestRequestBudgetExceeded(error) || this.isRunRequestLimitExceeded(error)) {
                        if (logger) {
                            logger(
                                this.isRunRequestLimitExceeded(error)
                                    ? `当次请求已达上限，停止后续详情: ${this.formatRunRequestQuota(error.runQuota)}`
                                    : `调试请求保护已达上限，停止后续详情: ${this.formatTestRequestBudget(activeRequestBudget)}`,
                                'warn'
                            );
                        }
                        shouldStopDetail = true;
                        break;
                    }

                    const isDidiDetail501 = pattern.platform === 'didi-charging'
                        && this.isDidiDetailPath(this.safePathname(pattern.baseUrl))
                        && Number(error?.response?.status) === 501;
                    if (isDidiDetail501 && signatureAttempt + 1 < signatureAttemptLimit) {
                        if (logger) {
                            logger(`详情签名样本 attempt=${signatureAttempt + 1} 返回 501，切换下一条样本重试`, 'warn');
                        }
                        continue;
                    }

                    if (isDidiDetail501) {
                        consecutiveDidiDetail501 += 1;
                        if (consecutiveDidiDetail501 >= 3) {
                            if (logger) {
                                logger('滴滴详情接口连续 3 次 501，停止当前详情模板，保留列表页数据并避免继续触发风控', 'warn');
                            }
                            shouldStopDetail = true;
                            break;
                        }
                    } else {
                        consecutiveDidiDetail501 = 0;
                    }
                    if (logger) {
                        logger(
                            `详情请求失败: ${seedStation.station_name || seedStation.stationName || seedStation.station_id || seedStation.stationId} - ${this.formatRequestError(error)}`,
                            'error'
                        );
                    }
                    break;
                }
            }
            if (shouldStopDetail) {
                break;
            }

            await this.sleep(this.getDetailRequestDelayMs(pattern));
        }

        return this.parser.deduplicateStations(detailStations);
    }

    getDetailRequestDelayMs(pattern) {
        if (pattern?.platform === 'didi-charging' && this.isDidiDetailPath(this.safePathname(pattern.baseUrl))) {
            return 800;
        }
        return 200;
    }

    getDetailSignatureAttemptLimit(pattern) {
        if (pattern?.platform === 'didi-charging' && this.isDidiDetailPath(this.safePathname(pattern.baseUrl))) {
            return 3;
        }
        return 1;
    }

    getListSignatureAttemptLimit(pattern) {
        if (this.isDidiSignedListPattern(pattern)) {
            return 3;
        }
        return 1;
    }

    async enrichDetailOverrides(pattern, overrides, seedStation, logger = null, requestBudget = null, runQuota = null, proxyContext = null) {
        if (pattern.platform === 'didi-charging' && this.hasDidiDetailSignatureSample(pattern, seedStation, proxyContext)) {
            return overrides;
        }

        if (pattern.platform === 'didi-charging' && overrides.cityId === undefined) {
            const cityId = await this.resolveDidiCityId(pattern, overrides, seedStation, logger, requestBudget, runQuota, proxyContext);
            if (cityId !== undefined) {
                overrides.cityId = cityId;
                overrides.cityid = cityId;
            }
        }

        return overrides;
    }

    /**
     * 按坐标爬取
     */
    async crawlByCoordinate(pattern, coordinate, radiusKm, pageSize, maxPages, logger = null, requestBudget = null, runQuota = null, proxyContext = null, progressReporter = null) {
        const stations = [];
        
        for (let page = 1; page <= maxPages; page++) {
            if (!this.hasTestRequestBudgetRemaining(requestBudget)) {
                if (logger) {
                    logger(`调试请求保护已达上限，停止分页: ${this.formatTestRequestBudget(requestBudget)}`, 'warn');
                }
                break;
            }
            if (!this.hasRunRequestQuotaRemaining(runQuota)) {
                if (logger) {
                    logger(`当次请求已达上限，停止分页: ${this.formatRunRequestQuota(runQuota)}`, 'warn');
                }
                break;
            }

            // 构建请求参数
            const params = this.buildParams(pattern, {
                lat: coordinate.lat,
                lng: coordinate.lng,
                radiusKm,
                page,
                pageSize
            });

            if (
                this.isDidiSignedListPattern(pattern)
                && this.didiSignatureProvider
                && typeof this.didiSignatureProvider.hasListSample === 'function'
                && !this.didiSignatureProvider.hasListSample(pattern, params, proxyContext)
            ) {
                if (logger) {
                    logger(`滴滴签名语料缺少 page=${page} 的可复用样本，停止后续分页，避免触发 501`, 'warn');
                }
                break;
            }
            
            let pageHandled = false;
            const signatureAttemptLimit = this.getListSignatureAttemptLimit(pattern);
            for (let signatureAttempt = 0; signatureAttempt < signatureAttemptLimit; signatureAttempt++) {
                try {
                    const response = await this.sendRequest(pattern, params, {
                        requestBudget,
                        runQuota,
                        reason: `list-page-${page}`,
                        signatureAttempt,
                        proxyContext,
                        logger,
                        progressReporter
                    });
                    if (logger) logger(`请求成功: ${pattern.method} ${pattern.baseUrl} page=${page}`);

                    const parsed = this.parser.parseResponseByPlatform(
                        pattern.platform,
                        JSON.stringify(response.data),
                        this.buildParseContext(pattern, params, 'template-list')
                    );

                    if (parsed.length === 0) {
                        pageHandled = true;
                        maxPages = page;
                        break;
                    }

                    stations.push(...parsed);
                    pageHandled = true;

                    if (parsed.length < pageSize) {
                        maxPages = page;
                    }
                    break;
                } catch (error) {
                    if (this.isTestRequestBudgetExceeded(error) || this.isRunRequestLimitExceeded(error)) {
                        if (logger) {
                            logger(
                                this.isRunRequestLimitExceeded(error)
                                    ? `当次请求已达上限，停止分页: ${this.formatRunRequestQuota(error.runQuota)}`
                                    : `调试请求保护已达上限，停止分页: ${this.formatTestRequestBudget(requestBudget)}`,
                                'warn'
                            );
                        }
                        pageHandled = true;
                        maxPages = page;
                        break;
                    }

                    const canRetrySignature = this.isDidiSignedListPattern(pattern)
                        && Number(error?.response?.status) === 501
                        && signatureAttempt + 1 < signatureAttemptLimit;
                    if (canRetrySignature) {
                        if (logger) {
                            logger(`列表 page=${page} 签名样本 attempt=${signatureAttempt + 1} 返回 501，切换下一条样本重试`, 'warn');
                        }
                        continue;
                    }

                    console.error(`      页码 ${page} 失败: ${this.formatRequestError(error)}`);
                    if (logger) logger(`页码 ${page} 请求失败: ${this.formatRequestError(error)}`, 'error');
                    pageHandled = true;
                    maxPages = page;
                    break;
                }
            }
            if (!pageHandled || page >= maxPages) {
                break;
            }
        }
        
        return stations;
    }

    /**
     * 构建请求参数
     */
    buildParams(pattern, overrides) {
        const params = {
            query: { ...pattern.queryParams },
            body: { ...pattern.bodyParams }
        };
        
        // 应用覆盖参数
        for (const [key, info] of Object.entries(pattern.variableParams)) {
            const overrideValue = this.resolveOverrideValue(key, info, overrides);

            if (info.location === 'body' && overrideValue !== undefined) {
                params.body[key] = overrideValue;
                
                // 同时更新 userlat/userlng
                if (key === 'lat' && params.body['userlat'] !== undefined) {
                    params.body['userlat'] = overrideValue;
                }
                if (key === 'lng' && params.body['userlng'] !== undefined) {
                    params.body['userlng'] = overrideValue;
                }
            }
            if (info.location === 'query' && overrideValue !== undefined) {
                params.query[key] = overrideValue;
            }
        }
        
        // 处理分页
        if (overrides.page !== undefined) {
            if (params.body['page'] !== undefined) params.body['page'] = overrides.page;
            if (params.body['pageNum'] !== undefined) params.body['pageNum'] = overrides.page;
        }
        if (overrides.pageSize !== undefined) {
            if (params.body['pageSize'] !== undefined) params.body['pageSize'] = overrides.pageSize;
            if (params.body['limit'] !== undefined) params.body['limit'] = overrides.pageSize;
        }
        if (overrides.radiusKm !== undefined) {
            const radiusKm = Number(overrides.radiusKm);
            if (Number.isFinite(radiusKm)) {
                if (params.body['distance'] !== undefined) params.body['distance'] = radiusKm;
                if (params.query['distance'] !== undefined) params.query['distance'] = radiusKm;
                if (params.body['radius'] !== undefined) params.body['radius'] = Math.max(1, Math.round(radiusKm * 1000));
                if (params.query['radius'] !== undefined) params.query['radius'] = Math.max(1, Math.round(radiusKm * 1000));
            }
        }

        // 兜底映射：即使 variableParams 未识别完整，也尽量覆盖常见坐标和分页字段
        this.applyFallbackOverrides(params, overrides);
        
        return params;
    }

    buildParseContext(pattern, params, sourceStage) {
        return {
            sourceType: 'api-crawl',
            sourceStage,
            request: {
                method: pattern.method || 'GET',
                url: pattern.baseUrl || '',
                queryParams: params?.query || {},
                bodyParams: params?.body || {},
                headers: pattern.headers || {}
            }
        };
    }

    resolveOverrideValue(key, info, overrides) {
        if (overrides[key] !== undefined) {
            return overrides[key];
        }

        if (!info || !info.type) {
            return undefined;
        }

        const compactKey = String(key).replace(/[_-]/g, '').toLowerCase();

        if (info.type === 'station_identifier') {
            if (compactKey === 'fullstationid') {
                return overrides.fullStationId ?? overrides.stationId ?? undefined;
            }
            if (compactKey === 'stationcode') {
                return overrides.stationCode ?? overrides.stationId ?? undefined;
            }
            if (compactKey === 'czbstationid') {
                return overrides.czbStationId ?? undefined;
            }
            if (compactKey === 'gasid') {
                return overrides.gasId ?? overrides.stationId ?? undefined;
            }
            if (compactKey === 'stubgroupid' || compactKey === 'id') {
                return overrides.stubGroupId ?? overrides.stationId ?? overrides.id ?? undefined;
            }
            return overrides.stationId ?? undefined;
        }

        if (info.type === 'detail_option') {
            if (compactKey === 'oilno') {
                return overrides.oilNo ?? undefined;
            }
        }

        if (info.type === 'city') {
            if (compactKey === 'cityid') {
                return overrides.cityId ?? overrides.cityid ?? undefined;
            }
            if (compactKey === 'citycode') {
                return overrides.cityCode ?? overrides.citycode ?? overrides.cityId ?? overrides.cityid ?? undefined;
            }
            if (compactKey === 'cityname') {
                return overrides.cityName ?? overrides.cityname ?? undefined;
            }
        }

        return undefined;
    }

    applyFallbackOverrides(params, overrides) {
        const setIfExist = (container, keys, value) => {
            for (const key of keys) {
                if (container[key] !== undefined) {
                    container[key] = value;
                }
            }
        };

        const latKeys = ['lat', 'latitude', 'userlat', 'userLat', 'gdLat', 'centerLat', 'locationLat'];
        const lngKeys = ['lng', 'longitude', 'userlng', 'userLng', 'gdLng', 'centerLng', 'locationLng'];
        const pageKeys = ['page', 'pageNum', 'pageNo', 'pageIndex', 'currentPage'];
        const pageSizeKeys = ['pageSize', 'limit', 'size', 'rows'];
        const distanceKeys = ['distance'];
        const radiusKeys = ['radius'];
        const cityIdKeys = ['cityId', 'cityid'];
        const cityCodeKeys = ['cityCode', 'citycode'];
        const cityNameKeys = ['cityName', 'cityname'];
        const stationIdentifierKeys = ['stationId', 'stationid', 'stationCode', 'stationcode', 'fullStationId', 'fullstationid', 'gasId', 'gasid', 'stubGroupId', 'stubgroupid', 'id'];
        const oilNoKeys = ['oilNo', 'oilno'];

        if (overrides.lat !== undefined) {
            setIfExist(params.body, latKeys, overrides.lat);
            setIfExist(params.query, latKeys, overrides.lat);
        }
        if (overrides.lng !== undefined) {
            setIfExist(params.body, lngKeys, overrides.lng);
            setIfExist(params.query, lngKeys, overrides.lng);
        }
        if (overrides.page !== undefined) {
            setIfExist(params.body, pageKeys, overrides.page);
            setIfExist(params.query, pageKeys, overrides.page);
        }
        if (overrides.pageSize !== undefined) {
            setIfExist(params.body, pageSizeKeys, overrides.pageSize);
            setIfExist(params.query, pageSizeKeys, overrides.pageSize);
        }
        if (overrides.radiusKm !== undefined) {
            const radiusKm = Number(overrides.radiusKm);
            if (Number.isFinite(radiusKm)) {
                setIfExist(params.body, distanceKeys, radiusKm);
                setIfExist(params.query, distanceKeys, radiusKm);
                setIfExist(params.body, radiusKeys, Math.max(1, Math.round(radiusKm * 1000)));
                setIfExist(params.query, radiusKeys, Math.max(1, Math.round(radiusKm * 1000)));
            }
        }
        if (overrides.cityId !== undefined || overrides.cityid !== undefined) {
            const cityId = overrides.cityId ?? overrides.cityid;
            setIfExist(params.body, cityIdKeys, cityId);
            setIfExist(params.query, cityIdKeys, cityId);
        }
        if (overrides.cityCode !== undefined || overrides.citycode !== undefined) {
            const cityCode = overrides.cityCode ?? overrides.citycode;
            setIfExist(params.body, cityCodeKeys, cityCode);
            setIfExist(params.query, cityCodeKeys, cityCode);
        }
        if (overrides.cityName !== undefined || overrides.cityname !== undefined) {
            const cityName = overrides.cityName ?? overrides.cityname;
            setIfExist(params.body, cityNameKeys, cityName);
            setIfExist(params.query, cityNameKeys, cityName);
        }
        if (overrides.stationId !== undefined || overrides.fullStationId !== undefined || overrides.stationCode !== undefined || overrides.gasId !== undefined || overrides.stubGroupId !== undefined || overrides.id !== undefined) {
            for (const key of stationIdentifierKeys) {
                const resolved = overrides[key] ?? this.resolveGenericStationIdentifier(key, overrides);
                if (resolved !== undefined) {
                    if (params.body[key] !== undefined) params.body[key] = resolved;
                    if (params.query[key] !== undefined) params.query[key] = resolved;
                }
            }
        }
        if (overrides.oilNo !== undefined) {
            setIfExist(params.body, oilNoKeys, overrides.oilNo);
            setIfExist(params.query, oilNoKeys, overrides.oilNo);
        }
    }

    resolveGenericStationIdentifier(key, overrides) {
        const compactKey = String(key).replace(/[_-]/g, '').toLowerCase();
        if (compactKey === 'fullstationid') {
            return overrides.fullStationId ?? overrides.stationId;
        }
        if (compactKey === 'stationcode') {
            return overrides.stationCode ?? overrides.stationId;
        }
        if (compactKey === 'gasid') {
            return overrides.gasId ?? overrides.stationId;
        }
        if (compactKey === 'stubgroupid' || compactKey === 'id') {
            return overrides.stubGroupId ?? overrides.id ?? overrides.stationId;
        }
        return overrides.stationId;
    }

    buildDetailOverrides(seedStation) {
        const raw = seedStation.raw || {};
        const stationId = seedStation.station_id || seedStation.stationId || raw.stationId || raw.StationID || raw.gasId || raw.id || null;
        const fullStationId = raw.fullStationId || raw.fullstationid || raw.fullStationID || null;
        const stationCode = raw.stationCode || raw.station_code || seedStation.station_id || seedStation.stationId || null;
        const czbStationId = raw.czbStationId || raw.czb_station_id || null;
        const stubGroupId = raw.stubGroupId || raw.id || stationId || null;
        const gasId = raw.gasId || stationId || null;
        const oilNo = raw.oilNo || raw.oilNO || null;
        const cityId = raw.cityId || raw.cityid || null;
        const cityCode = raw.cityCode || raw.citycode || null;
        const cityName = raw.cityName || raw.cityname || null;
        const latitude = Number(seedStation.latitude ?? seedStation.lat ?? raw.lat ?? raw.latitude ?? raw.gasAddressLatitude ?? raw.gisGcj02Lat);
        const longitude = Number(seedStation.longitude ?? seedStation.lng ?? raw.lng ?? raw.longitude ?? raw.gasAddressLongitude ?? raw.gisGcj02Lng);

        return {
            lat: Number.isFinite(latitude) ? latitude : undefined,
            lng: Number.isFinite(longitude) ? longitude : undefined,
            latitude: Number.isFinite(latitude) ? latitude : undefined,
            longitude: Number.isFinite(longitude) ? longitude : undefined,
            stationId: stationId || undefined,
            fullStationId: fullStationId || undefined,
            fullstationid: fullStationId || undefined,
            stationCode: stationCode || undefined,
            stationcode: stationCode || undefined,
            czbStationId: czbStationId || undefined,
            czbstationid: czbStationId || undefined,
            stubGroupId: stubGroupId || undefined,
            stubgroupid: stubGroupId || undefined,
            gasId: gasId || undefined,
            gasid: gasId || undefined,
            oilNo: oilNo || undefined,
            oilno: oilNo || undefined,
            cityId: cityId || undefined,
            cityid: cityId || undefined,
            cityCode: cityCode || undefined,
            citycode: cityCode || undefined,
            cityName: cityName || undefined,
            cityname: cityName || undefined,
            id: stubGroupId || stationId || undefined
        };
    }

    filterDetailSeedsForPattern(pattern, seedStations = [], proxyContext = null) {
        if (pattern?.platform === 'didi-charging' && this.isDidiDetailPath(this.safePathname(pattern.baseUrl))) {
            return seedStations.filter(seedStation => this.hasDidiDetailSignatureSample(pattern, seedStation, proxyContext));
        }

        if (!this.shouldUseSampleBoundDetail(pattern)) {
            return seedStations;
        }

        const sampleValues = this.extractPatternSampleValues(pattern);
        if (sampleValues.size === 0) {
            return seedStations;
        }

        return seedStations.filter(seedStation => {
            const overrides = this.buildDetailOverrides(seedStation);
            const candidateValues = new Set(
                Object.values(overrides)
                    .filter(value => value !== undefined && value !== null && value !== '')
                    .map(value => String(value))
            );

            return Array.from(sampleValues).some(value => candidateValues.has(value));
        });
    }

    hasResolvedDetailParams(pattern, overrides) {
        const detailParams = Object.entries(pattern.variableParams || {}).filter(([, info]) =>
            info && (info.type === 'station_identifier' || info.type === 'detail_option')
        );

        if (detailParams.length === 0) {
            return true;
        }

        return detailParams.every(([key, info]) => this.resolveOverrideValue(key, info, overrides) !== undefined);
    }

    async resolveDidiCityId(pattern, overrides, seedStation, logger = null, requestBudget = null, runQuota = null, proxyContext = null) {
        const lat = Number(overrides.lat ?? overrides.latitude);
        const lng = Number(overrides.lng ?? overrides.longitude);
        const stationLabel = seedStation.station_name || seedStation.stationName || seedStation.station_id || seedStation.stationId || overrides.fullStationId;

        if (!Number.isFinite(lat) || !Number.isFinite(lng) || !overrides.fullStationId) {
            return undefined;
        }

        const cacheKey = `${lat.toFixed(2)},${lng.toFixed(2)}`;
        if (this.didiCityIdCache.has(cacheKey)) {
            return this.didiCityIdCache.get(cacheKey);
        }

        if (logger) {
            logger(`滴滴详情自动探测 cityId: ${stationLabel}`);
        }

        const candidateIds = Array.from({ length: 120 }, (_, index) => index + 1);

        for (const candidate of candidateIds) {
            if (!this.hasTestRequestBudgetRemaining(requestBudget)) {
                if (logger) {
                    logger(`滴滴详情 cityId 探测停止，调试请求保护已达上限: ${this.formatTestRequestBudget(requestBudget)}`, 'warn');
                }
                return undefined;
            }
            if (!this.hasRunRequestQuotaRemaining(runQuota)) {
                if (logger) {
                    logger(`滴滴详情 cityId 探测停止，当次请求已达上限: ${this.formatRunRequestQuota(runQuota)}`, 'warn');
                }
                return undefined;
            }

            try {
                const params = this.buildParams(pattern, {
                    ...overrides,
                    cityId: candidate,
                    cityid: candidate
                });
                const response = await this.sendRequest(pattern, params, {
                    requestBudget,
                    runQuota,
                    reason: `resolve-cityId-${candidate}`,
                    proxyContext,
                    logger
                });
                const parsed = this.parser.parseResponseByPlatform(
                    pattern.platform,
                    JSON.stringify(response.data)
                ) || [];
                const matched = parsed.find(item =>
                    item && (
                        item.stationId === seedStation.station_id
                        || item.stationId === seedStation.stationId
                        || item.raw?.fullStationId === overrides.fullStationId
                    )
                );

                const canStrictMatch = Boolean(
                    overrides.fullStationId
                    || seedStation.station_id
                    || seedStation.stationId
                );

                if (matched || (!canStrictMatch && parsed.length > 0)) {
                    const hit = candidate;
                    this.didiCityIdCache.set(cacheKey, hit);
                    if (logger) {
                        logger(`滴滴详情 cityId 探测成功: ${hit}`);
                    }
                    return hit;
                }
            } catch (error) {
                if (this.isTestRequestBudgetExceeded(error) || this.isRunRequestLimitExceeded(error)) {
                    if (logger) {
                        logger(
                            this.isRunRequestLimitExceeded(error)
                                ? `滴滴详情 cityId 探测停止，当次请求已达上限: ${this.formatRunRequestQuota(error.runQuota)}`
                                : `滴滴详情 cityId 探测停止，调试请求保护已达上限: ${this.formatTestRequestBudget(requestBudget)}`,
                            'warn'
                        );
                    }
                    return undefined;
                }
            }
        }

        if (logger) {
            logger(`滴滴详情 cityId 探测失败: ${stationLabel}`, 'warn');
        }
        return undefined;
    }

    /**
     * 发送 HTTP 请求
     */
    async sendRequest(pattern, params, options = {}) {
        const {
            requestBudget = null,
            runQuota = null,
            reason = null,
            signatureAttempt = 0,
            proxyContext = null,
            logger = null,
            progressReporter = null
        } = options;
        this.ensureRunRequestQuota(pattern, runQuota, { reason });

        const preparedParams = {
            query: { ...(params.query || {}) },
            body: { ...(params.body || {}) }
        };
        const normalizedHeaders = this.sanitizeOutboundHeaders({ ...(pattern.headers || {}) });
        const signatureProviderMeta = this.preparePlatformRequest(pattern, preparedParams, normalizedHeaders, {
            proxyContext,
            reason,
            signatureAttempt,
            logger
        });
        if (logger && signatureProviderMeta) {
            const signatureLabel = signatureProviderMeta.scope === 'detail'
                ? `detail=${signatureProviderMeta.stationId || 'matched'} attempt=${signatureAttempt + 1}`
                : `page=${signatureProviderMeta.pageNo || 1}`;
            logger(
                `滴滴请求参数补齐: ${signatureProviderMeta.provider || 'signature-provider'} `
                    + `${signatureProviderMeta.city || signatureProviderMeta.keyword || 'target'} `
                    + `${signatureLabel} `
                    + `模式=${signatureProviderMeta.applyMode || 'patch'} `
                    + `样本距离=${Number(signatureProviderMeta.distanceKm || 0).toFixed(2)}km`,
                'warn'
            );
        }

        const contentType = String(normalizedHeaders['content-type'] || normalizedHeaders['Content-Type'] || 'application/json').toLowerCase();
        delete normalizedHeaders['Content-Type'];
        delete normalizedHeaders['content-type'];
        delete normalizedHeaders['User-Agent'];
        delete normalizedHeaders['user-agent'];

        const config = {
            method: pattern.method,
            url: pattern.baseUrl,
            headers: {
                ...normalizedHeaders,
                'Content-Type': contentType || 'application/json',
                'User-Agent': this.pickRandomUserAgent(pattern)
            },
            timeout: 10000
        };

        if (pattern.method === 'POST') {
            if (contentType.includes('application/x-www-form-urlencoded')) {
                config.data = new URLSearchParams(
                    Object.entries(preparedParams.body || {}).filter(([, value]) => value !== undefined && value !== null)
                ).toString();
            } else {
                config.data = preparedParams.body;
            }
        }
        
        if (Object.keys(preparedParams.query).length > 0) {
            config.params = preparedParams.query;
        }

        const useConfiguredProxy = this.shouldUseConfiguredProxyForRequest(pattern, reason);
        const proxyMatch = useConfiguredProxy
            ? await this.outboundClient.resolveProxyMatch(proxyContext)
            : { type: 'direct', label: '直连', proxyUrl: '' };
        if (logger && proxyMatch) {
            logger(`代理出口: ${this.describeProxyMatch(proxyMatch)}${reason ? ` (${reason})` : ''}`);
        }

        this.consumeTestRequestBudget(pattern, requestBudget, { reason });

        try {
            const response = await this.outboundClient.request(config, {
                proxyContext,
                proxyMatch,
                reason,
                platform: pattern?.platform || '',
                chain: 'api-crawl',
                evidenceType: pattern?.templateScope === 'detail' ? 'template-detail' : 'template-list',
                useConfiguredProxy
            });
            this.recordRunRequest(runQuota, pattern, {
                reason,
                success: true,
                statusCode: Number(response?.status) || null
            });
            this.reportRunProgress(progressReporter, pattern, runQuota, {
                reason,
                success: true,
                statusCode: Number(response?.status) || null
            });
            this.recordDailyRequest({
                platform: pattern?.platform || null,
                method: String(pattern?.method || 'GET').toUpperCase(),
                url: pattern?.baseUrl || '',
                success: true,
                statusCode: Number(response?.status) || null,
                reason
            });
            return response;
        } catch (error) {
            this.recordRunRequest(runQuota, pattern, {
                reason,
                success: false,
                statusCode: Number(error?.response?.status) || null
            });
            this.reportRunProgress(progressReporter, pattern, runQuota, {
                reason,
                success: false,
                statusCode: Number(error?.response?.status) || null
            });
            this.recordDailyRequest({
                platform: pattern?.platform || null,
                method: String(pattern?.method || 'GET').toUpperCase(),
                url: pattern?.baseUrl || '',
                success: false,
                statusCode: Number(error?.response?.status) || null,
                reason
            });
            throw error;
        }
    }

    shouldUseConfiguredProxyForRequest(pattern, reason = null) {
        if (
            pattern?.platform === 'didi-charging'
            && (
                this.isDidiListPath(this.safePathname(pattern.baseUrl))
                || this.isDidiDetailPath(this.safePathname(pattern.baseUrl))
            )
        ) {
            return false;
        }
        return true;
    }

    reportRunProgress(progressReporter, pattern, runQuota, requestMeta = {}) {
        if (typeof progressReporter !== 'function') {
            return;
        }

        try {
            progressReporter({
                platform: pattern?.platform || null,
                request: requestMeta,
                runQuota: this.getRunRequestQuotaSummary(runQuota, { includeRequests: false })
            });
        } catch (error) {
            console.error('Progress reporter failed:', error.message);
        }
    }

    preparePlatformRequest(pattern, params, headers, context = {}) {
        if (pattern.platform === 'didi-charging') {
            return this.applyDidiSignatureProvider(pattern, params, headers, context);
        }

        if (pattern.platform === 'star-charge') {
            this.applyStarChargeSignature(pattern, params, headers);
            return null;
        }

        if (pattern.platform === 'kuaidian') {
            this.applyKuaidianSignature(pattern, params);
            return null;
        }

        if (pattern.platform === 'tuanyou') {
            this.applyTuanyouSignature(pattern, params);
        }

        return null;
    }

    applyDidiSignatureProvider(pattern, params, headers, context = {}) {
        if (!this.didiSignatureProvider) {
            return null;
        }
        if (this.isDidiSignedListPattern(pattern) && typeof this.didiSignatureProvider.applyListSample === 'function') {
            return this.didiSignatureProvider.applyListSample(pattern, params, headers, context.proxyContext || null, {
                signatureAttempt: context.signatureAttempt || 0
            });
        }
        if (
            pattern?.platform === 'didi-charging'
            && this.isDidiDetailPath(this.safePathname(pattern.baseUrl))
            && typeof this.didiSignatureProvider.applyDetailSample === 'function'
        ) {
            return this.didiSignatureProvider.applyDetailSample(pattern, params, headers, context.proxyContext || null, {
                signatureAttempt: context.signatureAttempt || 0
            });
        }
        return null;
    }

    applyStarChargeSignature(pattern, params, headers) {
        const container = String(pattern.method || 'GET').toUpperCase() === 'GET'
            ? params.query
            : params.body;
        const timestamp = Date.now();
        const nonce = this.generateNonce();
        const timestampKey = this.findExistingKey(container, 'timestamp') || 'timestamp';
        const nonceKey = this.findExistingKey(container, 'nonce') || 'nonce';

        container[timestampKey] = timestamp;
        container[nonceKey] = nonce;
        this.removeEmptyFields(container);

        const sortedPayload = this.sortObjectKeys(container);
        const signature = this.createStarChargeSignature(sortedPayload, timestamp);
        const timestampHeaderKey = this.findExistingHeaderKey(headers, 'x-ca-timestamp') || 'x-ca-timestamp';
        const signatureHeaderKey = this.findExistingHeaderKey(headers, 'x-ca-signature') || 'x-ca-signature';

        headers[timestampHeaderKey] = String(timestamp);
        headers[signatureHeaderKey] = signature;

        if (String(pattern.method || 'GET').toUpperCase() === 'GET') {
            params.query = sortedPayload;
        } else {
            params.body = sortedPayload;
        }
    }

    createStarChargeSignature(payload, timestamp) {
        const firstPass = crypto.createHash('md5').update(this.serializeParams(payload)).digest('hex');
        return crypto.createHash('md5').update(`${firstPass}${timestamp}`).digest('hex').toUpperCase();
    }

    serializeParams(payload = {}) {
        return Object.entries(payload).map(([key, value]) => `${key}=${value}`).join('&');
    }

    sortObjectKeys(payload = {}) {
        return Object.keys(payload).sort().reduce((result, key) => {
            result[key] = payload[key];
            return result;
        }, {});
    }

    removeEmptyFields(payload = {}) {
        for (const key of Object.keys(payload)) {
            if (payload[key] === undefined || payload[key] === null) {
                delete payload[key];
            }
        }
    }

    applyKuaidianSignature(pattern, params) {
        const container = String(pattern.method || 'GET').toUpperCase() === 'GET'
            ? params.query
            : params.body;
        const timestampKey = this.findExistingKey(container, 'timestamp') || 'timestamp';
        const signKey = this.findExistingKey(container, 'sign') || 'sign';
        const appKeyKey = this.findExistingKey(container, 'app_key') || 'app_key';
        const appTerminalKey = this.findExistingKey(container, 'app_terminal') || 'app_terminal';

        container[timestampKey] = String(Date.now());
        if (container[appKeyKey] === undefined || container[appKeyKey] === null || container[appKeyKey] === '') {
            container[appKeyKey] = 'kd_prod_mp';
        }
        if (container[appTerminalKey] === undefined || container[appTerminalKey] === null || container[appTerminalKey] === '') {
            container[appTerminalKey] = 'mp';
        }

        this.normalizeEmptyStringFields(container);
        container[signKey] = this.createWrappedMd5Signature(container, signKey, '15cdf1eaf2110a3009bf2be5d3e53c3c');
    }

    applyTuanyouSignature(pattern, params) {
        const container = String(pattern.method || 'GET').toUpperCase() === 'GET'
            ? params.query
            : params.body;
        const timestampKey = this.findExistingKey(container, 'timestamp') || 'timestamp';
        const signKey = this.findExistingKey(container, 'sign') || 'sign';
        const appKeyKey = this.findExistingKey(container, 'app_key') || 'app_key';
        const tokenKey = this.findExistingKey(container, 'token') || 'token';
        const shumeiKey = this.findExistingKey(container, 'shumeiID') || 'shumeiID';
        const fromScanCodeKey = this.findExistingKey(container, 'fromScanCode') || 'fromScanCode';
        const mpVersionKey = this.findExistingKey(container, 'mp_version') || 'mp_version';

        container[timestampKey] = String(Date.now());
        if (container[appKeyKey] === undefined || container[appKeyKey] === null || container[appKeyKey] === '') {
            container[appKeyKey] = 'mp1.0';
        }
        if (container[tokenKey] === undefined || container[tokenKey] === null) {
            container[tokenKey] = '';
        }
        if (container[shumeiKey] === undefined || container[shumeiKey] === null) {
            container[shumeiKey] = '';
        }
        if (container[fromScanCodeKey] === undefined || container[fromScanCodeKey] === null) {
            container[fromScanCodeKey] = '';
        }
        if (container[mpVersionKey] === undefined || container[mpVersionKey] === null || container[mpVersionKey] === '') {
            container[mpVersionKey] = '10.2.1';
        }

        this.normalizeEmptyStringFields(container);
        container[signKey] = this.createWrappedMd5Signature(container, signKey, 'aff7f768de81bb5f4e7c9bfba518c');
    }

    createWrappedMd5Signature(payload = {}, signKey = 'sign', secret = '') {
        const normalizedSignKey = this.findExistingKey(payload, signKey) || signKey;
        const signingPayload = { ...payload };
        delete signingPayload[normalizedSignKey];
        this.normalizeEmptyStringFields(signingPayload);

        const serialized = Object.entries(this.sortObjectKeys(signingPayload))
            .map(([key, value]) => `${key}${value === undefined || value === null ? '' : value}`)
            .join('');

        return crypto.createHash('md5').update(`${secret}${serialized}${secret}`).digest('hex').toLowerCase();
    }

    normalizeEmptyStringFields(payload = {}) {
        for (const key of Object.keys(payload)) {
            if (payload[key] === undefined || payload[key] === null) {
                payload[key] = '';
            }
        }
    }

    generateNonce() {
        return crypto.randomUUID
            ? crypto.randomUUID()
            : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, character => {
                const random = Math.random() * 16 | 0;
                const value = character === 'x' ? random : (random & 0x3 | 0x8);
                return value.toString(16);
            });
    }

    findExistingKey(object = {}, expectedKey) {
        const normalizedExpected = this.normalizeKey(expectedKey);
        return Object.keys(object).find(key => this.normalizeKey(key) === normalizedExpected);
    }

    findExistingHeaderKey(headers = {}, expectedKey) {
        const normalizedExpected = String(expectedKey || '').toLowerCase();
        return Object.keys(headers).find(key => String(key || '').toLowerCase() === normalizedExpected);
    }

    pickRandomUserAgent(pattern) {
        if (pattern && pattern.__selectedUserAgent) {
            return pattern.__selectedUserAgent;
        }

        const capturedUserAgent = pattern?.headers?.['user-agent'] || pattern?.headers?.['User-Agent'];
        if (capturedUserAgent && this.shouldPreferCapturedUserAgent(pattern)) {
            if (pattern) {
                Object.defineProperty(pattern, '__selectedUserAgent', {
                    value: String(capturedUserAgent),
                    writable: true,
                    configurable: true,
                    enumerable: false
                });
            }
            return String(capturedUserAgent);
        }

        const candidates = new Set(this.userAgentPool);
        if (capturedUserAgent) {
            candidates.add(String(capturedUserAgent));
        }

        const userAgents = Array.from(candidates).filter(Boolean);
        const selected = userAgents[Math.floor(Math.random() * userAgents.length)];

        if (pattern) {
            Object.defineProperty(pattern, '__selectedUserAgent', {
                value: selected,
                writable: true,
                configurable: true,
                enumerable: false
            });
        }

        return selected;
    }

    sanitizeOutboundHeaders(headers = {}) {
        const blockedHeaderKeys = new Set([
            'x-forwarded-for',
            'forwarded',
            'via',
            'client-ip',
            'x-real-ip',
            'x-client-ip',
            'x-cluster-client-ip',
            'proxy-client-ip',
            'wl-proxy-client-ip',
            'true-client-ip',
            'cf-connecting-ip',
            'fastly-client-ip'
        ]);

        const sanitized = { ...headers };
        for (const key of Object.keys(sanitized)) {
            if (blockedHeaderKeys.has(String(key).toLowerCase())) {
                delete sanitized[key];
            }
        }

        return sanitized;
    }

    async applyProxyConfig(config, proxyContext = null) {
        return this.outboundClient.applyProxyConfig(config, proxyContext);
    }

    getProxyAgents(proxyUrl) {
        return this.outboundClient.getProxyAgents(proxyUrl);
    }

    async resolveProxyMatch(proxyContext = null) {
        return this.outboundClient.resolveProxyMatch(proxyContext);
    }

    normalizeProxySettings(settings = {}) {
        return this.outboundClient.normalizeProxySettings(settings);
    }

    findManualProxy(pool = [], proxyContext = null, matchType = 'city') {
        return this.outboundClient.findManualProxy(pool, proxyContext, matchType);
    }

    buildProxyTarget(proxyContext = null) {
        return this.outboundClient.buildProxyTarget(proxyContext);
    }

    locationMatches(token, target) {
        return this.outboundClient.locationMatches(token, target);
    }

    normalizeLocationToken(value) {
        return this.outboundClient.normalizeLocationToken(value);
    }

    async fetchProviderProxy(providerProxy = {}, proxyContext = null) {
        return this.outboundClient.fetchProviderProxy(
            providerProxy,
            proxyContext,
            this.normalizeProxySettings(this.getProxySettings() || {})
        );
    }

    buildProviderProxyUrl(apiUrl, context = {}) {
        return this.outboundClient.buildProviderProxyUrl(apiUrl, context);
    }

    extractProviderProxyUrl(payload) {
        return this.outboundClient.extractProviderProxyUrl(payload);
    }

    normalizeProxyUrlCandidate(value) {
        return this.outboundClient.normalizeProxyUrlCandidate(value);
    }

    describeProxyMatch(proxyMatch = {}) {
        return this.outboundClient.describeProxyMatch(proxyMatch);
    }

    maskProxyUrl(proxyUrl) {
        return this.outboundClient.maskProxyUrl(proxyUrl);
    }

    buildPatternDedupKey(pattern) {
        const baseKey = `${pattern.platform}-${pattern.method}-${pattern.baseUrl}-${pattern.templateScope || 'list'}`;
        if (!this.shouldPreserveMultipleSamples(pattern)) {
            return baseKey;
        }

        return `${baseKey}-${this.buildPatternFingerprint(pattern)}`;
    }

    buildPatternFingerprint(pattern) {
        return this.stableStringify({
            queryParams: pattern.queryParams || {},
            bodyParams: pattern.bodyParams || {},
            headers: pattern.headers || {}
        });
    }

    stableStringify(value) {
        if (Array.isArray(value)) {
            return `[${value.map(item => this.stableStringify(item)).join(',')}]`;
        }
        if (value && typeof value === 'object') {
            return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${this.stableStringify(value[key])}`).join(',')}}`;
        }
        return JSON.stringify(value);
    }

    normalizeKey(key) {
        return String(key || '').replace(/[_-]/g, '').toLowerCase();
    }

    isDidiListPath(pathname) {
        return /homepage\/stationlist/i.test(String(pathname || ''));
    }

    isDidiDetailPath(pathname) {
        return /station\/getoneinfo/i.test(String(pathname || ''));
    }

    shouldPreserveMultipleSamples(pattern) {
        return this.hasSensitiveRequestSignature(pattern);
    }

    shouldUseSampleBoundDetail(pattern) {
        if ((pattern.templateScope || 'list') !== 'detail') {
            return false;
        }

        if (this.canRegenerateSensitiveRequest(pattern)) {
            return false;
        }

        return this.shouldPreserveMultipleSamples(pattern);
    }

    shouldPreferCapturedUserAgent(pattern) {
        const pathname = this.safePathname(pattern?.baseUrl);
        if (pattern?.platform === 'didi-charging' && this.isDidiListPath(pathname)) {
            return true;
        }

        return this.shouldPreserveMultipleSamples(pattern);
    }

    formatRequestError(error) {
        if (!error) {
            return 'unknown error';
        }

        const baseMessage = String(error.message || 'request failed');
        const status = error?.response?.status;
        const statusText = error?.response?.statusText;
        const payload = error?.response?.data;
        let payloadSnippet = '';

        if (typeof payload === 'string') {
            payloadSnippet = payload.trim().slice(0, 180);
        } else if (payload && typeof payload === 'object') {
            const compact = {
                code: payload.code ?? payload.errno ?? payload.status ?? undefined,
                message: payload.message ?? payload.msg ?? payload.errmsg ?? payload.error ?? undefined
            };
            payloadSnippet = JSON.stringify(compact).slice(0, 180);
        }

        const detail = [];
        detail.push(baseMessage);
        if (status) {
            detail.push(`HTTP ${status}${statusText ? ` ${statusText}` : ''}`);
        }
        if (payloadSnippet) {
            detail.push(`resp=${payloadSnippet}`);
        }

        return detail.join(' | ');
    }

    hasSensitiveRequestSignature(pattern) {
        const paramKeys = [
            ...Object.keys(pattern.queryParams || {}),
            ...Object.keys(pattern.bodyParams || {})
        ];
        const headerKeys = Object.keys(pattern.headers || {});

        return paramKeys.some(key => this.isSensitiveParamKey(key))
            || headerKeys.some(key => this.isSensitiveHeaderKey(key));
    }

    canRegenerateSensitiveRequest(pattern) {
        return ['star-charge', 'kuaidian', 'tuanyou'].includes(pattern.platform);
    }

    isSensitiveParamKey(key) {
        const normalizedKey = this.normalizeKey(key);
        return normalizedKey === 'wsgsig'
            || normalizedKey === 'nonce'
            || normalizedKey === 'timestamp'
            || normalizedKey.includes('sign')
            || normalizedKey.includes('token');
    }

    isSensitiveHeaderKey(key) {
        const lowerKey = String(key || '').toLowerCase();
        return lowerKey.startsWith('secdd-')
            || lowerKey.startsWith('x-ca-')
            || [
                'authorization',
                'signature',
                'timestamp',
                'appversion',
                'channel-id',
                'positcity',
                'x-uid',
                'sid',
                'lmdtag',
                'did',
                'userid'
            ].includes(lowerKey);
    }

    extractPatternSampleValues(pattern) {
        const values = new Set();
        const collect = (container = {}) => {
            for (const [key, value] of Object.entries(container)) {
                const normalizedKey = this.normalizeKey(key);
                if (
                    [
                        'stationid',
                        'fullstationid',
                        'stationcode',
                        'czbstationid',
                        'gasid',
                        'stubgroupid',
                        'id',
                        'oilno'
                    ].includes(normalizedKey)
                    && value !== undefined
                    && value !== null
                    && value !== ''
                ) {
                    values.add(String(value));
                }
            }
        };

        collect(pattern.queryParams);
        collect(pattern.bodyParams);

        return values;
    }

    safePathname(baseUrl) {
        try {
            return new URL(baseUrl).pathname;
        } catch (error) {
            return '';
        }
    }

    /**
     * 延迟
     */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * 生成网格坐标
     */
    static generateGridCoordinates(centerLat, centerLng, radius = 5, gridSize = 1) {
        const coordinates = [];
        
        // 1度纬度约等于111公里
        // 1度经度约等于111 * cos(纬度) 公里
        const latStep = gridSize / 111;
        const lngStep = gridSize / (111 * Math.cos(centerLat * Math.PI / 180));
        
        const steps = Math.ceil(radius / gridSize);
        
        for (let i = -steps; i <= steps; i++) {
            for (let j = -steps; j <= steps; j++) {
                const distanceKm = Math.sqrt((i * gridSize) ** 2 + (j * gridSize) ** 2);
                coordinates.push({
                    lat: centerLat + i * latStep,
                    lng: centerLng + j * lngStep,
                    distanceKm: Number(distanceKm.toFixed(3))
                });
            }
        }
        
        return coordinates.sort((a, b) => a.distanceKm - b.distanceKm);
    }
}

module.exports = SmartCrawler;
