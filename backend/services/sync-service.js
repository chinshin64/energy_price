const fs = require('fs');
const path = require('path');
const axios = require('axios');

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;
const REPORT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/;
const NODE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const EVIDENCE_FILENAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
const NODE_DIRECTIONS = new Set(['push-only', 'pull-only', 'bidirectional']);
const EVIDENCE_FILE_TYPES = {
    'ocr-lines.jsonl': 'ocr-lines',
    'har-summary.json': 'har-summary',
    'api-requests.jsonl': 'api-request',
    'outbound-evidence.jsonl': 'outbound-evidence',
    'db-check-result.json': 'db-check',
    'supervisor-events.jsonl': 'supervisor-event',
    'events.jsonl': 'events',
};

function syncError(code, message, statusCode = 400) {
    const error = new Error(message);
    error.code = code;
    error.statusCode = statusCode;
    return error;
}

function normalizeHostList(value) {
    const values = Array.isArray(value) ? value : String(value || '').split(',');
    return values
        .map(item => String(item || '').trim().toLowerCase())
        .filter(Boolean);
}

class SyncService {
    constructor(options = {}) {
        this.nodesPath = options.nodesPath || path.join(__dirname, '../../config/sync-nodes.json');
        this.reportsDir = options.reportsDir || path.join(__dirname, '../../data/blue-team-reports');
        this.statePath = options.statePath || path.join(__dirname, '../../data/sync-state.json');
        this.blueTeamReportService = options.blueTeamReportService || null;
        this.httpClient = options.httpClient || axios;
        this.defaultNodes = Array.isArray(options.defaultNodes) ? options.defaultNodes : null;
        this.localNodeUrl = options.localNodeUrl
            || process.env.SYNC_LOCAL_NODE_URL
            || `http://127.0.0.1:${process.env.PORT || 3000}`;
        this.defaultNodeUrl = options.defaultNodeUrl || process.env.SYNC_DEFAULT_NODE_URL || '';
        this.defaultNodeName = options.defaultNodeName || process.env.SYNC_DEFAULT_NODE_NAME || 'remote';
        this.allowedNodeHosts = new Set(normalizeHostList(
            options.allowedNodeHosts !== undefined ? options.allowedNodeHosts : process.env.SYNC_ALLOWED_HOSTS
        ));
        this.requireNodeAllowlist = options.requireNodeAllowlist !== undefined
            ? options.requireNodeAllowlist === true
            : process.env.NODE_ENV === 'production';

        fs.mkdirSync(path.dirname(this.nodesPath), { recursive: true });
        fs.mkdirSync(this.reportsDir, { recursive: true });
        fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    }

    // ==================== 节点配置管理 ====================

    loadNodes() {
        try {
            if (!fs.existsSync(this.nodesPath)) {
                const defaultNodes = this.buildDefaultNodes();
                this.saveNodes(defaultNodes);
                return defaultNodes;
            }
            const raw = JSON.parse(fs.readFileSync(this.nodesPath, 'utf8'));
            return Array.isArray(raw.nodes)
                ? raw.nodes.map(node => this.normalizeNode(node))
                : [];
        } catch (error) {
            console.error('loadNodes failed:', error.message);
            return [];
        }
    }

    buildDefaultNodes() {
        if (this.defaultNodes) {
            return this.defaultNodes.map(node => this.normalizeNode(node));
        }
        const nodes = [];
        if (process.env.NODE_ENV !== 'production' && this.localNodeUrl) {
            try {
                nodes.push(this.normalizeNode({
                    name: 'local',
                    url: this.localNodeUrl,
                    direction: 'bidirectional',
                    enabled: true,
                }));
            } catch (error) {
                if (error.code !== 'sync_node_host_not_allowed') {
                    throw error;
                }
            }
        }
        if (this.defaultNodeUrl) {
            nodes.push(this.normalizeNode({
                name: this.defaultNodeName,
                url: this.defaultNodeUrl,
                direction: 'bidirectional',
                enabled: true,
            }));
        }
        return nodes;
    }

