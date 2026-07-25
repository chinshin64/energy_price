'use strict';

const REQUIRED_NON_EMPTY_FIELDS = Object.freeze([
    'appKey',
    'appSecret',
    'appTerminal',
    'appName',
    'platformType',
    'terminalType',
    'host',
    'userAgent',
    'referer',
]);

const REQUIRED_EXPLICIT_FIELDS = Object.freeze([
    'token',
    'sensorId',
    'deviceId',
    'saDistinctId',
    'saAnonymousId',
]);

function credentialError(code = 'kuaidian_credentials_required') {
    const error = new Error('Kuaidian backend credential configuration is unavailable');
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
        throw credentialError('kuaidian_credentials_invalid');
    }
    if (parsed.protocol !== 'https:'
            || parsed.username
            || parsed.password
            || parsed.search
            || parsed.hash
            || (originOnly && parsed.pathname !== '/' && parsed.pathname !== '')) {
        throw credentialError('kuaidian_credentials_invalid');
    }
    return originOnly ? parsed.origin : parsed.toString();
}

class KuaidianCredentialProvider {
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
            appTerminal: String(values.appTerminal || '').trim(),
            appName: String(values.appName || '').trim(),
            platformType: String(values.platformType || '').trim(),
            terminalType: String(values.terminalType || '').trim(),
            host: String(values.host || '').trim(),
            userAgent: String(values.userAgent || '').trim(),
            referer: String(values.referer || '').trim(),
            token: String(values.token ?? '').trim(),
            sensorId: String(values.sensorId ?? '').trim(),
            deviceId: String(values.deviceId ?? '').trim(),
            saDistinctId: String(values.saDistinctId ?? '').trim(),
            saAnonymousId: String(values.saAnonymousId ?? '').trim(),
        });
    }

    static fromEnvironment(env = process.env) {
        const values = {
            appKey: env.KUAIDIAN_APP_KEY,
            appSecret: env.KUAIDIAN_APP_SECRET,
            appTerminal: env.KUAIDIAN_APP_TERMINAL,
            appName: env.KUAIDIAN_APP_NAME,
            platformType: env.KUAIDIAN_PLATFORM_TYPE,
            terminalType: env.KUAIDIAN_TERMINAL_TYPE,
            host: env.KUAIDIAN_HOST,
            userAgent: env.KUAIDIAN_USER_AGENT,
            referer: env.KUAIDIAN_REFERER,
        };
        const optionalMappings = {
            KUAIDIAN_TOKEN: 'token',
            KUAIDIAN_SENSOR_ID: 'sensorId',
            KUAIDIAN_DEVICE_ID: 'deviceId',
            KUAIDIAN_SA_DISTINCT_ID: 'saDistinctId',
            KUAIDIAN_SA_ANONYMOUS_ID: 'saAnonymousId',
        };
        for (const [environmentKey, field] of Object.entries(optionalMappings)) {
            if (own(env, environmentKey)) values[field] = env[environmentKey];
        }
        return new KuaidianCredentialProvider(values);
    }

    requireCredentials() {
        const missingNonEmpty = REQUIRED_NON_EMPTY_FIELDS.some(field =>
            !this.#presence.has(field) || !this.#credentials[field]
        );
        const missingExplicit = REQUIRED_EXPLICIT_FIELDS.some(field => !this.#presence.has(field));
        if (missingNonEmpty || missingExplicit) throw credentialError();
        return Object.freeze({
            ...this.#credentials,
            host: normalizedHttpsUrl(this.#credentials.host, true),
            referer: normalizedHttpsUrl(this.#credentials.referer, false),
        });
    }

    assertRequestUrl(value) {
        const credentials = this.requireCredentials();
        let requestUrl;
        try {
            requestUrl = new URL(String(value || ''));
        } catch {
            throw credentialError('kuaidian_request_target_invalid');
        }
        if (requestUrl.protocol !== 'https:'
                || requestUrl.username
                || requestUrl.password
                || requestUrl.origin !== credentials.host) {
            throw credentialError('kuaidian_request_target_invalid');
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
    KuaidianCredentialProvider,
    REQUIRED_EXPLICIT_FIELDS,
    REQUIRED_NON_EMPTY_FIELDS,
    credentialError,
};
