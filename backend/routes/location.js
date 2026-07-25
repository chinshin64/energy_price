'use strict';

const express = require('express');
const { sendRouteError } = require('./http-response');

function createLocationRouter(options = {}) {
    const simulator = options.simulator;
    if (!simulator) throw new TypeError('simulator is required');
    const router = express.Router();

    router.post('/simulate', (req, res) => {
        try {
            const { city, lat, lng, windowId, windowBounds } = req.body || {};
            const result = simulator.setSimulatedLocation({ city, lat, lng, windowId, windowBounds });
            res.json({ success: result.success, data: result });
        } catch (error) {
            sendRouteError(req, res, error, { statusCode: 400, code: 'location_request_invalid' });
        }
    });

    router.post('/authorize', (req, res) => {
        try {
            const { windowId, windowBounds } = req.body || {};
            const result = simulator.clickAuthorizeButton(windowId, windowBounds);
            res.json({ success: result.success, data: result });
        } catch (error) {
            sendRouteError(req, res, error, { statusCode: 400, code: 'location_request_invalid' });
        }
    });

    router.get('/status', (req, res) => {
        res.json({ success: true, data: simulator.getStatus() });
    });

    return router;
}

module.exports = { createLocationRouter };
