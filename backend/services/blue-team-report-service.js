const fs = require('fs');
const path = require('path');

const db = require('../database/init');
const sensitiveRedactor = require('./sensitive-redactor');

const DEFAULT_SEED_REPORT_ID = 'BTR-RISK-20260531-0001';
const REPORT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/;
const DEFAULT_SCREENSHOT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_TEXT_EVIDENCE_MAX_BYTES = 1024 * 1024;

const INTERFACE_DISPLAY_MAP = {
    'stationList': '列表请求',
    'getoneinfo': '详情请求',
    'homepage/stationList': '场站列表请求',
    'station/getoneinfo': '场站详情请求',
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
    'page-automation': '页面采集',
    'background-automation': '请求采集',
    'traffic-template': '小规模访问验证',
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

        const storedReport = this.sanitizeStoredValue(report);
        this.writeFileAtomic(
            path.join(reportDir, 'report.json'),
            `${JSON.stringify(storedReport, null, 2)}\n`
        );

        this.upsertReportIndex(storedReport);

        return this.decorateReport(storedReport);
    }

    appendEvent(reportId, events = []) {
        const id = this.normalizeReportId(reportId);
        const report = this.readReportRaw(id);
        const appendList = (Array.isArray(events) ? events : [events])
            .slice(0, 100)
            .map(event => this.sanitizeStoredValue(event));

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

        let relativePath = `evidence/${mappedName}`;

        if (type === 'screenshot') {
            const screenshotsDir = path.join(evidencePath, 'screenshots');
            fs.mkdirSync(screenshotsDir, { recursive: true });
            const safeName = this.sanitizeFilename(filename || `screenshot-${Date.now()}.png`);
            if (!safeName || !['.png', '.jpg', '.jpeg'].includes(path.extname(safeName).toLowerCase())) {
                const error = new Error('screenshot filename must use .png, .jpg or .jpeg');
                error.statusCode = 400;
                error.code = 'invalid_screenshot_filename';
                throw error;
            }
            const image = this.decodeScreenshot(data, safeName);
            const filePath = path.join(screenshotsDir, safeName);
            fs.writeFileSync(filePath, image, { mode: 0o600 });
            relativePath = `evidence/screenshots/${safeName}`;
            this.updateEvidenceMatrix(report, type, relativePath, city);
        } else if (mappedName.endsWith('.jsonl')) {
            const safeData = this.sanitizeStoredValue(data);
            const line = typeof safeData === 'string' ? safeData : JSON.stringify(safeData);
            this.assertTextEvidenceSize(line);
            fs.appendFileSync(targetPath, `${line}\n`, { encoding: 'utf8', mode: 0o600 });
            this.updateEvidenceMatrix(report, type, relativePath, city);
        } else {
            const safeData = this.sanitizeStoredValue(data);
            const content = typeof safeData === 'string' ? safeData : JSON.stringify(safeData, null, 2);
            this.assertTextEvidenceSize(content);
            fs.writeFileSync(targetPath, content, 'utf8');
            this.updateEvidenceMatrix(report, type, relativePath, city);
        }

        report.updatedAt = new Date().toISOString();
        this.writeReportJson(id, report);
        this.upsertReportIndex(report);

        return { reportId: id, type, path: relativePath };
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
        if (input.executionProcedure && typeof input.executionProcedure === 'object') {
            report.executionProcedure = input.executionProcedure;
        }
        if (input.exploitableRisk && typeof input.exploitableRisk === 'object') {
            report.exploitableRisk = input.exploitableRisk;
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

        report.businessSummary = input.businessSummary && typeof input.businessSummary === 'object'
            ? { ...this.buildBusinessSummary(report), ...input.businessSummary }
            : this.buildBusinessSummary(report);

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

    readEvidenceFile(reportId, type, filename, options = {}) {
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
            if (!safeName || !['.png', '.jpg', '.jpeg'].includes(path.extname(safeName).toLowerCase())) {
                const error = new Error('invalid screenshot filename');
                error.statusCode = 400;
                error.code = 'invalid_screenshot_filename';
                throw error;
            }
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

        const contentType = contentTypes[ext] || 'application/octet-stream';
        const shouldSanitize = options.sanitize !== false && ['.json', '.jsonl', '.txt'].includes(ext);
        if (shouldSanitize) {
            const raw = fs.readFileSync(resolvedPath, 'utf8');
            return {
                content: this.sanitizeEvidenceContent(raw, ext),
                contentType,
                filename: path.basename(resolvedPath),
                sanitized: true,
            };
        }

        return {
            filePath: resolvedPath,
            contentType,
            filename: path.basename(resolvedPath),
            sanitized: false,
        };
    }

    sanitizeEvidenceContent(raw, ext) {
        if (ext === '.json') {
            try {
                return `${JSON.stringify(this.sanitizeEvidenceValue(JSON.parse(raw)), null, 2)}\n`;
            } catch {
                return this.sanitizeEvidenceText(raw);
            }
        }

        if (ext === '.jsonl') {
            return raw.split(/\r?\n/).map(line => {
                if (!line.trim()) return line;
                try {
                    return JSON.stringify(this.sanitizeEvidenceValue(JSON.parse(line)));
                } catch {
                    return this.sanitizeEvidenceText(line);
                }
            }).join('\n');
        }

        return this.sanitizeEvidenceText(raw);
    }

    sanitizeEvidenceValue(value) {
        const redacted = sensitiveRedactor.redactObject(value);
        return this.deepSanitizeEvidenceValue(redacted);
    }

    sanitizeStoredValue(value) {
        const redacted = sensitiveRedactor.redactObject(value);
        const walk = item => {
            if (Array.isArray(item)) return item.map(walk);
            if (item && typeof item === 'object') {
                return Object.fromEntries(Object.entries(item).map(([key, raw]) => [key, walk(raw)]));
            }
            return typeof item === 'string' ? sensitiveRedactor.redactText(item) : item;
        };
        return walk(redacted);
    }

    decodeScreenshot(data, filename) {
        let image;
        if (Buffer.isBuffer(data)) {
            image = data;
        } else if (typeof data === 'string') {
            const encoded = data.replace(/^data:image\/(?:png|jpeg);base64,/i, '').trim();
            if (!encoded || !/^[A-Za-z0-9+/_=-]+$/.test(encoded)) {
                const error = new Error('screenshot data must be valid base64');
                error.statusCode = 400;
                error.code = 'invalid_screenshot_data';
                throw error;
            }
            image = Buffer.from(encoded, 'base64');
        } else {
            const error = new Error('screenshot data must be a buffer or base64 string');
            error.statusCode = 400;
            error.code = 'invalid_screenshot_data';
            throw error;
        }

        const maxBytes = Math.max(1024, Number(process.env.REPORT_SCREENSHOT_MAX_BYTES) || DEFAULT_SCREENSHOT_MAX_BYTES);
        if (image.length === 0 || image.length > maxBytes) {
            const error = new Error('screenshot exceeds the configured size limit');
            error.statusCode = 413;
            error.code = 'screenshot_too_large';
            throw error;
        }
        const extension = path.extname(filename).toLowerCase();
        const isPng = image.length >= 8 && image.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
        const isJpeg = image.length >= 3 && image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff;
        if ((extension === '.png' && !isPng) || (['.jpg', '.jpeg'].includes(extension) && !isJpeg)) {
            const error = new Error('screenshot content does not match its file extension');
            error.statusCode = 400;
            error.code = 'screenshot_type_mismatch';
            throw error;
        }
        return image;
    }

    assertTextEvidenceSize(content) {
        const maxBytes = Math.max(1024, Number(process.env.REPORT_TEXT_EVIDENCE_MAX_BYTES) || DEFAULT_TEXT_EVIDENCE_MAX_BYTES);
        if (Buffer.byteLength(String(content || ''), 'utf8') > maxBytes) {
            const error = new Error('text evidence exceeds the configured size limit');
            error.statusCode = 413;
            error.code = 'text_evidence_too_large';
            throw error;
        }
    }

    deepSanitizeEvidenceValue(value) {
        if (Array.isArray(value)) {
            return value.map(item => this.deepSanitizeEvidenceValue(item));
        }
        if (value && typeof value === 'object') {
            const output = {};
            for (const [key, raw] of Object.entries(value)) {
                output[key] = sensitiveRedactor.isSensitiveKey(key)
                    ? sensitiveRedactor.REDACTED
                    : this.deepSanitizeEvidenceValue(raw);
            }
            return output;
        }
        if (typeof value === 'string') {
            return this.sanitizeEvidenceText(value);
        }
        return value;
    }

    sanitizeEvidenceText(raw) {
        if (!raw || typeof raw !== 'string') return raw;
        let text = raw.replace(/https?:\/\/[^\s"'<>]+/gi, url => {
            const redactedUrl = sensitiveRedactor.redactUrl(url);
            return this.sanitizeUrl(redactedUrl);
        });
        text = text.replace(
            /\b(cookie|authorization|token|access_token|refresh_token|ticket|wsgsig|signature|sign|session_key|openid|unionid)\b(\s*[:=]\s*["']?)[^"',\s&}\]]+/gi,
            (_match, key, sep) => `${key}${sep}${sensitiveRedactor.REDACTED}`
        );
        return text.replace(
            /([?&])(cookie|authorization|token|access_token|refresh_token|ticket|wsgsig|signature|sign|session_key|openid|unionid)=([^&\s"']+)/gi,
            (_match, prefix, key) => `${prefix}${key}=${sensitiveRedactor.REDACTED}`
        );
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
        const storedReport = this.sanitizeStoredValue(report);
        this.writeFileAtomic(jsonPath, `${JSON.stringify(storedReport, null, 2)}\n`);
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
            'ocr-lines': '页面识别行',
            'har-summary': '请求记录摘要',
            'api-request': '业务请求日志',
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
        const raw = String(filename || '').trim();
        if (!raw || raw !== path.basename(raw) || raw.includes('..')) return '';
        return raw.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 255);
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

                // result 中请求名用 INTERFACE_DISPLAY_MAP 映射
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
        // 去重映射后可能出现的重复词
        result = result.replace(/请求请求/g, '请求');
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
        if (sanitize) {
            const report = this.sanitizeReport(this.readReport(id));
            this.recordDownloadAudit(id, normalizedFormat, { sanitize: true, actor: options.actor || 'anonymous' });
            return {
                format: normalizedFormat,
                filename: normalizedFormat === 'markdown' ? `${id}-sanitized.md` : `${id}-sanitized.json`,
                contentType: normalizedFormat === 'markdown'
                    ? 'text/markdown; charset=utf-8'
                    : 'application/json; charset=utf-8',
                content: normalizedFormat === 'markdown'
                    ? this.generateMarkdown(report, { sanitize: true })
                    : `${JSON.stringify(report, null, 2)}\n`
            };
        }

        this.recordDownloadAudit(id, normalizedFormat, { sanitize: false, actor: options.actor || 'anonymous' });

        if (normalizedFormat === 'markdown') {
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

    recordDownloadAudit(reportId, format, meta = {}) {
        try {
            const auditPath = path.join(this.getReportDir(reportId), 'download-audit.jsonl');
            const line = {
                at: new Date().toISOString(),
                reportId,
                format,
                sanitize: meta.sanitize !== false,
                actor: meta.actor || 'anonymous'
            };
            fs.appendFileSync(auditPath, `${JSON.stringify(line)}\n`, 'utf8');
        } catch {
            // audit logging must not block report download
        }
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
        const businessSummary = report.businessSummary || this.buildBusinessSummary(report);
        return {
            ...report,
            reportId,
            businessSummary,
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
            businessSummary: report.businessSummary || this.buildBusinessSummary(report),
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

    buildBusinessSummary(report = {}) {
        const metrics = report.metrics || {};
        const resourceStats = report.resourceStats || {};
        const targets = Array.isArray(report.targets) ? report.targets : [];
        const methods = this.buildBusinessMethodSummary(report);
        const totalTests = this.pickNumber(
            resourceStats.totalRequests,
            resourceStats.requests,
            targets.reduce((sum, item) => sum + Number(item.metrics?.requests || 0), 0),
            targets.length
        );
        const successTests = this.pickNumber(
            resourceStats.successRequests,
            targets.reduce((sum, item) => sum + Number(item.metrics?.success || 0), 0),
            targets.filter(item => /success|done|pass|完成|通过/i.test(String(item.status || ''))).length
        );
        const failedTests = this.pickNumber(
            resourceStats.failedRequests,
            targets.reduce((sum, item) => sum + Number(item.metrics?.failed || 0), 0),
            Math.max(0, totalTests - successTests)
        );
        const dataRecords = this.pickNumber(metrics.stationCount, metrics.distinctCount, successTests);
        const evidenceFileCount = this.pickNumber(resourceStats.evidenceFileCount, 0);
        const tokenUsage = this.extractTokenUsage(report);
        const cost = this.buildBusinessCostSummary(report, {
            totalTests,
            evidenceFileCount,
            tokenUsage
        });
        const successRate = totalTests > 0 ? Math.round((successTests / totalTests) * 100) : 0;

        return {
            methodSummary: {
                title: methods.map(item => item.name).join(' / ') || '蓝军验证',
                description: methods.map(item => item.description).filter(Boolean).join('；') || '按授权范围执行蓝军验证并归档证据。',
                methods
            },
            costSummary: cost,
            resultSummary: {
                totalTests,
                successTests,
                failedTests,
                successRate,
                dataRecords,
                evidenceFileCount,
                cities: this.arrayValue(report.cities || report.target?.cities).length || targets.length,
                label: `测试 ${totalTests} 次，成功 ${successTests} 次，获取 ${dataRecords} 条数据`
            },
            conclusionSummary: {
                status: STATUS_LABEL_MAP[report.overallStatus] || report.overallStatus || '待确认',
                riskLevel: report.riskLevelLabel || this.toRiskLabel(report.riskLevel),
                evidenceCompleteness: report.evidenceCompleteness || 'unknown',
                conclusion: report.conclusion || report.completion?.summary || '',
                nextAction: this.firstText(
                    report.retest?.statusLabel,
                    report.recommendations?.[0]?.action,
                    report.evidenceCompleteness === 'missing' ? '补齐证据后复核' : '',
                    '按报告结论推进复测或归档'
                )
            }
        };
    }

    buildBusinessMethodSummary(report = {}) {
        const methods = Array.isArray(report.methods) && report.methods.length
            ? report.methods
            : this.arrayValue(report.method).map(method => ({ id: method, name: METHOD_LABEL_MAP[method] || method }));

        return methods.map(method => {
            const id = method.id || method.type || method.method || method.name || report.method || '';
            const name = method.name || METHOD_LABEL_MAP[id] || id || '蓝军验证';
            return {
                id,
                name,
                status: STATUS_LABEL_MAP[method.status] || method.status || '',
                description: this.describeBusinessMethod(id, method)
            };
        });
    }

    describeBusinessMethod(id, method = {}) {
        const text = String(id || method.name || '').toLowerCase();
        if (text.includes('page') || text.includes('页面')) {
            return '通过小程序页面截图和页面识别，复核普通用户可见数据。';
        }
        if (text.includes('background') || text.includes('capture') || text.includes('请求')) {
            return '通过小程序操作触发业务请求，记录并解析返回数据。';
        }
        if (text.includes('traffic') || text.includes('template') || text.includes('访问')) {
            return '复用已授权请求材料，做小规模访问验证并统计数据产出。';
        }
        return method.principle || method.description || '按授权范围执行蓝军测试并保留证据。';
    }

    buildBusinessCostSummary(report = {}, facts = {}) {
        const monthlySalary = Number(report.resourceStats?.monthlySalary || report.businessSummary?.costSummary?.monthlySalary || 20000);
        const hourlyRate = monthlySalary / 22 / 8;
        const durationHours = this.computeDurationHours(report.startedAt, report.finishedAt);
        const estimatedManualHours = Number(report.resourceStats?.manualWorkHours)
            || Number(report.businessSummary?.costSummary?.estimatedManualHours)
            || Math.max(0.5, durationHours || 0, (Number(facts.totalTests) || 0) * 0.15 + (Number(facts.evidenceFileCount) || 0) * 0.05);
        const humanCost = Math.round(estimatedManualHours * hourlyRate);
        const tokenUsage = facts.tokenUsage || { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
        const tokenLabel = tokenUsage.totalTokens > 0
            ? `模型消耗约 ${tokenUsage.totalTokens} tokens`
            : '未记录模型 token 消耗';

        return {
            monthlySalary,
            estimatedManualHours: Number(estimatedManualHours.toFixed(2)),
            estimatedHumanCost: humanCost,
            tokenUsage,
            label: `${tokenLabel}；按月薪 2w 技术人员估算，人工复现约 ${Number(estimatedManualHours.toFixed(2))} 人时，约 ${humanCost} 元`
        };
    }

    extractTokenUsage(value, depth = 0) {
        if (!value || typeof value !== 'object' || depth > 4) {
            return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
        }

        const promptTokens = Number(value.promptTokens ?? value.prompt_tokens ?? 0) || 0;
        const completionTokens = Number(value.completionTokens ?? value.completion_tokens ?? 0) || 0;
        const totalTokens = Number(value.totalTokens ?? value.total_tokens ?? value.tokens ?? 0) || 0;
        const own = {
            promptTokens,
            completionTokens,
            totalTokens: totalTokens || promptTokens + completionTokens
        };

        let nested = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
        for (const [key, child] of Object.entries(value)) {
            if (['promptTokens', 'prompt_tokens', 'completionTokens', 'completion_tokens', 'totalTokens', 'total_tokens', 'tokens'].includes(key)) {
                continue;
            }
            if (child && typeof child === 'object') {
                const usage = this.extractTokenUsage(child, depth + 1);
                nested.promptTokens += usage.promptTokens;
                nested.completionTokens += usage.completionTokens;
                nested.totalTokens += usage.totalTokens;
            }
        }

        return {
            promptTokens: own.promptTokens + nested.promptTokens,
            completionTokens: own.completionTokens + nested.completionTokens,
            totalTokens: own.totalTokens + nested.totalTokens
        };
    }

    computeDurationHours(startedAt, finishedAt) {
        const startMs = Date.parse(startedAt || '');
        const endMs = Date.parse(finishedAt || '');
        if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
            return 0;
        }
        return (endMs - startMs) / 3600000;
    }

    pickNumber(...values) {
        for (const value of values) {
            const number = Number(value);
            if (Number.isFinite(number) && number > 0) {
                return number;
            }
        }
        return 0;
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
                owner: item.owner || '业务运营 / 安全联系人',
                validation: item.verification || item.criteria || '复测报告状态更新为完成，证据中心可复核',
            }));
        }
        return [{
            id: 'A-1',
            priority: /高|high/i.test(String(report.riskLevelLabel || report.riskLevel || '')) ? 'P0' : 'P1',
            action: problemCause.summary || '补充测试证据并复核未完成目标',
            owner: '业务运营 / 安全联系人',
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
                assets: ['列表请求', '详情请求', '数据库场站记录']
            },
            scope: '武汉、南京、苏州、桂林 / 半径 20km',
            methods: [
                {
                    id: 'business-request',
                    name: '请求采集',
                    status: 'partial',
                    principle: '通过请求记录服务和小程序窗口复核实际业务请求，验证业务请求来源、请求材料和页面侧证据是否完整。',
                    evidenceRefs: ['capture-recorder-status', 'business-har-pending']
                },
                {
                    id: 'traffic-template',
                    name: '小规模访问验证',
                    status: 'partial',
                    principle: '通过已验证请求材料、城市/地标定位和数据库校验复核多城市场站数据链路。',
                    evidenceRefs: ['列表请求', '详情请求', '数据库校验']
                }
            ],
            overallStatus: 'partial',
            conclusion: '部分通过，待复测',
            riskLevel: 'medium',
            riskLevelLabel: '中',
            evidenceCompleteness: 'partial',
            impact: {
                summary: '多城市场站数据链路已有部分请求和入库证据，但请求采集和失败城市证据仍不完整，当前结论不能直接升级为完全通过。',
                affectedAssets: ['请求采集页面窗口', '请求记录服务', '请求材料', '场站列表与详情数据'],
                exposure: '若未补齐业务请求证据，无法证明测试结论来自真实小程序业务请求；若请求材料问题未复测，苏州、桂林等城市的数据完整性仍存在不确定性。',
                businessImpact: '影响安全报告可复核性、跨城市数据质量判定和后续修复闭环优先级。'
            },
            findings: [
                {
                    id: 'M-001',
                    title: '请求采集证据不完整',
                    severity: 'medium',
                    severityLabel: '中风险',
                    status: 'pending-retest',
                    affectedScope: ['小程序窗口', '页面截图', '业务请求记录'],
                    impact: '无法完整证明报告结论来自真实业务请求链路，影响渗透测试报告归档可信度。',
                    reproduction: {
                        steps: [
                            '打开安全报告详情页，检查请求采集证据矩阵。',
                            '核对请求记录服务状态和业务请求记录产物。',
                            '比对页面截图、请求摘要和数据库校验结果是否同源。'
                        ],
                        evidenceRefs: [
                            {
                                type: 'screenshot',
                                label: '小程序窗口 / 页面截图',
                                status: 'missing',
                                path: ''
                            },
                            {
                                type: 'request-record',
                                label: '业务请求记录',
                                status: 'pending',
                                path: ''
                            }
                        ]
                    },
                    recommendation: '补齐小程序业务窗口截图、请求记录会话、请求摘要和数据库核对结果，并在报告中保持证据与结论分离。',
                    retestStatus: 'pending'
                },
                {
                    id: 'M-002',
                    title: '请求材料待复测',
                    severity: 'medium',
                    severityLabel: '中风险',
                    status: 'pending-retest',
                    affectedScope: ['苏州', '桂林', '请求材料', '小规模访问验证'],
                    impact: '失败城市可能由请求材料或目标参数不匹配导致，当前无法判断是目标平台风险、材料过期还是环境问题。',
                    reproduction: {
                        steps: [
                            '使用目标城市和半径重新执行小规模访问验证。',
                            '观察列表请求和详情请求是否出现材料与目标不匹配。',
                            '对失败城市单独保存请求摘要、响应摘要和网络出口状态。'
                        ],
                        evidenceRefs: [
                            {
                                type: 'request-summary',
                                label: '请求材料与目标不匹配',
                                status: 'partial',
                                path: ''
                            }
                        ]
                    },
                    recommendation: '重新通过请求采集沉淀或复核请求材料，失败城市需独立记录请求预算、网络出口、响应摘要和参数差异。',
                    retestStatus: 'pending'
                },
                {
                    id: 'L-001',
                    title: '武汉、南京小规模访问验证已形成可复核证据',
                    severity: 'low',
                    severityLabel: '已验证',
                    status: 'passed',
                    affectedScope: ['武汉', '南京', '列表请求', '详情请求', '数据库'],
                    impact: '已能支撑部分通过结论，但仍需与业务请求验证证据合并归档。',
                    reproduction: {
                        steps: [
                            '复核列表请求和详情请求摘要。',
                            '核对数据库入库记录和城市范围。',
                            '确认报告字段与证据矩阵一致。'
                        ],
                        evidenceRefs: [
                            {
                                type: 'database',
                                label: '数据库场站记录',
                                status: 'partial',
                                path: ''
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
                    type: '请求记录服务',
                    status: 'partial',
                    purpose: '证明小程序实际业务包来源',
                    refs: ['capture-recorder-status', 'business-har-pending']
                },
                {
                    type: '小规模访问验证请求摘要',
                    status: 'partial',
                    purpose: '复核列表请求和详情请求响应状态',
                    refs: ['列表请求', '详情请求']
                },
                {
                    type: '数据库校验',
                    status: 'partial',
                    purpose: '验证场站、价格、枪数等字段落点',
                    refs: ['数据库校验']
                },
                {
                    type: '失败城市证据',
                    status: 'pending',
                    purpose: '区分目标平台失败、请求材料失败和环境问题',
                    refs: ['请求材料与目标不匹配']
                }
            ],
            recommendations: [
                {
                    id: 'R-001',
                    priority: 'P0',
                    action: '补齐业务请求记录、页面截图和请求摘要，形成同一报告下的证据引用。',
                    owner: 'backend/test',
                    verification: '报告中的证据矩阵和附录能定位对应证据。'
                },
                {
                    id: 'R-002',
                    priority: 'P0',
                    action: '对苏州、桂林独立复测请求材料和网络出口状态。',
                    owner: 'backend',
                    verification: '失败城市记录请求预算、响应摘要、请求材料状态和复测结论。'
                },
                {
                    id: 'R-003',
                    priority: 'P1',
                    action: '页面接入后按报告服务渲染列表、详情和下载入口。',
                    owner: 'frontend',
                    verification: '静态 SECURITY_REPORTS 可平滑迁移为后端报告列表。'
                }
            ],
            retest: {
                status: 'pending',
                statusLabel: '待复测',
                criteria: [
                    '请求采集需有请求记录、截图、请求摘要和数据库校验四类证据。',
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
        const businessSummary = report.businessSummary || this.buildBusinessSummary(report);
        const resultSummary = businessSummary.resultSummary || {};
        const costSummary = businessSummary.costSummary || {};
        const conclusionSummary = businessSummary.conclusionSummary || {};
        const executionProcedure = report.executionProcedure || {};
        const executionSteps = Array.isArray(executionProcedure.steps) ? executionProcedure.steps : [];
        const exploitableRisk = report.exploitableRisk || {};
        const exploitCost = exploitableRisk.exploitCost || {};

        const lines = [
            `# ${this.markdownText(report.title || report.reportName || report.reportId)}`,
            '',
            '## 安全声明',
            '',
            ...(sanitize ? [
                '本报告为蓝军测试内部文档。报告内容经过脱敏处理，请求地址、参数结构和认证字段已遮蔽。',
                '如需查看完整证据，请通过完整版导出功能获取。',
            ] : [
                '本报告为蓝军测试内部全文文档。以下内容未做脱敏处理，包含原始请求、参数结构、认证字段、执行节点和证据引用。',
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
            '## 业务摘要',
            '',
            `- 测试方式：${this.markdownText(businessSummary.methodSummary?.title || '')}`,
            `- 方式说明：${this.markdownText(businessSummary.methodSummary?.description || '')}`,
            `- 资源成本：${this.markdownText(costSummary.label || '')}`,
            `- 测试结果：${this.markdownText(resultSummary.label || '')}`,
            `- 成功率：${this.markdownText(resultSummary.successRate ?? 0)}%`,
            `- 数据产出：${this.markdownText(resultSummary.dataRecords ?? 0)} 条`,
            `- 当前结论：${this.markdownText(conclusionSummary.conclusion || conclusionSummary.status || '')}`,
            `- 下一步：${this.markdownText(conclusionSummary.nextAction || '')}`,
            '',
            ...(executionSteps.length ? [
                '## 具体执行过程',
                '',
                ...(executionProcedure.summary ? [
                    this.markdownText(executionProcedure.summary),
                    '',
                ] : []),
                '| 顺序 | 步骤 | 输入材料 | 执行方式 | 输出结果 | 校验方式 | 安全边界 |',
                '| --- | --- | --- | --- | --- | --- | --- |',
                ...executionSteps.map((step, index) => [
                    this.tableCell(String(step.order || index + 1)),
                    this.tableCell(step.name || step.phase || ''),
                    this.tableCell(Array.isArray(step.inputs) ? step.inputs.join('、') : (step.inputs || '')),
                    this.tableCell(step.action || ''),
                    this.tableCell(step.output || step.result || ''),
                    this.tableCell(Array.isArray(step.validation) ? step.validation.join('、') : (step.validation || '')),
                    this.tableCell(step.boundary || '')
                ].join(' | ')).map(row => `| ${row} |`),
                '',
            ] : []),
            ...(exploitableRisk.summary ? [
                '## 可利用风险与利用成本',
                '',
                `- 可利用性：${this.markdownText(exploitableRisk.exploitability || '')}`,
                `- 风险说明：${this.markdownText(exploitableRisk.summary || '')}`,
                `- 前置条件：${this.markdownText(Array.isArray(exploitableRisk.prerequisites) ? exploitableRisk.prerequisites.join('；') : (exploitableRisk.prerequisites || ''))}`,
                `- 可达能力：${this.markdownText(Array.isArray(exploitableRisk.availableCapabilities) ? exploitableRisk.availableCapabilities.join('；') : (exploitableRisk.availableCapabilities || ''))}`,
                `- 已有限制：${this.markdownText(Array.isArray(exploitableRisk.limitations) ? exploitableRisk.limitations.join('；') : (exploitableRisk.limitations || ''))}`,
                `- 业务影响：${this.markdownText(exploitableRisk.businessImpact || '')}`,
                `- 模型成本：${this.markdownText(exploitCost.tokenLabel || '')}`,
                `- 人力成本：${this.markdownText(exploitCost.humanCostLabel || '')}`,
                `- 总体成本：${this.markdownText(exploitCost.totalCostLabel || '')}`,
                '',
            ] : []),
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
            `- 请求记录资源：${this.markdownText(resources.captureResource || '')}`,
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
        fs.writeFileSync(tmpPath, content, { encoding: 'utf8', mode: 0o600 });
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
