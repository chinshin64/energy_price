const fs = require('fs');
const path = require('path');
const axios = require('axios');

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

class SyncService {
    constructor(options = {}) {
        this.nodesPath = options.nodesPath || path.join(__dirname, '../../config/sync-nodes.json');
        this.reportsDir = options.reportsDir || path.join(__dirname, '../../data/blue-team-reports');
        this.statePath = options.statePath || path.join(__dirname, '../../data/sync-state.json');
        this.blueTeamReportService = options.blueTeamReportService || null;

        fs.mkdirSync(path.dirname(this.nodesPath), { recursive: true });
        fs.mkdirSync(this.reportsDir, { recursive: true });
        fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    }

    // ==================== 节点配置管理 ====================

    loadNodes() {
        try {
            if (!fs.existsSync(this.nodesPath)) {
                const defaultNodes = {
                    nodes: [
                        { name: 'local', url: 'http://localhost:3000', direction: 'bidirectional', enabled: true },
                        { name: '172-server', url: 'http://172.23.32.250:50080', direction: 'bidirectional', enabled: true },
                    ],
                };
                this.saveNodes(defaultNodes.nodes);
                return defaultNodes.nodes;
            }
            const raw = JSON.parse(fs.readFileSync(this.nodesPath, 'utf8'));
            return Array.isArray(raw.nodes) ? raw.nodes : [];
        } catch (error) {
            console.error('loadNodes failed:', error.message);
            return [];
        }
    }

