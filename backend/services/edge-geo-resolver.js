'use strict';

const fs = require('node:fs');
const net = require('node:net');

function clean(value, maxLength = 160) {
    return String(value || '').trim().slice(0, maxLength);
}

function normalizeIp(value) {
    let normalized = clean(value, 128).toLowerCase();
    if (normalized.includes(',')) normalized = normalized.split(',')[0].trim();
    if (normalized.startsWith('::ffff:')) normalized = normalized.slice(7);
    const bracketed = normalized.match(/^\[([^\]]+)\](?::\d+)?$/);
    if (bracketed) normalized = bracketed[1];
    if (net.isIP(normalized)) return normalized;
    const ipv4WithPort = normalized.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
    return ipv4WithPort && net.isIP(ipv4WithPort[1]) === 4 ? ipv4WithPort[1] : '';
}

function ipv4ToInt(value) {
    if (net.isIP(value) !== 4) return null;
    return value.split('.').reduce((result, part) => ((result << 8) | Number(part)) >>> 0, 0);
}

function matchesCidr(ip, cidr) {
    const normalizedIp = normalizeIp(ip);
    const normalizedRule = clean(cidr, 128).toLowerCase();
    if (!normalizedIp || !normalizedRule) return false;
    if (!normalizedRule.includes('/')) return normalizedIp === normalizeIp(normalizedRule);
    const [network, prefixText] = normalizedRule.split('/');
    const prefix = Number(prefixText);
    if (net.isIP(normalizedIp) === 4 && net.isIP(network) === 4) {
        if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
        const addressInt = ipv4ToInt(normalizedIp);
        const networkInt = ipv4ToInt(network);
        const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
        return (addressInt & mask) === (networkInt & mask);
    }
    return prefix === 128 && normalizedIp === normalizeIp(network);
}

function isPrivateIp(value) {
    const ip = normalizeIp(value);
    if (!ip) return true;
    if (net.isIP(ip) === 4) {
        return matchesCidr(ip, '10.0.0.0/8')
            || matchesCidr(ip, '100.64.0.0/10')
            || matchesCidr(ip, '127.0.0.0/8')
            || matchesCidr(ip, '169.254.0.0/16')
            || matchesCidr(ip, '172.16.0.0/12')
            || matchesCidr(ip, '192.168.0.0/16');
    }
    return ip === '::1' || ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80:');
}

function normalizeGeo(input = {}, fallbackSource = '') {
    const country = clean(input.country || input.country_name, 80);
    const province = clean(input.province || input.region || input.regionName, 80);
    const city = clean(input.city, 80);
    const asn = clean(input.asn || input.connection?.asn || input.org, 120);
    return {
        country,
        province,
        city,
        asn,
        verified: input.verified === true || Boolean(country || province || city),
        source: clean(input.source || fallbackSource, 80) || 'unresolved'
    };
}

function readRules(filePath) {
    if (!filePath || !fs.existsSync(filePath)) return [];
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const entries = Array.isArray(parsed) ? parsed : parsed.rules;
    if (!Array.isArray(entries)) throw new Error('edge geo rules must be an array');
    return entries.map((entry, index) => {
        const cidr = clean(entry?.cidr, 128);
        if (!cidr || (!cidr.includes('/') && !normalizeIp(cidr))) {
            throw new Error(`invalid edge geo CIDR rule at index ${index}`);
        }
        return { cidr, geo: normalizeGeo({ ...entry, verified: true }, 'cidr-rule') };
    });
}

class EdgeGeoResolver {
    constructor(options = {}) {
        this.rules = options.rules || readRules(options.rulesPath || process.env.EDGE_GEO_RULES_PATH || '');
        this.providerUrl = clean(options.providerUrl ?? process.env.EDGE_GEO_PROVIDER_URL, 1000);
        this.httpClient = options.httpClient || null;
        this.timeoutMs = Math.max(500, Math.min(10000, Number(options.timeoutMs || 3000)));
        this.cacheTtlMs = Math.max(1000, Number(options.cacheTtlMs || 5 * 60 * 1000));
        this.cache = new Map();
        if (this.providerUrl) {
            const parsed = new URL(this.providerUrl.replace('{ip}', '127.0.0.1'));
            if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
                throw new Error('EDGE_GEO_PROVIDER_URL must be an HTTPS URL without credentials');
            }
        }
    }

    async resolve(value) {
        const ip = normalizeIp(value);
        if (!ip) return { ip: '', ...normalizeGeo({}, 'invalid-ip'), private: true };
        const cached = this.cache.get(ip);
        if (cached && cached.expiresAt > Date.now()) return { ...cached.value };

        const rule = this.rules.find(entry => matchesCidr(ip, entry.cidr));
        if (rule) return this.remember(ip, { ip, ...rule.geo, private: isPrivateIp(ip) });
        if (isPrivateIp(ip)) {
            return this.remember(ip, {
                ip,
                ...normalizeGeo({}, 'private-unmapped'),
                private: true
            });
        }
        if (!this.providerUrl) {
            return this.remember(ip, {
                ip,
                ...normalizeGeo({}, 'provider-unconfigured'),
                private: false
            });
        }

        const client = this.httpClient || require('axios');
        const response = await client.get(this.providerUrl.replace('{ip}', encodeURIComponent(ip)), {
            timeout: this.timeoutMs,
            maxRedirects: 0,
            validateStatus: status => status >= 200 && status < 300
        });
        const payload = response?.data && typeof response.data === 'object' ? response.data : {};
        if (payload.success === false || payload.status === 'fail') {
            throw new Error('edge IP geo provider rejected the lookup');
        }
        return this.remember(ip, {
            ip,
            ...normalizeGeo({ ...payload, verified: true }, 'https-provider'),
            private: false
        });
    }

    remember(ip, value) {
        const result = { ...value, resolvedAt: new Date().toISOString() };
        this.cache.set(ip, { value: result, expiresAt: Date.now() + this.cacheTtlMs });
        return { ...result };
    }
}

module.exports = {
    EdgeGeoResolver,
    isPrivateIp,
    matchesCidr,
    normalizeGeo,
    normalizeIp,
    readRules
};
