'use strict';

const fs = require('fs');
const path = require('path');

/**
 * 模板预检服务
 * 只做模板和签名语料匹配预检，不发真实请求
 */
class TemplatePreflightService {
    constructor(options = {}) {
        this.signatureProvider = options.signatureProvider || null;
        this.templateDir = options.templateDir || path.join(__dirname, '../../data');
    }

    /**
     * 执行 preflight 检查
     * @param {Object} input - { platform, city, lat, lng, mode }
     * @returns {Object} preflight result
     */
    preflight(input = {}) {
        const { platform, city, lat, lng, mode } = input;
        const diagnostics = [];

        // 1. 检查模板
        const templateStats = this._countTemplates();
        if (templateStats.list === 0 && templateStats.detail === 0) {
            return {
                success: false,
                status: 'template_missing',
                templateStats,
                diagnostics: [{
                    code: 'template_missing',
                    message: 'No API templates found in data directory',
                }],
            };
        }

        // 2. 检查签名语料
        const corpusStatus = this._checkCorpus();
        if (!corpusStatus.available) {
            diagnostics.push({
                code: 'signature_corpus_missing',
                message: corpusStatus.message,
                corpusEntries: 0,
            });
            return {
                success: false,
                status: 'signature_corpus_missing',
                templateStats,
                diagnostics,
            };
        }

        // 2.5 检查语料过期（超过30天视为过期，阻止匹配）
        const MAX_CORPUS_AGE_DAYS = 30;
        if (corpusStatus.corpusAgeDays && corpusStatus.corpusAgeDays > MAX_CORPUS_AGE_DAYS) {
            diagnostics.push({
                code: 'signature_corpus_expired',
                message: `请求材料已超过 ${corpusStatus.corpusAgeDays} 天未刷新，需更新后再执行`,
                corpusAgeDays: corpusStatus.corpusAgeDays,
                maxAgeDays: MAX_CORPUS_AGE_DAYS,
                repairSuggestion: '通过请求采集沉淀当前目标的最新请求材料',
            });
            return {
                success: false,
                status: 'signature_corpus_expired',
                templateStats,
                corpusStats: {
                    totalEntries: corpusStatus.totalEntries,
                    corpusAgeDays: corpusStatus.corpusAgeDays,
                },
                diagnostics,
            };
        }

        // 3. 检查坐标有效性
        const targetLat = Number(lat);
        const targetLng = Number(lng);
        if (!Number.isFinite(targetLat) || !Number.isFinite(targetLng)) {
            diagnostics.push({
                code: 'target_scope_required',
                message: 'Valid lat/lng required for preflight',
            });
            return {
                success: false,
                status: 'target_scope_required',
                templateStats,
                diagnostics,
            };
        }

        // 4. 检查语料中是否有当前目标的匹配
        const matchResult = this._checkCorpusMatch(targetLat, targetLng, city, mode, {
            radiusKm: input.radiusKm,
            maxDistanceKm: input.maxDistanceKm
        });
        if (!matchResult.matched) {
            if (matchResult.closestEntry) {
                diagnostics.push({
                    code: 'signed_template_target_mismatch',
                    message: 'Corpus entries exist but do not match target location within maxDistanceKm',
                    templateId: matchResult.closestEntry.source || 'unknown',
                    expectedTarget: {
                        city: city || 'unknown',
                        lat: targetLat,
                        lng: targetLng,
                    },
                    actualTarget: {
                        city: matchResult.closestEntry.city || 'unknown',
                        lat: matchResult.closestEntry.lat,
                        lng: matchResult.closestEntry.lng,
                    },
                    sampleCoordinate: {
                        lat: matchResult.closestEntry.lat,
                        lng: matchResult.closestEntry.lng,
                    },
                    targetCoordinate: {
                        lat: targetLat,
                        lng: targetLng,
                    },
                    distanceKm: matchResult.closestDistance,
                    maxDistanceKm: matchResult.maxDistanceKm,
                    mismatchFields: matchResult.mismatchFields,
                    repairSuggestion: '需要从当前目标重新采集请求语料',
                });
            } else {
                diagnostics.push({
                    code: 'live_request_material_missing',
                    message: 'No corpus entries found for the target scope',
                    expectedTarget: { city: city || 'unknown', lat: targetLat, lng: targetLng },
                });
            }

            const status = matchResult.closestEntry ? 'mismatch' : 'live_request_material_missing';
            return {
                success: false,
                status,
                templateStats,
                corpusStats: {
                    totalEntries: corpusStatus.totalEntries,
                    entriesByCity: corpusStatus.entriesByCity,
                    entriesByScope: corpusStatus.entriesByScope,
                    corpusAgeDays: corpusStatus.corpusAgeDays,
                },
                diagnostics,
            };
        }

        // 5. 匹配成功
        return {
            success: true,
            status: 'matched',
            templateStats,
            corpusStats: {
                totalEntries: corpusStatus.totalEntries,
                entriesByCity: corpusStatus.entriesByCity,
                entriesByScope: corpusStatus.entriesByScope,
                corpusAgeDays: corpusStatus.corpusAgeDays,
            },
            matchedSample: {
                city: matchResult.matchedEntry.city || 'unknown',
                scope: matchResult.matchedEntry.scope || mode || 'unknown',
                distanceKm: matchResult.matchedDistance,
            },
            diagnostics: [],
        };
    }

