'use strict';

const REQUIRED_NON_EMPTY_FIELDS = Object.freeze([
    'appKey',
    'appSecret',
    'host',
    'userAgent',
    'referer',
    'mpVersion',
    'shumeiID',
]);

const REQUIRED_EXPLICIT_FIELDS = Object.freeze([
    'token',
    'fromScanCode',
]);

function credentialError(code = 'tuanyou_credentials_required') {
    const error = new Error('Tuanyou backend credential configuration is unavailable');
    error.code = code;
    error.statusCode = 503;
    return error;
}

function own(source, key) {
    return Object.prototype.hasOwnProperty.call(source, key);
}

function normalizedHttpsUrl(value, originOnly) {
    let parsed;
    try {
        parsed = new URL(String(value || '').trim());
    } catch {
        throw credentialError('tuanyou_credentials_invalid');
    }
    if (parsed.protocol !== 'https:'
            || parsed.username
            || parsed.password
            || parsed.search
            || parsed.hash
            || (originOnly && parsed.pathname !== '/' && parsed.pathname !== '')) {
        throw credentialError('tuanyou_credentials_invalid');
    }
    return originOnly ? parsed.origin : parsed.toString();
}

class TuanyouCredentialProvider {
    #credentials;
    #presence;

    constructor(values = {}) {
        this.#presence = new Set([
            ...REQUIRED_NON_EMPTY_FIELDS.filter(field => own(values, field)),
            ...REQUIRED_EXPLICIT_FIELDS.filter(field => own(values, field)),
        ]);
        this.#credentials = Object.freeze({
            appKey: String(values.appKey || '').trim(),
            appSecret: String(values.appSecret || '').trim(),
            host: String(values.host || '').trim(),
            userAgent: String(values.userAgent || '').trim(),
            referer: String(values.referer || '').trim(),
            mpVersion: String(values.mpVersion || '').trim(),
            shumeiID: String(values.shumeiID || '').trim(),
            token: String(values.token ?? '').trim(),
            fromScanCode: String(values.fromScanCode ?? '').trim(),
        });
    }

    static fromEnvironment(env = process.env) {
        const values = {
            appKey: env.TUANYOU_APP_KEY,
            appSecret: env.TUANYOU_APP_SECRET,
            host: env.TUANYOU_HOST,
            userAgent: env.TUANYOU_USER_AGENT,
            referer: env.TUANYOU_REFERER,
            mpVersion: env.TUANYOU_MP_VERSION,
            shumeiID: env.TUANYOU_SHUMEI_ID,
        };
        if (own(env, 'TUANYOU_TOKEN')) values.token = env.TUANYOU_TOKEN;
        if (own(env, 'TUANYOU_FROM_SCAN_CODE')) values.fromScanCode = env.TUANYOU_FROM_SCAN_CODE;
        return new TuanyouCredentialProvider(values);
    }

    requireCredentials() {
        const missingNonEmpty = REQUIRED_NON_EMPTY_FIELDS.some(field =>
            !this.#presence.has(field) || !this.#credentials[field]
        );
        const missingExplicit = REQUIRED_EXPLICIT_FIELDS.some(field => !this.#presence.has(field));
        if (missingNonEmpty || missingExplicit) throw credentialError();

        const host = normalizedHttpsUrl(this.#credentials.host, true);
        const referer = normalizedHttpsUrl(this.#credentials.referer, false);
        return Object.freeze({
            ...this.#credentials,
            host,
            referer,
        });
    }

    assertRequestUrl(value) {
        const credentials = this.requireCredentials();
        let requestUrl;
        try {
            requestUrl = new URL(String(value || ''));
        } catch {
            throw credentialError('tuanyou_request_target_invalid');
        }
        if (requestUrl.protocol !== 'https:'
                || requestUrl.username
                || requestUrl.password
                || requestUrl.origin !== credentials.host) {
            throw credentialError('tuanyou_request_target_invalid');
        }
        return credentials;
    }

    isConfigured() {
        try {
            this.requireCredentials();
            return true;
        } catch {
            return false;
        }
    }

    toJSON() {
        return { configured: this.isConfigured() };
    }
}

module.exports = {
    REQUIRED_EXPLICIT_FIELDS,
    REQUIRED_NON_EMPTY_FIELDS,
    TuanyouCredentialProvider,
    credentialError,
};
