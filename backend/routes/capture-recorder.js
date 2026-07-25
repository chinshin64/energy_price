'use strict';

const express = require('express');
const { sendRouteError } = require('./http-response');

function createCaptureRecorderRouter(options = {}) {
    const service = options.service;
    if (!service) throw new TypeError('service is required');
    const router = express.Router();

    router.get('/status', (req, res) => {
        try {
            res.json({ success: true, data: service.getStatus() });
        } catch (error) {
            sendRouteError(req, res, error);
        }
    });

    router.post('/start', (req, res) => {
        try {
            res.json({ success: true, data: service.startSession(req.body || {}) });
        } catch (error) {
            sendRouteError(req, res, error, { statusCode: 400, code: 'capture_start_failed' });
        }
    });

    router.post('/stop', (req, res) => {
        try {
            res.json({ success: true, data: service.stopSession() });
        } catch (error) {
            sendRouteError(req, res, error, { statusCode: 400, code: 'capture_stop_failed' });
        }
    });

    return router;
}

module.exports = { createCaptureRecorderRouter };
