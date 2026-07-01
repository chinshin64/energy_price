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
    if (status.status >= 400 || status.json?.success !== true || status.json?.available === false) {
        console.error(`[FAIL] method1 status unavailable: ${status.json?.reason || status.status}`);
        process.exitCode = 1;
        return;
    }

    const basic = await request('/method1/run-basic-check', {
        method: 'POST',
        body: JSON.stringify({
            platform: 'didi-charging',
            city: process.env.CHAIN_CITY || '上海',
            maxScrolls: 1
        })
    });
    console.log('BASIC', JSON.stringify(basic.json, null, 2));
    if (basic.status >= 400 || basic.json?.success !== true || basic.json?.available === false) {
        console.error(`[FAIL] method1 basic check failed: ${basic.json?.reason || basic.status}`);
        process.exitCode = 1;
        return;
    }

    console.log('[PASS] method1 basic check');
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