    saveNodes(nodes) {
        const normalizedNodes = (Array.isArray(nodes) ? nodes : []).map(node => this.normalizeNode(node));
        const dir = path.dirname(this.nodesPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        const tmpPath = `${this.nodesPath}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(tmpPath, JSON.stringify({ nodes: normalizedNodes }, null, 2) + '\n', 'utf8');
        fs.renameSync(tmpPath, this.nodesPath);
    }

    addNode(node) {
        const entry = this.normalizeNode(node);
        const nodes = this.loadNodes();
        if (nodes.some(n => n.name === entry.name)) {
            throw syncError('sync_node_exists', `node already exists: ${entry.name}`, 409);
        }
        nodes.push(entry);
        this.saveNodes(nodes);
        return this.toPublicNode(entry);
    }

    removeNode(name) {
        const normalizedName = this.normalizeNodeName(name);
        const nodes = this.loadNodes();
        const index = nodes.findIndex(n => n.name === normalizedName);
        if (index === -1) {
            throw syncError('sync_node_not_found', `node not found: ${normalizedName}`, 404);
        }
        const removed = nodes.splice(index, 1)[0];
        this.saveNodes(nodes);
        return this.toPublicNode(removed);
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
        const normalizedName = this.normalizeNodeName(nodeName);
        const state = this.loadSyncState();
        if (!state[normalizedName]) {
            state[normalizedName] = {};
        }
        Object.assign(state[normalizedName], info, { updatedAt: new Date().toISOString() });
        this.saveSyncState(state);
    }

    // ==================== 节点连通性 ====================

    async checkNodeHealth(nodeUrl, authToken = '') {
        try {
            const normalizedUrl = this.normalizeNodeUrl(nodeUrl);
            const response = await this.httpClient.get(`${normalizedUrl}/api/blue-team/reports`, {
                params: { limit: 1 },
                timeout: 5000,
                headers: this.authHeaders(authToken),
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
            let reportId;
            try {
                reportId = this.normalizeReportId(entry.name);
            } catch (error) {
                continue;
            }
            const jsonPath = path.join(this.getReportDir(reportId), 'report.json');
            if (!fs.existsSync(jsonPath)) continue;
            try {
                const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
                const storedId = this.normalizeReportId(data.reportId || reportId);
                if (storedId !== reportId) {
                    continue;
                }
                reports.push({
                    reportId,
                    updatedAt: data.updatedAt || data.createdAt || '',
                });
            } catch (error) {
                reports.push({ reportId, updatedAt: '' });
            }
        }
        return reports;
    }

    // ==================== 远端交互 ====================

    async fetchRemoteReportList(nodeUrl, authToken = '') {
        const normalizedUrl = this.normalizeNodeUrl(nodeUrl);
        const response = await this.requestWithRetry(() =>
            this.httpClient.get(`${normalizedUrl}/api/blue-team/reports`, {
                params: { limit: 1000 },
                timeout: 15000,
                headers: this.authHeaders(authToken),
            })
        );
        const body = response.data;
        if (body && Array.isArray(body.data)) {
            return body.data.flatMap((report) => {
                try {
                    return [{
                        reportId: this.normalizeReportId(report.reportId),
                        updatedAt: report.updatedAt || report.createdAt || '',
                    }];
                } catch (error) {
                    return [];
                }
            });
        }
        return [];
    }

    async fetchRemoteReport(nodeUrl, reportId, authToken = '') {
        const normalizedUrl = this.normalizeNodeUrl(nodeUrl);
        const normalizedReportId = this.normalizeReportId(reportId);
        const response = await this.requestWithRetry(() =>
            this.httpClient.get(`${normalizedUrl}/api/blue-team/reports/${encodeURIComponent(normalizedReportId)}`, {
                params: { sanitize: 'false' },
                timeout: 30000,
                headers: this.authHeaders(authToken),
            })
        );
        const body = response.data;
        return body && body.success === true && body.data ? body.data : body;
    }

    async fetchRemoteEvidenceList(nodeUrl, reportId, authToken = '') {
        try {
            const normalizedUrl = this.normalizeNodeUrl(nodeUrl);
            const normalizedReportId = this.normalizeReportId(reportId);
            const response = await this.requestWithRetry(() =>
                this.httpClient.get(`${normalizedUrl}/api/blue-team/reports/${encodeURIComponent(normalizedReportId)}/evidence-list`, {
                    timeout: 15000,
                    headers: this.authHeaders(authToken),
                })
            );
            return response.data && response.data.files ? response.data.files : {};
        } catch (error) {
            return {};
        }
    }

    async fetchRemoteEvidenceFile(nodeUrl, reportId, type, filename, authToken = '') {
        const normalizedUrl = this.normalizeNodeUrl(nodeUrl);
        const encodedId = encodeURIComponent(this.normalizeReportId(reportId));
        let url;
        if (type === 'screenshot') {
            const safeFilename = this.normalizeEvidenceFilename(filename);
            url = `${normalizedUrl}/api/blue-team/reports/${encodedId}/evidence/${type}/${encodeURIComponent(safeFilename)}`;
        } else {
            url = `${normalizedUrl}/api/blue-team/reports/${encodedId}/evidence/${encodeURIComponent(type)}`;
        }
        const response = await this.requestWithRetry(() =>
            this.httpClient.get(url, {
                timeout: 30000,
                responseType: 'arraybuffer',
                headers: this.authHeaders(authToken),
            })
        );
        return response.data;
    }

    async pushReportToRemote(reportId, nodeUrl, authToken) {
        const normalizedReportId = this.normalizeReportId(reportId);
        const normalizedUrl = this.normalizeNodeUrl(nodeUrl);
        const reportDir = this.getReportDir(normalizedReportId);
        const jsonPath = path.join(reportDir, 'report.json');
        if (!fs.existsSync(jsonPath)) {
            throw syncError('report_not_found', `local report not found: ${normalizedReportId}`, 404);
        }

        const reportData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

        // 1. 推送报告元数据
        await this.requestWithRetry(() =>
            this.httpClient.post(`${normalizedUrl}/api/sync/receive/report`, {
                reportId: normalizedReportId,
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
            return { reportId: normalizedReportId, pushedEvidence: 0 };
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
                    await this.pushEvidenceFile(normalizedUrl, normalizedReportId, 'screenshot', file, fileBuffer, authToken);
                    pushedEvidence++;
                }
            } else if (entry.isFile()) {
                const eType = evidenceTypeMap[entry.name];
                if (!eType) continue;
                const fPath = path.join(evidenceDir, entry.name);
                const fileBuffer = fs.readFileSync(fPath);
                await this.pushEvidenceFile(normalizedUrl, normalizedReportId, eType, entry.name, fileBuffer, authToken);
                pushedEvidence++;
            }
        }

        return { reportId: normalizedReportId, pushedEvidence };
    }

    async pushEvidenceFile(nodeUrl, reportId, type, filename, fileBuffer, authToken) {
        const FormData = require('form-data');
        const normalizedUrl = this.normalizeNodeUrl(nodeUrl);
        const normalizedReportId = this.normalizeReportId(reportId);
        const safeFilename = this.normalizeEvidenceFilename(filename);
        const form = new FormData();
        form.append('reportId', normalizedReportId);
        form.append('type', type);
        form.append('filePath', safeFilename);
        form.append('file', fileBuffer, { filename: safeFilename });

        await this.requestWithRetry(() =>
            this.httpClient.post(`${normalizedUrl}/api/sync/receive/evidence`, form, {
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

    async pullReportFromRemote(reportId, nodeUrl, authToken = '') {
        const normalizedReportId = this.normalizeReportId(reportId);
        const normalizedUrl = this.normalizeNodeUrl(nodeUrl);
        // 1. 获取报告元数据
        const reportData = await this.fetchRemoteReport(normalizedUrl, normalizedReportId, authToken);
        if (!reportData || typeof reportData !== 'object' || Array.isArray(reportData)) {
            throw syncError('invalid_remote_report', 'remote report payload must be an object', 502);
        }
        const remoteReportId = this.normalizeReportId(reportData.reportId || normalizedReportId);
        if (remoteReportId !== normalizedReportId) {
            throw syncError('remote_report_id_mismatch', 'remote report id does not match the requested report', 502);
        }

        // 2. 保存到本地
        const reportDir = this.getReportDir(normalizedReportId);
        fs.mkdirSync(reportDir, { recursive: true });
        fs.mkdirSync(path.join(reportDir, 'evidence'), { recursive: true });
        fs.mkdirSync(path.join(reportDir, 'evidence', 'screenshots'), { recursive: true });

        const tmpPath = `${reportDir}/report.json.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(tmpPath, JSON.stringify(reportData, null, 2) + '\n', 'utf8');
        fs.renameSync(tmpPath, path.join(reportDir, 'report.json'));

        // 3. 拉取证据文件
        const evidenceList = await this.fetchRemoteEvidenceList(normalizedUrl, normalizedReportId, authToken);
        let pulledEvidence = 0;

        for (const [typeKey, value] of Object.entries(evidenceList)) {
            if (typeKey === 'screenshots' && Array.isArray(value)) {
                for (const filename of value) {
                    try {
                        const safeFilename = this.normalizeEvidenceFilename(filename);
                        const fileBuffer = await this.fetchRemoteEvidenceFile(
                            normalizedUrl,
                            normalizedReportId,
                            'screenshot',
                            safeFilename,
                            authToken
                        );
                        const screenshotPath = this.resolveWithin(
                            path.join(reportDir, 'evidence', 'screenshots'),
                            safeFilename
                        );
                        fs.writeFileSync(screenshotPath, Buffer.from(fileBuffer));
                        pulledEvidence++;
                    } catch (error) {
                        console.error(`pull screenshot ${filename} failed:`, error.message);
                    }
                }
            } else if (typeof value === 'string') {
                try {
                    const safeFilename = this.normalizeEvidenceFilename(value);
                    const evidenceType = EVIDENCE_FILE_TYPES[typeKey] || EVIDENCE_FILE_TYPES[safeFilename];
                    if (!evidenceType) {
                        continue;
                    }
                    const fileBuffer = await this.fetchRemoteEvidenceFile(
                        normalizedUrl,
                        normalizedReportId,
                        evidenceType,
                        undefined,
                        authToken
                    );
                    const evidencePath = this.resolveWithin(path.join(reportDir, 'evidence'), safeFilename);
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

        return { reportId: normalizedReportId, pulledEvidence };
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
        const normalizedNodeName = this.normalizeNodeName(nodeName);
        const nodes = this.loadNodes();
        const node = nodes.find(n => n.name === normalizedNodeName);
        if (!node) {
            throw syncError('sync_node_not_found', `node not found: ${normalizedNodeName}`, 404);
        }

        const localReports = this.scanLocalReports();
        let remoteReports = [];
        try {
            remoteReports = await this.fetchRemoteReportList(node.url, node.authToken);
        } catch (error) {
            const err = new Error(`cannot connect to node ${normalizedNodeName}: ${error.message}`);
            err.statusCode = 502;
            err.code = 'sync_node_unreachable';
            throw err;
        }

        const diff = this.computeDiff(localReports, remoteReports);
        const requestedReportIds = this.normalizeReportIdList(options.reportIds);
        const toPush = requestedReportIds
            ? diff.onlyLocal.filter(r => requestedReportIds.includes(r.reportId))
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
            node: normalizedNodeName,
            pushed: pushed.length,
            skipped: skipped.length,
            errors: errors.length,
            details: { pushed, skipped, errors },
        };

        this.updateNodeSyncState(normalizedNodeName, {
            lastPushAt: new Date().toISOString(),
            lastPushResult: result,
        });

        return result;
    }

    // ==================== 拉取 ====================

    async pull(nodeName, options = {}) {
        const normalizedNodeName = this.normalizeNodeName(nodeName);
        const nodes = this.loadNodes();
        const node = nodes.find(n => n.name === normalizedNodeName);
        if (!node) {
            throw syncError('sync_node_not_found', `node not found: ${normalizedNodeName}`, 404);
        }

        const localReports = this.scanLocalReports();
        let remoteReports = [];
        try {
            remoteReports = await this.fetchRemoteReportList(node.url, node.authToken);
        } catch (error) {
            const err = new Error(`cannot connect to node ${normalizedNodeName}: ${error.message}`);
            err.statusCode = 502;
            err.code = 'sync_node_unreachable';
            throw err;
        }

        const diff = this.computeDiff(localReports, remoteReports);
        const requestedReportIds = this.normalizeReportIdList(options.reportIds);
        const toPull = requestedReportIds
            ? diff.onlyRemote.filter(r => requestedReportIds.includes(r.reportId))
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
                const result = await this.pullReportFromRemote(report.reportId, node.url, node.authToken);
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
            node: normalizedNodeName,
            pulled: pulled.length,
            skipped: skipped.length,
            errors: errors.length,
            details: { pulled, skipped, errors },
        };

        this.updateNodeSyncState(normalizedNodeName, {
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
            node: this.normalizeNodeName(nodeName),
            pulled: pullResult.pulled,
            pushed: pushResult.pushed,
            conflicts: pullResult.details.skipped.filter(s => s.reason === 'local_newer').length
                + pushResult.details.skipped.filter(s => s.reason === 'remote_newer').length,
            pullErrors: pullResult.details.errors,
            pushErrors: pushResult.details.errors,
        };
    }

    // ==================== 同步状态 ====================

    async getSyncStatus(nodeName) {
        const normalizedNodeName = this.normalizeNodeName(nodeName);
        const nodes = this.loadNodes();
        const node = nodes.find(n => n.name === normalizedNodeName);
        if (!node) {
            throw syncError('sync_node_not_found', `node not found: ${normalizedNodeName}`, 404);
        }

        const localReports = this.scanLocalReports();
        let remoteReports = [];
        let status = 'offline';
        try {
            remoteReports = await this.fetchRemoteReportList(node.url, node.authToken);
            status = 'online';
        } catch (error) {
            // keep offline
        }

        const diff = this.computeDiff(localReports, remoteReports);
        const syncState = this.loadSyncState();
        const nodeState = syncState[normalizedNodeName] || {};

        return {
            node: normalizedNodeName,
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
        const normalizedReportId = this.normalizeReportId(reportId);
        if (!reportData || typeof reportData !== 'object' || Array.isArray(reportData)) {
            throw syncError('invalid_report_payload', 'reportData must be an object');
        }
        const payloadReportId = this.normalizeReportId(reportData.reportId || normalizedReportId);
        if (payloadReportId !== normalizedReportId) {
            throw syncError('report_id_mismatch', 'reportData.reportId must match reportId');
        }
        const normalizedReport = { ...reportData, reportId: normalizedReportId };
        const reportDir = this.getReportDir(normalizedReportId);
        fs.mkdirSync(reportDir, { recursive: true });
        fs.mkdirSync(path.join(reportDir, 'evidence'), { recursive: true });
        fs.mkdirSync(path.join(reportDir, 'evidence', 'screenshots'), { recursive: true });

        const jsonPath = path.join(reportDir, 'report.json');
        const tmpPath = `${jsonPath}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(tmpPath, JSON.stringify(normalizedReport, null, 2) + '\n', 'utf8');
        fs.renameSync(tmpPath, jsonPath);

        // 更新SQLite索引
        if (this.blueTeamReportService) {
            try {
                this.blueTeamReportService.upsertReportIndex(normalizedReport);
            } catch (error) {
                console.error('upsertReportIndex after receive failed:', error.message);
            }
        }

        return { reportId: normalizedReportId, received: true, source: String(source || '').slice(0, 128) };
    }

    receiveEvidence(reportId, type, filePath, fileBuffer) {
        const normalizedReportId = this.normalizeReportId(reportId);
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

        const reportDir = this.getReportDir(normalizedReportId);
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
            const safeName = filePath
                ? this.normalizeEvidenceFilename(filePath)
                : `screenshot-${Date.now()}.png`;
            targetPath = this.resolveWithin(screenshotsDir, safeName);
        } else {
            targetPath = this.resolveWithin(evidenceDir, mappedName);
        }

        fs.writeFileSync(targetPath, Buffer.from(fileBuffer));

        return { reportId: normalizedReportId, type, filePath: path.relative(reportDir, targetPath) };
    }

    checkExistingReports(reportIds) {
        const ids = this.normalizeReportIdList(reportIds) || [];
        const existing = [];
        for (const id of ids) {
            const jsonPath = path.join(this.getReportDir(id), 'report.json');
            if (fs.existsSync(jsonPath)) {
                existing.push(id);
            }
        }
        return existing;
    }

    // ==================== 工具方法 ====================

    normalizeReportId(value) {
        const reportId = String(value || '').trim();
        if (!REPORT_ID_PATTERN.test(reportId) || reportId.includes('..')) {
            throw syncError('invalid_sync_report_id', 'invalid sync report id');
        }
        return reportId;
    }

    normalizeReportIdList(value) {
        if (value === undefined || value === null || value === '') {
            return null;
        }
        const values = Array.isArray(value) ? value : String(value).split(',');
        return Array.from(new Set(values
            .map(item => String(item || '').trim())
            .filter(Boolean)
            .map(item => this.normalizeReportId(item))));
    }

    getReportDir(reportId) {
        const normalizedReportId = this.normalizeReportId(reportId);
        return this.resolveWithin(this.reportsDir, normalizedReportId);
    }

    resolveWithin(root, ...segments) {
        const resolvedRoot = path.resolve(root);
        const resolvedPath = path.resolve(resolvedRoot, ...segments);
        if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)) {
            throw syncError('invalid_sync_path', 'resolved path is outside the configured sync root');
        }
        return resolvedPath;
    }

    normalizeEvidenceFilename(value) {
        const filename = String(value || '').trim();
        if (!EVIDENCE_FILENAME_PATTERN.test(filename) || filename.includes('..')) {
            throw syncError('invalid_evidence_filename', 'invalid evidence filename');
        }
        return filename;
    }

    normalizeNodeName(value) {
        const name = String(value || '').trim();
        if (!NODE_NAME_PATTERN.test(name) || name.includes('..')) {
            throw syncError('invalid_sync_node_name', 'invalid sync node name');
        }
        return name;
    }

    normalizeNodeUrl(value) {
        let url;
        try {
            url = new URL(String(value || '').trim());
        } catch (error) {
            throw syncError('invalid_sync_node_url', 'sync node URL must be an absolute HTTP(S) URL');
        }
        if (!['http:', 'https:'].includes(url.protocol)) {
            throw syncError('invalid_sync_node_url', 'sync node URL must use HTTP or HTTPS');
        }
        if (url.username || url.password || url.search || url.hash) {
            throw syncError('invalid_sync_node_url', 'sync node URL cannot contain credentials, query, or fragment');
        }
        const hostname = String(url.hostname || '').toLowerCase();
        if (this.requireNodeAllowlist) {
            if (this.allowedNodeHosts.size === 0) {
                throw syncError(
                    'sync_node_allowlist_not_configured',
                    'SYNC_ALLOWED_HOSTS is required in production',
                    503
                );
            }
            if (!this.allowedNodeHosts.has(hostname)) {
                throw syncError('sync_node_host_not_allowed', `sync node host is not allowed: ${hostname}`, 403);
            }
        } else if (this.allowedNodeHosts.size > 0 && !this.allowedNodeHosts.has(hostname)) {
            throw syncError('sync_node_host_not_allowed', `sync node host is not allowed: ${hostname}`, 403);
        }
        url.pathname = url.pathname.replace(/\/+$/, '') || '/';
        return url.toString().replace(/\/$/, '');
    }

    normalizeNode(node) {
        if (!node || typeof node !== 'object' || Array.isArray(node)) {
            throw syncError('invalid_sync_node', 'sync node must be an object');
        }
        const direction = String(node.direction || 'bidirectional').trim();
        if (!NODE_DIRECTIONS.has(direction)) {
            throw syncError('invalid_sync_node_direction', 'invalid sync node direction');
        }
        const authToken = String(node.authToken || '');
        if (authToken.length > 4096) {
            throw syncError('invalid_sync_node_token', 'sync node token is too long');
        }
        return {
            name: this.normalizeNodeName(node.name),
            url: this.normalizeNodeUrl(node.url),
            authToken,
            direction,
            enabled: node.enabled !== false,
        };
    }

    toPublicNode(node) {
        return {
            name: node.name,
            url: node.url,
            direction: node.direction,
            enabled: node.enabled !== false,
            authConfigured: Boolean(node.authToken),
        };
    }

    authHeaders(authToken = '') {
        const token = String(authToken || '').trim();
        return token ? { authorization: `Bearer ${token}` } : {};
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
