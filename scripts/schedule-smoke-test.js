#!/usr/bin/env node

const baseUrl = process.env.BACKEND_BASE_URL || 'http://localhost:3000/api';
const unique = Date.now();

async function request(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch (_) {}
  return { res, text, payload };
}

function assertOk(label, result) {
  if (result.res.status >= 400 || result.payload?.success === false) {
    console.error(`FAIL ${label}: ${result.res.status} ${result.text.slice(0, 500)}`);
    process.exit(1);
  }
  console.log(`PASS ${label}`);
}

const create = await request('POST', '/schedules', {
  name: `smoke-schedule-${unique}`,
  platforms: ['didi-charging'],
  cronExpression: '0 3 * * *'
});
assertOk('创建定时任务', create);
const scheduleId = create.payload?.data?.id;
if (!scheduleId) {
  console.error('FAIL 创建定时任务未返回 id');
  process.exit(1);
}

const list = await request('GET', '/schedules');
assertOk('查询定时任务', list);
if (!Array.isArray(list.payload?.data) || !list.payload.data.some(item => Number(item.id) === Number(scheduleId))) {
  console.error('FAIL 定时任务列表未命中新建任务');
  process.exit(1);
}
console.log(`PASS 定时任务命中：id=${scheduleId}`);

const drill = await request('POST', `/schedules/${scheduleId}/drill`, {
  currentChain: 'api-template',
  errorType: 'no_active_template',
  message: 'smoke no active template'
});
assertOk('自愈诊断演练', drill);

const disable = await request('PATCH', `/schedules/${scheduleId}/toggle`, { enabled: false });
assertOk('停用定时任务', disable);

const del = await request('DELETE', `/schedules/${scheduleId}`);
assertOk('删除定时任务', del);

console.log('\n定时任务/自愈回归通过');
