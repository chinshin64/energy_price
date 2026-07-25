'use strict';

const express = require('express');
const { sendRouteError } = require('./http-response');

function boundedInteger(value, fallback, minimum, maximum) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(minimum, Math.min(maximum, parsed));
}

function positiveInteger(value, fieldName) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        const error = new Error(`${fieldName} must be a positive integer`);
        error.statusCode = 400;
        error.code = `invalid_${fieldName.replace(/[^a-zA-Z0-9]+/g, '_')}`;
        throw error;
    }
    return parsed;
}

function optionalPositiveInteger(value, fieldName) {
    if (value === undefined || value === null || value === '') return null;
    return positiveInteger(value, fieldName);
}

function optionalText(value, maximumLength = 128) {
    if (value === undefined || value === null) return null;
    const text = String(value).trim();
    if (!text) return null;
    if (text.length > maximumLength) {
        const error = new Error(`value must not exceed ${maximumLength} characters`);
        error.statusCode = 400;
        error.code = 'invalid_text_length';
        throw error;
    }
    return text;
}

function inlineContentDisposition(filename) {
    const original = String(filename || 'evidence');
    const fallback = original
        .replace(/[^\x20-\x7e]/g, '_')
        .replace(/["\\\r\n]/g, '_')
        .slice(0, 180) || 'evidence';
    const encoded = encodeURIComponent(original).replace(/[!'()*]/g, character => (
        `%${character.charCodeAt(0).toString(16).toUpperCase()}`
    ));
    return `inline; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function createDataRouter(options = {}) {
    const stationModel = options.stationModel;
    const priceScheduleModel = options.priceScheduleModel;
    const runHistoryModel = options.runHistoryModel;
    if (!stationModel || !priceScheduleModel || !runHistoryModel) {
        throw new TypeError('data router dependencies are required');
    }

    const router = express.Router();

    router.get('/stats', (req, res) => {
        try {
            res.json({ success: true, data: stationModel.getStatistics() });
        } catch (error) {
            sendRouteError(req, res, error, { code: 'station_statistics_failed' });
        }
    });

    router.get('/price-schedules/statistics', (req, res) => {
        try {
            res.json({ success: true, data: priceScheduleModel.getStatistics() });
        } catch (error) {
            sendRouteError(req, res, error, { code: 'price_schedule_statistics_failed' });
        }
    });

    router.get('/price-schedules/station/:stationId', (req, res) => {
        try {
            const stationId = positiveInteger(req.params.stationId, 'station_id');
            res.json({ success: true, data: priceScheduleModel.getByStationId(stationId) });
        } catch (error) {
            sendRouteError(req, res, error, { code: 'price_schedule_query_failed' });
        }
    });

    router.get('/price-schedules/platform/:platform', (req, res) => {
        try {
            const platform = optionalText(req.params.platform);
            if (!platform) {
                const error = new Error('platform is required');
                error.statusCode = 400;
                error.code = 'platform_required';
                throw error;
            }
            const limit = boundedInteger(req.query.limit, 1000, 1, 5000);
            res.json({ success: true, data: priceScheduleModel.getByPlatform(platform, limit) });
        } catch (error) {
            sendRouteError(req, res, error, { code: 'price_schedule_query_failed' });
        }
    });

    router.post('/price-schedules/backfill', (req, res) => {
        try {
            const limit = optionalPositiveInteger(req.body?.limit, 'limit');
            const result = priceScheduleModel.backfillFromStations({
                platform: optionalText(req.body?.platform),
                limit,
                resetExisting: req.body?.resetExisting !== false,
            });
            res.json({ success: true, data: result });
        } catch (error) {
            sendRouteError(req, res, error, { code: 'price_schedule_backfill_failed' });
        }
    });

    router.get('/runs', (req, res) => {
        try {
            const limit = boundedInteger(req.query.limit, 30, 1, 200);
            res.json({ success: true, data: runHistoryModel.getRuns(limit) });
        } catch (error) {
            sendRouteError(req, res, error, { code: 'run_history_query_failed' });
        }
    });

    router.get('/runs/:id', (req, res) => {
        try {
            const runId = positiveInteger(req.params.id, 'run_id');
            const run = runHistoryModel.getRun(runId);
            if (!run) {
                return res.status(404).json({
                    success: false,
                    error: 'run not found',
                    code: 'run_not_found',
                    requestId: req.requestId,
                });
            }
            return res.json({ success: true, data: run });
        } catch (error) {
            return sendRouteError(req, res, error, { code: 'run_history_query_failed' });
        }
    });

    router.get('/run-logs', (req, res) => {
        try {
            const limit = boundedInteger(req.query.limit, 200, 1, 500);
            const runId = optionalPositiveInteger(req.query.runId, 'run_id');
            res.json({ success: true, data: runHistoryModel.getLogs(limit, runId) });
        } catch (error) {
            sendRouteError(req, res, error, { code: 'run_log_query_failed' });
        }
    });

    router.post('/stations/deduplicate', (req, res) => {
        let runId = null;
        try {
            runId = runHistoryModel.startRun('deduplicate', {});
            runHistoryModel.appendLog(runId, '开始执行去重');
            const result = stationModel.deduplicateExisting();
            runHistoryModel.appendLog(runId, `去重完成，删除 ${result.removed} 条重复数据`);
            runHistoryModel.finishRun(runId, 'success', { removed: result.removed });
            res.json({
                success: true,
                message: `去重完成，删除 ${result.removed} 条重复数据`,
                removed: result.removed,
            });
        } catch (error) {
            if (runId !== null) {
                try {
                    runHistoryModel.appendLog(runId, `去重失败: ${error.message}`, 'error');
                    runHistoryModel.finishRun(runId, 'failed', null, error.message);
                } catch {
                    // Preserve the original operation failure when run logging is unavailable.
                }
            }
            sendRouteError(req, res, error, { code: 'station_deduplicate_failed' });
        }
    });

    router.get('/stations/evidence-assets', (req, res) => {
        try {
            const assets = stationModel.getEvidenceAssets({
                limit: req.query.limit,
                platform: optionalText(req.query.platform),
                stationId: optionalPositiveInteger(req.query.stationId, 'station_id'),
                evidenceType: optionalText(req.query.evidenceType),
            });
            res.json({ success: true, data: assets });
        } catch (error) {
            sendRouteError(req, res, error, { code: 'station_evidence_query_failed' });
        }
    });

    router.get('/stations/evidence-assets/:id/content', (req, res) => {
        try {
            const evidenceId = positiveInteger(req.params.id, 'evidence_id');
            const evidence = stationModel.getEvidenceAssetFilePath(evidenceId);
            if (!evidence) {
                return res.status(404).json({
                    success: false,
                    error: 'evidence asset not found',
                    code: 'station_evidence_not_found',
                    requestId: req.requestId,
                });
            }
            res.setHeader('Content-Type', evidence.contentType);
            res.setHeader('Content-Disposition', inlineContentDisposition(evidence.filename));
            return res.sendFile(evidence.filePath);
        } catch (error) {
            return sendRouteError(req, res, error, { code: 'station_evidence_read_failed' });
        }
    });

    router.get('/stations/recent', (req, res) => {
        try {
            const limit = boundedInteger(req.query.limit, 100, 1, 1000);
            const platform = optionalText(req.query.platform);
            res.json({ success: true, data: stationModel.getRecent(limit, platform) });
        } catch (error) {
            sendRouteError(req, res, error, { code: 'station_recent_query_failed' });
        }
    });

    router.get('/stations/range', (req, res) => {
        try {
            const start = optionalText(req.query.start, 64);
            const end = optionalText(req.query.end, 64);
            if (!start || !end) {
                return res.status(400).json({
                    success: false,
                    error: 'start and end required',
                    code: 'station_range_required',
                    requestId: req.requestId,
                });
            }
            const platform = optionalText(req.query.platform);
            return res.json({
                success: true,
                data: stationModel.getByDateRange(start, end, platform),
            });
        } catch (error) {
            return sendRouteError(req, res, error, { code: 'station_range_query_failed' });
        }
    });

    return router;
}

module.exports = {
    boundedInteger,
    createDataRouter,
    inlineContentDisposition,
    positiveInteger,
};
