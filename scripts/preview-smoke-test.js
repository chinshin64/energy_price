#!/usr/bin/env node

const baseUrl = process.env.PREVIEW_BASE_URL || 'http://localhost:3000/api';

const tests = [
  ['GET', '/config'],
  ['GET', '/chain-status'],
  ['GET', '/collection-modes'],
  ['GET', '/stats'],
  ['GET', '/stations/recent?limit=300'],
  ['GET', '/geocode/search?q=%E4%B8%8A%E6%B5%B7%E8%99%B9%E6%A1%A5%E7%AB%99'],
  ['GET', '/settings/network'],
  ['GET', '/self-heal/settings'],
  ['GET', '/self-heal/runs'],
  ['GET', '/crawler/run-quota'],
  ['GET', '/schedules'],
  ['GET', '/templates'],
  ['GET', '/export/csv'],
  ['POST', '/crawler/generate-grid', { centerLat: 31.1942, centerLng: 121.3184, radius: 10, gridSize: 2 }],
  ['POST', '/crawler/learn-upload', { filename: 'preview-smoke.har', content: '{"log":{"entries":[]}}' }],
  ['POST', '/templates/batch', { patterns: [{ platform: 'didi-charging', method: 'GET', baseUrl: 'https://preview.local/list' }] }],
  ['POST', '/templates/deduplicate', {}],
  ['POST', '/parse-har-upload', { filename: 'preview-smoke.har', content: '{}' }],
  ['POST', '/smart-collect/preflight', { platforms: ['didi-charging'] }],
  ['POST', '/page-collect/preflight', { platforms: ['didi-charging'] }],
  ['POST', '/crawler/crawl', { pattern: { platform: 'didi-charging', method: 'GET', baseUrl: 'https://preview.local/list' }, coordinates: [{ lat: 31.1, lng: 121.1 }], testMode: true }],
  ['POST', '/crawler/crawl-platforms-with-coordinates', { platforms: ['didi-charging'], centerLat: 31.1942, centerLng: 121.3184, testMode: true }]
];

let failures = 0;

for (const [method, path, body] of tests) {
  const options = { method, headers: {} };
  if (body !== undefined) {
    options.headers['content-type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  try {
    const response = await fetch(`${baseUrl}${path}`, options);
    const text = await response.text();
    const ok = response.status >= 200 && response.status < 400;
    if (!ok) failures += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${method.padEnd(6)} ${path.padEnd(48)} ${response.status} ${text.slice(0, 100).replace(/\s+/g, ' ')}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${method.padEnd(6)} ${path.padEnd(48)} ERR ${error.message}`);
  }
}

if (failures > 0) {
  console.error(`\n预览回归失败：${failures} 项`);
  process.exit(1);
}

console.log('\n预览回归通过');
