#!/usr/bin/env node
'use strict';

const DEFAULT_OS = '3';
const DEFAULT_VERSION = '2.0.34';
const MAX_SESSION_RULES = 20;
const ALGORITHMS = new Set(['fa', 'fb', 'fc', 'fd']);

function getHeader(headers, name) {
    const pair = Object.entries(headers || {})
        .find(([key]) => key.toLowerCase() === String(name).toLowerCase());
    if (!pair) return '';
    return String(Array.isArray(pair[1]) ? pair[1][0] || '' : pair[1] || '');
}

function setHeader(headers, name, value) {
    const existing = Object.keys(headers || {})
        .find(key => key.toLowerCase() === String(name).toLowerCase());
    headers[existing || name] = String(value);
}

function Vt(value, sessionId) {
    if (!sessionId) return value;
    const fields = String(value).split('|');
    fields[fields.length - 1] = String(sessionId);
    return fields.join('|');
}

function fa(power, start, end, offset) {
    const values = [power, start, end, offset].map(Number);
    let total = 0;
    for (let current = values[1]; current <= values[2]; current++) {
        let item = 1;
        for (let index = 0; index < values[0]; index++) item *= current;
        total += item;
    }
    return total + values[3];
}

function fb(left, right, offset) {
    return Number(left) * Number(right) + Number(offset);
}

function fc(left, right, offset) {
    return Number(left) / Number(right) + Number(offset);
}

function fd(left, right, offset) {
    return Number(left) % Number(right) + Number(offset);
}

function runAlgorithm(name, args) {
    const algorithms = { fa, fb, fc, fd };
    if (!ALGORITHMS.has(name)) throw new Error(`unsupported_secdd_algorithm_${name}`);
    const result = parseInt(algorithms[name](...args), 10);
    if (!Number.isFinite(result)) throw new Error(`invalid_secdd_algorithm_result_${name}`);
    return result;
}

function computeChallengeM(funcDef, args) {
    const functions = String(funcDef || '').split(',');
    const values = String(args || '').split(',');
    if (functions.length !== 3 || !ALGORITHMS.has(functions[0]) || !ALGORITHMS.has(functions[1])) {
        throw new Error('invalid_secdd_func_def');
    }
    if (values.length < 7 || values.length > 32 || values.some(value => {
        const number = Number(value);
        return value.trim() === '' || !Number.isFinite(number) || Math.abs(number) > 1_000_000;
    })) {
        throw new Error('invalid_secdd_args');
    }
    if (functions[0] === 'fa') {
        const [power, start, end] = values.slice(0, 3).map(Number);
        if (!Number.isInteger(power) || power < 0 || power > 16 || end < start || end - start > 10_000) {
            throw new Error('unsafe_secdd_fa_range');
        }
    }
    if (functions[1] === 'fa') {
        const [power, start, end] = values.slice(4, 7).map(Number);
        if (!Number.isInteger(power) || power < 0 || power > 16 || end < start || end - start > 10_000) {
            throw new Error('unsafe_secdd_fa_range');
        }
    }
    const left = runAlgorithm(functions[0], values.slice(0, 4));
    const right = runAlgorithm(functions[1], values.slice(4));
    return functions[2] === '0' ? left + right : `${left}${right}`;
}

function parseChallenge(response) {
    if (Number(response?.status) !== 522) return null;
    let payload = response.bodyText;
    if (typeof payload === 'string') {
        try {
            payload = JSON.parse(payload);
        } catch {
            throw new Error('invalid_secdd_522_json');
        }
    }
    const challenge = payload?.data || payload;
    const required = ['func', 'func_def', 'args', 'chid', 'ts'];
    if (!challenge || required.some(key => challenge[key] === undefined || challenge[key] === null || challenge[key] === '')) {
        throw new Error('incomplete_secdd_challenge');
    }
    for (const key of required) {
        const text = String(challenge[key]);
        if (text.length > 2048 || (key !== 'func_def' && key !== 'args' && text.includes('|'))) {
            throw new Error(`invalid_secdd_challenge_field_${key}`);
        }
    }
    computeChallengeM(challenge.func_def, challenge.args);
    return challenge;
}

