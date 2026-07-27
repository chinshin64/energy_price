#!/usr/bin/env node
'use strict';

const { createMobileSourceNodeApp } = require('../mobile-source-node');
const { MysqlMobileSourceStore } = require('../services/mysql-mobile-source-store');
const { MobileSourceNodeService } = require('../services/mobile-source-node-service');

const port = Number(process.env.MOBILE_SOURCE_PORT || 50080);
const host = process.env.MOBILE_SOURCE_HOST || '0.0.0.0';
const store = new MysqlMobileSourceStore({ env: process.env });
const service = new MobileSourceNodeService({
    store,
    maxStationRawBytes: process.env.MOBILE_SOURCE_STATION_RAW_MAX_BYTES,
    maxQuoteRawBytes: process.env.MOBILE_SOURCE_QUOTE_RAW_MAX_BYTES,
    fuelQuoteV1Enabled: process.env.MOBILE_SOURCE_FUEL_QUOTE_V1_ENABLED,
    fuelQuotePlatforms: process.env.MOBILE_SOURCE_FUEL_QUOTE_V1_PLATFORMS,
});
const app = createMobileSourceNodeApp({
    service,
    mobileToken: (process.env.MOBILE_SOURCE_INGEST_TOKEN || '')
        .split(',')
        .map(value => value.trim())
        .filter(value => value.length > 0),
    sourceSyncToken: process.env.MOBILE_SOURCE_SYNC_TOKEN,
    requireAuth: true,
    bodyLimit: process.env.MOBILE_SOURCE_BODY_LIMIT || '8mb',
    trustProxy: process.env.MOBILE_SOURCE_TRUST_PROXY || false,
    updateProxyUrl: process.env.MOBILE_UPDATE_PROXY_URL,
    updateProxyHost: process.env.MOBILE_UPDATE_PROXY_HOST || '127.0.0.1',
    updateProxyPort: process.env.MOBILE_UPDATE_PROXY_PORT || 50082,
    updateProxyTimeoutMs: process.env.MOBILE_UPDATE_PROXY_TIMEOUT_MS || 15000,
});

const server = app.listen(port, host, () => {
    console.log(`47 MySQL mobile source node listening on http://${host}:${port}`);
});

let stopping = false;
async function stop(signal) {
    if (stopping) return;
    stopping = true;
    console.log(`Received ${signal}, stopping mobile source node`);
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await store.close();
}

for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, () => {
        stop(signal)
            .then(() => process.exit(0))
            .catch(error => {
                console.error('Mobile source node shutdown failed:', error.message);
                process.exit(1);
            });
    });
}
