'use strict';

const express = require('express');
const { sendReasonError, sendRouteError } = require('./http-response');

function createGlobalAgentRouter(options = {}) {
    const service = options.service;
    const modelPresets = options.modelPresets || [];
    const appSettingModel = options.appSettingModel;
    const aiAgentDefaults = options.aiAgentDefaults || {};
    const refreshRuntimeConfig = options.refreshRuntimeConfig;
    const getSettingsResponse = options.getSettingsResponse;
    if (!service || !appSettingModel || !refreshRuntimeConfig || !getSettingsResponse) {
        throw new TypeError('global Agent router dependencies are required');
    }
    const router = express.Router();

    router.get('/status', (req, res) => {
        try {
            res.json(service.getStatus());
        } catch (error) {
            sendReasonError(req, res, error, 'global_agent_status_failed');
        }
    });

    for (const [path, method, reason] of [
        ['/chat', 'chat', 'global_agent_chat_failed'],
        ['/actions/plan', 'plan', 'global_agent_plan_failed'],
        ['/actions/execute', 'execute', 'global_agent_execute_failed'],
    ]) {
        router.post(path, async (req, res) => {
            try {
                const result = await service[method](req.body || {});
                res.status(result.success ? 200 : 400).json(result);
            } catch (error) {
                sendReasonError(req, res, error, reason);
            }
        });
    }

    router.put('/model', (req, res) => {
        try {
            const modelId = String(req.body?.modelId || '').trim();
            if (!modelPresets.some(model => model.id === modelId)) {
                return res.status(400).json({
                    success: false,
                    error: 'modelId must be one of the configured model presets',
                    code: 'invalid_agent_model',
                    requestId: req.requestId,
                });
            }
            appSettingModel.saveAiAgentSettings({ modelId, keepApiKey: true }, aiAgentDefaults);
            refreshRuntimeConfig();
            return res.json({ success: true, data: getSettingsResponse() });
        } catch (error) {
            return sendRouteError(req, res, error, { statusCode: 400, code: 'ai_agent_settings_invalid' });
        }
    });

    return router;
}

module.exports = { createGlobalAgentRouter };
