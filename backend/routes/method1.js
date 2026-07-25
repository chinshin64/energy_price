'use strict';

const express = require('express');

function createMethod1Router(options = {}) {
    const service = options.service;
    if (!service) {
        throw new TypeError('method1 service is required');
    }

    const router = express.Router();

    function platformFromQuery(query = {}) {
        return query.platform || query.platformId || 'didi-charging';
    }

    function platformFromBody(body = {}) {
        return body.platform || body.platformId || 'didi-charging';
    }

    function actionPayload(body = {}) {
        return {
            ...body,
            platform: platformFromBody(body)
        };
    }

    function sendCapabilityFailure(res, error, reason, extra = {}) {
        return res.json({
            success: false,
            available: false,
            reason: error.reason || reason,
            error: error.message,
            ...extra
        });
    }

    router.get('/status', async (req, res) => {
        try {
            const result = await service.getStatus({
                platform: platformFromQuery(req.query)
            });
            res.json(result);
        } catch (error) {
            sendCapabilityFailure(res, error, 'unknown_error', { checks: {} });
        }
    });

    router.get('/workflow', async (req, res) => {
        try {
            const result = await service.getWorkflowReadiness({
                platform: platformFromQuery(req.query)
            });
            res.json(result);
        } catch (error) {
            res.json({
                success: false,
                available: false,
                stage: 'diagnose',
                reason: error.reason || 'unknown_error',
                nextAction: 'Check server logs and recheck Method1 workflow readiness.',
                diagnostics: [{
                    code: error.reason || 'unknown_error',
                    component: 'method1',
                    status: 'unavailable',
                    message: error.message
                }],
                checks: {}
            });
        }
    });

    router.post('/run-basic-check', async (req, res) => {
        try {
            const result = await service.runBasicCheck({
                platform: platformFromBody(req.body),
                city: req.body?.city || '',
                targetCity: req.body?.targetCity || '',
                maxScrolls: req.body?.maxScrolls
            });
            res.json(result);
        } catch (error) {
            sendCapabilityFailure(res, error, 'unknown_error', {
                checks: {},
                before: null,
                after: null,
                scroll: {
                    status: 'unavailable',
                    reason: error.reason || 'unknown_error'
                }
            });
        }
    });

    router.post('/open-miniapp', async (req, res) => {
        try {
            const result = await service.openMiniApp({
                platform: platformFromBody(req.body),
                waitMs: req.body?.waitMs
            });
            res.json(result);
        } catch (error) {
            sendCapabilityFailure(res, error, 'miniapp_open_failed');
        }
    });

    const actionHandlers = {
        screenshot: { method: 'screenshotAction', fallback: 'screenshot_failed' },
        observe: { method: 'observeAction', fallback: 'page_not_recognized' },
        scroll: { method: 'scrollAction', fallback: 'scroll_failed' },
        back: { method: 'backAction', fallback: 'back_failed' },
        key: { method: 'keyAction', fallback: 'unknown_error' },
        tap: { method: 'tapAction', fallback: 'tap_failed' },
        'tap-by-text': { method: 'tapByTextAction', fallback: 'tap_failed' },
        'run-adaptive': { method: 'runAdaptive', fallback: 'unknown_error' }
    };

    for (const [path, handler] of Object.entries(actionHandlers)) {
        router.post(`/actions/${path}`, async (req, res) => {
            try {
                const result = await service[handler.method](actionPayload(req.body));
                res.json(result);
            } catch (error) {
                sendCapabilityFailure(
                    res,
                    error,
                    handler.fallback,
                    path === 'run-adaptive' ? { summary: {}, actionTrace: [] } : {}
                );
            }
        });
    }

    router.post('/actions/switch-city', async (req, res) => {
        try {
            const result = await service.switchCityAction({
                ...actionPayload(req.body),
                city: req.body?.city || req.body?.targetCity || ''
            });
            res.json(result);
        } catch (error) {
            sendCapabilityFailure(res, error, 'city_switch_verify_failed');
        }
    });

    return router;
}

module.exports = { createMethod1Router };
