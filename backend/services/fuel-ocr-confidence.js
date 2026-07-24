'use strict';

const {
    findForbiddenFuelField,
    validateFuelOffer,
    validateFuelQuote,
} = require('./fuel-payload-policy');

const FUEL_NAME_KEYWORDS = ['加油站', '油站', '石油', '石化', '能源'];
const PRICE_LABEL_KINDS = new Set([
    'display-price',
    'station-price',
    'national-price',
    'list-price',
    'discount-price',
    'unclassified-price',
]);
const PUBLIC_FUEL_STATION_FIELDS = Object.freeze([
    'address', 'missingFields', 'qualityStatus', 'needsReview',
]);
const QUALITY_STATUSES = new Set(['valid', 'incomplete', 'needs-review']);
const MISSING_FIELD_NAMES = new Set([
    'address',
    'priceFast', 'priceSlow', 'priceSuper', 'priceService',
    'fuelOffers', 'fuelQuotes', 'providerName',
]);

function validatePublicStationObservation(data = {}) {
    if (data.address !== undefined && data.address !== null
            && (typeof data.address !== 'string' || data.address.trim().length > 1024)) {
        return 'fuel_public_address_invalid';
    }
    // 燃油侧无枪数据：ports/portSemantics 一律不得出现。
    for (const field of ['availablePorts', 'busyPorts', 'totalPorts', 'portSemantics']) {
        if (data[field] !== undefined && data[field] !== null) {
            return `fuel_public_${field}_forbidden`;
        }
    }
    if (data.missingFields !== undefined && data.missingFields !== null) {
        if (!Array.isArray(data.missingFields)
                || data.missingFields.length > 32
                || data.missingFields.some(field => !MISSING_FIELD_NAMES.has(field))) {
            return 'fuel_public_missing_fields_invalid';
        }
    }
    if (data.qualityStatus !== undefined && data.qualityStatus !== null
            && !QUALITY_STATUSES.has(data.qualityStatus)) {
        return 'fuel_public_quality_status_invalid';
    }
    if (data.needsReview !== undefined && typeof data.needsReview !== 'boolean') {
        return 'fuel_public_needs_review_invalid';
    }
    return null;
}

function fuelPolicyRecord(data = {}) {
    const value = { ...data };
    for (const field of PUBLIC_FUEL_STATION_FIELDS) delete value[field];
    return value;
}

function moneyToCents(value) {
    if (value === null || value === undefined || value === '') return null;
    const text = String(value).trim();
    if (!/^(?:0|[1-9]\d{0,6})(?:\.\d{1,2})?$/.test(text)) return null;
    const [yuan, fraction = ''] = text.split('.');
    const cents = Number(yuan) * 100 + Number(fraction.padEnd(2, '0'));
    return Number.isSafeInteger(cents) ? cents : null;
}

function quoteConsistencyScore(quote = {}) {
    const selected = moneyToCents(quote.selectedAmount);
    const gross = moneyToCents(quote.grossDiscount);
    const service = moneyToCents(quote.serviceFee);
    const net = moneyToCents(quote.netDiscount);
    const payable = moneyToCents(quote.payableAmount);
    const observed = [selected, gross, service, net, payable].filter(value => value !== null);
    if (observed.length === 0) return 0;

    const checks = [];
    if (gross !== null && service !== null && net !== null) {
        checks.push(Math.abs((gross - service) - net) <= 1);
    }
    if (selected !== null && gross !== null && service !== null && payable !== null) {
        checks.push(Math.abs((selected - gross + service) - payable) <= 1);
    }
    if (checks.length === 0) return 60;
    return checks.every(Boolean) ? 100 : 20;
}

