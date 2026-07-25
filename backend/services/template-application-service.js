'use strict';

const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const ALLOWED_SCOPES = new Set(['list', 'detail']);

function templateError(code, message, statusCode = 400) {
    const error = new Error(message);
    error.code = code;
    error.statusCode = statusCode;
    return error;
}

class TemplateApplicationService {
    constructor(options = {}) {
        this.templateModel = options.templateModel;
        this.stationModel = options.stationModel;
        this.smartCrawler = options.smartCrawler;
        this.getPlatformIds = options.getPlatformIds;
        this.normalizeTargetLocation = options.normalizeTargetLocation;
        if (!this.templateModel || !this.stationModel || !this.smartCrawler
            || !this.getPlatformIds || !this.normalizeTargetLocation) {
            throw new TypeError('template application service dependencies are required');
        }
    }

    create(payload = {}) {
        const name = this.requiredText(payload.name, 'name', 200);
        const template = this.normalizePattern(payload.pattern, name);
        const result = this.templateModel.saveSmart(template);
        return {
            templateId: Number(result.templateId || result.lastInsertRowid) || null,
            created: Boolean(result.created),
            merged: Boolean(result.merged),
            skipped: Boolean(result.skipped),
        };
    }

    createBatch(payload = {}) {
        if (!Array.isArray(payload.patterns) || payload.patterns.length === 0) {
            throw templateError('template_patterns_required', 'patterns must be a non-empty array');
        }
        if (payload.patterns.length > 100) {
            throw templateError('template_batch_too_large', 'patterns must not contain more than 100 items');
        }
        const date = new Date().toISOString().slice(0, 10);
        const templates = payload.patterns.map((pattern, index) => this.normalizePattern(
            pattern,
            `${String(pattern?.platform || 'template')} [${String(pattern?.templateScope || 'list')}] - ${date} #${index + 1}`
        ));
        return this.templateModel.saveBatch(templates);
    }

    list() {
        const allowed = new Set(this.getPlatformIds());
        return this.templateModel.publicTemplates(
            this.templateModel.getAll().filter(template => allowed.has(template.platform))
        );
    }

    listByPlatform(platform) {
        this.assertPlatform(platform);
        return this.templateModel.publicTemplates(this.templateModel.getByPlatform(platform));
    }

    get(id) {
        const template = this.templateModel.getById(id);
        return template ? this.templateModel.publicTemplate(template) : null;
    }

    update(id, payload = {}) {
        const updates = { ...payload };
        if (updates.name !== undefined) updates.name = this.requiredText(updates.name, 'name', 200);
        if (updates.templateScope !== undefined && !ALLOWED_SCOPES.has(String(updates.templateScope))) {
            throw templateError('template_scope_invalid', 'templateScope must be list or detail');
        }
        for (const field of ['queryParams', 'bodyParams', 'variableParams', 'headers']) {
            if (updates[field] !== undefined && (!updates[field] || typeof updates[field] !== 'object' || Array.isArray(updates[field]))) {
                throw templateError('template_material_invalid', `${field} must be an object`);
            }
            if (updates[field] !== undefined
                && Buffer.byteLength(JSON.stringify(updates[field]), 'utf8') > 256 * 1024) {
                throw templateError('template_material_too_large', `${field} must not exceed 256 KiB`);
            }
        }
        const result = this.templateModel.update(id, updates);
        if (!result || result.changes === 0) throw templateError('template_not_found', 'Template not found', 404);
        return { changes: result.changes };
    }

    delete(id) {
        const result = this.templateModel.delete(id);
        if (!result || result.changes === 0) throw templateError('template_not_found', 'Template not found', 404);
    }

    deduplicate(payload = {}, query = {}) {
        const dryRun = payload.dryRun === true || payload.dryRun === 'true' || query.dryRun === '1';
        return this.templateModel.deduplicateExactTemplates({ dryRun });
    }

