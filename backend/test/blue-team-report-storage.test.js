'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blue-team-report-test-'));
process.env.DATABASE_PATH = path.join(tempDir, 'reports.db');
process.env.REPORT_SCREENSHOT_MAX_BYTES = '1024';
process.env.REPORT_TEXT_EVIDENCE_MAX_BYTES = '2048';

const db = require('../database/init');
const BlueTeamReportService = require('../services/blue-team-report-service');
const reportRoot = path.join(tempDir, 'reports');
const service = new BlueTeamReportService({ rootDir: reportRoot });

test.after(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
});

test('报告、事件和文本证据写盘前完成凭据脱敏', () => {
    const report = service.startReport({
        method: 'traffic-template',
        platform: 'commercial-test',
        title: '商业报告',
        signatures: { token: 'report-secret' }
    });
    service.appendEvent(report.reportId, {
        type: 'request',
        headers: [{ name: 'Authorization', value: 'Bearer event-secret' }]
    });
    service.appendEvidence(report.reportId, {
        type: 'api-request',
        data: { accessToken: 'evidence-secret', status: 200 }
    });

    const reportText = fs.readFileSync(path.join(reportRoot, report.reportId, 'report.json'), 'utf8');
    const evidenceText = fs.readFileSync(
        path.join(reportRoot, report.reportId, 'evidence', 'api-requests.jsonl'),
        'utf8'
    );
    for (const secret of ['report-secret', 'event-secret', 'evidence-secret']) {
        assert.equal(`${reportText}${evidenceText}`.includes(secret), false, `证据文件泄露 ${secret}`);
    }
    assert.equal(reportText.includes('**redacted**'), true);
    assert.equal(evidenceText.includes('**redacted**'), true);
});

test('截图仅接受扩展名匹配的受限 PNG/JPEG 数据', () => {
    const report = service.startReport({ method: 'page-automation', platform: 'commercial-test' });
    assert.throws(
        () => service.appendEvidence(report.reportId, {
            type: 'screenshot',
            filename: '../escape.png',
            data: Buffer.from('not-an-image')
        }),
        error => error.code === 'invalid_screenshot_filename'
    );
    assert.throws(
        () => service.appendEvidence(report.reportId, {
            type: 'screenshot',
            filename: 'fake.png',
            data: Buffer.from('not-an-image')
        }),
        error => error.code === 'screenshot_type_mismatch'
    );

    const png = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.from('test-payload')
    ]);
    const saved = service.appendEvidence(report.reportId, {
        type: 'screenshot',
        filename: 'valid.png',
        data: png
    });
    assert.equal(saved.path, 'evidence/screenshots/valid.png');
    assert.equal(fs.readFileSync(path.join(reportRoot, report.reportId, saved.path)).equals(png), true);
});
