'use strict';

const express = require('express');
const Method3Service = require('../services/method3-service');
const DidiSignatureProvider = require('../services/didi-signature-provider');

const router = express.Router();

let _service = null;
function getService(req) {
    if (req.app.locals.method3Service) {
        return req.app.locals.method3Service;
    }
    if (!_service) {
        const providerOptions = (req.app.locals.config?.didiSignatureProvider) || {};
        const signatureProvider = new DidiSignatureProvider(providerOptions);
        _service = new Method3Service({ signatureProvider, aiAgentConfig: req.app.locals.config || {} });
    }
    return _service;
}

/**
 * GET /api/method3/status
 * 返回模板统计、语料统计、最近失败原因
 */
router.get('/status', (req, res) => {
    try {
        const result = getService(req).getStatus(req.query || {});
        res.json(result);
    } catch (err) {
        console.error("[method3-route]", err);
        res.status(500).json({
            success: false,
            reason: 'unknown_error',
            message: "Internal error; check server logs for details",
        });
    }
});

/**
 * POST /api/method3/preflight
 * 只做模板和签名语料匹配预检，不发真实请求
 */
router.post('/preflight', (req, res) => {
    try {
        const result = getService(req).preflight(req.body || {});
        const status = result.status === 'matched' ? 200 : 200; // preflight always 200 with status field
        res.status(status).json(result);
    } catch (err) {
        console.error("[method3-route]", err);
        res.status(500).json({
            success: false,
            reason: 'unknown_error',
            message: "Internal error; check server logs for details",
        });
    }
});

/**
 * POST /api/method3/run-basic-check
 * 只在 preflight matched 时执行小规模请求
 */
router.post('/run-basic-check', async (req, res) => {
    try {
        const result = await getService(req).runBasicCheck(req.body || {});
        const status = result.success ? 200 : 400;
        res.status(status).json(result);
    } catch (err) {
        console.error("[method3-route]", err);
        res.status(500).json({
            success: false,
            reason: 'unknown_error',
            message: "Internal error; check server logs for details",
        });
    }
});

module.exports = router;
