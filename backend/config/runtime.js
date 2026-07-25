'use strict';

const path = require('node:path');

function parseBoolean(value, fallback = false) {
    const text = String(value ?? '').trim().toLowerCase();
    if (!text) return fallback;
    if (['1', 'true', 'yes', 'on'].includes(text)) return true;
    if (['0', 'false', 'no', 'off'].includes(text)) return false;
    return fallback;
}

function parsePort(value, fallback) {
    const candidate = String(value ?? '').trim() || String(fallback ?? '').trim();
    const port = Number(candidate);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
        const error = new Error(`PORT must be an integer between 0 and 65535: ${candidate || '<empty>'}`);
        error.code = 'runtime_port_invalid';
        throw error;
    }
    return port;
}

function resolveDataRoot(projectRoot, configuredValue) {
    const configured = String(configuredValue || '').trim();
    if (!configured) return path.join(projectRoot, 'data');
    return path.isAbsolute(configured)
        ? path.normalize(configured)
        : path.resolve(projectRoot, configured);
}

function readRuntimeConfig(options = {}) {
    const env = options.env || process.env;
    const server = options.server || {};
    const projectRoot = path.resolve(options.projectRoot || path.join(__dirname, '../..'));
    const nodeEnv = String(env.NODE_ENV || 'development').trim().toLowerCase();
    return Object.freeze({
        projectRoot,
        dataRoot: resolveDataRoot(projectRoot, env.DATA_ROOT),
        port: parsePort(env.PORT, server.port || 3000),
        host: String(env.HOST || server.host || '127.0.0.1').trim() || '127.0.0.1',
        nodeEnv,
        aiFeaturesEnabled: parseBoolean(env.AI_FEATURES_ENABLED, false),
        signatureHealthMonitorEnabled: parseBoolean(
            env.SIGNATURE_HEALTH_MONITOR_ENABLED,
            nodeEnv !== 'test'
        ),
    });
}

module.exports = {
    parseBoolean,
    parsePort,
    readRuntimeConfig,
    resolveDataRoot,
};
