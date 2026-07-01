#!/usr/bin/env node

const baseUrl = process.env.BACKEND_BASE_URL || 'http://localhost:3000/api';

const tests = [
  ['GET', '/config'],
  ['GET', '/stats'],
  ['GET', '/stations/recent?limit=5'],
  ['GET', '/runs'],
  ['GET', '/run-logs'],
  ['GET', '/settings/network'],
  ['GET', '/self-heal/settings'],
  ['GET', '/self-heal/runs'],
  ['GET', '/crawler/run-quota'],
  ['GET', '/diagnostics/platforms'],
  ['GET', '/test-chains/status'],
  ['GET', '/global-agent/status'],
  ['GET', '/blue-team/reports'],
  ['GET', '/signature/health'],
  ['GET', '/location/status'],
  ['GET', '/templates'],
  ['GET', '/schedules'],
  ['POST', '/crawler/generate-grid', { centerLat: 31.1942, centerLng: 121.3184, radius: 10, gridSize: 2 }],
  ['GET', '/geocode/search?q=%E4%B8%8A%E6%B5%B7%E8%99%B9%E6%A1%A5%E7%AB%99'],
  ['POST', '/smart-collect/preflight', { platforms: ['didi-charging'], cities: ['上海'] }],
  ['POST', '/page-collect/preflight', { platforms: ['didi-charging'], cities: ['上海'], pageCollectionMode: 'page-assisted' }],
  ['GET', '/export/csv']
];

let failures = 0;
let fullModeSeen = false;

for (const [method, path, body] of tests) {
  const options = { method, headers: {} };
  if (body !== undefined) {
    options.headers['content-type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.SMOKE_TIMEOUT_MS || 8000));
  options.signal = controller.signal;

  try {
    const response = await fetch(`${baseUrl}${path}`, options);
    const text = await response.text();
    const ok = response.status >= 200 && response.status < 400;
    if (!ok) failures += 1;

    if (path === '/config') {
      try {
        const config = JSON.parse(text);
        fullModeSeen = config.runtimeMode === 'full';
      } catch {}
    }

    console.log(`${ok ? 'PASS' : 'FAIL'} ${method.padEnd(6)} ${path.padEnd(44)} ${response.status} ${text.slice(0, 100).replace(/\s+/g, ' ')}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${method.padEnd(6)} ${path.padEnd(44)} ERR ${error.message}`);
  } finally {
    clearTimeout(timeout);
  }
}

if (!fullModeSeen) {
  failures += 1;
  console.error('\n完整后端回归失败：/api/config 未返回 runtimeMode=full，请确认连接的不是 local-preview。');
}

if (failures > 0) {
  console.error(`\n完整后端回归失败：${failures} 项`);
  process.exit(1);
}

console.log('\n完整后端回归通过');
