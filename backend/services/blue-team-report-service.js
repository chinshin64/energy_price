const fs = require('fs');
const path = require('path');

const db = require('../database/init');

const DEFAULT_SEED_REPORT_ID = 'BTR-RISK-20260531-0001';
const REPORT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/;

const INTERFACE_DISPLAY_MAP = {
    'stationList': '列表接口',
    'getoneinfo': '详情接口',
    'homepage/stationList': '场站列表接口',
    'station/getoneinfo': '场站详情接口',
};

const SENSITIVE_PARAM_NAMES = ['openid', 'token', 'tokenId', 'ticket', 'wsgsig', 'session_key'];
const SENSITIVE_HEADERS = ['xweb_xhr', 'cookie', 'authorization'];

const EVIDENCE_DIR_MAP = {
    'screenshot': 'screenshots',
    'ocr-lines': 'ocr-lines.jsonl',
    'har-summary': 'har-summary.json',
    'api-request': 'api-requests.jsonl',
    'outbound-evidence': 'outbound-evidence.jsonl',
    'db-check': 'db-check-result.json',
    'supervisor-event': 'supervisor-events.jsonl',
};

const METHOD_LABEL_MAP = {
    'page-automation': '页面自动化识别',
    'background-automation': '后台自动化识别',
    'traffic-template': '流量自动化识别',
};

const STATUS_LABEL_MAP = {
    'passed': '通过',
    'partial': '部分通过',
    'failed': '失败',
    'blocked': '阻塞',
    'draft': '草稿',
    'unknown': '未知',
};

const RETEST_STATUS_LABEL_MAP = {
    'none': '无',
    'pending': '待复测',
    'in-progress': '复测中',
    'done': '已复测',
};

const RISK_LABEL_MAP = {
    'critical': '严重',
    'high': '高',
    'medium': '中',
    'low': '低',
    'none': '无',
    'unknown': '未知',
};

class BlueTeamReportService {
    constructor(options = {}) {
        this.rootDir = options.rootDir || path.join(__dirname, '../../data/blue-team-reports');
        fs.mkdirSync(this.rootDir, { recursive: true });
    }

    // ==================== 新增方法 ====================

    startReport(input = {}) {
        const reportId = this.generateReportId();
        const now = new Date().toISOString();
        const method = input.method || '';
        const platform = input.platform || '';
        const title = String(input.title || '').trim() || `${METHOD_LABEL_MAP[method] || '蓝军测试'}报告 - ${reportId}`;
        const cities = Array.isArray(input.cities) ? input.cities : [];
        const executorName = input.executorName || input.executor?.name || '';
        const executor = input.executor || (executorName ? { name: executorName } : null);
        const infra = input.infra || (executor ? { executor } : {});
        const target = input.target || {};
        const scope = input.scope || target.scope || '';
        const assets = Array.isArray(target.assets || input.assets) ? (target.assets || input.assets) : [];

        const targets = cities.map(city => ({
            city,
            landmarks: [],
            status: 'unknown',
            riskLevel: 'unknown',
            metrics: { requests: 0, success: 0, failed: 0, cityMismatch: 0 }
        }));

        const report = {
            schemaVersion: 'blue-team-report/v3',
            reportId,
            title,
            method,
            platform,
            reportName: title,
            createdAt: now,
            startedAt: input.startedAt || now,
            finishedAt: null,
            updatedAt: now,
            executor,
            target: {
                ...target,
                platform: platform || target.platform || '',
                cities,
                assets,
            },
            scope,
            cities,
            methods: Array.isArray(input.methods) ? input.methods : [],
            events: [],
            targets,
            overallStatus: 'draft',
            conclusion: '',
            riskLevel: input.riskLevel || 'unknown',
            riskLevelLabel: this.toRiskLabel(input.riskLevel || 'unknown'),
            evidenceCompleteness: 'unknown',
            findings: [],
            evidenceMatrix: [],
            recommendations: [],
            retest: {
                status: 'none',
                statusLabel: '无',
                criteria: [],
                parentReportId: null,
                childReportId: null,
            },
            retestStatus: 'none',
            completion: {
                overall: 'draft',
                score: 0,
                riskLevel: 'unknown',
                evidenceCompleteness: 'unknown',
                summary: '报告创建中',
                conclusion: '',
            },
            infra,
            signatures: input.signatures || {},
            metrics: {},
            resourceStats: {},
            attackChain: input.attackChain || { summary: '', steps: [] },
            audit: {
                generatedBy: 'BlueTeamReportService',
                source: 'start',
            },
        };

        const reportDir = this.getReportDir(reportId);
        fs.mkdirSync(reportDir, { recursive: true });
        fs.mkdirSync(path.join(reportDir, 'evidence'), { recursive: true });
        fs.mkdirSync(path.join(reportDir, 'evidence', 'screenshots'), { recursive: true });

        this.writeFileAtomic(
            path.join(reportDir, 'report.json'),
            `${JSON.stringify(report, null, 2)}\n`
        );

        this.upsertReportIndex(report);

        return this.decorateReport(report);
    }

    appendEvent(reportId, events = []) {
        const id = this.normalizeReportId(reportId);
        const report = this.readReportRaw(id);
        const appendList = Array.isArray(events) ? events : [events];

        if (!Array.isArray(report.events)) {
            report.events = [];
        }

        report.events.push(...appendList);
        report.updatedAt = new Date().toISOString();

        if (report.events.length > 1000) {
            const overflow = report.events.slice(0, report.events.length - 1000);
            report.events = report.events.slice(report.events.length - 1000);
            const eventsJsonlPath = path.join(this.getReportDir(id), 'evidence', 'events.jsonl');
            fs.mkdirSync(path.dirname(eventsJsonlPath), { recursive: true });
            for (const evt of overflow) {
                fs.appendFileSync(eventsJsonlPath, `${JSON.stringify(evt)}\n`, 'utf8');
            }
        }

        this.writeReportJson(id, report);
        return { reportId: id, eventCount: report.events.length, appended: appendList.length };
    }

    appendEvidence(reportId, evidence = {}) {
        const id = this.normalizeReportId(reportId);
        const report = this.readReportRaw(id);
        const { type, data, filename, city } = evidence;

        if (!type || !EVIDENCE_DIR_MAP[type]) {
            const error = new Error(`invalid evidence type: ${type}`);
            error.statusCode = 400;
            error.code = 'invalid_evidence_type';
            throw error;
        }

        const evidenceDir = this.getReportDir(id);
        const evidencePath = path.join(evidenceDir, 'evidence');
        fs.mkdirSync(evidencePath, { recursive: true });

        const mappedName = EVIDENCE_DIR_MAP[type];
        const targetPath = path.join(evidencePath, mappedName);

        if (type === 'screenshot') {
            const screenshotsDir = path.join(evidencePath, 'screenshots');
            fs.mkdirSync(screenshotsDir, { recursive: true });
            const safeName = this.sanitizeFilename(filename || `screenshot-${Date.now()}.png`);
            const filePath = path.join(screenshotsDir, safeName);
            if (typeof data === 'string') {
                fs.writeFileSync(filePath, Buffer.from(data, 'base64'));
            } else if (Buffer.isBuffer(data)) {
                fs.writeFileSync(filePath, data);
            } else {
                fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
            }
            this.updateEvidenceMatrix(report, type, `evidence/screenshots/${safeName}`, city);
        } else if (mappedName.endsWith('.jsonl')) {
            const line = typeof data === 'string' ? data : JSON.stringify(data);
            fs.appendFileSync(targetPath, `${line}\n`, 'utf8');
            this.updateEvidenceMatrix(report, type, `evidence/${mappedName}`, city);
        } else {
            const content = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
            fs.writeFileSync(targetPath, content, 'utf8');
            this.updateEvidenceMatrix(report, type, `evidence/${mappedName}`, city);
        }

        report.updatedAt = new Date().toISOString();
        this.writeReportJson(id, report);
        this.upsertReportIndex(report);

        return { reportId: id, type, path: `evidence/${mappedName}` };
    }

    finalizeReport(reportId, input = {}) {
        const id = this.normalizeReportId(reportId);
        const report = this.readReportRaw(id);

        const now = new Date().toISOString();
        report.finishedAt = input.finishedAt || now;
        report.updatedAt = now;
        report.overallStatus = input.overallStatus || 'partial';
        report.conclusion = input.conclusion || '';
        report.riskLevel = input.riskLevel || report.riskLevel || 'unknown';
        report.riskLevelLabel = this.toRiskLabel(report.riskLevel);

        if (Array.isArray(input.targets)) {
            report.targets = input.targets;
        }
        if (Array.isArray(input.findings)) {
            report.findings = input.findings;
        }
        if (Array.isArray(input.recommendations)) {
            report.recommendations = input.recommendations;
        }
        if (input.conclusion !== undefined) {
            report.conclusion = input.conclusion;
        }

        // v3 新增字段支持
        if (input.completion && typeof input.completion === 'object') {
            report.completion = { ...report.completion, ...input.completion };
        }
        if (input.infra && typeof input.infra === 'object') {
            report.infra = input.infra;
        }
        if (input.signatures && typeof input.signatures === 'object') {
            report.signatures = input.signatures;
        }
        if (input.attackChain && typeof input.attackChain === 'object') {
            report.attackChain = input.attackChain;
        }
        if (input.methods && Array.isArray(input.methods)) {
            report.methods = input.methods;
        }

        // 证据校验：无证据不允许 passed
        const hasEvidence = this.hasActualEvidenceFiles(id);
        const hasFindings = Array.isArray(report.findings) && report.findings.length > 0;
        if (!hasEvidence && !hasFindings && report.overallStatus === 'passed') {
            report.overallStatus = 'partial';
            const warning = '⚠️ 本报告无证据支撑，结论已自动降级为部分通过';
            if (!report.conclusion) {
                report.conclusion = warning;
            } else if (!report.conclusion.includes('⚠️')) {
                report.conclusion = `${warning}\n${report.conclusion}`;
            }
        }

        // evidenceCompleteness 以实际文件校验为准，不信任 input
        report.evidenceCompleteness = hasEvidence
            ? this.computeEvidenceCompleteness(report)
            : 'missing';

        this.aggregateCityConclusions(report);

        // === v3 三核结构增强 ===
        // 计算完成度评分
        const score = this.computeCompletionScore(report);

        // 构建 completion 对象
        const conclusionText = report.conclusion || '';
        const summaryText = conclusionText
            ? conclusionText.split(/[。！？\n]/)[0].trim()
            : '';
        report.completion = {
            overall: report.overallStatus || 'unknown',
            score,
            riskLevel: report.riskLevel || 'unknown',
            evidenceCompleteness: report.evidenceCompleteness || 'unknown',
            summary: summaryText || (score > 0 ? '完成度 ' + score + '/100' : '无评分数据'),
            conclusion: conclusionText,
        };

        // 计算量化指标
        report.metrics = this.computeMetrics(report);

        // 计算资源统计
        report.resourceStats = this.computeResourceStats(report);

        // 构建 infra 结构（从 executor 迁移）
        if (!report.infra) {
            report.infra = report.executor
                ? { executor: report.executor }
                : {};
        }

        // 构建 signatures 结构（保持已有或为空）
        if (!report.signatures) {
            report.signatures = input.signatures || {};
        }

        // 构建 attackChain 结构（保持已有或为空）
        if (!report.attackChain) {
            report.attackChain = input.attackChain || { summary: '', steps: [] };
        }

        // 更新 schemaVersion
        report.schemaVersion = 'blue-team-report/v3';

        const markdownPath = path.join(this.getReportDir(id), 'report.md');
        this.writeFileAtomic(markdownPath, this.generateMarkdown(report));

        this.writeReportJson(id, report);
        this.upsertReportIndex(report);

        if (report.retest && report.retest.parentReportId) {
            this.updateParentRetestStatus(report.retest.parentReportId, report);
        }

        return this.decorateReport(report);
    }

