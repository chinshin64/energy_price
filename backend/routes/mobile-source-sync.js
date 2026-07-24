'use strict';

const express = require('express');
const { sendRouteError } = require('./http-response');

function createMobileSourceSyncRouter(options = {}) {
    if (!options.service) throw new TypeError('mobile source sync service is required');
    const service = options.service;
    const router = express.Router();

    router.get('/status', (req, res) => {
        try {
            res.json({ success: true, data: service.getStatus() });
        } catch (error) {
            sendRouteError(req, res, error);
        }
    });

    router.post('/pull', async (req, res) => {
        try {
            res.json({ success: true, data: await service.pullOnce() });
        } catch (error) {
            sendRouteError(req, res, error);
        }
    });

    return router;
}

module.exports = { createMobileSourceSyncRouter };
