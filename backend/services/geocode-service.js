'use strict';

const fs = require('fs');

function normalizeKeyword(value) {
    return String(value || '').trim().toLowerCase().replace(/\s+/g, '');
}

function loadGeocodePresets(filePath) {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!Array.isArray(parsed) || parsed.length === 0) {
        throw new Error('geocode presets must be a non-empty JSON array');
    }
    return parsed.map((item, index) => {
        const lat = Number(item?.lat);
        const lng = Number(item?.lng);
        const name = String(item?.name || '').trim();
        if (!name || !Number.isFinite(lat) || !Number.isFinite(lng)
            || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
            throw new Error(`invalid geocode preset at index ${index}`);
        }
        return {
            name,
            province: String(item.province || '').trim(),
            city: String(item.city || item.name || '').trim(),
            district: String(item.district || '').trim(),
            lat,
            lng,
            aliases: Array.isArray(item.aliases)
                ? item.aliases.map(value => String(value || '').trim()).filter(Boolean)
                : [],
        };
    });
}

class GeocodeService {
    constructor(options = {}) {
        this.presets = options.presets || loadGeocodePresets(options.presetsPath);
        this.outboundClient = options.outboundClient;
        this.getApiKey = options.getApiKey || (() => '');
        if (!this.outboundClient) throw new TypeError('outboundClient is required');
    }

    async search(keyword) {
        const localResults = this.searchLocal(keyword);
        return localResults.length > 0 ? localResults : this.searchAmap(keyword);
    }

    searchLocal(keyword) {
        const normalized = normalizeKeyword(keyword);
        if (!normalized) return [];

        return this.presets
            .map(item => {
                const nameKeys = [item.name, ...item.aliases].map(normalizeKeyword).filter(Boolean);
                const areaKeys = [item.city, item.province].map(normalizeKeyword).filter(Boolean);
                let score = 0;
                for (const key of nameKeys) {
                    if (key === normalized) score = Math.max(score, 100);
                    else if (key.includes(normalized)) score = Math.max(score, 80);
                    else if (normalized.includes(key) && key.length >= 3) score = Math.max(score, 60);
                }
                for (const key of areaKeys) {
                    if (key === normalized) score = Math.max(score, 50);
                    else if (key.includes(normalized)) score = Math.max(score, 30);
                }
                return score > 0 ? { item, score } : null;
            })
            .filter(Boolean)
            .sort((a, b) => b.score - a.score
                || normalizeKeyword(b.item.name).length - normalizeKeyword(a.item.name).length)
            .map(({ item }) => ({
                ...item,
                source: '本地预设',
                coordinateSystem: 'WGS84',
            }));
    }

    async searchAmap(keyword) {
        const key = String(this.getApiKey() || '').trim();
        if (!key) return [];

        const url = new URL('https://restapi.amap.com/v3/geocode/geo');
        url.searchParams.set('key', key);
        url.searchParams.set('address', keyword);
        url.searchParams.set('output', 'JSON');
        const payload = await this.outboundClient.fetchJson(url.toString(), {
            reason: 'geocode-search',
            platform: 'amap',
            chain: 'geocode',
            evidenceType: 'geocode',
            proxyContext: { keyword },
        });
        if (payload?.status !== '1' || !Array.isArray(payload.geocodes)) return [];

        return payload.geocodes.map(item => {
            const [lng, lat] = String(item.location || '').split(',').map(Number);
            if (!Number.isFinite(lat) || !Number.isFinite(lng)
                || lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
            return {
                name: item.formatted_address || keyword,
                province: item.province || '',
                city: Array.isArray(item.city) ? '' : (item.city || ''),
                district: Array.isArray(item.district) ? '' : (item.district || ''),
                lat,
                lng,
                source: '高德',
                coordinateSystem: 'GCJ02',
            };
        }).filter(Boolean);
    }
}

module.exports = { GeocodeService, loadGeocodePresets, normalizeKeyword };
