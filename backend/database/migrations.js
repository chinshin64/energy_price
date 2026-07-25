'use strict';

const crypto = require('node:crypto');

function quoteIdentifier(value) {
    const identifier = String(value || '');
    if (!/^[a-z][a-z0-9_]*$/i.test(identifier)) {
        const error = new Error(`Invalid SQL identifier: ${identifier}`);
        error.code = 'migration_identifier_invalid';
        throw error;
    }
    return `"${identifier}"`;
}

function tableColumns(db, table) {
    return new Set(db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all().map(column => column.name));
}

function addMissingColumns(db, table, definitions) {
    const columns = tableColumns(db, table);
    for (const [column, definition] of Object.entries(definitions)) {
        if (!columns.has(column)) {
            db.exec(`ALTER TABLE ${quoteIdentifier(table)} ADD COLUMN ${quoteIdentifier(column)} ${definition}`);
            columns.add(column);
        }
    }
}

function tableExists(db, table) {
    return Boolean(db.prepare(`
        SELECT 1 AS present
        FROM sqlite_master
        WHERE type = 'table' AND name = ?
    `).get(table));
}

function physicalDrift(message) {
    const error = new Error(`Database migration physical drift: ${message}`);
    error.code = 'migration_physical_drift';
    return error;
}

function requireColumns(db, table, required) {
    if (!tableExists(db, table)) throw physicalDrift(`missing table ${table}`);
    const columns = tableColumns(db, table);
    const missing = required.filter(column => !columns.has(column));
    if (missing.length > 0) {
        throw physicalDrift(`${table} is missing columns: ${missing.join(',')}`);
    }
}

function indexColumns(db, table) {
    const indexes = new Map();
    for (const index of db.prepare(`PRAGMA index_list(${quoteIdentifier(table)})`).all()) {
        const columns = db.prepare(`PRAGMA index_info(${quoteIdentifier(index.name)})`)
            .all()
            .map(column => column.name);
        indexes.set(index.name, { unique: Number(index.unique) === 1, columns });
    }
    return indexes;
}

function requireIndex(db, table, name, columns, unique = false) {
    const index = indexColumns(db, table).get(name);
    if (!index
            || index.unique !== unique
            || index.columns.join(',') !== columns.join(',')) {
        throw physicalDrift(`index ${name} on ${table} is invalid`);
    }
}

function requireUniqueColumns(db, table, columns) {
    const expected = columns.join(',');
    const present = Array.from(indexColumns(db, table).values())
        .some(index => index.unique && index.columns.join(',') === expected);
    if (!present) throw physicalDrift(`${table} is missing unique key (${expected})`);
}

function requireCascadeForeignKey(db, table) {
    const present = db.prepare(`PRAGMA foreign_key_list(${quoteIdentifier(table)})`)
        .all()
        .some(key => (
            key.table === 'stations'
            && key.from === 'station_id'
            && key.to === 'id'
            && String(key.on_delete || '').toUpperCase() === 'CASCADE'
        ));
    if (!present) throw physicalDrift(`${table}.station_id foreign key is invalid`);
}

