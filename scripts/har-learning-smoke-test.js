#!/usr/bin/env node

const baseUrl = process.env.BACKEND_BASE_URL || 'http://localhost:3000/api';
const platform = process.env.PLATFORM || 'didi-charging';
const unique = Date.now();
const sampleUrl = `https://api.xiaojukeji.com/charging/homepage/stationlist?lat=31.1942&lng=121.3184&page=1&pageSize=10&city=%E4%B8%8A%E6%B5%B7&smoke=${unique}`;

const har = {
  log: {
    version: '1.2',
    creator: { name: 'blue-team-smoke', version: '1.0' },
    entries: [
      {
        startedDateTime: new Date().toISOString(),
        time: 20,
        request: {
          method: 'GET',
          url: sampleUrl,
          httpVersion: 'HTTP/1.1',
          headers: [
            { name: 'User-Agent', value: 'Mozilla/5.0 MicroMessenger smoke' },
            { name: 'Accept', value: 'application/json' }
          ],
          queryString: [
            { name: 'lat', value: '31.1942' },
            { name: 'lng', value: '121.3184' },
            { name: 'page', value: '1' },
            { name: 'pageSize', value: '10' },
            { name: 'city', value: '上海' },
            { name: 'smoke', value: String(unique) }
          ],
          cookies: [],
          headersSize: -1,
          bodySize: 0
        },
        response: {
          status: 200,
          statusText: 'OK',
          httpVersion: 'HTTP/1.1',
          headers: [{ name: 'Content-Type', value: 'application/json' }],
          cookies: [],
          content: {
            size: 400,
            mimeType: 'application/json',
            text: JSON.stringify({
              data: {
                list: [
                  {
                    stationId: `smoke-station-${unique}`,
                    stationName: '烟测充电站',
                    address: '上海虹桥站测试地址',
                    lat: 31.1942,
                    lng: 121.3184,
                    totalMarketPrice: '1.23',
                    fastChargeIdleNum: 2,
                    fastChargeNum: 4
                  }
                ]
              }
            })
          },
          redirectURL: '',
          headersSize: -1,
          bodySize: 80
        },
        cache: {},
        timings: { send: 1, wait: 10, receive: 1 }
      }
    ]
  }
};

async function request(method, path, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.SMOKE_TIMEOUT_MS || 10000));
  const options = { method, headers: {}, signal: controller.signal };
  if (body !== undefined) {
    options.headers['content-type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  try {
    const response = await fetch(`${baseUrl}${path}`, options);
    const text = await response.text();
    let payload = null;
    try { payload = JSON.parse(text); } catch {}
    return { response, text, payload };
  } finally {
    clearTimeout(timeout);
  }
}

let failures = 0;

const config = await request('GET', '/config');
if (config.payload?.runtimeMode !== 'full') {
  console.error('FAIL 当前不是完整后端模式，停止 HAR 学习回归');
  process.exit(1);
}
console.log('PASS 完整后端模式确认');

const learn = await request('POST', '/crawler/learn-upload', {
  filename: `smoke-${unique}.har`,
  content: JSON.stringify(har)
});
const learned = Array.isArray(learn.payload?.patterns) ? learn.payload.patterns : [];
if (learn.response.status >= 400 || !learn.payload?.success || learned.length === 0) {
  console.error(`FAIL HAR 学习失败：${learn.response.status} ${learn.text.slice(0, 500)}`);
  process.exit(1);
}
console.log(`PASS HAR 学习识别 ${learned.length} 个模板`);

const didiListPattern = learned.find(item => item.platform === platform && (item.templateScope || 'list') === 'list');
if (!didiListPattern) {
  console.error(`FAIL 未识别到 ${platform} list 模板`);
  process.exit(1);
}
console.log(`PASS 识别模板：${didiListPattern.method} ${didiListPattern.baseUrl}`);

const save = await request('POST', '/templates/batch', { patterns: learned });
if (save.response.status >= 400 || !save.payload?.success) {
  console.error(`FAIL 模板保存失败：${save.response.status} ${save.text.slice(0, 500)}`);
  process.exit(1);
}
console.log(`PASS 模板保存成功：${save.payload.count ?? learned.length}`);

const templates = await request('GET', `/templates/platform/${platform}`);
const savedTemplates = Array.isArray(templates.payload?.data) ? templates.payload.data : [];
const matched = savedTemplates.find(item => item.baseUrl === didiListPattern.baseUrl);
if (!matched) {
  console.error('FAIL 保存后未能按平台查询到模板');
  process.exit(1);
}
console.log(`PASS 平台模板查询命中：id=${matched.id}`);

const dedupe = await request('POST', '/templates/deduplicate', { dryRun: false });
if (dedupe.response.status >= 400 || !dedupe.payload?.success) {
  console.error(`FAIL 模板去重失败：${dedupe.response.status} ${dedupe.text.slice(0, 500)}`);
  process.exit(1);
}
console.log('PASS 模板去重接口正常');

const diagnostics = await request('GET', '/diagnostics/platforms');
const coverage = (diagnostics.payload?.data || []).find(item => item.platform === platform) || {};
const activeList = Number(coverage.activeListTemplates ?? coverage.active_list_templates ?? 0);
if (activeList <= 0) {
  console.error(`FAIL 模板库存未体现 ${platform} list 覆盖`);
  process.exit(1);
}
console.log(`PASS 模板库存覆盖：${platform} list=${activeList}`);

if (process.env.KEEP_SMOKE_TEMPLATE !== '1' && matched?.id) {
  const cleanup = await request('DELETE', `/templates/${matched.id}`);
  if (cleanup.response.status >= 400 || !cleanup.payload?.success) {
    console.error(`FAIL 烟测模板清理失败：${cleanup.response.status} ${cleanup.text.slice(0, 500)}`);
    process.exit(1);
  }
  console.log(`PASS 已清理烟测模板：id=${matched.id}`);
}

console.log('\nHAR 学习/保存/库存闭环通过');
