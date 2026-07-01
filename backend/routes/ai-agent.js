'use strict';

const express = require('express');
const { RequestFailureAnalyzer } = require('../services/request-failure-analyzer');

const router = express.Router();

function analyzer(req) {
    const config = typeof req.app.locals.getEffectiveConfig === 'function'
        ? req.app.locals.getEffectiveConfig()
        : (req.app.locals.config || {});
    return new RequestFailureAnalyzer({ config });
}

router.get('/status', (req, res) => {
    try {
        res.json(analyzer(req).getStatus());
    } catch (err) {
        res.status(500).json({ success: false, reason: 'unknown_error', message: err.message });
    }
});

router.post('/analyze-failure', async (req, res) => {
    try {
        const result = await analyzer(req).analyzeFailure(req.body || {});
        res.status(result.success ? 200 : 400).json(result);
    } catch (err) {
        res.status(500).json({ success: false, reason: 'unknown_error', message: err.message });
    }
});

router.get('/failure-events', (req, res) => {
    try {
        const limit = Number(req.query.limit || 50);
        res.json({ success: true, items: analyzer(req).store.listFailureEvents(limit) });
    } catch (err) {
        res.status(500).json({ success: false, reason: 'unknown_error', message: err.message });
    }
});

router.get('/analyses', (req, res) => {
    try {
        const limit = Number(req.query.limit || 50);
        res.json({ success: true, items: analyzer(req).store.listAnalyses(limit) });
    } catch (err) {
        res.status(500).json({ success: false, reason: 'unknown_error', message: err.message });
    }
});

router.get('/patches', (req, res) => {
    try {
        const limit = Number(req.query.limit || 50);
        res.json({ success: true, items: analyzer(req).store.listPatches(limit) });
    } catch (err) {
        res.status(500).json({ success: false, reason: 'unknown_error', message: err.message });
    }
});

router.get('/strategies', (req, res) => {
    try {
        res.json({ success: true, ...analyzer(req).store.listStrategies() });
    } catch (err) {
        res.status(500).json({ success: false, reason: 'unknown_error', message: err.message });
    }
});

router.post('/patches/:id/apply', (req, res) => {
    try {
        const result = analyzer(req).applier.applyPatchById(req.params.id, { force: true, appliedBy: 'human' });
        res.status(result.success ? 200 : 404).json(result);
    } catch (err) {
        res.status(500).json({ success: false, reason: 'unknown_error', message: err.message });
    }
});

router.post('/patches/:id/reject', (req, res) => {
    try {
        const result = analyzer(req).applier.rejectPatchById(req.params.id, { rejectedBy: 'human', reason: req.body?.reason || '' });
        res.status(result.success ? 200 : 404).json(result);
    } catch (err) {
        res.status(500).json({ success: false, reason: 'unknown_error', message: err.message });
    }
});

module.exports = router;
