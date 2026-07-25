'use strict';

const express = require('express');
const { sendRouteError } = require('./http-response');

function createAuditRouter(options = {}) {
    const model = options.model;
    if (!model) throw new TypeError('model is required');
    const router = express.Router();

    router.get('/events', (req, res) => {
        try {
            const data = model.list({
                actorId: req.query.actorId,
                resource: req.query.resource,
                outcome: req.query.outcome,
                requestId: req.query.requestId,
                limit: req.query.limit,
                offset: req.query.offset,
            });
            res.json({ success: true, data });
        } catch (error) {
            sendRouteError(req, res, error);
        }
    });

    return router;
}

module.exports = { createAuditRouter };
