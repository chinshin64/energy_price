const fs = require('fs');
const path = require('path');

/**
 * 签名健康度监控 & 语料库管理（M1 + M4）
 *
 * M1: 定时检查各平台签名有效时间戳，距过期<24h黄灯告警，已过期红灯告警
 * M4: 语料TTL标记，过期>14天自动标记为不可用，清理过期签名
 */

const SIGNATURE_TTL_DAYS = 14;
const WARNING_HOURS_BEFORE_EXPIRY = 24;

// 6个平台的签名健康度配置
const PLATFORM_HEALTH_CONFIG = {
    'didi-charging': { name: '滴滴充电', signatureType: 'wsgsig', ttlDays: SIGNATURE_TTL_DAYS },
    'teld': { name: '特来电', signatureType: 'token', ttlDays: SIGNATURE_TTL_DAYS },
    'star-charge': { name: '星星充电', signatureType: 'sign', ttlDays: SIGNATURE_TTL_DAYS },
    'kuaidian': { name: '快电', signatureType: 'token+sign', ttlDays: SIGNATURE_TTL_DAYS },
    'tuanyou': { name: '团油', signatureType: 'token+sign', ttlDays: SIGNATURE_TTL_DAYS },
    'ykc': { name: '云快充', signatureType: 'token+sign', ttlDays: SIGNATURE_TTL_DAYS }
};

class SignatureHealthMonitor {
    constructor(options = {}) {
        this.corpusPath = options.corpusPath
            || process.env.DIDI_SIGNATURE_CORPUS_PATH
            || path.join(__dirname, '../../data/didi-signature-corpus.json');
        this.ttlDays = options.ttlDays || SIGNATURE_TTL_DAYS;
        this.warningHours = options.warningHours || WARNING_HOURS_BEFORE_EXPIRY;
        this.checkIntervalMs = options.checkIntervalMs || 60 * 60 * 1000; // 默认每小时
        this._timer = null;
        this._lastCheck = null;
        this._lastResults = null;
    }

    // ============ M1: 健康度监控 ============

    /**
     * 启动定时检查
     */
    startPeriodicCheck() {
        if (this._timer) return;
        // 立即执行一次
        this.performCheck();
        this._timer = setInterval(() => {
            this.performCheck();
        }, this.checkIntervalMs);
        console.log(`[SignatureHealth] 定时检查已启动，间隔 ${this.checkIntervalMs / 1000}s`);
    }