    listReports(filters = {}) {
        const limit = Math.max(1, Math.min(200, Math.floor(Number(filters.limit) || 100)));
        const offset = Math.max(0, Math.floor(Number(filters.offset) || 0));

        try {
            let whereClauses = [];
            let params = [];

            if (filters.method) {
                whereClauses.push('method = ?');
                params.push(filters.method);
            }
            if (filters.platform) {
                whereClauses.push('platform = ?');
                params.push(filters.platform);
            }
            if (filters.overallStatus) {
                whereClauses.push('overall_status = ?');
                params.push(filters.overallStatus);
            }
            if (filters.riskLevel) {
                whereClauses.push('risk_level = ?');
                params.push(filters.riskLevel);
            }
            if (filters.city) {
                whereClauses.push("cities LIKE ?");
                params.push(`%"${filters.city}"%`);
            }

            const whereClause = whereClauses.length > 0
                ? `WHERE ${whereClauses.join(' AND ')}`
                : '';

            const countRow = db.prepare(`SELECT COUNT(*) AS total FROM blue_team_reports ${whereClause}`).get(...params);
            const rows = db.prepare(
                `SELECT * FROM blue_team_reports ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`
            ).all(...params, limit, offset);

            const reports = rows.map(row => this.indexRowToSummary(row));
            return {
                data: reports,
                total: countRow.total,
                limit,
                offset,
            };
        } catch (error) {
            return this.listReportsFromFile(filters);
        }
    }

    createRetest(reportId, input = {}) {
        const id = this.normalizeReportId(reportId);
        const original = this.readReportRaw(id);

        const newReportId = this.generateReportId();
        const now = new Date().toISOString();

        const newReport = JSON.parse(JSON.stringify(original));
        newReport.schemaVersion = 'blue-team-report/v2';
        newReport.reportId = newReportId;
        newReport.title = `${original.title || original.reportId} - 复测`;
        newReport.reportName = newReport.title;
        newReport.createdAt = now;
        newReport.startedAt = now;
        newReport.finishedAt = null;
        newReport.updatedAt = now;
        newReport.overallStatus = 'draft';
        newReport.conclusion = '';
        newReport.findings = [];
        newReport.events = [];
        newReport.evidenceMatrix = [];
        newReport.targets = (original.targets || []).map(t => ({
            ...t,
            status: 'unknown',
            riskLevel: 'unknown',
            metrics: { requests: 0, success: 0, failed: 0, cityMismatch: 0 }
        }));
        newReport.retest = {
            status: 'none',
            statusLabel: '无',
            criteria: input.criteria || (original.retest && original.retest.criteria) || [],
            parentReportId: id,
            childReportId: null,
        };
        newReport.retestStatus = 'none';
        newReport.audit = {
            generatedBy: 'BlueTeamReportService',
            source: 'retest',
            parentReportId: id,
        };

        const newDir = this.getReportDir(newReportId);
        fs.mkdirSync(newDir, { recursive: true });
        fs.mkdirSync(path.join(newDir, 'evidence'), { recursive: true });
        fs.mkdirSync(path.join(newDir, 'evidence', 'screenshots'), { recursive: true });

        this.writeFileAtomic(
            path.join(newDir, 'report.json'),
            `${JSON.stringify(newReport, null, 2)}\n`
        );

        original.retest = original.retest || {};
        original.retest.childReportId = newReportId;
        original.retest.status = 'in-progress';
        original.retest.statusLabel = '复测中';
        original.retestStatus = 'in-progress';
        original.updatedAt = now;
        this.writeReportJson(id, original);
        this.upsertReportIndex(original);

        this.upsertReportIndex(newReport);

        return {
            parentReportId: id,
            childReportId: newReportId,
            report: this.decorateReport(newReport),
        };
    }

    readEvidenceFile(reportId, type, filename) {
        const id = this.normalizeReportId(reportId);
        const reportDir = this.getReportDir(id);

        if (!EVIDENCE_DIR_MAP[type]) {
            const error = new Error(`invalid evidence type: ${type}`);
            error.statusCode = 400;
            error.code = 'invalid_evidence_type';
            throw error;
        }

        const mappedName = EVIDENCE_DIR_MAP[type];
        let filePath;

        if (type === 'screenshot') {
            const safeName = this.sanitizeFilename(filename || '');
            filePath = path.join(reportDir, 'evidence', 'screenshots', safeName);
        } else {
            filePath = path.join(reportDir, 'evidence', mappedName);
        }

        const resolvedRoot = path.resolve(reportDir);
        const resolvedPath = path.resolve(filePath);
        if (!resolvedPath.startsWith(`${resolvedRoot}${path.sep}`) && resolvedPath !== resolvedRoot) {
            const error = new Error('invalid evidence file path');
            error.statusCode = 400;
            error.code = 'invalid_evidence_path';
            throw error;
        }

        if (!fs.existsSync(resolvedPath)) {
            const error = new Error(`evidence file not found: ${type}/${filename}`);
            error.statusCode = 404;
            error.code = 'evidence_file_not_found';
            throw error;
        }

        const ext = path.extname(resolvedPath).toLowerCase();
        const contentTypes = {
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.json': 'application/json',
            '.jsonl': 'application/x-ndjson',
            '.txt': 'text/plain',
        };

        return {
            filePath: resolvedPath,
            contentType: contentTypes[ext] || 'application/octet-stream',
            filename: path.basename(resolvedPath),
        };
    }

    sanitizeReport(data) {
        if (!data || typeof data !== 'object') {
            return data;
        }

        const sanitized = JSON.parse(JSON.stringify(data));

        // 集成 sensitive-redactor 对文本字段做 PII 检测
        try {
            const { redactObject } = require('./sensitive-redactor');
            // 对 completion/conclusion/summary 等文本字段做脱敏
            if (sanitized.completion && typeof sanitized.completion === 'object') {
                sanitized.completion = redactObject(sanitized.completion);
            }
            if (sanitized.recommendations && Array.isArray(sanitized.recommendations)) {
                sanitized.recommendations = sanitized.recommendations.map(r => redactObject(r));
            }
        } catch {}

        if (sanitized.target) {
            sanitized.target = this.sanitizeTarget(sanitized.target);
        }

        if (sanitized.methods) {
            sanitized.methods = sanitized.methods.map(m => this.sanitizeMethod(m));
        }

        if (sanitized.findings) {
            sanitized.findings = sanitized.findings.map(f => this.sanitizeFinding(f));
        }

        if (sanitized.evidenceMatrix) {
            sanitized.evidenceMatrix = sanitized.evidenceMatrix.map(e => this.sanitizeEvidenceEntry(e));
        }

        if (sanitized.executor) {
            sanitized.executor = this.sanitizeExecutor(sanitized.executor);
        }

        if (sanitized.infra) {
            sanitized.infra = this.sanitizeInfra(sanitized.infra);
        }

        if (sanitized.signatures) {
            sanitized.signatures = this.sanitizeSignatures(sanitized.signatures);
        }

        if (sanitized.attackChain) {
            sanitized.attackChain = this.sanitizeAttackChain(sanitized.attackChain);
        }

        if (sanitized.targets) {
            sanitized.targets = sanitized.targets.map(t => this.sanitizeTargetEntry(t));
        }

        if (sanitized.impact) {
            sanitized.impact = this.sanitizeImpact(sanitized.impact);
        }

        return sanitized;
    }

    // ==================== 内部辅助方法 ====================

    generateReportId() {
        const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        const prefix = `BTR-${datePart}`;

        let maxSeq = 0;
        if (fs.existsSync(this.rootDir)) {
            const dirs = fs.readdirSync(this.rootDir, { withFileTypes: true })
                .filter(entry => entry.isDirectory() && entry.name.startsWith(prefix));
            for (const dir of dirs) {
                const seqMatch = dir.name.match(/-(\d{4})$/);
                if (seqMatch) {
                    const seq = parseInt(seqMatch[1], 10);
                    if (seq > maxSeq) {
                        maxSeq = seq;
                    }
                }
            }
        }

        const nextSeq = String(maxSeq + 1).padStart(4, '0');
        return `${prefix}-${nextSeq}`;
    }

    readReportRaw(reportId) {
        const id = this.normalizeReportId(reportId);
        const jsonPath = path.join(this.getReportDir(id), 'report.json');
        if (!fs.existsSync(jsonPath)) {
            this.throwNotFound(id);
        }
        try {
            return JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        } catch (error) {
            error.statusCode = error.statusCode || 500;
            error.code = error.code || 'blue_team_report_read_failed';
            throw error;
        }
    }

