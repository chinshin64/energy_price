'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SyncService = require('../services/sync-service');

function createService(t, options = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'data-test-sync-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const service = new SyncService({
        nodesPath: path.join(root, 'config', 'sync-nodes.json'),
        reportsDir: path.join(root, 'reports'),
        statePath: path.join(root, 'sync-state.json'),
        localNodeUrl: 'http://127.0.0.1:3000',
        ...options,
    });
    return { root, service };
}

test('rejects report path traversal before writing files', (t) => {
    const { root, service } = createService(t);

    assert.throws(
        () => service.receiveReport('../../outside', { reportId: '../../outside' }, 'test'),
        error => error.code === 'invalid_sync_report_id'
    );
    assert.equal(fs.existsSync(path.join(root, 'outside', 'report.json')), false);
});

test('writes a valid report atomically inside the configured root', (t) => {
    const { service } = createService(t);
    const reportId = 'BTR-TEST-0001';
    const result = service.receiveReport(reportId, { reportId, title: 'test report' }, 'unit-test');
    const saved = JSON.parse(fs.readFileSync(path.join(service.getReportDir(reportId), 'report.json'), 'utf8'));

    assert.equal(result.reportId, reportId);
    assert.equal(saved.reportId, reportId);
    assert.equal(saved.title, 'test report');
});

test('rejects mismatched report ids and unsafe evidence filenames', (t) => {
    const { service } = createService(t);

    assert.throws(
        () => service.receiveReport('BTR-TEST-0001', { reportId: 'BTR-TEST-0002' }, 'unit-test'),
        error => error.code === 'report_id_mismatch'
    );
    assert.throws(
        () => service.receiveEvidence('BTR-TEST-0001', 'screenshot', '../escape.png', Buffer.from('x')),
        error => error.code === 'invalid_evidence_filename'
    );
});

test('validates node protocols, credentials, directions, and host allowlists', (t) => {
    const { service } = createService(t, { allowedNodeHosts: ['blue-node.example.test'] });

    assert.throws(
        () => service.addNode({ name: 'file-node', url: 'file:///tmp/data' }),
        error => error.code === 'invalid_sync_node_url'
    );
    assert.throws(
        () => service.addNode({ name: 'credential-node', url: 'http://user:pass@blue-node.example.test' }),
        error => error.code === 'invalid_sync_node_url'
    );
    assert.throws(
        () => service.addNode({ name: 'blocked-node', url: 'http://127.0.0.1:3000' }),
        error => error.code === 'sync_node_host_not_allowed'
    );
    assert.throws(
        () => service.addNode({ name: 'bad-direction', url: 'http://blue-node.example.test:50080', direction: 'all' }),
        error => error.code === 'invalid_sync_node_direction'
    );
});

test('does not create a hard-coded remote node and never returns its token', (t) => {
    const { service } = createService(t);
    const defaults = service.loadNodes();
    assert.equal(defaults.every(node => ['127.0.0.1', 'localhost'].includes(new URL(node.url).hostname)), true);

    const created = service.addNode({
        name: 'remote-node',
        url: 'http://blue-node.example.test:50080',
        authToken: 'secret-token',
    });
    assert.equal(created.authConfigured, true);
    assert.equal(Object.prototype.hasOwnProperty.call(created, 'authToken'), false);
    assert.deepEqual(service.authHeaders('secret-token'), { authorization: 'Bearer secret-token' });
});

test('unwraps remote report responses and sends machine credentials', async (t) => {
    const requests = [];
    const httpClient = {
        async get(url, options) {
            requests.push({ url, options });
            return {
                data: {
                    success: true,
                    data: { reportId: 'BTR-TEST-0001', title: 'remote report' },
                },
            };
        },
    };
    const { service } = createService(t, { httpClient });

    const report = await service.fetchRemoteReport(
        'http://blue-node.example.test:50080',
        'BTR-TEST-0001',
        'machine-token'
    );

    assert.equal(report.title, 'remote report');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].options.headers.authorization, 'Bearer machine-token');
});
