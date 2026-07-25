'use strict';

const express = require('express');

function createSystemRouter(options = {}) {
    const db = options.db;
    const authConfig = options.authConfig || {};
    const version = options.version || process.env.APP_VERSION || 'development';
    const now = options.now || (() => new Date().toISOString());
    if (!db) throw new TypeError('db is required');

    const router = express.Router();

    router.get('/health', (req, res) => {
        res.json({
            status: 'ok',
            version,
            timestamp: now()
        });
    });

    router.get('/readiness', (req, res) => {
        try {
            db.prepare('SELECT 1 AS ready').get();
            res.json({
                status: 'ready',
                database: 'ready',
                schemaVersion: db.applicationSchemaVersion || db.pragma('user_version', { simple: true }),
                migrationMode: db.applicationMigrationMode || 'unknown',
                authMode: authConfig.mode,
                timestamp: now()
            });
        } catch (error) {
            res.status(503).json({ status: 'not_ready', database: 'unavailable' });
        }
    });

    router.get('/auth/session', (req, res) => {
        const auth = req.auth || {};
        res.json({
            success: true,
            data: {
                subject: auth.subject,
                email: auth.email,
                roles: auth.roles,
                scopes: auth.scopes,
                mode: auth.mode
            }
        });
    });

    return router;
}

module.exports = { createSystemRouter };
