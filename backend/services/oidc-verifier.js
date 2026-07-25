'use strict';

const crypto = require('crypto');

const VERIFY_ALGORITHMS = {
    RS256: { digest: 'sha256', keyType: 'RSA' },
    RS384: { digest: 'sha384', keyType: 'RSA' },
    RS512: { digest: 'sha512', keyType: 'RSA' },
    PS256: { digest: 'sha256', keyType: 'RSA', padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 },
    PS384: { digest: 'sha384', keyType: 'RSA', padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 48 },
    PS512: { digest: 'sha512', keyType: 'RSA', padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 64 },
    ES256: { digest: 'sha256', keyType: 'EC', dsaEncoding: 'ieee-p1363' },
    ES384: { digest: 'sha384', keyType: 'EC', dsaEncoding: 'ieee-p1363' },
    ES512: { digest: 'sha512', keyType: 'EC', dsaEncoding: 'ieee-p1363' }
};

function authError(code, message, statusCode = 401) {
    const error = new Error(message);
    error.code = code;
    error.statusCode = statusCode;
    return error;
}

function parseJsonPart(value, label) {
    try {
        const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not object');
        return parsed;
    } catch {
        throw authError('auth_invalid_token', `JWT ${label} is invalid`);
    }
}

function normalizeList(value) {
    if (Array.isArray(value)) return value.map(item => String(item || '').trim()).filter(Boolean);
    return String(value || '').split(',').map(item => item.trim()).filter(Boolean);
}

class OidcJwtVerifier {
    constructor(options = {}) {
        this.issuer = String(options.issuer || '').trim();
        this.audience = String(options.audience || '').trim();
        this.jwksUri = String(options.jwksUri || '').trim();
        this.allowedAlgorithms = new Set(normalizeList(options.algorithms || ['RS256']));
        this.fetch = options.fetch || global.fetch;
        this.clockToleranceSec = Math.max(0, Math.min(300, Number(options.clockToleranceSec) || 60));
        this.cacheTtlMs = Math.max(1000, Math.min(60 * 60 * 1000, Number(options.cacheTtlMs) || 5 * 60 * 1000));
        this.fetchTimeoutMs = Math.max(1000, Math.min(30000, Number(options.fetchTimeoutMs) || 5000));
        this.allowInsecureHttp = options.allowInsecureHttp === true;
        this.cache = null;
        this.validateConfig();
    }

    validateConfig() {
        if (!this.issuer || !this.audience || !this.jwksUri) {
            throw authError(
                'auth_oidc_not_configured',
                'OIDC issuer, audience and JWKS URI are required',
                503
            );
        }
        for (const alg of this.allowedAlgorithms) {
            if (!VERIFY_ALGORITHMS[alg]) {
                throw authError('auth_oidc_algorithm_invalid', `Unsupported OIDC JWT algorithm: ${alg}`, 503);
            }
        }
        for (const [label, value] of [['issuer', this.issuer], ['JWKS URI', this.jwksUri]]) {
            let parsed;
            try {
                parsed = new URL(value);
            } catch {
                throw authError('auth_oidc_url_invalid', `OIDC ${label} must be an absolute URL`, 503);
            }
            if (!this.allowInsecureHttp && parsed.protocol !== 'https:') {
                throw authError('auth_oidc_https_required', `OIDC ${label} must use HTTPS`, 503);
            }
            if (parsed.username || parsed.password || parsed.hash || (label === 'issuer' && parsed.search)) {
                throw authError('auth_oidc_url_invalid', `OIDC ${label} cannot contain credentials or fragments`, 503);
            }
        }
    }

    async verify(token) {
        const raw = String(token || '').trim();
        if (!raw || raw.length > 16384) {
            throw authError('auth_invalid_token', 'Bearer token is missing or too large');
        }
        const parts = raw.split('.');
        if (parts.length !== 3 || parts.some(part => !part)) {
            throw authError('auth_invalid_token', 'Bearer token is not a signed JWT');
        }

        const header = parseJsonPart(parts[0], 'header');
        const claims = parseJsonPart(parts[1], 'payload');
        const alg = String(header.alg || '');
        if (!this.allowedAlgorithms.has(alg) || !VERIFY_ALGORITHMS[alg]) {
            throw authError('auth_invalid_token', 'JWT signing algorithm is not allowed');
        }
        if (header.crit !== undefined) {
            throw authError('auth_invalid_token', 'JWT critical headers are not supported');
        }

        const key = await this.resolveVerificationKey(header, alg);
        const signature = Buffer.from(parts[2], 'base64url');
        const signingInput = Buffer.from(`${parts[0]}.${parts[1]}`, 'ascii');
        const algorithm = VERIFY_ALGORITHMS[alg];
        const verified = crypto.verify(algorithm.digest, signingInput, {
            key,
            ...(algorithm.padding ? { padding: algorithm.padding, saltLength: algorithm.saltLength } : {}),
            ...(algorithm.dsaEncoding ? { dsaEncoding: algorithm.dsaEncoding } : {})
        }, signature);
        if (!verified) throw authError('auth_invalid_token', 'JWT signature verification failed');

        this.validateClaims(claims);
        return { header, claims };
    }

