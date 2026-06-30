const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPath = path.join(__dirname, '../../data/stations.db');
const dbDir = path.dirname(dbPath);

// 确保数据目录存在
if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(dbPath);

// 创建表结构
db.exec(`
    CREATE TABLE IF NOT EXISTS stations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform TEXT NOT NULL,
        station_id TEXT,
        station_name TEXT,
        address TEXT,
        latitude REAL,
        longitude REAL,
        price_fast REAL,
        price_slow REAL,
        price_super REAL,
        price_service REAL,
        available_ports INTEGER,
        total_ports INTEGER,
        online_fast_ports INTEGER,
        online_slow_ports INTEGER,
        fast_idle_ports INTEGER,
        fast_total_ports INTEGER,
        slow_idle_ports INTEGER,
        slow_total_ports INTEGER,
        super_idle_ports INTEGER,
        super_total_ports INTEGER,
        fuel_92_price REAL,
        fuel_95_price REAL,
        fuel_98_price REAL,
        fuel_diesel_price REAL,
        fuel_92_count INTEGER,
        fuel_95_count INTEGER,
        fuel_98_count INTEGER,
        fuel_diesel_count INTEGER,
        source_type TEXT,
        source_stage TEXT,
        raw_data TEXT,
        collected_at DATETIME DEFAULT (datetime('now', 'localtime')),
        snapshot_at DATETIME DEFAULT (datetime('now', 'localtime')),
        UNIQUE(platform, station_id, collected_at)
    );

    CREATE INDEX IF NOT EXISTS idx_platform ON stations(platform);
    CREATE INDEX IF NOT EXISTS idx_collected_at ON stations(collected_at);
    CREATE INDEX IF NOT EXISTS idx_station_name ON stations(station_name);

    CREATE TABLE IF NOT EXISTS api_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        platform TEXT NOT NULL,
        method TEXT NOT NULL,
        base_url TEXT NOT NULL,
        template_scope TEXT DEFAULT 'list',
        query_params TEXT,
        body_params TEXT,
        variable_params TEXT,
        headers TEXT,
        is_active BOOLEAN DEFAULT 1,
        last_used DATETIME,
        created_at DATETIME DEFAULT (datetime('now', 'localtime')),
        updated_at DATETIME DEFAULT (datetime('now', 'localtime'))
    );

    CREATE INDEX IF NOT EXISTS idx_api_templates_platform ON api_templates(platform);
    CREATE INDEX IF NOT EXISTS idx_api_templates_active ON api_templates(is_active);

    CREATE TABLE IF NOT EXISTS collection_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        started_at DATETIME,
        completed_at DATETIME,
        records_collected INTEGER DEFAULT 0,
        error_message TEXT,
        created_at DATETIME DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS schedules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        platforms TEXT NOT NULL,
        cron_expression TEXT NOT NULL,
        enabled BOOLEAN DEFAULT 1,
        last_run DATETIME,
        next_run DATETIME,
        created_at DATETIME DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS crawl_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_type TEXT NOT NULL,
        status TEXT NOT NULL,
        request_payload TEXT,
        result_summary TEXT,
        error_message TEXT,
        created_at DATETIME DEFAULT (datetime('now', 'localtime')),
        finished_at DATETIME,
        duration_ms INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_crawl_runs_type ON crawl_runs(run_type);
    CREATE INDEX IF NOT EXISTS idx_crawl_runs_created_at ON crawl_runs(created_at);

    CREATE TABLE IF NOT EXISTS crawl_run_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL,
        level TEXT NOT NULL DEFAULT 'info',
        message TEXT NOT NULL,
        created_at DATETIME DEFAULT (datetime('now', 'localtime')),
        FOREIGN KEY (run_id) REFERENCES crawl_runs(id)
    );

    CREATE INDEX IF NOT EXISTS idx_crawl_run_logs_run_id ON crawl_run_logs(run_id);
    CREATE INDEX IF NOT EXISTS idx_crawl_run_logs_created_at ON crawl_run_logs(created_at);

    CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at DATETIME DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS price_schedules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        station_id INTEGER NOT NULL,
        platform TEXT NOT NULL,
        schedule_type TEXT,
        start_time TEXT,
        end_time TEXT,
        price REAL,
        service_fee REAL,
        weekday_mask TEXT,
        source_type TEXT,
        source_stage TEXT,
        raw_data TEXT,
        created_at DATETIME DEFAULT (datetime('now', 'localtime')),
        FOREIGN KEY (station_id) REFERENCES stations(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_price_schedules_station ON price_schedules(station_id);
    CREATE INDEX IF NOT EXISTS idx_price_schedules_platform ON price_schedules(platform);
    CREATE INDEX IF NOT EXISTS idx_price_schedules_type ON price_schedules(schedule_type);
`);

