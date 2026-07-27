'use strict';

const crypto = require('node:crypto');
const { SOURCE_NODE } = require('./mysql-mobile-source-store');
const {
    findForbiddenFuelField,
    hasNestedField,
    normalizeFuelPrice,
} = require('./fuel-payload-policy');
const { normalizeIpAddress } = require('./mobile-source-agent-report-ip');

const SOURCE_AGENT_PATTERN = /^[a-z0-9][a-z0-9._-]{0,54}-agent$/;
const PLATFORM_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const FUEL_QUOTE_FEATURE = 'fuel-quote-v1';
const FUEL_QUOTE_CAPTURE_MODE = 'user-driven-ocr';
const DEFAULT_FUEL_QUOTE_PLATFORMS = Object.freeze(['tuanyou', 'amap-fuel']);
const BATCH_FIELDS = new Set([
    'schemaVersion', 'feature', 'stationType', 'sourceAgent',
    'platform', 'city', 'deviceId', 'deviceSessionId', 'sessionId',
    'pageIndex', 'sourceStage', 'stage', 'capturedAt', 'clientVersion',
    'appPackage', 'currentPackageName', 'currentClassName',
    'idempotencyKey', 'stations', 'observations',
]);
const FUEL_OBSERVATION_FIELDS = new Set([
    'stationId', 'station_id', 'sourceStationKey',
    'stationName', 'station_name', 'name',
    'platform', 'city', 'capturedAt', 'sourceStage', 'raw',
    'providerName', 'providerEvidence', 'fuelOffers', 'fuelQuotes',
]);
const V3_OBSERVATION_FIELDS = new Set([
    'schemaVersion', 'stationType', 'stationObservation',
    'chargingObservation', 'fuelObservation',
]);
const STATION_OBSERVATION_FIELDS = new Set([
    'stationId', 'station_id', 'sourceStationKey',
    'stationName', 'station_name', 'name',
    'address', 'addr',
    'availablePorts', 'busyPorts', 'totalPorts',
    'portSemantics', 'capturedAt', 'quality',
]);
const V3_CHARGING_FIELDS = new Set([
    'priceFast', 'priceSlow', 'priceSuper', 'priceService',
    'fastIdlePorts', 'fastTotalPorts',
    'slowIdlePorts', 'slowTotalPorts',
    'superIdlePorts', 'superTotalPorts',
    'capturedAt', 'sourceStage', 'raw',
]);
const QUALITY_FIELDS = new Set(['needsReview', 'missingFields', 'status']);
const QUALITY_STATUSES = new Set(['valid', 'incomplete', 'needs-review']);
const PORT_SEMANTICS = new Set(['charging-gun', 'generic-port']);
const MISSING_FIELD_NAMES = new Set([
    'address', 'availablePorts', 'busyPorts', 'totalPorts',
    'priceFast', 'priceSlow', 'priceSuper', 'priceService',
    'fuelOffers', 'fuelQuotes', 'providerName',
]);
const FUEL_OFFER_FIELDS = new Set([
    'fuelType', 'gradeCode', 'gradeLabel',
    'displayPrice', 'stationPrice', 'nationalPrice',
    'listPrice', 'discountPrice', 'unclassifiedPrice',
    'discountKind', 'currency', 'unit', 'fieldSource',
    'evidence', 'capturedAt',
]);
const FUEL_QUOTE_FIELDS = new Set([
    'quoteObservationId', 'quoteDedupKey', 'gradeCode', 'gradeLabel',
    'gunCode', 'gunLabel', 'selectedAmount', 'grossDiscount',
    'serviceFee', 'netDiscount', 'payableAmount', 'quoteEntry',
    'needsReview', 'capturedAt', 'raw',
]);
const PROVIDER_EVIDENCE_FIELDS = new Set([
    'kind', 'text', 'confidence', 'boundingBox',
]);
const OFFER_EVIDENCE_FIELDS = new Set([
    'kind', 'text', 'format', 'type', 'confidence', 'boundingBox',
]);
const BOUNDING_BOX_FIELDS = new Set(['x', 'y', 'width', 'height']);
const FIELD_SOURCE_FIELDS = new Set([
    'displayPrice', 'stationPrice', 'nationalPrice',
]);
const SENSITIVE_RAW_KEYS = new Set([
    'authorization', 'proxyauthorization', 'cookie', 'setcookie',
    'token', 'authtoken', 'bearertoken', 'accesstoken', 'refreshtoken',
    'idtoken', 'apikey', 'secret', 'clientsecret', 'appsecret',
    'password', 'passwd', 'passcode', 'pin', 'paymentpassword',
    'otp', 'smscode', 'verificationcode', 'captcha',
    'bankcard', 'bankcardno', 'cardnumber', 'cvv',
    'idcard', 'idcardno', 'openid', 'unionid',
    'orderid', 'orderno', 'tradeno', 'transactionid', 'paymentid',
    'sessionkey', 'privatekey', 'signature', 'sign', 'wsgsig',
]);
const SENSITIVE_RAW_KEY_PATTERNS = Object.freeze([
    /^(?:x)?api(?:key|token)$/,
    /^(?:auth|bearer|access|refresh|id|client|user|session)?token$/,
    /^(?:sms|email|phone)?(?:verification)?code$/,
    /^(?:payment)?(?:password|passwd|passcode|pin)$/,
    /^(?:bank)?card(?:id|no|number)?$/,
    /^(?:idcard|identitycard)(?:id|no|number)?$/,
    /^(?:payment)?(?:order|trade|transaction)(?:id|no|number)$/,
]);
const SENSITIVE_CONTENT_PATTERNS = Object.freeze([
    /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/i,
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
    /\b(?:authorization|cookie|set-cookie|token|access[_-]?token|refresh[_-]?token|api[_-]?key|password|passwd|otp|cvv)\b\s*[:=]\s*\S+/i,
    /(?:验证码|校验码|短信码|支付密码|银行卡号|卡号)\s*[:：=]?\s*[A-Za-z0-9*_-]{4,}/,
    /(?:订单|交易|支付)(?:号|编号|流水号|单号)\s*[:：=]?\s*[A-Za-z0-9_-]{4,}/,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /\b1[3-9]\d{9}\b/,
    /\b\d{17}[\dXx]\b/,
    /\b(?:\d[ -]?){12,19}\b/,
]);
const SENSITIVE_PUBLIC_TEXT_PATTERNS = Object.freeze([
    /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/i,
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
    /(?:手机号|手机号码|联系电话|身份证(?:号|号码)?|银行卡(?:号|号码)?|卡号|账号|账户|用户名|订单(?:号|编号|单号)?|交易(?:号|编号|流水号)?|支付(?:号|编号|流水号)?|验证码|校验码|短信码|密码|口令)\s*[:：=]?\s*[A-Za-z0-9*._-]{4,}/i,
    /\b1[3-9]\d{9}\b/,
    /\b\d{17}[\dXx]\b/,
    /\b(?:\d[ -]?){16,19}\b/,
]);

function sourceError(code, message, statusCode = 400) {
    const error = new Error(message);
    error.code = code;
    error.statusCode = statusCode;
    return error;
}

class MobileSourceNodeService {
    constructor(options = {}) {
        if (!options.store) throw new TypeError('mobile source store is required');
        this.store = options.store;
        this.sourceNode = options.sourceNode || SOURCE_NODE;
        this.maxStations = this.boundedInt(options.maxStations, 1, 1000, 500);
        this.maxStationRawBytes = this.boundedInt(options.maxStationRawBytes, 1024, 262144, 65536);
        this.maxQuoteRawBytes = this.boundedInt(options.maxQuoteRawBytes, 512, 65536, 16384);
        this.fuelQuoteV1Enabled = this.booleanOption(options.fuelQuoteV1Enabled, false);
        this.fuelQuotePlatforms = this.platformAllowlist(options.fuelQuotePlatforms);
    }

