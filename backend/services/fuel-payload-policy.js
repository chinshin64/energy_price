'use strict';

const EXACT_FORBIDDEN_KEYS = new Set([
    'address',
    'addr',
    'pricefast',
    'priceslow',
    'pricesuper',
    'priceservice',
    'availableports',
    'totalports',
    'busyports',
    'idleports',
    'portsemantics',
    'onlinefast',
    'onlineslow',
    'onlinesuper',
    'onlinefastports',
    'onlineslowports',
    'onlinesuperports',
    'fastidleports',
    'fastavailableports',
    'fasttotalports',
    'fastbusyports',
    'slowidleports',
    'slowavailableports',
    'slowtotalports',
    'slowbusyports',
    'superidleports',
    'superavailableports',
    'supertotalports',
    'superbusyports',
]);

const PROVIDER_EVIDENCE_FIELDS = new Set([
    'kind', 'text', 'confidence', 'boundingBox',
]);
const BOUNDING_BOX_FIELDS = new Set(['x', 'y', 'width', 'height']);
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
const FIELD_SOURCE_FIELDS = new Set([
    'displayPrice', 'stationPrice', 'nationalPrice',
]);
const OFFER_EVIDENCE_FIELDS = new Set([
    'kind', 'text', 'format', 'type', 'confidence', 'boundingBox',
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

function normalizeFieldKey(value) {
    return String(value || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function isChargingFieldKey(value) {
    const key = normalizeFieldKey(value);
    return EXACT_FORBIDDEN_KEYS.has(key)
        || /^price(fast|slow|super|service)$/.test(key)
        || /^(available|total|busy|idle)(ports|guns|gun)$/.test(key)
        || /^online(fast|slow|super)(ports|guns|gun)?$/.test(key)
        || /^(fast|slow|super)(idle|available|total|busy|online)(ports|guns|gun)?$/.test(key);
}

function findForbiddenFuelField(value, path = '$', seen = new WeakSet()) {
    if (!value || typeof value !== 'object') return null;
    if (seen.has(value)) return null;
    seen.add(value);
    if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index += 1) {
            const nested = findForbiddenFuelField(value[index], `${path}[${index}]`, seen);
            if (nested) return nested;
        }
        return null;
    }
    for (const [key, nestedValue] of Object.entries(value)) {
        if (isChargingFieldKey(key)) return `${path}.${key}`;
        const nested = findForbiddenFuelField(nestedValue, `${path}.${key}`, seen);
        if (nested) return nested;
    }
    return null;
}

function hasNestedField(value, expectedKey, seen = new WeakSet()) {
    if (!value || typeof value !== 'object') return false;
    if (seen.has(value)) return false;
    seen.add(value);
    if (Array.isArray(value)) return value.some(item => hasNestedField(item, expectedKey, seen));
    for (const [key, nestedValue] of Object.entries(value)) {
        if (normalizeFieldKey(key) === normalizeFieldKey(expectedKey)) return true;
        if (hasNestedField(nestedValue, expectedKey, seen)) return true;
    }
    return false;
}

function isValidFuelPrice(value) {
    if (value === null || value === undefined || value === '') return false;
    if (!['number', 'string'].includes(typeof value)) return false;
    const text = String(value).trim();
    if (!/^(?:0|[1-9]\d?)(?:\.\d{1,4})?$/.test(text)) return false;
    const number = Number(text);
    return Number.isFinite(number) && number > 0 && number <= 30;
}

function normalizeFuelPrice(value) {
    if (value === null || value === undefined || value === '') return null;
    return isValidFuelPrice(value) ? Number(value) : Number.NaN;
}

function plainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function firstUnknownField(value, allowed) {
    if (!plainObject(value)) return null;
    return Object.keys(value).find(key => !allowed.has(key)) || null;
}

function boundedText(value, maximum, required = false) {
    if (value === null || value === undefined) return !required;
    if (typeof value !== 'string') return false;
    const text = value.trim();
    return required ? text.length > 0 && text.length <= maximum : text.length <= maximum;
}

function validIsoTimestamp(value) {
    if (!boundedText(value, 64, true)) return false;
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
        return false;
    }
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp);
}

function validBoundingBox(value) {
    if (value === null || value === undefined) return true;
    if (!plainObject(value) || firstUnknownField(value, BOUNDING_BOX_FIELDS)) return false;
    const box = {};
    for (const field of BOUNDING_BOX_FIELDS) {
        const number = Number(value[field]);
        if (!Number.isFinite(number) || number < 0 || number > 1) return false;
        box[field] = number;
    }
    return box.x + box.width <= 1.000001 && box.y + box.height <= 1.000001;
}

