#!/usr/bin/env node
'use strict';

const http = require('http');

const base = process.env.API_BASE || 'http://127.0.0.1:3000';

function request(method, path, body) {
    return new Promise((resolve) => {
        const url = new URL(path, base);
        const data = body ? Buffer.from(JSON.stringify(body)) : null;
        const req = http.request(url, {
            method,
            headers: data ? {
                'content-type': 'application/json',
                'content-length': data.length,
            } : {},
        }, (res) => {
            let raw = '';
            res.on('data', chunk => raw += chunk.toString());
            res.on('end', () => {
                try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
                catch { resolve({ status: res.statusCode, body: raw }); }
            });
        });
        req.on('error', err => resolve({ status: 0, body: { success: false, reason: 'request_failed', message: err.message } }));
        if (data) req.write(data);
        req.end();
    });
}

(async () => {
    console.log('[ai-agent] status');
    console.log(JSON.stringify(await request('GET', '/api/ai-agent/status'), null, 2));

    console.log('[ai-agent] analyze sample failure');
    const sample = {
        source: 'method3',
        templateId: 'sample-template',
        request: {
            method: 'POST',
            host: 'energy.xiaojukeji.com',
            path: '/station-api/homepage/stationList',
            apiType: 'list',
            city: '上海',
        },
        response: {
            httpStatus: 501,
            bodySummary: { message: 'not implemented' },
        },
        error: {
            reason: 'request_failed',
            message: 'HTTP 501',
        },
        context: {
            preflightStatus: 'matched',
            requestLimit: { maxPages: 1, maxRequestCount: 5, maxQps: 1 },
        },
    };
    console.log(JSON.stringify(await request('POST', '/api/ai-agent/analyze-failure', sample), null, 2));
})();