function validateFuelQuotePhysicalV7(db) {
    requireColumns(db, 'stations', ['provider_name', 'fuel_offers', 'station_type']);
    requireColumns(db, 'fuel_offers', [
        'id', 'station_id', 'source_record_id', 'offer_index',
        'fuel_type', 'grade_code', 'grade_label',
        'display_price', 'station_price', 'national_price',
        'list_price', 'discount_price', 'unclassified_price',
        'discount_kind', 'currency', 'unit', 'evidence', 'raw_data', 'created_at',
    ]);
    requireColumns(db, 'fuel_quotes', [
        'id', 'station_id', 'source_record_id',
        'quote_observation_id', 'quote_dedup_key',
        'grade_code', 'grade_label', 'gun_code', 'gun_label',
        'selected_amount', 'gross_discount', 'service_fee',
        'net_discount', 'payable_amount', 'quote_entry',
        'needs_review', 'captured_at', 'raw_data', 'created_at',
    ]);
    requireIndex(db, 'fuel_offers', 'idx_fuel_offers_station', ['station_id']);
    requireIndex(db, 'fuel_offers', 'idx_fuel_offers_source_record', ['source_record_id']);
    requireIndex(db, 'fuel_offers', 'idx_fuel_offers_grade', ['grade_code']);
    requireUniqueColumns(db, 'fuel_offers', ['station_id', 'offer_index']);
    requireCascadeForeignKey(db, 'fuel_offers');
    requireIndex(db, 'fuel_quotes', 'idx_fuel_quotes_station', ['station_id']);
    requireIndex(db, 'fuel_quotes', 'idx_fuel_quotes_source_record', ['source_record_id']);
    requireIndex(db, 'fuel_quotes', 'idx_fuel_quotes_captured_at', ['captured_at']);
    requireUniqueColumns(db, 'fuel_quotes', ['quote_observation_id']);
    requireUniqueColumns(db, 'fuel_quotes', ['quote_dedup_key']);
    requireCascadeForeignKey(db, 'fuel_quotes');
}

function validateStationObservationPhysicalV8(db) {
    requireColumns(db, 'stations', [
        'busy_ports', 'port_semantics', 'missing_fields', 'quality_status',
    ]);
}

