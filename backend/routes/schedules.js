'use strict';

const express = require('express');
const { sendRouteError } = require('./http-response');

function positiveScheduleId(value) {
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id <= 0) {
        const error = new Error('schedule id must be a positive integer');
        error.code = 'schedule_id_invalid';
        error.statusCode = 400;
        throw error;
    }
    return id;
}

function createSchedulesRouter(options = {}) {
    const service = options.service;
    if (!service) throw new TypeError('service is required');
    const router = express.Router();

    router.get('/', (req, res) => {
        try {
            res.json({ success: true, data: service.list() });
        } catch (error) {
            sendRouteError(req, res, error, { code: 'schedule_query_failed' });
        }
    });

    router.post('/', (req, res) => {
        try {
            res.status(201).json({ success: true, data: service.create(req.body || {}) });
        } catch (error) {
            sendRouteError(req, res, error, { code: 'schedule_create_failed' });
        }
    });

    router.post('/:id/run', (req, res) => {
        try {
            res.status(202).json({ success: true, data: service.startNow(positiveScheduleId(req.params.id)) });
        } catch (error) {
            sendRouteError(req, res, error, { code: 'schedule_run_failed' });
        }
    });

    router.post('/:id/drill', (req, res) => {
        try {
            res.json({
                success: true,
                data: service.drill(positiveScheduleId(req.params.id), req.body || {}),
            });
        } catch (error) {
            sendRouteError(req, res, error, { code: 'schedule_drill_failed' });
        }
    });

    router.delete('/:id', (req, res) => {
        try {
            service.delete(positiveScheduleId(req.params.id));
            res.json({ success: true, message: 'Schedule deleted' });
        } catch (error) {
            sendRouteError(req, res, error, { code: 'schedule_delete_failed' });
        }
    });

    router.patch('/:id/toggle', (req, res) => {
        try {
            res.json({
                success: true,
                message: 'Schedule updated',
                data: service.toggle(positiveScheduleId(req.params.id), req.body?.enabled),
            });
        } catch (error) {
            sendRouteError(req, res, error, { code: 'schedule_toggle_failed' });
        }
    });

    return router;
}

module.exports = { createSchedulesRouter, positiveScheduleId };
