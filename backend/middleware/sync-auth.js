'use strict';

const crypto = require('crypto');

function parseBoolean(value, fallback = false) {
    if (value === undefined || value === null || value === '') {
        return fallback;
    }
    return /^(1|true|yes|on)$/i.test(String(value));
}

function readSyncToken(req) {
    const authorization = String(req.headers?.authorization || '').trim();
    if (authorization.toLowerCase().startsWith('bearer ')) {
        return authorization.slice(7).trim();
    }
    return String(req.headers?.['x-sync-token'] || '').trim();
}

function timingSafeStringEqual(left, right) {
    const leftDigest = crypto.createHash('sha256').update(String(left || ''), 'utf8').digest();
    const rightDigest = crypto.createHash('sha256').update(String(right || ''), 'utf8').digest();
    return crypto.timingSafeEqual(leftDigest, rightDigest);
}

function defaultRequired(configuredToken) {
    if (process.env.NODE_ENV === 'production') {
        return true;
    }
    return parseBoolean(process.env.SYNC_AUTH_REQUIRED, Boolean(configuredToken));
}

function createSyncAuthMiddleware(options = {}) {
    const getConfiguredToken = typeof options.getConfiguredToken === 'function'
        ? options.getConfiguredToken
        : () => process.env.SYNC_AUTH_TOKEN || '';
    const isRequired = typeof options.isRequired === 'function'
        ? options.isRequired
        : (configuredToken) => options.required !== undefined
            ? options.required === true
            : defaultRequired(configuredToken);

    return function requireSyncToken(req, res, next) {
        const configuredToken = String(getConfiguredToken() || '').trim();
        const required = process.env.NODE_ENV === 'production' || isRequired(configuredToken) === true;

        if (!required && !configuredToken) {
            return next();
        }
        if (!configuredToken) {
            return res.status(503).json({
                success: false,
                error: 'sync authentication is not configured',
                code: 'sync_auth_not_configured'
            });
        }

        const requestToken = readSyncToken(req);
        if (!requestToken || !timingSafeStringEqual(requestToken, configuredToken)) {
            res.setHeader('WWW-Authenticate', 'Bearer realm="sync"');
            return res.status(401).json({
                success: false,
                error: 'sync authentication failed',
                code: 'sync_auth_failed'
            });
        }

        req.syncPrincipal = { type: 'sync-node' };
        req.auth = {
            subject: 'sync-node',
            email: null,
            roles: ['sync-node'],
            scopes: ['sync:receive'],
            mode: 'sync_token'
        };
        return next();
    };
}

module.exports = {
    createSyncAuthMiddleware,
    readSyncToken,
    timingSafeStringEqual,
};