function safeJson(value, fallback) {
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

function finiteInRange(value, minimum, maximum, options = {}) {
    if (value === undefined || value === null || value === '') return true;
    const parsed = Number(value);
    return Number.isFinite(parsed)
        && (!options.integer || Number.isInteger(parsed))
        && parsed >= minimum
        && parsed <= maximum;
}

function isSafeScheduledValidation(row = {}) {
    if (String(row.task_type || '').trim().toLowerCase() !== 'validation') return false;
    const platforms = safeJson(row.platforms, null);
    if (!Array.isArray(platforms)
        || platforms.length === 0
        || platforms.length > 20
        || platforms.some(platform => !String(platform || '').trim())) {
        return false;
    }
    const payload = safeJson(row.payload, null);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
    if (String(payload.chain || '').trim().toLowerCase() !== 'method3') return false;
    const target = payload.target;
    if (!target || typeof target !== 'object' || Array.isArray(target)) return false;
    const city = String(target.city || '').trim();
    const lat = Number(target.lat);
    const lng = Number(target.lng);
    const coordinateSystem = String(target.coordinateSystem || 'WGS84').trim().toUpperCase();
    const mode = String(payload.mode || 'list').trim().toLowerCase();
    return Boolean(city)
        && city.length <= 80
        && Number.isFinite(lat)
        && lat >= -90
        && lat <= 90
        && Number.isFinite(lng)
        && lng >= -180
        && lng <= 180
        && ['WGS84', 'GCJ02'].includes(coordinateSystem)
        && ['list', 'detail'].includes(mode)
        && finiteInRange(target.radiusKm, 1, 50)
        && finiteInRange(payload.maxPages, 1, 1, { integer: true })
        && finiteInRange(payload.maxRequestCount, 1, 5, { integer: true })
        && finiteInRange(payload.maxQps, 0.1, 1);
}

const MIGRATIONS = Object.freeze([
    Object.freeze({
        version: 1,
        name: 'commercial_schema_normalization',
        signature: '2026-07-10-commercial-schema-normalization-v1',
        up(db) {
            addMissingColumns(db, 'blue_team_reports', {
                title: 'TEXT',
                method: 'TEXT',
                platform: 'TEXT',
                overall_status: "TEXT DEFAULT 'draft'",
                conclusion: 'TEXT',
                risk_level: "TEXT DEFAULT 'unknown'",
                evidence_completeness: "TEXT DEFAULT 'unknown'",
                cities: 'TEXT',
                executor_name: 'TEXT',
                started_at: 'DATETIME',
                finished_at: 'DATETIME',
                created_at: 'DATETIME',
                updated_at: 'DATETIME',
                parent_report_id: 'TEXT',
                retest_status: "TEXT DEFAULT 'none'",
                completion_score: 'INTEGER DEFAULT 0',
                completion_summary: 'TEXT',
                schema_version: "TEXT DEFAULT 'blue-team-report/v3'",
            });
            addMissingColumns(db, 'stations', {
                online_fast_ports: 'INTEGER',
                online_slow_ports: 'INTEGER',
                fast_idle_ports: 'INTEGER',
                fast_total_ports: 'INTEGER',
                slow_idle_ports: 'INTEGER',
                slow_total_ports: 'INTEGER',
                super_idle_ports: 'INTEGER',
                super_total_ports: 'INTEGER',
                fuel_92_price: 'REAL',
                price_super: 'REAL',
                fuel_95_price: 'REAL',
                fuel_98_price: 'REAL',
                fuel_diesel_price: 'REAL',
                fuel_92_count: 'INTEGER',
                fuel_95_count: 'INTEGER',
                fuel_98_count: 'INTEGER',
                fuel_diesel_count: 'INTEGER',
                operator: 'TEXT',
                source_type: 'TEXT',
                source_stage: 'TEXT',
                snapshot_at: 'DATETIME',
                needs_review: 'INTEGER DEFAULT 0',
                confidence_score: 'INTEGER',
                confidence_dimensions: 'TEXT',
            });
            addMissingColumns(db, 'api_templates', {
                template_scope: "TEXT DEFAULT 'list'",
            });
            db.exec(`
                UPDATE stations SET snapshot_at = collected_at WHERE snapshot_at IS NULL;
                UPDATE api_templates SET template_scope = 'list'
                    WHERE template_scope IS NULL OR trim(template_scope) = '';
                CREATE INDEX IF NOT EXISTS idx_snapshot_at ON stations(snapshot_at);
                CREATE INDEX IF NOT EXISTS idx_blue_team_reports_created_at ON blue_team_reports(created_at);
                CREATE INDEX IF NOT EXISTS idx_blue_team_reports_platform ON blue_team_reports(platform);
                CREATE INDEX IF NOT EXISTS idx_blue_team_reports_method ON blue_team_reports(method);
                CREATE INDEX IF NOT EXISTS idx_blue_team_reports_status ON blue_team_reports(overall_status);
                CREATE INDEX IF NOT EXISTS idx_blue_team_reports_risk ON blue_team_reports(risk_level);
                CREATE INDEX IF NOT EXISTS idx_blue_team_reports_parent ON blue_team_reports(parent_report_id);
            `);
        },
    }),
    Object.freeze({
        version: 2,
        name: 'persistent_schedule_runtime',
        signature: '2026-07-10-persistent-schedule-runtime-v2',
        up(db) {
            addMissingColumns(db, 'schedules', {
                timezone: "TEXT DEFAULT 'Asia/Shanghai'",
                task_type: "TEXT DEFAULT 'validation'",
                payload: "TEXT DEFAULT '{}'",
                last_status: "TEXT DEFAULT 'never_run'",
                last_error: 'TEXT',
                last_result: 'TEXT',
                last_run_started_at: 'DATETIME',
                last_run_finished_at: 'DATETIME',
                updated_at: 'DATETIME',
            });
            db.exec(`
                UPDATE schedules SET timezone = 'Asia/Shanghai'
                    WHERE timezone IS NULL OR trim(timezone) = '';
                UPDATE schedules SET task_type = 'validation'
                    WHERE task_type IS NULL OR trim(task_type) = '';
                UPDATE schedules SET payload = '{}'
                    WHERE payload IS NULL OR trim(payload) = '';
                UPDATE schedules SET last_status = 'never_run'
                    WHERE last_status IS NULL OR trim(last_status) = '';
                CREATE INDEX IF NOT EXISTS idx_schedules_enabled ON schedules(enabled);
                CREATE INDEX IF NOT EXISTS idx_schedules_next_run ON schedules(next_run);
            `);
        },
    }),
    Object.freeze({
        version: 3,
        name: 'quarantine_unsafe_legacy_schedules',
        signature: '2026-07-10-quarantine-unsafe-legacy-schedules-v3',
        up(db) {
            const unsafeRows = db.prepare(`
                SELECT id, platforms, task_type, payload
                FROM schedules
                WHERE enabled = 1
            `).all().filter(row => !isSafeScheduledValidation(row));
            const quarantine = db.prepare(`
                UPDATE schedules
                SET enabled = 0,
                    next_run = NULL,
                    last_status = 'configuration_required',
                    last_error = 'Task disabled during schema migration: configure an explicit method3 target and bounded request budget before enabling',
                    updated_at = datetime('now', 'localtime')
                WHERE id = ?
            `);
            for (const row of unsafeRows) quarantine.run(row.id);
        },
    }),
    Object.freeze({
        version: 4,
        name: 'mobile_ocr_source_agent',
        signature: '2026-07-21-mobile-ocr-source-agent-v4',
        up(db) {
            addMissingColumns(db, 'stations', {
                source_agent: 'TEXT',
            });
            db.exec('CREATE INDEX IF NOT EXISTS idx_station_source_agent ON stations(source_agent)');
        },
    }),
    Object.freeze({
        version: 5,
        name: 'remote_mobile_source_identity',
        signature: '2026-07-21-remote-mobile-source-identity-v5',
        up(db) {
            addMissingColumns(db, 'stations', {
                source_node: 'TEXT',
                source_record_id: 'INTEGER',
            });
            db.exec(`
                CREATE INDEX IF NOT EXISTS idx_station_source_node ON stations(source_node);
                CREATE UNIQUE INDEX IF NOT EXISTS idx_station_source_record
                    ON stations(source_node, source_record_id)
                    WHERE source_record_id IS NOT NULL;
            `);
        },
    }),
    Object.freeze({
        version: 6,
        name: 'station_observation_v2',
        signature: '2026-07-23-station-observation-v2',
        up(db) {
            addMissingColumns(db, 'stations', {
                station_type: "TEXT NOT NULL DEFAULT 'charging'",
                source_station_key: 'TEXT',
                fuel_offers: 'TEXT',
            });
            db.exec(`
                CREATE INDEX IF NOT EXISTS idx_station_type ON stations(station_type);
                CREATE INDEX IF NOT EXISTS idx_station_source_key
                    ON stations(source_node, source_station_key);
            `);
        },
    }),
    Object.freeze({
        version: 7,
        name: 'fuel_quote_observation',
        signature: '2026-07-23-fuel-quote-observation-v7',
        validate: validateFuelQuotePhysicalV7,
        up(db) {
            addMissingColumns(db, 'stations', {
                provider_name: 'TEXT',
            });
            db.exec(`
                CREATE TABLE IF NOT EXISTS fuel_offers (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    station_id INTEGER NOT NULL,
                    source_record_id INTEGER,
                    offer_index INTEGER NOT NULL,
                    fuel_type TEXT,
                    grade_code TEXT,
                    grade_label TEXT,
                    display_price NUMERIC,
                    station_price NUMERIC,
                    national_price NUMERIC,
                    list_price NUMERIC,
                    discount_price NUMERIC,
                    unclassified_price NUMERIC,
                    discount_kind TEXT,
                    currency TEXT,
                    unit TEXT,
                    evidence TEXT,
                    raw_data TEXT,
                    created_at DATETIME NOT NULL DEFAULT (datetime('now', 'localtime')),
                    UNIQUE(station_id, offer_index),
                    FOREIGN KEY (station_id) REFERENCES stations(id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_fuel_offers_station
                    ON fuel_offers(station_id);
                CREATE INDEX IF NOT EXISTS idx_fuel_offers_source_record
                    ON fuel_offers(source_record_id);
                CREATE INDEX IF NOT EXISTS idx_fuel_offers_grade
                    ON fuel_offers(grade_code);

                CREATE TABLE IF NOT EXISTS fuel_quotes (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    station_id INTEGER NOT NULL,
                    source_record_id INTEGER,
                    quote_observation_id TEXT NOT NULL,
                    quote_dedup_key TEXT NOT NULL,
                    grade_code TEXT,
                    grade_label TEXT,
                    gun_code TEXT,
                    gun_label TEXT,
                    selected_amount TEXT,
                    gross_discount TEXT,
                    service_fee TEXT,
                    net_discount TEXT,
                    payable_amount TEXT,
                    quote_entry TEXT,
                    needs_review INTEGER NOT NULL DEFAULT 0,
                    captured_at DATETIME,
                    raw_data TEXT,
                    created_at DATETIME NOT NULL DEFAULT (datetime('now', 'localtime')),
                    UNIQUE(quote_observation_id),
                    UNIQUE(quote_dedup_key),
                    FOREIGN KEY (station_id) REFERENCES stations(id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_fuel_quotes_station
                    ON fuel_quotes(station_id);
                CREATE INDEX IF NOT EXISTS idx_fuel_quotes_source_record
                    ON fuel_quotes(source_record_id);
                CREATE INDEX IF NOT EXISTS idx_fuel_quotes_captured_at
                    ON fuel_quotes(captured_at);
            `);

            const legacyRows = db.prepare(`
                SELECT id, source_record_id, fuel_offers
                FROM stations
                WHERE fuel_offers IS NOT NULL AND trim(fuel_offers) != ''
            `).all();
            const insertOffer = db.prepare(`
                INSERT OR IGNORE INTO fuel_offers (
                    station_id, source_record_id, offer_index,
                    fuel_type, grade_code, grade_label,
                    display_price, station_price, national_price,
                    list_price, discount_price, unclassified_price,
                    discount_kind, currency, unit, evidence, raw_data
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
            for (const row of legacyRows) {
                const offers = safeJson(row.fuel_offers, []);
                if (!Array.isArray(offers)) continue;
                offers.forEach((offer, index) => {
                    if (!offer || typeof offer !== 'object' || Array.isArray(offer)) return;
                    insertOffer.run(
                        row.id,
                        row.source_record_id ?? null,
                        index,
                        offer.fuelType ?? null,
                        offer.gradeCode ?? null,
                        offer.gradeLabel ?? null,
                        offer.displayPrice ?? null,
                        offer.stationPrice ?? null,
                        offer.nationalPrice ?? null,
                        offer.listPrice ?? null,
                        offer.discountPrice ?? null,
                        offer.unclassifiedPrice ?? null,
                        offer.discountKind ?? null,
                        offer.currency ?? null,
                        offer.unit ?? null,
                        offer.evidence ? JSON.stringify(offer.evidence) : null,
                        JSON.stringify(offer)
                    );
                });
            }
        },
    }),
    Object.freeze({
        version: 8,
        name: 'station_observation_v3',
        signature: '2026-07-24-station-observation-v3',
        validate: validateStationObservationPhysicalV8,
        up(db) {
            addMissingColumns(db, 'stations', {
                busy_ports: 'INTEGER',
                port_semantics: 'TEXT',
                missing_fields: 'TEXT',
                quality_status: 'TEXT',
            });
        },
    }),
]);

function migrationChecksum(migration) {
    return crypto.createHash('sha256')
        .update(`${migration.version}:${migration.name}:${migration.signature}`)
        .digest('hex');
}

function validateMigrations(migrations) {
    let previousVersion = 0;
    const names = new Set();
    for (const migration of migrations) {
        if (!Number.isInteger(migration.version) || migration.version <= previousVersion) {
            throw new Error('Migration versions must be positive and strictly increasing');
        }
        if (!migration.name || names.has(migration.name) || typeof migration.up !== 'function') {
            throw new Error(`Invalid migration definition at version ${migration.version}`);
        }
        previousVersion = migration.version;
        names.add(migration.name);
    }
}

function ensureMigrationTable(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            name TEXT NOT NULL UNIQUE,
            checksum TEXT NOT NULL,
            applied_at DATETIME NOT NULL DEFAULT (datetime('now'))
        )
    `);
}

function migrationTableExists(db) {
    return Boolean(db.prepare(`
        SELECT 1 AS present
        FROM sqlite_master
        WHERE type = 'table' AND name = 'schema_migrations'
    `).get());
}

function readAppliedMigrations(db) {
    if (!migrationTableExists(db)) return [];
    return db.prepare(`
        SELECT version, name, checksum, applied_at
        FROM schema_migrations
        ORDER BY version ASC
    `).all();
}

function getAppliedMigrations(db) {
    ensureMigrationTable(db);
    return readAppliedMigrations(db);
}

function getMigrationPlan(db, options = {}) {
    const migrations = options.migrations || MIGRATIONS;
    validateMigrations(migrations);
    const applied = readAppliedMigrations(db);
    const definitions = new Map(migrations.map(migration => [migration.version, migration]));
    for (const existing of applied) {
        const migration = definitions.get(existing.version);
        if (!migration) {
            const error = new Error(`Database migration ${existing.version} is newer than this application`);
            error.code = 'migration_version_unsupported';
            throw error;
        }
        if (existing.name !== migration.name || existing.checksum !== migrationChecksum(migration)) {
            const error = new Error(`Migration ${existing.version} does not match the applied definition`);
            error.code = 'migration_checksum_mismatch';
            throw error;
        }
        if (typeof migration.validate === 'function') migration.validate(db);
    }
    const appliedVersions = new Set(applied.map(migration => migration.version));
    return {
        targetVersion: migrations.length > 0 ? migrations[migrations.length - 1].version : 0,
        currentVersion: applied.length > 0 ? applied[applied.length - 1].version : 0,
        applied,
        pending: migrations
            .filter(migration => !appliedVersions.has(migration.version))
            .map(migration => ({ version: migration.version, name: migration.name })),
    };
}

function runMigrations(db, options = {}) {
    const migrations = options.migrations || MIGRATIONS;
    validateMigrations(migrations);
    ensureMigrationTable(db);
    const applied = new Map(getAppliedMigrations(db).map(migration => [migration.version, migration]));
    const appliedNow = [];

    for (const migration of migrations) {
        const checksum = migrationChecksum(migration);
        const existing = applied.get(migration.version);
        if (existing) {
            if (existing.name !== migration.name || existing.checksum !== checksum) {
                const error = new Error(`Migration ${migration.version} does not match the applied definition`);
                error.code = 'migration_checksum_mismatch';
                throw error;
            }
            if (typeof migration.validate === 'function') migration.validate(db);
            continue;
        }
        const apply = db.transaction(() => {
            try {
                migration.up(db);
            } catch (error) {
                if (typeof migration.validate !== 'function') throw error;
                const drift = physicalDrift(
                    `migration ${migration.version} cannot reconcile existing objects`
                );
                drift.cause = error;
                throw drift;
            }
            if (typeof migration.validate === 'function') migration.validate(db);
            db.prepare(`
                INSERT INTO schema_migrations (version, name, checksum)
                VALUES (?, ?, ?)
            `).run(migration.version, migration.name, checksum);
        });
        apply();
        appliedNow.push(migration.version);
    }

    const currentVersion = migrations.length > 0 ? migrations[migrations.length - 1].version : 0;
    db.pragma(`user_version = ${currentVersion}`);
    return {
        currentVersion,
        appliedNow,
        applied: getAppliedMigrations(db),
    };
}

module.exports = {
    MIGRATIONS,
    addMissingColumns,
    getAppliedMigrations,
    getMigrationPlan,
    migrationTableExists,
    migrationChecksum,
    validateFuelQuotePhysicalV7,
    validateStationObservationPhysicalV8,
    runMigrations,
    tableColumns,
};
