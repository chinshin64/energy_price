'use strict';

const express = require('express');
const { sendRouteError } = require('./http-response');

function queryFlag(value, defaultValue = true) {
    if (value === undefined || value === null || value === '') return defaultValue;
    return !/^(0|false|no|off)$/i.test(String(value));
}

function createBlueTeamReportsRouter(options = {}) {
    const service = options.service;
    if (!service) throw new TypeError('service is required');
    const router = express.Router();
    const fail = (req, res, error) => sendRouteError(req, res, error, { code: 'blue_team_report_error' });

    router.get('/', (req, res) => {
        try {
            const result = service.listReports({
                limit: req.query.limit,
                offset: req.query.offset,
                method: req.query.method,
                platform: req.query.platform,
                city: req.query.city,
                overallStatus: req.query.overallStatus || req.query.status,
                riskLevel: req.query.riskLevel || req.query.risk,
            });
            res.json({
                success: true,
                data: result.data || [],
                meta: {
                    total: result.total || 0,
                    limit: result.limit || 100,
                    offset: result.offset || 0,
                },
            });
        } catch (error) {
            fail(req, res, error);
        }
    });

    router.post('/start', (req, res) => {
        try {
            res.status(201).json({ success: true, data: service.startReport(req.body || {}) });
        } catch (error) {
            fail(req, res, error);
        }
    });

    router.post('/sanitize', (req, res) => {
        try {
            res.json({ success: true, data: service.sanitizeReport(req.body?.data || req.body || {}) });
        } catch (error) {
            fail(req, res, error);
        }
    });

    router.post('/seed', (req, res) => {
        try {
            const result = service.ensureSeedReport({ overwrite: req.body?.overwrite === true });
            res.status(result.created ? 201 : 200).json({
                success: true,
                message: result.created ? 'blue-team sample report seeded' : 'blue-team sample report already exists',
                data: result.report,
                meta: { created: result.created, files: result.files },
            });
        } catch (error) {
            fail(req, res, error);
        }
    });

    router.post('/:reportId/events', (req, res) => {
        try {
            const payload = req.body?.events !== undefined ? req.body.events : (req.body?.event || req.body || {});
            res.json({ success: true, data: service.appendEvent(req.params.reportId, payload) });
        } catch (error) {
            fail(req, res, error);
        }
    });

    router.post('/:reportId/evidence', (req, res) => {
        try {
            res.status(201).json({ success: true, data: service.appendEvidence(req.params.reportId, req.body || {}) });
        } catch (error) {
            fail(req, res, error);
        }
    });

    router.post('/:reportId/finalize', (req, res) => {
        try {
            res.json({ success: true, data: service.finalizeReport(req.params.reportId, req.body || {}) });
        } catch (error) {
            fail(req, res, error);
        }
    });

    router.post('/:reportId/retest', (req, res) => {
        try {
            res.status(201).json({ success: true, data: service.createRetest(req.params.reportId, req.body || {}) });
        } catch (error) {
            fail(req, res, error);
        }
    });

    router.get('/:reportId/download', (req, res) => {
        try {
            const download = service.getDownload(req.params.reportId, req.query.format || 'json', {
                sanitize: queryFlag(req.query.sanitize, true),
                actor: req.auth?.subject || req.get('x-user') || req.ip || 'anonymous',
            });
            res.setHeader('Content-Type', download.contentType);
            res.setHeader('Content-Disposition', `attachment; filename="${download.filename}"`);
            res.send(download.content);
        } catch (error) {
            fail(req, res, error);
        }
    });

    router.get('/:reportId/evidence/:type/:filename?', (req, res) => {
        try {
            const evidence = service.readEvidenceFile(
                req.params.reportId,
                req.params.type,
                req.params.filename,
                { sanitize: queryFlag(req.query.sanitize, true) }
            );
            res.setHeader('Content-Type', evidence.contentType);
            res.setHeader('Content-Disposition', `inline; filename="${evidence.filename}"`);
            if (Object.prototype.hasOwnProperty.call(evidence, 'content')) {
                res.send(evidence.content);
            } else {
                res.sendFile(evidence.filePath);
            }
        } catch (error) {
            fail(req, res, error);
        }
    });

    router.get('/:reportId/evidence-list', (req, res) => {
        try {
            const files = service.getRelativeFiles(req.params.reportId);
            res.json({ success: true, data: { files: files.evidence || {} } });
        } catch (error) {
            fail(req, res, error);
        }
    });

    router.get('/:reportId', (req, res) => {
        try {
            const report = service.readReport(req.params.reportId);
            res.json({
                success: true,
                data: queryFlag(req.query.sanitize, true) ? service.sanitizeReport(report) : report,
            });
        } catch (error) {
            fail(req, res, error);
        }
    });

    return router;
}

module.exports = { createBlueTeamReportsRouter, queryFlag };
