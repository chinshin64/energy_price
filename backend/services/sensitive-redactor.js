'use strict';

/**
 * 敏感字段脱敏服务
 * 用于请求采集和小规模访问验证的统一脱敏处理
 */

const SENSITIVE_KEY_PATTERNS = [
    /^cookie$/i,
    /^set[-_]?cookie$/i,
    /^authorization$/i,
    /^proxy[-_]?authorization$/i,
    /^token$/i,
    /^auth[-_]?token$/i,
    /^bearer[-_]?token$/i,
    /^client[-_]?token$/i,
    /^id[-_]?token$/i,
    /^user[-_]?token$/i,
    /^access[-_]?token$/i,
    /^refresh[-_]?token$/i,
    /^sign$/i,
    /^signature$/i,
    /^sig$/i,
    /^openid$/i,
    /^unionid$/i,
    /^phone$/i,
    /^mobile$/i,
    /^idcard$/i,
    /^skey$/i,
    /^session$/i,
    /^session[-_]?id$/i,
    /^wsgsig$/i,
    /^password$/i,
    /^passwd$/i,
    /^secret$/i,
    /^api[-_]?key$/i,
    /^client[-_]?secret$/i,
    /^app[-_]?secret$/i,
    /^private[-_]?key$/i,
    /^email$/i,
    /^real[-_]?name$/i,
    /^bank[-_]?card$/i,
    /^cvv$/i,
    /^imei$/i,
    /^udid$/i,
    /^device[-_]?id$/i,
    /^session[-_]?key$/i,
    /^ticket$/i,
    /^token[-_]?id$/i,
];

const REDACTED = '**redacted**';
const URL_KEY_PATTERN = /(?:^|[-_])(url|uri|href)$/i;
const BODY_TEXT_KEY_PATTERN = /(?:^|[-_])(body|payload|post[-_]?data|request[-_]?data)$/i;
const DEFAULT_MAX_STORAGE_BYTES = 512 * 1024;

