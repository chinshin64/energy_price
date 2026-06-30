#!/usr/bin/env node
const BASE = process.env.BASE_URL || process.env.API_BASE || 'http://localhost:3000/api';

async function request(path, options = {}) {
    const res = await fetch(`${BASE}${path}`, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            ...(options.headers || {})
        }
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
}

async function main() {
    console.log(`Method1 smoke base: ${BASE}`);
    const status = await request('/method1/status?platform=didi-charging');
    console.log('STATUS', JSON.stringify(status.json, null, 2));

    const observe = await request('/method1/actions/observe', {
        method: 'POST',
        body: JSON.stringify({ platform: 'didi-charging' })
    });
    console.log('OBSERVE', JSON.stringify(observe.json, null, 2));

    const adaptive = await request('/method1/actions/run-adaptive', {
        method: 'POST',
        body: JSON.stringify({
            platform: 'didi-charging',
            limits: { maxSteps: 3, maxScrolls: 1, maxDurationSeconds: 30 }
        })
    });
    console.log('ADAPTIVE', JSON.stringify(adaptive.json, null, 2));
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
