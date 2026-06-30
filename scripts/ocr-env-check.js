#!/usr/bin/env node

const fs = require('fs');
const { execFileSync } = require('child_process');

const checks = [];
function add(status, label, message) {
  checks.push({ status, label, message });
  const tag = status === 'pass' ? 'PASS' : status === 'warn' ? 'WARN' : 'FAIL';
  console.log(`${tag} ${label.padEnd(18)} ${message}`);
}

function existsExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch (_) {
    return false;
  }
}

add(fs.existsSync('/Applications/WeChat.app') ? 'pass' : 'fail', 'WeChat 应用', fs.existsSync('/Applications/WeChat.app') ? '/Applications/WeChat.app' : '未找到');
add(existsExecutable('/tmp/ocr-image') ? 'pass' : 'warn', 'OCR 工具', existsExecutable('/tmp/ocr-image') ? '/tmp/ocr-image 可执行' : '未找到 /tmp/ocr-image，无法本地 OCR');
add(existsExecutable('/tmp/list-wx') ? 'pass' : 'warn', '微信窗口工具', existsExecutable('/tmp/list-wx') ? '/tmp/list-wx 可执行' : '未找到 /tmp/list-wx，无法列窗口');

if (existsExecutable('/tmp/list-wx')) {
  try {
    const output = execFileSync('/tmp/list-wx', { encoding: 'utf8', timeout: 5000 });
    const lines = output.split(/\r?\n/).filter(Boolean);
    const didiLike = lines.filter(line => /滴滴|充电|WeChat|微信|小程序/i.test(line));
    add(lines.length > 0 ? 'pass' : 'warn', '微信窗口列表', lines.length > 0 ? `发现 ${lines.length} 行窗口信息` : '未发现微信窗口');
    if (didiLike.length > 0) {
      add('pass', '候选小程序窗口', didiLike.slice(0, 3).join(' | '));
    } else {
      add('warn', '候选小程序窗口', '未匹配到滴滴/充电相关窗口，需要人工打开小程序');
    }
  } catch (error) {
    add('warn', '微信窗口列表', `读取失败：${error.message}`);
  }
}

const failCount = checks.filter(item => item.status === 'fail').length;
const warnCount = checks.filter(item => item.status === 'warn').length;
console.log(`\nOCR 环境检查完成：fail=${failCount} warn=${warnCount}`);
process.exit(failCount > 0 ? 1 : 0);
