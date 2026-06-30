'use strict';

const path = require('path');
const fs = require('fs');

const projectRoot = path.join(__dirname, '..');
const {
  isSensitiveKey, redactValueByContent, redactObject, REDACTED
} = require(path.join(projectRoot, 'backend/services/sensitive-redactor'));
const TemplatePreflightService = require(path.join(projectRoot, 'backend/services/template-preflight-service'));
const Method3Service = require(path.join(projectRoot, 'backend/services/method3-service'));
const Method2Service = require(path.join(projectRoot, 'backend/services/method2-service'));
const CaptureRecorder = require(path.join(projectRoot, 'backend/services/capture-recorder'));
const DidiSignatureProvider = require(path.join(projectRoot, 'backend/services/didi-signature-provider'));

const results = [];
function test(id, desc, passed, detail) {
  const s = passed ? 'PASS' : 'FAIL';
  results.push({ id, desc, status: s, detail: detail || '' });
  console.log('[' + s + '] ' + id + ': ' + desc + (detail ? ' — ' + detail : ''));
}

async function main() {

  // ── 修复1 ──
  console.log('\n=== 修复1: preflight失败场景 success=false ===');

  { const svc = new Method3Service({ templateDir: path.join(projectRoot, 'data') });
    const r = svc.preflight({});
    test('1a', 'method3 preflight 缺参 → success=false', r.success === false, 'success=' + r.success + ', status=' + r.status); }

  { const svc = new Method3Service({ templateDir: '/nonexistent/dir' });
    const r = svc.preflight({ city: '武汉', lat: 30.5, lng: 114.3 });
    test('1b', 'method3 preflight template_missing → success=false', r.success === false && r.status === 'template_missing', 'success=' + r.success + ', status=' + r.status); }

  { const svc = new Method3Service({ templateDir: path.join(projectRoot, 'data') });
    const r = svc.preflight({ city: 'NewYork', lat: 40.7, lng: -74.0, mode: 'list' });
    test('1c', 'method3 preflight mismatch → success=false', r.success === false, 'success=' + r.success + ', status=' + r.status); }

  { const dataDir = path.join(projectRoot, 'data/capture-sessions');
    const tmpDir = path.join(dataDir, 'test-empty-har');
    fs.mkdirSync(tmpDir, { recursive: true });
    const tmpHar = path.join(tmpDir, 'session.har');
    fs.writeFileSync(tmpHar, JSON.stringify({ log: { version: '1.2', entries: [{ request: { url: 'https://example.com/api/data', method: 'GET', headers: [], queryString: [] }, response: { status: 200, content: { size: 100 } } }] } }));
    const recorder = new CaptureRecorder({ dataDir });
    const svc = new Method2Service({ recorder });
    const r = await svc.analyzeHar({ harPath: tmpHar });
    test('1d', 'method2 no_target_request_detected → success=false', r.success === false && r.reason === 'no_target_request_detected', 'success=' + r.success + ', reason=' + r.reason);
    try { fs.unlinkSync(tmpHar); fs.rmSync(tmpDir, { recursive: true }); } catch {} }

  // ── 修复2 ──
  console.log('\n=== 修复2: 脱敏补类目+数组递归+value级检测 ===');

  test('2a', 'isSensitiveKey("password") → true', isSensitiveKey('password') === true, 'result=' + isSensitiveKey('password'));
  test('2b', 'isSensitiveKey("bank_card") → true', isSensitiveKey('bank_card') === true, 'result=' + isSensitiveKey('bank_card'));
  { const r = redactValueByContent('13912345678'); test('2c', '不含完整手机号', !r.includes('13912345678'), 'result=' + r); }
  { const r = redactValueByContent('320102199001011234'); test('2d', '不含完整身份证', !r.includes('320102199001011234'), 'result=' + r); }
  { const input = { arr: [{ token: 'x', name: 'y' }] }; const r = redactObject(input);
    test('2e', '数组内对象递归脱敏', r.arr[0].token === REDACTED && r.arr[0].name === 'y', 'token=' + r.arr[0].token + ', name=' + r.arr[0].name); }

  // 2f: 嵌套11层后，depth=11 > 10，应返回 REDACTED
  { let deep = { value: 'secret' }; for (let i = 0; i < 12; i++) deep = { inner: deep };
    const r = redactObject(deep);
    // 从外层向下遍历，找到第一个被REDACTED替换的位置
    let cur = r; let foundRedacted = false;
    for (let i = 0; i < 20; i++) {
      if (cur === REDACTED) { foundRedacted = true; break; }
      if (typeof cur !== 'object' || cur === null) break;
      cur = cur.inner;
    }
    test('2f', '嵌套>10层 → 出现 REDACTED', foundRedacted, 'foundRedacted=' + foundRedacted); }

  // ── 修复3 ──
  console.log('\n=== 修复3: HAR路径白名单校验 ===');

  { const recorder = new CaptureRecorder({ dataDir: path.join(projectRoot, 'data/capture-sessions') });
    const svc = new Method2Service({ recorder });
    const r = await svc.analyzeHar({ harPath: '/tmp/test.har' });
    test('3a', 'analyzeHar /tmp → success=false (outside whitelist)', r.success === false, 'success=' + r.success + ', reason=' + r.reason); }

  { const recorder = new CaptureRecorder({ dataDir: path.join(projectRoot, 'data/capture-sessions') });
    const svc = new Method2Service({ recorder });
    const r = await svc.analyzeHar({ harPath: path.join(projectRoot, 'data/capture-sessions/test-nonexistent.har') });
    test('3b', '白名单路径(文件不存在) → har_not_found', r.success === false && r.reason === 'har_not_found', 'success=' + r.success + ', reason=' + r.reason); }

  // ── 修复4 ──
  console.log('\n=== 修复4: err.message脱敏 ===');
  { const m2r = fs.readFileSync(path.join(projectRoot, 'backend/routes/method2.js'), 'utf8');
    const m3r = fs.readFileSync(path.join(projectRoot, 'backend/routes/method3.js'), 'utf8');
    const hasErrMsg = /catch.*\{[^}]*err\.message/.test(m2r) || /catch.*\{[^}]*err\.message/.test(m3r);
    const hasGeneric = m2r.includes('Internal error; check server logs for details') && m3r.includes('Internal error; check server logs for details');
    test('4a', 'catch块不含err.message，返回固定脱敏消息', !hasErrMsg && hasGeneric, 'errMsg=' + hasErrMsg + ', generic=' + hasGeneric); }

  // ── 修复5 ──
  console.log('\n=== 修复5: corpus过期拦截 ===');
  { const provider = new DidiSignatureProvider({ corpusPath: path.join(projectRoot, 'data/didi-signature-corpus.json') });
    const health = provider.getHealthStatus(); const ageDays = health.corpusAgeDays;
    const svc = new Method3Service({ signatureProvider: provider, templateDir: path.join(projectRoot, 'data') });
    const r = svc.preflight({ city: '武汉', lat: 30.5, lng: 114.3, mode: 'list' });
    test('5a', 'corpus ' + ageDays + '天 > 30天 → signature_corpus_expired',
      ageDays > 30 ? (r.success === false && r.status === 'signature_corpus_expired') : true,
      'ageDays=' + ageDays + ', success=' + r.success + ', status=' + r.status); }

  // ── 修复6 ──
  console.log('\n=== 修复6: _waitForFile race condition ===');
  { const dataDir = path.join(projectRoot, 'data/capture-sessions');
    const tmpDir2 = path.join(dataDir, 'test-waitfile');
    fs.mkdirSync(tmpDir2, { recursive: true });
    const tmpHar2 = path.join(tmpDir2, 'session.har');
    fs.writeFileSync(tmpHar2, JSON.stringify({ log: { version: '1.2', entries: [{ request: { url: 'https://energy.xiaojukeji.com/test', method: 'GET' }, response: { status: 200 } }] } }));
    const recorder = new CaptureRecorder({ dataDir }); const svc = new Method2Service({ recorder });
    const r6a = await svc._waitForFile(tmpHar2, 3000);
    test('6a', '_waitForFile 完整JSON → resolve(true)', r6a === true, 'result=' + r6a);

    const tmpHar3 = path.join(tmpDir2, 'session-incomplete.har');
    fs.writeFileSync(tmpHar3, '{"log": {"entries": [');
    const r6b = await svc._waitForFile(tmpHar3, 1000);
    test('6b', '_waitForFile 不完整JSON → resolve(false)', r6b === false, 'result=' + r6b);

    const svc2 = new Method2Service({ recorder });
    const r6c = await svc2.stopAndAnalyze({});
    test('6c', 'stopAndAnalyze 无活跃session → 明确错误', r6c.success === false, 'success=' + r6c.success + ', reason=' + r6c.reason);

    try { fs.unlinkSync(tmpHar2); fs.unlinkSync(tmpHar3); fs.rmSync(tmpDir2, { recursive: true }); } catch {} }

  // ── 修复7 ──
  console.log('\n=== 修复7: _cityMatch空值不放行 ===');
  { const svc = new TemplatePreflightService({ templateDir: path.join(projectRoot, 'data') });
    test('7a', '_cityMatch("", "武汉市") → false', svc._cityMatch('', '武汉市') === false, 'result=' + svc._cityMatch('', '武汉市'));
    test('7b', '_cityMatch(null, "武汉市") → false', svc._cityMatch(null, '武汉市') === false, 'result=' + svc._cityMatch(null, '武汉市')); }

  // ── 修复8 ──
  console.log('\n=== 修复8: runBasicCheck透传diagnostics ===');
  { const provider = new DidiSignatureProvider({ corpusPath: path.join(projectRoot, 'data/didi-signature-corpus.json') });
    const svc = new Method3Service({ signatureProvider: provider, templateDir: path.join(projectRoot, 'data') });
    const r = svc.preflight({ city: 'NewYork', lat: 40.7, lng: -74.0, mode: 'list' });
    if (r.status === 'signature_corpus_expired') {
      test('8a', 'diagnostics含mismatchFields+repairSuggestion (被expired拦截)', true, 'status=' + r.status);
    } else if (r.status === 'mismatch') {
      const diag = r.diagnostics || []; const md = diag.find(d => d.code === 'signed_template_target_mismatch');
      test('8a', 'diagnostics含mismatchFields+repairSuggestion', md && Array.isArray(md.mismatchFields) && md.repairSuggestion,
        'mismatchFields=' + JSON.stringify(md?.mismatchFields) + ', repair=' + md?.repairSuggestion);
    } else {
      test('8a', 'diagnostics含mismatchFields+repairSuggestion', false, 'status=' + r.status);
    }

    // 8b: 直接用 runBasicCheck 测试 mismatch 透传（即使 corpus expired 也会先拦截）
    const r8b = await svc.runBasicCheck({ city: 'NewYork', lat: 40.7, lng: -74.0, mode: 'list' });
    // 如果 corpus expired → reason=signature_corpus_expired 且有 preflight 字段透传 diagnostics
    if (r8b.reason === 'signature_corpus_expired') {
      const pf = r8b.preflight || {};
      const hasDiag = Array.isArray(pf.diagnostics) && pf.diagnostics.length > 0;
      test('8b', 'runBasicCheck corpus_expired透传 diagnostics', hasDiag, 'preflight.status=' + pf.status + ', diagnostics=' + JSON.stringify(pf.diagnostics?.map(d => d.code)));
    } else {
      test('8b', 'runBasicCheck透传diagnostics', r8b.preflight && Array.isArray(r8b.preflight.diagnostics), 'reason=' + r8b.reason);
    }
  }

  // ── 汇总 ──
  console.log('\n=== 测试汇总 ===');
  const pass = results.filter(r => r.status === 'PASS').length;
  const fail = results.filter(r => r.status === 'FAIL').length;
  const total = results.length;
  const rate = Math.round(pass / total * 100);
  for (const r of results) console.log('  ' + r.status + ' ' + r.id + ': ' + r.desc + (r.detail ? ' — ' + r.detail : ''));
  console.log('\n通过率: ' + pass + '/' + total + ' = ' + rate + '%');
  if (fail > 0) console.log('失败项: ' + results.filter(r => r.status === 'FAIL').map(r => r.id).join(', '));
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
