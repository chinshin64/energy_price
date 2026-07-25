const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { getMigrationPlan, runMigrations } = require('./migrations');
const { resolveDatabasePath } = require('./path');

const projectRoot = path.resolve(__dirname, '../..');
const dbPath = resolveDatabasePath(process.env, projectRoot);
const dbDir = dbPath === ':memory:' ? null : path.dirname(dbPath);
const defaultMigrationMode = process.env.NODE_ENV === 'production' ? 'validate' : 'apply';
const migrationMode = String(process.env.DATABASE_MIGRATION_MODE || defaultMigrationMode).trim().toLowerCase();
if (!['apply', 'validate'].includes(migrationMode)) {
    const error = new Error('DATABASE_MIGRATION_MODE must be apply or validate');
    error.code = 'database_migration_mode_invalid';
    throw error;
}

let validatedMigrationPlan = null;
if (migrationMode === 'validate') {
    if (dbPath === ':memory:' || !fs.existsSync(dbPath)) {
        const error = new Error('Database must be migrated before production startup');
        error.code = 'database_migration_required';
        throw error;
    }
    const validationDb = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
        validatedMigrationPlan = getMigrationPlan(validationDb);
    } finally {
        validationDb.close();
    }
    if (validatedMigrationPlan.pending.length > 0) {
        const versions = validatedMigrationPlan.pending.map(migration => migration.version).join(', ');
        const error = new Error(`Database migrations are pending: ${versions}`);
        error.code = 'database_migration_required';
        throw error;
    }
}

// 确保数据目录存在
if (dbDir && !fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(dbPath);
const busyTimeoutMs = Math.max(100, Math.min(60000, Number(process.env.DATABASE_BUSY_TIMEOUT_MS) || 5000));
db.pragma('foreign_keys = ON');
db.pragma(`busy_timeout = ${busyTimeoutMs}`);
if (dbPath !== ':memory:') {
    db.pragma('journal_mode = WAL');
}

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
        busy_ports INTEGER,
        total_ports INTEGER,
        port_semantics TEXT,
        missing_fields TEXT,
        quality_status TEXT,
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
        operator TEXT,
        source_type TEXT,
        source_stage TEXT,
        source_agent TEXT,
        source_node TEXT,
        source_record_id INTEGER,
        station_type TEXT NOT NULL DEFAULT 'charging',
        source_station_key TEXT,
        provider_name TEXT,
        fuel_offers TEXT,
        raw_data TEXT,
        needs_review INTEGER DEFAULT 0,
        confidence_score INTEGER,
        confidence_dimensions TEXT,
        collected_at DATETIME DEFAULT (datetime('now', 'localtime')),
        snapshot_at DATETIME DEFAULT (datetime('now', 'localtime')),
        UNIQUE(platform, station_id, collected_at)
    );

    CREATE INDEX IF NOT EXISTS idx_platform ON stations(platform);
    CREATE INDEX IF NOT EXISTS idx_collected_at ON stations(collected_at);
    CREATE INDEX IF NOT EXISTS idx_station_name ON stations(station_name);
    CREATE INDEX IF NOT EXISTS idx_station_source_agent ON stations(source_agent);
    CREATE INDEX IF NOT EXISTS idx_station_source_node ON stations(source_node);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_station_source_record
        ON stations(source_node, source_record_id)
        WHERE source_record_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS station_evidence_assets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        station_id INTEGER,
        platform TEXT,
        station_name TEXT,
        city TEXT,
        evidence_type TEXT NOT NULL,
        source_type TEXT,
        source_stage TEXT,
        asset_path TEXT,
        asset_url TEXT,
        content_hash TEXT,
        captured_at DATETIME,
        summary TEXT,
        metadata TEXT,
        created_at DATETIME DEFAULT (datetime('now', 'localtime')),
        FOREIGN KEY (station_id) REFERENCES stations(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_station_evidence_station ON station_evidence_assets(station_id);
    CREATE INDEX IF NOT EXISTS idx_station_evidence_platform ON station_evidence_assets(platform);
    CREATE INDEX IF NOT EXISTS idx_station_evidence_type ON station_evidence_assets(evidence_type);
    CREATE INDEX IF NOT EXISTS idx_station_evidence_captured_at ON station_evidence_assets(captured_at);

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

    CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        request_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        auth_mode TEXT NOT NULL,
        roles TEXT,
        action TEXT NOT NULL,
        resource TEXT NOT NULL,
        method TEXT,
        path TEXT NOT NULL,
        status_code INTEGER,
        outcome TEXT NOT NULL,
        remote_address TEXT,
        user_agent TEXT,
        duration_ms INTEGER,
        metadata TEXT,
        created_at DATETIME DEFAULT (datetime('now', 'localtime'))
    );

    CREATE INDEX IF NOT EXISTS idx_audit_events_created_at ON audit_events(created_at);
    CREATE INDEX IF NOT EXISTS idx_audit_events_request_id ON audit_events(request_id);
    CREATE INDEX IF NOT EXISTS idx_audit_events_actor_id ON audit_events(actor_id);
    CREATE INDEX IF NOT EXISTS idx_audit_events_resource ON audit_events(resource);
    CREATE INDEX IF NOT EXISTS idx_audit_events_outcome ON audit_events(outcome);

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

    CREATE TABLE IF NOT EXISTS blue_team_reports (
        report_id TEXT PRIMARY KEY,
        title TEXT,
        method TEXT,
        platform TEXT,
        overall_status TEXT DEFAULT 'draft',
        conclusion TEXT,
        risk_level TEXT DEFAULT 'unknown',
        evidence_completeness TEXT DEFAULT 'unknown',
        cities TEXT,
        executor_name TEXT,
        started_at DATETIME,
        finished_at DATETIME,
        created_at DATETIME DEFAULT (datetime('now', 'localtime')),
        updated_at DATETIME DEFAULT (datetime('now', 'localtime')),
        parent_report_id TEXT,
        retest_status TEXT DEFAULT 'none',
        completion_score INTEGER DEFAULT 0,
        completion_summary TEXT,
        schema_version TEXT DEFAULT 'blue-team-report/v3'
    );

`);

const migrationState = migrationMode === 'apply'
    ? runMigrations(db)
    : {
        currentVersion: validatedMigrationPlan.targetVersion,
        appliedNow: [],
        applied: validatedMigrationPlan.applied,
    };
db.applicationSchemaVersion = migrationState.currentVersion;
db.applicationMigrationMode = migrationMode;

console.log(`Database initialized at: ${dbPath} (schema v${migrationState.currentVersion}, ${migrationMode})`);

module.exports = db;
