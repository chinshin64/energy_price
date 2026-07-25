'use strict';

const express = require('express');
const { sendRouteError } = require('./http-response');

function createMobileSyncRouter(options = {}) {
    const syncService = options.syncService;
    const supervisorService = options.supervisorService;
    const commandService = options.commandService;
    const getSettings = options.getSettings;
    const aiFeaturesEnabled = options.aiFeaturesEnabled === true;
    const buildAiFeatureStatus = options.buildAiFeatureStatus || (() => ({ enabled: aiFeaturesEnabled }));
    if (!syncService || !supervisorService || !commandService || !getSettings) {
        throw new TypeError('mobile sync router dependencies are required');
    }
    const router = express.Router();

    function withTransportContext(req) {
        return {
            ...(req.body || {}),
            _transport: {
                mobileAgent: req.headers['x-mobile-agent'] || '',
                relayNode: req.headers['x-relay-node'] || '',
                remoteAddress: req.ip,
            },
        };
    }

    router.get('/config', (req, res) => {
        try {
            const settings = getSettings();
            res.json({
                success: true,
                data: {
                    ...syncService.getClientConfig(),
                    supervisor: supervisorService.getClientConfig(),
                    command: commandService.getClientConfig(),
                    auth: {
                        authRequired: settings.authRequired,
                        authMode: settings.authRequired ? 'bearer' : 'disabled',
                        tokenHeader: settings.tokenHeader,
                    },
                },
            });
        } catch (error) {
            sendRouteError(req, res, error);
        }
    });

    router.post('/devices/register', (req, res) => {
        try {
            const device = commandService.registerDevice({
                ...(req.body || {}),
                remoteAddress: req.ip,
                relayNode: req.headers['x-relay-node'] || '',
            });
            res.json({ success: true, message: '手机端已注册，已建立控制会话', data: device });
        } catch (error) {
            sendRouteError(req, res, error, { statusCode: 400, code: 'mobile_device_registration_failed' });
        }
    });

    router.post('/ocr', (req, res) => {
        try {
            const result = syncService.ingestOcrPayload(withTransportContext(req));
            commandService.advanceWorkflows();
            res.json({
                success: true,
                message: `手机 OCR 同步完成，识别 ${result.stationCount} 个场站`,
                data: result,
            });
        } catch (error) {
            sendRouteError(req, res, error, { statusCode: 400, code: 'mobile_ocr_ingest_failed' });
        }
    });

    router.post('/stations', (req, res) => {
        try {
            const result = syncService.ingestStationPayload(withTransportContext(req));
            commandService.advanceWorkflows();
            res.json({
                success: true,
                message: `手机场站同步完成，写入 ${result.insertedCount} 条`,
                data: result,
            });
        } catch (error) {
            sendRouteError(req, res, error, { statusCode: 400, code: 'mobile_station_ingest_failed' });
        }
    });

    router.post('/supervisor', (req, res) => {
        if (!aiFeaturesEnabled) {
            return res.json({
                success: true,
                message: '移动端监督已暂时下线，事件未进入自动决策链路',
                data: {
                    accepted: false,
                    action: 'NONE',
                    pageType: 'UNKNOWN',
                    reason: '移动端监督已暂时下线，后续版本恢复。',
                    aiFeatures: buildAiFeatureStatus(),
                },
            });
        }
        try {
            const result = supervisorService.ingestEvent(req.body || {});
            return res.json({
                success: true,
                message: `移动端监督事件已记录: ${result.pageType} -> ${result.action}`,
                data: result,
            });
        } catch (error) {
            return sendRouteError(req, res, error, { statusCode: 400, code: 'mobile_supervisor_ingest_failed' });
        }
    });

    router.get('/supervisor/recent', (req, res) => {
        try {
            res.json({ success: true, data: supervisorService.getRecent(req.query.limit || 100) });
        } catch (error) {
            sendRouteError(req, res, error);
        }
    });

    router.get('/commands/poll', (req, res) => {
        try {
            const command = commandService.pollCommand(
                req.query.deviceId || req.query.device_id || 'unknown',
                {
                    deviceSessionId: req.query.deviceSessionId
                        || req.query.device_session_id
                        || req.headers['x-mobile-device-session']
                        || '',
                    remoteAddress: req.ip,
                    relayNode: req.headers['x-relay-node'] || '',
                }
            );
            res.json({ success: true, data: command });
        } catch (error) {
            sendRouteError(req, res, error);
        }
    });

    router.post('/commands/:id/result', (req, res) => {
        try {
            res.json({ success: true, data: commandService.completeCommand(req.params.id, req.body || {}) });
        } catch (error) {
            sendRouteError(req, res, error, { statusCode: 400, code: 'mobile_command_result_invalid' });
        }
    });

    return router;
}

module.exports = { createMobileSyncRouter };
