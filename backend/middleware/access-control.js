'use strict';

const crypto = require('crypto');
const net = require('net');
const { OidcJwtVerifier, authError } = require('../services/oidc-verifier');

const ROLE_LEVEL = Object.freeze({
    viewer: 1,
    reviewer: 2,
    operator: 3,
    admin: 4
});
const REQUEST_ID_PATTERN = /^[a-zA-Z0-9._:-]{8,128}$/;

function parseBoolean(value, fallback = false) {
    if (value === undefined || value === null || value === '') return fallback;
    return /^(1|true|yes|on)$/i.test(String(value));
}

function parseList(value) {
    if (Array.isArray(value)) return value.map(item => String(item || '').trim()).filter(Boolean);
    return String(value || '').split(/[\s,]+/).map(item => item.trim()).filter(Boolean);
}

function parseRoleMap(value) {
    if (!value) return {};
    try {
        const parsed = typeof value === 'string' ? JSON.parse(value) : value;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid map');
        return Object.fromEntries(Object.entries(parsed).map(([key, role]) => [String(key), String(role)]));
    } catch {
        throw authError('auth_role_map_invalid', 'AUTH_ROLE_MAP_JSON must be a JSON object', 503);
    }
}

function normalizeIp(value) {
    const text = String(value || '').trim().toLowerCase();
    return text.startsWith('::ffff:') ? text.slice(7) : text;
}

function ipv4ToInt(value) {
    if (net.isIP(value) !== 4) return null;
    return value.split('.').reduce((result, part) => ((result << 8) | Number(part)) >>> 0, 0);
}

function addressMatchesRule(address, rule) {
    const normalizedAddress = normalizeIp(address);
    const normalizedRule = normalizeIp(rule);
    if (!normalizedRule.includes('/')) return normalizedAddress === normalizedRule;
    const [network, prefixText] = normalizedRule.split('/');
    const prefix = Number(prefixText);
    const addressInt = ipv4ToInt(normalizedAddress);
    const networkInt = ipv4ToInt(network);
    if (addressInt === null || networkInt === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
        return false;
    }
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return (addressInt & mask) === (networkInt & mask);
}

function readAuthConfig(env = process.env) {
    const production = String(env.NODE_ENV || '').toLowerCase() === 'production';
    const mode = String(env.AUTH_MODE || (production ? '' : 'disabled')).trim().toLowerCase();
    if (!['disabled', 'trusted_proxy', 'oidc'].includes(mode)) {
        throw authError(
            'auth_mode_invalid',
            'AUTH_MODE must be disabled, trusted_proxy or oidc',
            503
        );
    }
    if (production && mode === 'disabled') {
        throw authError('auth_required_in_production', 'Production cannot start with AUTH_MODE=disabled', 503);
    }

    const config = {
        mode,
        production,
        trustedProxyIps: parseList(env.AUTH_TRUSTED_PROXY_IPS),
        userHeader: String(env.AUTH_USER_HEADER || 'x-auth-request-user').toLowerCase(),
        emailHeader: String(env.AUTH_EMAIL_HEADER || 'x-auth-request-email').toLowerCase(),
        rolesHeader: String(env.AUTH_ROLES_HEADER || 'x-auth-request-roles').toLowerCase(),
        scopesHeader: String(env.AUTH_SCOPES_HEADER || 'x-auth-request-scopes').toLowerCase(),
        issuer: String(env.AUTH_OIDC_ISSUER || '').trim(),
        audience: String(env.AUTH_OIDC_AUDIENCE || '').trim(),
        jwksUri: String(env.AUTH_OIDC_JWKS_URI || '').trim(),
        algorithms: parseList(env.AUTH_OIDC_ALGORITHMS || 'RS256'),
        rolesClaim: String(env.AUTH_ROLES_CLAIM || 'roles').trim(),
        scopesClaim: String(env.AUTH_SCOPES_CLAIM || 'scope').trim(),
        requiredScope: String(env.AUTH_REQUIRED_SCOPE || '').trim(),
        defaultRole: String(env.AUTH_DEFAULT_ROLE || 'viewer').trim(),
        roleMap: parseRoleMap(env.AUTH_ROLE_MAP_JSON),
        allowInsecureOidcHttp: !production && parseBoolean(env.AUTH_OIDC_ALLOW_HTTP, false)
    };

    if (!ROLE_LEVEL[config.defaultRole]) {
        throw authError('auth_default_role_invalid', 'AUTH_DEFAULT_ROLE is invalid', 503);
    }
    if (mode === 'trusted_proxy' && config.trustedProxyIps.length === 0) {
        throw authError('auth_trusted_proxy_not_configured', 'AUTH_TRUSTED_PROXY_IPS is required', 503);
    }
    for (const header of [config.userHeader, config.emailHeader, config.rolesHeader, config.scopesHeader]) {
        if (!/^x-[a-z0-9-]{1,62}$/.test(header)) {
            throw authError('auth_header_invalid', 'Trusted identity headers must use x-* header names', 503);
        }
    }
    return config;
}

