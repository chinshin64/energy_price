'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const axios = require('axios');
const {
    findForbiddenFuelField,
    validateFuelOffer,
    validateFuelQuote,
    validateProviderEvidence,
} = require('./fuel-payload-policy');

const SOURCE_AGENT_PATTERN = /^[a-z0-9][a-z0-9._-]{0,54}-agent$/;
const PUBLIC_FUEL_STATION_FIELDS = Object.freeze([
    'address', 'availablePorts', 'busyPorts', 'totalPorts',
    'portSemantics', 'missingFields', 'qualityStatus', 'needsReview',
]);

function parseBoolean(value, fallback = false) {
    if (value === undefined || value === null || value === '') return fallback;
    return /^(1|true|yes|on)$/i.test(String(value));
}

class RemoteMobileSourceSync {
    constructor(options = {}) {
        if (!options.stationModel || typeof options.stationModel.insertBatch !== 'function') {
            throw new TypeError('stationModel.insertBatch is required');
        }
        this.stationModel = options.stationModel;
        this.httpClient = options.httpClient || axios;
        this.sourceNode = options.sourceNode || '47-mysql';
        this.enabled = options.enabled !== undefined
            ? options.enabled === true
            : parseBoolean(process.env.MOBILE_SOURCE_SYNC_ENABLED, false);
        this.baseUrl = this.normalizeBaseUrl(
            options.baseUrl !== undefined ? options.baseUrl : process.env.MOBILE_SOURCE_BASE_URL,
            options.allowHttp !== undefined
                ? options.allowHttp === true
                : parseBoolean(process.env.MOBILE_SOURCE_ALLOW_HTTP, false),
            options.allowedHosts !== undefined
                ? options.allowedHosts
                : process.env.MOBILE_SOURCE_ALLOWED_HOSTS || '47.111.139.230'
        );
        this.token = String(options.token !== undefined ? options.token : process.env.MOBILE_SOURCE_SYNC_TOKEN || '').trim();
        this.includeVerificationAgent = options.includeVerificationAgent !== undefined
            ? options.includeVerificationAgent === true
            : parseBoolean(process.env.MOBILE_SOURCE_SYNC_INCLUDE_VERIFICATION_AGENT, false);
        this.batchSize = this.boundedInt(
            options.batchSize ?? process.env.MOBILE_SOURCE_SYNC_BATCH_SIZE,
            1,
            1000,
            200
        );
        this.intervalMs = this.boundedInt(
            options.intervalMs ?? process.env.MOBILE_SOURCE_SYNC_INTERVAL_MS,
            10000,
            24 * 60 * 60 * 1000,
            60000
        );
        this.requestTimeoutMs = this.boundedInt(
            options.requestTimeoutMs ?? process.env.MOBILE_SOURCE_SYNC_TIMEOUT_MS,
            1000,
            120000,
            15000
        );
        this.statePath = options.statePath || process.env.MOBILE_SOURCE_SYNC_STATE_PATH
            || path.resolve(__dirname, '../../data/mobile-source-sync-state.json');
        this.timer = null;
        this.running = false;
        fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    }

    start() {
        if (!this.enabled || this.timer) return false;
        const run = async () => {
            try {
                await this.pullOnce();
            } catch (error) {
                this.recordFailure(error);
                console.warn(`47 mobile source sync failed: ${error.message}`);
            } finally {
                if (this.enabled) {
                    this.timer = setTimeout(run, this.intervalMs);
                    this.timer.unref?.();
                }
            }
        };
        this.timer = setTimeout(run, 0);
        this.timer.unref?.();
        return true;
    }

    stop() {
        this.enabled = false;
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
    }

