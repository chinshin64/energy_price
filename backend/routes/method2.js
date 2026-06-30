'use strict';

const express = require('express');
const Method2Service = require('../services/method2-service');

const router = express.Router();

// 延迟实例化，避免模块加载顺序问题
let _service = null;
function getService(req) {
    if (!_service) {
        const CaptureRecorder = require('../services/capture-recorder');
        const recorderOptions = (req.app.locals.config?.captureRecorder) || {};
        const mergedOptions = {
            bin: process.env.CAPTURE_RECORDER_BIN || '',
            listenHost: process.env.CAPTURE_RECORDER_HOST || '0.0.0.0',
            listenPort: Number(process.env.CAPTURE_RECORDER_PORT || 8899),
            ...recorderOptions,
        };
        const recorder = new CaptureRecorder(mergedOptions);
        _service = new Method2Service({ recorder, aiAgentConfig: req.app.locals.config || {} });
    }
    return _service;
}

/**
 * GET /api/method2/status
 * 返回 mitmdump、recorder、proxy、harOutput 状态
 */
router.get('/status', (req, res) => {
    try {
        const result = getService(req).getStatus();
        res.json(result);
    } catch (err) {
        console.error("[method2-route]", err);
        res.status(500).json({
            success: false,
            reason: 'unknown_error',
            message: "Internal error; check server logs for details",
        });
    }
});

/**
 * POST /api/method2/start-capture
 * 启动录包
 */
router.post('/start-capture', (req, res) => {
    try {
        const result = getService(req).startCapture(req.body || {});
        const status = result.success ? 200 : (result.reason === 'mitmdump_missing' ? 503 : 400);
        res.status(status).json(result);
    } catch (err) {
        console.error("[method2-route]", err);
        res.status(500).json({
            success: false,
            reason: 'unknown_error',
            message: "Internal error; check server logs for details",
        });
    }
});

/**
 * POST /api/method2/stop-and-analyze
 * 停止录包，生成 HAR，解析 HAR，返回接口摘要
 */
router.post('/stop-and-analyze', async (req, res) => {
    try {
        const result = await getService(req).stopAndAnalyze(req.body || {});
        const status = result.success ? 200 : 400;
        res.status(status).json(result);
    } catch (err) {
        console.error("[method2-route]", err);
        res.status(500).json({
            success: false,
            reason: 'unknown_error',
            message: "Internal error; check server logs for details",
        });
    }
});

/**
 * POST /api/method2/analyze-har
 * 分析已有 HAR 文件
 */
router.post('/analyze-har', async (req, res) => {
    try {
        const result = await getService(req).analyzeHar(req.body || {});
        const status = result.success ? 200 : 400;
        res.status(status).json(result);
    } catch (err) {
        console.error("[method2-route]", err);
        res.status(500).json({
            success: false,
            reason: 'unknown_error',
            message: "Internal error; check server logs for details",
        });
    }
});

module.exports = router;
