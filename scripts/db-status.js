#!/usr/bin/env node

const path = require('path');
const fs = require('fs');
const Database = require('../backend/node_modules/better-sqlite3');

const dbPath = process.env.DB_PATH || path.resolve(__dirname, '..', 'data', 'stations.db');

if (!fs.existsSync(dbPath)) {
  console.error(`数据库不存在：${dbPath}`);
  process.exit(1);
}

const db = new Database(dbPath, { readonly: true });
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all();

console.log(`数据库：${dbPath}`);
console.log(`表数量：${tables.length}`);

for (const { name } of tables) {
  let count = null;
  try {
    count = db.prepare(`SELECT COUNT(*) AS count FROM ${JSON.stringify(name)}`).get().count;
  } catch (error) {
    count = `读取失败：${error.message}`;
  }
  console.log(`- ${name}: ${count}`);
}

const requiredTables = [
  'stations',
  'price_schedules',
  'api_templates',
  'schedules',
  'crawl_runs',
  'crawl_run_logs',
  'app_settings'
];
const existing = new Set(tables.map(item => item.name));
const missing = requiredTables.filter(name => !existing.has(name));

if (missing.length > 0) {
  console.error(`缺少必要表：${missing.join(', ')}`);
  process.exit(1);
}

console.log('数据库状态检查通过');