    async pullOnce() {
        if (this.running) {
            return { skipped: true, reason: 'sync already running', ...this.getStatus() };
        }
        if (!this.baseUrl) throw this.syncError('mobile_source_url_missing', 'MOBILE_SOURCE_BASE_URL is required');
        if (!this.token) throw this.syncError('mobile_source_token_missing', 'MOBILE_SOURCE_SYNC_TOKEN is required');

        this.running = true;
        try {
            const state = this.loadState();
            const cursor = this.safeCursor(state.cursor);
            const response = await this.httpClient.get(`${this.baseUrl}/api/source-sync/stations`, {
                params: { afterId: cursor, limit: this.batchSize },
                timeout: this.requestTimeoutMs,
                headers: {
                    Authorization: `Bearer ${this.token}`,
                    Accept: 'application/json',
                },
                proxy: false,
                maxContentLength: 16 * 1024 * 1024,
                maxBodyLength: 16 * 1024 * 1024,
            });
            const data = response?.data?.data;
            const records = Array.isArray(data?.records) ? data.records : null;
            if (!response?.data?.success || !records) {
                throw this.syncError('mobile_source_response_invalid', '47 source response is invalid');
            }
            const normalized = this.normalizeRecords(records, cursor);
            const mergeable = this.includeVerificationAgent
                ? normalized
                : normalized.filter(record => record.sourceAgent !== 'verification-agent');
            const dbResult = mergeable.length > 0
                ? this.stationModel.insertBatch(
                    mergeable.map(record => this.toLocalStation(record)),
                    { rejectOnRed: true }
                )
                : { successCount: 0, yellowCount: 0, redCount: 0, skipCount: 0 };
            this.assertBatchPersisted(dbResult, mergeable.length);
            const nextCursor = normalized.length > 0
                ? normalized[normalized.length - 1].sourceRecordId
                : cursor;
            const nextState = {
                cursor: nextCursor,
                sourceNode: this.sourceNode,
                lastAttemptAt: new Date().toISOString(),
                lastSuccessAt: new Date().toISOString(),
                lastError: null,
                lastFetchedCount: normalized.length,
                lastMergedCount: mergeable.length,
                totalFetched: (Number(state.totalFetched) || 0) + normalized.length,
                totalMerged: (Number(state.totalMerged) || 0) + mergeable.length,
                lastDbResult: {
                    successCount: Number(dbResult.successCount) || 0,
                    reviewCount: Number(dbResult.yellowCount) || 0,
                    rejectedCount: Number(dbResult.redCount) || 0,
                    skippedCount: Number(dbResult.skipCount) || 0,
                },
            };
            this.saveState(nextState);
            return { skipped: false, ...nextState };
        } finally {
            this.running = false;
        }
    }

    normalizeRecords(records, cursor) {
        let previous = cursor;
        return records.map((record, index) => {
            const sourceRecordId = this.safeCursor(record?.sourceRecordId);
            if (sourceRecordId <= previous) {
                throw this.syncError(
                    'mobile_source_cursor_invalid',
                    `sourceRecordId must increase at records[${index}]`
                );
            }
            if (record.sourceNode !== this.sourceNode) {
                throw this.syncError('mobile_source_node_mismatch', `unexpected sourceNode at records[${index}]`);
            }
            const sourceAgent = String(record.sourceAgent || '').trim().toLowerCase();
            if (!SOURCE_AGENT_PATTERN.test(sourceAgent)) {
                throw this.syncError('mobile_source_agent_invalid', `invalid sourceAgent at records[${index}]`);
            }
            if (!String(record.platform || '').trim() || !String(record.stationName || '').trim()) {
                throw this.syncError('mobile_source_record_invalid', `missing station identity at records[${index}]`);
            }
            const stationType = String(record.stationType || 'charging');
            if (!['charging', 'fuel'].includes(stationType)) {
                throw this.syncError('mobile_source_record_invalid', `unknown station type at records[${index}]`);
            }
            if (stationType === 'fuel') {
                const observation = record.fuelObservation
                    && typeof record.fuelObservation === 'object'
                    && !Array.isArray(record.fuelObservation)
                    ? record.fuelObservation
                    : {};
                const fuelRecord = {
                    ...record,
                    providerName: record.providerName ?? observation.providerName ?? null,
                    providerEvidence: record.providerEvidence ?? observation.providerEvidence ?? null,
                    fuelOffers: record.fuelOffers ?? observation.fuelOffers,
                    fuelQuotes: record.fuelQuotes ?? observation.fuelQuotes ?? [],
                };
                const rawRecord = record.raw
                    && typeof record.raw === 'object'
                    && !Array.isArray(record.raw)
                    ? record.raw
                    : {};
                const rawFuelObservation = rawRecord.fuelObservation
                    && typeof rawRecord.fuelObservation === 'object'
                    && !Array.isArray(rawRecord.fuelObservation)
                    ? rawRecord.fuelObservation
                    : {};
                const rawProviderEvidence = rawFuelObservation.providerEvidence
                    ?? rawRecord.providerEvidence;
                if (rawProviderEvidence !== undefined
                        && rawProviderEvidence !== null
                        && !isDeepStrictEqual(rawProviderEvidence, fuelRecord.providerEvidence)) {
                    throw this.syncError(
                        'mobile_source_record_invalid',
                        `provider evidence mismatch at records[${index}]`
                    );
                }
                const fuelPolicyRecord = { ...fuelRecord };
                for (const field of PUBLIC_FUEL_STATION_FIELDS) delete fuelPolicyRecord[field];
                if (findForbiddenFuelField(fuelPolicyRecord)) {
                    throw this.syncError(
                        'mobile_source_record_invalid',
                        `fuel record contains charging fields at records[${index}]`
                    );
                }
                if (String(fuelRecord.platform) === 'amap') {
                    throw this.syncError(
                        'mobile_source_record_invalid',
                        `amap fuel platform must be amap-fuel at records[${index}]`
                    );
                }
                if (fuelRecord.providerName !== null
                        && (typeof fuelRecord.providerName !== 'string'
                            || !String(fuelRecord.providerName).trim()
                            || String(fuelRecord.providerName).length > 128)) {
                    throw this.syncError('mobile_source_record_invalid', `provider invalid at records[${index}]`);
                }
                const providerEvidenceError = validateProviderEvidence(fuelRecord.providerEvidence);
                if (providerEvidenceError || (fuelRecord.providerName && !fuelRecord.providerEvidence)) {
                    throw this.syncError(
                        'mobile_source_record_invalid',
                        `provider evidence invalid at records[${index}]`
                    );
                }
                if (!Array.isArray(fuelRecord.fuelOffers)
                        || fuelRecord.fuelOffers.length > 32
                        || fuelRecord.fuelOffers.some(offer => validateFuelOffer(offer))) {
                    throw this.syncError('mobile_source_record_invalid', `fuel offers invalid at records[${index}]`);
                }
                if (!Array.isArray(fuelRecord.fuelQuotes)
                        || fuelRecord.fuelQuotes.length > 128
                        || fuelRecord.fuelQuotes.some(quote => validateFuelQuote(quote))) {
                    throw this.syncError('mobile_source_record_invalid', `fuel quotes invalid at records[${index}]`);
                }
                if (fuelRecord.fuelOffers.length === 0 && fuelRecord.fuelQuotes.length === 0) {
                    throw this.syncError(
                        'mobile_source_record_invalid',
                        `fuel record requires offers or quotes at records[${index}]`
                    );
                }
                previous = sourceRecordId;
                return { ...fuelRecord, sourceRecordId, sourceAgent, stationType };
            }
            previous = sourceRecordId;
            return { ...record, sourceRecordId, sourceAgent, stationType };
        });
    }

