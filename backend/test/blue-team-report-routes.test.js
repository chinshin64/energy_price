'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');
const { createBlueTeamReportsRouter } = require('../routes/blue-team-reports');

async function withServer(service, callback) {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.requestId = 'request-report-0001';
        req.auth = { subject: 'reviewer-1' };
        next();
    });
    app.use('/api/blue-team/reports', createBlueTeamReportsRouter({ service }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
    });
    try {
        await callback(`http://127.0.0.1:${server.address().port}`);
    } finally {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
}

test('报告 Router 保留筛选、默认脱敏和鉴权主体下载契约', async () => {
    const calls = {};
    const service = {
        listReports(filters) {
            calls.filters = filters;
            return { data: [{ reportId: 'r-1' }], total: 1, limit: 10, offset: 0 };
        },
        readReport: reportId => ({ reportId, secret: 'hidden' }),
        sanitizeReport: report => ({ reportId: report.reportId, sanitized: true }),
        getDownload(reportId, format, options) {
            calls.download = { reportId, format, options };
            return { contentType: 'application/json', filename: 'report.json', content: '{}' };
        },
        getRelativeFiles: () => ({ evidence: { text: ['evidence.txt'] } }),
    };

    await withServer(service, async baseUrl => {
        const list = await fetch(`${baseUrl}/api/blue-team/reports?status=failed&risk=high&limit=10`);
        assert.equal(list.status, 200);
        assert.deepEqual(calls.filters.overallStatus, 'failed');
        assert.deepEqual(calls.filters.riskLevel, 'high');

        const sanitized = await (await fetch(`${baseUrl}/api/blue-team/reports/r-1`)).json();
        assert.deepEqual(sanitized.data, { reportId: 'r-1', sanitized: true });
        const raw = await (await fetch(`${baseUrl}/api/blue-team/reports/r-1?sanitize=false`)).json();
        assert.equal(raw.data.secret, 'hidden');

        const download = await fetch(`${baseUrl}/api/blue-team/reports/r-1/download?sanitize=false&format=md`);
        assert.equal(download.status, 200);
        assert.deepEqual(calls.download, {
            reportId: 'r-1',
            format: 'md',
            options: { sanitize: false, actor: 'reviewer-1' },
        });

        const evidenceList = await (await fetch(`${baseUrl}/api/blue-team/reports/r-1/evidence-list`)).json();
        assert.deepEqual(evidenceList.data.files, { text: ['evidence.txt'] });
    });
});

test('报告 Router 统一返回状态码、错误码和 requestId', async () => {
    const notFound = new Error('report not found');
    notFound.statusCode = 404;
    notFound.code = 'report_not_found';
    const service = {
        readReport: () => { throw notFound; },
    };
    await withServer(service, async baseUrl => {
        const response = await fetch(`${baseUrl}/api/blue-team/reports/missing`);
        assert.equal(response.status, 404);
        assert.deepEqual(await response.json(), {
            success: false,
            error: 'report not found',
            code: 'report_not_found',
            requestId: 'request-report-0001',
        });
    });
});
