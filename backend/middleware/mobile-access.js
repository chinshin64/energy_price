'use strict';

const { parseBoolean } = require('../config/runtime');
const { timingSafeStringEqual } = require('./sync-auth');

function readMobileSyncSettings(config = {}, env = process.env) {
    const settings = config.mobileSync || {};
    const tokenHeader = String(settings.tokenHeader || 'x-mobile-sync-token').toLowerCase();
    const production = String(env.NODE_ENV || '').toLowerCase() === 'production';
    const token = String(env.MOBILE_SYNC_TOKEN || (!production ? settings.authToken : '') || '').trim();
    const configuredRequired = parseBoolean(env.MOBILE_SYNC_AUTH_REQUIRED, false)
        || settings.authRequired === true
        || Boolean(token);
    return {
        enabled: settings.enabled !== false,
        authRequired: production || configuredRequired,
        tokenHeader,
        token,
        authConfigured: Boolean(token),
    };
}

function getMobileSyncTokenFromRequest(req, tokenHeader) {
    const authHeader = String(req.headers.authorization || '').trim();
    if (authHeader.toLowerCase().startsWith('bearer ')) {
        return authHeader.slice(7).trim();
    }
    return String(req.headers[tokenHeader] || '').trim();
}

function isMobileControlRequest(req) {
    const requestPath = String(req.originalUrl || req.url || req.path || '');
    return requestPath.startsWith('/api/mobile-control') || String(req.baseUrl || '').startsWith('/api/mobile-control');
}

function createMobileAccess(options = {}) {
    const config = options.config || {};
    const env = options.env || process.env;
    const tokenEquals = options.tokenEquals || timingSafeStringEqual;
    const getSettings = () => readMobileSyncSettings(config, env);

    function middleware(req, res, next) {
        const settings = getSettings();
        if (!settings.enabled) {
            return res.status(404).json({
                success: false,
                error: 'mobile sync disabled',
                code: 'mobile_sync_disabled',
                requestId: req.requestId,
            });
        }
        if (req.mobilePrincipal?.type === 'mobile-device') return next();
        if (isMobileControlRequest(req) && req.auth?.subject) return next();
        if (!settings.authRequired) return next();
        if (!settings.authConfigured) {
            return res.status(503).json({
                success: false,
                error: 'mobile sync authentication is not configured',
                code: 'mobile_sync_auth_not_configured',
                requestId: req.requestId,
            });
        }
        const requestToken = getMobileSyncTokenFromRequest(req, settings.tokenHeader);
        if (!requestToken || !tokenEquals(requestToken, settings.token)) {
            res.setHeader('WWW-Authenticate', 'Bearer realm="mobile-sync"');
            return res.status(401).json({
                success: false,
                error: 'mobile sync authentication failed',
                code: 'mobile_sync_auth_failed',
                requestId: req.requestId,
            });
        }
        req.mobilePrincipal = { type: 'mobile-device' };
        req.auth = {
            subject: 'mobile-device',
            email: null,
            roles: ['device'],
            scopes: ['mobile:sync'],
            mode: 'device_token',
        };
        return next();
    }

    return { getSettings, middleware };
}

module.exports = {
    createMobileAccess,
    getMobileSyncTokenFromRequest,
    isMobileControlRequest,
    readMobileSyncSettings,
};
