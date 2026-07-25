'use strict';

const db = require('../database/init');
const { serializeRedacted } = require('../services/sensitive-redactor');

class AuditEventModel {
    static record(event = {}) {
        const required = ['eventId', 'requestId', 'actorId', 'authMode', 'action', 'resource', 'path', 'outcome'];
        for (const field of required) {
            if (!String(event[field] || '').trim()) {
                throw new Error(`audit event missing ${field}`);
            }
        }
        return db.prepare(`
            INSERT INTO audit_events (
                event_id, request_id, actor_id, auth_mode, roles, action, resource,
                method, path, status_code, outcome, remote_address, user_agent,
                duration_ms, metadata
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            this.text(event.eventId, 128),
            this.text(event.requestId, 128),
            this.text(event.actorId, 255),
            this.text(event.authMode, 64),
            JSON.stringify(Array.isArray(event.roles) ? event.roles.slice(0, 20) : []),
            this.text(event.action, 64),
            this.text(event.resource, 255),
            this.text(event.method, 16),
            this.text(event.path, 1024),
            Number.isInteger(Number(event.statusCode)) ? Number(event.statusCode) : null,
            this.text(event.outcome, 64),
            this.text(event.remoteAddress, 128),
            this.text(event.userAgent, 512),
            Number.isFinite(Number(event.durationMs)) ? Math.max(0, Math.floor(Number(event.durationMs))) : null,
            serializeRedacted(event.metadata, { maxBytes: 16 * 1024 })
        );
    }

    static list(filters = {}) {
        const where = [];
        const params = [];
        for (const [field, column] of [
            ['actorId', 'actor_id'],
            ['resource', 'resource'],
            ['outcome', 'outcome'],
            ['requestId', 'request_id']
        ]) {
            if (filters[field]) {
                where.push(`${column} = ?`);
                params.push(String(filters[field]));
            }
        }
        const limit = Math.max(1, Math.min(1000, Math.floor(Number(filters.limit) || 100)));
        const offset = Math.max(0, Math.floor(Number(filters.offset) || 0));
        const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
        const rows = db.prepare(`
            SELECT *
            FROM audit_events
            ${clause}
            ORDER BY id DESC
            LIMIT ? OFFSET ?
        `).all(...params, limit, offset);
        return rows.map(row => this.mapRow(row));
    }

    static mapRow(row) {
        return {
            id: Number(row.id),
            eventId: row.event_id,
            requestId: row.request_id,
            actorId: row.actor_id,
            authMode: row.auth_mode,
            roles: this.parseJson(row.roles, []),
            action: row.action,
            resource: row.resource,
            method: row.method,
            path: row.path,
            statusCode: row.status_code === null ? null : Number(row.status_code),
            outcome: row.outcome,
            remoteAddress: row.remote_address || null,
            userAgent: row.user_agent || null,
            durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
            metadata: this.parseJson(row.metadata, null),
            createdAt: row.created_at
        };
    }

    static parseJson(value, fallback) {
        if (!value) return fallback;
        try {
            return JSON.parse(value);
        } catch {
            return fallback;
        }
    }

    static text(value, maxLength) {
        return String(value || '').trim().slice(0, maxLength);
    }
}

module.exports = AuditEventModel;
