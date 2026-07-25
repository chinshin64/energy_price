'use strict';

function parseBoolean(value, fallback = false) {
    if (value === undefined || value === null || value === '') return fallback;
    return /^(1|true|yes|on)$/i.test(String(value));
}

function normalizeOrigin(value) {
    const text = String(value || '').trim();
    if (!text) return '';
    try {
        const url = new URL(text);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
            throw new Error('invalid origin');
        }
        return url.origin;
    } catch {
        const error = new Error(`Invalid CORS origin: ${text}`);
        error.code = 'cors_origin_invalid';
        error.statusCode = 503;
        throw error;
    }
}

function readCorsPolicy(options = {}) {
    const env = options.env || process.env;
    const port = Number(options.port || env.PORT || 3000);
    const production = String(env.NODE_ENV || '').toLowerCase() === 'production';
    const configured = String(env.CORS_ALLOWED_ORIGINS || '').split(',').map(item => item.trim()).filter(Boolean);
    const defaults = production ? [] : [
        `http://localhost:${port}`,
        `http://127.0.0.1:${port}`
    ];
    const allowedOrigins = new Set((configured.length > 0 ? configured : defaults).map(normalizeOrigin));
    return {
        allowedOrigins,
        credentials: parseBoolean(env.CORS_ALLOW_CREDENTIALS, false),
        production
    };
}

function corsDenied(origin) {
    const error = new Error(`Cross-origin request is not allowed: ${origin}`);
    error.code = 'cors_origin_denied';
    error.statusCode = 403;
    return error;
}

function createCorsOptions(policy) {
    return {
        origin(origin, callback) {
            if (!origin || policy.allowedOrigins.has(origin)) return callback(null, true);
            return callback(corsDenied(origin));
        },
        credentials: policy.credentials,
        methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id', 'X-Sync-Token', 'X-Mobile-Sync-Token'],
        exposedHeaders: ['X-Request-Id'],
        maxAge: 600
    };
}

function createOriginGuard(policy) {
    return function originGuard(req, res, next) {
        const origin = String(req.headers?.origin || '').trim();
        if (!origin || policy.allowedOrigins.has(origin)) return next();
        const error = corsDenied(origin);
        return res.status(error.statusCode).json({
            success: false,
            error: error.message,
            code: error.code,
            requestId: req.requestId
        });
    };
}

module.exports = {
    createCorsOptions,
    createOriginGuard,
    normalizeOrigin,
    readCorsPolicy
};
