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

(async () => {
  console.log(`[smoke-method2] API_BASE=${API_BASE}`);
  const status = await call('/method2/status');
  console.log('[status]', JSON.stringify(status.body, null, 2));
  if (status.status >= 400) process.exitCode = 1;

  if (process.env.START_CAPTURE === '1') {
    const start = await call('/method2/start-capture', {
      method: 'POST',
      body: JSON.stringify({ label: 'smoke-method2' })
    });
    console.log('[start-capture]', JSON.stringify(start.body, null, 2));
    if (start.status >= 400) process.exitCode = 1;
  }
})().catch(err => {
  console.error('[smoke-method2] failed:', err.message);
  process.exit(1);
});
