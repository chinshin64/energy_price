#!/usr/bin/env node
'use strict';

const API_BASE = (process.env.API_BASE || 'http://localhost:3000/api').replace(/\/$/, '');
async function call(pathname, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${API_BASE}${pathname}`, { ...options, headers });
  let body;
  try { body = await res.json(); } catch { body = await res.text(); }
  return { status: res.status, body };
}

function readTarget() {
  return {
    platform: process.env.METHOD3_PLATFORM || 'didi-charging',
    city: process.env.METHOD3_CITY || '上海',
    lat: Number(process.env.METHOD3_LAT || '31.2304'),
    lng: Number(process.env.METHOD3_LNG || '121.4737'),
    mode: process.env.METHOD3_MODE || 'list',
    maxPages: 1,
    maxRequestCount: 5,
    maxQps: 1
  };
}

(async () => {
  console.log(`[smoke-method3] API_BASE=${API_BASE}`);
  const status = await call('/method3/status');
  console.log('[status]', JSON.stringify(status.body, null, 2));
  if (status.status >= 400 || status.body?.success !== true || status.body?.available === false) {
    console.error(`[FAIL] method3 status unavailable: ${status.body?.reason || status.status}`);
    process.exitCode = 1;
    return;
  }

  const target = readTarget();
  const preflight = await call('/method3/preflight', {
    method: 'POST',
    body: JSON.stringify(target)
  });
  console.log('[preflight]', JSON.stringify(preflight.body, null, 2));
  if (preflight.status >= 400 || preflight.body?.success !== true || preflight.body?.status !== 'matched') {
    console.error(`[FAIL] method3 preflight failed: ${preflight.body?.reason || preflight.body?.status || preflight.status}`);
    process.exitCode = 1;
    return;
  }

  if (process.env.RUN_BASIC_CHECK === '1') {
    const run = await call('/method3/run-basic-check', {
      method: 'POST',
      body: JSON.stringify(target)
    });
    console.log('[run-basic-check]', JSON.stringify(run.body, null, 2));
    if (run.status >= 400 || run.body?.success !== true || run.body?.result?.success === false) {
      console.error(`[FAIL] method3 run-basic-check failed: ${run.body?.reason || run.body?.status || run.status}`);
      process.exitCode = 1;
      return;
    }
  }
  console.log('[PASS] method3 preflight matched');
})().catch(err => {
  console.error('[smoke-method3] failed:', err.message);
  process.exit(1);
});
