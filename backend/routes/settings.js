'use strict';

const express = require('express');
const { sendRouteError } = require('./http-response');
const { normalizeNetworkSettingsPayload } = require('../services/network-settings-validator');

function createSettingsRouter(options = {}) {
    const model = options.appSettingModel;
    const getAiAgentSettingsResponse = options.getAiAgentSettingsResponse;
    const refreshAiAgentRuntimeConfig = options.refreshAiAgentRuntimeConfig;
    const modelPresets = options.modelPresets || [];
    const aiAgentDefaults = options.aiAgentDefaults || {};
    if (!model || !getAiAgentSettingsResponse || !refreshAiAgentRuntimeConfig) {
        throw new TypeError('settings router dependencies are required');
    }
    const router = express.Router();

    router.get('/network', (req, res) => {
        try {
            const settings = model.getProxySettings();
            res.json({ success: true, data: model.publicProxySettings(settings) });
        } catch (error) {
            sendRouteError(req, res, error);
        }
    });

    router.put('/network', (req, res) => {
        try {
            const settings = normalizeNetworkSettingsPayload(req.body || {});
            const data = model.saveProxySettings(settings);
            res.json({ success: true, data: model.publicProxySettings(data) });
        } catch (error) {
            sendRouteError(req, res, error, { statusCode: 400, code: 'network_settings_invalid' });
        }
    });

    router.get('/ai-agent', (req, res) => {
        try {
            res.json({ success: true, data: getAiAgentSettingsResponse() });
        } catch (error) {
            sendRouteError(req, res, error);
        }
    });

    router.get('/ai-agent/models', (req, res) => {
        res.json({ success: true, data: modelPresets });
    });

    router.put('/ai-agent', (req, res) => {
        try {
            model.saveAiAgentSettings(req.body || {}, aiAgentDefaults);
            refreshAiAgentRuntimeConfig();
            res.json({ success: true, data: getAiAgentSettingsResponse() });
        } catch (error) {
            sendRouteError(req, res, error, { statusCode: 400, code: 'ai_agent_settings_invalid' });
        }
    });

    return router;
}

module.exports = { createSettingsRouter };