    saveNodes(nodes) {
        const dir = path.dirname(this.nodesPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        const tmpPath = `${this.nodesPath}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(tmpPath, JSON.stringify({ nodes }, null, 2) + '\n', 'utf8');
        fs.renameSync(tmpPath, this.nodesPath);
    }

    addNode(node) {
        const nodes = this.loadNodes();
        if (nodes.some(n => n.name === node.name)) {
            const error = new Error(`node already exists: ${node.name}`);
            error.statusCode = 409;
            error.code = 'sync_node_exists';
            throw error;
        }
        const entry = {
            name: node.name,
            url: String(node.url || '').replace(/\/+$/, ''),
            authToken: node.authToken || '',
            direction: node.direction || 'bidirectional',
            enabled: true,
        };
        nodes.push(entry);
        this.saveNodes(nodes);
        return entry;
    }

    removeNode(name) {
        const nodes = this.loadNodes();
        const index = nodes.findIndex(n => n.name === name);
        if (index === -1) {
            const error = new Error(`node not found: ${name}`);
            error.statusCode = 404;
            error.code = 'sync_node_not_found';
            throw error;
        }
        const removed = nodes.splice(index, 1)[0];
        this.saveNodes(nodes);
        return removed;
    }

    // ==================== 同步状态管理 ====================

    loadSyncState() {
        try {
            if (!fs.existsSync(this.statePath)) {
                return {};
            }
            return JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
        } catch (error) {
            console.error('loadSyncState failed:', error.message);
            return {};
        }
    }

    saveSyncState(state) {
        const tmpPath = `${this.statePath}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2) + '\n', 'utf8');
        fs.renameSync(tmpPath, this.statePath);
    }

    updateNodeSyncState(nodeName, info) {
        const state = this.loadSyncState();
        if (!state[nodeName]) {
            state[nodeName] = {};
        }
        Object.assign(state[nodeName], info, { updatedAt: new Date().toISOString() });
        this.saveSyncState(state);
    }

    // ==================== 节点连通性 ====================

    async checkNodeHealth(nodeUrl) {
        try {
            const response = await axios.get(`${nodeUrl}/api/blue-team/reports`, {
                params: { limit: 1 },
                timeout: 5000,
            });
            return response.status === 200 ? 'online' : 'offline';
        } catch (error) {
            return 'offline';
        }
    }

    // ==================== 本地报告扫描 ====================

    scanLocalReports() {
        const reports = [];
        if (!fs.existsSync(this.reportsDir)) {
            return reports;
        }
        const entries = fs.readdirSync(this.reportsDir, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const jsonPath = path.join(this.reportsDir, entry.name, 'report.json');
            if (!fs.existsSync(jsonPath)) continue;
            try {
                const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
                reports.push({
                    reportId: data.reportId || entry.name,
                    updatedAt: data.updatedAt || data.createdAt || '',
                });
            } catch (error) {
                reports.push({ reportId: entry.name, updatedAt: '' });
            }
        }
        return reports;
    }

    // ==================== 远端交互 ====================

    async fetchRemoteReportList(nodeUrl) {
        const response = await this.requestWithRetry(() =>
            axios.get(`${nodeUrl}/api/blue-team/reports`, {
                params: { limit: 1000 },
                timeout: 15000,
            })
        );
        const body = response.data;
        if (body && Array.isArray(body.data)) {
            return body.data.map(r => ({
                reportId: r.reportId,
                updatedAt: r.updatedAt || r.createdAt || '',
            }));
        }
        return [];
    }

    async fetchRemoteReport(nodeUrl, reportId) {
        const response = await this.requestWithRetry(() =>
            axios.get(`${nodeUrl}/api/blue-team/reports/${encodeURIComponent(reportId)}`, {
                params: { sanitize: 'false' },
                timeout: 30000,
            })
        );
        return response.data;
    }

    async fetchRemoteEvidenceList(nodeUrl, reportId) {
        try {
            const response = await this.requestWithRetry(() =>
                axios.get(`${nodeUrl}/api/blue-team/reports/${encodeURIComponent(reportId)}/evidence-list`, {
                    timeout: 15000,
                })
            );
            return response.data && response.data.files ? response.data.files : {};
        } catch (error) {
            return {};
        }
    }

    async fetchRemoteEvidenceFile(nodeUrl, reportId, type, filename) {
        const encodedId = encodeURIComponent(reportId);
        let url;
        if (type === 'screenshot') {
            url = `${nodeUrl}/api/blue-team/reports/${encodedId}/evidence/${type}/${encodeURIComponent(filename)}`;
        } else {
            url = `${nodeUrl}/api/blue-team/reports/${encodedId}/evidence/${type}`;
        }
        const response = await this.requestWithRetry(() =>
            axios.get(url, {
                timeout: 30000,
                responseType: 'arraybuffer',
            })
        );
        return response.data;
    }

    async pushReportToRemote(reportId, nodeUrl, authToken) {
        const reportDir = path.join(this.reportsDir, reportId);
        const jsonPath = path.join(reportDir, 'report.json');
        if (!fs.existsSync(jsonPath)) {
            const error = new Error(`local report not found: ${reportId}`);
            error.code = 'report_not_found';
            throw error;
        }

        const reportData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

        // 1. 推送报告元数据
        await this.requestWithRetry(() =>
            axios.post(`${nodeUrl}/api/sync/receive/report`, {
                reportId,
                reportData,
                source: 'sync-push',
            }, {
                headers: this.authHeaders(authToken),
                timeout: 30000,
            })
        );

        // 2. 扫描本地 evidence 目录并逐个上传
        const evidenceDir = path.join(reportDir, 'evidence');
        if (!fs.existsSync(evidenceDir)) {
            return { reportId, pushedEvidence: 0 };
        }

        const evidenceTypeMap = {
            'screenshots': 'screenshot',
            'ocr-lines.jsonl': 'ocr-lines',
            'har-summary.json': 'har-summary',
            'api-requests.jsonl': 'api-request',
            'outbound-evidence.jsonl': 'outbound-evidence',
            'db-check-result.json': 'db-check',
            'supervisor-events.jsonl': 'supervisor-event',
            'events.jsonl': 'events',
        };

        let pushedEvidence = 0;
        const entries = fs.readdirSync(evidenceDir, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.isDirectory() && entry.name === 'screenshots') {
                const screenshotDir = path.join(evidenceDir, 'screenshots');
                const files = fs.readdirSync(screenshotDir);
                for (const file of files) {
                    const fPath = path.join(screenshotDir, file);
                    const fileBuffer = fs.readFileSync(fPath);
                    await this.pushEvidenceFile(nodeUrl, reportId, 'screenshot', file, fileBuffer, authToken);
                    pushedEvidence++;
                }
            } else if (entry.isFile()) {
                const eType = evidenceTypeMap[entry.name];
                if (!eType) continue;
                const fPath = path.join(evidenceDir, entry.name);
                const fileBuffer = fs.readFileSync(fPath);
                await this.pushEvidenceFile(nodeUrl, reportId, eType, entry.name, fileBuffer, authToken);
                pushedEvidence++;
            }
        }

        return { reportId, pushedEvidence };
    }

    async pushEvidenceFile(nodeUrl, reportId, type, filename, fileBuffer, authToken) {
        const FormData = require('form-data');
        const form = new FormData();
        form.append('reportId', reportId);
        form.append('type', type);
        form.append('filePath', filename);
        form.append('file', fileBuffer, { filename });

        await this.requestWithRetry(() =>
            axios.post(`${nodeUrl}/api/sync/receive/evidence`, form, {
                headers: {
                    ...this.authHeaders(authToken),
                    ...form.getHeaders(),
                },
                timeout: 60000,
                maxContentLength: Infinity,
                maxBodyLength: Infinity,
            })
        );
    }

    async pullReportFromRemote(reportId, nodeUrl) {
        // 1. 获取报告元数据
        const reportData = await this.fetchRemoteReport(nodeUrl, reportId);

        // 2. 保存到本地
        const reportDir = path.join(this.reportsDir, reportId);
        fs.mkdirSync(reportDir, { recursive: true });
        fs.mkdirSync(path.join(reportDir, 'evidence'), { recursive: true });
        fs.mkdirSync(path.join(reportDir, 'evidence', 'screenshots'), { recursive: true });

        const tmpPath = `${reportDir}/report.json.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(tmpPath, JSON.stringify(reportData, null, 2) + '\n', 'utf8');
        fs.renameSync(tmpPath, path.join(reportDir, 'report.json'));

        // 3. 拉取证据文件
        const evidenceList = await this.fetchRemoteEvidenceList(nodeUrl, reportId);
        let pulledEvidence = 0;

        for (const [typeKey, value] of Object.entries(evidenceList)) {
            if (typeKey === 'screenshots' && Array.isArray(value)) {
                for (const filename of value) {
                    try {
                        const fileBuffer = await this.fetchRemoteEvidenceFile(nodeUrl, reportId, 'screenshot', filename);
                        const screenshotPath = path.join(reportDir, 'evidence', 'screenshots', filename);
                        fs.writeFileSync(screenshotPath, Buffer.from(fileBuffer));
                        pulledEvidence++;
                    } catch (error) {
                        console.error(`pull screenshot ${filename} failed:`, error.message);
                    }
                }
            } else if (typeof value === 'string') {
                try {
                    const fileBuffer = await this.fetchRemoteEvidenceFile(nodeUrl, reportId, typeKey);
                    const evidencePath = path.join(reportDir, 'evidence', value);
                    fs.writeFileSync(evidencePath, Buffer.from(fileBuffer));
                    pulledEvidence++;
                } catch (error) {
                    console.error(`pull evidence ${typeKey} failed:`, error.message);
                }
            }
        }

        // 4. 更新SQLite索引
        if (this.blueTeamReportService) {
            try {
                this.blueTeamReportService.upsertReportIndex(reportData);
            } catch (error) {
                console.error('upsertReportIndex after pull failed:', error.message);
            }
        }

        return { reportId, pulledEvidence };
    }

    // ==================== 对比差异 ====================

    computeDiff(localReports, remoteReports) {
        const localMap = new Map(localReports.map(r => [r.reportId, r]));
        const remoteMap = new Map(remoteReports.map(r => [r.reportId, r]));

        const onlyLocal = [];
        const onlyRemote = [];
        const conflicts = [];
        const common = [];

        for (const [id, local] of localMap) {
            const remote = remoteMap.get(id);
            if (!remote) {
                onlyLocal.push(local);
            } else {
                common.push({ reportId: id, local, remote });
                if (local.updatedAt && remote.updatedAt && local.updatedAt !== remote.updatedAt) {
                    conflicts.push({
                        reportId: id,
                        localUpdatedAt: local.updatedAt,
                        remoteUpdatedAt: remote.updatedAt,
                        winner: local.updatedAt > remote.updatedAt ? 'local' : 'remote',
                    });
                }
            }
        }

        for (const [id, remote] of remoteMap) {
            if (!localMap.has(id)) {
                onlyRemote.push(remote);
            }
        }

        return { onlyLocal, onlyRemote, conflicts, common };
    }

    // ==================== 推送 ====================

    async push(nodeName, options = {}) {
        const nodes = this.loadNodes();
        const node = nodes.find(n => n.name === nodeName);
        if (!node) {
            const error = new Error(`node not found: ${nodeName}`);
            error.statusCode = 404;
            error.code = 'sync_node_not_found';
            throw error;
        }

        const localReports = this.scanLocalReports();
        let remoteReports = [];
        try {
            remoteReports = await this.fetchRemoteReportList(node.url);
        } catch (error) {
            const err = new Error(`cannot connect to node ${nodeName}: ${error.message}`);
            err.statusCode = 502;
            err.code = 'sync_node_unreachable';
            throw err;
        }

        const diff = this.computeDiff(localReports, remoteReports);
        const effectiveAuthToken = '';
        const toPush = options.reportIds
            ? diff.onlyLocal.filter(r => options.reportIds.includes(r.reportId))
            : diff.onlyLocal;

        // 也推送冲突中本地更新的
        const conflictPush = diff.conflicts
            .filter(c => c.winner === 'local')
            .map(c => ({ reportId: c.reportId, updatedAt: c.localUpdatedAt }));
        if (!options.reportIds) {
            toPush.push(...conflictPush);
        }

        const pushed = [];
        const skipped = [];
        const errors = [];

        for (const report of toPush) {
            try {
                const result = await this.pushReportToRemote(report.reportId, node.url, node.authToken);
                pushed.push(result);
            } catch (error) {
                errors.push({ reportId: report.reportId, error: error.message });
            }
        }

        // 冲突中远端更新的跳过
        for (const c of diff.conflicts) {
            if (c.winner === 'remote') {
                skipped.push({ reportId: c.reportId, reason: 'remote_newer' });
            }
        }

        // 公共且无冲突的也跳过
        for (const c of diff.common) {
            if (!diff.conflicts.some(cf => cf.reportId === c.reportId)) {
                skipped.push({ reportId: c.reportId, reason: 'already_synced' });
            }
        }

        const result = {
            node: nodeName,
            pushed: pushed.length,
            skipped: skipped.length,
            errors: errors.length,
            details: { pushed, skipped, errors },
        };

        this.updateNodeSyncState(nodeName, {
            lastPushAt: new Date().toISOString(),
            lastPushResult: result,
        });

        return result;
    }

    // ==================== 拉取 ====================

    async pull(nodeName, options = {}) {
        const nodes = this.loadNodes();
        const node = nodes.find(n => n.name === nodeName);
        if (!node) {
            const error = new Error(`node not found: ${nodeName}`);
            error.statusCode = 404;
            error.code = 'sync_node_not_found';
            throw error;
        }

        const localReports = this.scanLocalReports();
        let remoteReports = [];
        try {
            remoteReports = await this.fetchRemoteReportList(node.url);
        } catch (error) {
            const err = new Error(`cannot connect to node ${nodeName}: ${error.message}`);
            err.statusCode = 502;
            err.code = 'sync_node_unreachable';
            throw err;
        }

        const diff = this.computeDiff(localReports, remoteReports);
        const toPull = options.reportIds
            ? diff.onlyRemote.filter(r => options.reportIds.includes(r.reportId))
            : diff.onlyRemote;

        // 冲突中远端更新的也拉取
        const conflictPull = diff.conflicts
            .filter(c => c.winner === 'remote')
            .map(c => ({ reportId: c.reportId, updatedAt: c.remoteUpdatedAt }));
        if (!options.reportIds) {
            toPull.push(...conflictPull);
        }

        const pulled = [];
        const skipped = [];
        const errors = [];

        for (const report of toPull) {
            try {
                const result = await this.pullReportFromRemote(report.reportId, node.url);
                pulled.push(result);
            } catch (error) {
                errors.push({ reportId: report.reportId, error: error.message });
            }
        }

        // 冲突中本地更新的跳过
        for (const c of diff.conflicts) {
            if (c.winner === 'local') {
                skipped.push({ reportId: c.reportId, reason: 'local_newer' });
            }
        }

        // 公共且无冲突的跳过
        for (const c of diff.common) {
            if (!diff.conflicts.some(cf => cf.reportId === c.reportId)) {
                skipped.push({ reportId: c.reportId, reason: 'already_synced' });
            }
        }

        const result = {
            node: nodeName,
            pulled: pulled.length,
            skipped: skipped.length,
            errors: errors.length,
            details: { pulled, skipped, errors },
        };

        this.updateNodeSyncState(nodeName, {
            lastPullAt: new Date().toISOString(),
            lastPullResult: result,
        });

        return result;
    }

    // ==================== 双向同步 ====================

    async sync(nodeName, options = {}) {
        const pullResult = await this.pull(nodeName, options);
        const pushResult = await this.push(nodeName, options);

        return {
            node: nodeName,
            pulled: pullResult.pulled,
            pushed: pushResult.pushed,
            conflicts: pullResult.details.skipped.filter(s => s.reason === 'local_newer').length
                + pushResult.details.skipped.filter(s => s.reason === 'remote_newer').length,
            pullErrors: pullResult.errors,
            pushErrors: pushResult.errors,
        };
    }

    // ==================== 同步状态 ====================

    async getSyncStatus(nodeName) {
        const nodes = this.loadNodes();
        const node = nodes.find(n => n.name === nodeName);
        if (!node) {
            const error = new Error(`node not found: ${nodeName}`);
            error.statusCode = 404;
            error.code = 'sync_node_not_found';
            throw error;
        }

        const localReports = this.scanLocalReports();
        let remoteReports = [];
        let status = 'offline';
        try {
            remoteReports = await this.fetchRemoteReportList(node.url);
            status = 'online';
        } catch (error) {
            // keep offline
        }

        const diff = this.computeDiff(localReports, remoteReports);
        const syncState = this.loadSyncState();
        const nodeState = syncState[nodeName] || {};

        return {
            node: nodeName,
            nodeUrl: node.url,
            status,
            localCount: localReports.length,
            remoteCount: remoteReports.length,
            onlyLocal: diff.onlyLocal.length,
            onlyRemote: diff.onlyRemote.length,
            conflicts: diff.conflicts.length,
            lastSyncAt: nodeState.lastPullAt || nodeState.lastPushAt || null,
            diff,
        };
    }

    // ==================== 接收端 ====================

    receiveReport(reportId, reportData, source) {
        const reportDir = path.join(this.reportsDir, reportId);
        fs.mkdirSync(reportDir, { recursive: true });
        fs.mkdirSync(path.join(reportDir, 'evidence'), { recursive: true });
        fs.mkdirSync(path.join(reportDir, 'evidence', 'screenshots'), { recursive: true });

        const jsonPath = path.join(reportDir, 'report.json');
        const tmpPath = `${jsonPath}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(tmpPath, JSON.stringify(reportData, null, 2) + '\n', 'utf8');
        fs.renameSync(tmpPath, jsonPath);

        // 更新SQLite索引
        if (this.blueTeamReportService) {
            try {
                this.blueTeamReportService.upsertReportIndex(reportData);
            } catch (error) {
                console.error('upsertReportIndex after receive failed:', error.message);
            }
        }

        return { reportId, received: true, source };
    }

    receiveEvidence(reportId, type, filePath, fileBuffer) {
        const evidenceTypeDirMap = {
            'screenshot': 'screenshots',
            'ocr-lines': 'ocr-lines.jsonl',
            'har-summary': 'har-summary.json',
            'api-request': 'api-requests.jsonl',
            'outbound-evidence': 'outbound-evidence.jsonl',
            'db-check': 'db-check-result.json',
            'supervisor-event': 'supervisor-events.jsonl',
            'events': 'events.jsonl',
        };

        const reportDir = path.join(this.reportsDir, reportId);
        const evidenceDir = path.join(reportDir, 'evidence');
        fs.mkdirSync(evidenceDir, { recursive: true });

        const mappedName = evidenceTypeDirMap[type];
        if (!mappedName) {
            const error = new Error(`invalid evidence type: ${type}`);
            error.statusCode = 400;
            error.code = 'invalid_evidence_type';
            throw error;
        }

        let targetPath;
        if (type === 'screenshot') {
            const screenshotsDir = path.join(evidenceDir, 'screenshots');
            fs.mkdirSync(screenshotsDir, { recursive: true });
            const safeName = String(filePath || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 255) || `screenshot-${Date.now()}.png`;
            targetPath = path.join(screenshotsDir, safeName);
        } else {
            targetPath = path.join(evidenceDir, mappedName);
        }

        fs.writeFileSync(targetPath, Buffer.from(fileBuffer));

        return { reportId, type, filePath: path.relative(reportDir, targetPath) };
    }

    checkExistingReports(reportIds) {
        const ids = String(reportIds || '').split(',').map(s => s.trim()).filter(Boolean);
        const existing = [];
        for (const id of ids) {
            const jsonPath = path.join(this.reportsDir, id, 'report.json');
            if (fs.existsSync(jsonPath)) {
                existing.push(id);
            }
        }
        return existing;
    }

    // ==================== 工具方法 ====================

    authHeaders() {
        return {};
    }

    async requestWithRetry(fn, retries = MAX_RETRIES) {
        let lastError;
        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                return await fn();
            } catch (error) {
                lastError = error;
                if (attempt < retries && (!error.response || error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT')) {
                    await this.sleep(RETRY_DELAY_MS * attempt);
                    continue;
                }
                throw error;
            }
        }
        throw lastError;
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = SyncService;
