'use strict';

const express = require('express');
const { sendRouteError } = require('./http-response');

function boundedLimit(value) {
    if (value === undefined || value === null || value === '') return 40;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return 40;
    return Math.max(1, Math.min(200, Math.trunc(parsed)));
}

function createSelfHealRouter(options = {}) {
    const service = options.service;
    if (!service) throw new TypeError('service is required');
    const router = express.Router();

    router.get('/settings', (req, res) => {
        if (!service.enabled) {
            return res.json({ success: true, data: service.getDisabledSettings() });
        }
        try {
            return res.json({ success: true, data: service.getSettings() });
        } catch (error) {
            return sendRouteError(req, res, error, { code: 'self_heal_settings_query_failed' });
        }
    });

    router.put('/settings', (req, res) => {
        if (!service.enabled) {
            return res.status(503).json(service.getDisabledResponse('自动排查与自愈'));
        }
        try {
            return res.json({ success: true, data: service.saveSettings(req.body || {}) });
        } catch (error) {
            return sendRouteError(req, res, error, {
                statusCode: 400,
                code: 'self_heal_settings_invalid',
            });
        }
    });

    router.get('/runs', (req, res) => {
        if (!service.enabled) return res.json({ success: true, data: [] });
        try {
            return res.json({ success: true, data: service.listRuns(boundedLimit(req.query.limit)) });
        } catch (error) {
            return sendRouteError(req, res, error, { code: 'self_heal_runs_query_failed' });
        }
    });

    router.post('/diagnose', (req, res) => {
        if (!service.enabled) {
            return res.status(503).json(service.getDisabledResponse('自动排查诊断'));
        }
        try {
            return res.json({ success: true, data: service.diagnoseAndRecord(req.body || {}) });
        } catch (error) {
            return sendRouteError(req, res, error, { code: 'self_heal_diagnosis_failed' });
        }
    });

    router.post('/apply', (req, res) => {
        if (!service.enabled) {
            return res.status(503).json(service.getDisabledResponse('自动排查修复'));
        }
        try {
            return res.json({ success: true, data: service.apply(req.body || {}) });
        } catch (error) {
            return sendRouteError(req, res, error, { code: 'self_heal_apply_failed' });
        }
    });

    return router;
}

module.exports = { boundedLimit, createSelfHealRouter };
