'use strict';

const { buildDeviceProfile } = require('./device-profile');

function boundedPayload(payload = {}) {
    const serialized = JSON.stringify(payload && typeof payload === 'object' ? payload : {});
    if (Buffer.byteLength(serialized) > 64 * 1024) throw new Error('desktop task payload is too large');
    return JSON.parse(serialized);
}

async function localRequest(config, pathname, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
    const headers = { accept: 'application/json', ...(options.headers || {}) };
    if (config.localBlueTeamToken) headers.authorization = `Bearer ${config.localBlueTeamToken}`;
    if (options.body) headers['content-type'] = 'application/json';
    try {
        const response = await fetch(`${config.localBlueTeamUrl}${pathname}`, {
            method: options.method || 'GET',
            headers,
            body: options.body ? JSON.stringify(options.body) : undefined,
            signal: controller.signal
        });
        const text = await response.text();
        const data = text ? JSON.parse(text) : {};
        if (!response.ok) throw new Error(`local blue-team request failed: HTTP ${response.status}`);
        return data;
    } finally {
        clearTimeout(timeout);
    }
}

function createExecutors(options = {}) {
    const config = options.config;
    const stateStore = options.stateStore;
    if (!config || !stateStore) throw new TypeError('desktop executor config and state store are required');
    return Object.freeze({
        'system.status': async () => ({
            ...buildDeviceProfile(stateStore.state.installationSecret).profile,
            nodeId: stateStore.state.nodeId || '',
            checkedAt: new Date().toISOString()
        }),
        'desktop.wechat.status': async () => {
            const current = buildDeviceProfile(stateStore.state.installationSecret).profile;
            return { wechatInstalled: current.wechatInstalled, wechatRunning: current.wechatRunning };
        },
        'blue-team.health': async () => localRequest(config, '/api/health'),
        'desktop.wechat.workflow': async payload => {
            const safe = boundedPayload(payload);
            const platform = encodeURIComponent(String(safe.platform || 'didi-charging'));
            return localRequest(config, `/api/method1/workflow?platform=${platform}`);
        },
        'desktop.wechat.basic-check': async payload => {
            const safe = boundedPayload(payload);
            return localRequest(config, '/api/method1/run-basic-check', {
                method: 'POST',
                body: {
                    platform: String(safe.platform || 'didi-charging').slice(0, 80),
                    city: String(safe.city || '').slice(0, 80),
                    targetCity: String(safe.targetCity || '').slice(0, 80),
                    maxScrolls: Math.max(0, Math.min(20, Number(safe.maxScrolls || 1)))
                }
            });
        }
    });
}

async function executeTask(executors, task) {
    const executor = executors[task?.capability];
    if (!executor) throw new Error(`unsupported desktop capability: ${task?.capability || 'empty'}`);
    return executor(task.payload || {});
}

module.exports = { boundedPayload, createExecutors, executeTask, localRequest };