    toLocalStation(record) {
        const upstreamRaw = record.raw && typeof record.raw === 'object' && !Array.isArray(record.raw)
            ? record.raw
            : {};
        const canonicalUpstreamRaw = { ...upstreamRaw };
        const upstreamFuelObservation = record.stationType === 'fuel'
            && upstreamRaw.fuelObservation
            && typeof upstreamRaw.fuelObservation === 'object'
            && !Array.isArray(upstreamRaw.fuelObservation)
            ? upstreamRaw.fuelObservation
            : {};
        if (record.stationType === 'fuel') delete canonicalUpstreamRaw.providerEvidence;
        const base = {
            platform: record.platform,
            stationId: record.stationId || null,
            stationName: record.stationName,
            stationType: record.stationType,
            sourceStationKey: record.stationType === 'fuel'
                ? (record.sourceStationKey || record.stationId || `${this.sourceNode}:${record.sourceRecordId}`)
                : `${this.sourceNode}:${record.sourceRecordId}`,
            fuelOffers: record.stationType === 'fuel' ? record.fuelOffers : [],
            fuelQuotes: record.stationType === 'fuel' ? record.fuelQuotes : [],
            providerName: record.stationType === 'fuel' ? record.providerName : null,
            providerEvidence: record.stationType === 'fuel' ? record.providerEvidence : null,
            sourceType: 'mobile-ocr',
            sourceStage: record.sourceStage || 'phone-user-scroll',
            sourceAgent: record.sourceAgent,
            sourceNode: this.sourceNode,
            sourceRecordId: record.sourceRecordId,
            address: record.address ?? null,
            // 燃油侧无枪数据：不携带 ports/portSemantics，否则 evaluateFuel 的
            // findForbiddenFuelField 会判 fuel_charging_field_forbidden 红灯。
            // 充电侧显式带 null 占位。
            ...(record.stationType === 'fuel' ? {} : {
                availablePorts: record.availablePorts ?? null,
                busyPorts: record.busyPorts ?? null,
                totalPorts: record.totalPorts ?? null,
                portSemantics: record.portSemantics || null,
            }),
            missingFields: Array.isArray(record.missingFields) ? record.missingFields : [],
            qualityStatus: record.qualityStatus || null,
            needsReview: record.needsReview === true || (
                record.qualityStatus !== null
                && record.qualityStatus !== undefined
                && record.qualityStatus !== 'valid'
            ),
            snapshotAt: record.capturedAt,
            collectedAt: record.capturedAt,
            snapshotMode: 'append',
            raw: {
                ...canonicalUpstreamRaw,
                snapshotMode: 'append',
                ...(record.stationType === 'fuel' ? {
                    fuelObservation: {
                        ...upstreamFuelObservation,
                        providerEvidence: record.providerEvidence,
                    },
                } : {}),
                mobileSync: {
                    ...(upstreamRaw.mobileSync || {}),
                    meta: {
                        ...(upstreamRaw.mobileSync?.meta || {}),
                        sourceNode: this.sourceNode,
                        sourceRecordId: record.sourceRecordId,
                        ingestId: record.ingestId,
                        sourceAgent: record.sourceAgent,
                        sourceType: 'mobile-ocr',
                        sourceStage: record.sourceStage || 'phone-user-scroll',
                        platform: record.platform,
                        city: record.city,
                        capturedAt: record.capturedAt,
                    },
                },
            },
        };
        if (record.stationType === 'fuel') return base;
        return {
            ...base,
            latitude: record.latitude ?? null,
            longitude: record.longitude ?? null,
            priceFast: record.priceFast ?? null,
            priceSlow: record.priceSlow ?? null,
            priceSuper: record.priceSuper ?? null,
            priceService: record.priceService ?? null,
            fastIdlePorts: record.fastIdlePorts ?? 0,
            fastTotalPorts: record.fastTotalPorts ?? 0,
            slowIdlePorts: record.slowIdlePorts ?? 0,
            slowTotalPorts: record.slowTotalPorts ?? 0,
            superIdlePorts: record.superIdlePorts ?? 0,
            superTotalPorts: record.superTotalPorts ?? 0,
        };
    }

