'use strict';

const crypto = require('node:crypto');
const express = require('express');
const { createMachineAuth } = require('./services/mobile-source-auth');

function createMobileSourceNodeApp(options = {}) {
    if (!options.service) throw new TypeError('mobile source node service is required');
    const service = options.service;
    const app = express();
    app.disable('x-powered-by');
    if (options.trustProxy) app.set('trust proxy', options.trustProxy);

    app.use((req, res, next) => {
        const supplied = String(req.headers['x-request-id'] || '').trim();
        req.requestId = /^[A-Za-z0-9._:-]{8,128}$/.test(supplied) ? supplied : crypto.randomUUID();
        res.setHeader('X-Request-Id', req.requestId);
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        next();
    });

    const requireMobile = createMachineAuth({
        token: options.mobileToken,
        header: 'x-mobile-token',
        realm: 'mobile-ocr-ingest',
        required: options.requireAuth !== false,
    });
    const requireSourceSync = createMachineAuth({
        token: options.sourceSyncToken,
        header: 'x-source-sync-token',
        realm: 'mobile-source-sync',
        required: options.requireAuth !== false,
    });

    app.get('/health', async (req, res, next) => {
        try {
            const result = await service.health();
            res.status(result.ok ? 200 : 503).json({ success: result.ok, data: result });
        } catch (error) {
            next(error);
        }
    });

    app.post(
        '/api/mobile-sync/stations',
        requireMobile,
        express.json({ limit: options.bodyLimit || '8mb', strict: true }),
        async (req, res, next) => {
            try {
                const result = await service.ingestStationPayload(req.body, {
                    mobileAgent: req.headers['x-mobile-agent'],
                    idempotencyKey: req.headers['idempotency-key'],
                    remoteAddress: req.ip || req.socket?.remoteAddress,
                    userAgent: req.headers['user-agent'],
                });
                res.status(result.duplicate ? 200 : 201).json({
                    success: true,
                    message: result.duplicate ? '采集批次已存在' : '47 MySQL 已提交采集批次',
                    data: result,
                });
            } catch (error) {
                next(error);
            }
        }
    );

    app.get('/api/source-sync/stations', requireSourceSync, async (req, res, next) => {
        try {
            res.json({ success: true, data: await service.listStations(req.query || {}) });
        } catch (error) {
            next(error);
        }
    });

    app.use((req, res) => {
        res.status(404).json({
            success: false,
            code: 'source_route_not_found',
            error: 'source node route not found',
            requestId: req.requestId,
        });
    });

    app.use((error, req, res, _next) => {
        const tooLarge = error?.type === 'entity.too.large';
        const malformedJson = error instanceof SyntaxError && error?.type === 'entity.parse.failed';
        const status = tooLarge ? 413 : (malformedJson ? 400 : Number(error.statusCode || error.status || 500));
        if (status >= 500) console.error('Mobile source node request failed:', error.message);
        res.status(status).json({
            success: false,
            code: tooLarge
                ? 'source_payload_too_large'
                : (malformedJson ? 'source_json_invalid' : (error.code || 'source_internal_error')),
            error: status >= 500 ? 'mobile source node internal error' : error.message,
            requestId: req.requestId,
        });
    });

    return app;
}

module.exports = { createMobileSourceNodeApp };