    async use(id, payload = {}) {
        const template = this.templateModel.getById(id);
        if (!template) throw templateError('template_not_found', 'Template not found', 404);

        const coordinates = Array.isArray(payload.coordinates) ? payload.coordinates : [];
        if (coordinates.length > 5000) {
            throw templateError('template_coordinates_too_large', 'coordinates must not contain more than 5000 items');
        }
        const requestedRunLimit = payload.perRunUnlimited === true ? null : payload.perRunLimit;
        const runQuota = this.smartCrawler.createRunRequestQuota(requestedRunLimit);
        const requestBudget = this.isTestMode(payload.testMode)
            ? this.smartCrawler.createTestRequestBudget(template.platform)
            : null;
        const firstCoord = coordinates[0] || null;
        const proxyContext = this.normalizeTargetLocation(payload.targetLocation, firstCoord?.lat, firstCoord?.lng);
        const preflightDiagnostics = this.buildPreflightDiagnostics(template, proxyContext);
        let stations;

        try {
            if ((template.templateScope || 'list') === 'detail') {
                const seedStations = Array.isArray(payload.seedStations) ? payload.seedStations : [];
                if (seedStations.length === 0 || seedStations.length > 5000) {
                    throw templateError(
                        'template_seed_stations_invalid',
                        'detail template requires between 1 and 5000 seedStations'
                    );
                }
                stations = await this.smartCrawler.crawlDetail(template, {
                    seedStations, requestBudget, runQuota, proxyContext,
                });
            } else {
                stations = await this.smartCrawler.crawl(template, {
                    coordinates,
                    pageSize: this.boundedInteger(payload.pageSize, 20, 1, 200),
                    maxPages: this.boundedInteger(payload.maxPages, 5, 1, 100),
                    requestBudget,
                    runQuota,
                    proxyContext,
                });
            }
        } catch (error) {
            if (this.smartCrawler.isRunRequestLimitExceeded(error)) {
                error.statusCode = 429;
                error.code = error.code || 'run_request_limit_exceeded';
                error.runQuota = error.runQuota
                    || this.smartCrawler.getRunRequestQuotaSummary(runQuota, { includeRequests: false });
                error.quotaStats = this.smartCrawler.getQuotaStatsSummary();
            }
            throw error;
        }

        const insertResult = stations.length > 0
            ? this.stationModel.insertBatch(stations)
            : { successCount: 0, skipCount: 0 };
        this.templateModel.updateLastUsed(template.id);
        return {
            stationCount: stations.length,
            insertedCount: insertResult.successCount || 0,
            skippedCount: insertResult.skipCount || 0,
            testMode: Boolean(requestBudget),
            preflightDiagnostics,
            requestBudget: this.smartCrawler.getTestRequestBudgetSummary(requestBudget),
            quotaStats: this.smartCrawler.getQuotaStatsSummary(),
            runQuota: this.smartCrawler.getRunRequestQuotaSummary(runQuota, { includeRequests: false }),
        };
    }

    buildPreflightDiagnostics(pattern, proxyContext = null) {
        const mismatch = this.smartCrawler.getSignedTemplateTargetMismatch(pattern, proxyContext);
        return mismatch ? [{
            code: 'signed_template_target_mismatch',
            severity: 'warn',
            message: mismatch,
            action: '补齐目标城市的实际请求参数，或接入可审计的签名参数修复能力后再执行。',
        }] : [];
    }

    normalizePattern(pattern, name) {
        if (!pattern || typeof pattern !== 'object' || Array.isArray(pattern)) {
            throw templateError('template_pattern_required', 'pattern must be an object');
        }
        const platform = this.requiredText(pattern.platform, 'platform', 64);
        this.assertPlatform(platform);
        const method = String(pattern.method || '').trim().toUpperCase();
        if (!ALLOWED_METHODS.has(method)) {
            throw templateError('template_method_invalid', 'method is invalid');
        }
        const baseUrl = this.validateUrl(pattern.baseUrl);
        const templateScope = String(pattern.templateScope || 'list').trim();
        if (!ALLOWED_SCOPES.has(templateScope)) {
            throw templateError('template_scope_invalid', 'templateScope must be list or detail');
        }
        const normalized = { name, platform, method, baseUrl, templateScope };
        for (const field of ['queryParams', 'bodyParams', 'variableParams', 'headers']) {
            const value = pattern[field] === undefined ? {} : pattern[field];
            if (!value || typeof value !== 'object' || Array.isArray(value)) {
                throw templateError('template_material_invalid', `${field} must be an object`);
            }
            if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 256 * 1024) {
                throw templateError('template_material_too_large', `${field} must not exceed 256 KiB`);
            }
            normalized[field] = value;
        }
        return normalized;
    }

    assertPlatform(platform) {
        if (!this.getPlatformIds().includes(String(platform))) {
            throw templateError('template_platform_unsupported', `unsupported platform: ${platform}`);
        }
    }

    validateUrl(value) {
        const text = String(value || '').trim();
        let url;
        try {
            url = new URL(text);
        } catch {
            throw templateError('template_url_invalid', 'baseUrl must be a valid HTTP(S) URL');
        }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
            throw templateError(
                'template_url_invalid',
                'baseUrl must be an HTTP(S) URL without credentials, query parameters or fragments'
            );
        }
        return text;
    }

    requiredText(value, field, maxLength) {
        const text = String(value || '').trim();
        if (!text || text.length > maxLength) {
            throw templateError(`template_${field}_invalid`, `${field} is required and must not exceed ${maxLength} characters`);
        }
        return text;
    }

    boundedInteger(value, fallback, minimum, maximum) {
        if (value === undefined || value === null || value === '') return fallback;
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) return fallback;
        return Math.max(minimum, Math.min(maximum, Math.trunc(parsed)));
    }

    isTestMode(value) {
        return value === true || value === 'true' || value === 1 || value === '1';
    }
}

module.exports = TemplateApplicationService;
module.exports.templateError = templateError;