const stationColumns = db.prepare(`PRAGMA table_info(stations)`).all().map(col => col.name);
if (!stationColumns.includes('online_fast_ports')) {
    db.exec(`ALTER TABLE stations ADD COLUMN online_fast_ports INTEGER`);
}
if (!stationColumns.includes('online_slow_ports')) {
    db.exec(`ALTER TABLE stations ADD COLUMN online_slow_ports INTEGER`);
}
if (!stationColumns.includes('fast_idle_ports')) {
    db.exec(`ALTER TABLE stations ADD COLUMN fast_idle_ports INTEGER`);
}
if (!stationColumns.includes('fast_total_ports')) {
    db.exec(`ALTER TABLE stations ADD COLUMN fast_total_ports INTEGER`);
}
if (!stationColumns.includes('slow_idle_ports')) {
    db.exec(`ALTER TABLE stations ADD COLUMN slow_idle_ports INTEGER`);
}
if (!stationColumns.includes('slow_total_ports')) {
    db.exec(`ALTER TABLE stations ADD COLUMN slow_total_ports INTEGER`);
}
if (!stationColumns.includes('super_idle_ports')) {
    db.exec(`ALTER TABLE stations ADD COLUMN super_idle_ports INTEGER`);
}
if (!stationColumns.includes('super_total_ports')) {
    db.exec(`ALTER TABLE stations ADD COLUMN super_total_ports INTEGER`);
}
if (!stationColumns.includes('fuel_92_price')) {
    db.exec(`ALTER TABLE stations ADD COLUMN fuel_92_price REAL`);
}
if (!stationColumns.includes('price_super')) {
    db.exec(`ALTER TABLE stations ADD COLUMN price_super REAL`);
}
if (!stationColumns.includes('fuel_95_price')) {
    db.exec(`ALTER TABLE stations ADD COLUMN fuel_95_price REAL`);
}
if (!stationColumns.includes('fuel_98_price')) {
    db.exec(`ALTER TABLE stations ADD COLUMN fuel_98_price REAL`);
}
if (!stationColumns.includes('fuel_diesel_price')) {
    db.exec(`ALTER TABLE stations ADD COLUMN fuel_diesel_price REAL`);
}
if (!stationColumns.includes('fuel_92_count')) {
    db.exec(`ALTER TABLE stations ADD COLUMN fuel_92_count INTEGER`);
}
if (!stationColumns.includes('fuel_95_count')) {
    db.exec(`ALTER TABLE stations ADD COLUMN fuel_95_count INTEGER`);
}
if (!stationColumns.includes('fuel_98_count')) {
    db.exec(`ALTER TABLE stations ADD COLUMN fuel_98_count INTEGER`);
}
if (!stationColumns.includes('fuel_diesel_count')) {
    db.exec(`ALTER TABLE stations ADD COLUMN fuel_diesel_count INTEGER`);
}
if (!stationColumns.includes('source_type')) {
    db.exec(`ALTER TABLE stations ADD COLUMN source_type TEXT`);
}
if (!stationColumns.includes('source_stage')) {
    db.exec(`ALTER TABLE stations ADD COLUMN source_stage TEXT`);
}
if (!stationColumns.includes('snapshot_at')) {
    db.exec(`ALTER TABLE stations ADD COLUMN snapshot_at DATETIME`);
    db.exec(`UPDATE stations SET snapshot_at = collected_at WHERE snapshot_at IS NULL`);
}
db.exec(`CREATE INDEX IF NOT EXISTS idx_snapshot_at ON stations(snapshot_at)`);

const templateColumns = db.prepare(`PRAGMA table_info(api_templates)`).all().map(col => col.name);
if (!templateColumns.includes('template_scope')) {
    db.exec(`ALTER TABLE api_templates ADD COLUMN template_scope TEXT DEFAULT 'list'`);
}
db.exec(`UPDATE api_templates SET template_scope = 'list' WHERE template_scope IS NULL OR trim(template_scope) = ''`);

console.log('Database initialized at:', dbPath);

module.exports = db;
