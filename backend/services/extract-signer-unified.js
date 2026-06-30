const fs = require('fs');
const path = require('path');

/**
 * 签名提取器统一入口
 * 输入 HAR 条目 → 输出签名参数
 * 支持平台插件：didi(wsgsig) / teld(token) / star-charge(sign) 等
 * 每个平台一个提取规则函数，可扩展
 */

// ============ 平台提取规则插件 ============

const PLATFORM_EXTRACTORS = {
    'didi-charging': {
        name: '滴滴充电',
        signatureKeys: ['wsgsig'],
        extract(entry) {
            const url = entry.request?.url || '';
            const query = parseHarQueryString(entry.request?.queryString || []);
            const body = parseHarPostData(entry.request?.postData || null);
            const headers = parseHarHeaders(entry.request?.headers || []);

            const wsgsig = query.wsgsig || query._wsgsig || '';
            if (!wsgsig) return null;

            return {
                platform: 'didi-charging',
                signatureType: 'wsgsig',
                signatureParams: { wsgsig },
                queryParams: query,
                bodyParams: body,
                headers: normalizeHeaderKeys(headers),
                capturedAt: extractTimestamp(entry, query, body),
                scope: detectDidiScope(url),
                method: entry.request?.method || 'POST',
                baseUrl: extractBaseUrl(url),
                city: query.city || body.city || '',
                lat: Number(query.lat ?? body.lat ?? body.userlat ?? null),
                lng: Number(query.lng ?? body.lng ?? body.userlng ?? null),
                pageNo: Number(query.pageNo ?? body.pageNo ?? 1),
                stationId: query.fullstationid || body.fullstationid || ''
            };
        }
    },

    'teld': {
        name: '特来电',
        signatureKeys: ['token', 'tokenId'],
        extract(entry) {
            const url = entry.request?.url || '';
            const query = parseHarQueryString(entry.request?.queryString || []);
            const body = parseHarPostData(entry.request?.postData || null);
            const headers = parseHarHeaders(entry.request?.headers || []);

            const token = query.token || query.tokenId || headers.token || headers['x-token'] || '';
            if (!token) return null;

            return {
                platform: 'teld',
                signatureType: 'token',
                signatureParams: { token },
                queryParams: query,
                bodyParams: body,
                headers: normalizeHeaderKeys(headers),
                capturedAt: extractTimestamp(entry, query, body),
                method: entry.request?.method || 'GET',
                baseUrl: extractBaseUrl(url),
                city: query.city || body.city || ''
            };
        }
    },

    'star-charge': {
        name: '星星充电',
        signatureKeys: ['sign', 'timestamp', 'nonce'],
        extract(entry) {
            const url = entry.request?.url || '';
            const query = parseHarQueryString(entry.request?.queryString || []);
            const body = parseHarPostData(entry.request?.postData || null);
            const headers = parseHarHeaders(entry.request?.headers || []);

            const sign = query.sign || headers.sign || '';
            const timestamp = query.timestamp || headers.timestamp || '';
            if (!sign) return null;

            return {
                platform: 'star-charge',
                signatureType: 'sign',
                signatureParams: { sign, timestamp, nonce: query.nonce || '' },
                queryParams: query,
                bodyParams: body,
                headers: normalizeHeaderKeys(headers),
                capturedAt: extractTimestamp(entry, query, body),
                method: entry.request?.method || 'GET',
                baseUrl: extractBaseUrl(url),
                city: query.city || body.city || ''
            };
        }
    },

    'kuaidian': {
        name: '快电',
        signatureKeys: ['token', 'sign'],
        extract(entry) {
            const url = entry.request?.url || '';
            const query = parseHarQueryString(entry.request?.queryString || []);
            const body = parseHarPostData(entry.request?.postData || null);
            const headers = parseHarHeaders(entry.request?.headers || []);

            const token = query.token || headers.token || '';
            const sign = query.sign || headers.sign || '';
            if (!token && !sign) return null;

            return {
                platform: 'kuaidian',
                signatureType: 'token+sign',
                signatureParams: { token, sign },
                queryParams: query,
                bodyParams: body,
                headers: normalizeHeaderKeys(headers),
                capturedAt: extractTimestamp(entry, query, body),
                method: entry.request?.method || 'GET',
                baseUrl: extractBaseUrl(url),
                city: query.city || body.city || ''
            };
        }
    },

    'tuanyou': {
        name: '团油',
        signatureKeys: ['token', 'sign'],
        extract(entry) {
            const url = entry.request?.url || '';
            const query = parseHarQueryString(entry.request?.queryString || []);
            const body = parseHarPostData(entry.request?.postData || null);
            const headers = parseHarHeaders(entry.request?.headers || []);

            const token = query.token || headers.token || '';
            const sign = query.sign || headers.sign || '';
            if (!token && !sign) return null;

            return {
                platform: 'tuanyou',
                signatureType: 'token+sign',
                signatureParams: { token, sign },
                queryParams: query,
                bodyParams: body,
                headers: normalizeHeaderKeys(headers),
                capturedAt: extractTimestamp(entry, query, body),
                method: entry.request?.method || 'GET',
                baseUrl: extractBaseUrl(url),
                city: query.city || body.city || ''
            };
        }
    },

    'ykc': {
        name: '云快充',
        signatureKeys: ['token', 'sign'],
        extract(entry) {
            const url = entry.request?.url || '';
            const query = parseHarQueryString(entry.request?.queryString || []);
            const body = parseHarPostData(entry.request?.postData || null);
            const headers = parseHarHeaders(entry.request?.headers || []);

            const token = query.token || headers.token || '';
            const sign = query.sign || headers.sign || '';
            if (!token && !sign) return null;

            return {
                platform: 'ykc',
                signatureType: 'token+sign',
                signatureParams: { token, sign },
                queryParams: query,
                bodyParams: body,
                headers: normalizeHeaderKeys(headers),
                capturedAt: extractTimestamp(entry, query, body),
                method: entry.request?.method || 'GET',
                baseUrl: extractBaseUrl(url),
                city: query.city || body.city || ''
            };
        }
    }
};

