'use strict';

const express = require('express');
const { sendRouteError } = require('./http-response');

function createMobileControlRouter(options = {}) {
    const service = options.commandService;
    const getSettings = options.getSettings;
    const authMode = options.authMode || 'disabled';
    if (!service || !getSettings) throw new TypeError('mobile control router dependencies are required');
    const router = express.Router();

    router.get('/commands', (req, res) => {
        try {
            res.json({ success: true, data: service.listCommands(req.query.limit || 100) });
        } catch (error) {
            sendRouteError(req, res, error);
        }
    });

    router.get('/devices', (req, res) => {
        try {
            res.json({ success: true, data: service.listDevices(req.query.limit || 50) });
        } catch (error) {
            sendRouteError(req, res, error);
        }
    });

    router.post('/browser-session', (req, res) => {
        try {
            if (!getSettings().enabled) {
                return res.status(404).json({
                    success: false,
                    error: 'mobile sync disabled',
                    code: 'mobile_sync_disabled',
                    requestId: req.requestId,
                });
            }
            return res.json({ success: true, data: { authMode: req.auth?.mode || authMode } });
        } catch (error) {
            return sendRouteError(req, res, error);
        }
    });

    router.get('/status', (req, res) => {
        try {
            res.json({ success: true, data: service.getControlStatus() });
        } catch (error) {
            sendRouteError(req, res, error);
        }
    });

    router.post('/commands', (req, res) => {
        try {
            res.json({ success: true, data: service.enqueueCommand(req.body || {}) });
        } catch (error) {
            sendRouteError(req, res, error, { statusCode: 400, code: 'mobile_command_invalid' });
        }
    });

    router.get('/workflows', (req, res) => {
        try {
            service.advanceWorkflows();
            res.json({ success: true, data: service.listWorkflows() });
        } catch (error) {
            sendRouteError(req, res, error);
        }
    });

    router.post('/workflows/city-increment/start', (req, res) => {
        try {
            res.json({ success: true, data: service.startCityIncrementWorkflow(req.body || {}) });
        } catch (error) {
            sendRouteError(req, res, error, { statusCode: 400, code: 'mobile_workflow_invalid' });
        }
    });

    router.get('/interaction/config', (req, res) => {
        try {
            res.json({ success: true, data: service.getInteractionConfig() });
        } catch (error) {
            sendRouteError(req, res, error);
        }
    });

    router.post('/intent', async (req, res) => {
        try {
            res.json({ success: true, data: await service.submitIntent(req.body || {}) });
        } catch (error) {
            sendRouteError(req, res, error, { statusCode: 400, code: 'mobile_intent_invalid' });
        }
    });

    router.get('/chat/sessions', (req, res) => {
        try {
            res.json({ success: true, data: service.listChatSessions(req.query.limit || 20) });
        } catch (error) {
            sendRouteError(req, res, error);
        }
    });

    router.get('/chat/sessions/:id', (req, res) => {
        try {
            const session = service.getChatSession(req.params.id);
            if (!session) {
                return res.status(404).json({
                    success: false,
                    error: 'chat session not found',
                    code: 'mobile_chat_session_not_found',
                    requestId: req.requestId,
                });
            }
            return res.json({ success: true, data: session });
        } catch (error) {
            return sendRouteError(req, res, error);
        }
    });

    router.post('/chat', async (req, res) => {
        try {
            res.json({ success: true, data: await service.submitChatMessage(req.body || {}) });
        } catch (error) {
            sendRouteError(req, res, error, { statusCode: 400, code: 'mobile_chat_invalid' });
        }
    });

    return router;
}

module.exports = { createMobileControlRouter };
