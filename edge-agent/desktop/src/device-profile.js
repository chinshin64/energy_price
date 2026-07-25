'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function hash(value, secret) {
    return crypto.createHmac('sha256', secret).update(String(value || '')).digest('hex');
}

function processRunning(platform = process.platform) {
    if (platform === 'darwin') {
        return spawnSync('/usr/bin/pgrep', ['-x', 'WeChat'], { stdio: 'ignore', timeout: 2000 }).status === 0;
    }
    if (platform === 'win32') {
        const result = spawnSync('tasklist.exe', ['/FI', 'IMAGENAME eq WeChat.exe', '/FO', 'CSV', '/NH'], {
            encoding: 'utf8', timeout: 3000, windowsHide: true
        });
        return result.status === 0 && /WeChat\.exe/i.test(result.stdout || '');
    }
    return false;
}

function wechatInstalled(platform = process.platform, env = process.env) {
    if (platform === 'darwin') return fs.existsSync('/Applications/WeChat.app');
    if (platform === 'win32') {
        const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter(Boolean);
        return roots.some(root => [
            path.join(root, 'Tencent', 'WeChat', 'WeChat.exe'),
            path.join(root, 'Tencent', 'Weixin', 'Weixin.exe')
        ].some(fs.existsSync));
    }
    return false;
}

function buildDeviceProfile(secret, options = {}) {
    const platform = options.platform || process.platform;
    const cpus = os.cpus() || [];
    const stableProperties = [platform, process.arch, os.release(), cpus.length].join('|');
    const profile = {
        manufacturer: platform === 'darwin' ? 'Apple' : platform === 'win32' ? 'Windows OEM' : 'Unknown',
        model: 'desktop',
        osName: platform,
        osVersion: os.release(),
        osBuild: os.version?.() || '',
        architecture: process.arch,
        cpuCount: cpus.length,
        memoryMb: Math.round(os.totalmem() / 1024 / 1024),
        hostnameHash: hash(os.hostname(), secret),
        installationIdHash: hash('blue-team-edge-installation', secret),
        appVersion: options.appVersion || '0.1.0',
        wechatInstalled: wechatInstalled(platform, options.env || process.env),
        wechatRunning: processRunning(platform),
        locale: Intl.DateTimeFormat().resolvedOptions().locale || '',
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || ''
    };
    return {
        profile,
        fingerprintHash: hash(stableProperties, secret)
    };
}

function capabilities(platform = process.platform, canDelegate = false) {
    const values = ['system.status', 'blue-team.health'];
    if (['darwin', 'win32'].includes(platform)) {
        values.push(
            'desktop.wechat.status',
            'desktop.wechat.workflow',
            'desktop.wechat.basic-check'
        );
    }
    if (canDelegate) values.push('edge.controller');
    return values;
}

module.exports = { buildDeviceProfile, capabilities, hash, processRunning, wechatInstalled };
