'use strict';

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_INPUT = path.join(PROJECT_ROOT, 'data/platform-security-test-history.json');
const DEFAULT_OUTPUT = path.join(PROJECT_ROOT, 'docs/platform-security-continuous-test-report.html');

const REQUIRED_FIELDS = [
    'id', 'testedAt', 'title', 'platform', 'platformId', 'city', 'capabilityType',
    'status', 'evidenceLevel', 'scheme', 'path', 'principle', 'environment',
    'content', 'requestStats', 'result', 'evidence', 'recommendations', 'retestStatus'
];
const VALID_STATUSES = new Set(['success', 'partial', 'failed', 'blocked']);
const VALID_EVIDENCE_LEVELS = new Set(['A', 'B', 'C']);

function validateRecord(record, index = null) {
    const prefix = index === null ? 'record' : `records[${index}]`;
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
        throw new TypeError(`${prefix} must be an object`);
    }
    for (const field of REQUIRED_FIELDS) {
        if (record[field] === undefined || record[field] === null) {
            throw new Error(`${prefix}.${field} is required`);
        }
    }
    if (!VALID_STATUSES.has(record.status)) throw new Error(`${prefix}.status is invalid`);
    if (!VALID_EVIDENCE_LEVELS.has(record.evidenceLevel)) throw new Error(`${prefix}.evidenceLevel is invalid`);
    if (!Array.isArray(record.path) || record.path.length === 0) throw new Error(`${prefix}.path must not be empty`);
    if (!Array.isArray(record.content) || record.content.length === 0) throw new Error(`${prefix}.content must not be empty`);
    if (!Array.isArray(record.evidence)) throw new Error(`${prefix}.evidence must be an array`);
    if (!Array.isArray(record.recommendations)) throw new Error(`${prefix}.recommendations must be an array`);
    const stats = record.requestStats;
    for (const key of ['planned', 'executed', 'success', 'failed', 'successRate', 'unit', 'note']) {
        if (!(key in stats)) throw new Error(`${prefix}.requestStats.${key} is required`);
    }
    const numeric = ['planned', 'executed', 'success', 'failed'];
    for (const key of numeric) {
        if (stats[key] !== null && (!Number.isInteger(stats[key]) || stats[key] < 0)) {
            throw new Error(`${prefix}.requestStats.${key} must be a non-negative integer or null`);
        }
    }
    if (stats.executed !== null && stats.success !== null && stats.failed !== null) {
        if (stats.success + stats.failed !== stats.executed) {
            throw new Error(`${prefix} request counts do not add up`);
        }
        if (stats.executed > 0 && stats.successRate !== null) {
            const calculated = Number(((stats.success / stats.executed) * 100).toFixed(1));
            if (Math.abs(calculated - Number(stats.successRate)) > 0.1) {
                throw new Error(`${prefix}.requestStats.successRate must equal ${calculated}`);
            }
        }
    }
    if (Number.isNaN(Date.parse(record.testedAt))) throw new Error(`${prefix}.testedAt is invalid`);
    return record;
}

function validateHistory(history) {
    if (!history || typeof history !== 'object') throw new TypeError('history must be an object');
    if (!Array.isArray(history.records) || history.records.length === 0) throw new Error('history.records must not be empty');
    const ids = new Set();
    history.records.forEach((record, index) => {
        validateRecord(record, index);
        if (ids.has(record.id)) throw new Error(`duplicate record id: ${record.id}`);
        ids.add(record.id);
    });
    return history;
}

function parseArgs(argv) {
    const args = { input: DEFAULT_INPUT, output: DEFAULT_OUTPUT };
    for (let index = 2; index < argv.length; index += 1) {
        if (argv[index] === '--input') args.input = path.resolve(argv[++index]);
        else if (argv[index] === '--output') args.output = path.resolve(argv[++index]);
        else throw new Error(`unknown argument: ${argv[index]}`);
    }
    return args;
}

function safeJson(value) {
    return JSON.stringify(value).replace(/</g, '\\u003c').replace(/-->/g, '--\\u003e');
}

