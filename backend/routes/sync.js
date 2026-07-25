'use strict';

const fs = require('node:fs');
const express = require('express');
const { sendRouteError } = require('./http-response');

function createSyncRouter(options = {}) {
    const service = options.service;
    const requireToken = options.requireToken;
    const upload = options.upload;
    if (!service || !requireToken || !upload?.single) {
        throw new TypeError('sync router dependencies are required');
    }
    const router = express.Router();

    router.get('/nodes', async (req, res) => {
        try {
            const nodes = service.loadNodes();
            const syncState = service.loadSyncState();
            const result = await Promise.all(nodes.map(async node => {
                const status = await service.checkNodeHealth(node.url, node.authToken);
                const nodeState = syncState[node.name] || {};
                return {
                    name: node.name,
                    url: node.url,
                    status,
                    direction: node.direction || 'push-only',
                    enabled: node.enabled !== false,
                    lastSyncAt: nodeState.lastPushAt || null,
                    lastPushAt: nodeState.lastPushAt || null,
                };
            }));
            res.json({ success: true, data: result });
        } catch (error) {
            sendRouteError(req, res, error);
        }
    });

    router.post('/nodes', (req, res) => {
        try {
            res.json({ success: true, data: service.addNode(req.body || {}) });
        } catch (error) {
            sendRouteError(req, res, error);
        }
    });

    router.delete('/nodes/:name', (req, res) => {
        try {
            res.json({ success: true, data: service.removeNode(req.params.name) });
        } catch (error) {
            sendRouteError(req, res, error);
        }
    });

    router.get('/status', async (req, res) => {
        try {
            res.json({ success: true, data: await service.getSyncStatus(req.query.node || '172-server') });
        } catch (error) {
            sendRouteError(req, res, error);
        }
    });

    router.post('/push', async (req, res) => {
        try {
            const body = req.body || {};
            res.json({
                success: true,
                data: await service.push(body.node || '172-server', { reportIds: body.reportIds || null }),
            });
        } catch (error) {
            sendRouteError(req, res, error);
        }
    });

    router.post('/receive/report', requireToken, (req, res) => {
        try {
            const { reportId, reportData, source } = req.body || {};
            if (!reportId || !reportData) {
                return res.status(400).json({
                    success: false,
                    error: 'reportId and reportData are required',
                    code: 'sync_payload_invalid',
                    requestId: req.requestId,
                });
            }
            return res.json({ success: true, data: service.receiveReport(reportId, reportData, source) });
        } catch (error) {
            return sendRouteError(req, res, error);
        }
    });

    router.post('/receive/evidence', requireToken, upload.single('file'), (req, res) => {
        try {
            const { reportId, type, filePath } = req.body || {};
            const file = req.file || (req.files && req.files[0]);
            if (!reportId || !type || !file) {
                return res.status(400).json({
                    success: false,
                    error: 'reportId, type and file are required',
                    code: 'sync_payload_invalid',
                    requestId: req.requestId,
                });
            }
            const fileBuffer = file.buffer || fs.readFileSync(file.path);
            return res.json({
                success: true,
                data: service.receiveEvidence(reportId, type, filePath || file.originalname, fileBuffer),
            });
        } catch (error) {
            return sendRouteError(req, res, error);
        }
    });

    router.get('/receive/check', requireToken, (req, res) => {
        try {
            const existing = service.checkExistingReports(req.query.reportIds || '');
            res.json({ success: true, data: { existing } });
        } catch (error) {
            sendRouteError(req, res, error);
        }
    });

    return router;
}

module.exports = { createSyncRouter };
