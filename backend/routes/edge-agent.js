'use strict';

const express = require('express');
const { sendRouteError } = require('./http-response');

function bearerToken(req) {
    const authorization = String(req.headers.authorization || '').trim();
    return authorization.toLowerCase().startsWith('bearer ')
        ? authorization.slice(7).trim()
        : '';
}

function nodeCredentials(req) {
    return {
        nodeId: String(req.headers['x-edge-node-id'] || req.query.nodeId || req.body?.nodeId || '').trim(),
        sessionToken: bearerToken(req) || String(req.headers['x-edge-session-token'] || '').trim()
    };
}

function observedIp(req) {
    return String(req.ip || req.socket?.remoteAddress || '').trim();
}

function createEdgeAgentRouter(options = {}) {
    const service = options.service;
    if (!service) throw new TypeError('edge agent service is required');
    const router = express.Router();

    router.post('/v1/nodes/register', async (req, res) => {
        try {
            const result = await service.registerNode(req.body || {}, {
                enrollmentToken: String(req.headers['x-edge-enrollment-token'] || bearerToken(req)).trim(),
                observedIp: observedIp(req)
            });
            return res.status(201).json({ success: true, data: result });
        } catch (error) {
            return sendRouteError(req, res, error, { statusCode: error.statusCode || 400, code: error.code || 'edge_node_registration_failed' });
        }
    });

    router.post('/v1/nodes/heartbeat', async (req, res) => {
        try {
            const credentials = nodeCredentials(req);
            const result = await service.heartbeat(credentials.nodeId, req.body || {}, {
                sessionToken: credentials.sessionToken,
                observedIp: observedIp(req)
            });
            req.edgePrincipal = { nodeId: credentials.nodeId };
            return res.json({ success: true, data: result });
        } catch (error) {
            return sendRouteError(req, res, error, { statusCode: error.statusCode || 400, code: error.code || 'edge_node_heartbeat_failed' });
        }
    });

    router.get('/v1/tasks/poll', (req, res) => {
        try {
            const credentials = nodeCredentials(req);
            const result = service.pollTask(credentials.nodeId, credentials.sessionToken);
            req.edgePrincipal = { nodeId: credentials.nodeId };
            return res.json({ success: true, data: result });
        } catch (error) {
            return sendRouteError(req, res, error, { statusCode: error.statusCode || 400, code: error.code || 'edge_task_poll_failed' });
        }
    });

    router.post('/v1/tasks/:id/result', (req, res) => {
        try {
            const credentials = nodeCredentials(req);
            const result = service.completeTask(credentials.nodeId, credentials.sessionToken, req.params.id, req.body || {});
            req.edgePrincipal = { nodeId: credentials.nodeId };
            return res.json({ success: true, data: result });
        } catch (error) {
            return sendRouteError(req, res, error, { statusCode: error.statusCode || 400, code: error.code || 'edge_task_result_failed' });
        }
    });

    router.post('/v1/tasks', (req, res) => {
        try {
            const credentials = nodeCredentials(req);
            const result = service.createTask(req.body || {}, {
                type: 'node',
                nodeId: credentials.nodeId,
                sessionToken: credentials.sessionToken
            });
            req.edgePrincipal = { nodeId: credentials.nodeId };
            return res.status(201).json({ success: true, data: result });
        } catch (error) {
            return sendRouteError(req, res, error, { statusCode: error.statusCode || 400, code: error.code || 'edge_child_task_create_failed' });
        }
    });

    router.get('/status', (req, res) => {
        try {
            return res.json({ success: true, data: service.getStatus() });
        } catch (error) {
            return sendRouteError(req, res, error);
        }
    });

    router.get('/nodes', (req, res) => {
        try {
            const isAdmin = Array.isArray(req.auth?.roles) && req.auth.roles.includes('admin');
            return res.json({
                success: true,
                data: service.listNodes({ includeIp: isAdmin && req.query.includeIp === 'true' })
            });
        } catch (error) {
            return sendRouteError(req, res, error);
        }
    });

    router.get('/tasks', (req, res) => {
        try {
            return res.json({ success: true, data: service.listTasks({ limit: req.query.limit }) });
        } catch (error) {
            return sendRouteError(req, res, error);
        }
    });

    router.post('/tasks', (req, res) => {
        try {
            return res.status(201).json({
                success: true,
                data: service.createTask(req.body || {}, { type: 'server', subject: req.auth?.subject || 'operator' })
            });
        } catch (error) {
            return sendRouteError(req, res, error, { statusCode: error.statusCode || 400, code: error.code || 'edge_task_create_failed' });
        }
    });

    router.post('/tasks/:id/cancel', (req, res) => {
        try {
            return res.json({
                success: true,
                data: service.cancelTask(req.params.id, req.auth?.subject || 'operator')
            });
        } catch (error) {
            return sendRouteError(req, res, error, { statusCode: error.statusCode || 400, code: error.code || 'edge_task_cancel_failed' });
        }
    });

    return router;
}

module.exports = {
    bearerToken,
    createEdgeAgentRouter,
    nodeCredentials,
    observedIp
};
