#!/usr/bin/env node
'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_SERVER_URL = 'http://localhost:3000';

function loadEnv() {
    const envPath = path.join(ROOT, '.env');
    if (!fs.existsSync(envPath)) {
        return {};
    }
    const result = {};
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) {
            continue;
        }
        const index = trimmed.indexOf('=');
        result[trimmed.slice(0, index)] = trimmed.slice(index + 1);
    }
    return result;
}

function parseArgs(argv) {
    const env = loadEnv();
    const defaultServerUrl = process.env.MOBILE_SYNC_SERVER_URL
        || env.MOBILE_SYNC_SERVER_URL
        || DEFAULT_SERVER_URL;
    const options = {
        serverUrl: defaultServerUrl,
        cities: ['上海', '北京', '广州'],
        targetIncrement: 100,
        pagesPerLandmark: 90,
        minIntervalMs: 1800,
        maxIntervalMs: 4200,
        noGrowthSeconds: 120,
        detailEnrichmentEnabled: false,
        maxCommandRetries: 2,
        deviceId: '',
        pollIntervalMs: 5000
    };

    for (let i = 2; i < argv.length; i += 1) {
        const arg = argv[i];
        const next = argv[i + 1];
        if (arg === '--server-url') {
            options.serverUrl = next;
            i += 1;
        } else if (arg === '--token') {
            // 已废弃：访问鉴权关闭后不再需要 token，保留参数兼容旧脚本。
            i += 1;
        } else if (arg === '--cities') {
            options.cities = String(next || '').split(/[,，\s]+/).filter(Boolean);
            i += 1;
        } else if (arg === '--target-increment') {
            options.targetIncrement = Number(next);
            i += 1;
        } else if (arg === '--pages-per-landmark') {
            options.pagesPerLandmark = Number(next);
            i += 1;
        } else if (arg === '--min-interval') {
            options.minIntervalMs = Number(next);
            i += 1;
        } else if (arg === '--max-interval') {
            options.maxIntervalMs = Number(next);
            i += 1;
        } else if (arg === '--no-growth-seconds') {
            options.noGrowthSeconds = Number(next);
            i += 1;
        } else if (arg === '--detail-enrichment') {
            options.detailEnrichmentEnabled = !['0', 'false', 'off'].includes(String(next).toLowerCase());
            i += 1;
        } else if (arg === '--max-command-retries') {
            options.maxCommandRetries = Number(next);
            i += 1;
        } else if (arg === '--device-id') {
            options.deviceId = next;
            i += 1;
        } else if (arg === '--poll-ms') {
            options.pollIntervalMs = Number(next);
            i += 1;
        } else if (arg === '-h' || arg === '--help') {
            printHelp();
            process.exit(0);
        } else {
            throw new Error(`Unknown option: ${arg}`);
        }
    }

    options.serverUrl = String(options.serverUrl || '').replace(/\/+$/, '');
    return options;
}

function printHelp() {
    console.log(`Usage: scripts/start-mobile-network-workflow.js [options]

Starts a server-driven mobile collection workflow. The phone must have
"网络指令模式" running; after that the server controls city/landmark actions.

Options:
  --server-url URL           Default: http://localhost:3000
  --token TOKEN              已废弃：访问鉴权关闭后不再需要
  --cities "上海 北京 广州"    Default: 上海 北京 广州
  --target-increment N       Default: 100 new price/gun snapshots per city
  --pages-per-landmark N     Default: 90
  --min-interval MS          Default: 1800
  --max-interval MS          Default: 4200
  --detail-enrichment 0|1    Default: 0
  --max-command-retries N     Default: 2
  --device-id ID             Optional target phone device id
  --poll-ms MS               Default: 5000
`);
}

function requestJson(method, urlString, body) {
    const url = new URL(urlString);
    const transport = url.protocol === 'https:' ? https : http;
    const textBody = body ? JSON.stringify(body) : null;
    const headers = {};
    if (textBody) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(textBody);
    }

    return new Promise((resolve, reject) => {
        const req = transport.request(url, { method, headers, timeout: 20000 }, (res) => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', chunk => {
                data += chunk;
            });
            res.on('end', () => {
                let parsed = {};
                try {
                    parsed = data ? JSON.parse(data) : {};
                } catch (error) {
                    return reject(new Error(`Invalid JSON from ${urlString}: ${data.slice(0, 200)}`));
                }
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    return reject(new Error(`HTTP ${res.statusCode}: ${parsed.error || data}`));
                }
                resolve(parsed);
            });
        });
        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy(new Error(`Request timed out: ${urlString}`));
        });
        if (textBody) {
            req.write(textBody);
        }
        req.end();
    });
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function summarizeWorkflow(workflow) {
    const parts = [];
    for (const city of workflow.cities || []) {
        const baseline = workflow.baselines?.[city]?.total || 0;
        const target = workflow.targets?.[city] || 0;
        parts.push(`${city}: ${baseline}->${target}`);
    }
    return `${workflow.status} ${workflow.currentCityIndex || 0}/${(workflow.cities || []).length} ${parts.join(', ')}`;
}

async function main() {
    const options = parseArgs(process.argv);
    const workflowPayload = {
        cities: options.cities,
        targetIncrement: options.targetIncrement,
        pagesPerLandmark: options.pagesPerLandmark,
        minIntervalMs: options.minIntervalMs,
        maxIntervalMs: options.maxIntervalMs,
        noGrowthSeconds: options.noGrowthSeconds,
        detailEnrichmentEnabled: options.detailEnrichmentEnabled,
        maxCommandRetries: options.maxCommandRetries
    };
    if (options.deviceId) {
        workflowPayload.deviceId = options.deviceId;
    }

    const started = await requestJson(
        'POST',
        `${options.serverUrl}/api/mobile-control/workflows/city-increment/start`,
        workflowPayload
    );
    const workflowId = started.data.id;
    console.log(`workflow started: ${workflowId}`);

    while (true) {
        const [workflowsResp, commandsResp] = await Promise.all([
            requestJson('GET', `${options.serverUrl}/api/mobile-control/workflows`),
            requestJson('GET', `${options.serverUrl}/api/mobile-control/commands?limit=8`)
        ]);
        const workflow = (workflowsResp.data || []).find(item => item.id === workflowId);
        if (!workflow) {
            throw new Error(`workflow disappeared: ${workflowId}`);
        }
        const latestCommand = (commandsResp.data || []).find(item => item.workflowId === workflowId);
        const commandSummary = latestCommand
            ? `${latestCommand.type}/${latestCommand.status}/${latestCommand.payload?.city || '-'}:${latestCommand.payload?.keyword || '-'}`
            : 'no command';
        console.log(`[${new Date().toISOString()}] ${summarizeWorkflow(workflow)} | ${commandSummary}`);

        if (workflow.status !== 'running') {
            if (workflow.status !== 'succeeded') {
                throw new Error(workflow.error || `workflow ended with ${workflow.status}`);
            }
            return;
        }
        await sleep(Math.max(1000, options.pollIntervalMs));
    }
}

main().catch(error => {
    console.error(error.message);
    process.exit(1);
});
