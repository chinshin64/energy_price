'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    createSyncAuthMiddleware,
    readSyncToken,
    timingSafeStringEqual,
} = require('../middleware/sync-auth');

function createResponse() {
    return {
        statusCode: 200,
        headers: {},
        body: null,
        status(value) {
            this.statusCode = value;
            return this;
        },
        json(value) {
            this.body = value;
            return this;
        },
        setHeader(name, value) {
            this.headers[String(name).toLowerCase()] = value;
        },
    };
}

test('reads bearer and dedicated sync headers', () => {
    assert.equal(readSyncToken({ headers: { authorization: 'Bearer machine-token' } }), 'machine-token');
    assert.equal(readSyncToken({ headers: { 'x-sync-token': 'node-token' } }), 'node-token');
});

test('allows development requests only when authentication is explicitly optional', () => {
    const middleware = createSyncAuthMiddleware({
        getConfiguredToken: () => '',
        required: false,
    });
    const response = createResponse();
    let nextCalled = false;

    middleware({ headers: {} }, response, () => { nextCalled = true; });

    assert.equal(nextCalled, true);
    assert.equal(response.statusCode, 200);
});

test('fails closed when authentication is required but not configured', () => {
    const middleware = createSyncAuthMiddleware({
        getConfiguredToken: () => '',
        required: true,
    });
    const response = createResponse();

    middleware({ headers: {} }, response, () => assert.fail('next must not be called'));

    assert.equal(response.statusCode, 503);
    assert.equal(response.body.code, 'sync_auth_not_configured');
});

test('rejects an invalid token and accepts a valid token', () => {
    const middleware = createSyncAuthMiddleware({
        getConfiguredToken: () => 'expected-token',
        required: true,
    });
    const rejected = createResponse();
    middleware(
        { headers: { authorization: 'Bearer wrong-token' } },
        rejected,
        () => assert.fail('next must not be called')
    );
    assert.equal(rejected.statusCode, 401);
    assert.equal(rejected.body.code, 'sync_auth_failed');

    const accepted = createResponse();
    const request = { headers: { 'x-sync-token': 'expected-token' } };
    let nextCalled = false;
    middleware(request, accepted, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    assert.deepEqual(request.syncPrincipal, { type: 'sync-node' });
});

test('compares credentials without early length exits', () => {
    assert.equal(timingSafeStringEqual('same', 'same'), true);
    assert.equal(timingSafeStringEqual('short', 'a much longer value'), false);
});