    _countTemplates() {
        // 查找请求材料文件
        const listTemplates = [];
        const detailTemplates = [];

        // 检查 smart-crawler 内嵌模板
        try {
            const SmartCrawler = require('../crawler/smart-crawler');
            // SmartCrawler 的模板在构造时从内置数据加载
            // 这里我们直接检查 data 目录下的模板相关文件
        } catch {}

        // 从 corpus 中统计 list/detail 条目
        const corpus = this._loadCorpus();
        if (corpus && Array.isArray(corpus)) {
            for (const entry of corpus) {
                if (entry.scope === 'list') listTemplates.push(entry);
                else if (entry.scope === 'detail') detailTemplates.push(entry);
            }
        }

        return {
            list: listTemplates.length,
            detail: detailTemplates.length,
        };
    }

    _checkCorpus() {
        const corpus = this._loadCorpus();
        if (!corpus || !Array.isArray(corpus) || corpus.length === 0) {
            return {
                available: false,
                message: 'Signature corpus not found or empty',
                totalEntries: 0,
            };
        }

        // 借助 signature provider 的健康检查
        if (this.signatureProvider && typeof this.signatureProvider.getHealthStatus === 'function') {
            try {
                const health = this.signatureProvider.getHealthStatus();
                return {
                    available: true,
                    totalEntries: health.totalEntries,
                    entriesByCity: health.entriesByCity,
                    entriesByScope: health.entriesByScope,
                    corpusAgeDays: health.corpusAgeDays,
                    status: health.status,
                };
            } catch {}
            // health 检查失败时手动计算 corpusAgeDays
            return {
                available: true,
                totalEntries: corpus.length,
                corpusAgeDays: this._computeCorpusAge(corpus),
            };
        }

        return {
            available: true,
            totalEntries: corpus.length,
            message: 'Corpus loaded (no health check from provider)',
            corpusAgeDays: this._computeCorpusAge(corpus),
        };
    }

    _loadCorpus() {
        const corpusPath = path.join(this.templateDir, 'didi-signature-corpus.json');
        try {
            const content = fs.readFileSync(corpusPath, 'utf8');
            const data = JSON.parse(content);
            // corpus 格式: { meta, entries } 或直接数组
            if (Array.isArray(data)) return data;
            if (data && Array.isArray(data.entries)) return data.entries;
            return null;
        } catch {
            return null;
        }
    }

