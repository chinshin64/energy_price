'use strict';

const express = require('express');
const { sendRouteError } = require('./http-response');

function createPlatformDiagnosticsRouter(options = {}) {
    const service = options.service;
    if (!service) throw new TypeError('service is required');
    const router = express.Router();

    router.get('/platforms', (req, res) => {
        try {
            res.json({ success: true, data: service.list() });
        } catch (error) {
            sendRouteError(req, res, error, { code: 'platform_diagnostics_failed' });
        }
    });

    return router;
}

module.exports = { createPlatformDiagnosticsRouter };
