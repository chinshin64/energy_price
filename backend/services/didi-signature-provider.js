const fs = require('fs');
const path = require('path');

class DidiSignatureProvider {
    constructor(options = {}) {
        this.corpusPath = options.corpusPath
            || process.env.DIDI_SIGNATURE_CORPUS_PATH
            || path.join(__dirname, '../../data/didi-signature-corpus.json');
        this.maxDistanceKm = this.normalizeMaxDistance(options.maxDistanceKm ?? process.env.DIDI_SIGNATURE_CORPUS_MAX_DISTANCE_KM);
        this.sampleApplyMode = this.normalizeApplyMode(
            options.sampleApplyMode || process.env.DIDI_SIGNATURE_SAMPLE_APPLY_MODE || 'patch'
        );
        this.cache = null;
        this.cacheMtimeMs = 0;
    }

    normalizeMaxDistance(value) {
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed <= 0) {
            return 10;
        }
        return parsed;
    }

    hasListSample(pattern, params = {}, proxyContext = null) {
        return Boolean(
            this.findTargetRequestSample(pattern, params, proxyContext, 'list')
            || this.findListSample(pattern, params, proxyContext)
        );
    }

    getMaxListPage(pattern, params = {}, proxyContext = null) {
        if (!this.isDidiListPattern(pattern)) {
            return null;
        }

        const target = this.extractTarget(params, proxyContext);
        if (!target) {
            return null;
        }

        const explicitSample = this.findTargetRequestSample(pattern, params, proxyContext, 'list');
        if (explicitSample) {
            return Number(explicitSample.pageNo) || 1;
        }

        const pages = this.findListCandidates(pattern, target)
            .map(entry => Number(entry.pageNo))
            .filter(page => Number.isFinite(page) && page > 0);
        return pages.length > 0 ? Math.max(...pages) : null;
    }

    applyListSample(pattern, params = {}, headers = {}, proxyContext = null, options = {}) {
        const sample = this.findTargetRequestSample(pattern, params, proxyContext, 'list')
            || this.findListSample(pattern, params, proxyContext, options);
        if (!sample) {
            return null;
        }

        const patchSummary = this.applySampleToRequest(sample, params, headers, pattern, {
            mode: sample.__applyMode || this.sampleApplyMode
        });
        return this.buildMeta(sample, 'list', patchSummary);
    }

    hasDetailSample(pattern, params = {}, proxyContext = null) {
        return Boolean(this.findTargetRequestSample(pattern, params, proxyContext, 'detail'))
            || this.countDetailSamples(pattern, params, proxyContext) > 0;
    }

    applyDetailSample(pattern, params = {}, headers = {}, proxyContext = null, options = {}) {
        const sample = this.findTargetRequestSample(pattern, params, proxyContext, 'detail')
            || this.findDetailSample(pattern, params, proxyContext, options);
        if (!sample) {
            return null;
        }

        const patchSummary = this.applySampleToRequest(sample, params, headers, pattern, {
            mode: sample.__applyMode || this.sampleApplyMode
        });
        return this.buildMeta(sample, 'detail', patchSummary);
    }

    applySampleToRequest(sample, params = {}, headers = {}, pattern = null, options = {}) {
        const mode = this.normalizeApplyMode(options.mode || sample.__applyMode || this.sampleApplyMode);
        const queryPatch = this.mergeRequestParams(params.query, sample.queryParams, mode);
        const bodyPatch = this.mergeRequestParams(params.body, sample.bodyParams, mode);
        params.query = queryPatch.params;
        params.body = bodyPatch.params;

        const patchedHeaders = [];
        for (const [key, value] of Object.entries(sample.headers || {})) {
            if (this.shouldApplyHeaderValue(headers, key, value, mode)) {
                headers[key] = value;
                patchedHeaders.push(key);
            }
        }

        const userAgent = sample.headers?.['user-agent'];
        if (userAgent && pattern) {
            Object.defineProperty(pattern, '__selectedUserAgent', {
                value: String(userAgent),
                writable: true,
                configurable: true,
                enumerable: false
            });
        }

        return {
            mode,
            patchedQueryKeys: queryPatch.patchedKeys,
            patchedBodyKeys: bodyPatch.patchedKeys,
            patchedHeaderKeys: patchedHeaders
        };
    }

    buildMeta(sample, scope, patchSummary = null) {
        return {
            provider: sample.source === 'target-request-params'
                ? 'target-request-params'
                : 'didi-signature-corpus',
            scope,
            source: sample.source || 'corpus',
            city: sample.city || '',
            keyword: sample.keyword || '',
            capturedAt: sample.capturedAt || null,
            distanceKm: sample.__distanceKm,
            sampleLat: sample.lat,
            sampleLng: sample.lng,
            pageNo: sample.pageNo || null,
            stationId: sample.stationId || sample.fullStationId || null,
            corpusPath: this.corpusPath,
            applyMode: patchSummary?.mode || sample.__applyMode || this.sampleApplyMode,
            patchedQueryKeys: patchSummary?.patchedQueryKeys || [],
            patchedBodyKeys: patchSummary?.patchedBodyKeys || [],
            patchedHeaderKeys: patchSummary?.patchedHeaderKeys || []
        };
    }

    mergeRequestParams(current = {}, supplement = {}, mode = 'patch') {
        if (mode === 'replay') {
            return {
                params: { ...(supplement || {}) },
                patchedKeys: Object.keys(supplement || {})
            };
        }

        const merged = { ...(current || {}) };
        const patchedKeys = [];
        for (const [key, value] of Object.entries(supplement || {})) {
            if (this.shouldApplyParamValue(merged, key, value, mode)) {
                merged[key] = value;
                patchedKeys.push(key);
            }
        }
        return { params: merged, patchedKeys };
    }

    shouldApplyParamValue(current = {}, key, value, mode = 'patch') {
        if (value === undefined || value === null || value === '') {
            return false;
        }
        if (mode === 'actual' || mode === 'replay') {
            return true;
        }
        return this.isEmptyValue(current[key]) || this.isSensitiveParamKey(key);
    }

    shouldApplyHeaderValue(current = {}, key, value, mode = 'patch') {
        if (value === undefined || value === null || value === '') {
            return false;
        }
        if (mode === 'actual' || mode === 'replay') {
            return true;
        }
        return this.isEmptyValue(current[key])
            || this.isSensitiveHeaderKey(key)
            || ['user-agent', 'referer', 'xweb_xhr', 'content-type'].includes(String(key || '').toLowerCase());
    }

    normalizeApplyMode(value) {
        const normalized = String(value || '').trim().toLowerCase();
        return normalized === 'actual' || normalized === 'replay' ? normalized : 'patch';
    }

    isEmptyValue(value) {
        return value === undefined || value === null || value === '';
    }

    isSensitiveParamKey(key) {
        const normalized = String(key || '').replace(/[_-]/g, '').toLowerCase();
        return normalized === 'wsgsig'
            || normalized === 'ticket'
            || normalized === 'openid'
            || normalized === 'token'
            || normalized === 'tokenid'
            || normalized.includes('sign');
    }

    isSensitiveHeaderKey(key) {
        const normalized = String(key || '').toLowerCase();
        return normalized.startsWith('secdd-')
            || normalized.startsWith('x-ca-')
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
            ].includes(normalized);
    }

    findTargetRequestSample(pattern, params = {}, proxyContext = null, scope = 'list') {
        const requestParams = proxyContext?.requestParams
            || proxyContext?.actualRequestParams
            || proxyContext?.didiRequestParams
            || null;
        if (!requestParams || typeof requestParams !== 'object') {
            return null;
        }

        const material = requestParams[scope] && typeof requestParams[scope] === 'object'
            ? requestParams[scope]
            : requestParams;
        const queryParams = this.normalizeObject(material.queryParams || material.query || {});
        const bodyParams = this.normalizeObject(material.bodyParams || material.body || {});
        const headers = this.normalizeHeaders(material.headers || {});
        if (
            Object.keys(queryParams).length === 0
            && Object.keys(bodyParams).length === 0
        ) {
            return null;
        }
        if (
            (this.isDidiListPattern(pattern) || this.isDidiDetailPattern(pattern))
            && !this.hasSensitiveRequestParam(queryParams, bodyParams)
        ) {
            return null;
        }

        const targetPath = this.safePathname(pattern.baseUrl);
        const materialPath = this.safePathname(material.baseUrl || material.url || '');
        if (materialPath && materialPath !== targetPath) {
            return null;
        }

        const lat = Number(material.lat ?? bodyParams.lat ?? bodyParams.userlat ?? queryParams.lat ?? proxyContext?.lat);
        const lng = Number(material.lng ?? bodyParams.lng ?? bodyParams.userlng ?? queryParams.lng ?? proxyContext?.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
            return null;
        }

        return {
            scope,
            method: String(material.method || pattern.method || (scope === 'detail' ? 'GET' : 'POST')).toUpperCase(),
            baseUrl: material.baseUrl || pattern.baseUrl || this.defaultBaseUrl({ scope }),
            city: material.city || proxyContext?.city || '',
            keyword: material.keyword || proxyContext?.keyword || proxyContext?.name || '',
            lat,
            lng,
            pageNo: Number(material.pageNo ?? bodyParams.pageNo ?? bodyParams.page ?? 1),
            stationId: material.stationId || material.fullStationId || queryParams.fullstationid || bodyParams.fullstationid || '',
            fullStationId: material.fullStationId || material.stationId || queryParams.fullstationid || bodyParams.fullstationid || '',
            capturedAt: material.capturedAt || material.createdAt || null,
            source: 'target-request-params',
            queryParams,
            bodyParams,
            headers,
            replayable: true,
            active: true,
            __distanceKm: 0,
            __applyMode: 'actual'
        };
    }

    hasSensitiveRequestParam(queryParams = {}, bodyParams = {}) {
        return [...Object.keys(queryParams || {}), ...Object.keys(bodyParams || {})]
            .some(key => this.isSensitiveParamKey(key));
    }

    findListSample(pattern, params = {}, proxyContext = null, options = {}) {
        if (!this.isDidiListPattern(pattern)) {
            return null;
        }

        const target = this.extractTarget(params, proxyContext);
        if (!target) {
            return null;
        }

        const requestedPageNo = this.extractPageNo(params) || 1;
        const candidates = this.findListCandidates(pattern, target)
            .filter(entry => Number(entry.pageNo) === Number(requestedPageNo))
            .sort((left, right) => this.compareSamples(left, right));

        if (candidates.length === 0) {
            return null;
        }
        const attempt = Math.max(0, Math.floor(Number(options.signatureAttempt) || 0));
        return candidates[attempt % candidates.length] || null;
    }

    findListCandidates(pattern, target) {
        const patternPath = this.safePathname(pattern.baseUrl);
        const method = String(pattern.method || 'GET').toUpperCase();
        const maxDistanceKm = this.effectiveMaxDistanceKm(target?.maxDistanceKm || target?.radiusKm);

        return this.getEntries()
            .filter(entry => entry.scope === 'list')
            .filter(entry => entry.active !== false)
            .filter(entry => entry.method === method)
            .filter(entry => this.safePathname(entry.baseUrl) === patternPath)
            .map(entry => ({
                ...entry,
                __distanceKm: this.calculateDistanceKm(target.lat, target.lng, entry.lat, entry.lng)
            }))
            .filter(entry => Number.isFinite(entry.__distanceKm) && entry.__distanceKm <= maxDistanceKm);
    }

    effectiveMaxDistanceKm(requestedDistanceKm) {
        const requested = Number(requestedDistanceKm);
        if (!Number.isFinite(requested) || requested <= 0) {
            return this.maxDistanceKm;
        }
        return Math.min(Math.max(this.maxDistanceKm, requested), 50);
    }

    countDetailSamples(pattern, params = {}, proxyContext = null) {
        return this.findDetailCandidates(pattern, params, proxyContext).length;
    }

    findDetailSample(pattern, params = {}, proxyContext = null, options = {}) {
        const candidates = this.findDetailCandidates(pattern, params, proxyContext);
        if (candidates.length === 0) {
            return null;
        }
        const attempt = Math.max(0, Math.floor(Number(options.signatureAttempt) || 0));
        return candidates[attempt % candidates.length] || null;
    }

    findDetailCandidates(pattern, params = {}, proxyContext = null) {
        if (!this.isDidiDetailPattern(pattern)) {
            return [];
        }

        const stationIds = this.extractStationIds(params);
        if (stationIds.length === 0) {
            return [];
        }

        const target = this.extractTarget(params, proxyContext);
        const patternPath = this.safePathname(pattern.baseUrl);
        const method = String(pattern.method || 'GET').toUpperCase();

        return this.getEntries()
            .filter(entry => entry.scope === 'detail')
            .filter(entry => entry.active !== false)
            .filter(entry => entry.method === method)
            .filter(entry => this.safePathname(entry.baseUrl) === patternPath)
            .filter(entry => stationIds.includes(this.normalizeStationId(entry.stationId || entry.fullStationId)))
            .map(entry => ({
                ...entry,
                __distanceKm: target
                    ? this.calculateDistanceKm(target.lat, target.lng, entry.lat, entry.lng)
                    : Number(entry.sampleDistanceKm || 0)
            }))
            .filter(entry => !target || (Number.isFinite(entry.__distanceKm) && entry.__distanceKm <= this.maxDistanceKm))
            .sort((left, right) => this.compareSamples(left, right));
    }

    compareSamples(left, right) {
        const replayableDiff = Number(right.replayable !== false) - Number(left.replayable !== false);
        if (replayableDiff !== 0) return replayableDiff;
        const tokenDiff = Number(Boolean(left.hasToken)) - Number(Boolean(right.hasToken));
        if (tokenDiff !== 0) return tokenDiff;
        const distanceDiff = Number(left.__distanceKm || 0) - Number(right.__distanceKm || 0);
        if (distanceDiff !== 0) return distanceDiff;
        return String(right.capturedAt || '').localeCompare(String(left.capturedAt || ''));
    }

    isDidiListPattern(pattern) {
        if (!pattern || pattern.platform !== 'didi-charging') {
            return false;
        }
        return /homepage\/stationlist/i.test(this.safePathname(pattern.baseUrl));
    }

    isDidiDetailPattern(pattern) {
        if (!pattern || pattern.platform !== 'didi-charging') {
            return false;
        }
        return /station\/getoneinfo/i.test(this.safePathname(pattern.baseUrl));
    }

    extractTarget(params = {}, proxyContext = null) {
        const body = params.body || {};
        const query = params.query || {};
        const lat = Number(body.lat ?? body.userlat ?? query.lat ?? query.userlat ?? proxyContext?.lat);
        const lng = Number(body.lng ?? body.userlng ?? query.lng ?? query.userlng ?? proxyContext?.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
            return null;
        }
        return { lat, lng };
    }

    extractPageNo(params = {}) {
        const body = params.body || {};
        const query = params.query || {};
        const pageNo = Number(body.pageNo ?? body.page ?? query.pageNo ?? query.page);
        return Number.isFinite(pageNo) ? pageNo : null;
    }

    extractStationIds(params = {}) {
        const body = params.body || {};
        const query = params.query || {};
        const keys = ['fullstationid', 'fullStationId', 'stationId', 'stationid', 'station_id', 'id'];
        const values = [];
        for (const container of [query, body]) {
            for (const key of keys) {
                const normalized = this.normalizeStationId(container[key]);
                if (normalized && !values.includes(normalized)) {
                    values.push(normalized);
                }
            }
        }
        return values;
    }

    getEntries() {
        let stat = null;
        try {
            stat = fs.statSync(this.corpusPath);
        } catch (error) {
            this.cache = [];
            this.cacheMtimeMs = 0;
            return this.cache;
        }

        if (this.cache && this.cacheMtimeMs === stat.mtimeMs) {
            return this.cache;
        }

        try {
            const payload = JSON.parse(fs.readFileSync(this.corpusPath, 'utf8'));
            const rawEntries = Array.isArray(payload) ? payload : payload.entries;
            this.cache = Array.isArray(rawEntries)
                ? rawEntries.map(entry => this.normalizeEntry(entry)).filter(Boolean)
                : [];
            this.cacheMtimeMs = stat.mtimeMs;
        } catch (error) {
            this.cache = [];
            this.cacheMtimeMs = stat.mtimeMs;
        }

        return this.cache;
    }

    normalizeEntry(entry = {}) {
        const bodyParams = this.normalizeObject(entry.bodyParams || entry.body || {});
        const queryParams = this.normalizeObject(entry.queryParams || entry.query || {});
        const headers = this.normalizeHeaders(entry.headers || {});
        const baseUrl = entry.baseUrl || this.defaultBaseUrl(entry);
        const scope = this.normalizeScope(entry.scope, baseUrl);
        const lat = Number(entry.lat ?? bodyParams.lat ?? bodyParams.userlat ?? queryParams.lat);
        const lng = Number(entry.lng ?? bodyParams.lng ?? bodyParams.userlng ?? queryParams.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
            return null;
        }

        const stationId = this.normalizeStationId(
            entry.stationId
            || entry.fullStationId
            || queryParams.fullstationid
            || queryParams.fullStationId
            || queryParams.stationId
            || queryParams.stationid
            || bodyParams.stationId
            || bodyParams.fullstationid
        );

        return {
            ...entry,
            scope,
            method: String(entry.method || (scope === 'detail' ? 'GET' : 'POST')).toUpperCase(),
            baseUrl,
            queryParams,
            bodyParams,
            headers,
            lat,
            lng,
            pageNo: Number(entry.pageNo ?? bodyParams.pageNo ?? bodyParams.page ?? 1),
            pageSize: Number(entry.pageSize ?? bodyParams.pageSize ?? 10),
            stationId,
            fullStationId: stationId,
            hasToken: Boolean(entry.hasToken ?? bodyParams.token ?? bodyParams.ticket ?? queryParams.ticket ?? queryParams._waf_token),
            replayable: entry.replayable !== false,
            active: entry.active !== false
        };
    }

    defaultBaseUrl(entry = {}) {
        const scope = this.normalizeScope(entry.scope, '');
        return scope === 'detail'
            ? 'https://energy.xiaojukeji.com/station-api/station/getoneinfo'
            : 'https://energy.xiaojukeji.com/station-api/homepage/stationList';
    }

    normalizeScope(scope, baseUrl) {
        const normalized = String(scope || '').toLowerCase();
        if (normalized === 'detail' || normalized === 'list') {
            return normalized;
        }
        return /station\/getoneinfo/i.test(this.safePathname(baseUrl)) ? 'detail' : 'list';
    }

    normalizeObject(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return {};
        }
        return { ...value };
    }

    normalizeHeaders(headers = {}) {
        return Object.keys(headers).reduce((result, key) => {
            result[String(key).toLowerCase()] = headers[key];
            return result;
        }, {});
    }

    normalizeStationId(value) {
        return String(value || '').trim();
    }

    safePathname(baseUrl) {
        try {
            return new URL(baseUrl).pathname;
        } catch (error) {
            return '';
        }
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

    getHealthStatus() {
        const entries = this.getEntries();
        const now = Date.now();
        let oldestCapture = null;
        let newestCapture = null;
        let corpusAgeDays = null;

        const entriesByCity = {};
        const entriesByScope = { list: 0, detail: 0 };
        const entriesBySource = {};

        for (const entry of entries) {
            const city = entry.city || 'unknown';
            entriesByCity[city] = (entriesByCity[city] || 0) + 1;

            const scope = entry.scope || 'unknown';
            if (scope === 'list' || scope === 'detail') {
                entriesByScope[scope]++;
            }

            const source = entry.source || 'unknown';
            entriesBySource[source] = (entriesBySource[source] || 0) + 1;

            const capturedAt = entry.capturedAt;
            if (capturedAt) {
                if (!oldestCapture || capturedAt < oldestCapture) {
                    oldestCapture = capturedAt;
                }
                if (!newestCapture || capturedAt > newestCapture) {
                    newestCapture = capturedAt;
                }
            }
        }

        if (newestCapture) {
            const newestMs = this._parseCapturedAtMs(newestCapture);
            if (newestMs > 0) {
                corpusAgeDays = (now - newestMs) / (1000 * 60 * 60 * 24);
            }
        }

        let status = 'critical';
        if (corpusAgeDays !== null) {
            if (corpusAgeDays < 3) {
                status = 'healthy';
            } else if (corpusAgeDays < 7) {
                status = 'stale';
            }
        }

        return {
            corpusAgeDays: corpusAgeDays !== null ? Math.round(corpusAgeDays * 10) / 10 : null,
            totalEntries: entries.length,
            entriesByCity,
            entriesByScope,
            entriesBySource,
            oldestCapture,
            newestCapture,
            status
        };
    }

    forceRefresh() {
        this.cache = null;
        this.cacheMtimeMs = 0;
        return this.getHealthStatus();
    }

    _parseCapturedAtMs(value) {
        if (!value) return 0;
        const s = String(value).trim();
        const ms = Date.parse(s);
        if (!Number.isNaN(ms)) return ms;
        const match = s.match(/^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/);
        if (match) {
            const [, y, mo, d, h, mi, sec] = match;
            return Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${sec}+08:00`);
        }
        return 0;
    }
}

module.exports = DidiSignatureProvider;
