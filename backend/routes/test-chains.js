'use strict';

const express = require('express');
const { sendReasonError } = require('./http-response');

function createTestChainsRouter(options = {}) {
    const orchestrator = options.orchestrator;
    if (!orchestrator) throw new TypeError('orchestrator is required');
    const router = express.Router();

    router.get('/status', async (req, res) => {
        try {
            res.json(await orchestrator.getStatus(req.query || {}));
        } catch (error) {
            sendReasonError(req, res, error, 'test_chain_status_failed');
        }
    });

    router.post('/run', async (req, res) => {
        try {
            const result = await orchestrator.run(req.body || {});
            res.status(result.success ? 200 : 400).json(result);
        } catch (error) {
            sendReasonError(req, res, error, 'test_chain_run_failed');
        }
    });

    router.get('/runs/:id', (req, res) => {
        try {
            const run = orchestrator.getRun(req.params.id);
            if (!run) {
                return res.status(404).json({
                    success: false,
                    reason: 'run_not_found',
                    code: 'run_not_found',
                    requestId: req.requestId,
                });
            }
            return res.json({ success: true, data: run });
        } catch (error) {
            return sendReasonError(req, res, error, 'test_chain_run_read_failed');
        }
    });

    router.post('/runs/:id/stop', (req, res) => {
        try {
            const result = orchestrator.stopRun(req.params.id);
            res.status(result.success ? 200 : 404).json(result);
        } catch (error) {
            sendReasonError(req, res, error, 'test_chain_stop_failed');
        }
    });

    router.post('/diagnose', async (req, res) => {
        try {
            res.json(await orchestrator.diagnose(req.body || {}));
        } catch (error) {
            sendReasonError(req, res, error, 'test_chain_diagnose_failed');
        }
    });

    return router;
}

module.exports = { createTestChainsRouter };