    async ingestStationPayload(payload = {}, transport = {}) {
        const batch = this.normalizeBatch(payload, transport);
        return this.store.ingest(batch);
    }

    async listStations(query = {}) {
        const afterId = this.boundedInt(query.afterId ?? query.after_id, 0, Number.MAX_SAFE_INTEGER, 0);
        const limit = this.boundedInt(query.limit, 1, 1000, 200);
        const records = await this.store.listAfter(afterId, limit);
        const nextCursor = records.length > 0
            ? records[records.length - 1].sourceRecordId
            : afterId;
        return {
            sourceNode: this.sourceNode,
            afterId,
            nextCursor,
            count: records.length,
            hasMore: records.length === limit,
            records,
        };
    }

    async health() {
        try {
            return {
                ok: await this.store.health(),
                role: 'mobile-ocr-mysql-source',
                sourceNode: this.sourceNode,
                capabilities: {
                    schemaVersion: 2,
                    latestSchemaVersion: 3,
                    supportedSchemaVersions: [1, 2, 3],
                    stationTypes: ['charging', 'fuel'],
                    observationEnvelope: true,
                    stationObservation: true,
                    features: this.featureCapabilities(),
                },
            };
        } catch (error) {
            return {
                ok: false,
                role: 'mobile-ocr-mysql-source',
                sourceNode: this.sourceNode,
                capabilities: {
                    schemaVersion: 2,
                    latestSchemaVersion: 3,
                    supportedSchemaVersions: [1, 2, 3],
                    stationTypes: ['charging', 'fuel'],
                    observationEnvelope: true,
                    stationObservation: true,
                    features: this.featureCapabilities(),
                },
            };
        }
    }

    normalizeBatch(payload, transport) {
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
            throw sourceError('mobile_source_payload_invalid', 'JSON object payload required');
        }
        this.assertKnownFields(payload, BATCH_FIELDS, 'payload');
        const bodyAgent = this.normalizeSourceAgent(payload.sourceAgent);
        const headerAgent = this.normalizeSourceAgent(transport.mobileAgent);
        if (bodyAgent && headerAgent && bodyAgent !== headerAgent) {
            throw sourceError('mobile_source_agent_mismatch', 'sourceAgent does not match X-Mobile-Agent');
        }
        const sourceAgent = headerAgent || bodyAgent;
        if (!sourceAgent) {
            throw sourceError('mobile_source_agent_required', 'sourceAgent is required');
        }

        const platform = this.requiredText(payload.platform, 'platform', 64).toLowerCase();
        if (!PLATFORM_PATTERN.test(platform)) {
            throw sourceError('mobile_source_platform_invalid', 'platform is invalid');
        }
        const city = this.requiredText(payload.city, 'city', 128);
        const sessionId = this.requiredText(payload.sessionId, 'sessionId', 128);
        const deviceSessionId = this.requiredText(
            payload.deviceSessionId,
            'deviceSessionId',
            128
        );
        const sourceStage = this.optionalText(payload.sourceStage || payload.stage, 64) || 'phone-user-scroll';
        const capturedAt = this.normalizeCapturedAt(payload.capturedAt);
        const schemaVersion = payload.schemaVersion === undefined || payload.schemaVersion === null
            ? 1
            : Number(payload.schemaVersion);
        if (!Number.isInteger(schemaVersion) || ![1, 2, 3].includes(schemaVersion)) {
            throw sourceError(
                'mobile_source_schema_version_invalid',
                'schemaVersion must be 1, 2 or 3'
            );
        }
        const observationEnvelope = schemaVersion >= 2;
        const feature = this.optionalText(payload.feature, 64);
        if (feature && feature !== FUEL_QUOTE_FEATURE) {
            throw sourceError('mobile_source_feature_invalid', 'unsupported mobile source feature');
        }
        if (!observationEnvelope && (Object.prototype.hasOwnProperty.call(payload, 'observations')
                || (payload.stationType !== undefined && payload.stationType !== 'charging')
                || feature)) {
            throw sourceError(
                'mobile_source_schema_version_invalid',
                'v1 only supports charging stations'
            );
        }
        if (observationEnvelope && Object.prototype.hasOwnProperty.call(payload, 'stations')) {
            throw sourceError(
                'mobile_source_observation_exclusive',
                'observation payload must use observations only'
            );
        }
        const rawStations = observationEnvelope
            ? (Array.isArray(payload.observations) ? payload.observations : [])
            : (Array.isArray(payload.stations) ? payload.stations : []);
        if (rawStations.length === 0 || rawStations.length > this.maxStations) {
            throw sourceError(
                'mobile_source_station_count_invalid',
                `${observationEnvelope ? 'observations' : 'stations'} must contain 1-${this.maxStations} records`
            );
        }
        const stations = rawStations.map((station, index) => observationEnvelope
            ? (schemaVersion === 3
                ? this.normalizeObservationV3(station, index, sourceStage, capturedAt, {
                    feature,
                    platform,
                    city,
                })
                : this.normalizeObservation(station, index, sourceStage, capturedAt, {
                feature,
                platform,
                city,
                }))
            : this.normalizeStation(station, index, sourceStage, capturedAt));
        const stationTypes = new Set(stations.map(station => station.stationType));
        if (stationTypes.size !== 1) {
            throw sourceError('mobile_source_station_type_mixed', 'one batch must contain one station type');
        }
        const stationType = [...stationTypes][0];
        if (observationEnvelope && payload.stationType !== stationType) {
            throw sourceError('mobile_source_station_type_mismatch', 'batch stationType does not match observations');
        }
        if (feature && stationType !== 'fuel') {
            throw sourceError('mobile_source_feature_invalid', 'fuel-quote-v1 only supports fuel observations');
        }
        const deviceId = this.optionalText(payload.deviceId, 128);
        const pageIndex = this.boundedInt(payload.pageIndex, 0, 10000000, 0);
        const clientVersion = this.optionalText(payload.clientVersion, 64);
        const idempotencySeed = this.buildIdempotencySeed(payload, transport, {
            sourceAgent,
            platform,
            city,
            sessionId,
            deviceSessionId,
            pageIndex,
            capturedAt,
            schemaVersion,
            feature,
            stationType,
            stations,
        });

