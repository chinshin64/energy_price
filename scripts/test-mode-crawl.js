#!/usr/bin/env node

const baseUrl = process.env.BACKEND_BASE_URL || 'http://localhost:3000/api';
const platforms = (process.env.PLATFORMS || 'didi-charging')
  .split(',')
  .map(item => item.trim())
  .filter(Boolean);
const centerLat = Number(process.env.CENTER_LAT || 31.1942);
const centerLng = Number(process.env.CENTER_LNG || 121.3184);
const radius = Number(process.env.RADIUS_KM || 2);
const gridSize = Number(process.env.GRID_SIZE_KM || 2);
const perRunLimit = Math.max(1, Math.floor(Number(process.env.PER_RUN_LIMIT || 5)));
const maxPages = Math.max(1, Math.floor(Number(process.env.MAX_PAGES || 1)));
const pageSize = Math.max(1, Math.floor(Number(process.env.PAGE_SIZE || 10)));
const crawlMode = process.env.CRAWL_MODE || 'list';

const payload = {
  platforms,
  centerLat,
  centerLng,
  radius,
  gridSize,
  pageSize,
  maxPages,
  crawlMode,
  testMode: true,
  perRunLimit,
  targetLocation: {
    keyword: process.env.TARGET_KEYWORD || '上海虹桥站',
    name: process.env.TARGET_KEYWORD || '上海虹桥站',
    city: process.env.TARGET_CITY || '上海',
    lat: centerLat,
    lng: centerLng
  }
};

const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), Number(process.env.CRAWL_TIMEOUT_MS || 30000));

let response;
let text;
try {
  response = await fetch(`${baseUrl}/crawler/crawl-platforms-with-coordinates`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: controller.signal
  });
  text = await response.text();
} finally {
  clearTimeout(timeout);
}

let result = null;
try { result = JSON.parse(text); } catch {}

console.log(`HTTP ${response.status}`);
console.log(String(text || '').slice(0, 2000));

if (response.status >= 500) {
  console.error('测试模式采集失败：服务端 5xx');
  process.exit(1);
}

if (!result || typeof result !== 'object') {
  console.error('测试模式采集失败：响应不是 JSON');
  process.exit(1);
}

const summaries = Array.isArray(result.summary) ? result.summary : [];
let budgetExceeded = false;
let malformedBudget = false;
for (const item of summaries) {
  const budget = item.requestBudget;
  if (!budget) continue;
  if (Number(budget.used) > Number(budget.limit)) budgetExceeded = true;
  if (Number(budget.limit) > perRunLimit && Number(budget.limit) > 5) malformedBudget = true;
}

if (budgetExceeded || malformedBudget) {
  console.error('测试模式采集失败：请求预算异常');
  process.exit(1);
}

if (result.success === false) {
  const reasons = summaries.map(item => `${item.platform}:${item.reason || item.error || 'unknown'}`).join(', ') || result.error || 'unknown';
  console.log(`\n测试模式采集链路可达，但未产生真实采集结果：${reasons}`);
  process.exit(0);
}

console.log(`\n测试模式采集通过：stationCount=${result.stationCount ?? summaries.reduce((sum, item) => sum + (Number(item.stationCount) || 0), 0)}`);