    _checkCorpusMatch(targetLat, targetLng, city, mode, options = {}) {
        const corpus = this._loadCorpus();
        if (!corpus || !Array.isArray(corpus)) {
            return { matched: false, closestEntry: null };
        }

        const configuredDistanceKm = this.signatureProvider
            ? (this.signatureProvider.maxDistanceKm || 50)
            : 50;
        const requestedDistanceKm = Number(options.maxDistanceKm || options.radiusKm || 0);
        const maxDistanceKm = this._effectiveMaxDistanceKm(configuredDistanceKm, requestedDistanceKm);

        let closestEntry = null;
        let closestDistance = Infinity;
        let matchedEntry = null;
        let matchedDistance = Infinity;

        for (const entry of corpus) {
            const entryLat = Number(entry.lat);
            const entryLng = Number(entry.lng);
            if (!Number.isFinite(entryLat) || !Number.isFinite(entryLng)) continue;

            const dist = this._haversineKm(targetLat, targetLng, entryLat, entryLng);

            if (dist < closestDistance) {
                closestDistance = dist;
                closestEntry = entry;
            }

            if (dist <= maxDistanceKm && dist < matchedDistance) {
                // 城市匹配：如果用户指定了city，entry必须有city且匹配
                if (city) {
                    if (!entry.city || !this._cityMatch(city, entry.city)) continue;
                }
                // 检查 scope 匹配
                if (mode && entry.scope && mode !== entry.scope) continue;

                matchedDistance = dist;
                matchedEntry = entry;
            }
        }

        if (matchedEntry) {
            return { matched: true, matchedEntry, matchedDistance, maxDistanceKm };
        }

        // 构建 mismatchFields
        const mismatchFields = [];
        if (closestEntry) {
            if (closestDistance > maxDistanceKm) {
                mismatchFields.push('distance');
            }
            if (city && closestEntry.city && !this._cityMatch(city, closestEntry.city)) {
                mismatchFields.push('city');
            }
            if (mode && closestEntry.scope && mode !== closestEntry.scope) {
                mismatchFields.push('scope');
            }
        }

        return {
            matched: false,
            closestEntry,
            closestDistance,
            maxDistanceKm,
            mismatchFields: mismatchFields.length > 0 ? mismatchFields : ['distance'],
        };
    }

    _cityMatch(targetCity, entryCity) {
        if (!targetCity || !entryCity) return false; // 缺少城市信息时不放行
        const t = targetCity.replace(/[市区县]/g, '');
        const e = entryCity.replace(/[市区县]/g, '');
        return t.includes(e) || e.includes(t);
    }

    _effectiveMaxDistanceKm(configuredDistanceKm, requestedDistanceKm) {
        const configured = Number(configuredDistanceKm);
        const requested = Number(requestedDistanceKm);
        const base = Number.isFinite(configured) && configured > 0 ? configured : 10;
        if (!Number.isFinite(requested) || requested <= 0) {
            return base;
        }
        return Math.min(Math.max(base, requested), 50);
    }

    _haversineKm(lat1, lng1, lat2, lng2) {
        const R = 6371;
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLng = (lng2 - lng1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) ** 2
            + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180)
            * Math.sin(dLng / 2) ** 2;
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        return R * c;
    }

    _computeCorpusAge(corpus) {
        if (!corpus || !Array.isArray(corpus) || corpus.length === 0) return Infinity;
        let newest = 0;
        for (const entry of corpus) {
            const ts = entry.capturedAt || entry.sourceTime || '';
            if (!ts) continue;
            const d = new Date(ts.replace(/\//g, '-'));
            if (!isNaN(d.getTime()) && d.getTime() > newest) newest = d.getTime();
        }
        if (newest === 0) return Infinity;
        return (Date.now() - newest) / (1000 * 60 * 60 * 24);
    }

}

module.exports = TemplatePreflightService;
