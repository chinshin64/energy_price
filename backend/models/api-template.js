const db = require('../database/init');

class ApiTemplateModel {
    /**
     * 保存 API 模板
     */
    static save(template) {
        const stmt = db.prepare(`
            INSERT INTO api_templates (
                name, platform, method, base_url,
                template_scope, query_params, body_params, variable_params, headers
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        return stmt.run(
            template.name,
            template.platform,
            template.method,
            template.baseUrl,
            template.templateScope || 'list',
            JSON.stringify(template.queryParams || {}),
            JSON.stringify(template.bodyParams || {}),
            JSON.stringify(template.variableParams || {}),
            JSON.stringify(template.headers || {})
        );
    }

    /**
     * 获取所有模板
     */
    static getAll() {
        const templates = db.prepare(`
            SELECT * FROM api_templates 
            WHERE is_active = 1
            ORDER BY last_used DESC, created_at DESC
        `).all();

        return templates.map(t => this.parse(t));
    }

    /**
     * 根据 ID 获取模板
     */
    static getById(id) {
        const template = db.prepare(`
            SELECT * FROM api_templates WHERE id = ?
        `).get(id);

        return template ? this.parse(template) : null;
    }

    static getByEndpoint(platform, method, baseUrl, templateScope = 'list') {
        const templates = db.prepare(`
            SELECT *
            FROM api_templates
            WHERE platform = ? AND method = ? AND base_url = ? AND template_scope = ?
            ORDER BY id DESC
        `).all(platform, method, baseUrl, templateScope);

        return templates.map(t => this.parse(t));
    }

    /**
     * 根据平台获取模板
     */
    static getByPlatform(platform) {
        const templates = db.prepare(`
            SELECT * FROM api_templates 
            WHERE platform = ? AND is_active = 1
            ORDER BY
                CASE template_scope WHEN 'list' THEN 1 WHEN 'detail' THEN 2 ELSE 3 END,
                CASE WHEN last_used IS NULL THEN 1 ELSE 0 END,
                datetime(last_used) DESC,
                datetime(created_at) DESC,
                id DESC
        `).all(platform).map(t => this.parse(t));

        return this.sortTemplatesByPriority(templates);
    }

    static getByPlatformAndScope(platform, templateScope) {
        const templates = db.prepare(`
            SELECT *
            FROM api_templates
            WHERE platform = ? AND template_scope = ? AND is_active = 1
            ORDER BY
                CASE WHEN last_used IS NULL THEN 1 ELSE 0 END,
                datetime(last_used) DESC,
                datetime(created_at) DESC,
                id DESC
        `).all(platform, templateScope).map(t => this.parse(t));

        return this.sortTemplatesByPriority(templates);
    }

    /**
     * 获取平台首选模板（接口质量优先，其次按最近使用时间）
     */
    static getPreferredByPlatform(platform) {
        return this.getByPlatform(platform)[0] || null;
    }

    static getPreferredByPlatformAndScope(platform, templateScope) {
        return this.getByPlatformAndScope(platform, templateScope)[0] || null;
    }

    static sortTemplatesByPriority(templates = []) {
        return templates.slice().sort((left, right) => {
            const scoreDiff = this.getTemplatePriorityScore(right) - this.getTemplatePriorityScore(left);
            if (scoreDiff !== 0) {
                return scoreDiff;
            }

            const completenessDiff = this.getTemplateCompletenessScore(right) - this.getTemplateCompletenessScore(left);
            if (completenessDiff !== 0) {
                return completenessDiff;
            }

            const lastUsedDiff = this.compareDateDesc(right.lastUsed, left.lastUsed);
            if (lastUsedDiff !== 0) {
                return lastUsedDiff;
            }

            const createdAtDiff = this.compareDateDesc(right.createdAt, left.createdAt);
            if (createdAtDiff !== 0) {
                return createdAtDiff;
            }

            return (right.id || 0) - (left.id || 0);
        });
    }

    static compareDateDesc(leftValue, rightValue) {
        const left = leftValue ? new Date(leftValue).getTime() : 0;
        const right = rightValue ? new Date(rightValue).getTime() : 0;
        return left - right;
    }

    static getTemplatePriorityScore(template = {}) {
        const platform = String(template.platform || '');
        const scope = String(template.templateScope || template.template_scope || 'list');
        const url = String(template.baseUrl || template.base_url || '').toLowerCase();
        let score = 0;

        if (platform === 'didi-charging') {
            if (scope === 'list' && /homepage\/stationlist/.test(url)) {
                score += 100;
                const pageNo = Number(template.bodyParams?.pageNo ?? template.queryParams?.pageNo);
                if (pageNo === 1) {
                    score += 20;
                } else if (Number.isFinite(pageNo) && pageNo > 1) {
                    score -= Math.min(20, pageNo);
                }
            }
            if (scope === 'detail' && /station\/getoneinfo/.test(url)) score += 100;
        }

        if (platform === 'star-charge') {
            if (scope === 'list' && /stubgroup\/list\/query\/nouser/.test(url)) score += 120;
            if (/advertisement\//.test(url)) score -= 120;
            if (/openid\/get/.test(url)) score -= 110;
            if (/search\/filters/.test(url)) score -= 100;
            if (/system\/(info|config)/.test(url)) score -= 100;
            if (/member\/city\/get/.test(url)) score -= 90;

            if (scope === 'detail' && /stubgroupdetailnew\/base\/find\/nouser/.test(url)) score += 120;
            if (scope === 'detail' && /stubgroup\/price\/detail\/nouser/.test(url)) score += 95;
            if (scope === 'detail' && /stubgroupinfo\/extra\/find\/nouser/.test(url)) score += 40;
            if (scope === 'detail' && /placeholder\/rule\/query\/find/.test(url)) score -= 40;
        }

        if (platform === 'kuaidian') {
            if (scope === 'list' && /stationlist/.test(url)) score += 120;
            if (scope === 'detail' && /stationdetail/.test(url)) score += 120;
            if (scope === 'detail' && /getczbconnectorinfolist/.test(url)) score += 95;
            if (scope === 'detail' && /querystationroadbook/.test(url)) score += 30;
        }

        if (platform === 'tuanyou') {
            if (scope === 'list' && /mapgasinfolistpage/.test(url)) score += 120;
            if (scope === 'list' && /getlisttabshowitems/.test(url)) score -= 120;
            if (scope === 'detail' && /getgasgunoilinfov2/.test(url)) score += 120;
            if (scope === 'detail' && /getcombinedetail/.test(url)) score += 90;
        }

        return score;
    }

    static getTemplateCompletenessScore(template = {}) {
        const queryParams = template.queryParams || {};
        const bodyParams = template.bodyParams || {};
        const headers = template.headers || {};
        const variableParams = template.variableParams || {};
        const sensitiveParamKeys = [
            ...Object.keys(queryParams),
            ...Object.keys(bodyParams)
        ].filter(key => this.isSensitiveParamKey(key));
        const sensitiveHeaderKeys = Object.keys(headers).filter(key => this.isSensitiveHeaderKey(key));
        const bindingValues = this.extractTemplateBindingValues(template);
        const expectedKeys = this.getExpectedSensitiveKeys(template);

        let score = 0;
        score += Object.keys(variableParams).length * 4;
        score += Object.keys(queryParams).length * 2;
        score += Object.keys(bodyParams).length * 2;
        score += Object.keys(headers).length * 3;
        score += sensitiveParamKeys.length * 14;
        score += sensitiveHeaderKeys.length * 14;
        score += bindingValues.length * 6;
        score += expectedKeys.params.filter(key =>
            this.objectHasNormalizedKey(queryParams, key) || this.objectHasNormalizedKey(bodyParams, key)
        ).length * 24;
        score += expectedKeys.headers.filter(key => this.objectHasNormalizedKey(headers, key)).length * 24;

        return score;
    }

    /**
     * 平台模板覆盖概览
     */
    static getPlatformCoverage() {
        return db.prepare(`
            SELECT
                platform,
                SUM(CASE WHEN template_scope = 'list' AND is_active = 1 THEN 1 ELSE 0 END) as active_list_templates,
                SUM(CASE WHEN template_scope = 'detail' AND is_active = 1 THEN 1 ELSE 0 END) as active_detail_templates,
                COUNT(*) as total_templates,
                SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) as active_templates,
                MAX(created_at) as latest_created_at,
                MAX(last_used) as latest_used_at
            FROM api_templates
            GROUP BY platform
        `).all().map(row => ({
            platform: row.platform,
            totalTemplates: row.total_templates,
            activeTemplates: row.active_templates,
            activeListTemplates: row.active_list_templates,
            activeDetailTemplates: row.active_detail_templates,
            latestCreatedAt: row.latest_created_at,
            latestUsedAt: row.latest_used_at
        }));
    }

    /**
     * 更新模板
     */
    static update(id, updates) {
        const fields = [];
        const values = [];

        if (updates.name !== undefined) {
            fields.push('name = ?');
            values.push(updates.name);
        }
        if (updates.queryParams !== undefined) {
            fields.push('query_params = ?');
            values.push(JSON.stringify(updates.queryParams));
        }
        if (updates.templateScope !== undefined) {
            fields.push('template_scope = ?');
            values.push(updates.templateScope);
        }
        if (updates.bodyParams !== undefined) {
            fields.push('body_params = ?');
            values.push(JSON.stringify(updates.bodyParams));
        }
        if (updates.variableParams !== undefined) {
            fields.push('variable_params = ?');
            values.push(JSON.stringify(updates.variableParams));
        }
        if (updates.headers !== undefined) {
            fields.push('headers = ?');
            values.push(JSON.stringify(updates.headers));
        }

        fields.push("updated_at = datetime('now', 'localtime')");
        values.push(id);

        const stmt = db.prepare(`
            UPDATE api_templates 
            SET ${fields.join(', ')}
            WHERE id = ?
        `);

        return stmt.run(...values);
    }

    /**
     * 更新最后使用时间
     */
    static updateLastUsed(id) {
        return db.prepare(`
            UPDATE api_templates 
            SET last_used = datetime('now', 'localtime')
            WHERE id = ?
        `).run(id);
    }

    /**
     * 删除模板
     */
    static delete(id) {
        return db.prepare(`
            DELETE FROM api_templates WHERE id = ?
        `).run(id);
    }

    /**
     * 禁用模板
     */
    static disable(id) {
        return db.prepare(`
            UPDATE api_templates 
            SET is_active = 0 
            WHERE id = ?
        `).run(id);
    }

    /**
     * 启用模板
     */
    static enable(id) {
        return db.prepare(`
            UPDATE api_templates 
            SET is_active = 1 
            WHERE id = ?
        `).run(id);
    }

    /**
     * 解析模板数据
     */
    static parse(row) {
        return {
            id: row.id,
            name: row.name,
            platform: row.platform,
            method: row.method,
            baseUrl: row.base_url,
            templateScope: row.template_scope || 'list',
            queryParams: JSON.parse(row.query_params || '{}'),
            bodyParams: JSON.parse(row.body_params || '{}'),
            variableParams: JSON.parse(row.variable_params || '{}'),
            headers: JSON.parse(row.headers || '{}'),
            isActive: Boolean(row.is_active),
            lastUsed: row.last_used,
            createdAt: row.created_at,
            updatedAt: row.updated_at
        };
    }

    /**
     * 批量保存模板
     */
    static saveBatch(templates) {
        const insert = db.transaction((templateList) => {
            let successCount = 0;
            
            for (const template of templateList) {
                try {
                    this.saveSmart(template);
                    successCount++;
                } catch (error) {
                    console.error(`保存模板失败: ${template.name}`, error.message);
                }
            }
            
            return { successCount };
        });
        
        return insert(templates);
    }

    static saveSmart(template) {
        const normalizedTemplate = this.normalizeTemplate(template);
        const templateScope = normalizedTemplate.templateScope || 'list';
        const existingTemplates = this.sortTemplatesByPriority(this.getByEndpoint(
            normalizedTemplate.platform,
            normalizedTemplate.method,
            normalizedTemplate.baseUrl,
            templateScope
        ));

        const identicalTemplate = existingTemplates.find(item => this.isSameTemplateSample(item, normalizedTemplate));
        if (identicalTemplate) {
            return this.update(identicalTemplate.id, this.buildMergedTemplatePayload(identicalTemplate, normalizedTemplate));
        }

        const mergeTarget = this.findMergeTarget(existingTemplates, normalizedTemplate);
        if (mergeTarget) {
            return this.update(mergeTarget.id, this.buildMergedTemplatePayload(mergeTarget, normalizedTemplate));
        }

        if (existingTemplates.length >= this.getMaxSamplesPerEndpoint(normalizedTemplate)) {
            const weakestTemplate = existingTemplates[existingTemplates.length - 1];
            if (
                weakestTemplate
                && this.getTemplateCompletenessScore(normalizedTemplate) > this.getTemplateCompletenessScore(weakestTemplate)
            ) {
                return this.update(weakestTemplate.id, this.buildMergedTemplatePayload(weakestTemplate, normalizedTemplate));
            }

            return {
                changes: 0,
                lastInsertRowid: 0
            };
        }

        return this.save(normalizedTemplate);
    }

    /**
     * 清理模板重复项：同平台 + 方法 + URL + scope 仅保留最新入库记录
     */
    static deduplicateExactTemplates({ dryRun = false } = {}) {
        const templates = db.prepare(`
            SELECT *
            FROM api_templates
        `).all().map(row => this.parse(row));

        const groups = new Map();
        templates.forEach(template => {
            const endpointKey = this.buildTemplateEndpointKey(template);
            if (!groups.has(endpointKey)) {
                groups.set(endpointKey, []);
            }
            groups.get(endpointKey).push(template);
        });

        const removeIds = [];
        const duplicateGroups = [];
        let uniqueCount = 0;

        groups.forEach(group => {
            const ordered = group.slice().sort((left, right) => {
                const leftTs = left.createdAt ? new Date(left.createdAt).getTime() : 0;
                const rightTs = right.createdAt ? new Date(right.createdAt).getTime() : 0;
                if (rightTs !== leftTs) {
                    return rightTs - leftTs;
                }
                return (right.id || 0) - (left.id || 0);
            });

            uniqueCount += 1;
            if (ordered.length <= 1) {
                return;
            }

            const keep = ordered[0];
            const removed = ordered.slice(1);
            const removedIds = removed.map(item => item.id);
            removeIds.push(...removedIds);
            duplicateGroups.push({
                platform: keep.platform,
                method: keep.method,
                baseUrl: keep.baseUrl,
                templateScope: keep.templateScope || 'list',
                keepId: keep.id,
                removedIds
            });
        });

        if (!dryRun && removeIds.length > 0) {
            const deleteStmt = db.prepare(`DELETE FROM api_templates WHERE id = ?`);
            const deleteMany = db.transaction((ids) => {
                ids.forEach(id => deleteStmt.run(id));
            });
            deleteMany(removeIds);
        }

        return {
            dryRun: Boolean(dryRun),
            totalTemplates: templates.length,
            uniqueTemplates: uniqueCount,
            duplicateGroupCount: duplicateGroups.length,
            removedCount: removeIds.length,
            removedIds: removeIds,
            groups: duplicateGroups
        };
    }

    static shouldKeepMultipleSamples(template) {
        const templateScope = template.templateScope || template.template_scope || 'list';
        const pathname = this.safePathname(template.baseUrl);

        if (templateScope === 'list') {
            if (
                template.platform === 'didi-charging'
                && /homepage\/stationlist/i.test(pathname)
                && this.hasSensitiveSignature(template)
            ) {
                return true;
            }
            return false;
        }

        return this.hasSensitiveSignature(template);
    }

    static findMergeTarget(existingTemplates = [], template = {}) {
        if (existingTemplates.length === 0) {
            return null;
        }

        if (!this.shouldKeepMultipleSamples(template)) {
            return existingTemplates[0];
        }

        const bindingKey = this.buildTemplateBindingKey(template);
        if (!bindingKey) {
            return null;
        }

        return existingTemplates.find(item => this.buildTemplateBindingKey(item) === bindingKey) || null;
    }

    static buildMergedTemplatePayload(existingTemplate = {}, incomingTemplate = {}) {
        return {
            name: incomingTemplate.name || existingTemplate.name,
            templateScope: incomingTemplate.templateScope || incomingTemplate.template_scope || existingTemplate.templateScope || 'list',
            queryParams: this.mergeContainers(existingTemplate.queryParams, incomingTemplate.queryParams),
            bodyParams: this.mergeContainers(existingTemplate.bodyParams, incomingTemplate.bodyParams),
            variableParams: this.mergeContainers(existingTemplate.variableParams, incomingTemplate.variableParams),
            headers: this.mergeContainers(existingTemplate.headers, incomingTemplate.headers)
        };
    }

    static mergeContainers(existing = {}, incoming = {}) {
        const merged = { ...(existing || {}) };

        for (const [key, value] of Object.entries(incoming || {})) {
            if (value === undefined || value === null || value === '') {
                if (merged[key] === undefined) {
                    merged[key] = value;
                }
                continue;
            }
            merged[key] = value;
        }

        return merged;
    }

    static normalizeTemplate(template = {}) {
        return {
            ...template,
            templateScope: template.templateScope || template.template_scope || 'list',
            queryParams: template.queryParams && typeof template.queryParams === 'object' ? template.queryParams : {},
            bodyParams: template.bodyParams && typeof template.bodyParams === 'object' ? template.bodyParams : {},
            variableParams: template.variableParams && typeof template.variableParams === 'object' ? template.variableParams : {},
            headers: template.headers && typeof template.headers === 'object' ? template.headers : {}
        };
    }

    static getMaxSamplesPerEndpoint(template = {}) {
        return this.shouldKeepMultipleSamples(template) ? 12 : 1;
    }

    static getExpectedSensitiveKeys(template = {}) {
        const platform = String(template.platform || '');
        const scope = String(template.templateScope || template.template_scope || 'list');
        const pathname = this.safePathname(template.baseUrl).toLowerCase();

        if (platform === 'didi-charging' && scope === 'list' && /homepage\/stationlist/.test(pathname)) {
            return {
                params: ['wsgsig'],
                headers: ['secdd-authentication', 'secdd-challenge', 'xweb_xhr', 'user-agent']
            };
        }

        if (platform === 'didi-charging' && scope === 'detail' && /station\/getoneinfo/.test(pathname)) {
            return {
                params: ['wsgsig'],
                headers: ['secdd-authentication', 'secdd-challenge', 'xweb_xhr']
            };
        }

        if (platform === 'star-charge') {
            return {
                params: ['timestamp', 'nonce'],
                headers: ['x-ca-signature', 'x-ca-timestamp', 'appversion', 'channel-id', 'sid', 'did', 'x-uid', 'positcity']
            };
        }

        if (platform === 'kuaidian') {
            return {
                params: ['timestamp', 'sign'],
                headers: ['xweb_xhr']
            };
        }

        if (platform === 'tuanyou') {
            return {
                params: ['timestamp', 'sign'],
                headers: ['x-tingyun', 'xweb_xhr']
            };
        }

        return { params: [], headers: [] };
    }

    static buildTemplateBindingKey(template = {}) {
        return this.extractTemplateBindingValues(template).join('|');
    }

    static extractTemplateBindingValues(template = {}) {
        const values = new Set();
        const collect = (container = {}) => {
            for (const [key, value] of Object.entries(container || {})) {
                const normalizedKey = this.normalizeKey(key);
                if (
                    [
                        'stationid',
                        'fullstationid',
                        'stationcode',
                        'czbstationid',
                        'gasid',
                        'stubgroupid',
                        'id',
                        'oilno'
                    ].includes(normalizedKey)
                    && value !== undefined
                    && value !== null
                    && value !== ''
                ) {
                    values.add(String(value));
                }
            }
        };

        collect(template.queryParams);
        collect(template.bodyParams);

        return Array.from(values).sort();
    }

    static objectHasNormalizedKey(object = {}, expectedKey) {
        const normalizedExpected = this.normalizeKey(expectedKey);
        return Object.keys(object || {}).some(key => this.normalizeKey(key) === normalizedExpected);
    }

    static hasSensitiveSignature(template) {
        const paramKeys = [
            ...Object.keys(template.queryParams || {}),
            ...Object.keys(template.bodyParams || {})
        ];
        const headerKeys = Object.keys(template.headers || {});

        return paramKeys.some(key => this.isSensitiveParamKey(key))
            || headerKeys.some(key => this.isSensitiveHeaderKey(key));
    }

    static isSensitiveParamKey(key) {
        const normalizedKey = this.normalizeKey(key);
        return normalizedKey === 'wsgsig'
            || normalizedKey === 'nonce'
            || normalizedKey === 'timestamp'
            || normalizedKey.includes('sign')
            || normalizedKey.includes('token');
    }

    static isSensitiveHeaderKey(key) {
        const lowerKey = String(key || '').toLowerCase();
        return lowerKey.startsWith('secdd-')
            || lowerKey.startsWith('x-ca-')
            || [
                'authorization',
                'signature',
                'timestamp',
                'appversion',
                'channel-id',
                'positcity',
                'x-uid',
                'sid',
                'lmdtag',
                'did',
                'userid'
            ].includes(lowerKey);
    }

    static isSameTemplateSample(left, right) {
        return this.stableStringify({
            queryParams: left.queryParams || {},
            bodyParams: left.bodyParams || {},
            variableParams: left.variableParams || {},
            headers: left.headers || {}
        }) === this.stableStringify({
            queryParams: right.queryParams || {},
            bodyParams: right.bodyParams || {},
            variableParams: right.variableParams || {},
            headers: right.headers || {}
        });
    }

    static stableStringify(value) {
        if (Array.isArray(value)) {
            return `[${value.map(item => this.stableStringify(item)).join(',')}]`;
        }
        if (value && typeof value === 'object') {
            return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${this.stableStringify(value[key])}`).join(',')}}`;
        }
        return JSON.stringify(value);
    }

    static buildTemplateFingerprint(template = {}) {
        return [
            String(template.platform || ''),
            String(template.method || ''),
            String(template.baseUrl || ''),
            String(template.templateScope || template.template_scope || 'list'),
            this.stableStringify(template.queryParams || {}),
            this.stableStringify(template.bodyParams || {}),
            this.stableStringify(template.variableParams || {}),
            this.stableStringify(template.headers || {})
        ].join('||');
    }

    static buildTemplateEndpointKey(template = {}) {
        return [
            String(template.platform || ''),
            String(template.method || ''),
            String(template.baseUrl || ''),
            String(template.templateScope || template.template_scope || 'list')
        ].join('||');
    }

    static normalizeKey(key) {
        return String(key || '').replace(/[_-]/g, '').toLowerCase();
    }

    static safePathname(baseUrl) {
        try {
            return new URL(baseUrl).pathname;
        } catch (error) {
            return '';
        }
    }
}

module.exports = ApiTemplateModel;