    assertBatchPersisted(result = {}, expectedCount = 0) {
        const rejected = Number(result.redCount) || 0;
        const processed = (Number(result.successCount) || 0)
            + (Number(result.yellowCount) || 0)
            + (Number(result.skipCount) || 0);
        if (rejected > 0 || processed !== expectedCount) {
            throw this.syncError(
                'mobile_source_persistence_incomplete',
                'local mobile source persistence was incomplete'
            );
        }
    }

    getStatus() {
        return {
            enabled: this.enabled,
            running: this.running,
            sourceNode: this.sourceNode,
            baseUrlConfigured: Boolean(this.baseUrl),
            tokenConfigured: Boolean(this.token),
            intervalMs: this.intervalMs,
            batchSize: this.batchSize,
            includeVerificationAgent: this.includeVerificationAgent,
            ...this.loadState(),
        };
    }

    loadState() {
        try {
            if (!fs.existsSync(this.statePath)) return { cursor: 0 };
            const value = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
            return value && typeof value === 'object' ? value : { cursor: 0 };
        } catch (error) {
            throw this.syncError('mobile_source_state_invalid', 'mobile source sync state is invalid');
        }
    }

    saveState(state) {
        const tempPath = `${this.statePath}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
        fs.renameSync(tempPath, this.statePath);
    }

    recordFailure(error) {
        let state;
        try {
            state = this.loadState();
        } catch (stateError) {
            state = { cursor: 0 };
        }
        this.saveState({
            ...state,
            sourceNode: this.sourceNode,
            lastAttemptAt: new Date().toISOString(),
            lastError: String(error?.message || error || 'unknown error').slice(0, 500),
        });
    }

    normalizeBaseUrl(value, allowHttp, allowedHosts) {
        const text = String(value || '').trim();
        if (!text) return '';
        let url;
        try {
            url = new URL(text);
        } catch (error) {
            throw this.syncError('mobile_source_url_invalid', 'MOBILE_SOURCE_BASE_URL is invalid');
        }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
            throw this.syncError('mobile_source_url_invalid', 'MOBILE_SOURCE_BASE_URL must be an HTTP(S) origin');
        }
        if (url.protocol === 'http:' && !allowHttp) {
            throw this.syncError('mobile_source_https_required', '47 source URL must use HTTPS');
        }
        const hosts = new Set((Array.isArray(allowedHosts) ? allowedHosts : String(allowedHosts || '').split(','))
            .map(item => String(item || '').trim().toLowerCase())
            .filter(Boolean));
        if (hosts.size > 0 && !hosts.has(url.hostname.toLowerCase())) {
            throw this.syncError('mobile_source_host_not_allowed', '47 source host is not allowlisted');
        }
        return url.toString().replace(/\/$/, '');
    }

    safeCursor(value) {
        const number = Number(value || 0);
        if (!Number.isSafeInteger(number) || number < 0) {
            throw this.syncError('mobile_source_cursor_invalid', 'source cursor is invalid');
        }
        return number;
    }

    boundedInt(value, min, max, fallback) {
        if (value === undefined || value === null || value === '') return fallback;
        const number = Number(value);
        if (!Number.isSafeInteger(number) || number < min || number > max) {
            throw this.syncError('mobile_source_config_invalid', `integer must be between ${min} and ${max}`);
        }
        return number;
    }

    syncError(code, message) {
        const error = new Error(message);
        error.code = code;
        error.statusCode = 400;
        return error;
    }
}

module.exports = { RemoteMobileSourceSync, parseBoolean };
