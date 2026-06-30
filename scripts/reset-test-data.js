#!/usr/bin/env node

const path = require('path');
const Database = require('../backend/node_modules/better-sqlite3');

const dbPath = process.env.DB_PATH || path.resolve(__dirname, '..', 'data', 'stations.db');
const confirm = process.env.CONFIRM_RESET === '1';
const keepStations = process.env.KEEP_STATIONS === '1';
const keepTemplates = process.env.KEEP_TEMPLATES === '1';

if (!confirm) {
  console.error('拒绝执行：请设置 CONFIRM_RESET=1 后再清理测试数据。');
  process.exit(1);
}

const db = new Database(dbPath);
const tables = [];

if (!keepStations) {
  tables.push('price_schedules', 'stations');
}
if (!keepTemplates) {
  tables.push('api_templates');
}
tables.push('crawl_run_logs', 'crawl_runs', 'collection_tasks');

const result = db.transaction(() => {
  const summary = [];
  for (const table of tables) {
    const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
    if (!exists) continue;
    const before = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
    db.prepare(`DELETE FROM ${table}`).run();
    summary.push({ table, removed: before });
  }
  return summary;
})();

console.log(JSON.stringify({ success: true, dbPath, result }, null, 2));
