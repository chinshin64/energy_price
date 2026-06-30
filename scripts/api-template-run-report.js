#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const baseUrl = process.env.BACKEND_BASE_URL || 'http://localhost:3000/api';
const harFilePath = process.env.HAR_FILE_PATH || '';
const platform = process.env.PLATFORM || 'didi-charging';
const templateScope = process.env.TEMPLATE_SCOPE || 'list';
const targetMode = process.env.TARGET_MODE || 'anchor';
const perRunLimit = Math.max(1, Math.floor(Number(process.env.PER_RUN_LIMIT || 5)));
const pageSize = Math.max(1, Math.floor(Number(process.env.PAGE_SIZE || 10)));
const maxPages = Math.max(1, Math.floor(Number(process.env.MAX_PAGES || 1)));
const reportPath = process.env.REPORT_PATH || '';

function usage() {
  return [
    '用法：',
    '  BACKEND_BASE_URL=http://127.0.0.1:3000/api HAR_FILE_PATH=data/har-sessions/sample.har node scripts/api-template-run-report.js',
    '',
    '可选环境变量：PLATFORM, TEMPLATE_SCOPE, TARGET_MODE=anchor|manual, CENTER_LAT, CENTER_LNG, TARGET_CITY, TARGET_KEYWORD, PER_RUN_LIMIT, PAGE_SIZE, MAX_PAGES, REPORT_PATH'
  ].join('\n');
}

function assertHarFile() {
  if (!harFilePath) {
    throw new Error(`HAR_FILE_PATH required\n${usage()}`);
  }
  if (!fs.existsSync(harFilePath)) {
    throw new Error(`HAR 文件不存在：${harFilePath}`);
  }
}

async function request(method, apiPath, body, timeoutMs = 30000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}${apiPath}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal
    });
    const text = await response.text();
    let payload = null;
    try { payload = JSON.parse(text); } catch {}
    return { status: response.status, text, payload };
  } finally {
    clearTimeout(timeout);
  }
}

