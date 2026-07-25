'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

function normalizeStations(value) {
    return Array.isArray(value) ? value : [];
}

function createPageCaptureRouter(options = {}) {
    const dataRoot = path.resolve(options.dataRoot || 'data');
    const teldRuntimeParser = options.teldRuntimeParser;
    const stationModel = options.stationModel;
    const wechatLiveOcrService = options.wechatLiveOcrService || options.wechatLiveOCRService;
    const getMiniProgram = options.getMiniProgram;
    const serializeRedacted = options.serializeRedacted;
    const logger = options.logger || console;
    const randomUUID = typeof options.randomUUID === 'function'
        ? options.randomUUID
        : () => crypto.randomUUID();

    if (!teldRuntimeParser || typeof teldRuntimeParser.extractStations !== 'function'
        || !stationModel || typeof stationModel.insertBatch !== 'function'
        || !wechatLiveOcrService || typeof wechatLiveOcrService.captureCurrentWindow !== 'function'
        || typeof getMiniProgram !== 'function'
        || typeof serializeRedacted !== 'function') {
        throw new TypeError('page capture router dependencies are required');
    }

    const router = express.Router();

    function resolvePageCaptureTitleKeywords(platformId) {
        const miniProgram = getMiniProgram(platformId);
        if (!miniProgram) {
            return [];
        }
        return [miniProgram.name, miniProgram.searchKeyword].filter(Boolean);
    }

    router.post('/teld/runtime-capture', (req, res) => {
        const body = req.body || {};
        const { payload, meta } = body;

        if (payload === undefined) {
            return res.status(400).json({ success: false, error: 'payload required' });
        }

        try {
            const captureDir = path.join(dataRoot, 'teld-runtime');
            if (!fs.existsSync(captureDir)) {
                fs.mkdirSync(captureDir, { recursive: true, mode: 0o700 });
            }

            const captureId = randomUUID();
            const captureFile = path.join(captureDir, `capture-${captureId}.json`);
            const safeCapture = serializeRedacted({ meta, payload }, {
                maxBytes: process.env.RUNTIME_CAPTURE_MAX_BYTES || 2 * 1024 * 1024
            });
            fs.writeFileSync(captureFile, `${safeCapture}\n`, { encoding: 'utf8', mode: 0o600 });

            const stations = normalizeStations(teldRuntimeParser.extractStations(payload, meta));
            const insertResult = stations.length > 0
                ? stationModel.insertBatch(stations)
                : { successCount: 0, skipCount: 0 };

            return res.json({
                success: true,
                message: `特来电运行时数据已接收，识别 ${stations.length} 个场站`,
                captureId,
                stationCount: stations.length,
                insertedCount: insertResult.successCount || 0,
                skippedCount: insertResult.skipCount || 0
            });
        } catch (error) {
            logger.error?.('特来电运行时数据处理失败:', error);
            return res.status(500).json({ success: false, error: error.message });
        }
    });

    function handlePageCapture(req, res, forcedPlatform = null) {
        try {
            const body = req.body || {};
            const platform = String(forcedPlatform || body.platform || '').trim();
            if (!platform) {
                return res.status(400).json({ success: false, error: 'platform required' });
            }

            const titleKeywords = Array.isArray(body.titleKeywords) && body.titleKeywords.length > 0
                ? body.titleKeywords
                : resolvePageCaptureTitleKeywords(platform);
            const result = wechatLiveOcrService.captureCurrentWindow({
                platform,
                titleKeywords,
                stage: body.stage || 'manual',
                sourceType: body.sourceType || 'page-ocr',
                sourceStage: body.sourceStage || body.stage || 'page-capture',
                runId: body.runId || '',
                city: body.city || '',
                landmark: body.landmark || '',
                operator: body.operator || ''
            }) || {};
            const stations = normalizeStations(result.stations);
            const insertResult = stations.length > 0
                ? stationModel.insertBatch(stations)
                : { successCount: 0, skipCount: 0 };

            return res.json({
                success: true,
                message: `${platform} 页面 OCR 识别 ${stations.length} 个场站`,
                platform,
                stationCount: stations.length,
                insertedCount: insertResult.successCount || 0,
                reviewInsertedCount: insertResult.yellowCount || 0,
                redCount: insertResult.redCount || 0,
                skippedCount: insertResult.skipCount || 0,
                screenshotPath: result.screenshotPath,
                capturePath: result.capturePath,
                ocrPath: result.ocrPath,
                data: stations
            });
        } catch (error) {
            logger.error?.('页面 OCR 捕获失败:', error);
            return res.status(500).json({ success: false, error: error.message });
        }
    }

    router.post('/page-capture', (req, res) => handlePageCapture(req, res));
    router.post('/teld/ocr-capture', (req, res) => handlePageCapture(req, res, 'teld'));

    return router;
}

module.exports = { createPageCaptureRouter };