    /**
     * 停止定时检查
     */
    stopPeriodicCheck() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
            console.log('[SignatureHealth] 定时检查已停止');
        }
    }

    /**
     * 执行一次健康度检查
     */
    performCheck() {
        const results = this.checkAllPlatforms();
        this._lastCheck = new Date().toISOString();
        this._lastResults = results;

        const alerts = results.filter(r => r.status !== 'green');
        if (alerts.length > 0) {
            const summary = alerts.map(r =>
                `${r.platform}(${r.status === 'red' ? '过期' : '即将过期'})`
            ).join(', ');
            console.log(`[SignatureHealth] ⚠️ 告警: ${summary}`);
        } else {
            console.log('[SignatureHealth] ✅ 全部平台签名健康');
        }

        return results;
    }

    /**
     * 检查所有6个平台的签名健康度
     * @returns {Array} 各平台健康状态
     */
    checkAllPlatforms() {
        const corpus = this.loadCorpus();
        const now = new Date();
        const results = [];

        for (const [platformId, config] of Object.entries(PLATFORM_HEALTH_CONFIG)) {
            const result = this.checkPlatform(platformId, config, corpus, now);
            results.push(result);
        }

        return results;
    }

    /**
     * 检查单个平台的签名健康度
     * @returns {object} 平台健康状态
     */
    checkPlatform(platformId, config, corpus, now) {
        const entries = corpus.filter(e => e.platform === platformId && e.active !== false);
        const ttlMs = this.ttlDays * 24 * 60 * 60 * 1000;
        const warningMs = this.warningHours * 60 * 60 * 1000;

        let latestTimestamp = null;
        let latestEntry = null;
        let totalEntries = entries.length;
        let activeEntries = 0;
        let expiringEntries = 0;
        let expiredEntries = 0;

        for (const entry of entries) {
            const ts = this.parseEntryTimestamp(entry);
            if (!ts) continue;

            const ageMs = now.getTime() - ts.getTime();
            const remainingMs = ttlMs - ageMs;

            if (remainingMs > 0) {
                activeEntries++;
                if (remainingMs < warningMs) {
                    expiringEntries++;
                }
            } else {
                expiredEntries++;
            }

            if (!latestTimestamp || ts.getTime() > latestTimestamp.getTime()) {
                latestTimestamp = ts;
                latestEntry = entry;
            }
        }

        let status = 'green';
        let statusMessage = '正常';
        let remainingHours = null;

        if (latestTimestamp) {
            const latestAgeMs = now.getTime() - latestTimestamp.getTime();
            remainingHours = Math.max(0, (ttlMs - latestAgeMs) / (60 * 60 * 1000));

            if (remainingHours <= 0) {
                status = 'red';
                statusMessage = '签名已过期';
            } else if (remainingHours < this.warningHours) {
                status = 'yellow';
                statusMessage = `签名将在 ${Math.round(remainingHours)}h 后过期`;
            }
        } else {
            status = 'red';
            statusMessage = '无签名数据';
        }

        return {
            platform: platformId,
            name: config.name,
            signatureType: config.signatureType,
            status,
            statusMessage,
            totalEntries,
            activeEntries,
            expiringEntries,
            expiredEntries,
            latestTimestamp: latestTimestamp ? latestTimestamp.toISOString() : null,
            remainingHours: remainingHours !== null ? Math.round(remainingHours * 10) / 10 : null,
            latestCapturedAt: latestEntry?.capturedAt || null
        };
    }

    /**
     * 获取单平台详情
     */
    getPlatformStatus(platformId) {
        const config = PLATFORM_HEALTH_CONFIG[platformId];
        if (!config) return null;

        const corpus = this.loadCorpus();
        const now = new Date();
        const health = this.checkPlatform(platformId, config, corpus, now);

        const entries = corpus.filter(e => e.platform === platformId);
        const ttlMs = this.ttlDays * 24 * 60 * 60 * 1000;

        const samples = entries.map(entry => {
            const ts = this.parseEntryTimestamp(entry);
            const ageMs = ts ? now.getTime() - ts.getTime() : null;
            const remainingMs = ageMs !== null ? ttlMs - ageMs : null;

            return {
                scope: entry.scope || 'unknown',
                city: entry.city || '',
                capturedAt: entry.capturedAt || null,
                active: entry.active !== false,
                ageDays: ageMs !== null ? Math.round(ageMs / (24 * 60 * 60 * 1000) * 10) / 10 : null,
                remainingHours: remainingMs !== null ? Math.round(remainingMs / (60 * 60 * 1000) * 10) / 10 : null,
                hasSignature: this.entryHasSignature(entry, config.signatureType)
            };
        });

        return {
            ...health,
            samples
        };
    }

    // ============ M4: 语料库管理 ============

    /**
     * 标记过期签名为不可用（>14天）
     */
    markExpiredEntries() {
        const corpus = this.loadCorpus();
        const now = new Date();
        const ttlMs = this.ttlDays * 24 * 60 * 60 * 1000;
        let markedCount = 0;

        for (const entry of corpus) {
            if (entry.active === false) continue; // 已经不可用

            const ts = this.parseEntryTimestamp(entry);
            if (!ts) continue;

            const ageMs = now.getTime() - ts.getTime();
            if (ageMs > ttlMs) {
                entry.active = false;
                entry.expiredAt = now.toISOString();
                markedCount++;
            }
        }

        if (markedCount > 0) {
            this.saveCorpus(corpus);
        }

        return { markedCount, totalEntries: corpus.length };
    }

    /**
     * 清理过期签名（删除不可用的条目）
     */
    cleanupExpiredEntries() {
        const corpus = this.loadCorpus();
        const now = new Date();
        const ttlMs = this.ttlDays * 24 * 60 * 60 * 1000;

        const before = corpus.length;
        const remaining = corpus.filter(entry => {
            if (entry.active === false) return false;
            const ts = this.parseEntryTimestamp(entry);
            if (!ts) return true; // 无法判断时间戳的保留
            const ageMs = now.getTime() - ts.getTime();
            return ageMs <= ttlMs;
        });
        const removedCount = before - remaining.length;

        if (removedCount > 0) {
            this.saveCorpus(remaining);
        }

        return { removedCount, remainingCount: remaining.length, beforeCount: before };
    }

    /**
     * 为语料条目补充 createdAt 字段（兼容旧数据）
     */
    backfillCreatedAt() {
        const corpus = this.loadCorpus();
        let backfilledCount = 0;

        for (const entry of corpus) {
            if (!entry.createdAt) {
                const ts = this.parseEntryTimestamp(entry);
                entry.createdAt = ts ? ts.toISOString() : new Date().toISOString();
                backfilledCount++;
            }
        }

        if (backfilledCount > 0) {
            this.saveCorpus(corpus);
        }

        return { backfilledCount, totalEntries: corpus.length };
    }

    // ============ 内部工具 ============

    loadCorpus() {
        try {
            const raw = fs.readFileSync(this.corpusPath, 'utf8');
            const payload = JSON.parse(raw);
            const entries = payload.entries || payload;
            return Array.isArray(entries) ? entries : [];
        } catch (error) {
            return [];
        }
    }

    saveCorpus(entries) {
        try {
            const raw = fs.readFileSync(this.corpusPath, 'utf8');
            const payload = JSON.parse(raw);
            if (Array.isArray(payload.entries)) {
                payload.entries = entries;
                fs.writeFileSync(this.corpusPath, JSON.stringify(payload, null, 2), 'utf8');
            } else {
                fs.writeFileSync(this.corpusPath, JSON.stringify(entries, null, 2), 'utf8');
            }
        } catch (error) {
            // 如果原文件格式异常，直接写入数组
            const wrapper = { meta: { updatedAt: new Date().toISOString() }, entries };
            fs.writeFileSync(this.corpusPath, JSON.stringify(wrapper, null, 2), 'utf8');
        }
    }

    /**
     * 解析条目的时间戳
     * 支持格式：ISO / "2026/05/11 11:47:57" / capturedAt
     */
    parseEntryTimestamp(entry) {
        const candidates = [
            entry.capturedAt,
            entry.createdAt,
            entry.timestamp
        ];

        for (const candidate of candidates) {
            if (!candidate) continue;
            const parsed = this.parseTimestampString(candidate);
            if (parsed) return parsed;
        }

        return null;
    }

    parseTimestampString(value) {
        if (!value) return null;

        // ISO 格式
        const isoDate = new Date(value);
        if (!isNaN(isoDate.getTime())) {
            return isoDate;
        }

        // "2026/05/11 11:47:57" 格式
        const slashMatch = String(value).match(/^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
        if (slashMatch) {
            const [, y, m, d, h, min, s] = slashMatch;
            return new Date(Date.UTC(+y, +m - 1, +d, +h, +min, +s));
        }

        return null;
    }

    entryHasSignature(entry, signatureType) {
        const qp = entry.queryParams || entry.query || {};
        const bp = entry.bodyParams || entry.body || {};
        const headers = entry.headers || {};

        switch (signatureType) {
            case 'wsgsig':
                return Boolean(qp.wsgsig || qp._wsgsig);
            case 'token':
                return Boolean(qp.token || qp.tokenId || headers.token);
            case 'sign':
                return Boolean(qp.sign || headers.sign);
            case 'token+sign':
                return Boolean(qp.token || headers.token || qp.sign || headers.sign);
            default:
                return false;
        }
    }
}

module.exports = SignatureHealthMonitor;
