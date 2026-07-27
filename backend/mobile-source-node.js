'use strict';

const crypto = require('node:crypto');
const express = require('express');
const http = require('node:http');
const { createMachineAuth } = require('./services/mobile-source-auth');
const {
    normalizeIpAddress,
    resolveAgentReportIp,
} = require('./services/mobile-source-agent-report-ip');

const UPDATE_RESPONSE_HEADERS = new Set([
    'cache-control',
    'content-disposition',
    'content-length',
    'content-type',
    'etag',
    'last-modified',
]);
const SAFE_APK_FILE = /^[A-Za-z0-9._-]+\.apk$/;

function createMobileSourceNodeApp(options = {}) {
    if (!options.service) throw new TypeError('mobile source node service is required');
    const service = options.service;
    const updateProxy = resolveUpdateProxy(options);
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

    if (updateProxy) {
        const proxyLatest = (req, res) => proxyUpdateRequest(req, res, updateProxy, 'application/json');
        const proxyApk = (req, res, next) => {
            if (!safeApkFile(req.params.file)) return next();
            return proxyUpdateRequest(
                req,
                res,
                updateProxy,
                'application/vnd.android.package-archive'
            );
        };
        const methodNotAllowed = (req, res) => {
            res.setHeader('Allow', 'GET');
            res.status(405).json({
                success: false,
                code: 'source_update_method_not_allowed',
                error: 'method not allowed',
                requestId: req.requestId,
            });
        };
        const apkMethodNotAllowed = (req, res, next) => {
            if (!safeApkFile(req.params.file)) return next();
            return methodNotAllowed(req, res);
        };

        app.get('/api/mobile-update/latest', proxyLatest);
        app.all('/api/mobile-update/latest', methodNotAllowed);
        app.get('/api/mobile-update/apk/:file', proxyApk);
        app.all('/api/mobile-update/apk/:file', apkMethodNotAllowed);
    }

    app.post(
        '/api/mobile-sync/stations',
        requireMobile,
        express.json({ limit: options.bodyLimit || '8mb', strict: true }),
        async (req, res, next) => {
            try {
                const result = await service.ingestStationPayload(req.body, {
                    mobileAgent: req.headers['x-mobile-agent'],
                    idempotencyKey: req.headers['idempotency-key'],
                    agentReportIp: resolveAgentReportIp(req),
                    remoteAddress: normalizeIpAddress(req.socket?.remoteAddress),
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
        if (status >= 500 && status < 600) {
            res.setHeader('Retry-After', '30');
        }
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

function resolveUpdateProxy(options = {}) {
    const configuredUrl = String(options.updateProxyUrl || '').trim();
    const configuredHost = String(options.updateProxyHost || '').trim();
    const configuredPort = options.updateProxyPort;
    if (!configuredUrl && !configuredHost && (configuredPort === undefined || configuredPort === null)) {
        return null;
    }

    let target;
    if (configuredUrl) {
        target = new URL(configuredUrl);
    } else {
        const host = configuredHost || '127.0.0.1';
        const port = Number(configuredPort || 50082);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            throw new TypeError('mobile update proxy port is invalid');
        }
        target = new URL(`http://${host}:${port}`);
    }
    if (target.protocol !== 'http:'
            || target.hostname !== '127.0.0.1'
            || target.username
            || target.password
            || target.pathname !== '/'
            || target.search
            || target.hash) {
        throw new TypeError('mobile update proxy must use an HTTP loopback root URL');
    }
    const timeout = Number(options.updateProxyTimeoutMs || 15000);
    if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 60000) {
        throw new TypeError('mobile update proxy timeout is invalid');
    }
    return Object.freeze({
        hostname: target.hostname,
        port: Number(target.port || 80),
        timeout,
    });
}

function safeApkFile(value) {
    const file = String(value || '');
    return SAFE_APK_FILE.test(file) && !file.includes('..');
}

function proxyUpdateRequest(req, res, proxy, accept) {
    const requestUrl = new URL(req.originalUrl || req.url, 'http://mobile-source.invalid');
    const upstream = http.request({
        protocol: 'http:',
        hostname: proxy.hostname,
        port: proxy.port,
        method: 'GET',
        path: `${requestUrl.pathname}${requestUrl.search}`,
        headers: {
            Accept: accept,
            'User-Agent': 'mobile-source-update-proxy/1.0',
        },
    });
    let upstreamResponse = null;

    const fail = () => {
        if (res.headersSent) {
            res.destroy();
            return;
        }
        res.status(502).json({
            success: false,
            code: 'update_upstream_unavailable',
            error: 'mobile update upstream unavailable',
            requestId: req.requestId,
        });
    };

    upstream.setTimeout(proxy.timeout, () => {
        upstream.destroy(new Error('mobile update upstream timeout'));
    });
    upstream.once('response', response => {
        upstreamResponse = response;
        res.statusCode = Number(response.statusCode || 502);
        for (const [name, value] of Object.entries(response.headers)) {
            if (UPDATE_RESPONSE_HEADERS.has(name) && value !== undefined) {
                res.setHeader(name, value);
            }
        }
        response.once('error', fail);
        response.pipe(res);
    });
    upstream.once('error', fail);
    req.once('aborted', () => upstream.destroy());
    res.once('close', () => {
        if (!res.writableEnded) {
            upstreamResponse?.destroy();
            upstream.destroy();
        }
    });
    upstream.end();
}

module.exports = {
    createMobileSourceNodeApp,
    resolveUpdateProxy,
    safeApkFile,
};