function compactKey(key) {
    return String(key || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function isSensitiveKey(key) {
    if (!key || typeof key !== 'string') return false;
    if (SENSITIVE_KEY_PATTERNS.some(p => p.test(key))) return true;

    const compact = compactKey(key);
    return [
        'authtoken',
        'bearertoken',
        'clienttoken',
        'idtoken',
        'usertoken',
        'accesstoken',
        'refreshtoken',
        'sessionid',
        'sessionkey',
        'clientsecret',
        'appsecret',
        'apikey',
        'privatekey',
        'proxyauthorization',
        'setcookie',
        'xwxskey',
        'xsign',
        'xsignature'
    ].includes(compact);
}

function redactValue(val) {
    if (val === undefined || val === null) return val;
    const s = String(val);
    return REDACTED;
}

/**
 * Value 级 PII 检测：手机号/身份证号
 */
function redactValueByContent(val) {
    if (val === undefined || val === null) return val;
    if (typeof val !== 'string') return val;
    // 手机号: 1[3-9]xxxxxxxxx
    if (/^1[3-9]\d{9}$/.test(val)) return val.substring(0, 3) + '****' + val.substring(7);
    // 身份证号: 17位数字+X/数字
    if (/^\d{17}[\dXx]$/.test(val)) return val.substring(0, 4) + '**********' + val.substring(14);
    return val;
}

/**
 * 脱敏一个 key-value 对象，返回新对象
 */
function redactObject(obj, options = {}) {
    if (!obj || typeof obj !== 'object') return obj;
    const depth = (options._depth || 0);
    if (depth > 10) return REDACTED; // max depth guard
    const nextOpts = { ...options, _depth: depth + 1 };

    if (obj instanceof Date) {
        return Number.isNaN(obj.getTime()) ? null : obj.toISOString();
    }

    if (Array.isArray(obj)) {
        return obj.map(item => {
            if (typeof item === 'object' && item !== null) return redactObject(item, nextOpts);
            return redactValueByContent(item);
        });
    }

    const namedField = typeof obj.name === 'string'
        ? obj.name
        : (typeof obj.key === 'string' ? obj.key : null);
    const namedFieldIsSensitive = isSensitiveKey(namedField);
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
        if (isSensitiveKey(key) || (namedFieldIsSensitive && /^(value|val)$/i.test(key))) {
            result[key] = REDACTED;
        } else if (typeof value === 'object' && value !== null) {
            result[key] = redactObject(value, nextOpts);
        } else if (typeof value === 'string' && URL_KEY_PATTERN.test(key)) {
            result[key] = redactUrl(value);
        } else if (typeof value === 'string' && BODY_TEXT_KEY_PATTERN.test(key)) {
            result[key] = redactBodyText(value);
        } else {
            result[key] = redactValueByContent(value);
        }
    }
    return result;
}

/**
 * 脱敏 URL 中的敏感查询参数
 */
function redactUrl(url) {
    if (!url || typeof url !== 'string') return url;
    try {
        const u = new URL(url);
        const params = u.searchParams;
        for (const [key] of params) {
            if (isSensitiveKey(key)) {
                params.set(key, REDACTED);
            }
        }
        return u.toString();
    } catch {
        return url.replace(/([?&])(\w+)=([^&]+)/g, (match, sep, key, val) => {
            if (isSensitiveKey(key)) return `${sep}${key}=${REDACTED}`;
            return match;
        });
    }
}

/**
 * 脱敏 HAR entry 的请求摘要
 */
function redactHarEntry(entry) {
    if (!entry) return entry;
    const req = entry.request || {};
    const resp = entry.response || {};

    // 脱敏请求头
    const safeHeaders = {};
    if (Array.isArray(req.headers)) {
        for (const h of req.headers) {
            if (isSensitiveKey(h.name)) {
                safeHeaders[h.name] = REDACTED;
            } else {
                safeHeaders[h.name] = h.value;
            }
        }
    }

    // 脱敏查询参数
    const safeQuery = {};
    if (Array.isArray(req.queryString)) {
        for (const q of req.queryString) {
            if (isSensitiveKey(q.name)) {
                safeQuery[q.name] = REDACTED;
            } else {
                safeQuery[q.name] = q.value;
            }
        }
    }

    // 脱敏 POST body
    let safeBody = null;
    if (req.postData) {
        if (req.postData.params && Array.isArray(req.postData.params)) {
            safeBody = {};
            for (const p of req.postData.params) {
                if (isSensitiveKey(p.name)) {
                    safeBody[p.name] = REDACTED;
                } else {
                    safeBody[p.name] = p.value;
                }
            }
        } else if (req.postData.text) {
            safeBody = redactBodyText(req.postData.text);
        }
    }

    return {
        method: req.method,
        url: redactUrl(req.url),
        httpVersion: req.httpVersion,
        headers: safeHeaders,
        queryString: safeQuery,
        postData: safeBody,
        response: {
            status: resp.status,
            statusText: resp.statusText,
            contentSize: resp.content?.size || 0,
            mimeType: resp.content?.mimeType || '',
        },
    };
}

function redactBodyText(text) {
    if (!text) return text;
    try {
        const obj = JSON.parse(text);
        return JSON.stringify(redactObject(obj));
    } catch {
        const raw = String(text);
        if (/^[^=]+=[^=]*(?:&[^=]+=[^=]*)*$/.test(raw)) {
            const params = new URLSearchParams(raw);
            let changed = false;
            for (const key of Array.from(params.keys())) {
                if (isSensitiveKey(key)) {
                    params.set(key, REDACTED);
                    changed = true;
                }
            }
            if (changed) return params.toString();
        }

        return raw.replace(/(")([\w.-]+)(")\s*:\s*(")([^"]*)(")/g, (match, q1, key, q2, q3, val, q4) => {
            if (isSensitiveKey(key)) return `${q1}${key}${q2}:${q3}${REDACTED}${q4}`;
            return match;
        });
    }
}

