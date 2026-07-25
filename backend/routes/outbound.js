'use strict';

const express = require('express');
const { sendRouteError } = require('./http-response');

function boundedLimit(value, fallback, maximum) {
    return Math.max(1, Math.min(maximum, Number.parseInt(value, 10) || fallback));
}

function createOutboundRouter(options = {}) {
    const client = options.client;
    if (!client) throw new TypeError('client is required');
    const router = express.Router();

    router.get('/status', (req, res) => {
        try {
            res.json({ success: true, data: client.getStatus(boundedLimit(req.query.limit, 20, 200)) });
        } catch (error) {
            sendRouteError(req, res, error);
        }
    });

    router.get('/evidence/recent', (req, res) => {
        try {
            res.json({ success: true, data: client.getRecentEvidence(boundedLimit(req.query.limit, 100, 1000)) });
        } catch (error) {
            sendRouteError(req, res, error);
        }
    });

    return router;
}

module.exports = { boundedLimit, createOutboundRouter };