        return {
            ingestId: crypto.randomUUID(),
            idempotencyKey: crypto.createHash('sha256').update(idempotencySeed, 'utf8').digest('hex'),
            sourceNode: this.sourceNode,
            sourceAgent,
            sourceStage,
            platform,
            city,
            deviceId,
            sessionId,
            pageIndex,
            clientVersion,
            capturedAt,
            schemaVersion,
            feature,
            stationType,
            stations,
            rawMeta: {
                deviceSessionId,
                appPackage: this.optionalText(payload.appPackage, 191),
                currentPackageName: this.optionalText(payload.currentPackageName, 191),
                currentClassName: this.optionalText(payload.currentClassName, 255),
                agentReportIp: normalizeIpAddress(transport.agentReportIp),
                remoteAddress: this.optionalText(transport.remoteAddress, 128),
                userAgent: this.optionalText(transport.userAgent, 255),
                feature,
            },
        };
    }

    normalizeStation(station, index, defaultStage, batchCapturedAt) {
        if (!station || typeof station !== 'object' || Array.isArray(station)) {
            throw sourceError('mobile_source_station_invalid', `stations[${index}] must be an object`);
        }
        const fastIdlePorts = this.boundedInt(station.fastIdlePorts, 0, 100000, 0);
        const fastTotalPorts = this.boundedInt(station.fastTotalPorts, 0, 100000, 0);
        const slowIdlePorts = this.boundedInt(station.slowIdlePorts, 0, 100000, 0);
        const slowTotalPorts = this.boundedInt(station.slowTotalPorts, 0, 100000, 0);
        const superIdlePorts = this.boundedInt(station.superIdlePorts, 0, 100000, 0);
        const superTotalPorts = this.boundedInt(station.superTotalPorts, 0, 100000, 0);
        this.assertPortPair(fastIdlePorts, fastTotalPorts, `stations[${index}].fast`);
        this.assertPortPair(slowIdlePorts, slowTotalPorts, `stations[${index}].slow`);
        this.assertPortPair(superIdlePorts, superTotalPorts, `stations[${index}].super`);

        const typedAvailable = fastIdlePorts + slowIdlePorts + superIdlePorts;
        const typedTotal = fastTotalPorts + slowTotalPorts + superTotalPorts;
        const availablePorts = station.availablePorts === undefined || station.availablePorts === null
            ? typedAvailable
            : this.boundedInt(station.availablePorts, 0, 100000, typedAvailable);
        const totalPorts = station.totalPorts === undefined || station.totalPorts === null
            ? typedTotal
            : this.boundedInt(station.totalPorts, 0, 100000, typedTotal);
        this.assertPortPair(availablePorts, totalPorts, `stations[${index}]`);

        return {
            stationType: 'charging',
            stationId: this.optionalText(station.stationId || station.station_id, 191),
            stationName: this.requiredText(
                station.stationName || station.station_name || station.name,
                `stations[${index}].stationName`,
                512
            ),
            address: this.optionalText(station.address || station.addr, 1024),
            latitude: this.nullableNumber(station.latitude ?? station.lat, -90, 90, `stations[${index}].latitude`),
            longitude: this.nullableNumber(station.longitude ?? station.lng ?? station.lon, -180, 180, `stations[${index}].longitude`),
            priceFast: this.nullableNumber(station.priceFast, 0, 20, `stations[${index}].priceFast`),
            priceSlow: this.nullableNumber(station.priceSlow, 0, 20, `stations[${index}].priceSlow`),
            priceSuper: this.nullableNumber(station.priceSuper, 0, 20, `stations[${index}].priceSuper`),
            priceService: this.nullableNumber(station.priceService, 0, 20, `stations[${index}].priceService`),
            availablePorts,
            totalPorts,
            fastIdlePorts,
            fastTotalPorts,
            slowIdlePorts,
            slowTotalPorts,
            superIdlePorts,
            superTotalPorts,
            capturedAt: station.capturedAt
                ? this.normalizeCapturedAt(station.capturedAt)
                : batchCapturedAt,
            sourceStage: this.optionalText(station.sourceStage, 64) || defaultStage,
            raw: this.normalizeRaw(station.raw, index),
        };
    }

    normalizeObservation(observation, index, defaultStage, batchCapturedAt, context) {
        if (!observation || typeof observation !== 'object' || Array.isArray(observation)) {
            throw sourceError('mobile_source_observation_invalid', `observations[${index}] must be an object`);
        }
        if (Number(observation.schemaVersion) !== 2) {
            throw sourceError('mobile_source_schema_version_invalid', `observations[${index}].schemaVersion must be 2`);
        }
        if (String(observation.stationType || '').trim() === 'fuel') {
            const forbiddenPath = findForbiddenFuelField(observation);
            if (forbiddenPath) {
                throw sourceError(
                    'mobile_source_fuel_field_forbidden',
                    `observations[${index}] contains charging/address fields`
                );
            }
        }
        this.assertKnownFields(
            observation,
            new Set(['schemaVersion', 'feature', 'stationType', 'chargingObservation', 'fuelObservation']),
            `observations[${index}]`
        );
        const observationFeature = this.optionalText(observation.feature, 64);
        if (observationFeature && observationFeature !== FUEL_QUOTE_FEATURE) {
            throw sourceError('mobile_source_feature_invalid', `observations[${index}].feature is invalid`);
        }
        if (context.feature && observationFeature && context.feature !== observationFeature) {
            throw sourceError('mobile_source_feature_invalid', `observations[${index}].feature does not match batch feature`);
        }
        const feature = observationFeature || context.feature;
        const type = String(observation.stationType || '').trim();
        const charging = this.plainObject(observation.chargingObservation);
        const fuel = this.plainObject(observation.fuelObservation);
        if ((charging && fuel) || (!charging && !fuel)
            || (type === 'charging' && !charging) || (type === 'fuel' && !fuel)
            || !['charging', 'fuel'].includes(type)) {
            throw sourceError(
                'mobile_source_observation_exclusive',
                `observations[${index}] must contain exactly one matching observation`
            );
        }
        if (type === 'charging') {
            if (feature) {
                throw sourceError('mobile_source_feature_invalid', 'fuel-quote-v1 cannot be used by charging observations');
            }
            if (hasNestedField(charging, 'fuelOffers')) {
                throw sourceError('mobile_source_observation_invalid', 'charging observation contains fuel fields');
            }
            return this.normalizeStation(charging, index, defaultStage, batchCapturedAt);
        }
        const forbiddenPath = findForbiddenFuelField(observation);
        if (forbiddenPath) {
            throw sourceError(
                'mobile_source_fuel_field_forbidden',
                `observations[${index}] contains charging/address fields`
            );
        }
        return this.normalizeFuelObservation(fuel, index, defaultStage, batchCapturedAt, {
            ...context,
            feature,
        });
    }

    normalizeObservationV3(observation, index, defaultStage, batchCapturedAt, context) {
        const prefix = `observations[${index}]`;
        if (!this.plainObject(observation)) {
            throw sourceError('mobile_source_observation_invalid', `${prefix} must be an object`);
        }
        if (Number(observation.schemaVersion) !== 3) {
            throw sourceError(
                'mobile_source_schema_version_invalid',
                `${prefix}.schemaVersion must be 3`
            );
        }
        this.assertKnownFields(observation, V3_OBSERVATION_FIELDS, prefix);
        const type = String(observation.stationType || '').trim();
        const common = this.plainObject(observation.stationObservation);
        const charging = this.plainObject(observation.chargingObservation);
        const fuel = this.plainObject(observation.fuelObservation);
        if (!common
                || (charging && fuel)
                || (!charging && !fuel)
                || (type === 'charging' && !charging)
                || (type === 'fuel' && !fuel)
                || !['charging', 'fuel'].includes(type)) {
            throw sourceError(
                'mobile_source_observation_exclusive',
                `${prefix} requires stationObservation and exactly one matching type observation`
            );
        }

        const stationObservation = this.normalizeStationObservation(
            common,
            index,
            type,
            batchCapturedAt
        );
        if (type === 'charging') {
            if (context.feature) {
                throw sourceError(
                    'mobile_source_feature_invalid',
                    'fuel-quote-v1 cannot be used by charging observations'
                );
            }
            return this.normalizeChargingObservationV3(
                charging,
                stationObservation,
                index,
                defaultStage,
                batchCapturedAt
            );
        }

        const forbiddenPath = findForbiddenFuelField(fuel);
        if (forbiddenPath) {
            throw sourceError(
                'mobile_source_fuel_field_forbidden',
                `${prefix}.fuelObservation contains charging/address fields`
            );
        }
        // 燃油 common 信封不得携带充电专属的 ports/枪数据字段（address 允许）。
        for (const portsField of ['availablePorts', 'busyPorts', 'totalPorts', 'portSemantics']) {
            if (hasNestedField(common, portsField)) {
                throw sourceError(
                    'mobile_source_fuel_field_forbidden',
                    `${prefix}.stationObservation must not contain ${portsField}`
                );
            }
        }
        const normalizedFuel = this.normalizeFuelObservation(
            {
                ...fuel,
                stationId: fuel.stationId || fuel.station_id
                    || stationObservation.stationId
                    || stationObservation.sourceStationKey,
                sourceStationKey: fuel.sourceStationKey
                    || stationObservation.sourceStationKey
                    || stationObservation.stationId,
                stationName: fuel.stationName || fuel.station_name || fuel.name
                    || stationObservation.stationName,
                capturedAt: fuel.capturedAt || stationObservation.capturedAt,
            },
            index,
            defaultStage,
            batchCapturedAt,
            context
        );
        const commonIdentity = stationObservation.stationId
            || stationObservation.sourceStationKey;
        const fuelIdentity = normalizedFuel.stationId
            || normalizedFuel.sourceStationKey;
        if (commonIdentity && fuelIdentity && commonIdentity !== fuelIdentity) {
            throw sourceError(
                'mobile_source_station_identity_mismatch',
                `${prefix} common and fuel station identities must match`
            );
        }
        return {
            ...normalizedFuel,
            stationId: stationObservation.stationId || normalizedFuel.stationId,
            sourceStationKey: stationObservation.sourceStationKey
                || normalizedFuel.sourceStationKey,
            stationName: stationObservation.stationName,
            address: stationObservation.address,
            // 燃油侧无枪数据：normalizeStationObservation 对燃油已返回 null。
            availablePorts: stationObservation.availablePorts,
            busyPorts: stationObservation.busyPorts,
            totalPorts: stationObservation.totalPorts,
            portSemantics: stationObservation.portSemantics,
            missingFields: stationObservation.missingFields,
            qualityStatus: stationObservation.qualityStatus,
            needsReview: stationObservation.needsReview,
            capturedAt: stationObservation.capturedAt,
        };
    }

    normalizeStationObservation(common, index, stationType, batchCapturedAt) {
        const prefix = `observations[${index}].stationObservation`;
        this.assertKnownFields(common, STATION_OBSERVATION_FIELDS, prefix);
        const isFuel = stationType === 'fuel';

        const quality = this.normalizeObservationQuality(common.quality, prefix);
        const missing = new Set(quality.missingFields);
        const address = this.optionalText(common.address || common.addr, 1024);
        const stationName = this.requiredText(
            common.stationName || common.station_name || common.name,
            `${prefix}.stationName`,
            512
        );
        this.assertNoSensitivePublicText(stationName, `${prefix}.stationName`);
        if (address) this.assertNoSensitivePublicText(address, `${prefix}.address`);
        if (!address) missing.add('address');

        // 燃油侧无枪数据：ports 一律 null，不做 ports 校验，portSemantics 置 null。
        if (isFuel) {
            const incomplete = quality.needsReview || missing.size > 0;
            const qualityStatus = incomplete
                ? (quality.status === 'needs-review' ? 'needs-review' : 'incomplete')
                : (quality.status || 'valid');
            const stationId = this.optionalText(common.stationId || common.station_id, 191);
            const sourceStationKey = this.optionalText(common.sourceStationKey, 191);
            if (stationId && sourceStationKey && stationId !== sourceStationKey) {
                throw sourceError(
                    'mobile_source_station_identity_mismatch',
                    `${prefix}.stationId and sourceStationKey must identify the same source station`
                );
            }
            return {
                stationId,
                sourceStationKey,
                stationName,
                address,
                availablePorts: null,
                busyPorts: null,
                totalPorts: null,
                portSemantics: null,
                missingFields: [...missing].sort(),
                qualityStatus,
                needsReview: quality.needsReview || qualityStatus !== 'valid',
                capturedAt: common.capturedAt
                    ? this.normalizeCapturedAt(common.capturedAt)
                    : batchCapturedAt,
            };
        }

        const available = this.nullableInteger(
            common.availablePorts,
            0,
            100000,
            `${prefix}.availablePorts`
        );
        const suppliedBusy = this.nullableInteger(
            common.busyPorts,
            0,
            100000,
            `${prefix}.busyPorts`
        );
        const suppliedTotal = this.nullableInteger(
            common.totalPorts,
            0,
            100000,
            `${prefix}.totalPorts`
        );
        let busy = suppliedBusy;
        let total = suppliedTotal;
        let normalizedAvailable = available;
        if (normalizedAvailable !== null && total !== null && busy === null) {
            if (normalizedAvailable > total) {
                throw sourceError(
                    'mobile_source_ports_invalid',
                    `${prefix} available ports exceed total ports`
                );
            }
            busy = total - normalizedAvailable;
        } else if (normalizedAvailable !== null && busy !== null && total === null) {
            total = normalizedAvailable + busy;
        } else if (normalizedAvailable === null && busy !== null && total !== null) {
            if (busy > total) {
                throw sourceError(
                    'mobile_source_ports_invalid',
                    `${prefix} busy ports exceed total ports`
                );
            }
            normalizedAvailable = total - busy;
        }
        if (normalizedAvailable !== null && busy !== null && total !== null
                && normalizedAvailable + busy !== total) {
            throw sourceError(
                'mobile_source_ports_invalid',
                `${prefix} available and busy ports must equal total ports`
            );
        }

        if (normalizedAvailable === null) missing.add('availablePorts');
        if (busy === null) missing.add('busyPorts');
        if (total === null) missing.add('totalPorts');
        const portSemantics = this.optionalText(common.portSemantics, 32)
            || 'charging-gun';
        if (!PORT_SEMANTICS.has(portSemantics)) {
            throw sourceError(
                'mobile_source_port_semantics_invalid',
                `${prefix}.portSemantics is invalid`
            );
        }
        const incomplete = quality.needsReview || missing.size > 0;
        const qualityStatus = incomplete
            ? (quality.status === 'needs-review' ? 'needs-review' : 'incomplete')
            : (quality.status || 'valid');
        const stationId = this.optionalText(common.stationId || common.station_id, 191);
        const sourceStationKey = this.optionalText(common.sourceStationKey, 191);
        if (stationId && sourceStationKey && stationId !== sourceStationKey) {
            throw sourceError(
                'mobile_source_station_identity_mismatch',
                `${prefix}.stationId and sourceStationKey must identify the same source station`
            );
        }
        return {
            stationId,
            sourceStationKey,
            stationName,
            address,
            availablePorts: normalizedAvailable,
            busyPorts: busy,
            totalPorts: total,
            portSemantics,
            missingFields: [...missing].sort(),
            qualityStatus,
            needsReview: quality.needsReview || qualityStatus !== 'valid',
            capturedAt: common.capturedAt
                ? this.normalizeCapturedAt(common.capturedAt)
                : batchCapturedAt,
        };
    }

    normalizeObservationQuality(value, field) {
        if (value === null || value === undefined) {
            return { needsReview: false, missingFields: [], status: null };
        }
        if (!this.plainObject(value)) {
            throw sourceError('mobile_source_quality_invalid', `${field}.quality must be an object`);
        }
        this.assertKnownFields(value, QUALITY_FIELDS, `${field}.quality`);
        const needsReview = value.needsReview === undefined
            ? false
            : this.optionalBoolean(value.needsReview, `${field}.quality.needsReview`);
        const rawMissing = value.missingFields === undefined ? [] : value.missingFields;
        if (!Array.isArray(rawMissing) || rawMissing.length > 32) {
            throw sourceError(
                'mobile_source_quality_invalid',
                `${field}.quality.missingFields is invalid`
            );
        }
        const missingFields = [];
        for (const [index, item] of rawMissing.entries()) {
            const name = this.requiredText(
                item,
                `${field}.quality.missingFields[${index}]`,
                64
            );
            if (!MISSING_FIELD_NAMES.has(name)) {
                throw sourceError(
                    'mobile_source_quality_invalid',
                    `${field}.quality.missingFields contains an unsupported field`
                );
            }
            if (!missingFields.includes(name)) missingFields.push(name);
        }
        const status = this.optionalText(value.status, 32);
        if (status && !QUALITY_STATUSES.has(status)) {
            throw sourceError(
                'mobile_source_quality_invalid',
                `${field}.quality.status is invalid`
            );
        }
        return { needsReview: Boolean(needsReview), missingFields, status };
    }

    normalizeChargingObservationV3(
        charging,
        stationObservation,
        index,
        defaultStage,
        batchCapturedAt
    ) {
        const prefix = `observations[${index}].chargingObservation`;
        this.assertKnownFields(charging, V3_CHARGING_FIELDS, prefix);
        if (hasNestedField(charging, 'fuelOffers')) {
            throw sourceError(
                'mobile_source_observation_invalid',
                `${prefix} contains fuel fields`
            );
        }
        const typed = {};
        for (const key of [
            'fastIdlePorts', 'fastTotalPorts',
            'slowIdlePorts', 'slowTotalPorts',
            'superIdlePorts', 'superTotalPorts',
        ]) {
            typed[key] = this.nullableInteger(charging[key], 0, 100000, `${prefix}.${key}`);
        }
        for (const kind of ['fast', 'slow', 'super']) {
            const idle = typed[`${kind}IdlePorts`];
            const total = typed[`${kind}TotalPorts`];
            if (idle !== null && total !== null) this.assertPortPair(idle, total, `${prefix}.${kind}`);
        }
        const missing = new Set(stationObservation.missingFields);
        const prices = {};
        for (const key of ['priceFast', 'priceSlow', 'priceSuper', 'priceService']) {
            prices[key] = this.nullableNumber(charging[key], 0, 20, `${prefix}.${key}`);
            if (prices[key] === null) missing.add(key);
        }
        const raw = this.normalizeBoundedRaw(
            charging.raw,
            this.maxStationRawBytes,
            `${prefix}.raw`
        );
        const qualityStatus = missing.size > 0
            ? (stationObservation.qualityStatus === 'needs-review'
                ? 'needs-review'
                : 'incomplete')
            : stationObservation.qualityStatus;
        return {
            stationType: 'charging',
            stationId: stationObservation.stationId,
            sourceStationKey: stationObservation.sourceStationKey
                || stationObservation.stationId,
            stationName: stationObservation.stationName,
            address: stationObservation.address,
            latitude: null,
            longitude: null,
            ...prices,
            availablePorts: stationObservation.availablePorts,
            busyPorts: stationObservation.busyPorts,
            totalPorts: stationObservation.totalPorts,
            fastIdlePorts: typed.fastIdlePorts,
            fastTotalPorts: typed.fastTotalPorts,
            slowIdlePorts: typed.slowIdlePorts,
            slowTotalPorts: typed.slowTotalPorts,
            superIdlePorts: typed.superIdlePorts,
            superTotalPorts: typed.superTotalPorts,
            portSemantics: stationObservation.portSemantics,
            missingFields: [...missing].sort(),
            qualityStatus,
            needsReview: stationObservation.needsReview || qualityStatus !== 'valid',
            capturedAt: charging.capturedAt
                ? this.normalizeCapturedAt(charging.capturedAt)
                : stationObservation.capturedAt || batchCapturedAt,
            sourceStage: this.optionalText(charging.sourceStage, 64) || defaultStage,
            raw,
        };
    }

    normalizeFuelObservation(fuel, index, defaultStage, batchCapturedAt, context) {
        const prefix = `observations[${index}].fuelObservation`;
        this.assertKnownFields(fuel, FUEL_OBSERVATION_FIELDS, prefix);
        this.assertMatchingContext(fuel, context, prefix);
        const hasExtendedOffer = Array.isArray(fuel.fuelOffers)
            && fuel.fuelOffers.some(offer => (
                this.plainObject(offer)
                && ['displayPrice', 'stationPrice', 'nationalPrice']
                    .some(field => offer[field] !== undefined
                        && offer[field] !== null
                        && String(offer[field]).trim() !== '')
            ));
        const hasProviderAttribution = (
            fuel.providerName !== undefined
            && fuel.providerName !== null
            && String(fuel.providerName).trim() !== ''
        ) || (fuel.providerEvidence !== undefined && fuel.providerEvidence !== null);
        const hasQuotes = Array.isArray(fuel.fuelQuotes) && fuel.fuelQuotes.length > 0;
        const usesFeature = context.feature === FUEL_QUOTE_FEATURE
            || hasProviderAttribution
            || hasQuotes
            || hasExtendedOffer;
        if (usesFeature) this.assertFuelQuoteFeature(context, prefix);
        const rawQuotes = fuel.fuelQuotes === undefined || fuel.fuelQuotes === null
            ? []
            : fuel.fuelQuotes;
        if (!Array.isArray(rawQuotes) || rawQuotes.length > 128) {
            throw sourceError('mobile_source_fuel_quotes_invalid', `${prefix}.fuelQuotes is invalid`);
        }
        const fuelQuotes = rawQuotes.map((quote, quoteIndex) => this.normalizeFuelQuote(
            quote,
            index,
            quoteIndex
        ));
        const rawOffers = fuel.fuelOffers === undefined || fuel.fuelOffers === null
            ? []
            : fuel.fuelOffers;
        const maxOffers = usesFeature ? 8 : 32;
        if (!Array.isArray(rawOffers)
                || rawOffers.length > maxOffers
                || (rawOffers.length === 0 && fuelQuotes.length === 0)) {
            throw sourceError('mobile_source_fuel_offers_invalid', `${prefix}.fuelOffers is invalid`);
        }
        const fuelOffers = rawOffers.map((offer, offerIndex) => (
            this.normalizeFuelOffer(offer, index, offerIndex, fuel.capturedAt || batchCapturedAt)
        ));
        const providerName = this.optionalText(fuel.providerName, 128);
        const providerEvidence = this.normalizeProviderEvidence(
            fuel.providerEvidence,
            `${prefix}.providerEvidence`
        );
        if (providerName && !providerEvidence) {
            throw sourceError(
                'mobile_source_provider_evidence_required',
                `${prefix}.providerEvidence is required when providerName is present`
            );
        }
        const raw = this.normalizeRaw(fuel.raw, index);
        if (hasNestedField(raw, 'providerEvidence')) {
            throw sourceError(
                'mobile_source_field_duplicate',
                `${prefix}.raw providerEvidence must use the typed providerEvidence field`
            );
        }
        const rawFuelObservation = this.plainObject(raw.fuelObservation) || {};
        const rawWithEvidence = providerEvidence
            ? {
                ...raw,
                fuelObservation: {
                    ...rawFuelObservation,
                    providerEvidence,
                },
            }
            : raw;
        this.assertRawBytes(rawWithEvidence, this.maxStationRawBytes, `stations[${index}].raw`);
        const stationId = this.optionalText(fuel.stationId || fuel.station_id, 191);
        const sourceStationKey = this.optionalText(fuel.sourceStationKey, 191);
        if (usesFeature && !sourceStationKey) {
            throw sourceError(
                'mobile_source_field_required',
                `${prefix}.sourceStationKey is required for fuel-quote-v1`
            );
        }
        if (stationId && sourceStationKey && stationId !== sourceStationKey) {
            throw sourceError(
                'mobile_source_station_identity_mismatch',
                `${prefix}.stationId and sourceStationKey must identify the same source station`
            );
        }
        this.assertQuoteDedupKeys({
            platform: context.platform,
            sourceStationKey,
            providerName,
            fuelOffers,
            fuelQuotes,
            prefix,
        });
        return {
            stationType: 'fuel',
            stationId: stationId || sourceStationKey,
            sourceStationKey: sourceStationKey || stationId,
            stationName: this.requiredText(
                fuel.stationName || fuel.station_name || fuel.name,
                `${prefix}.stationName`,
                512
            ),
            providerName,
            providerEvidence,
            address: null,
            latitude: null,
            longitude: null,
            priceFast: null,
            priceSlow: null,
            priceSuper: null,
            priceService: null,
            availablePorts: 0,
            totalPorts: 0,
            fastIdlePorts: 0,
            fastTotalPorts: 0,
            slowIdlePorts: 0,
            slowTotalPorts: 0,
            superIdlePorts: 0,
            superTotalPorts: 0,
            fuelOffers,
            fuelQuotes,
            capturedAt: fuel.capturedAt
                ? this.normalizeCapturedAt(fuel.capturedAt)
                : batchCapturedAt,
            sourceStage: this.optionalText(fuel.sourceStage, 64) || defaultStage,
            raw: rawWithEvidence,
        };
    }

    normalizeFuelOffer(offer, stationIndex, offerIndex, defaultCapturedAt) {
        if (!this.plainObject(offer)) {
            throw sourceError(
                'mobile_source_fuel_offer_invalid',
                `observations[${stationIndex}].fuelOffers[${offerIndex}] must be an object`
            );
        }
        const prefix = `observations[${stationIndex}].fuelOffers[${offerIndex}]`;
        this.assertKnownFields(offer, FUEL_OFFER_FIELDS, prefix);
        const displayPrice = this.fuelPrice(offer.displayPrice, `${prefix}.displayPrice`);
        const stationPrice = this.fuelPrice(offer.stationPrice, `${prefix}.stationPrice`);
        const nationalPrice = this.fuelPrice(offer.nationalPrice, `${prefix}.nationalPrice`);
        const listPrice = this.fuelPrice(offer.listPrice, `${prefix}.listPrice`);
        const discountPrice = this.fuelPrice(offer.discountPrice, `${prefix}.discountPrice`);
        const unclassifiedPrice = this.fuelPrice(
            offer.unclassifiedPrice,
            `${prefix}.unclassifiedPrice`
        );
        if ([displayPrice, stationPrice, nationalPrice, listPrice, discountPrice, unclassifiedPrice]
            .every(value => value === null)) {
            throw sourceError('mobile_source_fuel_offer_invalid', `${prefix} requires a price`);
        }
        if (listPrice !== null && discountPrice !== null && discountPrice > listPrice) {
            throw sourceError('mobile_source_fuel_offer_invalid', `${prefix}.discountPrice exceeds listPrice`);
        }
        if (offer.currency !== 'CNY' || offer.unit !== 'CNY_PER_LITER') {
            throw sourceError('mobile_source_fuel_offer_invalid', `${prefix} currency/unit is invalid`);
        }
        const evidence = this.normalizeEvidenceRows(offer.evidence, `${prefix}.evidence`);
        const fieldSource = this.normalizeFieldSource(offer.fieldSource, prefix, {
            displayPrice,
            stationPrice,
            nationalPrice,
        });
        return {
            fuelType: this.requiredText(offer.fuelType, `${prefix}.fuelType`, 32),
            gradeCode: this.requiredText(offer.gradeCode, `${prefix}.gradeCode`, 32),
            gradeLabel: this.requiredText(offer.gradeLabel, `${prefix}.gradeLabel`, 64),
            displayPrice,
            stationPrice,
            nationalPrice,
            listPrice,
            discountPrice,
            unclassifiedPrice,
            discountKind: this.optionalText(offer.discountKind, 32) || 'none',
            currency: 'CNY',
            unit: 'CNY_PER_LITER',
            fieldSource,
            evidence,
            capturedAt: offer.capturedAt
                ? this.normalizeCapturedAt(offer.capturedAt)
                : this.normalizeCapturedAt(defaultCapturedAt),
        };
    }

    normalizeFuelQuote(quote, stationIndex, quoteIndex) {
        const prefix = `observations[${stationIndex}].fuelQuotes[${quoteIndex}]`;
        if (!this.plainObject(quote)) {
            throw sourceError('mobile_source_fuel_quote_invalid', `${prefix} must be an object`);
        }
        this.assertKnownFields(quote, FUEL_QUOTE_FIELDS, prefix);
        const quoteObservationId = this.requiredText(
            quote.quoteObservationId,
            `${prefix}.quoteObservationId`,
            128
        );
        if (!/^[A-Za-z0-9._:-]{8,128}$/.test(quoteObservationId)) {
            throw sourceError('mobile_source_fuel_quote_invalid', `${prefix}.quoteObservationId is invalid`);
        }
        const quoteDedupKey = this.requiredText(quote.quoteDedupKey, `${prefix}.quoteDedupKey`, 64)
            .toLowerCase();
        if (!/^[a-f0-9]{64}$/.test(quoteDedupKey)) {
            throw sourceError('mobile_source_fuel_quote_invalid', `${prefix}.quoteDedupKey is invalid`);
        }
        const selectedAmount = this.money(quote.selectedAmount, `${prefix}.selectedAmount`, false);
        const grossDiscount = this.money(quote.grossDiscount, `${prefix}.grossDiscount`, true);
        const serviceFee = this.money(quote.serviceFee, `${prefix}.serviceFee`, true);
        let netDiscount = this.money(quote.netDiscount, `${prefix}.netDiscount`, true);
        const payableAmount = this.money(quote.payableAmount, `${prefix}.payableAmount`, true);
        const quoteEntry = this.requiredText(quote.quoteEntry, `${prefix}.quoteEntry`, 32);
        if (!['inline', 'explanation_popup'].includes(quoteEntry)) {
            throw sourceError('mobile_source_fuel_quote_invalid', `${prefix}.quoteEntry is invalid`);
        }
        if (grossDiscount !== null && serviceFee !== null
                && this.moneyMinor(serviceFee) > this.moneyMinor(grossDiscount)) {
            throw sourceError('mobile_source_fuel_quote_invalid', `${prefix}.serviceFee exceeds grossDiscount`);
        }
        let needsReview = this.optionalBoolean(quote.needsReview, `${prefix}.needsReview`) || false;
        if (grossDiscount === null && serviceFee === null && payableAmount === null) {
            throw sourceError(
                'mobile_source_fuel_quote_invalid',
                `${prefix} requires an observed discount, service fee or payable amount`
            );
        }
        if (grossDiscount !== null && serviceFee !== null) {
            const expectedNetMinor = this.moneyMinor(grossDiscount) - this.moneyMinor(serviceFee);
            if (netDiscount === null) {
                netDiscount = this.moneyFromMinor(expectedNetMinor);
            } else if (Math.abs(this.moneyMinor(netDiscount) - expectedNetMinor) > 1) {
                needsReview = true;
            }
            if (payableAmount !== null) {
                const expectedPayableMinor = this.moneyMinor(selectedAmount) - expectedNetMinor;
                if (expectedPayableMinor < 0
                        || Math.abs(this.moneyMinor(payableAmount) - expectedPayableMinor) > 1) {
                    needsReview = true;
                }
            } else {
                needsReview = true;
            }
        } else {
            needsReview = true;
        }
        const raw = this.normalizeBoundedRaw(
            quote.raw,
            this.maxQuoteRawBytes,
            `${prefix}.raw`
        );
        return {
            quoteObservationId,
            quoteDedupKey,
            gradeCode: this.requiredText(quote.gradeCode, `${prefix}.gradeCode`, 32),
            gradeLabel: this.requiredText(quote.gradeLabel, `${prefix}.gradeLabel`, 64),
            gunCode: this.optionalText(quote.gunCode, 32),
            gunLabel: this.optionalText(quote.gunLabel, 64),
            selectedAmount,
            grossDiscount,
            serviceFee,
            netDiscount,
            payableAmount,
            quoteEntry,
            needsReview,
            capturedAt: this.normalizeCapturedAt(
                this.requiredText(quote.capturedAt, `${prefix}.capturedAt`, 64)
            ),
            raw,
        };
    }

    assertQuoteDedupKeys({
        platform,
        sourceStationKey,
        providerName,
        fuelOffers,
        fuelQuotes,
        prefix,
    }) {
        for (const [index, quote] of fuelQuotes.entries()) {
            const offer = fuelOffers.find(item => item.gradeCode === quote.gradeCode);
            const price = value => value === null || value === undefined
                ? ''
                : Number(value).toFixed(4);
            const minor = value => value === null || value === undefined
                ? ''
                : String(this.moneyMinor(value));
            const seed = [
                '2',
                platform,
                sourceStationKey,
                quote.gradeCode,
                quote.gunCode || '',
                minor(quote.selectedAmount),
                quote.capturedAt.toISOString(),
                price(offer?.displayPrice),
                price(offer?.stationPrice),
                price(offer?.nationalPrice),
                minor(quote.grossDiscount),
                minor(quote.serviceFee),
                minor(quote.payableAmount),
                providerName || '',
            ].join('|');
            const expected = crypto.createHash('sha256').update(seed, 'utf8').digest('hex');
            if (quote.quoteDedupKey !== expected) {
                throw sourceError(
                    'mobile_source_quote_dedup_mismatch',
                    `${prefix}.fuelQuotes[${index}].quoteDedupKey does not match normalized quote fields`
                );
            }
        }
    }

    buildIdempotencySeed(payload, transport, normalized) {
        const supplied = this.requiredText(
            transport.idempotencyKey || payload.idempotencyKey,
            'Idempotency-Key',
            256
        );
        const scope = [
            normalized.sourceAgent,
            normalized.deviceSessionId,
            normalized.platform,
            normalized.city,
        ];
        if (normalized.schemaVersion >= 2) scope.push(normalized.stationType);
        scope.push(supplied);
        return scope.join('|');
    }

    normalizeSourceAgent(value) {
        const normalized = this.optionalText(value, 64)?.toLowerCase() || null;
        if (normalized && !SOURCE_AGENT_PATTERN.test(normalized)) {
            throw sourceError('mobile_source_agent_invalid', 'sourceAgent is invalid');
        }
        return normalized;
    }

    normalizeCapturedAt(value) {
        const date = value ? new Date(value) : new Date();
        if (Number.isNaN(date.getTime())) {
            throw sourceError('mobile_source_captured_at_invalid', 'capturedAt is invalid');
        }
        const now = Date.now();
        if (date.getTime() > now + 24 * 60 * 60 * 1000) {
            throw sourceError('mobile_source_captured_at_invalid', 'capturedAt is too far in the future');
        }
        return date;
    }

    normalizeRaw(value, index) {
        return this.normalizeBoundedRaw(
            value,
            this.maxStationRawBytes,
            `stations[${index}].raw`
        );
    }

    normalizeBoundedRaw(value, maxBytes, field) {
        const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
        this.assertRawBytes(raw, maxBytes, field);
        this.assertNoSensitiveData(raw, field);
        return raw;
    }

    assertRawBytes(value, maxBytes, field) {
        if (Buffer.byteLength(JSON.stringify(value), 'utf8') > maxBytes) {
            throw sourceError(
                'mobile_source_raw_too_large',
                `${field} exceeds ${maxBytes} bytes`,
                413
            );
        }
    }

    normalizeProviderEvidence(value, field) {
        if (value === null || value === undefined) return null;
        if (!this.plainObject(value)) {
            throw sourceError('mobile_source_provider_evidence_invalid', `${field} must be an object`);
        }
        this.assertNoSensitiveData(value, field);
        this.assertKnownFields(value, PROVIDER_EVIDENCE_FIELDS, field);
        const kind = this.optionalText(value.kind, 64) || 'provider-attribution';
        if (kind !== 'provider-attribution') {
            throw sourceError('mobile_source_provider_evidence_invalid', `${field}.kind is invalid`);
        }
        return {
            kind,
            text: this.requiredText(value.text, `${field}.text`, 256),
            confidence: value.confidence === undefined || value.confidence === null
                ? null
                : this.nullableNumber(value.confidence, 0, 1, `${field}.confidence`),
            boundingBox: this.normalizeBoundingBox(value.boundingBox, `${field}.boundingBox`),
        };
    }

    normalizeBoundingBox(value, field) {
        if (value === null || value === undefined) return null;
        if (!this.plainObject(value)) {
            throw sourceError('mobile_source_evidence_invalid', `${field} must be an object`);
        }
        this.assertKnownFields(value, BOUNDING_BOX_FIELDS, field);
        const box = {};
        for (const key of BOUNDING_BOX_FIELDS) {
            box[key] = this.nullableNumber(value[key], 0, 1, `${field}.${key}`);
            if (box[key] === null) {
                throw sourceError('mobile_source_evidence_invalid', `${field}.${key} is required`);
            }
        }
        if (box.x + box.width > 1.000001 || box.y + box.height > 1.000001) {
            throw sourceError('mobile_source_evidence_invalid', `${field} exceeds normalized bounds`);
        }
        return box;
    }

    normalizeEvidenceRows(value, field) {
        if (value === null || value === undefined) return [];
        if (!Array.isArray(value) || value.length > 8
                || value.some(item => !this.plainObject(item))) {
            throw sourceError('mobile_source_evidence_invalid', `${field} is invalid`);
        }
        this.assertRawBytes({ rows: value }, 16384, field);
        this.assertNoSensitiveData(value, field);
        return value.map((item, index) => {
            const prefix = `${field}[${index}]`;
            this.assertKnownFields(item, OFFER_EVIDENCE_FIELDS, prefix);
            const normalized = {};
            for (const key of ['kind', 'format', 'type']) {
                const text = this.optionalText(item[key], 64);
                if (text) normalized[key] = text;
            }
            const text = this.optionalText(item.text, 256);
            if (text) normalized.text = text;
            if (item.confidence !== undefined && item.confidence !== null) {
                normalized.confidence = this.nullableNumber(
                    item.confidence,
                    0,
                    1,
                    `${prefix}.confidence`
                );
            }
            if (item.boundingBox !== undefined && item.boundingBox !== null) {
                normalized.boundingBox = this.normalizeBoundingBox(
                    item.boundingBox,
                    `${prefix}.boundingBox`
                );
            }
            if (!normalized.kind && !normalized.text && !normalized.format && !normalized.type) {
                throw sourceError(
                    'mobile_source_evidence_invalid',
                    `${prefix} requires bounded evidence metadata`
                );
            }
            return normalized;
        });
    }

    assertNoSensitiveData(value, field, depth = 0, seen = new WeakSet()) {
        if (value === null || value === undefined) return;
        if (depth > 12) {
            throw sourceError(
                'mobile_source_raw_invalid',
                `${field} exceeds the supported nesting depth`
            );
        }
        if (typeof value === 'string') {
            if (SENSITIVE_CONTENT_PATTERNS.some(pattern => pattern.test(value))) {
                throw sourceError(
                    'mobile_source_sensitive_data_forbidden',
                    `${field} contains forbidden sensitive content`
                );
            }
            return;
        }
        if (typeof value !== 'object') return;
        if (seen.has(value)) return;
        seen.add(value);
        if (Array.isArray(value)) {
            for (const item of value) {
                this.assertNoSensitiveData(item, field, depth + 1, seen);
            }
            return;
        }
        for (const [key, nested] of Object.entries(value)) {
            const normalizedKey = String(key).replace(/[^a-z0-9]/gi, '').toLowerCase();
            if (SENSITIVE_RAW_KEYS.has(normalizedKey)
                    || SENSITIVE_RAW_KEY_PATTERNS.some(pattern => pattern.test(normalizedKey))) {
                throw sourceError(
                    'mobile_source_sensitive_data_forbidden',
                    `${field} contains a forbidden sensitive field`
                );
            }
            this.assertNoSensitiveData(nested, field, depth + 1, seen);
        }
    }

    assertNoSensitivePublicText(value, field) {
        const text = String(value || '').trim();
        if (text && SENSITIVE_PUBLIC_TEXT_PATTERNS.some(pattern => pattern.test(text))) {
            throw sourceError(
                'mobile_source_sensitive_data_forbidden',
                `${field} contains forbidden sensitive content`
            );
        }
    }

    normalizeFieldSource(value, prefix, prices) {
        if (value === null || value === undefined) return {};
        if (!this.plainObject(value)) {
            throw sourceError('mobile_source_fuel_offer_invalid', `${prefix}.fieldSource must be an object`);
        }
        this.assertKnownFields(value, FIELD_SOURCE_FIELDS, `${prefix}.fieldSource`);
        const normalized = {};
        for (const key of FIELD_SOURCE_FIELDS) {
            if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
            if (value[key] !== 'ocr' || prices[key] === null) {
                throw sourceError(
                    'mobile_source_fuel_offer_invalid',
                    `${prefix}.fieldSource.${key} is invalid`
                );
            }
            normalized[key] = 'ocr';
        }
        return normalized;
    }

    assertMatchingContext(fuel, context, prefix) {
        const platform = this.optionalText(fuel.platform, 64)?.toLowerCase() || null;
        const city = this.optionalText(fuel.city, 128);
        if (platform && platform !== context.platform) {
            throw sourceError('mobile_source_platform_mismatch', `${prefix}.platform does not match batch platform`);
        }
        if (city && city !== context.city) {
            throw sourceError('mobile_source_city_mismatch', `${prefix}.city does not match batch city`);
        }
    }

    assertFuelQuoteFeature(context, field) {
        if (context.feature !== FUEL_QUOTE_FEATURE) {
            throw sourceError('mobile_source_feature_required', `${field} requires fuel-quote-v1`);
        }
        if (!this.fuelQuoteV1Enabled || !this.fuelQuotePlatforms.has(context.platform)) {
            throw sourceError(
                'mobile_source_feature_disabled',
                'fuel-quote-v1 is not enabled for this platform',
                409
            );
        }
    }

    assertKnownFields(value, allowed, field) {
        const unknown = Object.keys(value).filter(key => !allowed.has(key));
        if (unknown.length > 0) {
            throw sourceError(
                'mobile_source_field_unknown',
                `${field} contains unsupported fields: ${unknown.join(',')}`
            );
        }
    }

    money(value, field, nullable) {
        if (value === null || value === undefined || value === '') {
            if (nullable) return null;
            throw sourceError('mobile_source_fuel_quote_invalid', `${field} is required`);
        }
        if (!['number', 'string'].includes(typeof value)) {
            throw sourceError('mobile_source_fuel_quote_invalid', `${field} is invalid`);
        }
        const text = String(value).trim();
        if (!/^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/.test(text)) {
            throw sourceError('mobile_source_fuel_quote_invalid', `${field} is invalid`);
        }
        const minor = Math.round(Number(text) * 100);
        if (!Number.isSafeInteger(minor)
                || minor < 0
                || minor > 10000000
                || (!nullable && minor === 0)) {
            throw sourceError('mobile_source_fuel_quote_invalid', `${field} is invalid`);
        }
        return this.moneyFromMinor(minor);
    }

    moneyMinor(value) {
        return Math.round(Number(value) * 100);
    }

    moneyFromMinor(value) {
        return (value / 100).toFixed(2);
    }

    optionalBoolean(value, field) {
        if (value === null || value === undefined) return null;
        if (typeof value !== 'boolean') {
            throw sourceError('mobile_source_field_invalid', `${field} must be a boolean`);
        }
        return value;
    }

    booleanOption(value, fallback) {
        if (value === null || value === undefined || value === '') return fallback;
        if (typeof value === 'boolean') return value;
        return /^(1|true|yes|on)$/i.test(String(value));
    }

    platformAllowlist(value) {
        if (value === null || value === undefined || value === '') {
            return new Set(DEFAULT_FUEL_QUOTE_PLATFORMS);
        }
        const source = Array.isArray(value) ? value : String(value).split(',');
        const requested = source
            .map(item => String(item || '').trim().toLowerCase())
            .filter(Boolean);
        if (requested.length === 0 || requested.some(item => !PLATFORM_PATTERN.test(item))) {
            throw new TypeError('fuel-quote-v1 platform allowlist is invalid');
        }
        return new Set(requested);
    }

    featureCapabilities() {
        return {
            [FUEL_QUOTE_FEATURE]: {
                enabled: this.fuelQuoteV1Enabled,
                platforms: [...this.fuelQuotePlatforms],
                captureMode: FUEL_QUOTE_CAPTURE_MODE,
                maxOffersPerStation: 8,
                maxQuotesPerObservation: 128,
            },
        };
    }

    plainObject(value) {
        return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    }

    requiredText(value, field, maxLength) {
        const text = this.optionalText(value, maxLength);
        if (!text) throw sourceError('mobile_source_field_required', `${field} is required`);
        return text;
    }

    optionalText(value, maxLength) {
        if (value === null || value === undefined) return null;
        const text = String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
        if (!text) return null;
        if (text.length > maxLength) {
            throw sourceError('mobile_source_field_too_long', `field exceeds ${maxLength} characters`);
        }
        return text;
    }

    nullableNumber(value, min, max, field) {
        if (value === null || value === undefined || value === '') return null;
        const number = Number(value);
        if (!Number.isFinite(number) || number < min || number > max) {
            throw sourceError('mobile_source_number_invalid', `${field} is out of range`);
        }
        return number;
    }

    nullableInteger(value, min, max, field) {
        if (value === null || value === undefined || value === '') return null;
        const number = Number(value);
        if (!Number.isSafeInteger(number) || number < min || number > max) {
            throw sourceError(
                'mobile_source_integer_invalid',
                `${field} must be an integer between ${min} and ${max}`
            );
        }
        return number;
    }

    fuelPrice(value, field) {
        const normalized = normalizeFuelPrice(value);
        if (normalized === null) return null;
        if (!Number.isFinite(normalized)) {
            throw sourceError(
                'mobile_source_fuel_price_invalid',
                `${field} must be within range with at most four decimal places`
            );
        }
        return normalized;
    }

    boundedInt(value, min, max, fallback) {
        if (value === null || value === undefined || value === '') return fallback;
        const number = Number(value);
        if (!Number.isSafeInteger(number) || number < min || number > max) {
            throw sourceError('mobile_source_integer_invalid', `integer must be between ${min} and ${max}`);
        }
        return number;
    }

    assertPortPair(idle, total, field) {
        if (idle > total) {
            throw sourceError('mobile_source_ports_invalid', `${field} idle ports exceed total ports`);
        }
    }
}

module.exports = {
    MobileSourceNodeService,
    sourceError,
};
