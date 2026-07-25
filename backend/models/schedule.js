'use strict';

const db = require('../database/init');
const { redactText, serializeRedacted } = require('../services/sensitive-redactor');

class ScheduleModel {
    static list() {
        return db.prepare(`
            SELECT * FROM schedules
            ORDER BY enabled DESC, datetime(COALESCE(next_run, created_at)) ASC, id ASC
        `).all().map(row => this.parse(row));
    }

    static getById(id) {
        const row = db.prepare('SELECT * FROM schedules WHERE id = ?').get(id);
        return row ? this.parse(row) : null;
    }

    static create(input = {}) {
        const result = db.prepare(`
            INSERT INTO schedules (
                name, platforms, cron_expression, enabled, timezone,
                task_type, payload, last_status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'never_run', datetime('now', 'localtime'), datetime('now', 'localtime'))
        `).run(
            input.name,
            JSON.stringify(input.platforms || []),
            input.cronExpression,
            input.enabled === false ? 0 : 1,
            input.timezone || 'Asia/Shanghai',
            input.taskType || 'validation',
            serializeRedacted(input.payload || {}, { maxBytes: 32 * 1024 })
        );
        return this.getById(result.lastInsertRowid);
    }

    static setEnabled(id, enabled) {
        const result = db.prepare(`
            UPDATE schedules
            SET enabled = ?, updated_at = datetime('now', 'localtime')
            WHERE id = ?
        `).run(enabled ? 1 : 0, id);
        return result.changes > 0 ? this.getById(id) : null;
    }

    static setNextRun(id, nextRun) {
        db.prepare(`
            UPDATE schedules
            SET next_run = ?, updated_at = datetime('now', 'localtime')
            WHERE id = ?
        `).run(nextRun || null, id);
    }

    static markRunStarted(id, startedAt) {
        db.prepare(`
            UPDATE schedules
            SET last_status = 'running', last_error = NULL,
                last_run = ?, last_run_started_at = ?, last_run_finished_at = NULL,
                updated_at = datetime('now', 'localtime')
            WHERE id = ?
        `).run(startedAt, startedAt, id);
    }

    static markRunFinished(id, status, result, errorMessage, finishedAt) {
        db.prepare(`
            UPDATE schedules
            SET last_status = ?, last_result = ?, last_error = ?,
                last_run_finished_at = ?, updated_at = datetime('now', 'localtime')
            WHERE id = ?
        `).run(
            status,
            result === undefined ? null : serializeRedacted(result, { maxBytes: 64 * 1024 }),
            errorMessage ? redactText(String(errorMessage)).slice(0, 4000) : null,
            finishedAt,
            id
        );
    }

    static markConfigurationRequired(id, errorMessage) {
        db.prepare(`
            UPDATE schedules
            SET enabled = 0, next_run = NULL,
                last_status = 'configuration_required', last_error = ?,
                updated_at = datetime('now', 'localtime')
            WHERE id = ?
        `).run(
            errorMessage ? redactText(String(errorMessage)).slice(0, 4000) : null,
            id
        );
        return this.getById(id);
    }

    static delete(id) {
        return db.prepare('DELETE FROM schedules WHERE id = ?').run(id);
    }

    static parse(row = {}) {
        return {
            id: Number(row.id),
            name: row.name,
            platforms: this.safeJson(row.platforms, []),
            cronExpression: row.cron_expression,
            enabled: Boolean(row.enabled),
            timezone: row.timezone || 'Asia/Shanghai',
            taskType: row.task_type || 'validation',
            payload: this.safeJson(row.payload, {}),
            lastStatus: row.last_status || 'never_run',
            lastError: row.last_error || null,
            lastResult: this.safeJson(row.last_result, null),
            lastRun: row.last_run || null,
            lastRunStartedAt: row.last_run_started_at || null,
            lastRunFinishedAt: row.last_run_finished_at || null,
            nextRun: row.next_run || null,
            createdAt: row.created_at || null,
            updatedAt: row.updated_at || null,
        };
    }

    static safeJson(value, fallback) {
        if (!value) return fallback;
        try {
            const parsed = JSON.parse(value);
            return parsed === null ? fallback : parsed;
        } catch {
            return fallback;
        }
    }
}

module.exports = ScheduleModel;
