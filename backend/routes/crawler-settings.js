'use strict';

const express = require('express');
const { sendRouteError } = require('./http-response');

const UNLIMITED_VALUES = new Set(['unlimited', 'none', 'no-limit', 'infinity', '∞']);

function normalizePerRunLimit(body = {}) {
    const rawLimit = body.perRunLimit;
    const unlimited = body.unlimited === true
        || body.perRunUnlimited === true
        || rawLimit === null
        || UNLIMITED_VALUES.has(String(rawLimit || '').trim().toLowerCase());
    if (unlimited) return 'unlimited';

    const parsed = Number(rawLimit);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        const error = new Error('perRunLimit must be a positive number');
        error.statusCode = 400;
        error.code = 'crawler_run_quota_invalid';
        throw error;
    }
    return parsed;
}

function createCrawlerSettingsRouter(options = {}) {
    const appSettingModel = options.appSettingModel;
    if (!appSettingModel) throw new TypeError('appSettingModel is required');
    const router = express.Router();

    router.get('/run-quota', (req, res) => {
        try {
            res.json({ success: true, data: appSettingModel.getCrawlerRunQuotaStatus() });
        } catch (error) {
            sendRouteError(req, res, error, { code: 'crawler_run_quota_query_failed' });
        }
    });

    router.put('/run-quota', (req, res) => {
        try {
            const data = appSettingModel.saveCrawlerPerRunLimit(normalizePerRunLimit(req.body || {}));
            res.json({ success: true, data });
        } catch (error) {
            sendRouteError(req, res, error, { code: 'crawler_run_quota_update_failed' });
        }
    });

    return router;
}

module.exports = { createCrawlerSettingsRouter, normalizePerRunLimit };
