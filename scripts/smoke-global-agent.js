#!/usr/bin/env node
'use strict';

const API_BASE = (process.env.API_BASE || 'http://127.0.0.1:3000/api').replace(/\/$/, '');

async function call(pathname, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${API_BASE}${pathname}`, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let body = text;
  try { body = JSON.parse(text); } catch {}
  return { status: res.status, ok: res.status >= 200 && res.status < 400, body };
}

function assertOk(name, condition, detail) {
  if (!condition) {
    console.error(`[FAIL] ${name}: ${detail || ''}`);
    process.exitCode = 1;
    return;
  }
  console.log(`[PASS] ${name}`);
}

(async () => {
  console.log(`[smoke-global-agent] API_BASE=${API_BASE}`);

  const agentStatus = await call('/global-agent/status');
  console.log('[global-agent/status]', JSON.stringify(agentStatus.body, null, 2));
  assertOk('global-agent status reachable', agentStatus.ok && agentStatus.body?.success === true, `status=${agentStatus.status}`);

  const chainStatus = await call('/test-chains/status');
  console.log('[test-chains/status]', JSON.stringify(chainStatus.body, null, 2));
  assertOk('test-chains status reachable', chainStatus.ok && chainStatus.body?.success === true, `status=${chainStatus.status}`);
  assertOk('three chain statuses present', ['method1', 'method2', 'method3'].every(k => chainStatus.body?.chains?.[k]), 'missing chain key');

  const target = {
    platform: process.env.CHAIN_PLATFORM || 'didi-charging',
    city: process.env.CHAIN_CITY || '上海',
    lat: Number(process.env.CHAIN_LAT || '31.2304'),
    lng: Number(process.env.CHAIN_LNG || '121.4737'),
    radiusKm: 20,
    maxPages: 1,
    maxRequestCount: 5,
    maxQps: 1
  };

  const plan = await call('/global-agent/actions/plan', {
    method: 'POST',
    body: {
      message: '检查三条链路，选择当前最合适的链路做一次小规模验证',
      target,
      dryRun: true
    }
  });
  console.log('[global-agent/actions/plan]', JSON.stringify(plan.body, null, 2));
  assertOk('global-agent plan', plan.ok && plan.body?.success === true && Array.isArray(plan.body?.plan?.actions), `status=${plan.status}`);
  const plannedTool = plan.body?.plan?.actions?.[0]?.tool;
  assertOk('global-agent selects best executable chain', plannedTool === 'run_best_chain', `tool=${plannedTool}`);

  const execute = await call('/global-agent/actions/execute', {
    method: 'POST',
    body: {
      plan: plan.body.plan,
      dryRun: true
    }
  });
  console.log('[global-agent/actions/execute dry-run]', JSON.stringify(execute.body, null, 2));

  if (agentStatus.body?.mode === 'disabled') {
    assertOk('disabled mode is controlled', execute.status === 400 && execute.body?.reason === 'global_agent_disabled', `status=${execute.status}`);
  } else {
    assertOk('dry-run execution accepted', execute.ok && execute.body?.success === true, `status=${execute.status}`);
    assertOk('dry-run did not mutate', execute.body?.results?.some(r => r.tool === 'run_best_chain' && r.dryRun === true), 'no run_best_chain dryRun result');
  }

  const chat = await call('/global-agent/chat', {
    method: 'POST',
    body: {
      message: '检查三条链路，选择当前最合适的链路做一次小规模验证',
      target,
      dryRun: true
    }
  });
  console.log('[global-agent/chat dry-run]', JSON.stringify(chat.body, null, 2));
  assertOk('global-agent chat plans best chain', chat.ok && chat.body?.plan?.actions?.[0]?.tool === 'run_best_chain', `status=${chat.status}`);
  if (agentStatus.body?.mode !== 'disabled') {
    assertOk('global-agent chat dry-run executes', chat.body?.execution?.results?.some(r => r.tool === 'run_best_chain' && r.dryRun === true), 'chat did not dry-run execute run_best_chain');
  }
})().catch(err => {
  console.error('[smoke-global-agent] failed:', err);
  process.exit(1);
});