function containsSensitiveData(value, depth = 0, seen = new WeakSet()) {
    if (value === null || value === undefined) return false;
    if (depth > 12) return true;
    if (typeof value === 'string') {
        return SENSITIVE_CONTENT_PATTERNS.some(pattern => pattern.test(value));
    }
    if (typeof value !== 'object') return false;
    if (seen.has(value)) return false;
    seen.add(value);
    if (Array.isArray(value)) {
        return value.some(item => containsSensitiveData(item, depth + 1, seen));
    }
    return Object.entries(value).some(([key, nested]) => {
        const normalizedKey = String(key).replace(/[^a-z0-9]/gi, '').toLowerCase();
        return SENSITIVE_RAW_KEYS.has(normalizedKey)
            || SENSITIVE_RAW_KEY_PATTERNS.some(pattern => pattern.test(normalizedKey))
            || containsSensitiveData(nested, depth + 1, seen);
    });
}

function validateProviderEvidence(value) {
    if (value === null || value === undefined) return null;
    if (!plainObject(value)) return 'providerEvidence must be an object';
    if (containsSensitiveData(value)) return 'providerEvidence contains sensitive content';
    const unknown = firstUnknownField(value, PROVIDER_EVIDENCE_FIELDS);
    if (unknown) return `providerEvidence contains unsupported field ${unknown}`;
    if (value.kind !== 'provider-attribution') return 'providerEvidence.kind is invalid';
    if (!boundedText(value.text, 256, true)) return 'providerEvidence.text is invalid';
    if (value.confidence !== null && value.confidence !== undefined) {
        const confidence = Number(value.confidence);
        if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
            return 'providerEvidence.confidence is invalid';
        }
    }
    if (!validBoundingBox(value.boundingBox)) return 'providerEvidence.boundingBox is invalid';
    return null;
}

function validateFieldSource(value, offer) {
    if (!plainObject(value)) return 'fieldSource must be an object';
    const unknown = firstUnknownField(value, FIELD_SOURCE_FIELDS);
    if (unknown) return `fieldSource contains unsupported field ${unknown}`;
    for (const [field, source] of Object.entries(value)) {
        if (source !== 'ocr' || offer[field] === null || offer[field] === undefined) {
            return `fieldSource.${field} is invalid`;
        }
    }
    return null;
}

function validateOfferEvidence(value) {
    if (!Array.isArray(value) || value.length > 8) return 'evidence must be an array of at most 8 rows';
    if (Buffer.byteLength(JSON.stringify({ rows: value }), 'utf8') > 16384) {
        return 'evidence exceeds 16384 bytes';
    }
    if (containsSensitiveData(value)) return 'evidence contains sensitive content';
    for (const [index, row] of value.entries()) {
        if (!plainObject(row)) return `evidence[${index}] must be an object`;
        const unknown = firstUnknownField(row, OFFER_EVIDENCE_FIELDS);
        if (unknown) return `evidence[${index}] contains unsupported field ${unknown}`;
        for (const field of ['kind', 'format', 'type']) {
            if (!boundedText(row[field], 64, false)) {
                return `evidence[${index}].${field} is invalid`;
            }
        }
        if (!boundedText(row.text, 256, false)) return `evidence[${index}].text is invalid`;
        if (row.confidence !== null && row.confidence !== undefined) {
            const confidence = Number(row.confidence);
            if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
                return `evidence[${index}].confidence is invalid`;
            }
        }
        if (!validBoundingBox(row.boundingBox)) return `evidence[${index}].boundingBox is invalid`;
        if (!['kind', 'text', 'format', 'type'].some(field => (
            typeof row[field] === 'string' && row[field].trim()
        ))) {
            return `evidence[${index}] requires bounded evidence metadata`;
        }
    }
    return null;
}

