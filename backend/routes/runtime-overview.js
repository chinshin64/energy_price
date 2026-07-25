'use strict';

const express = require('express');
const { sendRouteError } = require('./http-response');

function createRuntimeOverviewRouter(options = {}) {
    const service = options.service;
    if (!service) throw new TypeError('service is required');
    const router = express.Router();

    router.get('/config', async (req, res) => {
        try {
            res.json(await service.getOverview());
        } catch (error) {
            sendRouteError(req, res, error, { code: 'runtime_overview_failed' });
        }
    });

    return router;
}

module.exports = { createRuntimeOverviewRouter };
