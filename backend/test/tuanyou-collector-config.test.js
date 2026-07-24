'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const TuanyouCollector = require('../services/tuanyou-collector');

test('tuanyou API collector fails closed without backend-controlled signing and device configuration', () => {
    const collector = new TuanyouCollector();
    assert.throws(
        () => collector.buildSignedParams({}),
        error => error.code === 'tuanyou_credentials_required'
            && !String(error.message).includes('secret')
    );
});