function claimAtPath(claims, path) {
    return String(path || '').split('.').filter(Boolean).reduce((value, key) => {
        if (!value || typeof value !== 'object') return undefined;
        return value[key];
    }, claims);
}

function mapRoles(rawRoles, config) {
    const mapped = parseList(rawRoles)
        .map(role => config.roleMap[role] || role)
        .filter(role => ROLE_LEVEL[role]);
    return Array.from(new Set(mapped.length > 0 ? mapped : [config.defaultRole]));
}

function maxRoleLevel(roles) {
    return Math.max(0, ...parseList(roles).map(role => ROLE_LEVEL[role] || 0));
}

function requiredRoleForRequest(method, path) {
    const normalizedMethod = String(method || 'GET').toUpperCase();
    const normalizedPath = String(path || '').split('?')[0];
    if (normalizedMethod === 'OPTIONS') return null;

    if (/^\/api\/settings\/ai-agent(?:\/models)?$/.test(normalizedPath) && normalizedMethod === 'GET') {
        return 'operator';
    }
    if (/^\/api\/settings\/ai-agent$/.test(normalizedPath)) {
        return 'admin';
    }
    if (/^\/api\/(settings\/network|sync\/nodes|schedules|crawler\/run-quota|self-heal\/settings)(?:\/|$)/.test(normalizedPath)) {
        return 'admin';
    }
    if (/^\/api\/audit(?:\/|$)/.test(normalizedPath)) {
        return 'admin';
    }
    if (/^\/api\/(signature\/corpus|price-schedules\/backfill|stations\/deduplicate)(?:\/|$)/.test(normalizedPath)) {
        return 'admin';
    }
    if (/^\/api\/(export\/|blue-team\/reports\/[^/]+\/download)/.test(normalizedPath)) {
        return 'reviewer';
    }
    if (/^\/api\/ocr-review\/(approve|reject)\//.test(normalizedPath)) {
        return 'reviewer';
    }
    if (/^\/api\/blue-team\/reports\/[^/]+\/(sanitize|finalize|retest)$/.test(normalizedPath)) {
        return 'reviewer';
    }
    if (/^\/api\/(global-agent\/(chat|actions)|ai-agent\/|mobile-control\/)/.test(normalizedPath)) {
        return 'operator';
    }
    if (/^\/api\/templates(?:\/|$)/.test(normalizedPath)) {
        return 'operator';
    }
    if (['GET', 'HEAD'].includes(normalizedMethod)) return 'viewer';
    return 'operator';
}

function isDelegatedMachineRoute(path) {
    const normalized = String(path || '').split('?')[0];
    return normalized.startsWith('/api/sync/receive/')
        || normalized === '/api/sync/receive/check'
        || normalized.startsWith('/api/mobile-sync/')
        || normalized.startsWith('/api/edge/v1/');
}

function isPublicRoute(method, path) {
    return String(method || '').toUpperCase() === 'OPTIONS'
        || ['/api/health', '/api/readiness'].includes(String(path || '').split('?')[0]);
}

function readBearerToken(req) {
    const header = String(req.headers?.authorization || '').trim();
    return header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
}

function resourceFromPath(path) {
    const segments = String(path || '').split('?')[0].split('/').filter(Boolean);
    return segments.slice(1, 4).join('/') || 'api';
}

function shouldAuditRequest(method, path, statusCode) {
    const normalizedMethod = String(method || 'GET').toUpperCase();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(normalizedMethod)) return true;
    if (Number(statusCode) >= 400) return true;
    return /^\/api\/(export\/|settings\/|sync\/nodes|blue-team\/reports\/[^/]+\/download)/.test(path);
}