class ExtractSignerUnified {
    constructor(options = {}) {
        this.extractors = { ...PLATFORM_EXTRACTORS };
        this.defaultPlatform = options.defaultPlatform || 'didi-charging';

        if (options.customExtractors) {
            for (const [platform, extractor] of Object.entries(options.customExtractors)) {
                this.extractors[platform] = extractor;
            }
        }
    }

    /**
     * 统一提取入口
     * @param {object} harEntry - HAR 条目对象
     * @param {string} [platform] - 指定平台，若不指定则自动推断
     * @returns {object|null} 签名参数对象，null 表示无签名
     */
    extract(harEntry, platform = null) {
        const detectedPlatform = platform || this.detectPlatform(harEntry);
        if (!detectedPlatform) return null;

        const extractor = this.extractors[detectedPlatform];
        if (!extractor) return null;

        const result = extractor.extract(harEntry);
        if (!result) return null;

        result.extractor = extractor.name;
        result.signatureKeys = extractor.signatureKeys;
        result.createdAt = new Date().toISOString();
        return result;
    }

    /**
     * 批量提取
     * @param {Array} harEntries - HAR 条目数组
     * @param {string} [platform] - 指定平台
     * @returns {Array} 有效签名参数数组
     */
    extractBatch(harEntries, platform = null) {
        const results = [];
        for (const entry of harEntries) {
            const result = this.extract(entry, platform);
            if (result) results.push(result);
        }
        return results;
    }

    /**
     * 从 HAR 文件提取所有签名
     * @param {string} harPath - HAR 文件路径
     * @param {string} [platform] - 指定平台
     * @returns {Array} 有效签名参数数组
     */
    extractFromFile(harPath, platform = null) {
        const har = JSON.parse(fs.readFileSync(harPath, 'utf8'));
        const entries = har.log?.entries || [];
        return this.extractBatch(entries, platform);
    }

    /**
     * 自动推断平台
     */
    detectPlatform(harEntry) {
        const url = harEntry?.request?.url || '';
        const host = extractHost(url);

        if (/xiaojukeji\.com|didichuxing\.com/i.test(host)) return 'didi-charging';
        if (/teld\.cn|teldapi/i.test(host)) return 'teld';
        if (/star-charge\.com|starcharge/i.test(host)) return 'star-charge';
        if (/kuaidian/i.test(host)) return 'kuaidian';
        if (/tuanyou/i.test(host)) return 'tuanyou';
        if (/ykc/i.test(host)) return 'ykc';

        return null;
    }

    /**
     * 获取已注册的平台列表
     */
    getPlatformList() {
        return Object.entries(this.extractors).map(([id, extractor]) => ({
            id,
            name: extractor.name,
            signatureKeys: extractor.signatureKeys
        }));
    }

    /**
     * 注册新平台提取器
     */
    registerExtractor(platformId, extractor) {
        this.extractors[platformId] = extractor;
    }
}

// ============ 辅助函数 ============

function parseHarQueryString(qsArray) {
    if (!Array.isArray(qsArray)) return {};
    const result = {};
    for (const item of qsArray) {
        if (item.name && item.value !== undefined) {
            result[item.name] = item.value;
        }
    }
    return result;
}

function parseHarPostData(postData) {
    if (!postData) return {};
    if (postData.mimeType === 'application/json') {
        try {
            return JSON.parse(postData.text || '{}');
        } catch (error) {
            return {};
        }
    }
    if (postData.mimeType === 'application/x-www-form-urlencoded' && postData.text) {
        const result = {};
        for (const pair of postData.text.split('&')) {
            const [key, value] = pair.split('=');
            if (key) result[key] = decodeURIComponent(value || '');
        }
        return result;
    }
    return {};
}

function parseHarHeaders(headersArray) {
    if (!Array.isArray(headersArray)) return {};
    const result = {};
    for (const item of headersArray) {
        if (item.name) result[item.name.toLowerCase()] = item.value;
    }
    return result;
}

function normalizeHeaderKeys(headers) {
    const result = {};
    for (const [key, value] of Object.entries(headers)) {
        result[key.toLowerCase()] = value;
    }
    return result;
}

function extractBaseUrl(url) {
    try {
        const parsed = new URL(url);
        return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
    } catch (error) {
        return url;
    }
}

function extractHost(url) {
    try {
        return new URL(url).host;
    } catch (error) {
        return '';
    }
}

function detectDidiScope(url) {
    try {
        const pathname = new URL(url).pathname;
        if (/station\/getoneinfo/i.test(pathname)) return 'detail';
        return 'list';
    } catch (error) {
        return 'list';
    }
}

function extractTimestamp(entry, query, body) {
    const startedDateTime = entry.startedDateTime || '';
    if (startedDateTime) return startedDateTime;

    const ts = query.timestamp || query.ts || query._ts || body.timestamp || '';
    if (ts) {
        const numTs = Number(ts);
        if (Number.isFinite(numTs) && numTs > 1e12) {
            return new Date(numTs).toISOString();
        }
        if (Number.isFinite(numTs) && numTs > 1e9) {
            return new Date(numTs * 1000).toISOString();
        }
        return String(ts);
    }

    return new Date().toISOString();
}

module.exports = ExtractSignerUnified;
