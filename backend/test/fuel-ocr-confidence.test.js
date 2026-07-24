'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { evaluateFuel } = require('../services/fuel-ocr-confidence');

function station() {
    return {
        stationType: 'fuel',
        stationName: '浙江石油测试加油站',
        confidence: 0.92,
        fuelOffers: [{
            fuelType: 'gasoline',
            gradeCode: '92',
            gradeLabel: '92#',
            listPrice: 7.4,
            discountPrice: 7.1,
            unclassifiedPrice: null,
            discountKind: 'explicit',
            currency: 'CNY',
            unit: 'CNY_PER_LITER',
            evidence: [{ kind: 'discount-price' }, { kind: 'list-price' }],
            fieldSource: {},
            capturedAt: '2026-07-23T03:30:00.000Z',
        }],
    };
}

function quote(overrides = {}) {
    return {
        quoteObservationId: 'quote-confidence-0001',
        quoteDedupKey: 'a'.repeat(64),
        gradeCode: '95',
        gradeLabel: '95#汽油',
        gunCode: null,
        gunLabel: null,
        selectedAmount: '200.00',
        grossDiscount: '20.65',
        serviceFee: '3.30',
        netDiscount: '17.35',
        payableAmount: '182.65',
        quoteEntry: 'inline',
        needsReview: false,
        capturedAt: '2026-07-23T03:30:00.000Z',
        raw: {},
        ...overrides,
    };
}

test('fuel OCR confidence evaluates grade, CNY per liter price and explicit evidence without ports/address', () => {
    const result = evaluateFuel(station());
    assert.equal(result.light, 'green');
    assert.equal(result.weightPolicy, 'fuel-ocr-v1');
    assert.equal(result.hardRules.length, 0);
});

test('fuel OCR confidence accepts validated v3 public station observation fields', () => {
    const observed = {
        ...station(),
        address: '湖北省武汉市测试大道2号',
        missingFields: [],
        qualityStatus: 'valid',
        needsReview: false,
    };
    const result = evaluateFuel(observed);
    assert.equal(result.light, 'green');
    assert.equal(result.hardRules.length, 0);
});

test('fuel OCR confidence rejects invalid public fields and nested charging fields', () => {
    // 燃油侧无枪数据：任何 ports 字段都应被拒绝。
    const withPorts = {
        ...station(),
        availablePorts: 3,
        busyPorts: 3,
        totalPorts: 5,
    };
    assert.ok(evaluateFuel(withPorts).hardRules.includes('fuel_public_availablePorts_forbidden'));

    const withSemantics = {
        ...station(),
        portSemantics: 'charging-gun',
    };
    assert.ok(
        evaluateFuel(withSemantics).hardRules
            .includes('fuel_public_portSemantics_forbidden')
    );

    const nestedCharging = {
        ...station(),
        address: '湖北省武汉市测试大道2号',
        raw: { availablePorts: 3 },
    };
    assert.ok(
        evaluateFuel(nestedCharging).hardRules
            .includes('fuel_charging_field_forbidden')
    );
});

test('fuel OCR confidence rejects missing offers and invalid discount ordering', () => {
    const missing = station();
    missing.fuelOffers = [];
    assert.equal(evaluateFuel(missing).light, 'red');

    const invalid = station();
    invalid.fuelOffers[0].discountPrice = 8.1;
    assert.match(evaluateFuel(invalid).hardRules.join(','), /discountPrice exceeds listPrice/);
});

test('fuel quote OCR confidence accepts three-price offers and exact cent formulas', () => {
    const quoted = station();
    quoted.fuelOffers = [{
        fuelType: 'gasoline',
        gradeCode: '95',
        gradeLabel: '95#汽油',
        displayPrice: '6.6300',
        stationPrice: '7.8600',
        nationalPrice: '8.1200',
        currency: 'CNY',
        unit: 'CNY_PER_LITER',
        evidence: [
            { kind: 'display-price' },
            { kind: 'station-price' },
            { kind: 'national-price' },
        ],
        fieldSource: {
            displayPrice: 'ocr',
            stationPrice: 'ocr',
            nationalPrice: 'ocr',
        },
        discountKind: 'none',
        capturedAt: '2026-07-23T03:30:00.000Z',
    }];
    quoted.fuelQuotes = [quote()];

    const result = evaluateFuel(quoted);
    assert.equal(result.light, 'green');
    assert.equal(result.dimensions.quoteConsistency, 100);
    assert.equal(result.weightPolicy, 'fuel-quote-ocr-v1');
});

test('fuel quote formula mismatch is review-grade instead of silently corrected', () => {
    const quoted = station();
    quoted.fuelQuotes = [quote({
        grossDiscount: '8.39',
        serviceFee: '1.34',
        netDiscount: '7.05',
        payableAmount: '190.00',
        needsReview: true,
    })];
    const result = evaluateFuel(quoted);
    assert.equal(result.light, 'yellow');
    assert.equal(result.dimensions.quoteConsistency, 20);
});

test('quote-only fuel OCR confidence remains mergeable when the quote is complete', () => {
    const quoted = station();
    quoted.fuelOffers = [];
    quoted.fuelQuotes = [quote()];
    const result = evaluateFuel(quoted);
    assert.equal(result.light, 'green');
    assert.equal(result.weightPolicy, 'fuel-quote-only-ocr-v1');
    assert.equal(result.dimensions.priceReasonability, null);
    assert.equal(result.dimensions.quoteConsistency, 100);
});
