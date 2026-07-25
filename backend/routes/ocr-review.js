'use strict';

const express = require('express');
const { sendRouteError } = require('./http-response');

function positiveReviewId(value) {
    const id = Number(value);
    if (!Number.isInteger(id) || id <= 0) {
        const error = new Error('invalid id');
        error.statusCode = 400;
        error.code = 'ocr_review_id_invalid';
        throw error;
    }
    return id;
}

function boundedInteger(value, fallback, minimum, maximum) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(minimum, Math.min(maximum, parsed));
}

function createOcrReviewRouter(options = {}) {
    const stationModel = options.stationModel;
    if (!stationModel) throw new TypeError('stationModel is required');
    const router = express.Router();

    router.get('/ocr-quality/dashboard', (req, res) => {
        try {
            res.json({ success: true, data: stationModel.getOcrQualityDashboard() });
        } catch (error) {
            sendRouteError(req, res, error, { code: 'ocr_quality_query_failed' });
        }
    });

    router.get('/ocr-review/pending', (req, res) => {
        try {
            const limit = boundedInteger(req.query.limit, 100, 1, 500);
            const offset = boundedInteger(req.query.offset, 0, 0, 1_000_000);
            const rows = stationModel.getPendingReview(limit, offset);
            const total = stationModel.getPendingReviewCount();
            res.json({ success: true, data: rows, total, limit, offset });
        } catch (error) {
            sendRouteError(req, res, error, { code: 'ocr_review_query_failed' });
        }
    });

    router.post('/ocr-review/approve/:id', (req, res) => {
        try {
            const result = stationModel.approveStation(positiveReviewId(req.params.id));
            if (result.changes === 0) {
                return res.status(404).json({
                    success: false,
                    error: 'not found or already approved',
                    code: 'ocr_review_not_pending',
                    requestId: req.requestId,
                });
            }
            return res.json({ success: true, message: '审核通过', changes: result.changes });
        } catch (error) {
            return sendRouteError(req, res, error, { code: 'ocr_review_approve_failed' });
        }
    });

    router.post('/ocr-review/reject/:id', (req, res) => {
        try {
            const result = stationModel.rejectStation(positiveReviewId(req.params.id));
            if (result.changes === 0) {
                return res.status(404).json({
                    success: false,
                    error: 'not found or already processed',
                    code: 'ocr_review_not_pending',
                    requestId: req.requestId,
                });
            }
            return res.json({ success: true, message: '已拒绝并移入异常池', changes: result.changes });
        } catch (error) {
            return sendRouteError(req, res, error, { code: 'ocr_review_reject_failed' });
        }
    });

    return router;
}

module.exports = { createOcrReviewRouter, positiveReviewId };
