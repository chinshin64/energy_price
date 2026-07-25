'use strict';

const express = require('express');
const { sendRouteError } = require('./http-response');

function createSignatureRouter(options = {}) {
    const healthMonitor = options.healthMonitor;
    const refreshService = options.refreshService;
    if (!healthMonitor || !refreshService) {
        throw new TypeError('healthMonitor and refreshService are required');
    }

    const router = express.Router();
    router.get('/health', (req, res) => {
        try {
            const platforms = healthMonitor.checkAllPlatforms();
            const summary = {
                green: platforms.filter(item => item.status === 'green').length,
                yellow: platforms.filter(item => item.status === 'yellow').length,
                red: platforms.filter(item => item.status === 'red').length,
            };
            res.json({ success: true, summary, platforms, checkedAt: new Date().toISOString() });
        } catch (error) {
            sendRouteError(req, res, error);
        }
    });

    router.get('/status/:platform', (req, res) => {
        try {
            const result = healthMonitor.getPlatformStatus(req.params.platform);
            if (!result) {
                return res.status(404).json({
                    success: false,
                    error: `Unknown platform: ${req.params.platform}`,
                    requestId: req.requestId,
                });
            }
            return res.json({ success: true, data: result });
        } catch (error) {
            return sendRouteError(req, res, error);
        }
    });

    router.post('/refresh/:platform', async (req, res) => {
        try {
            const result = await refreshService.refresh(req.params.platform, req.body || {});
            const statusCode = result.success ? 200 : (result.code === 'rate_limited' ? 429 : 502);
            res.status(statusCode).json(result);
        } catch (error) {
            sendRouteError(req, res, error);
        }
    });

    router.get('/refresh/status', (req, res) => {
        try {
            res.json({ success: true, data: refreshService.getStatus() });
        } catch (error) {
            sendRouteError(req, res, error);
        }
    });

    router.post('/corpus/cleanup', (req, res) => {
        try {
            res.json({ success: true, data: healthMonitor.cleanupExpiredEntries() });
        } catch (error) {
            sendRouteError(req, res, error);
        }
    });

    router.post('/corpus/mark-expired', (req, res) => {
        try {
            res.json({ success: true, data: healthMonitor.markExpiredEntries() });
        } catch (error) {
            sendRouteError(req, res, error);
        }
    });

    return router;
}

module.exports = { createSignatureRouter };
