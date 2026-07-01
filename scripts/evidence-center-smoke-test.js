#!/usr/bin/env node
'use strict';

const API_BASE = (process.env.API_BASE || 'http://127.0.0.1:3000/api').replace(/\/$/, '');

async function call(method, pathname, body) {
  const res = await fetch(`${API_BASE}${pathname}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let payload = text;
  try { payload = JSON.parse(text); } catch {}
  return { status: res.status, ok: res.status >= 200 && res.status < 400, body: payload };
}

function check(name, condition, detail) {
  if (!condition) {
    console.error(`[FAIL] ${name}: ${detail || ''}`);
    process.exitCode = 1;
  } else {
    console.log(`[PASS] ${name}`);
  }
}

(async () => {
  console.log(`[evidence-center-smoke] API_BASE=${API_BASE}`);
  const start = await call('POST', '/blue-team/reports/start', {
    title: '证据中心 smoke 报告',
    method: 'chain-orchestrator',
    platform: 'didi-charging',
    cities: ['上海'],
    target: { platform: 'didi-charging', cities: ['上海'], scope: '上海 / smoke' }
  });
  console.log('[start]', JSON.stringify(start.body, null, 2));
  check('start report', start.ok && start.body?.data?.reportId, `status=${start.status}`);
  const reportId = start.body?.data?.reportId;
  if (!reportId) return;

  const event = await call('POST', `/blue-team/reports/${encodeURIComponent(reportId)}/events`, {
    type: 'step',
    source: 'smoke',
    message: 'smoke event'
  });
  check('append event', event.ok && event.body?.data?.appended >= 1, `status=${event.status}`);

  const evidence = await call('POST', `/blue-team/reports/${encodeURIComponent(reportId)}/evidence`, {
    type: 'supervisor-event',
    city: '上海',
    data: {
      source: 'smoke',
      result: 'ok',
      url: 'https://energy.example.test/station-api/homepage/stationList?openid=OPENID_SECRET&wsgsig=WSGSIG_SECRET&token=TOKEN_SECRET&city=shanghai',
      headers: {
        cookie: 'SID=COOKIE_SECRET',
        authorization: 'Bearer AUTH_SECRET'
      },
      body: {
        token: 'BODY_TOKEN_SECRET',
        stationId: 'station-001'
      }
    }
  });
  check('append evidence', evidence.ok && evidence.body?.data?.path, `status=${evidence.status}`);

  const finalize = await call('POST', `/blue-team/reports/${encodeURIComponent(reportId)}/finalize`, {
    overallStatus: 'passed',
    conclusion: 'smoke passed',
    riskLevel: 'low'
  });
  check('finalize report', finalize.ok && finalize.body?.data?.overallStatus, `status=${finalize.status}`);

  const list = await call('GET', '/blue-team/reports?limit=5');
  check('list reports', list.ok && Array.isArray(list.body?.data), `status=${list.status}`);

  const detail = await call('GET', `/blue-team/reports/${encodeURIComponent(reportId)}?sanitize=true`);
  check('detail sanitized', detail.ok && detail.body?.data?.reportId === reportId, `status=${detail.status}`);

  const download = await call('GET', `/blue-team/reports/${encodeURIComponent(reportId)}/download?format=json&sanitize=true`);
  check('download sanitized json', download.ok && String(download.body).length > 0, `status=${download.status}`);

  const evidenceFile = await call('GET', `/blue-team/reports/${encodeURIComponent(reportId)}/evidence/supervisor-event?sanitize=true`);
  const evidenceText = JSON.stringify(evidenceFile.body);
  check('evidence file sanitized', evidenceFile.ok
    && !/OPENID_SECRET|WSGSIG_SECRET|TOKEN_SECRET|COOKIE_SECRET|AUTH_SECRET|BODY_TOKEN_SECRET/.test(evidenceText),
    `status=${evidenceFile.status} body=${evidenceText.slice(0, 200)}`);
})().catch(err => {
  console.error('[evidence-center-smoke] failed:', err);
  process.exit(1);
});