function createAccessControl(options = {}) {
    const config = options.config || readAuthConfig(options.env || process.env);
    const verifier = options.verifier || (config.mode === 'oidc'
        ? new OidcJwtVerifier({
            issuer: config.issuer,
            audience: config.audience,
            jwksUri: config.jwksUri,
            algorithms: config.algorithms,
            allowInsecureHttp: config.allowInsecureOidcHttp
        })
        : null);
    const auditRecorder = typeof options.auditRecorder === 'function' ? options.auditRecorder : null;

    async function authenticate(req) {
        if (config.mode === 'disabled') {
            return {
                subject: 'development-user',
                email: null,
                roles: ['admin'],
                scopes: config.requiredScope ? [config.requiredScope] : [],
                mode: 'disabled'
            };
        }

        if (config.mode === 'trusted_proxy') {
            const remoteAddress = normalizeIp(req.socket?.remoteAddress);
            if (!config.trustedProxyIps.some(rule => addressMatchesRule(remoteAddress, rule))) {
                throw authError('auth_untrusted_proxy', 'Request did not arrive from a trusted identity proxy');
            }
            const subject = String(req.headers?.[config.userHeader] || '').trim();
            if (!subject || subject.length > 255) {
                throw authError('auth_identity_missing', 'Authenticated user identity is missing');
            }
            return {
                subject,
                email: String(req.headers?.[config.emailHeader] || '').trim() || null,
                roles: mapRoles(req.headers?.[config.rolesHeader], config),
                scopes: parseList(req.headers?.[config.scopesHeader]),
                mode: 'trusted_proxy'
            };
        }

        const token = readBearerToken(req);
        if (!token) throw authError('auth_bearer_required', 'Bearer authentication is required');
        const { claims } = await verifier.verify(token);
        return {
            subject: String(claims.sub),
            email: String(claims.email || '').trim() || null,
            roles: mapRoles(claimAtPath(claims, config.rolesClaim), config),
            scopes: parseList(claimAtPath(claims, config.scopesClaim) || claims.scp),
            mode: 'oidc',
            issuer: claims.iss
        };
    }

    return async function accessControl(req, res, next) {
        const path = String(req.originalUrl || req.url || '').split('?')[0];
        if (!path.startsWith('/api/')) return next();

        const suppliedRequestId = String(req.headers?.['x-request-id'] || '').trim();
        req.requestId = req.requestId
            || (REQUEST_ID_PATTERN.test(suppliedRequestId) ? suppliedRequestId : crypto.randomUUID());
        res.setHeader('x-request-id', req.requestId);
        const startedAt = Date.now();
        res.once('finish', () => {
            if (!auditRecorder || !shouldAuditRequest(req.method, path, res.statusCode)) return;
            try {
                auditRecorder({
                    eventId: crypto.randomUUID(),
                    requestId: req.requestId,
                    actorId: req.auth?.subject
                        || req.edgePrincipal?.nodeId
                        || req.syncPrincipal?.type
                        || req.mobilePrincipal?.type
                        || 'anonymous',
                    authMode: req.auth?.mode
                        || (req.edgePrincipal ? 'edge_session'
                            : (req.syncPrincipal ? 'sync_token' : (req.mobilePrincipal ? 'device_token' : 'none'))),
                    roles: req.auth?.roles || [],
                    action: String(req.method || 'GET').toUpperCase(),
                    resource: resourceFromPath(path),
                    method: req.method,
                    path,
                    statusCode: res.statusCode,
                    outcome: res.statusCode < 400 ? 'success' : 'denied_or_failed',
                    remoteAddress: normalizeIp(req.socket?.remoteAddress),
                    userAgent: String(req.headers?.['user-agent'] || '').slice(0, 512),
                    durationMs: Date.now() - startedAt
                });
            } catch (error) {
                console.warn('审计事件写入失败:', error.message);
            }
        });

        if (isPublicRoute(req.method, path) || isDelegatedMachineRoute(path)) return next();

        try {
            req.auth = await authenticate(req);
            if (config.requiredScope && !req.auth.scopes.includes(config.requiredScope)) {
                throw authError('auth_scope_forbidden', 'Required product scope is missing', 403);
            }
            const requiredRole = requiredRoleForRequest(req.method, path);
            if (requiredRole && maxRoleLevel(req.auth.roles) < ROLE_LEVEL[requiredRole]) {
                throw authError('auth_role_forbidden', `Role ${requiredRole} or higher is required`, 403);
            }
            return next();
        } catch (error) {
            const statusCode = error.statusCode || 401;
            if (statusCode === 401) res.setHeader('WWW-Authenticate', 'Bearer realm="blue-team"');
            return res.status(statusCode).json({
                success: false,
                error: error.message || 'Access denied',
                code: error.code || 'auth_failed',
                requestId: req.requestId
            });
        }
    };
}

module.exports = {
    ROLE_LEVEL,
    addressMatchesRule,
    claimAtPath,
    createAccessControl,
    isDelegatedMachineRoute,
    isPublicRoute,
    mapRoles,
    maxRoleLevel,
    readAuthConfig,
    requiredRoleForRequest
};
