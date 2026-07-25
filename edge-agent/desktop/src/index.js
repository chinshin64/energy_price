#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const { readConfig } = require('./config');
const { buildDeviceProfile, capabilities } = require('./device-profile');
const { EdgeClient } = require('./edge-client');
const { createExecutors, executeTask } = require('./executors');
const { StateStore } = require('./state-store');

const VERSION = '0.1.0';

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function deriveNodeId(config, fingerprintHash) {
    if (/^[a-zA-Z0-9._:-]{6,128}$/.test(config.configuredNodeId)) return config.configuredNodeId;
    return `desktop-${process.platform}-${fingerprintHash.slice(0, 20)}`;
}

async function run(options = {}) {
    const config = options.config || readConfig();
    const stateStore = options.stateStore || new StateStore(config.statePath);
    const profileResult = buildDeviceProfile(stateStore.state.installationSecret, { appVersion: VERSION });
    const nodeId = stateStore.state.nodeId || deriveNodeId(config, profileResult.fingerprintHash);
    const nodeCapabilities = capabilities(process.platform, config.canDelegate);
    const client = options.client || new EdgeClient({ config, stateStore });
    const executors = options.executors || createExecutors({ config, stateStore });
    let stopping = false;
    let lastHeartbeatAt = 0;

    const registration = () => client.register({
        nodeId,
        parentNodeId: config.parentNodeId,
        nodeType: config.canDelegate ? 'controller' : 'worker',
        platform: process.platform,
        version: VERSION,
        capabilities: nodeCapabilities,
        delegatedCapabilities: config.delegatedCapabilities,
        delegatedRegions: config.delegatedRegions,
        canDelegate: config.canDelegate,
        fingerprintHash: profileResult.fingerprintHash,
        deviceProfile: profileResult.profile,
        commandServiceRunning: true
    });

    if (!stateStore.state.sessionToken) await registration();

    const heartbeat = async () => {
        const current = buildDeviceProfile(stateStore.state.installationSecret, { appVersion: VERSION });
        await client.heartbeat({
            version: VERSION,
            capabilities: nodeCapabilities,
            deviceProfile: current.profile,
            commandServiceRunning: true
        });
        lastHeartbeatAt = Date.now();
    };

    const cycle = async () => {
        if (Date.now() - lastHeartbeatAt >= config.heartbeatIntervalMs) await heartbeat();
        const task = await client.pollTask();
        if (!task) return false;
        try {
            const result = await executeTask(executors, task);
            await client.completeTask(task.id, { success: true, result, completedAt: new Date().toISOString() });
        } catch (error) {
            await client.completeTask(task.id, {
                success: false,
                result: { errorId: crypto.randomUUID() },
                error: String(error.message || error).slice(0, 1000),
                completedAt: new Date().toISOString()
            });
        }
        return true;
    };

    const stop = () => { stopping = true; };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    do {
        try {
            await cycle();
        } catch (error) {
            if (error.statusCode === 401 && config.enrollmentToken) {
                await registration().catch(() => undefined);
            } else if (!options.quiet) {
                process.stderr.write(`[edge-agent] ${String(error.message || error)}\n`);
            }
        }
        if (options.once || process.argv.includes('--once')) break;
        await delay(config.pollIntervalMs);
    } while (!stopping);
}

function printDeviceProfile() {
    const config = readConfig();
    const stateStore = new StateStore(config.statePath);
    const profile = buildDeviceProfile(stateStore.state.installationSecret, { appVersion: VERSION });
    process.stdout.write(`${JSON.stringify(profile, null, 2)}\n`);
}

if (require.main === module) {
    const action = process.argv.includes('--print-profile') ? Promise.resolve(printDeviceProfile()) : run();
    action.catch(error => {
        process.stderr.write(`[edge-agent] fatal: ${String(error.message || error)}\n`);
        process.exitCode = 1;
    });
}

module.exports = { VERSION, delay, deriveNodeId, printDeviceProfile, run };