function escapeHtmlString(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function encodeDisplayStrings(value) {
    if (typeof value === 'string') return escapeHtmlString(value);
    if (Array.isArray(value)) return value.map(encodeDisplayStrings);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encodeDisplayStrings(item)]));
    }
    return value;
}

function buildHtml(history) {
    const records = [...history.records].sort((a, b) => Date.parse(b.testedAt) - Date.parse(a.testedAt));
    const generatedAt = new Date().toISOString();
    const payload = safeJson(encodeDisplayStrings({ ...history, generatedAt, records }));
    const documentTitle = escapeHtmlString(history.title);
    return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>${documentTitle}</title>
  <style>
    :root {
      --ink:#101315;--coal:#080a0b;--paper:#e9e5da;--paper2:#f6f3eb;--line:#aaa59a;
      --yellow:#f3c71d;--red:#d94235;--green:#3f8757;--blue:#3d719d;--orange:#dc7a2d;
      --muted:#6c6961;--radius:6px;--display:"Avenir Next Condensed","DIN Condensed","Arial Narrow",sans-serif;
      --body:"Songti SC","STSong","PingFang SC",sans-serif;
    }
    *{box-sizing:border-box;letter-spacing:0}html{scroll-behavior:smooth;background:var(--coal)}body{margin:0;color:var(--ink);background:var(--paper);font-family:var(--body);font-size:15px;line-height:1.65;overflow-x:hidden}
    button,input,select{font:inherit;letter-spacing:0}button{cursor:pointer}:focus-visible{outline:3px solid var(--yellow);outline-offset:3px}.mono,.eyebrow,.metric strong,.rate,.stamp,th{font-family:var(--display);font-variant-numeric:tabular-nums}
    .topbar{position:sticky;z-index:30;top:0;height:50px;display:flex;align-items:center;justify-content:space-between;padding:0 28px;color:var(--paper2);background:rgba(8,10,11,.97);border-bottom:1px solid #393d3e}.brand{display:flex;align-items:center;gap:12px;min-width:0;font:800 14px var(--display);white-space:nowrap}.brand i{width:15px;height:15px;background:var(--yellow);box-shadow:6px 6px 0 var(--red);flex:0 0 auto}.top-actions{display:flex;gap:8px}.icon-btn{min-width:35px;height:32px;padding:0 10px;color:var(--paper2);background:transparent;border:1px solid #555;border-radius:3px}.icon-btn:hover{color:var(--coal);background:var(--yellow);border-color:var(--yellow)}
    .hero{position:relative;min-height:610px;display:grid;grid-template-columns:minmax(420px,.9fr) minmax(520px,1.1fr);color:var(--paper2);background:var(--coal);border-bottom:10px solid var(--yellow);overflow:hidden}.hero::before{content:"";position:absolute;inset:0;opacity:.12;background-image:repeating-linear-gradient(90deg,transparent 0,transparent 79px,#d8d7cf 80px);pointer-events:none}.hero-copy{position:relative;z-index:2;align-self:center;padding:80px 38px 56px max(38px,calc((100vw - 1360px)/2))}.kicker{color:var(--yellow);font:900 15px var(--display)}h1{max-width:650px;margin:18px 0 20px;font:900 68px/.92 var(--display)}.hero-lead{max-width:620px;margin:0;color:#c8c9c4;font-size:17px}.hero-metrics{display:grid;grid-template-columns:repeat(4,1fr);max-width:650px;margin-top:34px;border:1px solid #4a4e4f}.hero-metrics div{padding:13px;border-right:1px solid #4a4e4f}.hero-metrics div:last-child{border-right:0}.hero-metrics b{display:block;color:var(--yellow);font:900 28px/1 var(--display)}.hero-metrics span{color:#aeb0ac;font-size:11px}.hero-visual{position:relative;z-index:1;min-height:560px}#historyCanvas{display:block;width:100%;height:100%;min-height:560px}.canvas-note{position:absolute;right:24px;bottom:24px;max-width:350px;padding:10px 14px;color:#b9bbb7;background:rgba(8,10,11,.86);border-left:4px solid var(--yellow);font-size:12px}
    .band{padding:72px max(28px,calc((100vw - 1360px)/2));border-bottom:1px solid var(--line)}.band.light{background:var(--paper2)}.band.dark{color:var(--paper2);background:#141718;border-color:#3a3e3f}.section-head{display:grid;grid-template-columns:220px minmax(0,1fr);gap:38px;margin-bottom:36px}.section-no{color:var(--red);font:900 14px var(--display)}h2{margin:0;font:900 43px/1 var(--display)}.section-head p{max-width:900px;margin:12px 0 0;color:var(--muted)}.dark .section-head p{color:#b9bbb7}
    .question-list{border-top:3px solid var(--ink)}.question{display:grid;grid-template-columns:44px 1fr;gap:14px;padding:17px 0;border-bottom:1px solid var(--line)}.question b{color:var(--red);font:900 20px var(--display)}.question p{margin:0}.scope-note{margin-top:24px;padding:16px 18px;background:var(--yellow);border-left:9px solid var(--red)}
    .controls{position:sticky;z-index:20;top:50px;display:grid;grid-template-columns:minmax(190px,1fr) repeat(3,minmax(130px,180px));gap:10px;padding:12px max(28px,calc((100vw - 1360px)/2));background:rgba(233,229,218,.97);border-bottom:1px solid var(--line)}.controls input,.controls select{height:38px;padding:0 11px;color:var(--ink);background:var(--paper2);border:1px solid var(--ink);border-radius:0}.controls input{width:100%}
    .timeline{position:relative;display:grid;gap:18px}.timeline::before{content:"";position:absolute;left:24px;top:0;bottom:0;width:2px;background:var(--line)}.record{--accent:var(--blue);position:relative;margin-left:48px;background:var(--paper2);border:1px solid var(--line);border-left:7px solid var(--accent);border-radius:var(--radius);overflow:hidden}.record::before{content:"";position:absolute;left:-39px;top:28px;width:12px;height:12px;background:var(--accent);border:4px solid var(--paper);border-radius:50%}.record[hidden]{display:none}.record-head{width:100%;display:grid;grid-template-columns:160px minmax(230px,1fr) 115px 100px 38px;gap:14px;align-items:center;padding:18px 20px;color:var(--ink);background:transparent;border:0;text-align:left}.record-time{font:800 14px var(--display)}.record-time small{display:block;color:var(--muted);font:12px var(--body)}.record-title b{display:block;font:900 25px/1.05 var(--display)}.record-title span{color:var(--muted);font-size:12px}.metric{padding-left:14px;border-left:1px solid var(--line)}.metric strong{display:block;font-size:22px;line-height:1}.metric span{color:var(--muted);font-size:10px}.status{display:inline-block;width:max-content;padding:3px 8px;color:#fff;background:var(--accent);font-size:12px;font-weight:700}.toggle{font:900 24px var(--display);transition:transform .2s}.record-head[aria-expanded="true"] .toggle{transform:rotate(45deg)}.record-body{padding:0 20px 24px;border-top:1px solid var(--line)}.record-body[hidden]{display:none}
    .record-summary{display:grid;grid-template-columns:1.25fr .75fr;gap:28px;padding:22px 0;border-bottom:1px solid var(--line)}.record-summary p{margin:0}.result-callout{padding:14px 16px;background:#ece7dc;border-left:5px solid var(--accent)}.result-callout b{display:block;font-family:var(--display);font-size:17px}.result-callout p{margin:5px 0 0}
    .fact-grid{display:grid;grid-template-columns:repeat(4,1fr);border-bottom:1px solid var(--line)}.fact{padding:16px 14px 16px 0}.fact+.fact{padding-left:14px;border-left:1px solid var(--line)}.fact b{display:block;color:var(--muted);font-size:11px}.fact span{display:block;margin-top:4px;font-weight:700}.detail-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));margin-top:20px;border-top:3px solid var(--ink)}.detail{padding:20px 22px 4px 0}.detail+.detail{padding-left:22px;border-left:1px solid var(--line)}.detail h3{margin:0 0 10px;font:900 18px var(--display)}.detail ul,.detail ol{margin:0;padding-left:19px}.detail li{margin-bottom:7px}.path-list{counter-reset:path}.path-list li::marker{color:var(--red);font-family:var(--display);font-weight:900}.split-result{display:grid;grid-template-columns:1fr 1fr;gap:0;margin-top:20px;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}.split-result section{padding:17px 20px 8px 0}.split-result section+section{padding-left:20px;border-left:1px solid var(--line)}.split-result h3{margin:0 0 8px;font:900 17px var(--display)}.split-result ul{margin:0;padding-left:18px}.evidence-table{width:100%;margin-top:20px;border-collapse:collapse}.evidence-table th,.evidence-table td{padding:10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}.evidence-table th{font-size:11px}.evidence-table code{word-break:break-all;font-size:11px}.badge{display:inline-block;padding:2px 7px;border:1px solid currentColor;font-size:11px}.missing{color:var(--red)}
    .empty{display:none;padding:40px;text-align:center;border:1px dashed var(--line)}.empty.visible{display:block}.method-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:32px}.method-grid h3{margin:0 0 8px;color:var(--yellow);font:900 20px var(--display)}.method-grid p{margin:0;color:#c2c4c0}.version-table{width:100%;margin-top:32px;border-collapse:collapse}.version-table td{padding:12px 0;border-bottom:1px solid #3c4041;color:#c2c4c0}.version-table td:first-child{width:160px;color:var(--yellow);font-family:var(--display)}footer{padding:26px max(28px,calc((100vw - 1360px)/2));color:#989b98;background:var(--coal);font-size:12px}
    @media(max-width:1000px){.hero{grid-template-columns:1fr}.hero-copy{padding:76px 34px 20px}.hero-visual,#historyCanvas{min-height:470px}.record-head{grid-template-columns:135px minmax(200px,1fr) 90px 82px 30px}.record-summary{grid-template-columns:1fr}.section-head{grid-template-columns:150px 1fr}.fact-grid{grid-template-columns:repeat(2,1fr)}.fact:nth-child(3){border-left:0}.fact:nth-child(n+3){border-top:1px solid var(--line)}}
    @media(max-width:720px){body{font-size:14px}.topbar{padding:0 16px}.brand{max-width:230px;overflow:hidden;text-overflow:ellipsis}.hero{min-height:780px}.hero-copy{padding:66px 20px 0}h1{font-size:40px;line-height:.98}.hero-lead{font-size:16px}.hero-metrics{grid-template-columns:repeat(2,1fr)}.hero-metrics div:nth-child(2){border-right:0}.hero-metrics div:nth-child(-n+2){border-bottom:1px solid #4a4e4f}.hero-visual,#historyCanvas{min-height:420px}.canvas-note{left:20px;right:20px;bottom:14px}.band{padding:52px 20px}.section-head{grid-template-columns:1fr;gap:7px}h2{font-size:34px}.controls{position:static;grid-template-columns:1fr 1fr;padding:12px 20px}.controls input{grid-column:1/-1}.timeline::before{left:7px}.record{margin-left:25px}.record::before{left:-27px}.record-head{grid-template-columns:1fr 1fr 62px 27px;padding:16px 13px}.record-time{grid-column:1/-1;padding-bottom:8px;border-bottom:1px solid var(--line)}.record-title{grid-column:1/3}.record-title b{font-size:23px}.record-title span{display:block}.record-head>.metric{grid-column:3}.record-head>span:nth-child(4){display:none}.record-head>.toggle{grid-column:4}.metric{padding-left:7px}.metric strong{font-size:18px}.status{display:none}.record-body{padding:0 13px 18px}.fact-grid{grid-template-columns:1fr}.fact+.fact,.fact:nth-child(3){padding-left:0;border-left:0;border-top:1px solid var(--line)}.detail-grid{grid-template-columns:1fr}.detail{padding:17px 0}.detail+.detail{padding-left:0;border-left:0;border-top:1px solid var(--line)}.split-result{grid-template-columns:1fr}.split-result section{padding-right:0}.split-result section+section{padding-left:0;border-left:0;border-top:1px solid var(--line)}.method-grid{grid-template-columns:1fr}.evidence-table{display:block;overflow-x:auto}.question{grid-template-columns:32px 1fr}}
    @media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}.toggle{transition:none}}
    @media print{@page{size:A4 landscape;margin:12mm}body{color:#111;background:#fff;font-size:9pt}.topbar,.controls{display:none!important}.hero{min-height:175mm;color:#fff;break-after:page;print-color-adjust:exact;-webkit-print-color-adjust:exact}.band{padding:10mm 0}.record{break-inside:avoid;margin-left:0}.record::before,.timeline::before,.toggle{display:none}.record-body[hidden]{display:block!important}.dark{print-color-adjust:exact;-webkit-print-color-adjust:exact}}
  </style>
</head>
<body>
  <header class="topbar"><div class="brand"><i aria-hidden="true"></i>CONTINUOUS TEST LEDGER / 2026</div><div class="top-actions"><button class="icon-btn" id="expandAll" title="展开全部" aria-label="展开全部">＋</button><button class="icon-btn" id="print" title="打印报告" aria-label="打印报告">⎙</button></div></header>
  <section class="hero">
    <div class="hero-copy"><div class="kicker">AUTHORIZED TEST EVIDENCE / ${escapeHtmlString(history.reportId)}</div><h1>${documentTitle}</h1><p class="hero-lead">逐次记录测试时间、方案、攻击路径、原理、环境、执行内容、成功点、失败点、成功率与证据缺口。历史记录只追加，不覆盖。</p><div class="hero-metrics" id="heroMetrics"></div></div>
    <div class="hero-visual"><canvas id="historyCanvas" aria-label="历史测试状态与证据等级分布"></canvas><div class="canvas-note">横轴为测试时间，纵轴按平台分层；点的颜色表示通过、部分、失败或阻塞，外圈表示 A/B/C 证据等级。</div></div>
  </section>
  <main>
    <section class="band light"><div class="section-head"><div class="section-no">01 / EVIDENCE GAPS</div><div><h2>待确认与待补证</h2><p>以下事项会直接影响成功率、执行节点和当前有效性的结论。未补证前，报告保持保守口径。</p></div></div><div class="question-list" id="questions"></div><div class="scope-note"><b>已追加的补充字段：</b>执行节点、网络出口、请求预算、实际请求数、HTTP/业务码摘要、入库与去重数量、证据等级、证据路径/哈希、停止原因、整改建议、复测状态和版本记录。</div></section>
    <div class="controls" aria-label="测试记录筛选"><input id="search" type="search" placeholder="搜索平台、城市、方案或结果" aria-label="搜索测试记录"><select id="platformFilter" aria-label="平台筛选"><option value="all">全部平台</option></select><select id="statusFilter" aria-label="状态筛选"><option value="all">全部状态</option><option value="success">成功</option><option value="partial">部分完成</option><option value="failed">失败</option><option value="blocked">阻塞</option></select><select id="evidenceFilter" aria-label="证据等级筛选"><option value="all">全部证据</option><option value="A">A级证据</option><option value="B">B级证据</option><option value="C">C级证据</option></select></div>
    <section class="band" id="ledger"><div class="section-head"><div class="section-no">02 / RUN LEDGER</div><div><h2>测试运行时间轴</h2><p id="filterSummary"></p></div></div><div class="timeline" id="timeline"></div><div class="empty" id="empty">没有符合当前筛选条件的测试记录。</div></section>
    <section class="band dark"><div class="section-head"><div class="section-no">03 / METHOD</div><div><h2>统计口径与追加规则</h2><p>成功率只计算请求级数字完整的记录；数据库行、场站数量和接口 totalCount 均不得替代成功请求数。</p></div></div><div class="method-grid"><article><h3>A / 请求级证据</h3><p>包含测试时间、实际请求数、成功/失败、状态摘要和证据哈希，可直接计算成功率。</p></article><article><h3>B / 运行级证据</h3><p>有工作流、日志或数据库批次，可证明关键阶段，但请求细节有缺口。</p></article><article><h3>C / 结果级证据</h3><p>只剩数据库、历史文字或静态分析；不计算请求成功率，不追认执行节点。</p></article></div><table class="version-table"><tr><td>v1.0 / 2026-07-14</td><td>建立持续报告；回填 16 条历史平台测试；引入证据等级与不可计算成功率口径。</td></tr><tr><td>追加命令</td><td><code>node scripts/append-platform-security-test-record.js --input &lt;record.json&gt;</code></td></tr><tr><td>生成时间</td><td>${generatedAt}</td></tr></table></section>
  </main>
  <footer>${escapeHtmlString(history.reportId)} · 脱敏审核版 · 仅用于授权安全评估、风控整改与复测留痕</footer>
  <script id="report-data" type="application/json">${payload}</script>
  <script>
    const report=JSON.parse(document.querySelector('#report-data').textContent);const records=report.records;
    const labels={success:'成功',partial:'部分完成',failed:'失败',blocked:'阻塞'};const colors={success:'#3f8757',partial:'#dc7a2d',failed:'#d94235',blocked:'#6c6961'};
    const fmtTime=r=>{const d=new Date(r.testedAt);if(r.timePrecision==='day')return d.toLocaleDateString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit'})+' / 时间待补';return d.toLocaleString('zh-CN',{hour12:false,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:r.timePrecision==='second'?'2-digit':undefined})};
    const rateText=r=>r.requestStats.successRate===null?'N/A':r.requestStats.successRate+'%';
    const countable=records.filter(r=>r.requestStats.executed>0&&r.requestStats.success!==null&&r.requestStats.failed!==null);const executed=countable.reduce((n,r)=>n+r.requestStats.executed,0),success=countable.reduce((n,r)=>n+r.requestStats.success,0);const aggregate=executed?((success/executed)*100).toFixed(1)+'%':'N/A';
    document.querySelector('#heroMetrics').innerHTML=[['记录',records.length],['成功',records.filter(r=>r.status==='success').length],['A级证据',records.filter(r=>r.evidenceLevel==='A').length],['可计算成功率',aggregate]].map(x=>'<div><b>'+x[1]+'</b><span>'+x[0]+'</span></div>').join('');
    document.querySelector('#questions').innerHTML=report.openQuestions.map((q,i)=>'<div class="question"><b>'+String(i+1).padStart(2,'0')+'</b><p>'+q+'</p></div>').join('');
    const platforms=[...new Set(records.map(r=>r.platform))].sort((a,b)=>a.localeCompare(b,'zh-CN'));document.querySelector('#platformFilter').insertAdjacentHTML('beforeend',platforms.map(p=>'<option value="'+p+'">'+p+'</option>').join(''));
    const list=v=>'<ul>'+v.map(x=>'<li>'+x+'</li>').join('')+'</ul>';const ordered=v=>'<ol class="path-list">'+v.map(x=>'<li>'+x+'</li>').join('')+'</ol>';
    function evidenceRows(items){return items.length?items.map(e=>'<tr><td>'+e.type+'</td><td>'+e.label+'</td><td><code>'+e.path+'</code></td><td>'+(e.sha256?'<code>'+e.sha256+'</code>':'—')+'</td><td><span class="badge">'+e.status+'</span></td></tr>').join(''):'<tr><td colspan="5" class="missing">无证据文件</td></tr>'}
    function recordHtml(r){const s=r.requestStats,env=r.environment;return '<article class="record" data-platform="'+r.platform+'" data-status="'+r.status+'" data-evidence="'+r.evidenceLevel+'" style="--accent:'+colors[r.status]+'"><button class="record-head" aria-expanded="false" aria-controls="body-'+r.id+'"><span class="record-time">'+fmtTime(r)+'<small>'+r.id+'</small></span><span class="record-title"><b>'+r.title+'</b><span>'+r.platform+' · '+r.city+' · '+r.capabilityType+'</span></span><span class="metric"><strong>'+rateText(r)+'</strong><span>请求成功率</span></span><span><i class="status">'+labels[r.status]+'</i><small class="mono"> EVIDENCE '+r.evidenceLevel+'</small></span><span class="toggle">＋</span></button><div class="record-body" id="body-'+r.id+'" hidden><div class="record-summary"><div><span class="eyebrow">测试方案</span><p>'+r.scheme+'</p></div><div class="result-callout"><b>'+labels[r.status]+' / '+r.evidenceLevel+'级证据</b><p>'+r.result.summary+'</p></div></div><div class="fact-grid"><div class="fact"><b>执行节点</b><span>'+env.executionNode+'</span></div><div class="fact"><b>网络出口</b><span>'+env.network+'</span></div><div class="fact"><b>运行时</b><span>'+env.runtime+'</span></div><div class="fact"><b>数据目标</b><span>'+env.dataTarget+'</span></div></div><div class="detail-grid"><section class="detail"><h3>测试路径</h3>'+ordered(r.path)+'</section><section class="detail"><h3>实现原理</h3><p>'+r.principle+'</p></section><section class="detail"><h3>具体内容</h3>'+list(r.content)+'</section></div><div class="fact-grid"><div class="fact"><b>计划请求</b><span>'+(s.planned===null?'未知':s.planned)+' '+s.unit+'</span></div><div class="fact"><b>实际 / 成功 / 失败</b><span>'+(s.executed===null?'未知':s.executed)+' / '+(s.success===null?'未知':s.success)+' / '+(s.failed===null?'未知':s.failed)+'</span></div><div class="fact"><b>成功率</b><span>'+rateText(r)+'</span></div><div class="fact"><b>停止原因</b><span>'+r.result.stopReason+'</span></div></div><p class="scope-note"><b>统计口径：</b>'+s.note+'</p><div class="split-result"><section><h3>成功位置</h3>'+list(r.result.successAt.length?r.result.successAt:['无'])+'</section><section><h3>失败位置 / 缺口</h3>'+list(r.result.failureAt.length?r.result.failureAt:['无'])+'</section></div><table class="evidence-table"><thead><tr><th>类型</th><th>证据</th><th>路径</th><th>SHA-256</th><th>状态</th></tr></thead><tbody>'+evidenceRows(r.evidence)+'</tbody></table><div class="detail-grid"><section class="detail"><h3>改进与复测</h3>'+list(r.recommendations)+'</section><section class="detail"><h3>复测状态</h3><p><span class="badge">'+r.retestStatus+'</span></p></section><section class="detail"><h3>数据结果</h3><p>入库行：'+(r.result.dataRows===null?'未知':r.result.dataRows)+'<br>去重对象：'+(r.result.uniqueStations===null?'未知':r.result.uniqueStations)+'<br>历史回填：'+(r.historicalBackfill?'是':'否')+'</p></section></div></div></article>'}
    const timeline=document.querySelector('#timeline');timeline.innerHTML=records.map(recordHtml).join('');
    function bind(){document.querySelectorAll('.record-head').forEach(b=>b.addEventListener('click',()=>{const open=b.getAttribute('aria-expanded')==='true';b.setAttribute('aria-expanded',String(!open));document.getElementById(b.getAttribute('aria-controls')).hidden=open}))}bind();
    function apply(){const q=document.querySelector('#search').value.trim().toLowerCase(),p=document.querySelector('#platformFilter').value,s=document.querySelector('#statusFilter').value,e=document.querySelector('#evidenceFilter').value;let visible=0;document.querySelectorAll('.record').forEach(el=>{const text=el.textContent.toLowerCase(),show=(!q||text.includes(q))&&(p==='all'||el.dataset.platform===p)&&(s==='all'||el.dataset.status===s)&&(e==='all'||el.dataset.evidence===e);el.hidden=!show;if(show)visible++});document.querySelector('#filterSummary').textContent='当前显示 '+visible+' / '+records.length+' 条记录。A级证据可直接复核；B/C 级记录需结合缺口阅读。';document.querySelector('#empty').classList.toggle('visible',visible===0)}
    ['search','platformFilter','statusFilter','evidenceFilter'].forEach(id=>document.getElementById(id).addEventListener(id==='search'?'input':'change',apply));apply();
    document.querySelector('#expandAll').addEventListener('click',e=>{const buttons=[...document.querySelectorAll('.record:not([hidden]) .record-head')],open=buttons.some(b=>b.getAttribute('aria-expanded')==='false');buttons.forEach(b=>{b.setAttribute('aria-expanded',String(open));document.getElementById(b.getAttribute('aria-controls')).hidden=!open});e.currentTarget.textContent=open?'−':'＋'});document.querySelector('#print').addEventListener('click',()=>print());
    function draw(){const c=document.querySelector('#historyCanvas'),rect=c.getBoundingClientRect(),dpr=Math.min(devicePixelRatio||1,2);c.width=Math.round(rect.width*dpr);c.height=Math.round(rect.height*dpr);const x=c.getContext('2d');x.scale(dpr,dpr);const w=rect.width,h=rect.height,pad={l:65,r:35,t:45,b:75};x.clearRect(0,0,w,h);const ids=[...new Set(records.map(r=>r.platform))],dates=records.map(r=>Date.parse(r.testedAt)),min=Math.min(...dates),max=Math.max(...dates),range=Math.max(1,max-min);x.font="700 11px 'PingFang SC',sans-serif";x.textBaseline='middle';ids.forEach((id,i)=>{const y=pad.t+i*(h-pad.t-pad.b)/Math.max(1,ids.length-1);x.strokeStyle='#313536';x.beginPath();x.moveTo(pad.l,y);x.lineTo(w-pad.r,y);x.stroke();x.fillStyle='#b9bbb7';x.textAlign='right';x.fillText(id,pad.l-10,y)});records.forEach(r=>{const px=pad.l+(Date.parse(r.testedAt)-min)/range*(w-pad.l-pad.r),py=pad.t+ids.indexOf(r.platform)*(h-pad.t-pad.b)/Math.max(1,ids.length-1),radius=r.evidenceLevel==='A'?10:r.evidenceLevel==='B'?8:6;x.beginPath();x.arc(px,py,radius+3,0,Math.PI*2);x.strokeStyle=r.evidenceLevel==='A'?'#f6f3eb':r.evidenceLevel==='B'?'#f3c71d':'#777';x.lineWidth=2;x.stroke();x.beginPath();x.arc(px,py,radius,0,Math.PI*2);x.fillStyle=colors[r.status];x.fill()});x.textAlign='left';x.fillStyle='#aeb0ac';x.fillText(new Date(min).toLocaleDateString('zh-CN'),pad.l,h-34);x.textAlign='right';x.fillText(new Date(max).toLocaleDateString('zh-CN'),w-pad.r,h-34);x.textAlign='center';x.fillStyle='#f3c71d';x.fillText('测试时间 →',w/2,h-34)}draw();addEventListener('resize',()=>{clearTimeout(window.__ct);window.__ct=setTimeout(draw,120)});
  </script>
</body>
</html>`;
}

function generate(inputPath = DEFAULT_INPUT, outputPath = DEFAULT_OUTPUT) {
    const history = validateHistory(JSON.parse(fs.readFileSync(inputPath, 'utf8')));
    const html = buildHtml(history);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, html, 'utf8');
    return { inputPath, outputPath, recordCount: history.records.length, bytes: Buffer.byteLength(html) };
}

if (require.main === module) {
    try {
        console.log(JSON.stringify(generate(...Object.values(parseArgs(process.argv))), null, 2));
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}

module.exports = { validateRecord, validateHistory, buildHtml, generate, DEFAULT_INPUT, DEFAULT_OUTPUT };