function evaluateFuel(data = {}) {
    const hardRules = [];
    const dimensions = {};
    const name = String(data.stationName || data.station_name || '').trim();
    const offers = Array.isArray(data.fuelOffers) ? data.fuelOffers : [];
    const quotes = Array.isArray(data.fuelQuotes) ? data.fuelQuotes : [];

    const publicObservationError = validatePublicStationObservation(data);
    if (publicObservationError) hardRules.push(publicObservationError);
    if (findForbiddenFuelField(fuelPolicyRecord(data))) {
        hardRules.push('fuel_charging_field_forbidden');
    }
    if (!name) hardRules.push('fuel_station_name_missing');
    if (offers.length === 0 && quotes.length === 0) {
        hardRules.push('fuel_observation_missing');
    }
    for (const [index, offer] of offers.entries()) {
        const reason = validateFuelOffer(offer);
        if (reason) hardRules.push(`fuel_offer_invalid:${index}:${reason}`);
    }
    for (const [index, quote] of quotes.entries()) {
        const reason = validateFuelQuote(quote);
        if (reason) hardRules.push(`fuel_quote_invalid:${index}:${reason}`);
    }
    if (hardRules.length > 0) {
        return {
            score: 0,
            light: 'red',
            dimensions: {},
            hardRules,
            sourceTrust: 40,
            weightPolicy: 'fuel-ocr-v1',
        };
    }

    dimensions.stationNameNorm = FUEL_NAME_KEYWORDS.some(keyword => name.includes(keyword)) ? 100 : 60;
    const gradedRecords = offers.length > 0 ? offers : quotes;
    dimensions.gradeCompleteness = Math.round(
        gradedRecords.filter(item => item.gradeCode && item.gradeLabel).length / gradedRecords.length * 100
    );
    if (offers.length > 0) {
        dimensions.priceReasonability = Math.round(offers.reduce((sum, offer) => {
            const values = [
                offer.displayPrice,
                offer.stationPrice,
                offer.nationalPrice,
                offer.listPrice,
                offer.discountPrice,
                offer.unclassifiedPrice,
            ]
                .map(Number)
                .filter(value => Number.isFinite(value) && value > 0);
            return sum + (values.every(value => value >= 2 && value <= 15) ? 100 : 60);
        }, 0) / offers.length);
        dimensions.labelAndUnitEvidence = Math.round(offers.reduce((sum, offer) => {
            const evidence = Array.isArray(offer.evidence) ? offer.evidence : [];
            const label = evidence.some(item => PRICE_LABEL_KINDS.has(String(item?.kind || '')));
            return sum + (label && offer.currency === 'CNY' && offer.unit === 'CNY_PER_LITER' ? 100 : 50);
        }, 0) / offers.length);
    } else {
        dimensions.priceReasonability = null;
        dimensions.labelAndUnitEvidence = null;
    }
    dimensions.ocrConfidence = Math.round(
        Math.max(0, Math.min(1, Number(data.confidence ?? data.raw?.confidence ?? 0.7))) * 100
    );

    let score;
    let weightPolicy = 'fuel-ocr-v1';
    if (quotes.length > 0) {
        const quoteScores = quotes.map(quote => quoteConsistencyScore(quote));
        dimensions.quoteConsistency = Math.round(
            quoteScores.reduce((sum, quoteScore) => sum + quoteScore, 0) / quoteScores.length
        );
        dimensions.quoteCompleteness = Math.round(quotes.reduce((sum, quote) => {
            const observed = [
                quote.grossDiscount,
                quote.serviceFee,
                quote.netDiscount,
                quote.payableAmount,
            ].filter(value => moneyToCents(value) !== null).length;
            return sum + Math.min(100, 40 + observed * 15);
        }, 0) / quotes.length);
        score = offers.length > 0
            ? Math.round(
                dimensions.stationNameNorm * 0.20
                + dimensions.gradeCompleteness * 0.15
                + dimensions.priceReasonability * 0.20
                + dimensions.labelAndUnitEvidence * 0.15
                + dimensions.ocrConfidence * 0.10
                + dimensions.quoteConsistency * 0.20
            )
            : Math.round(
                dimensions.stationNameNorm * 0.25
                + dimensions.gradeCompleteness * 0.20
                + dimensions.quoteCompleteness * 0.20
                + dimensions.ocrConfidence * 0.10
                + dimensions.quoteConsistency * 0.25
            );
        if (quoteScores.some(quoteScore => quoteScore === 0)) {
            score = Math.min(score, 59);
        } else if (quoteScores.some(quoteScore => quoteScore < 60)) {
            score = Math.min(score, 79);
        }
        weightPolicy = offers.length > 0 ? 'fuel-quote-ocr-v1' : 'fuel-quote-only-ocr-v1';
    } else {
        score = Math.round(
            dimensions.stationNameNorm * 0.25
            + dimensions.gradeCompleteness * 0.20
            + dimensions.priceReasonability * 0.25
            + dimensions.labelAndUnitEvidence * 0.20
            + dimensions.ocrConfidence * 0.10
        );
    }
    return {
        score,
        light: score >= 80 ? 'green' : score >= 60 ? 'yellow' : 'red',
        dimensions,
        hardRules: [],
        sourceTrust: 40,
        weightPolicy,
    };
}

module.exports = {
    evaluateFuel,
    FUEL_NAME_KEYWORDS,
    MISSING_FIELD_NAMES,
    PRICE_LABEL_KINDS,
    PUBLIC_FUEL_STATION_FIELDS,
    QUALITY_STATUSES,
    fuelPolicyRecord,
    moneyToCents,
    quoteConsistencyScore,
    validatePublicStationObservation,
};