function validateFuelOffer(offer) {
    if (!plainObject(offer)) return 'offer must be an object';
    const unknown = firstUnknownField(offer, FUEL_OFFER_FIELDS);
    if (unknown) return `offer contains unsupported field ${unknown}`;
    if (!boundedText(offer.fuelType, 32, true)) return 'offer.fuelType is invalid';
    if (!boundedText(offer.gradeCode, 32, true)) return 'offer.gradeCode is invalid';
    if (!boundedText(offer.gradeLabel, 64, true)) return 'offer.gradeLabel is invalid';
    const priceFields = [
        'displayPrice', 'stationPrice', 'nationalPrice',
        'listPrice', 'discountPrice', 'unclassifiedPrice',
    ];
    const observed = priceFields.filter(field => (
        offer[field] !== null && offer[field] !== undefined && offer[field] !== ''
    ));
    if (observed.length === 0 || observed.some(field => !isValidFuelPrice(offer[field]))) {
        return 'offer price is invalid';
    }
    if (offer.listPrice !== null && offer.listPrice !== undefined
            && offer.discountPrice !== null && offer.discountPrice !== undefined
            && Number(offer.discountPrice) > Number(offer.listPrice)) {
        return 'offer.discountPrice exceeds listPrice';
    }
    if (!boundedText(offer.discountKind, 32, false)) return 'offer.discountKind is invalid';
    if (offer.currency !== 'CNY' || offer.unit !== 'CNY_PER_LITER') {
        return 'offer currency/unit is invalid';
    }
    const fieldSourceError = validateFieldSource(offer.fieldSource, offer);
    if (fieldSourceError) return `offer.${fieldSourceError}`;
    const evidenceError = validateOfferEvidence(offer.evidence);
    if (evidenceError) return `offer.${evidenceError}`;
    if (!validIsoTimestamp(offer.capturedAt)) return 'offer.capturedAt is invalid';
    return null;
}

function moneyToCents(value, required = false) {
    if (value === null || value === undefined || value === '') return required ? null : undefined;
    if (!['string', 'number'].includes(typeof value)) return null;
    const text = String(value).trim();
    if (!/^(?:0|[1-9]\d{0,6})(?:\.\d{1,2})?$/.test(text)) return null;
    const [yuan, fraction = ''] = text.split('.');
    const cents = Number(yuan) * 100 + Number(fraction.padEnd(2, '0'));
    return Number.isSafeInteger(cents) ? cents : null;
}

function validateFuelQuote(quote) {
    if (!plainObject(quote)) return 'quote must be an object';
    const unknown = firstUnknownField(quote, FUEL_QUOTE_FIELDS);
    if (unknown) return `quote contains unsupported field ${unknown}`;
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(String(quote.quoteObservationId || ''))) {
        return 'quote.quoteObservationId is invalid';
    }
    if (!/^[a-f0-9]{64}$/i.test(String(quote.quoteDedupKey || ''))) {
        return 'quote.quoteDedupKey is invalid';
    }
    if (!boundedText(quote.gradeCode, 32, true)) return 'quote.gradeCode is invalid';
    if (!boundedText(quote.gradeLabel, 64, true)) return 'quote.gradeLabel is invalid';
    if (!boundedText(quote.gunCode, 32, false)) return 'quote.gunCode is invalid';
    if (!boundedText(quote.gunLabel, 64, false)) return 'quote.gunLabel is invalid';
    const selected = moneyToCents(quote.selectedAmount, true);
    if (selected === null) return 'quote.selectedAmount is invalid';
    const amounts = ['grossDiscount', 'serviceFee', 'netDiscount', 'payableAmount'];
    const normalized = new Map();
    for (const field of amounts) {
        const cents = moneyToCents(quote[field], false);
        if (cents === null) return `quote.${field} is invalid`;
        normalized.set(field, cents);
    }
    if (['grossDiscount', 'serviceFee', 'payableAmount']
        .every(field => normalized.get(field) === undefined)) {
        return 'quote requires an observed discount, service fee or payable amount';
    }
    if (normalized.get('grossDiscount') !== undefined
            && normalized.get('serviceFee') !== undefined
            && normalized.get('serviceFee') > normalized.get('grossDiscount')) {
        return 'quote.serviceFee exceeds grossDiscount';
    }
    if (!['inline', 'explanation_popup'].includes(quote.quoteEntry)) {
        return 'quote.quoteEntry is invalid';
    }
    if (typeof quote.needsReview !== 'boolean') return 'quote.needsReview is invalid';
    if (!validIsoTimestamp(quote.capturedAt)) return 'quote.capturedAt is invalid';
    if (!plainObject(quote.raw)) return 'quote.raw must be an object';
    return null;
}

module.exports = {
    BOUNDING_BOX_FIELDS,
    containsSensitiveData,
    EXACT_FORBIDDEN_KEYS,
    FIELD_SOURCE_FIELDS,
    FUEL_OFFER_FIELDS,
    FUEL_QUOTE_FIELDS,
    OFFER_EVIDENCE_FIELDS,
    PROVIDER_EVIDENCE_FIELDS,
    SENSITIVE_CONTENT_PATTERNS,
    SENSITIVE_RAW_KEYS,
    findForbiddenFuelField,
    hasNestedField,
    isChargingFieldKey,
    isValidFuelPrice,
    moneyToCents,
    normalizeFieldKey,
    normalizeFuelPrice,
    plainObject,
    validateFuelOffer,
    validateFuelQuote,
    validateProviderEvidence,
    validBoundingBox,
    validIsoTimestamp,
};
