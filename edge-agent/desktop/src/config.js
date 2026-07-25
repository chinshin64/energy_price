'use strict';

const os = require('node:os');
const path = require('node:path');

function parseBoolean(value, fallback = false) {
    const text = String(value ?? '').trim().toLowerCase();
    if (!text) return fallback;
    if (['1', 'true', 'yes', 'on'].includes(text)) return true;
    if (['0', 'false', 'no', 'off'].includes(text)) return false;
    return fallback;
}

function parseList(value) {
    if (Array.isArray(value)) return value.map(item => String(item).trim()).filter(Boolean);
    return String(value || '').split(',').map(item => item.trim()).filter(Boolean);
}

function parseRegions(value) {
    if (!value) return [];
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (!Array.isArray(parsed)) throw new Error('EDGE_DELEGATED_REGIONS_JSON must be an array');
    return parsed.slice(0, 64).map(item => ({
        country: String(item?.country || '').trim(),
        province: String(item?.province || '').trim(),
        city: String(item?.city || '').trim()
    }));
}

function validateUrl(value, label, options = {}) {
    const url = new URL(String(value || '').trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
        throw new Error(`${label} must be an HTTP(S) URL without credentials`);
    }
    if (options.loopbackOnly) {
        const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
        if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
            throw new Error(`${label} must use a loopback host`);
        }
    }
    return url.toString().replace(/\/$/, '');
}

function readConfig(env = process.env) {
    const dataDir = path.resolve(env.EDGE_DATA_DIR || path.join(os.homedir(), '.blue-team-edge-agent'));
    return Object.freeze({
        serverUrl: validateUrl(env.EDGE_SERVER_URL || 'http://127.0.0.1:50080', 'EDGE_SERVER_URL'),
        enrollmentToken: String(env.EDGE_ENROLLMENT_TOKEN || '').trim(),
        configuredNodeId: String(env.EDGE_NODE_ID || '').trim(),
        parentNodeId: String(env.EDGE_PARENT_NODE_ID || '').trim(),
        canDelegate: parseBoolean(env.EDGE_CAN_DELEGATE, false),
        delegatedCapabilities: parseList(env.EDGE_DELEGATED_CAPABILITIES),
        delegatedRegions: parseRegions(env.EDGE_DELEGATED_REGIONS_JSON),
        localBlueTeamUrl: validateUrl(
            env.EDGE_LOCAL_BLUE_TEAM_URL || 'http://127.0.0.1:50080',
            'EDGE_LOCAL_BLUE_TEAM_URL',
            { loopbackOnly: true }
        ),
        localBlueTeamToken: String(env.EDGE_LOCAL_BLUE_TEAM_TOKEN || '').trim(),
        dataDir,
        statePath: path.join(dataDir, 'state.json'),
        pollIntervalMs: Math.max(1000, Math.min(60000, Number(env.EDGE_POLL_INTERVAL_MS || 2000))),
        heartbeatIntervalMs: Math.max(5000, Math.min(300000, Number(env.EDGE_HEARTBEAT_INTERVAL_MS || 15000))),
        requestTimeoutMs: Math.max(1000, Math.min(120000, Number(env.EDGE_REQUEST_TIMEOUT_MS || 15000)))
    });
}

module.exports = { parseBoolean, parseList, parseRegions, readConfig, validateUrl };
