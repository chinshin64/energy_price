const db = require('../database/init');
const { redactText, serializeRedacted } = require('../services/sensitive-redactor');

class RunHistoryModel {
  static startRun(runType, payload = {}) {
    const stmt = db.prepare(`
      INSERT INTO crawl_runs (run_type, status, request_payload)
      VALUES (?, 'running', ?)
    `);
    const result = stmt.run(runType, serializeRedacted(payload, { maxBytes: 64 * 1024 }));
    return result.lastInsertRowid;
  }

  static appendLog(runId, message, level = 'info') {
    return db.prepare(`
      INSERT INTO crawl_run_logs (run_id, level, message)
      VALUES (?, ?, ?)
    `).run(runId, level, redactText(String(message || '')).slice(0, 4000));
  }

  static finishRun(runId, status, summary = null, errorMessage = null) {
    const run = db.prepare(`SELECT created_at FROM crawl_runs WHERE id = ?`).get(runId);
    let durationMs = null;

    if (run && run.created_at) {
      const started = new Date(run.created_at.replace(' ', 'T'));
      durationMs = Math.max(0, Date.now() - started.getTime());
    }

    return db.prepare(`
      UPDATE crawl_runs
      SET
        status = ?,
        result_summary = ?,
        error_message = ?,
        finished_at = datetime('now', 'localtime'),
        duration_ms = ?
      WHERE id = ?
    `).run(
      status,
      serializeRedacted(summary, { maxBytes: 64 * 1024 }),
      errorMessage ? redactText(errorMessage).slice(0, 4000) : null,
      durationMs,
      runId
    );
  }

  static updateRunSummary(runId, summary = null) {
    return db.prepare(`
      UPDATE crawl_runs
      SET result_summary = ?
      WHERE id = ?
    `).run(
      serializeRedacted(summary, { maxBytes: 64 * 1024 }),
      runId
    );
  }

  static markInterruptedRuns(reason = 'service restarted before task finished') {
    return db.prepare(`
      UPDATE crawl_runs
      SET
        status = 'aborted',
        error_message = COALESCE(error_message, ?),
        finished_at = datetime('now', 'localtime'),
        duration_ms = COALESCE(duration_ms, 0)
      WHERE status = 'running'
    `).run(reason);
  }

  static getRuns(limit = 30) {
    return db.prepare(`
      SELECT
        id, run_type, status, request_payload, result_summary, error_message,
        created_at, finished_at, duration_ms
      FROM crawl_runs
      ORDER BY id DESC
      LIMIT ?
    `).all(limit).map(row => this.mapRun(row));
  }

  static getRun(runId) {
    const row = db.prepare(`
      SELECT
        id, run_type, status, request_payload, result_summary, error_message,
        created_at, finished_at, duration_ms
      FROM crawl_runs
      WHERE id = ?
    `).get(runId);

    return row ? this.mapRun(row) : null;
  }

  static mapRun(row) {
    return {
      id: row.id,
      runType: row.run_type,
      status: row.status,
      requestPayload: this.safeParse(row.request_payload),
      resultSummary: this.safeParse(row.result_summary),
      errorMessage: row.error_message,
      createdAt: row.created_at,
      finishedAt: row.finished_at,
      durationMs: row.duration_ms
    };
  }

  static getLogs(limit = 200, runId = null) {
    if (runId) {
      return db.prepare(`
        SELECT id, run_id, level, message, created_at
        FROM crawl_run_logs
        WHERE run_id = ?
        ORDER BY id DESC
        LIMIT ?
      `).all(runId, limit).map(this.mapLog);
    }

    return db.prepare(`
      SELECT id, run_id, level, message, created_at
      FROM crawl_run_logs
      ORDER BY id DESC
      LIMIT ?
    `).all(limit).map(this.mapLog);
  }

  static mapLog(row) {
    return {
      id: row.id,
      runId: row.run_id,
      level: row.level,
      message: row.message,
      createdAt: row.created_at
    };
  }

  static safeParse(text) {
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch (e) {
      return null;
    }
  }
}

module.exports = RunHistoryModel;
