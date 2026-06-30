#!/usr/bin/env node

const baseUrl = process.env.BACKEND_BASE_URL || 'http://localhost:3000/api';
const requiredPlatforms = (process.env.PLATFORMS || 'didi-charging,teld,star-charge,ykc,tuanyou,kuaidian')
  .split(',')
  .map(item => item.trim())
  .filter(Boolean);
const requireTemplate = process.env.REQUIRE_TEMPLATE === '1';

async function request(path) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.SMOKE_TIMEOUT_MS || 8000));
  try {
    const response = await fetch(`${baseUrl}${path}`, { signal: controller.signal });
    const text = await response.text();
    let payload = null;
    try { payload = JSON.parse(text); } catch {}
    return { response, text, payload };
  } finally {
    clearTimeout(timeout);
  }
}

let failures = 0;
let warnings = 0;

const configResult = await request('/config');
if (configResult.response.status >= 400 || configResult.payload?.runtimeMode !== 'full') {
  console.error('FAIL /api/config 未返回完整后端模式 runtimeMode=full');
  process.exit(1);
}
console.log('PASS 完整后端模式确认');

const diagnosticsResult = await request('/diagnostics/platforms');
if (diagnosticsResult.response.status >= 400 || !diagnosticsResult.payload?.success) {
  console.error(`FAIL 诊断平台接口异常：${diagnosticsResult.response.status} ${diagnosticsResult.text.slice(0, 160)}`);
  process.exit(1);
}

const templatesResult = await request('/templates');
if (templatesResult.response.status >= 400 || !templatesResult.payload?.success) {
  console.error(`FAIL 模板列表接口异常：${templatesResult.response.status} ${templatesResult.text.slice(0, 160)}`);
  process.exit(1);
}

const diagnostics = Array.isArray(diagnosticsResult.payload.data) ? diagnosticsResult.payload.data : [];
const templates = Array.isArray(templatesResult.payload.data) ? templatesResult.payload.data : [];
const byPlatform = new Map(diagnostics.map(item => [item.platform, item]));

console.log('\n模板覆盖情况');
for (const platform of requiredPlatforms) {
  const item = byPlatform.get(platform) || {};
  const platformTemplates = templates.filter(template => template.platform === platform);
  const activeList = Number(item.activeListTemplates ?? item.active_list_templates ?? 0);
  const activeDetail = Number(item.activeDetailTemplates ?? item.active_detail_templates ?? 0);
  const total = Number(item.totalTemplates ?? item.total_templates ?? platformTemplates.length);
  const status = activeList > 0 ? 'PASS' : (requireTemplate ? 'FAIL' : 'WARN');
  if (status === 'FAIL') failures += 1;
  if (status === 'WARN') warnings += 1;
  console.log(`${status} ${platform.padEnd(14)} list=${activeList} detail=${activeDetail} total=${total}`);
}

const quotaResult = await request('/crawler/daily-quota');
if (quotaResult.response.status < 400 && quotaResult.payload?.success) {
  const quota = quotaResult.payload.data || {};
  console.log(`\n请求配额：perRunLimit=${quota.perRunLimit ?? quota.limit ?? 'unknown'} total=${quota.totalRequests ?? 0} success=${quota.successRequests ?? 0} fail501=${quota.fail501Requests ?? 0}`);
} else {
  warnings += 1;
  console.log('\nWARN 请求配额接口不可用');
}

if (failures > 0) {
  console.error(`\n模板 API 检查失败：${failures} 项。`);
  process.exit(1);
}

console.log(`\n模板 API 检查完成：${warnings} 个警告。${requireTemplate ? '' : '当前未强制要求模板存在。'}`);