function sanitizeResponse(response) {
    const headers = {};
    for (const [key, value] of Object.entries(response?.headers || {})) {
        if (/^(secdd-authentication|set-secch-sessionid)$/i.test(key)) continue;
        headers[key] = value;
    }
    return { ...(response || {}), headers };
}

function parseSessionRule(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    const rule = {};
    for (const part of value.split(/;\s*/)) {
        const separator = part.indexOf('=');
        if (separator <= 0) continue;
        rule[part.slice(0, separator)] = part.slice(separator + 1);
    }
    if (!rule.domain || rule.path === undefined || !rule.secch_sessionid) return null;
    return {
        domain: String(rule.domain),
        path: String(rule.path),
        secch_sessionid: String(rule.secch_sessionid),
    };
}

class SecddSession {
    constructor(options = {}) {
        this.os = String(options.os || DEFAULT_OS);
        this.version = String(options.version || DEFAULT_VERSION);
        this.now = options.now || (() => Date.now());
        this.authentication = String(Math.round(this.now() / 1000));
        this.sessionRules = [];
    }

    getSessionId(url) {
        const text = String(url || '');
        return this.sessionRules
            .filter(rule => text.includes(`${rule.domain}${rule.path}`))
            .map(rule => rule.secch_sessionid)
            .join('');
    }

    updateFromResponse(response) {
        const authentication = getHeader(response?.headers, 'secdd-authentication');
        if (authentication) this.authentication = authentication;

        const rule = parseSessionRule(getHeader(response?.headers, 'set-secch-sessionid'));
        if (!rule) return;
        const key = `${rule.domain}${rule.path}`;
        const index = this.sessionRules.findIndex(item => `${item.domain}${item.path}` === key);
        if (index >= 0) this.sessionRules[index] = rule;
        else {
            if (this.sessionRules.length >= MAX_SESSION_RULES) this.sessionRules.shift();
            this.sessionRules.push(rule);
        }
    }

    initialChallenge(url) {
        return Vt(`${this.os}|${this.version}||||||`, this.getSessionId(url));
    }

    responseChallenge(url, challenge) {
        const result = computeChallengeM(challenge.func_def, challenge.args);
        const base = `${this.os}|${this.version}|${challenge.func}|${challenge.args}|${challenge.ts}|${result}|${challenge.chid}|`;
        return Vt(base, this.getSessionId(url));
    }

    async request(options) {
        const { buildSignedUrl, method, headers, body, send } = options;
        if (typeof buildSignedUrl !== 'function' || typeof send !== 'function') {
            throw new Error('secdd_request_dependencies_required');
        }

        const dispatch = async challengeValue => {
            const url = buildSignedUrl();
            const requestHeaders = { ...(headers || {}) };
            setHeader(requestHeaders, 'secdd-challenge', challengeValue(url));
            setHeader(requestHeaders, 'secdd-authentication', this.authentication);
            return send(url, { method, headers: requestHeaders, body });
        };

        const first = await dispatch(url => this.initialChallenge(url));
        this.updateFromResponse(first);
        if (Number(first.status) !== 522) {
            return {
                response: sanitizeResponse(first),
                path: 'direct',
                attemptCount: 1,
                challengeHandled: false,
                authenticationLength: this.authentication.length,
                sessionRuleCount: this.sessionRules.length,
            };
        }

        const challenge = parseChallenge(first);
        const second = await dispatch(url => this.responseChallenge(url, challenge));
        this.updateFromResponse(second);
        return {
            response: sanitizeResponse(second),
            path: '522_challenge_response',
            attemptCount: 2,
            challengeHandled: true,
            authenticationLength: this.authentication.length,
            sessionRuleCount: this.sessionRules.length,
        };
    }
}

module.exports = {
    DEFAULT_OS,
    DEFAULT_VERSION,
    SecddSession,
    Vt,
    computeChallengeM,
    getHeader,
    parseChallenge,
    parseSessionRule,
    sanitizeResponse,
    setHeader,
};