    validateClaims(claims) {
        const now = Math.floor(Date.now() / 1000);
        const tolerance = this.clockToleranceSec;
        if (String(claims.iss || '') !== this.issuer) {
            throw authError('auth_invalid_token', 'JWT issuer does not match');
        }
        const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
        if (!audiences.map(String).includes(this.audience)) {
            throw authError('auth_invalid_token', 'JWT audience does not match');
        }
        if (audiences.length > 1 && String(claims.azp || '') !== this.audience) {
            throw authError('auth_invalid_token', 'JWT authorized party does not match');
        }
        if (!Number.isFinite(Number(claims.exp)) || now >= Number(claims.exp) + tolerance) {
            throw authError('auth_invalid_token', 'JWT has expired or has no valid expiration');
        }
        if (claims.nbf !== undefined) {
            if (!Number.isFinite(Number(claims.nbf)) || now + tolerance < Number(claims.nbf)) {
                throw authError('auth_invalid_token', 'JWT is not active yet');
            }
        }
        if (claims.iat !== undefined) {
            if (!Number.isFinite(Number(claims.iat)) || Number(claims.iat) > now + tolerance) {
                throw authError('auth_invalid_token', 'JWT issued-at time is invalid');
            }
        }
        if (!String(claims.sub || '').trim() || String(claims.sub).length > 255) {
            throw authError('auth_invalid_token', 'JWT subject is missing or invalid');
        }
    }

    async resolveVerificationKey(header, alg) {
        let keys = await this.getJwks(false);
        let jwk = this.selectKey(keys, header, alg);
        if (!jwk) {
            keys = await this.getJwks(true);
            jwk = this.selectKey(keys, header, alg);
        }
        if (!jwk) throw authError('auth_invalid_token', 'No matching JWT verification key was found');
        try {
            return crypto.createPublicKey({ key: jwk, format: 'jwk' });
        } catch {
            throw authError('auth_invalid_token', 'JWT verification key is invalid');
        }
    }

    selectKey(keys, header, alg) {
        const expectedType = VERIFY_ALGORITHMS[alg].keyType;
        const candidates = keys.filter(key => {
            if (!key || key.kty !== expectedType) return false;
            if (header.kid && key.kid !== header.kid) return false;
            if (!header.kid && keys.length > 1) return false;
            if (key.use && key.use !== 'sig') return false;
            if (Array.isArray(key.key_ops) && !key.key_ops.includes('verify')) return false;
            if (key.alg && key.alg !== alg) return false;
            return true;
        });
        return candidates.length === 1 ? candidates[0] : null;
    }

    async getJwks(forceRefresh) {
        if (!forceRefresh && this.cache && this.cache.expiresAt > Date.now()) {
            return this.cache.keys;
        }
        if (typeof this.fetch !== 'function') {
            throw authError('auth_jwks_unavailable', 'JWKS fetch implementation is unavailable', 503);
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.fetchTimeoutMs);
        try {
            const response = await this.fetch(this.jwksUri, {
                method: 'GET',
                headers: { Accept: 'application/json' },
                redirect: 'error',
                signal: controller.signal
            });
            if (!response?.ok) throw new Error(`status ${response?.status || 0}`);
            const payload = await response.json();
            const keys = Array.isArray(payload?.keys) ? payload.keys : [];
            if (keys.length === 0 || keys.length > 100) throw new Error('invalid key count');
            this.cache = { keys, expiresAt: Date.now() + this.cacheTtlMs };
            return keys;
        } catch {
            throw authError('auth_jwks_unavailable', 'OIDC verification keys are unavailable', 503);
        } finally {
            clearTimeout(timeout);
        }
    }
}

module.exports = {
    OidcJwtVerifier,
    authError,
    VERIFY_ALGORITHMS
};