    writeReportJson(reportId, report) {
        const id = this.normalizeReportId(reportId);
        const jsonPath = path.join(this.getReportDir(id), 'report.json');
        this.writeFileAtomic(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
    }

    upsertReportIndex(report) {
        try {
            const reportId = report.reportId || report.id;
            const title = report.title || report.reportName || '';
            const method = report.method || (Array.isArray(report.methods) && report.methods[0]?.id) || null;
            const platform = report.target?.platform || report.platform || null;
            const overallStatus = report.overallStatus || report.status || 'draft';
            const conclusion = report.conclusion || '';
            const riskLevel = report.riskLevel || 'unknown';
            const evidenceCompleteness = report.evidenceCompleteness || 'unknown';
            const cities = Array.isArray(report.cities || report.target?.cities)
                ? JSON.stringify(report.cities || report.target?.cities)
                : null;
            const executorName = report.executor?.name || null;
            const startedAt = report.startedAt || null;
            const finishedAt = report.finishedAt || null;
            const parentReportId = report.retest?.parentReportId || null;
            const retestStatus = report.retest?.status || report.retestStatus || 'none';

            const existing = db.prepare('SELECT report_id FROM blue_team_reports WHERE report_id = ?').get(reportId);
            const now = new Date().toISOString();

            const completionScore = report.completion?.score || 0;
            const completionSummary = report.completion?.summary || '';

            if (existing) {
                db.prepare(`
                    UPDATE blue_team_reports SET
                        title = ?, method = ?, platform = ?, overall_status = ?,
                        conclusion = ?, risk_level = ?, evidence_completeness = ?,
                        cities = ?, executor_name = ?, started_at = ?, finished_at = ?,
                        updated_at = ?, parent_report_id = ?, retest_status = ?,
                        completion_score = ?, completion_summary = ?, schema_version = ?
                    WHERE report_id = ?
                `).run(title, method, platform, overallStatus, conclusion, riskLevel,
                    evidenceCompleteness, cities, executorName, startedAt, finishedAt,
                    now, parentReportId, retestStatus,
                    completionScore, completionSummary, report.schemaVersion || 'blue-team-report/v2',
                    reportId);
            } else {
                db.prepare(`
                    INSERT INTO blue_team_reports (
                        report_id, title, method, platform, overall_status,
                        conclusion, risk_level, evidence_completeness,
                        cities, executor_name, started_at, finished_at,
                        created_at, updated_at, parent_report_id, retest_status,
                        completion_score, completion_summary, schema_version
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `).run(reportId, title, method, platform, overallStatus,
                    conclusion, riskLevel, evidenceCompleteness,
                    cities, executorName, startedAt, finishedAt,
                    now, now, parentReportId, retestStatus,
                    completionScore, completionSummary, report.schemaVersion || 'blue-team-report/v2');
            }
        } catch (error) {
            console.error('upsertReportIndex failed:', error.message);
        }
    }

    indexRowToSummary(row) {
        let cities = [];
        try {
            cities = JSON.parse(row.cities || '[]');
        } catch (e) {
            cities = [];
        }
        return {
            reportId: row.report_id,
            title: row.title,
            method: row.method,
            platform: row.platform,
            overallStatus: row.overall_status,
            conclusion: row.conclusion,
            riskLevel: row.risk_level,
            riskLevelLabel: this.toRiskLabel(row.risk_level),
            evidenceCompleteness: row.evidence_completeness,
            cities,
            executorName: row.executor_name,
            startedAt: row.started_at,
            finishedAt: row.finished_at,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            parentReportId: row.parent_report_id,
            retestStatus: row.retest_status,
            completionScore: row.completion_score || 0,
            completionSummary: row.completion_summary || '',
            schemaVersion: row.schema_version || 'blue-team-report/v2',
            files: this.getRelativeFiles(row.report_id),
            downloads: this.getDownloadLinks(row.report_id),
        };
    }

    listReportsFromFile(filters = {}) {
        const limit = Math.max(1, Math.min(200, Math.floor(Number(filters.limit) || 100)));
        const offset = Math.max(0, Math.floor(Number(filters.offset) || 0));

        if (!fs.existsSync(this.rootDir)) {
            return { data: [], total: 0, limit, offset };
        }

        let reports = fs.readdirSync(this.rootDir, { withFileTypes: true })
            .filter(entry => entry.isDirectory())
            .map(entry => {
                try {
                    return this.toReportSummary(this.readReport(entry.name));
                } catch (error) {
                    return null;
                }
            })
            .filter(Boolean);

        if (filters.method) {
            reports = reports.filter(r => r.method === filters.method || (r.methods || []).includes(filters.method));
        }
        if (filters.platform) {
            reports = reports.filter(r => r.platform === filters.platform);
        }
        if (filters.overallStatus) {
            reports = reports.filter(r => r.overallStatus === filters.overallStatus);
        }
        if (filters.riskLevel) {
            reports = reports.filter(r => r.riskLevel === filters.riskLevel);
        }
        if (filters.city) {
            reports = reports.filter(r => {
                const cities = r.cities || [];
                return cities.includes(filters.city);
            });
        }

        reports.sort((left, right) => {
            const rightTime = Date.parse(right.finishedAt || right.startedAt || right.createdAt || right.updatedAt || '') || 0;
            const leftTime = Date.parse(left.finishedAt || left.startedAt || left.createdAt || left.updatedAt || '') || 0;
            return rightTime - leftTime || String(right.reportId).localeCompare(String(left.reportId));
        });

        const total = reports.length;
        const sliced = reports.slice(offset, offset + limit);
        return { data: sliced, total, limit, offset };
    }

    updateEvidenceMatrix(report, type, refPath, city) {
        if (!Array.isArray(report.evidenceMatrix)) {
            report.evidenceMatrix = [];
        }

        const existing = report.evidenceMatrix.find(e => e.type === type);
        if (existing) {
            existing.status = 'available';
            if (Array.isArray(existing.refs)) {
                if (!existing.refs.includes(refPath)) {
                    existing.refs.push(refPath);
                }
            } else {
                existing.refs = [refPath];
            }
        } else {
            report.evidenceMatrix.push({
                type,
                status: 'available',
                purpose: this.describeEvidenceType(type),
                refs: [refPath],
            });
        }
    }

    describeEvidenceType(type) {
        const descriptions = {
            'screenshot': '截图证据',
            'ocr-lines': 'OCR 识别行',
            'har-summary': 'HAR 摘要',
            'api-request': '接口请求日志',
            'outbound-evidence': '出站证据',
            'db-check': '数据库校验',
            'supervisor-event': 'AI 监督事件',
        };
        return descriptions[type] || type;
    }

    aggregateCityConclusions(report) {
        const targets = report.targets;
        if (!Array.isArray(targets) || targets.length === 0) {
            return;
        }

        const statuses = targets.map(t => t.status).filter(Boolean);
        const allPassed = statuses.length > 0 && statuses.every(s => s === 'passed');
        const anyFailed = statuses.some(s => s === 'failed');
        const anyBlocked = statuses.some(s => s === 'blocked');

        if (allPassed) {
            if (!report.conclusion) report.conclusion = 'passed';
            if (!report.overallStatus || report.overallStatus === 'draft') report.overallStatus = 'passed';
        } else if (anyBlocked) {
            if (!report.conclusion) report.conclusion = 'blocked';
            if (!report.overallStatus || report.overallStatus === 'draft') report.overallStatus = 'blocked';
        } else if (anyFailed) {
            if (!report.conclusion) report.conclusion = 'failed';
            if (!report.overallStatus || report.overallStatus === 'draft') report.overallStatus = 'failed';
        } else {
            if (!report.conclusion) report.conclusion = 'partial';
            if (!report.overallStatus || report.overallStatus === 'draft') report.overallStatus = 'partial';
        }

        const riskPriority = { critical: 4, high: 3, medium: 2, low: 1, none: 0, unknown: -1 };
        const maxRisk = targets
            .map(t => t.riskLevel)
            .reduce((max, r) => (riskPriority[r] || 0) > (riskPriority[max] || 0) ? r : max, 'none');
        if (report.riskLevel === 'unknown' || !report.riskLevel) {
            report.riskLevel = maxRisk;
            report.riskLevelLabel = this.toRiskLabel(maxRisk);
        }
    }

    computeEvidenceCompleteness(report) {
        const matrix = report.evidenceMatrix || [];
        if (matrix.length === 0) return 'missing';
        const hasFiles = this.hasActualEvidenceFiles(report.reportId || report.id);
        if (!hasFiles) return 'missing';
        const available = matrix.filter(e => e.status === 'available' || e.status === 'complete').length;
        if (available === matrix.length) return 'complete';
        if (available > 0) return 'partial';
        return 'missing';
    }
 
    hasActualEvidenceFiles(reportId) {
        try {
            const id = this.normalizeReportId(reportId);
            const evidenceDir = path.join(this.getReportDir(id), 'evidence');
            if (!fs.existsSync(evidenceDir)) {
                return false;
            }
            return this._scanDirHasFiles(evidenceDir, true);
        } catch (error) {
            return false;
        }
    }
 
    _scanDirHasFiles(dir, isRoot = false) {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.isDirectory()) {
                const subDir = path.join(dir, entry.name);
                const isEmptyScreenshots = !isRoot && entry.name === 'screenshots';
                if (isEmptyScreenshots) {
                    if (this._scanDirHasFiles(subDir)) {
                        return true;
                    }
                    continue;
                }
                if (this._scanDirHasFiles(subDir)) {
                    return true;
                }
            } else if (entry.isFile()) {
                const filePath = path.join(dir, entry.name);
                try {
                    const stat = fs.statSync(filePath);
                    if (stat.size > 0) {
                        return true;
                    }
                } catch (_) {
                    continue;
                }
            }
        }
        return false;
    }

    updateParentRetestStatus(parentReportId, childReport) {
        try {
            const parent = this.readReportRaw(parentReportId);
            if (!parent.retest) parent.retest = {};

            if (childReport.overallStatus === 'passed') {
                parent.retest.status = 'done';
                parent.retest.statusLabel = '已复测';
            } else if (childReport.overallStatus === 'failed') {
                parent.retest.status = 'done';
                parent.retest.statusLabel = '已复测（未通过）';
            } else {
                parent.retest.status = 'in-progress';
                parent.retest.statusLabel = '复测中';
            }

            parent.retestStatus = parent.retest.status;
            parent.updatedAt = new Date().toISOString();
            this.writeReportJson(parentReportId, parent);
            this.upsertReportIndex(parent);
        } catch (error) {
            console.error('updateParentRetestStatus failed:', error.message);
        }
    }

    sanitizeFilename(filename) {
        return String(filename || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 255);
    }

    sanitizeUrl(rawUrl) {
        if (!rawUrl || typeof rawUrl !== 'string') return rawUrl;
        try {
            const url = new URL(rawUrl);
            const parts = url.pathname.split('/').filter(Boolean);
            if (parts.length <= 1) {
                return `${url.host}/${parts[0] || ''}`;
            }
            const firstSegment = parts[0];
            const lastSegment = parts[parts.length - 1];
            return `${url.host}/${firstSegment}/**/${lastSegment}`;
        } catch (e) {
            return rawUrl;
        }
    }

    sanitizeTargetPath(pathname) {
        if (!pathname || typeof pathname !== 'string') return pathname;
        const parts = pathname.split('/').filter(Boolean);
        if (parts.length <= 1) return pathname;
        return `${parts[0]}/**`;
    }

    sanitizeParamKeys(keys = []) {
        if (!Array.isArray(keys)) return keys;
        const hasAuthParams = keys.some(k => SENSITIVE_PARAM_NAMES.includes(k));
        return { count: keys.length, hasAuthParams };
    }

    sanitizeHeaderKeys(keys = []) {
        if (!Array.isArray(keys)) return keys;
        return keys.filter(k => !SENSITIVE_HEADERS.includes(k.toLowerCase()));
    }

    sanitizeIp(ip) {
        if (!ip || typeof ip !== 'string') return ip;
        const match = ip.match(/^(\d+\.\d+)\.\d+\.\d+$/);
        if (match) return `${match[1]}.x.x`;
        return ip;
    }

    sanitizeCoordinates(lat, lng) {
        const sanitizeCoord = (v) => {
            const n = Number(v);
            if (!Number.isFinite(n)) return v;
            return Number(n.toFixed(2));
        };
        return { lat: sanitizeCoord(lat), lng: sanitizeCoord(lng) };
    }

    sanitizeAssets(assets = []) {
        if (!Array.isArray(assets)) return assets;
        return assets.map(a => INTERFACE_DISPLAY_MAP[a] || a);
    }

    sanitizeTarget(target = {}) {
        if (!target || typeof target !== 'object') return target;
        return {
            ...target,
            assets: this.sanitizeAssets(target.assets),
        };
    }

    sanitizeMethod(method = {}) {
        if (!method || typeof method !== 'object') return method;
        const sanitized = { ...method };
        if (Array.isArray(sanitized.evidenceRefs)) {
            sanitized.evidenceRefs = sanitized.evidenceRefs.map(ref =>
                INTERFACE_DISPLAY_MAP[ref] || ref
            );
        }
        return sanitized;
    }

    sanitizeFinding(finding = {}) {
        if (!finding || typeof finding !== 'object') return finding;
        const sanitized = { ...finding };
        if (Array.isArray(sanitized.affectedScope)) {
            sanitized.affectedScope = this.sanitizeAssets(sanitized.affectedScope);
        }
        if (sanitized.reproduction && Array.isArray(sanitized.reproduction.evidenceRefs)) {
            sanitized.reproduction = {
                ...sanitized.reproduction,
                evidenceRefs: sanitized.reproduction.evidenceRefs.map(ref => {
                    if (!ref || typeof ref !== 'object') return ref;
                    return { ...ref, label: INTERFACE_DISPLAY_MAP[ref.label] || ref.label };
                }),
            };
        }
        return sanitized;
    }

    sanitizeEvidenceEntry(entry = {}) {
        if (!entry || typeof entry !== 'object') return entry;
        const sanitized = { ...entry };
        if (Array.isArray(sanitized.refs)) {
            sanitized.refs = sanitized.refs.map(ref => INTERFACE_DISPLAY_MAP[ref] || ref);
        }
        return sanitized;
    }

    sanitizeExecutor(executor = {}) {
        if (!executor || typeof executor !== 'object') return executor;
        const sanitized = { ...executor };
        if (sanitized.node) {
            sanitized.node = this.sanitizeIp(sanitized.node);
        }
        return sanitized;
    }

    sanitizeTargetEntry(target = {}) {
        if (!target || typeof target !== 'object') return target;
        const sanitized = { ...target };
        if (sanitized.targetLocation) {
            const coords = this.sanitizeCoordinates(
                sanitized.targetLocation.lat,
                sanitized.targetLocation.lng
            );
            sanitized.targetLocation = { ...sanitized.targetLocation, ...coords };
        }
        return sanitized;
    }

    sanitizeImpact(impact = {}) {
        if (!impact || typeof impact !== 'object') return impact;
        const sanitized = { ...impact };
        if (Array.isArray(sanitized.affectedAssets)) {
            sanitized.affectedAssets = this.sanitizeAssets(sanitized.affectedAssets);
        }
        return sanitized;
    }

    // ==================== v3 三核结构方法 ====================

    compatV2Report(report) {
        if (!report || report.schemaVersion === 'blue-team-report/v3') return report;

        const compat = { ...report, schemaVersion: 'blue-team-report/v3' };

        // 迁移 overallStatus → completion
        if (!compat.completion) {
            const conclusionText = compat.conclusion || '';
            const summaryText = conclusionText
                ? conclusionText.split(/[。！？\n]/)[0].trim()
                : '';
            compat.completion = {
                overall: compat.overallStatus || 'unknown',
                score: 0,
                riskLevel: compat.riskLevel || 'unknown',
                evidenceCompleteness: compat.evidenceCompleteness || 'unknown',
                summary: summaryText || '旧版报告无评分',
                conclusion: conclusionText,
            };
        }

        // 迁移 executor → infra
        if (!compat.infra && compat.executor) {
            compat.infra = { executor: compat.executor };
        } else if (!compat.infra) {
            compat.infra = {};
        }

        // 旧版无 attackChain，生成空结构
        if (!compat.attackChain) {
            compat.attackChain = {
                summary: '旧版报告未记录攻击路径',
                steps: [],
            };
        }

        // 旧版无 metrics，从 dataQuality 映射
        if (!compat.metrics) {
            const dq = compat.dataQuality || compat.quality || {};
            compat.metrics = {
                stationCount: dq.totalStations || dq.stationCount || 0,
                distinctCount: dq.distinctCount || 0,
                addressCompleteRate: dq.addressCompleteness || dq.addressCompleteRate || 0,
                priceCompleteRate: dq.priceCompleteness || dq.priceCompleteRate || 0,
                cityMatchRate: dq.cityMatchRate || 0,
                dataFreshness: dq.dataFreshness || '',
            };
        }

        // 旧版无 signatures
        if (!compat.signatures) {
            compat.signatures = {};
        }

        // 旧版无 resourceStats
        if (!compat.resourceStats) {
            compat.resourceStats = {};
        }

        // findings 补充 attackStepRef
        if (Array.isArray(compat.findings)) {
            compat.findings = compat.findings.map(f => ({
                ...f,
                attackStepRef: f.attackStepRef || null,
            }));
        }

        // evidenceMatrix 补充 attackStepRef
        if (Array.isArray(compat.evidenceMatrix)) {
            compat.evidenceMatrix = compat.evidenceMatrix.map(e => ({
                ...e,
                attackStepRef: e.attackStepRef || null,
            }));
        }

        return compat;
    }

    computeCompletionScore(report) {
        const targets = Array.isArray(report.targets) ? report.targets : [];
        const evidenceMatrix = Array.isArray(report.evidenceMatrix) ? report.evidenceMatrix : [];
        const totalCities = targets.length;

        if (totalCities === 0) return 0;

        // 目标完成率：status为passed的城市数 / 总城市数
        const passedCities = targets.filter(t => t.status === 'passed').length;
        const targetCompletionRate = passedCities / totalCities;

        // 证据完整率：有证据矩阵条目且状态非missing的目标数 / 总目标数
        const evidenceWithStatus = evidenceMatrix.filter(
            e => e.status && e.status !== 'missing'
        ).length;
        const totalEvidence = evidenceMatrix.length;
        const evidenceCompleteRate = totalEvidence > 0
            ? evidenceWithStatus / totalEvidence
            : 0;

        // 城市覆盖率：有有效数据(metrics.requests > 0)的城市数 / 总城市数
        const citiesWithData = targets.filter(
            t => t.metrics && (t.metrics.requests || 0) > 0
        ).length;
        const cityCoverageRate = citiesWithData / totalCities;

        const score = Math.round(
            (targetCompletionRate * 0.5 + evidenceCompleteRate * 0.3 + cityCoverageRate * 0.2) * 100
        );

        return Math.max(0, Math.min(100, score));
    }

    computeMetrics(report) {
        const targets = Array.isArray(report.targets) ? report.targets : [];
        const dataQuality = report.dataQuality || report.quality || {};

        let totalRequests = 0;
        let totalSuccess = 0;
        let totalFailed = 0;
        let totalMismatch = 0;

        for (const t of targets) {
            const m = t.metrics || {};
            totalRequests += m.requests || 0;
            totalSuccess += m.success || 0;
            totalFailed += m.failed || 0;
            totalMismatch += m.cityMismatch || 0;
        }

        const stationCount = dataQuality.totalStations || dataQuality.stationCount || totalSuccess;
        const distinctCount = dataQuality.distinctCount || 0;
        const addressCompleteRate = dataQuality.addressCompleteness || dataQuality.addressCompleteRate || 0;
        const priceCompleteRate = dataQuality.priceCompleteness || dataQuality.priceCompleteRate || 0;

        const cities = report.cities || report.target?.cities || [];
        const cityMatchRate = totalRequests > 0 && cities.length > 0
            ? Math.round(((totalRequests - totalMismatch) / totalRequests) * 100)
            : (dataQuality.cityMatchRate || 0);

        const dataFreshness = dataQuality.dataFreshness
            || report.finishedAt
            || report.updatedAt
            || '';

        return {
            stationCount,
            distinctCount,
            addressCompleteRate,
            priceCompleteRate,
            cityMatchRate,
            dataFreshness,
        };
    }

    computeResourceStats(report) {
        const startedAt = report.startedAt;
        const finishedAt = report.finishedAt;

        // 计算耗时
        let duration = '';
        if (startedAt && finishedAt) {
            const startMs = Date.parse(startedAt);
            const endMs = Date.parse(finishedAt);
            if (!isNaN(startMs) && !isNaN(endMs) && endMs > startMs) {
                const diffMs = endMs - startMs;
                const diffMins = Math.floor(diffMs / 60000);
                const hours = Math.floor(diffMins / 60);
                const mins = diffMins % 60;
                duration = hours > 0
                    ? (mins > 0 ? hours + 'h' + mins + 'm' : hours + 'h')
                    : mins + 'm';
            }
        }

        // 从 targets 聚合请求数据
        const targets = Array.isArray(report.targets) ? report.targets : [];
        let totalRequests = 0;
        let successRequests = 0;
        let failedRequests = 0;
        const statusCodeDistribution = {};
        const proxyDistribution = {};

        for (const t of targets) {
            const m = t.metrics || {};
            totalRequests += m.requests || 0;
            successRequests += m.success || 0;
            failedRequests += m.failed || 0;
        }

        // 如果有 outbound evidence，尝试解析状态码分布
        try {
            const id = this.normalizeReportId(report.reportId || report.id);
            const outboundPath = path.join(this.getReportDir(id), 'evidence', 'outbound-evidence.jsonl');
            if (fs.existsSync(outboundPath)) {
                const lines = fs.readFileSync(outboundPath, 'utf8').split('\n').filter(Boolean);
                for (const line of lines) {
                    try {
                        const entry = JSON.parse(line);
                        const code = entry.statusCode || entry.status;
                        if (code) {
                            const codeKey = String(code);
                            statusCodeDistribution[codeKey] = (statusCodeDistribution[codeKey] || 0) + 1;
                        }
                        const proxyType = entry.proxyType || 'direct';
                        proxyDistribution[proxyType] = (proxyDistribution[proxyType] || 0) + 1;
                    } catch (_) {
                        // skip malformed lines
                    }
                }
            }
        } catch (_) {
            // report dir may not exist
        }

        // 如果没有出站证据的状态码分布，用 targets 聚合
        if (Object.keys(statusCodeDistribution).length === 0 && totalRequests > 0) {
            if (successRequests > 0) statusCodeDistribution['200'] = successRequests;
            if (failedRequests > 0) statusCodeDistribution['501'] = failedRequests;
        }

        if (Object.keys(proxyDistribution).length === 0) {
            proxyDistribution['direct'] = totalRequests;
        }

        // 统计证据文件
        let evidenceFileCount = 0;
        const evidenceFileHashes = [];
        try {
            const id = this.normalizeReportId(report.reportId || report.id);
            const evidenceDir = path.join(this.getReportDir(id), 'evidence');
            if (fs.existsSync(evidenceDir)) {
                const files = this._listAllFiles(evidenceDir, evidenceDir);
                evidenceFileCount = files.length;
                for (const filePath of files) {
                    try {
                        const crypto = require('crypto');
                        const content = fs.readFileSync(filePath);
                        const hash = crypto.createHash('sha256').update(content).digest('hex');
                        evidenceFileHashes.push({
                            filename: path.relative(evidenceDir, filePath),
                            sha256: hash.slice(0, 8),
                        });
                    } catch (_) {
                        // skip unreadable files
                    }
                }
            }
        } catch (_) {
            // evidence dir may not exist
        }

        return {
            duration,
            totalRequests,
            successRequests,
            failedRequests,
            statusCodeDistribution,
            proxyDistribution,
            evidenceFileCount,
            evidenceFileHashes,
        };
    }

    _listAllFiles(dir, baseDir) {
        const results = [];
        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    results.push(...this._listAllFiles(fullPath, baseDir));
                } else if (entry.isFile()) {
                    results.push(fullPath);
                }
            }
        } catch (_) {
            // skip unreadable dirs
        }
        return results;
    }

    sanitizeAttackChain(attackChain) {
        if (!attackChain || typeof attackChain !== 'object') return attackChain;
        const sanitized = { ...attackChain };

        if (Array.isArray(sanitized.steps)) {
            sanitized.steps = sanitized.steps.map(step => {
                if (!step || typeof step !== 'object') return step;
                const s = { ...step };

                // description 中URL脱敏：只展示操作类别，不展示具体URL/参数
                if (typeof s.description === 'string') {
                    s.description = this._sanitizeDescription(s.description);
                }

                // result 中接口名用 INTERFACE_DISPLAY_MAP 映射
                if (typeof s.result === 'string') {
                    s.result = this._sanitizeInterfaceNames(s.result);
                }

                // evidenceRefs 路径脱敏
                if (Array.isArray(s.evidenceRefs)) {
                    s.evidenceRefs = s.evidenceRefs.map(ref =>
                        INTERFACE_DISPLAY_MAP[ref] || ref
                    );
                }

                // authEntry 中 authParams.names 脱敏
                if (s.authEntry && s.authEntry.authParams) {
                    s.authEntry = {
                        ...s.authEntry,
                        authParams: this._sanitizeAuthParams(s.authEntry.authParams),
                    };
                }

                // dataAccess 中 interfaceList 脱敏
                if (s.dataAccess && Array.isArray(s.dataAccess.interfaceList)) {
                    s.dataAccess = {
                        ...s.dataAccess,
                        interfaceList: s.dataAccess.interfaceList.map(iface => ({
                            ...iface,
                            name: INTERFACE_DISPLAY_MAP[iface.name] || iface.name,
                            url: iface.url ? this.sanitizeUrl(iface.url) : iface.url,
                        })),
                    };
                }

                return s;
            });
        }

        return sanitized;
    }

    sanitizeSignatures(signatures) {
        if (!signatures || typeof signatures !== 'object') return signatures;
        const sanitized = { ...signatures };

        // authParams：脱敏模式下仅保留 count 和 hasAuth，移除 names
        if (sanitized.authParams && typeof sanitized.authParams === 'object') {
            sanitized.authParams = this._sanitizeAuthParams(sanitized.authParams);
        }

        // proxy.address 不展示
        if (sanitized.proxy && sanitized.proxy.address) {
            sanitized.proxy = { ...sanitized.proxy, address: undefined };
        }

        return sanitized;
    }

    sanitizeInfra(infra) {
        if (!infra || typeof infra !== 'object') return infra;
        const sanitized = { ...infra };

        // executor.node IP脱敏
        if (sanitized.executor && sanitized.executor.node) {
            sanitized.executor = {
                ...sanitized.executor,
                node: this.sanitizeIp(sanitized.executor.node),
            };
        }

        // proxy.address 不展示
        if (sanitized.proxy && sanitized.proxy.address) {
            sanitized.proxy = { ...sanitized.proxy, address: undefined };
        }

        return sanitized;
    }

    _sanitizeDescription(text) {
        if (!text || typeof text !== 'string') return text;
        // URL脱敏：保留域名+一级路径，后续用**替代
        let result = text.replace(
            /https?:\/\/[^\s"'<>]+/g,
            (url) => this.sanitizeUrl(url)
        );
        // 域名脱敏（不以http开头的裸域名带路径）
        result = result.replace(
            /([a-z0-9][a-z0-9-]*\.)+[a-z]{2,}(\/[^\s"'<>]+)?/g,
            (match) => {
                if (!match.includes('/')) return match;
                const parts = match.split('/');
                const host = parts[0];
                const pathParts = parts.slice(1).filter(Boolean);
                if (pathParts.length > 0) {
                    return host + '/' + pathParts[0] + '/**';
                }
                return host;
            }
        );
        // 参数脱敏：移除 key=value 形式的参数值
        result = result.replace(/([a-zA-Z_]\w*)=([^\s&"'<>,;)]+)/g, '$1=**');
        // 认证参数名脱敏：移除已知敏感参数名
        for (const param of SENSITIVE_PARAM_NAMES) {
            const re = new RegExp('\\b' + param + '\\b', 'gi');
            result = result.replace(re, '**');
        }
        return result;
    }

    sanitizeUrl(url) {
        if (!url || typeof url !== 'string') return url;
        try {
            // 提取 protocol://host 和一级路径
            const protoMatch = url.match(/^(https?:\/\/[^/]+)/);
            if (!protoMatch) return url;
            const hostPart = protoMatch[1];
            const rest = url.slice(protoMatch[0].length);
            // 取一级路径
            const pathParts = rest.split('/').filter(Boolean);
            if (pathParts.length === 0) return hostPart + '/';
            const firstPath = pathParts[0];
            return hostPart + '/' + firstPath + '/**';
        } catch (_) {
            return url;
        }
    }

    _sanitizeInterfaceNames(text) {
        if (!text || typeof text !== 'string') return text;
        let result = text;
        for (const [key, display] of Object.entries(INTERFACE_DISPLAY_MAP)) {
            result = result.replace(new RegExp(key, 'g'), display);
        }
        // 去重映射后可能出现的"接口接口"重复
        result = result.replace(/接口接口/g, '接口');
        // 认证参数名脱敏
        for (const param of SENSITIVE_PARAM_NAMES) {
            const re = new RegExp('\\b' + param + '\\b', 'gi');
            result = result.replace(re, '**');
        }
        return result;
    }

    _sanitizeAuthParams(authParams) {
        if (!authParams || typeof authParams !== 'object') return authParams;
        return {
            count: authParams.count || 0,
            hasAuth: !!authParams.hasAuth,
        };
    }


    compatV1Report(report) {
        if (!report || report.schemaVersion === 'blue-team-report/v2') return report;

        const compat = { ...report };
        compat.schemaVersion = 'blue-team-report/v2';

        if (!Array.isArray(compat.events)) {
            compat.events = [];
        }

        if (!Array.isArray(compat.targets)) {
            const cities = compat.cities || compat.target?.cities || [];
            compat.targets = cities.map(city => ({
                city,
                landmarks: [],
                status: 'unknown',
                riskLevel: 'unknown',
                metrics: { requests: 0, success: 0, failed: 0, cityMismatch: 0 },
            }));
        }

        if (compat.retestStatus && (!compat.retest || typeof compat.retest !== 'object' || !compat.retest.status)) {
            compat.retest = {
                status: compat.retestStatus || 'none',
                statusLabel: compat.retestStatusLabel || RETEST_STATUS_LABEL_MAP[compat.retestStatus] || compat.retestStatus,
                criteria: (compat.retest && compat.retest.criteria) || [],
                parentReportId: null,
                childReportId: null,
            };
        }

        if (Array.isArray(compat.evidenceMatrix)) {
            compat.evidenceMatrix = compat.evidenceMatrix.map(e => {
                if (e.refs && Array.isArray(e.refs)) {
                    return { ...e, _legacy: true };
                }
                return e;
            });
        }

        return compat;
    }

    // ==================== 原有方法 ====================

    listReportsLegacy(options = {}) {
        const limit = Math.max(1, Math.min(200, Math.floor(Number(options.limit) || 100)));
        if (!fs.existsSync(this.rootDir)) {
            return [];
        }

        return fs.readdirSync(this.rootDir, { withFileTypes: true })
            .filter(entry => entry.isDirectory())
            .map(entry => {
                try {
                    return this.toReportSummary(this.readReport(entry.name));
                } catch (error) {
                    return null;
                }
            })
            .filter(Boolean)
            .sort((left, right) => {
                const rightTime = Date.parse(right.finishedAt || right.startedAt || right.createdAt || right.updatedAt || '') || 0;
                const leftTime = Date.parse(left.finishedAt || left.startedAt || left.createdAt || left.updatedAt || '') || 0;
                return rightTime - leftTime || String(right.reportId).localeCompare(String(left.reportId));
            })
            .slice(0, limit);
    }

    readReport(reportId) {
        const id = this.normalizeReportId(reportId);
        const jsonPath = this.getReportFilePath(id, 'report.json');
        if (!fs.existsSync(jsonPath)) {
            this.throwNotFound(id);
        }

        try {
            const report = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
            const v1Compat = this.compatV1Report(report);
            return this.decorateReport(this.compatV2Report(v1Compat));
        } catch (error) {
            error.statusCode = error.statusCode || 500;
            error.code = error.code || 'blue_team_report_read_failed';
            throw error;
        }
    }

    writeReport(report, options = {}) {
        const normalized = this.normalizeReport(report);
        const reportDir = this.getReportDir(normalized.reportId);
        if (fs.existsSync(reportDir) && options.overwrite === false) {
            const error = new Error(`blue-team report already exists: ${normalized.reportId}`);
            error.statusCode = 409;
            error.code = 'blue_team_report_exists';
            throw error;
        }

        fs.mkdirSync(reportDir, { recursive: true });
        this.writeFileAtomic(
            path.join(reportDir, 'report.json'),
            `${JSON.stringify(normalized, null, 2)}\n`
        );
        this.writeFileAtomic(
            path.join(reportDir, 'report.md'),
            this.generateMarkdown(normalized)
        );

        this.upsertReportIndex(normalized);

        return this.decorateReport(normalized);
    }

    ensureSeedReport(options = {}) {
        const seed = this.buildSeedReport();
        const reportDir = this.getReportDir(seed.reportId);
        const exists = fs.existsSync(path.join(reportDir, 'report.json'));

        if (exists && options.overwrite !== true) {
            const report = this.readReport(seed.reportId);
            this.ensureMarkdown(report);
            return {
                created: false,
                report: this.readReport(seed.reportId),
                files: this.getRelativeFiles(seed.reportId)
            };
        }

        const report = this.writeReport(seed, { overwrite: true });
        return {
            created: !exists,
            report,
            files: this.getRelativeFiles(seed.reportId)
        };
    }

    getDownload(reportId, format = 'json', options = {}) {
        const id = this.normalizeReportId(reportId);
        const normalizedFormat = this.normalizeDownloadFormat(format);
        const sanitize = options.sanitize !== false;
        if (normalizedFormat === 'markdown' && !sanitize) {
            return {
                format: normalizedFormat,
                filename: `${id}.md`,
                contentType: 'text/markdown; charset=utf-8',
                content: this.generateMarkdown(this.readReport(id), { sanitize: false })
            };
        }
        const fileName = normalizedFormat === 'markdown' ? 'report.md' : 'report.json';
        const filePath = this.getReportFilePath(id, fileName);

        if (!fs.existsSync(filePath) && normalizedFormat === 'markdown') {
            this.ensureMarkdown(this.readReport(id));
        }
        if (!fs.existsSync(filePath)) {
            this.throwNotFound(id);
        }

        return {
            format: normalizedFormat,
            filename: normalizedFormat === 'markdown' ? `${id}.md` : `${id}.json`,
            contentType: normalizedFormat === 'markdown'
                ? 'text/markdown; charset=utf-8'
                : 'application/json; charset=utf-8',
            content: fs.readFileSync(filePath, 'utf8')
        };
    }

    normalizeReport(rawReport = {}) {
        const now = new Date().toISOString();
        const reportId = this.normalizeReportId(rawReport.reportId || rawReport.id);
        const target = rawReport.target && typeof rawReport.target === 'object'
            ? rawReport.target
            : {};
        const methods = Array.isArray(rawReport.methods) ? rawReport.methods : [];
        const findings = Array.isArray(rawReport.findings) ? rawReport.findings : [];
        const evidenceMatrix = Array.isArray(rawReport.evidenceMatrix) ? rawReport.evidenceMatrix : [];
        const recommendations = Array.isArray(rawReport.recommendations) ? rawReport.recommendations : [];

        return {
            schemaVersion: rawReport.schemaVersion || 'blue-team-report/v1',
            reportId,
            reportName: String(rawReport.reportName || rawReport.title || '').trim() || reportId,
            title: String(rawReport.title || rawReport.reportName || '').trim() || reportId,
            createdAt: rawReport.createdAt || rawReport.startedAt || now,
            startedAt: rawReport.startedAt || rawReport.createdAt || now,
            finishedAt: rawReport.finishedAt || null,
            updatedAt: now,
            executor: rawReport.executor || null,
            target,
            scope: rawReport.scope || target.scope || '',
            methods,
            overallStatus: rawReport.overallStatus || rawReport.status || 'draft',
            conclusion: rawReport.conclusion || '',
            riskLevel: rawReport.riskLevel || 'unknown',
            riskLevelLabel: rawReport.riskLevelLabel || this.toRiskLabel(rawReport.riskLevel),
            impact: rawReport.impact || null,
            findings,
            evidenceMatrix,
            recommendations,
            retest: rawReport.retest || {
                status: rawReport.retestStatus || 'pending',
                statusLabel: rawReport.retestStatusLabel || '待复测',
                criteria: []
            },
            retestStatus: rawReport.retestStatus || rawReport.retest?.status || 'pending',
            evidenceCompleteness: rawReport.evidenceCompleteness || 'unknown',
            audit: {
                ...(rawReport.audit || {}),
                generatedBy: rawReport.audit?.generatedBy || 'BlueTeamReportService'
            }
        };
    }

    decorateReport(report = {}) {
        const reportId = this.normalizeReportId(report.reportId || report.id);
        return {
            ...report,
            reportId,
            operationView: report.operationView || this.buildOperationView(report),
            files: this.getRelativeFiles(reportId),
            downloads: this.getDownloadLinks(reportId)
        };
    }

    toReportSummary(report = {}) {
        const methodNames = Array.isArray(report.methods)
            ? report.methods.map(item => item.name || item.id).filter(Boolean)
            : [];
        const target = report.target || {};
        return {
            reportId: report.reportId,
            reportName: report.reportName || report.title,
            title: report.title || report.reportName,
            createdAt: report.createdAt || null,
            startedAt: report.startedAt || null,
            finishedAt: report.finishedAt || null,
            updatedAt: report.updatedAt || null,
            target: target.name || report.targetName || '',
            scope: report.scope || target.scope || '',
            platform: target.platform || report.platform || '',
            methods: methodNames,
            method: methodNames.join(' / '),
            overallStatus: report.overallStatus || '',
            conclusion: report.conclusion || '',
            riskLevel: report.riskLevel || '',
            riskLevelLabel: report.riskLevelLabel || this.toRiskLabel(report.riskLevel),
            retestStatus: report.retestStatus || report.retest?.status || '',
            evidenceCompleteness: report.evidenceCompleteness || '',
            findingCount: Array.isArray(report.findings) ? report.findings.length : 0,
            operationView: report.operationView || this.buildOperationView(report),
            files: report.files || this.getRelativeFiles(report.reportId),
            downloads: report.downloads || this.getDownloadLinks(report.reportId)
        };
    }

    arrayValue(value) {
        if (Array.isArray(value)) return value.filter(item => item !== undefined && item !== null && item !== '');
        if (value === undefined || value === null || value === '') return [];
        return [value];
    }

    firstText(...values) {
        for (const value of values) {
            if (Array.isArray(value) && value.length > 0) return value.join('、');
            if (value !== undefined && value !== null && String(value).trim()) return String(value);
        }
        return '';
    }

    normalizeOperationStatus(value) {
        const text = String(value || '').toLowerCase();
        if (/success|done|pass|passed|完成|通过/.test(text)) return '完成';
        if (/partial|部分|warning|pending|running|执行|处理中/.test(text)) return '部分完成';
        if (/fail|failed|error|blocked|missing|失败|阻塞|缺失/.test(text)) return '未完成';
        return value ? String(value) : '待确认';
    }

    buildOperationView(report = {}) {
        const targetCompletion = this.buildTargetCompletion(report);
        const resources = this.buildOperationResources(report);
        const attackPath = this.buildOperationAttackPath(report);
        const problemCause = this.buildProblemCause(report, targetCompletion);
        const recommendedActions = this.buildRecommendedActions(report, problemCause);
        return {
            conclusion: this.firstText(report.conclusion, targetCompletion.actual),
            targetCompletion,
            resources,
            attackPath,
            problemCause,
            recommendedActions,
        };
    }

    buildTargetCompletion(report = {}) {
        const target = report.target || {};
        const targets = Array.isArray(report.targets) ? report.targets : [];
        const completed = targets.filter(item => /success|done|pass|完成|通过/i.test(String(item.status || ''))).length;
        const failedTargets = targets
            .filter(item => !/success|done|pass|完成|通过/i.test(String(item.status || '')))
            .map(item => ({
                name: item.city || item.name || item.target || '未命名目标',
                status: this.normalizeOperationStatus(item.status),
                reason: item.reason || item.error || item.conclusion || '',
            }));
        const total = targets.length || this.arrayValue(report.cities || target.cities).length || 1;
        const status = failedTargets.length === 0 && (completed > 0 || /success|done|pass|完成|通过/i.test(String(report.overallStatus || '')))
            ? '完成'
            : this.normalizeOperationStatus(report.overallStatus || report.conclusion);
        return {
            target: this.firstText(target.name, report.scope, report.reportName),
            expected: this.firstText(report.expectedResult, target.expectedResult, '完成授权蓝军测试并形成可复核证据'),
            actual: this.firstText(report.conclusion, report.completion?.summary, report.overallStatus),
            status,
            percent: failedTargets.length === 0 && status === '完成' ? 100 : Math.round((completed / total) * 100),
            failedTargets,
        };
    }

    buildOperationResources(report = {}) {
        const target = report.target || {};
        const stats = report.resourceStats || report.metrics || {};
        const evidenceFiles = report.files?.evidence || {};
        const evidenceFileCount = stats.evidenceFileCount
            ?? Object.values(evidenceFiles).reduce((count, value) => count + (Array.isArray(value) ? value.length : (value ? 1 : 0)), 0);
        return {
            executionNode: this.firstText(report.executor?.node, report.infra?.executor?.node, report.executor?.name, report.infra?.executor?.name),
            platform: this.firstText(report.platform, target.platform),
            cities: this.arrayValue(report.cities || target.cities),
            assets: this.arrayValue(target.assets || report.assets),
            requestCount: stats.totalRequests ?? stats.requests ?? report.targets?.reduce((sum, item) => sum + Number(item.metrics?.requests || 0), 0) ?? 0,
            evidenceFileCount,
            captureResource: this.firstText(stats.captureSessionId, report.captureSessionId, report.files?.har, report.files?.markdown),
            outboundResource: this.firstText(stats.proxyLabel, report.infra?.proxy?.type, report.proxy?.label, '出站证据'),
        };
    }

    buildOperationAttackPath(report = {}) {
        const steps = Array.isArray(report.attackChain?.steps) ? report.attackChain.steps : [];
        if (steps.length > 0) {
            return steps.map((step, index) => ({
                order: index + 1,
                phase: this.firstText(step.phase, step.type, `阶段 ${index + 1}`),
                action: this.firstText(step.action, step.description, step.title, step.name),
                result: this.firstText(step.result, step.output, step.status),
                evidenceRefs: this.arrayValue(step.evidenceRefs || step.refs),
            }));
        }
        const methods = Array.isArray(report.methods) ? report.methods : [];
        if (methods.length > 0) {
            return methods.map((method, index) => ({
                order: index + 1,
                phase: this.firstText(method.name, method.id, `方式 ${index + 1}`),
                action: this.firstText(method.principle, method.description, '执行蓝军测试方式'),
                result: this.normalizeOperationStatus(method.status),
                evidenceRefs: this.arrayValue(method.evidenceRefs),
            }));
        }
        return [{
            order: 1,
            phase: '报告生成',
            action: '生成蓝军测试报告',
            result: this.firstText(report.conclusion, report.overallStatus, '待补充攻击路径'),
            evidenceRefs: this.arrayValue(report.files?.markdown || report.files?.json),
        }];
    }

    buildProblemCause(report = {}, targetCompletion = {}) {
        const findings = Array.isArray(report.findings) ? report.findings : [];
        const missingEvidence = /missing|缺失/i.test(String(report.evidenceCompleteness || ''));
        const firstFinding = findings[0] || {};
        const failedTarget = targetCompletion.failedTargets && targetCompletion.failedTargets[0];
        return {
            type: this.firstText(firstFinding.category, firstFinding.type, missingEvidence ? '证据缺失' : '', failedTarget ? '目标未完成' : '', '待复核'),
            summary: this.firstText(firstFinding.title, firstFinding.reason, failedTarget?.reason, report.completion?.summary, report.conclusion, '当前报告未给出明确根因，需要结合证据中心复核'),
            failurePoint: this.firstText(firstFinding.location, firstFinding.step, failedTarget?.name, report.retest?.statusLabel),
            evidenceGap: missingEvidence ? '报告标记证据缺失或证据不完整' : this.firstText(firstFinding.evidenceGap, report.evidenceCompleteness),
            impact: this.firstText(firstFinding.impact, report.impact?.summary, report.impact?.businessImpact, report.riskLevelLabel || report.riskLevel),
        };
    }

    buildRecommendedActions(report = {}, problemCause = {}) {
        const recommendations = Array.isArray(report.recommendations) ? report.recommendations : [];
        if (recommendations.length > 0) {
            return recommendations.map((item, index) => ({
                id: item.id || `A-${index + 1}`,
                priority: item.priority || 'P1',
                action: item.action || item.title || item.desc || '',
                owner: item.owner || '业务运营 / 安全接口人',
                validation: item.verification || item.criteria || '复测报告状态更新为完成，证据中心可复核',
            }));
        }
        return [{
            id: 'A-1',
            priority: /高|high/i.test(String(report.riskLevelLabel || report.riskLevel || '')) ? 'P0' : 'P1',
            action: problemCause.summary || '补充测试证据并复核未完成目标',
            owner: '业务运营 / 安全接口人',
            validation: '完成复测并生成包含目标完成情况、使用资源、攻击路径和问题原因的报告',
        }];
    }

    buildSeedReport() {
        return {
            schemaVersion: 'blue-team-report/v1',
            reportId: DEFAULT_SEED_REPORT_ID,
            reportName: '多城市场站数据暴露风险验证报告',
            title: '多城市场站数据暴露风险验证报告',
            createdAt: '2026-05-31T23:40:00+08:00',
            startedAt: '2026-05-31T22:10:00+08:00',
            finishedAt: '2026-05-31T23:40:00+08:00',
            executor: {
                name: '系统任务'
            },
            target: {
                name: '滴滴充电场站数据能力',
                platform: 'didi-charging',
                businessLine: '充电场站数据',
                scope: '武汉、南京、苏州、桂林 / 半径 20km',
                cities: ['武汉', '南京', '苏州', '桂林'],
                radiusKm: 20,
                assets: ['stationList', 'getoneinfo', 'SQLite stations']
            },
            scope: '武汉、南京、苏州、桂林 / 半径 20km',
            methods: [
                {
                    id: 'business-request',
                    name: '业务请求验证',
                    status: 'partial',
                    principle: '通过内置录包服务和小程序窗口复核实际业务请求，验证业务包来源、请求参数和页面侧证据是否完整。',
                    evidenceRefs: ['capture-recorder-status', 'business-har-pending']
                },
                {
                    id: 'traffic-template',
                    name: '自动化采集验证',
                    status: 'partial',
                    principle: '通过已学习模板 API、城市/地标定位和数据库校验复核多城市场站数据链路。',
                    evidenceRefs: ['stationList', 'getoneinfo', 'sqlite-check']
                }
            ],
            overallStatus: 'partial',
            conclusion: '部分通过，待复测',
            riskLevel: 'medium',
            riskLevelLabel: '中',
            evidenceCompleteness: 'partial',
            impact: {
                summary: '多城市场站数据链路已有部分接口和入库证据，但业务请求验证和失败城市证据仍不完整，当前结论不能直接升级为完全通过。',
                affectedAssets: ['业务请求验证页面窗口', 'HAR / 录包服务', '签名模板', '场站列表与详情数据'],
                exposure: '若未补齐业务请求证据，无法证明测试结论来自真实小程序业务包；若模板签名问题未复测，苏州、桂林等城市的数据完整性仍存在不确定性。',
                businessImpact: '影响安全报告可复核性、跨城市数据质量判定和后续修复闭环优先级。'
            },
            findings: [
                {
                    id: 'M-001',
                    title: '业务请求验证证据不完整',
                    severity: 'medium',
                    severityLabel: '中风险',
                    status: 'pending-retest',
                    affectedScope: ['小程序窗口', '页面截图', '业务 HAR'],
                    impact: '无法完整证明报告结论来自真实业务请求链路，影响渗透测试报告归档可信度。',
                    reproduction: {
                        steps: [
                            '打开安全报告详情页，检查业务请求验证证据矩阵。',
                            '核对内置录包服务状态和业务 HAR 产物。',
                            '比对页面截图、HAR 摘要和数据库校验结果是否同源。'
                        ],
                        evidenceRefs: [
                            {
                                type: 'screenshot',
                                label: '小程序窗口 / 页面截图',
                                status: 'missing',
                                path: ''
                            },
                            {
                                type: 'har',
                                label: '业务 HAR',
                                status: 'pending',
                                path: ''
                            }
                        ]
                    },
                    recommendation: '补齐小程序业务窗口截图、录包会话 HAR、请求摘要和数据库核对结果，并在报告中保持证据与结论分离。',
                    retestStatus: 'pending'
                },
                {
                    id: 'M-002',
                    title: '签名模板待复测',
                    severity: 'medium',
                    severityLabel: '中风险',
                    status: 'pending-retest',
                    affectedScope: ['苏州', '桂林', '签名模板', '自动化采集验证'],
                    impact: '失败城市可能由模板签名或目标参数不匹配导致，当前无法判断是目标平台风险、模板过期还是环境问题。',
                    reproduction: {
                        steps: [
                            '使用目标城市和半径重新执行自动化采集验证。',
                            '观察 stationList / getoneinfo 请求是否出现 signed_template_target_mismatch。',
                            '对失败城市单独保存请求摘要、响应摘要和代理出口状态。'
                        ],
                        evidenceRefs: [
                            {
                                type: 'api-log',
                                label: 'signed_template_target_mismatch',
                                status: 'partial',
                                path: 'data/outbound-evidence/'
                            }
                        ]
                    },
                    recommendation: '重新通过 HAR 学习或复核签名模板，失败城市需独立记录请求预算、代理出口、响应摘要和参数差异。',
                    retestStatus: 'pending'
                },
                {
                    id: 'L-001',
                    title: '武汉、南京自动化采集验证已形成可复核证据',
                    severity: 'low',
                    severityLabel: '已验证',
                    status: 'passed',
                    affectedScope: ['武汉', '南京', 'stationList', 'getoneinfo', 'SQLite'],
                    impact: '已能支撑部分通过结论，但仍需与业务请求验证证据合并归档。',
                    reproduction: {
                        steps: [
                            '复核 stationList / getoneinfo 请求摘要。',
                            '核对 SQLite 入库记录和城市范围。',
                            '确认报告字段与证据矩阵一致。'
                        ],
                        evidenceRefs: [
                            {
                                type: 'database',
                                label: 'SQLite stations',
                                status: 'partial',
                                path: 'data/stations.db'
                            }
                        ]
                    },
                    recommendation: '保留武汉、南京作为正向样本，后续复测时与失败城市同一报告口径聚合。',
                    retestStatus: 'passed'
                }
            ],
            evidenceMatrix: [
                {
                    type: '业务请求验证预检',
                    status: 'partial',
                    purpose: '定位环境权限、窗口识别、截图授权问题',
                    refs: ['小程序窗口 / 页面截图']
                },
                {
                    type: 'HAR / 录包服务',
                    status: 'partial',
                    purpose: '证明小程序实际业务包来源',
                    refs: ['capture-recorder-status', 'business-har-pending']
                },
                {
                    type: '自动化采集验证接口日志',
                    status: 'partial',
                    purpose: '复核 stationList / getoneinfo 响应状态',
                    refs: ['stationList', 'getoneinfo']
                },
                {
                    type: '数据库校验',
                    status: 'partial',
                    purpose: '验证场站、价格、枪数等字段落点',
                    refs: ['data/stations.db']
                },
                {
                    type: '失败城市证据',
                    status: 'pending',
                    purpose: '区分目标平台失败、签名模板失败和环境问题',
                    refs: ['signed_template_target_mismatch']
                }
            ],
            recommendations: [
                {
                    id: 'R-001',
                    priority: 'P0',
                    action: '补齐业务请求 HAR、页面截图和请求摘要，形成同一报告目录下的证据引用。',
                    owner: 'backend/test',
                    verification: 'report.json 中 evidenceMatrix 与 report.md 附录能定位对应证据。'
                },
                {
                    id: 'R-002',
                    priority: 'P0',
                    action: '对苏州、桂林独立复测签名模板和代理出口状态。',
                    owner: 'backend',
                    verification: '失败城市记录请求预算、响应摘要、模板 ID 和复测结论。'
                },
                {
                    id: 'R-003',
                    priority: 'P1',
                    action: '前端接入后按报告 API 渲染列表、详情和下载入口。',
                    owner: 'frontend',
                    verification: '静态 SECURITY_REPORTS 可平滑迁移为后端报告列表。'
                }
            ],
            retest: {
                status: 'pending',
                statusLabel: '待复测',
                criteria: [
                    '业务请求验证需有 HAR、截图、请求摘要和数据库校验四类证据。',
                    '四个城市需分别记录结论，失败城市不能只在总报告里摘要化处理。',
                    '修复后重新生成 report.json 与 report.md，并保留复测状态。'
                ]
            },
            audit: {
                generatedBy: 'BlueTeamReportService',
                source: 'seed',
                requirement: 'REQ-003-BE-1'
            }
        };
    }

    generateMarkdown(report = {}, options = {}) {
        const sanitize = options.sanitize !== false;
        const target = report.target || {};
        const impact = report.impact || {};
        const retest = report.retest || {};
        const methods = Array.isArray(report.methods) ? report.methods : [];
        const findings = Array.isArray(report.findings) ? report.findings : [];
        const evidenceMatrix = Array.isArray(report.evidenceMatrix) ? report.evidenceMatrix : [];
        const recommendations = Array.isArray(report.recommendations) ? report.recommendations : [];
        const targets = Array.isArray(report.targets) ? report.targets : [];
        const operationView = report.operationView || this.buildOperationView(report);
        const targetCompletion = operationView.targetCompletion || {};
        const resources = operationView.resources || {};
        const problemCause = operationView.problemCause || {};
        const operationActions = Array.isArray(operationView.recommendedActions) ? operationView.recommendedActions : [];
        const attackPath = Array.isArray(operationView.attackPath) ? operationView.attackPath : [];

        const lines = [
            `# ${this.markdownText(report.title || report.reportName || report.reportId)}`,
            '',
            '## 安全声明',
            '',
            ...(sanitize ? [
                '本报告为蓝军测试内部文档。报告内容经过脱敏处理，接口地址、参数结构和认证字段已遮蔽。',
                '如需查看完整证据，请通过完整版导出功能获取。',
            ] : [
                '本报告为蓝军测试内部全文文档。以下内容未做脱敏处理，包含原始接口、参数结构、认证字段、执行节点和证据引用。',
                '仅限授权安全测试与内部复核使用。',
            ]),
            '',
            '## 报告摘要',
            '',
            `- 报告名称：${this.markdownText(report.reportName || report.title || '')}`,
            `- 报告编号：${this.markdownText(report.reportId || '')}`,
            `- 测试时间：${this.markdownText(this.formatTimeRange(report.startedAt, report.finishedAt))}`,
            `- 测试对象：${this.markdownText(target.name || '')}`,
            `- 目标范围：${this.markdownText(report.scope || target.scope || '')}`,
            `- 测试方式：${this.markdownText(methods.map(item => item.name || item.id).filter(Boolean).join(' / '))}`,
            `- 测试结论：${this.markdownText(report.conclusion || report.overallStatus || '')}`,
            `- 风险等级：${this.markdownText(report.riskLevelLabel || this.toRiskLabel(report.riskLevel))}`,
            `- 证据完整性：${this.markdownText(report.evidenceCompleteness || '')}`,
            `- 复测状态：${this.markdownText(retest.statusLabel || report.retestStatus || '')}`,
            '',
            ...(report.evidenceCompleteness === 'missing' ? [
                '> ⚠️ **证据缺失警告**：本报告无实际证据文件支撑，结论已自动降级为部分通过。请补充证据后重新提交。',
                '',
            ] : []),
            '## 目标完成情况',
            '',
            `- 测试目标：${this.markdownText(targetCompletion.target || target.name || report.reportName || '')}`,
            `- 预期结果：${this.markdownText(targetCompletion.expected || '完成授权蓝军测试并形成可复核证据')}`,
            `- 实际结果：${this.markdownText(targetCompletion.actual || report.conclusion || report.overallStatus || '')}`,
            `- 完成状态：${this.markdownText(targetCompletion.status || report.overallStatus || '')}`,
            `- 完成率：${this.markdownText(targetCompletion.percent ?? '')}%`,
            '',
            '| 未完成目标 | 状态 | 原因 |',
            '| --- | --- | --- |',
            ...((targetCompletion.failedTargets || []).length
                ? targetCompletion.failedTargets.map(item => `| ${this.tableCell(item.name || '')} | ${this.tableCell(item.status || '')} | ${this.tableCell(item.reason || '')} |`)
                : ['| 无 | 完成 | - |']),
            '',
            '## 使用资源',
            '',
            `- 执行节点：${this.markdownText(resources.executionNode || '')}`,
            `- 测试平台：${this.markdownText(resources.platform || target.platform || '')}`,
            `- 城市范围：${this.markdownText(Array.isArray(resources.cities) ? resources.cities.join('、') : '')}`,
            `- 资产范围：${this.markdownText(Array.isArray(resources.assets) ? resources.assets.join('、') : '')}`,
            `- 请求数量：${this.markdownText(resources.requestCount ?? '')}`,
            `- 证据文件数：${this.markdownText(resources.evidenceFileCount ?? '')}`,
            `- 录包资源：${this.markdownText(resources.captureResource || '')}`,
            `- 出站资源：${this.markdownText(resources.outboundResource || '')}`,
            '',
            '## 攻击路径',
            '',
            '| 顺序 | 阶段 | 动作 | 结果 | 证据引用 |',
            '| --- | --- | --- | --- | --- |',
            ...attackPath.map(step => [
                this.tableCell(String(step.order || '')),
                this.tableCell(step.phase || ''),
                this.tableCell(step.action || ''),
                this.tableCell(step.result || ''),
                this.tableCell(Array.isArray(step.evidenceRefs) ? step.evidenceRefs.join(', ') : '')
            ].join(' | ')).map(row => `| ${row} |`),
            '',
            '## 问题原因',
            '',
            `- 根因类型：${this.markdownText(problemCause.type || '')}`,
            `- 根因说明：${this.markdownText(problemCause.summary || '')}`,
            `- 失败位置：${this.markdownText(problemCause.failurePoint || '')}`,
            `- 证据缺口：${this.markdownText(problemCause.evidenceGap || '')}`,
            `- 影响面：${this.markdownText(problemCause.impact || '')}`,
            '',
            '## 测试方式',
            '',
            '| 方式 | 状态 | 工作原理 | 证据引用 |',
            '| --- | --- | --- | --- |',
            ...methods.map(item => [
                this.tableCell(item.name || item.id),
                this.tableCell(item.status || ''),
                this.tableCell(item.principle || ''),
                this.tableCell(Array.isArray(item.evidenceRefs) ? item.evidenceRefs.join(', ') : '')
            ].join(' | ')).map(row => `| ${row} |`),
            '',
            '## 多城市测试结论',
            '',
            '| 城市 | 结论 | 风险等级 | 请求数 | 成功 | 失败 | 城市错配 |',
            '| --- | --- | --- | --- | --- | --- | --- |',
            ...targets.map(t => [
                this.tableCell(t.city || ''),
                this.tableCell(STATUS_LABEL_MAP[t.status] || t.status || ''),
                this.tableCell(RISK_LABEL_MAP[t.riskLevel] || t.riskLevel || ''),
                this.tableCell(String(t.metrics?.requests ?? '')),
                this.tableCell(String(t.metrics?.success ?? '')),
                this.tableCell(String(t.metrics?.failed ?? '')),
                this.tableCell(String(t.metrics?.cityMismatch ?? '')),
            ].join(' | ')).map(row => `| ${row} |`),
            '',
            ...targets.map(t => `### ${this.markdownText(t.city || '')} 详细结论\n\n${this.markdownText(t.conclusion || t.analysis || '')}`).filter(Boolean),
            '',
            '## 影响面',
            '',
            `- 摘要：${this.markdownText(impact.summary || '')}`,
            `- 影响资产：${this.markdownText(Array.isArray(impact.affectedAssets) ? impact.affectedAssets.join('、') : '')}`,
            `- 暴露风险：${this.markdownText(impact.exposure || '')}`,
            `- 业务影响：${this.markdownText(impact.businessImpact || '')}`,
            '',
            '## 风险发现',
            '',
            '| 编号 | 等级 | 发现项 | 影响面 | 复现 / 证据引用 | 修复建议 | 复测状态 |',
            '| --- | --- | --- | --- | --- | --- | --- |',
            ...findings.map(item => [
                this.tableCell(item.id || ''),
                this.tableCell(item.severityLabel || this.toRiskLabel(item.severity)),
                this.tableCell(item.title || ''),
                this.tableCell(Array.isArray(item.affectedScope) ? item.affectedScope.join('、') : item.affectedScope || item.impact || ''),
                this.tableCell(this.describeFindingEvidence(item)),
                this.tableCell(item.recommendation || ''),
                this.tableCell(item.retestStatus || item.status || '')
            ].join(' | ')).map(row => `| ${row} |`),
            '',
            '## 证据矩阵',
            '',
            '| 证据类型 | 当前状态 | 复核用途 | 引用 |',
            '| --- | --- | --- | --- |',
            ...evidenceMatrix.map(item => [
                this.tableCell(item.type || ''),
                this.tableCell(item.status || ''),
                this.tableCell(item.purpose || ''),
                this.tableCell(Array.isArray(item.refs) ? item.refs.join(', ') : '')
            ].join(' | ')).map(row => `| ${row} |`),
            '',
            '## 修复建议',
            '',
            '| 编号 | 优先级 | 动作 | Owner | 验证标准 |',
            '| --- | --- | --- | --- | --- |',
            ...(operationActions.length ? operationActions : recommendations).map(item => [
                this.tableCell(item.id || ''),
                this.tableCell(item.priority || ''),
                this.tableCell(item.action || ''),
                this.tableCell(item.owner || ''),
                this.tableCell(item.validation || item.verification || '')
            ].join(' | ')).map(row => `| ${row} |`),
            '',
            '## 复测状态',
            '',
            `- 状态：${this.markdownText(retest.statusLabel || retest.status || '')}`,
            '',
            ...(retest.parentReportId ? [`- 原始报告：${this.markdownText(retest.parentReportId)}`] : []),
            ...(retest.childReportId ? [`- 复测报告：${this.markdownText(retest.childReportId)}`] : []),
            '',
            ...this.formatList(retest.criteria || []),
            ''
        ];

        return `${lines.join('\n')}\n`;
    }

    ensureMarkdown(report) {
        const id = this.normalizeReportId(report.reportId || report.id);
        const markdownPath = this.getReportFilePath(id, 'report.md');
        if (!fs.existsSync(markdownPath)) {
            this.writeFileAtomic(markdownPath, this.generateMarkdown(report));
        }
    }

    getReportDir(reportId) {
        const id = this.normalizeReportId(reportId);
        const resolvedRoot = path.resolve(this.rootDir);
        const reportDir = path.resolve(resolvedRoot, id);
        if (!reportDir.startsWith(`${resolvedRoot}${path.sep}`)) {
            const error = new Error('invalid report id');
            error.statusCode = 400;
            error.code = 'invalid_blue_team_report_id';
            throw error;
        }
        return reportDir;
    }

    getReportFilePath(reportId, fileName) {
        return path.join(this.getReportDir(reportId), fileName);
    }

    normalizeReportId(value) {
        const id = String(value || '').trim();
        if (!REPORT_ID_PATTERN.test(id) || id.includes('..')) {
            const error = new Error('invalid report id');
            error.statusCode = 400;
            error.code = 'invalid_blue_team_report_id';
            throw error;
        }
        return id;
    }

    normalizeDownloadFormat(value) {
        const format = String(value || 'json').trim().toLowerCase();
        if (['json', 'markdown'].includes(format)) {
            return format;
        }
        if (format === 'md') {
            return 'markdown';
        }
        const error = new Error('format must be json or markdown');
        error.statusCode = 400;
        error.code = 'invalid_blue_team_report_format';
        throw error;
    }

    writeFileAtomic(filePath, content) {
        const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(tmpPath, content, 'utf8');
        fs.renameSync(tmpPath, filePath);
    }

    getRelativeFiles(reportId) {
        const id = this.normalizeReportId(reportId);
        const reportDir = this.getReportDir(id);
        const evidenceDir = path.join(reportDir, 'evidence');
        const evidenceFiles = {};
        try {
            if (fs.existsSync(evidenceDir)) {
                const types = fs.readdirSync(evidenceDir, { withFileTypes: true });
                for (const entry of types) {
                    if (entry.isDirectory()) {
                        const subFiles = fs.readdirSync(path.join(evidenceDir, entry.name));
                        evidenceFiles[entry.name] = subFiles;
                    } else {
                        evidenceFiles[entry.name] = entry.name;
                    }
                }
            }
        } catch (error) {
            // evidence dir may not exist for legacy reports
        }
        return {
            json: `data/blue-team-reports/${id}/report.json`,
            markdown: `data/blue-team-reports/${id}/report.md`,
            evidence: evidenceFiles,
        };
    }

    getDownloadLinks(reportId) {
        const id = encodeURIComponent(this.normalizeReportId(reportId));
        return {
            json: `/api/blue-team/reports/${id}/download?format=json`,
            markdown: `/api/blue-team/reports/${id}/download?format=markdown`
        };
    }

    describeFindingEvidence(finding = {}) {
        const refs = [];
        const reproduction = finding.reproduction || {};
        if (Array.isArray(reproduction.steps) && reproduction.steps.length > 0) {
            refs.push(`复现步骤 ${reproduction.steps.length} 步`);
        }
        if (Array.isArray(reproduction.evidenceRefs)) {
            refs.push(...reproduction.evidenceRefs.map(item => {
                if (!item || typeof item !== 'object') {
                    return '';
                }
                const status = item.status ? `:${item.status}` : '';
                return `${item.label || item.type || 'evidence'}${status}`;
            }).filter(Boolean));
        }
        if (Array.isArray(finding.evidenceRefs)) {
            refs.push(...finding.evidenceRefs);
        }
        return refs.join('; ');
    }

    formatList(items = []) {
        if (!Array.isArray(items) || items.length === 0) {
            return ['- 暂无'];
        }
        return items.map(item => `- ${this.markdownText(item)}`);
    }

    formatTimeRange(startedAt, finishedAt) {
        if (startedAt && finishedAt && startedAt !== finishedAt) {
            return `${startedAt} - ${finishedAt}`;
        }
        return startedAt || finishedAt || '';
    }

    tableCell(value) {
        return this.markdownText(value).replace(/\|/g, '\\|');
    }

    markdownText(value) {
        return String(value ?? '').replace(/\r?\n/g, ' ').trim();
    }

    toRiskLabel(value) {
        const key = String(value || '').toLowerCase();
        const labels = {
            critical: '严重',
            high: '高',
            medium: '中',
            low: '低',
            none: '无',
            unknown: '未知'
        };
        return labels[key] || String(value || '未知');
    }

    throwNotFound(reportId) {
        const error = new Error(`blue-team report not found: ${reportId}`);
        error.statusCode = 404;
        error.code = 'blue_team_report_not_found';
        throw error;
    }
}

module.exports = BlueTeamReportService;
