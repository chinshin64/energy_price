'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createMobileSourceNodeApp } = require('../mobile-source-node');
const {
    isTrustedProxyPeer,
    normalizeIpAddress,
    resolveAgentReportIp,
} = require('../services/mobile-source-agent-report-ip');
const { MobileSourceNodeService } = require('../services/mobile-source-node-service');

test('report IP normalization accepts IPv4 and IPv6 and canonicalizes IPv4-mapped forms', () => {
    assert.equal(normalizeIpAddress(' 203.0.113.7 '), '203.0.113.7');
    assert.equal(normalizeIpAddress('2001:DB8::7'), '2001:db8::7');
    assert.equal(normalizeIpAddress('::ffff:192.0.2.128'), '192.0.2.128');
    assert.equal(normalizeIpAddress('::ffff:c000:0280'), '192.0.2.128');
    assert.equal(
        normalizeIpAddress('0:0:0:0:0:ffff:192.0.2.128'),
        '192.0.2.128'
    );
    assert.equal(normalizeIpAddress('198.51.100.1, 127.0.0.1'), null);
    assert.equal(normalizeIpAddress('not-an-ip'), null);
    assert.equal(normalizeIpAddress(['203.0.113.7']), null);
});

test('Cloudflare address is used only for a trusted proxy peer', () => {
    const request = (trusted, cloudflare = '203.0.113.9') => ({
        app: { get: name => name === 'trust proxy fn' ? () => trusted : undefined },
        headers: { 'cf-connecting-ip': cloudflare },
        socket: { remoteAddress: '::ffff:127.0.0.1' },
    });
    assert.equal(isTrustedProxyPeer(request(true)), true);
    assert.equal(resolveAgentReportIp(request(true)), '203.0.113.9');
    assert.equal(resolveAgentReportIp(request(false)), '127.0.0.1');
    assert.equal(resolveAgentReportIp(request(true, 'invalid')), '127.0.0.1');
    assert.equal(resolveAgentReportIp({
        app: { get: () => () => { throw new Error('bad trust rule'); } },
        headers: { 'cf-connecting-ip': '203.0.113.9' },
        socket: { remoteAddress: '127.0.0.1' },
    }), '127.0.0.1');
});

function chargingPayload() {
    return {
        sourceAgent: 'android-agent',
        platform: 'didi-charging',
        city: '西安',
        deviceSessionId: 'device-session-ip-test',
        sessionId: 'session-ip-test',
        pageIndex: 0,
        capturedAt: '2026-07-27T08:00:00.000Z',
        stations: [{
            stationName: '上报IP测试站',
            address: '陕西省西安市测试路1号',
            availablePorts: 1,
            totalPorts: 2,
            fastIdlePorts: 1,
            fastTotalPorts: 2,
        }],
    };
}

async function withIpServer(options, run) {
    const store = {
        batch: null,
        async ingest(batch) {
            this.batch = batch;
            return {
                ingestId: batch.ingestId,
                idempotencyKey: batch.idempotencyKey,
                sourceNode: '47-mysql',
                sourceAgent: batch.sourceAgent,
                persisted: true,
                duplicate: false,
                acceptedCount: batch.stations.length,
                acceptedStationCount: batch.stations.length,
                acceptedQuoteCount: 0,
                firstSourceRecordId: 1,
                lastSourceRecordId: 1,
                firstFuelSourceRecordId: null,
                lastFuelSourceRecordId: null,
            };
        },
        async health() { return true; },
    };
    const service = new MobileSourceNodeService({ store });
    const app = createMobileSourceNodeApp({
        service,
        mobileToken: 'mobile-secret',
        sourceSyncToken: 'sync-secret',
        requireAuth: true,
        ...options,
    });
    const server = await new Promise(resolve => {
        const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    try {
        await run({
            baseUrl: `http://127.0.0.1:${server.address().port}`,
            store,
        });
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
}

async function postBatch(baseUrl, body, cloudflareIp) {
    return fetch(`${baseUrl}/api/mobile-sync/stations`, {
        method: 'POST',
        headers: {
            Authorization: 'Bearer mobile-secret',
            'Content-Type': 'application/json',
            'X-Mobile-Agent': 'android-agent',
            'CF-Connecting-IP': cloudflareIp,
            'Idempotency-Key': 'f'.repeat(64),
        },
        body: JSON.stringify(body),
    });
}

test('trusted Cloudflare POST persists only the server-derived report IP in batch metadata', async () => {
    await withIpServer({ trustProxy: 'loopback' }, async ({ baseUrl, store }) => {
        const response = await postBatch(baseUrl, chargingPayload(), '198.51.100.27');
        const result = await response.clone().json();
        assert.equal(response.status, 201, JSON.stringify(result));
        assert.equal(store.batch.rawMeta.agentReportIp, '198.51.100.27');
        assert.equal(store.batch.rawMeta.remoteAddress, '127.0.0.1');
    });
});

test('untrusted or malformed Cloudflare values fall back without failing the batch', async () => {
    await withIpServer({}, async ({ baseUrl, store }) => {
        const response = await postBatch(baseUrl, chargingPayload(), 'invalid-ip');
        const result = await response.clone().json();
        assert.equal(response.status, 201, JSON.stringify(result));
        assert.equal(store.batch.rawMeta.agentReportIp, '127.0.0.1');
    });
});

test('client JSON cannot self-report or override agent report IP', async () => {
    await withIpServer({ trustProxy: 'loopback' }, async ({ baseUrl, store }) => {
        const body = { ...chargingPayload(), agentReportIp: '203.0.113.200' };
        const response = await postBatch(baseUrl, body, '198.51.100.27');
        const result = await response.json();
        assert.equal(response.status, 400);
        assert.equal(result.code, 'mobile_source_field_unknown');
        assert.equal(store.batch, null);
    });
});