function pickCoordinateValue(pattern, keys) {
  const body = pattern.bodyParams || {};
  const query = pattern.queryParams || {};
  for (const key of keys) {
    const value = body[key] ?? query[key];
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function buildTargetLocation(pattern) {
  const manualLat = Number(process.env.CENTER_LAT);
  const manualLng = Number(process.env.CENTER_LNG);
  if (targetMode === 'manual') {
    if (!Number.isFinite(manualLat) || !Number.isFinite(manualLng)) {
      throw new Error('TARGET_MODE=manual 时必须提供 CENTER_LAT 和 CENTER_LNG');
    }
    return {
      city: process.env.TARGET_CITY || '',
      keyword: process.env.TARGET_KEYWORD || 'manual-target',
      name: process.env.TARGET_KEYWORD || 'manual-target',
      lat: manualLat,
      lng: manualLng
    };
  }

  const anchorLat = pickCoordinateValue(pattern, ['lat', 'latitude', 'userlat', 'userLat', 'gdLat', 'centerLat']);
  const anchorLng = pickCoordinateValue(pattern, ['lng', 'longitude', 'userlng', 'userLng', 'gdLng', 'centerLng']);
  if (!Number.isFinite(anchorLat) || !Number.isFinite(anchorLng)) {
    throw new Error('模板中没有可识别的样本坐标，请改用 TARGET_MODE=manual');
  }
  return {
    city: process.env.TARGET_CITY || 'HAR样本城市',
    keyword: process.env.TARGET_KEYWORD || 'HAR样本坐标',
    name: process.env.TARGET_KEYWORD || 'HAR样本坐标',
    lat: anchorLat,
    lng: anchorLng
  };
}

function summarizePattern(pattern) {
  return {
    platform: pattern.platform,
    method: pattern.method,
    baseUrl: pattern.baseUrl,
    templateScope: pattern.templateScope || 'list',
    variableKeys: Object.keys(pattern.variableParams || {})
  };
}

function summarizeEvidence(row) {
  return {
    id: row.id,
    createdAt: row.createdAt,
    chain: row.chain,
    platform: row.platform,
    reason: row.reason,
    method: row.method,
    host: row.targetHost,
    path: row.targetPath,
    proxyUsed: Boolean(row.proxy?.used),
    proxyType: row.proxy?.type || '',
    proxyLabel: row.proxy?.label || '',
    statusCode: row.statusCode || null,
    success: Boolean(row.success),
    durationMs: row.durationMs || null,
    error: row.error?.message || row.error?.code || null
  };
}

function classify(result) {
  const evidence = Array.isArray(result.recentEvidence) ? result.recentEvidence : [];
  const requestIssued = Number(result.requestBudget?.used || result.runQuota?.used || 0) > 0;
  const proxyVerified = evidence.some(row => row.proxyUsed);
  const hasPlatform501 = evidence.some(row => Number(row.statusCode) === 501) || Number(result.runQuota?.fail501 || 0) > 0;
  const hasData = Number(result.stationCount || 0) > 0;

  if (!requestIssued) {
    return {
      status: 'blocked_before_request',
      summary: '模板执行前被前置保护拦截，未产生外部请求。'
    };
  }
  if (hasPlatform501) {
    return {
      status: 'platform_or_signature_501',
      summary: '请求已发出且代理证据完整，但目标平台返回 501，优先处理签名、动态参数或模板时效。'
    };
  }
  if (!hasData) {
    return {
      status: 'no_parsed_data',
      summary: '请求已发出但未解析出场站，优先检查响应结构和解析器映射。'
    };
  }
  return {
    status: proxyVerified ? 'passed_with_proxy' : 'passed_direct_or_unverified_proxy',
    summary: '模板请求已产生可解析场站数据。'
  };
}

function buildMarkdownReport(result) {
  const lines = [];
  lines.push('# API 模板小流量验证报告');
  lines.push('');
  lines.push(`时间：${result.startedAt}`);
  lines.push(`后端：${baseUrl}`);
  lines.push(`HAR：${harFilePath}`);
  lines.push('');
  lines.push('## 结论');
  lines.push('');
  lines.push(`- 状态：${result.classification.status}`);
  lines.push(`- 说明：${result.classification.summary}`);
  lines.push(`- 是否发起请求：${result.requestIssued ? '是' : '否'}`);
  lines.push(`- 是否命中代理：${result.proxyVerified ? '是' : '否'}`);
  lines.push(`- 场站数：${result.stationCount}`);
  lines.push(`- 入库数：${result.insertedCount}`);
  lines.push('');
  lines.push('## 模板');
  lines.push('');
  lines.push(`- 平台：${result.selectedPattern.platform}`);
  lines.push(`- 方法：${result.selectedPattern.method}`);
  lines.push(`- URL：${result.selectedPattern.baseUrl}`);
  lines.push(`- 类型：${result.selectedPattern.templateScope}`);
  lines.push(`- 可变参数：${result.selectedPattern.variableKeys.join(', ') || '-'}`);
  lines.push(`- 目标坐标：${result.targetLocation.lat}, ${result.targetLocation.lng}`);
  lines.push('');
  lines.push('## 请求预算');
  lines.push('');
  lines.push(`- 平台调试预算：${result.requestBudget?.used ?? '-'} / ${result.requestBudget?.limit ?? '-'}`);
  lines.push(`- 当次请求预算：${result.runQuota?.used ?? '-'} / ${result.runQuota?.limit ?? '-'}`);
  lines.push(`- 501 次数：${result.runQuota?.fail501 ?? 0}`);
  lines.push('');
  lines.push('## 出站证据');
  lines.push('');
  if (result.recentEvidence.length === 0) {
    lines.push('- 无新增出站证据。');
  } else {
    for (const row of result.recentEvidence) {
      lines.push(`- ${row.createdAt} ${row.method} ${row.host}${row.path} status=${row.statusCode || '-'} proxy=${row.proxyUsed ? row.proxyLabel || row.proxyType : 'direct'} error=${row.error || '-'}`);
    }
  }
  lines.push('');
  lines.push('## 后续优化');
  lines.push('');
  lines.push('- 如果状态为 `platform_or_signature_501`，优先导入目标城市最新 HAR 或接入方式三 AI 参数修复 dry-run。');
  lines.push('- 如果状态为 `blocked_before_request`，优先查看 `preflightDiagnostics`，避免跨城复用强绑定签名模板。');
  lines.push('- 验证通过后再决定是否保存模板到 `api_templates`。');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

async function main() {
  assertHarFile();
  const startedAt = new Date().toISOString();
  const content = fs.readFileSync(harFilePath, 'utf8');
  const learn = await request('POST', '/crawler/learn-upload', {
    filename: path.basename(harFilePath),
    content
  }, 60000);
  if (learn.status >= 400 || !learn.payload?.success) {
    throw new Error(`HAR 学习失败：${learn.status} ${(learn.payload?.error || learn.text || '').slice(0, 300)}`);
  }

  const patterns = Array.isArray(learn.payload.patterns) ? learn.payload.patterns : [];
  const selected = patterns.find(item => item.platform === platform && (item.templateScope || 'list') === templateScope);
  if (!selected) {
    throw new Error(`未识别到 ${platform} / ${templateScope} 模板，learnedCount=${patterns.length}`);
  }

  const targetLocation = buildTargetLocation(selected);
  const crawl = await request('POST', '/crawler/crawl', {
    pattern: selected,
    coordinates: [{ lat: targetLocation.lat, lng: targetLocation.lng }],
    pageSize,
    maxPages,
    testMode: true,
    perRunLimit,
    targetLocation
  }, 60000);
  if (crawl.status >= 500) {
    throw new Error(`模板执行服务端异常：${crawl.status} ${(crawl.payload?.error || crawl.text || '').slice(0, 300)}`);
  }

  const evidence = await request('GET', '/outbound/evidence/recent?limit=50', undefined, 15000);
  const recentEvidence = (evidence.payload?.data || [])
    .filter(row => row.createdAt && row.createdAt >= startedAt)
    .map(summarizeEvidence);

  const result = {
    ok: true,
    startedAt,
    learnedCount: patterns.length,
    selectedPattern: summarizePattern(selected),
    targetLocation,
    crawlHttpStatus: crawl.status,
    crawlSuccess: crawl.payload?.success === true,
    crawlError: crawl.payload?.error || null,
    stationCount: crawl.payload?.stationCount ?? 0,
    insertedCount: crawl.payload?.insertedCount ?? 0,
    skippedCount: crawl.payload?.skippedCount ?? 0,
    preflightDiagnostics: crawl.payload?.preflightDiagnostics || [],
    requestBudget: crawl.payload?.requestBudget || null,
    runQuota: crawl.payload?.runQuota || null,
    quotaStats: crawl.payload?.quotaStats || null,
    recentEvidence
  };
  result.requestIssued = Number(result.requestBudget?.used || result.runQuota?.used || 0) > 0;
  result.proxyVerified = recentEvidence.some(row => row.proxyUsed);
  result.classification = classify(result);

  if (reportPath) {
    fs.mkdirSync(path.dirname(path.resolve(reportPath)), { recursive: true });
    fs.writeFileSync(reportPath, buildMarkdownReport(result), 'utf8');
  }

  console.log(JSON.stringify(result, null, 2));
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