function redactText(value) {
    if (value === undefined || value === null) return value;
    let text = String(value);
    text = text.replace(/https?:\/\/[^\s"'<>]+/gi, url => redactUrl(url));
    text = text.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`);
    text = text.replace(
        /\b(cookie|set-cookie|authorization|proxy-authorization|token|auth[-_]?token|access[-_]?token|refresh[-_]?token|api[-_]?key|secret|session[-_]?key|wsgsig|signature)\b\s*[:=]\s*(?:Bearer\s+)?[^\s,;]+/gi,
        (_match, key) => `${key}=${REDACTED}`
    );
    text = text.replace(/\b1[3-9]\d{9}\b/g, phone => `${phone.slice(0, 3)}****${phone.slice(7)}`);
    text = text.replace(/\b\d{17}[\dXx]\b/g, idCard => `${idCard.slice(0, 4)}**********${idCard.slice(14)}`);
    return text;
}

function normalizeStorageLimit(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_STORAGE_BYTES;
    return Math.max(256, Math.min(10 * 1024 * 1024, Math.floor(parsed)));
}

function buildStoragePreview(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const preferredKeys = [
        'source', 'sourceType', 'sourceStage', 'stage', 'snapshotMode',
        'platform', 'city', 'stationId', 'stationName', 'address', 'meta'
    ];
    const preview = {};
    for (const key of preferredKeys) {
        if (Object.prototype.hasOwnProperty.call(value, key)) {
            preview[key] = value[key];
        }
    }
    return Object.keys(preview).length > 0 ? preview : null;
}

/**
 * 生成可安全持久化的 JSON。超出上限时仅保留来源摘要，避免大报文撑大 SQLite。
 */
function serializeRedacted(value, options = {}) {
    if (value === undefined || value === null || value === '') return null;
    const maxBytes = normalizeStorageLimit(options.maxBytes);
    const normalized = typeof value === 'string'
        ? (() => {
            try {
                return redactObject(JSON.parse(value));
            } catch {
                return redactBodyText(value);
            }
        })()
        : redactObject(value);
    let serialized;
    try {
        serialized = JSON.stringify(normalized);
    } catch {
        serialized = JSON.stringify({
            _storagePolicy: {
                redacted: true,
                serializationFailed: true
            }
        });
    }

    const byteLength = Buffer.byteLength(serialized, 'utf8');
    if (byteLength <= maxBytes) return serialized;

    return JSON.stringify({
        _storagePolicy: {
            redacted: true,
            truncated: true,
            originalBytes: byteLength,
            maxBytes
        },
        preview: buildStoragePreview(normalized)
    });
}

/**
 * 从脱敏后的 entry 生成摘要
 */
function summarizeRedactedEntry(entry, targetHosts = []) {
    const redacted = redactHarEntry(entry);
    const req = entry.request || {};
    const resp = entry.response || {};
    const url = req.url || '';
    const isTarget = targetHosts.length === 0 || targetHosts.some(h => url.includes(h));

    // 提取响应字段摘要（脱敏后的顶层key列表）
    let responseFieldSummary = [];
    try {
        const text = resp.content?.text;
        if (text) {
            const body = JSON.parse(text);
            if (body && typeof body === 'object') {
                responseFieldSummary = Object.keys(body).filter(k => !isSensitiveKey(k)).slice(0, 20);
            }
        }
    } catch {}

    return {
        method: redacted.method,
        url: redacted.url,
        host: isTarget ? new URL(url).hostname : undefined,
        path: isTarget ? new URL(url).pathname : undefined,
        isTarget,
        querySummary: redacted.queryString,
        bodySummary: redacted.postData,
        responseStatus: resp.status,
        responseFieldSummary,
        responseSize: resp.content?.size || 0,
        riskTags: detectRiskTags(req),
    };
}

function detectRiskTags(req) {
    const tags = [];
    const url = req.url || '';
    const headers = Array.isArray(req.headers) ? req.headers : [];
    const hasAuth = headers.some(h => isSensitiveKey(h.name)) || /token|sign|session|openid/i.test(url);
    if (hasAuth) tags.push('has_auth_params');
    if (url.startsWith('http://') && !url.includes('localhost')) tags.push('plaintext_http');
    if (respHasPersonalData(req)) tags.push('personal_data_possible');
    return tags;
}

function respHasPersonalData(req) {
    // 保守估计：如果路径包含 user/info/profile/account，可能含个人信息
    const url = (req.url || '').toLowerCase();
    return /user|profile|account|personal/.test(url);
}

module.exports = {
    redactValueByContent,    isSensitiveKey,
    redactValue,
    redactObject,
    redactUrl,
    redactHarEntry,
    redactBodyText,
    redactText,
    serializeRedacted,
    summarizeRedactedEntry,
    REDACTED,
    SENSITIVE_KEY_PATTERNS,
    DEFAULT_MAX_STORAGE_BYTES,
};
