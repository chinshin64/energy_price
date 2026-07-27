'use strict';

const crypto = require('node:crypto');

function digest(value) {
    return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest();
}

function safeEqual(left, right) {
    return crypto.timingSafeEqual(digest(left), digest(right));
}

function normalizeConfiguredToken(token) {
    if (Array.isArray(token)) {
        const tokens = token
            .map(value => String(value || '').trim())
            .filter(value => value.length > 0);
        return tokens.length > 0 ? tokens : '';
    }
    const value = String(token || '').trim();
    return value.length > 0 ? value : '';
}

function matchesConfiguredToken(supplied, configuredToken) {
    if (Array.isArray(configuredToken)) {
        return configuredToken.some(candidate => safeEqual(supplied, candidate));
    }
    return safeEqual(supplied, configuredToken);
}

function readBearer(req, alternateHeader) {
    const authorization = String(req.headers?.authorization || '').trim();
    if (authorization.toLowerCase().startsWith('bearer ')) {
        return authorization.slice(7).trim();
    }
    return String(req.headers?.[alternateHeader] || '').trim();
}

function createMachineAuth(options = {}) {
    const configuredToken = normalizeConfiguredToken(options.token);
    const header = String(options.header || 'x-machine-token').toLowerCase();
    const realm = String(options.realm || 'mobile-source');
    const required = options.required !== false;

    return function machineAuth(req, res, next) {
        if (!configuredToken || (Array.isArray(configuredToken) && configuredToken.length === 0)) {
            if (!required) return next();
            return res.status(503).json({
                success: false,
                code: 'machine_auth_not_configured',
                error: 'machine authentication is not configured',
                requestId: req.requestId,
            });
        }
        const supplied = readBearer(req, header);
        if (!supplied || !matchesConfiguredToken(supplied, configuredToken)) {
            res.setHeader('WWW-Authenticate', `Bearer realm="${realm}"`);
            return res.status(401).json({
                success: false,
                code: 'machine_auth_failed',
                error: 'machine authentication failed',
                requestId: req.requestId,
            });
        }
        return next();
    };
}

module.exports = {
    createMachineAuth,
    readBearer,
    safeEqual,
};
