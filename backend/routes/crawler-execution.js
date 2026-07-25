'use strict';

const express = require('express');
const DefaultSmartCrawler = require('../crawler/smart-crawler');

function normalizeCrawlMode(value) {
    const mode = String(value || 'both').toLowerCase();
    return ['list', 'detail', 'both'].includes(mode) ? mode : null;
}

function normalizeTestMode(value) {
    return value === true || value === 'true' || value === 1 || value === '1';
}

function normalizeTargetRequestParams(raw = null) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return null;
    }

    const normalizeObject = (value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return {};
        }

        return Object.entries(value).reduce((result, [key, entryValue]) => {
            if (!key || entryValue === undefined || entryValue === null) {
                return result;
            }
            if (typeof entryValue === 'object') {
                return result;
            }
            result[String(key)] = entryValue;
            return result;
        }, {});
    };

    const normalizeMaterial = (value = {}) => {
        const material = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
        const normalized = {
            queryParams: normalizeObject(material.queryParams || material.query || {}),
            bodyParams: normalizeObject(material.bodyParams || material.body || {}),
            headers: normalizeObject(material.headers || {})
        };
        for (const key of ['method', 'baseUrl', 'url', 'lat', 'lng', 'pageNo', 'city', 'keyword', 'capturedAt', 'createdAt', 'stationId', 'fullStationId']) {
            const entryValue = material[key];
            if (entryValue !== undefined && entryValue !== null && typeof entryValue !== 'object') {
                normalized[key] = entryValue;
            }
        }
        return normalized;
    };

    const direct = normalizeMaterial(raw);
    const scoped = {};
    for (const scope of ['list', 'detail']) {
        if (raw[scope] && typeof raw[scope] === 'object' && !Array.isArray(raw[scope])) {
            scoped[scope] = normalizeMaterial(raw[scope]);
        }
    }

    const hasDirect = Object.keys(direct.queryParams).length > 0
        || Object.keys(direct.bodyParams).length > 0
        || Object.keys(direct.headers).length > 0;

    return {
        ...(hasDirect ? direct : {}),
        ...scoped
    };
}

function normalizeTargetLocation(raw = {}, centerLat = null, centerLng = null) {
    const input = raw && typeof raw === 'object' ? raw : {};
    const lat = Number(input.lat ?? centerLat);
    const lng = Number(input.lng ?? centerLng);

    return {
        keyword: String(input.keyword || input.name || '').trim(),
        name: String(input.name || input.keyword || '').trim(),
        province: String(input.province || '').trim(),
        city: String(input.city || '').trim(),
        district: String(input.district || '').trim(),
        coordinateSystem: ['WGS84', 'GCJ02'].includes(String(input.coordinateSystem || '').toUpperCase())
            ? String(input.coordinateSystem).toUpperCase()
            : null,
        lat: Number.isFinite(lat) ? lat : null,
        lng: Number.isFinite(lng) ? lng : null,
        requestParams: normalizeTargetRequestParams(
            input.requestParams
            || input.actualRequestParams
            || input.didiRequestParams
            || null
        )
    };
}

function dedupeSeedStations(stations = []) {
    const bestByKey = new Map();

    for (const station of stations) {
        const key = [
            station.platform || '',
            station.station_id || station.stationId || '',
            station.station_name || station.stationName || '',
            station.latitude || '',
            station.longitude || ''
        ].join('|');

        if (!bestByKey.has(key)) {
            bestByKey.set(key, station);
        }
    }

    return Array.from(bestByKey.values());
}

function getStationCoordinate(station) {
    const lat = Number(station.latitude ?? station.lat);
    const lng = Number(station.longitude ?? station.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return null;
    }
    return { lat, lng };
}

function calculateDistanceKm(lat1, lng1, lat2, lng2) {
    const toRad = (value) => value * Math.PI / 180;
    const earthRadiusKm = 6371;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
        Math.sin(dLat / 2) ** 2
        + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return earthRadiusKm * c;
}

function filterStationsByRadius(stations = [], centerLat, centerLng, radiusKm) {
    const lat = Number(centerLat);
    const lng = Number(centerLng);
    const radius = Math.max(0.1, Number(radiusKm) || 10);

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return stations;
    }

    return stations.filter((station) => {
        const coord = getStationCoordinate(station);
        if (!coord) {
            return false;
        }
        return calculateDistanceKm(lat, lng, coord.lat, coord.lng) <= radius;
    });
}

function normalizeCoordinateTargetLocations(rawTargetLocations = [], fallbackLocation = null, centerLat = null, centerLng = null) {
    const source = rawTargetLocations.length > 0
        ? rawTargetLocations
        : [fallbackLocation || { lat: centerLat, lng: centerLng }];

    return source
        .map((item, index) => {
            const normalized = normalizeTargetLocation(item, item?.lat ?? centerLat, item?.lng ?? centerLng);
            const lat = Number(normalized.lat);
            const lng = Number(normalized.lng);
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
                return null;
            }

            const label = normalized.keyword || normalized.name || normalized.city || `目标${index + 1}`;
            return {
                ...normalized,
                keyword: normalized.keyword || label,
                name: normalized.name || label,
                lat,
                lng,
                index: index + 1
            };
        })
        .filter(Boolean);
}

function formatTargetLocationLabel(target = {}) {
    return [target.province, target.city, target.district, target.keyword || target.name]
        .filter(Boolean)
        .join(' / ') || `${target.lat},${target.lng}`;
}

function createCrawlerExecutionRouter(options = {}) {
    const smartCrawler = options.smartCrawler;
    const SmartCrawlerClass = options.SmartCrawlerClass || DefaultSmartCrawler;
    const stationModel = options.stationModel;
    const apiTemplateModel = options.apiTemplateModel;
    const runHistoryModel = options.runHistoryModel;
    const harParser = options.harParser;
    const selfHealService = options.selfHealService;
    const templateApplicationService = options.templateApplicationService;
    const scheduleImmediate = typeof options.scheduleImmediate === 'function'
        ? options.scheduleImmediate
        : callback => setImmediate(callback);
    const logger = options.logger || console;

    if (!smartCrawler || !SmartCrawlerClass || !stationModel || !apiTemplateModel
        || !runHistoryModel || !harParser || !selfHealService || !templateApplicationService) {
        throw new TypeError('crawler execution router dependencies are required');
    }

    const router = express.Router();

    function getTemplatesByMode(platform, crawlMode) {
        const listTemplates = crawlMode === 'detail' ? [] : apiTemplateModel.getByPlatformAndScope(platform, 'list');
        const detailTemplates = crawlMode === 'list' ? [] : apiTemplateModel.getByPlatformAndScope(platform, 'detail');
        return { listTemplates, detailTemplates };
    }

    async function runPlatformCrawl({
        platform,
        crawlMode,
        coordinates,
        centerLat,
        centerLng,
        radius,
        pageSize,
        maxPages,
        runId,
        testMode = false,
        runQuota = null,
        proxyContext = null,
        progressReporter = null
    }) {
        const { listTemplates, detailTemplates } = getTemplatesByMode(platform, crawlMode);
        const maxListTemplatesToTry = platform === 'didi-charging' ? 3 : 1;
        const executedListTemplates = listTemplates.slice(0, maxListTemplatesToTry);
        const executedDetailTemplates = platform === 'didi-charging'
            ? detailTemplates.slice(0, 1)
            : detailTemplates;
        const log = (message, level = 'info') => runHistoryModel.appendLog(runId, `[${platform}] ${message}`, level);
        const requestBudget = testMode ? smartCrawler.createTestRequestBudget(platform) : null;

        if (executedListTemplates.length === 0 && executedDetailTemplates.length === 0) {
            log('无可用模板', 'warn');
            return { success: false, reason: 'no_active_template' };
        }

        if (requestBudget) {
            log(`调试请求保护开启：平台请求上限 ${requestBudget.limit} 次`);
        }

        if (listTemplates.length > executedListTemplates.length && executedListTemplates[0]) {
            log(`列表模板共 ${listTemplates.length} 条，按优先级执行前 ${executedListTemplates.length} 条候选模板`);
        }
        if (platform === 'didi-charging' && executedListTemplates.length > 1) {
            log('滴滴列表模板启用候选校验：若当前模板无数据将在 API 能力内复测下一个候选模板', 'warn');
        }
        if (platform === 'didi-charging' && detailTemplates.length > executedDetailTemplates.length) {
            log(`滴滴详情模板共 ${detailTemplates.length} 条，当前只执行 1 条 getoneinfo 模板，避免重复详情请求触发 501`, 'warn');
        }

        const listStations = [];
        const detailStations = [];
        let attemptedListTemplateCount = 0;
        let signedTemplateMismatchCount = 0;
        const signedTemplateMismatchMessages = [];

        for (const template of executedListTemplates) {
            attemptedListTemplateCount += 1;
            log(`执行列表模板 #${template.id}: ${template.baseUrl}`);
            const signedTargetMismatch = smartCrawler.getSignedTemplateTargetMismatch(template, proxyContext);
            if (signedTargetMismatch) {
                signedTemplateMismatchCount += 1;
                signedTemplateMismatchMessages.push(signedTargetMismatch);
                log(signedTargetMismatch, 'warn');
                continue;
            }

            let stations = [];
            try {
                stations = await smartCrawler.crawl(template, {
                    coordinates,
                    radiusKm: radius,
                    pageSize,
                    maxPages,
                    logger: log,
                    requestBudget,
                    runQuota,
                    proxyContext,
                    progressReporter
                });
            } catch (error) {
                log(`列表模板 #${template.id} 执行失败: ${error.message}`, 'error');
                if (
                    smartCrawler.isRunRequestLimitExceeded(error)
                    || smartCrawler.isTestRequestBudgetExceeded(error)
                    || platform !== 'didi-charging'
                ) {
                    throw error;
                }
                stations = [];
            }

            listStations.push(...stations);

            if (stations.length > 0) {
                apiTemplateModel.updateLastUsed(template.id);
                log(`列表模板 #${template.id} 完成，解析 ${stations.length} 条`);
                if (platform === 'didi-charging') {
                    log(`滴滴列表模板 #${template.id} 命中可用数据，停止后续模板切换`);
                    break;
                }
            } else {
                log(`列表模板 #${template.id} 未解析到数据`, 'warn');
            }

            if (requestBudget && !smartCrawler.hasTestRequestBudgetRemaining(requestBudget)) {
                log(`调试请求保护已达上限，停止后续模板: ${smartCrawler.formatTestRequestBudget(requestBudget)}`, 'warn');
                break;
            }
            if (runQuota && !smartCrawler.hasRunRequestQuotaRemaining(runQuota)) {
                log(`当次请求已达上限，停止后续模板: ${smartCrawler.formatRunRequestQuota(runQuota)}`, 'warn');
                break;
            }
        }

        let detailSeeds = [];
        if (executedDetailTemplates.length > 0) {
            const nearbyStoredSeeds = dedupeSeedStations(
                stationModel.getNearbySeeds(platform, centerLat, centerLng, radius, 1000)
            );
            const currentRunSeedsInRadius = dedupeSeedStations(
                filterStationsByRadius(listStations, centerLat, centerLng, radius)
            );
            const currentRunSeeds = currentRunSeedsInRadius.length > 0
                ? currentRunSeedsInRadius
                : dedupeSeedStations(listStations);

            detailSeeds = currentRunSeeds.length > 0 ? currentRunSeeds : nearbyStoredSeeds;

            if (currentRunSeedsInRadius.length === 0 && currentRunSeeds.length > 0) {
                log('列表结果未命中半径过滤，回退使用当前批次列表场站作为详情种子', 'warn');
            } else if (currentRunSeeds.length === 0 && nearbyStoredSeeds.length > 0) {
                log('当前批次列表无可用详情种子，回退使用历史半径内场站', 'warn');
            }

            log(`详情种子场站 ${detailSeeds.length} 条`);

            if (detailSeeds.length === 0) {
                log('没有可用的详情种子场站，跳过详情模板', 'warn');
            }
        }

        for (const template of executedDetailTemplates) {
            if (detailSeeds.length === 0) {
                break;
            }

            if (requestBudget && !smartCrawler.hasTestRequestBudgetRemaining(requestBudget)) {
                log(`调试请求保护已达上限，跳过后续详情模板: ${smartCrawler.formatTestRequestBudget(requestBudget)}`, 'warn');
                break;
            }
            if (runQuota && !smartCrawler.hasRunRequestQuotaRemaining(runQuota)) {
                log(`当次请求已达上限，跳过后续详情模板: ${smartCrawler.formatRunRequestQuota(runQuota)}`, 'warn');
                break;
            }

            log(`执行详情模板 #${template.id}: ${template.baseUrl}`);
            const stations = await smartCrawler.crawlDetail(template, {
                seedStations: detailSeeds,
                logger: log,
                requestBudget,
                runQuota,
                proxyContext,
                progressReporter
            });
            apiTemplateModel.updateLastUsed(template.id);
            detailStations.push(...stations);
            log(`详情模板 #${template.id} 完成，解析 ${stations.length} 条`);
        }

        const stations = harParser.deduplicateStations([...listStations, ...detailStations]);
        const radiusFilteredStations = platform === 'didi-charging'
            ? filterStationsByRadius(stations, centerLat, centerLng, radius)
            : stations;
        const stationsForInsert = radiusFilteredStations.length > 0 ? radiusFilteredStations : stations;
        if (platform === 'didi-charging' && radiusFilteredStations.length > 0 && radiusFilteredStations.length < stations.length) {
            log(`半径过滤: ${stations.length} -> ${radiusFilteredStations.length} 条`);
        }
        const insertResult = stationsForInsert.length > 0
            ? stationModel.insertBatch(stationsForInsert)
            : { successCount: 0, skipCount: 0 };
        const allListTemplatesSkippedBySignature = attemptedListTemplateCount > 0
            && signedTemplateMismatchCount === attemptedListTemplateCount
            && listStations.length === 0
            && detailStations.length === 0;

        return {
            success: !allListTemplatesSkippedBySignature,
            reason: allListTemplatesSkippedBySignature ? 'signed_template_target_mismatch' : undefined,
            diagnostics: signedTemplateMismatchMessages.length > 0
                ? {
                    signedTemplateTargetMismatch: signedTemplateMismatchMessages
                }
                : undefined,
            crawlMode,
            listTemplateCount: attemptedListTemplateCount,
            listTemplateCandidateCount: listTemplates.length,
            detailTemplateCount: executedDetailTemplates.length,
            detailTemplateCandidateCount: detailTemplates.length,
            listStationCount: listStations.length,
            detailStationCount: detailStations.length,
            stationCount: stationsForInsert.length,
            insertedCount: insertResult.successCount || 0,
            skippedCount: insertResult.skipCount || 0,
            testMode: Boolean(requestBudget),
            requestBudget: smartCrawler.getTestRequestBudgetSummary(requestBudget),
            quotaStats: smartCrawler.getQuotaStatsSummary(),
            runQuota: smartCrawler.getRunRequestQuotaSummary(runQuota, { includeRequests: false })
        };
    }

    function createAggregateRunQuota(requestedRunLimit, targetCount = 1) {
        const perTargetQuota = smartCrawler.createRunRequestQuota(requestedRunLimit);
        if (perTargetQuota.unlimited) {
            return smartCrawler.createRunRequestQuota(null);
        }
        const aggregateQuota = smartCrawler.createRunRequestQuota(perTargetQuota.limit * Math.max(1, Number(targetCount) || 1));
        aggregateQuota.perTargetLimit = perTargetQuota.limit;
        aggregateQuota.targetCount = Math.max(1, Number(targetCount) || 1);
        aggregateQuota.quotaMode = 'per-target';
        return aggregateQuota;
    }

    function createCoordinateCrawlJob(body = {}) {
        const {
            platforms,
            centerLat,
            centerLng,
            radius = 10,
            gridSize = 2,
            pageSize = 20,
            maxPages = 5,
            crawlMode: rawCrawlMode = 'both',
            testMode,
            targetLocation
        } = body;

        if (!Array.isArray(platforms) || platforms.length === 0) {
            const error = new Error('platforms required');
            error.statusCode = 400;
            throw error;
        }

        const rawTargetLocations = Array.isArray(body.targetLocations) ? body.targetLocations : [];
        let lat = centerLat === null || centerLat === undefined || centerLat === '' ? NaN : Number(centerLat);
        let lng = centerLng === null || centerLng === undefined || centerLng === '' ? NaN : Number(centerLng);
        if (!Number.isFinite(lat) && rawTargetLocations.length > 0) {
            lat = Number(rawTargetLocations[0]?.lat);
        }
        if (!Number.isFinite(lng) && rawTargetLocations.length > 0) {
            lng = Number(rawTargetLocations[0]?.lng);
        }
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
            const error = new Error('invalid centerLat or centerLng');
            error.statusCode = 400;
            throw error;
        }

        const crawlMode = normalizeCrawlMode(rawCrawlMode);
        if (!crawlMode) {
            const error = new Error('crawlMode must be list, detail, or both');
            error.statusCode = 400;
            throw error;
        }

        const targetLocations = normalizeCoordinateTargetLocations(rawTargetLocations, targetLocation, lat, lng);
        if (targetLocations.length === 0) {
            const error = new Error('targetLocations required');
            error.statusCode = 400;
            throw error;
        }

        const proxyContext = targetLocations[0];
        const radiusValue = Number(radius) || 10;
        const gridSizeValue = Number(gridSize) || 2;
        const pageSizeValue = Number(pageSize) || 20;
        const maxPagesValue = Number(maxPages) || 5;
        const normalizedTestMode = normalizeTestMode(testMode);

        const runId = runHistoryModel.startRun('crawl-platforms-with-coordinates', {
            platforms,
            centerLat: lat,
            centerLng: lng,
            radius: radiusValue,
            gridSize: gridSizeValue,
            pageSize: pageSizeValue,
            maxPages: maxPagesValue,
            crawlMode,
            testMode: normalizedTestMode,
            targetLocation: proxyContext,
            targetLocations
        });
        const requestedRunLimit = body.perRunUnlimited === true ? null : body.perRunLimit;
        const runQuota = createAggregateRunQuota(requestedRunLimit, targetLocations.length);

        return {
            runId,
            platforms,
            lat,
            lng,
            radius: radiusValue,
            gridSize: gridSizeValue,
            pageSize: pageSizeValue,
            maxPages: maxPagesValue,
            crawlMode,
            testMode: normalizedTestMode,
            proxyContext,
            targetLocations,
            requestedRunLimit,
            runQuota
        };
    }

    function buildAggregateRunQuotaSummary(job, state) {
        const summaries = (state.targetSummaries || [])
            .map(item => item.runQuota)
            .filter(Boolean);
        if (summaries.length === 0) {
            return smartCrawler.getRunRequestQuotaSummary(job.runQuota, { includeRequests: false });
        }

        const unlimited = summaries.some(item => item.unlimited);
        const limit = unlimited ? null : summaries.reduce((sum, item) => sum + (Number(item.limit) || 0), 0);
        const used = summaries.reduce((sum, item) => sum + (Number(item.used) || 0), 0);
        const success = summaries.reduce((sum, item) => sum + (Number(item.success) || 0), 0);
        const fail501 = summaries.reduce((sum, item) => sum + (Number(item.fail501) || 0), 0);
        const requestCount = summaries.reduce((sum, item) => sum + (Number(item.requestCount) || 0), 0);
        return {
            limit,
            unlimited,
            used,
            success,
            fail501,
            remaining: unlimited ? null : Math.max(0, limit - used),
            exhausted: !unlimited && limit !== null && used >= limit,
            requestCount,
            quotaMode: 'per-target',
            targetCount: job.targetLocations.length,
            perTargetLimit: summaries.find(item => item.limit !== null && item.limit !== undefined)?.limit ?? null
        };
    }

    function buildCoordinateRunSummary(job, state, status = 'running') {
        const runQuota = buildAggregateRunQuotaSummary(job, state);
        const completedTargetCount = state.targetSummaries.filter(item => item.status !== 'running').length;
        const flattenedSummary = state.targetSummaries.flatMap(targetSummary =>
            (targetSummary.summary || []).map(item => ({
                ...item,
                targetLocation: targetSummary.targetLocation,
                targetLabel: targetSummary.targetLabel
            }))
        );

        return {
            status,
            coordinateCount: state.coordinateCount,
            totalStations: state.totalStations,
            totalInserted: state.totalInserted,
            totalSkipped: state.totalSkipped,
            failureCount: state.failureCount || 0,
            summary: flattenedSummary,
            targetLocation: job.targetLocations[0] || null,
            targetLocations: job.targetLocations,
            targetSummaries: state.targetSummaries,
            activeTarget: state.activeTarget,
            quotaStats: smartCrawler.getQuotaStatsSummary(),
            runQuota,
            progress: {
                status,
                targetCount: job.targetLocations.length,
                completedTargetCount,
                activeTarget: state.activeTarget,
                used: runQuota?.used || 0,
                success: runQuota?.success || 0,
                fail501: runQuota?.fail501 || 0,
                remaining: runQuota?.remaining ?? null,
                limit: runQuota?.limit ?? null,
                unlimited: Boolean(runQuota?.unlimited),
                exhausted: Boolean(runQuota?.exhausted)
            }
        };
    }

    async function executeCoordinateCrawlJob(job) {
        const {
            runId,
            platforms,
            radius,
            gridSize,
            pageSize,
            maxPages,
            crawlMode,
            testMode,
            targetLocations,
            requestedRunLimit
        } = job;

        const state = {
            coordinateCount: 0,
            totalStations: 0,
            totalInserted: 0,
            totalSkipped: 0,
            failureCount: 0,
            targetSummaries: [],
            activeTarget: null
        };
        const updateProgress = (status = 'running') => {
            runHistoryModel.updateRunSummary(runId, buildCoordinateRunSummary(job, state, status));
        };

        try {
            runHistoryModel.appendLog(runId, `本次目标位置 ${targetLocations.length} 个`);
            runHistoryModel.appendLog(runId, `检索模式: ${crawlMode}`);
            updateProgress();

            for (const target of targetLocations) {
                const targetLabel = formatTargetLocationLabel(target);
                const targetRunQuota = smartCrawler.createRunRequestQuota(requestedRunLimit);

                state.activeTarget = target;
                const coordinates = SmartCrawlerClass.generateGridCoordinates(
                    target.lat,
                    target.lng,
                    radius,
                    gridSize
                );
                state.coordinateCount += coordinates.length;
                runHistoryModel.appendLog(runId, `目标位置 ${target.index}/${targetLocations.length}: ${targetLabel}`);
                runHistoryModel.appendLog(runId, `生成坐标网格 ${coordinates.length} 个点`);

                const targetSummary = {
                    targetLocation: target,
                    targetLabel,
                    coordinateCount: coordinates.length,
                    status: 'running',
                    totalStations: 0,
                    totalInserted: 0,
                    totalSkipped: 0,
                    runQuota: smartCrawler.getRunRequestQuotaSummary(targetRunQuota, { includeRequests: false }),
                    summary: []
                };
                state.targetSummaries.push(targetSummary);
                updateProgress();

                for (const platform of platforms) {
                    if (!smartCrawler.hasRunRequestQuotaRemaining(targetRunQuota)) {
                        runHistoryModel.appendLog(
                            runId,
                            `目标位置 ${targetLabel} 当次请求已达上限，停止后续平台: ${smartCrawler.formatRunRequestQuota(targetRunQuota)}`,
                            'warn'
                        );
                        targetSummary.runQuota = smartCrawler.getRunRequestQuotaSummary(targetRunQuota, { includeRequests: false });
                        targetSummary.summary.push({
                            platform,
                            success: false,
                            reason: 'run_request_limit_exceeded',
                            runQuota: targetSummary.runQuota
                        });
                        break;
                    }

                    runHistoryModel.appendLog(runId, `开始平台爬取: ${platform}`);
                    const { listTemplates, detailTemplates } = getTemplatesByMode(platform, crawlMode);
                    if (listTemplates.length === 0 && detailTemplates.length === 0) {
                        runHistoryModel.appendLog(runId, `平台 ${platform} 无可用模板`, 'warn');
                        state.failureCount += 1;
                        targetSummary.summary.push({
                            platform,
                            success: false,
                            reason: 'no_active_template',
                            selfHeal: selfHealService.buildApiFailure(platform, 'no_active_template', targetRunQuota)
                        });
                        updateProgress();
                        continue;
                    }

                    try {
                        const result = await runPlatformCrawl({
                            platform,
                            crawlMode,
                            coordinates,
                            centerLat: target.lat,
                            centerLng: target.lng,
                            radius,
                            pageSize,
                            maxPages,
                            runId,
                            testMode,
                            runQuota: targetRunQuota,
                            proxyContext: target,
                            progressReporter: () => {
                                targetSummary.runQuota = smartCrawler.getRunRequestQuotaSummary(targetRunQuota, { includeRequests: false });
                                updateProgress();
                            }
                        });
                        targetSummary.runQuota = smartCrawler.getRunRequestQuotaSummary(targetRunQuota, { includeRequests: false });

                        if (!result.success) {
                            state.failureCount += 1;
                            targetSummary.summary.push({
                                platform,
                                success: false,
                                reason: result.reason,
                                diagnostics: result.diagnostics,
                                stationCount: result.stationCount || 0,
                                insertedCount: result.insertedCount || 0,
                                skippedCount: result.skippedCount || 0,
                                runQuota: result.runQuota,
                                selfHeal: selfHealService.buildApiFailure(platform, result.reason, result.runQuota)
                            });
                            updateProgress();
                            continue;
                        }

                        state.totalStations += result.stationCount || 0;
                        state.totalInserted += result.insertedCount || 0;
                        state.totalSkipped += result.skippedCount || 0;
                        targetSummary.totalStations += result.stationCount || 0;
                        targetSummary.totalInserted += result.insertedCount || 0;
                        targetSummary.totalSkipped += result.skippedCount || 0;

                        targetSummary.summary.push({
                            platform,
                            success: true,
                            crawlMode,
                            coordinateCount: coordinates.length,
                            listTemplateCount: result.listTemplateCount,
                            detailTemplateCount: result.detailTemplateCount,
                            listStationCount: result.listStationCount,
                            detailStationCount: result.detailStationCount,
                            stationCount: result.stationCount,
                            insertedCount: result.insertedCount,
                            skippedCount: result.skippedCount,
                            testMode: result.testMode,
                            requestBudget: result.requestBudget,
                            quotaStats: result.quotaStats,
                            runQuota: result.runQuota
                        });
                        runHistoryModel.appendLog(
                            runId,
                            `平台 ${platform} 完成: 列表 ${result.listStationCount}，详情 ${result.detailStationCount}，合并 ${result.stationCount}，入库 ${result.insertedCount}，跳过 ${result.skippedCount}`
                        );
                        updateProgress();
                    } catch (error) {
                        runHistoryModel.appendLog(runId, `平台 ${platform} 失败: ${error.message}`, 'error');
                        state.failureCount += 1;
                        if (smartCrawler.isRunRequestLimitExceeded(error)) {
                            const selfHeal = selfHealService.buildApiFailure(
                                platform,
                                error.message,
                                error.runQuota || smartCrawler.getRunRequestQuotaSummary(targetRunQuota, { includeRequests: false })
                            );
                            targetSummary.runQuota = error.runQuota || smartCrawler.getRunRequestQuotaSummary(targetRunQuota, { includeRequests: false });
                            targetSummary.summary.push({
                                platform,
                                success: false,
                                reason: 'run_request_limit_exceeded',
                                runQuota: targetSummary.runQuota,
                                selfHeal
                            });
                            updateProgress();
                            break;
                        }
                        targetSummary.summary.push({
                            platform,
                            success: false,
                            reason: error.message,
                            selfHeal: selfHealService.buildApiFailure(
                                platform,
                                error.message,
                                smartCrawler.getRunRequestQuotaSummary(targetRunQuota, { includeRequests: false })
                            )
                        });
                        updateProgress();
                    }
                }

                targetSummary.status = targetSummary.totalStations > 0
                    ? 'success'
                    : (targetSummary.summary.some(item => item.success === false) ? 'failed' : 'success');
                targetSummary.runQuota = smartCrawler.getRunRequestQuotaSummary(targetRunQuota, { includeRequests: false });
                state.activeTarget = null;
                updateProgress();
            }

            const finalStatus = state.totalStations > 0
                ? (state.failureCount > 0 ? 'partial' : 'success')
                : (state.failureCount > 0 ? 'failed' : 'success');
            const finalSummary = buildCoordinateRunSummary(job, state, finalStatus);
            runHistoryModel.finishRun(
                runId,
                finalStatus === 'failed' ? 'failed' : 'success',
                finalSummary,
                finalStatus === 'failed' ? '方式三未获取到可用场站数据' : null
            );

            return {
                success: finalStatus !== 'failed',
                message: `多平台坐标爬取完成，共识别 ${state.totalStations} 个场站`,
                center: {
                    lat: targetLocations[0]?.lat,
                    lng: targetLocations[0]?.lng
                },
                status: finalStatus,
                coordinateCount: state.coordinateCount,
                crawlMode,
                targetLocation: targetLocations[0] || null,
                targetLocations,
                totalStations: state.totalStations,
                totalInserted: state.totalInserted,
                totalSkipped: state.totalSkipped,
                summary: finalSummary.summary,
                targetSummaries: state.targetSummaries,
                testMode,
                quotaStats: smartCrawler.getQuotaStatsSummary(),
                runQuota: finalSummary.runQuota
            };
        } catch (error) {
            logger.error?.('多平台坐标爬取失败:', error);
            if (runId) {
                runHistoryModel.appendLog(runId, `任务失败: ${error.message}`, 'error');
                runHistoryModel.finishRun(runId, 'failed', null, error.message);
            }
            throw error;
        }
    }

    function sendCoordinateCrawlError(res, error, runQuota = null) {
        const statusCode = error.statusCode || (smartCrawler.isRunRequestLimitExceeded(error) ? 429 : 500);
        const payload = {
            success: false,
            error: error.message
        };

        if (smartCrawler.isRunRequestLimitExceeded(error)) {
            payload.code = error.code;
            payload.runQuota = error.runQuota || smartCrawler.getRunRequestQuotaSummary(runQuota, { includeRequests: false });
            payload.quotaStats = smartCrawler.getQuotaStatsSummary();
        }

        return res.status(statusCode).json(payload);
    }

    function buildTemplatePreflightDiagnostics(pattern, proxyContext = null) {
        return templateApplicationService.buildPreflightDiagnostics(pattern, proxyContext);
    }

    router.post('/crawler/crawl', async (req, res) => {
        const { pattern, coordinates, pageSize, maxPages, seedStations = [], testMode, targetLocation } = req.body;

        if (!pattern) {
            return res.status(400).json({ success: false, error: 'pattern required' });
        }

        try {
            const templateScope = pattern.templateScope || 'list';
            let stations = [];
            const requestedRunLimit = req.body.perRunUnlimited === true ? null : req.body.perRunLimit;
            const runQuota = smartCrawler.createRunRequestQuota(requestedRunLimit);
            const requestBudget = normalizeTestMode(testMode)
                ? smartCrawler.createTestRequestBudget(pattern.platform)
                : null;
            const firstCoord = Array.isArray(coordinates) ? coordinates[0] : null;
            const proxyContext = normalizeTargetLocation(targetLocation, firstCoord?.lat, firstCoord?.lng);
            const preflightDiagnostics = buildTemplatePreflightDiagnostics(pattern, proxyContext);

            if (templateScope === 'detail') {
                if (!Array.isArray(seedStations) || seedStations.length === 0) {
                    return res.status(400).json({ success: false, error: 'detail template requires seedStations' });
                }
                stations = await smartCrawler.crawlDetail(pattern, { seedStations, requestBudget, runQuota, proxyContext });
            } else {
                if (!Array.isArray(coordinates) || coordinates.length === 0) {
                    return res.status(400).json({ success: false, error: 'list template requires coordinates' });
                }
                stations = await smartCrawler.crawl(pattern, {
                    coordinates,
                    pageSize: pageSize || 20,
                    maxPages: maxPages || 5,
                    requestBudget,
                    runQuota,
                    proxyContext
                });
            }

            const insertResult = stations.length > 0
                ? stationModel.insertBatch(stations)
                : { successCount: 0, skipCount: 0 };

            return res.json({
                success: true,
                stationCount: stations.length,
                insertedCount: insertResult.successCount || 0,
                skippedCount: insertResult.skipCount || 0,
                data: stations,
                testMode: Boolean(requestBudget),
                preflightDiagnostics,
                requestBudget: smartCrawler.getTestRequestBudgetSummary(requestBudget),
                quotaStats: smartCrawler.getQuotaStatsSummary(),
                runQuota: smartCrawler.getRunRequestQuotaSummary(runQuota, { includeRequests: false })
            });
        } catch (error) {
            logger.error?.('爬取失败:', error);
            if (smartCrawler.isRunRequestLimitExceeded(error)) {
                return res.status(429).json({
                    success: false,
                    error: error.message,
                    code: error.code,
                    runQuota: error.runQuota || null,
                    quotaStats: smartCrawler.getQuotaStatsSummary()
                });
            }
            return res.status(500).json({ success: false, error: error.message });
        }
    });

    router.post('/crawler/crawl-platforms-with-coordinates', async (req, res) => {
        let job = null;
        try {
            job = createCoordinateCrawlJob(req.body);
            const result = await executeCoordinateCrawlJob(job);
            res.json(result);
        } catch (error) {
            sendCoordinateCrawlError(res, error, job?.runQuota || null);
        }
    });

    router.post('/crawler/crawl-platforms-with-coordinates/start', (req, res) => {
        let job = null;
        try {
            job = createCoordinateCrawlJob(req.body);
            runHistoryModel.appendLog(job.runId, '方式三任务已进入后台执行队列');
            scheduleImmediate(() => {
                executeCoordinateCrawlJob(job).catch(error => {
                    logger.error?.(`后台方式三任务失败 runId=${job.runId}:`, error);
                });
            });

            res.json({
                success: true,
                runId: job.runId,
                status: 'running',
                message: '方式三任务已启动，可在执行进度中查看进度条',
                runQuota: smartCrawler.getRunRequestQuotaSummary(job.runQuota, { includeRequests: false }),
                quotaStats: smartCrawler.getQuotaStatsSummary()
            });
        } catch (error) {
            sendCoordinateCrawlError(res, error, job?.runQuota || null);
        }
    });

    router.post('/crawler/generate-grid', (req, res) => {
        const { centerLat, centerLng, radius, gridSize } = req.body;

        if (!centerLat || !centerLng) {
            return res.status(400).json({
                success: false,
                error: 'centerLat and centerLng required'
            });
        }

        try {
            const coordinates = SmartCrawlerClass.generateGridCoordinates(
                parseFloat(centerLat),
                parseFloat(centerLng),
                parseFloat(radius) || 10,
                parseFloat(gridSize) || 2
            );

            return res.json({
                success: true,
                count: coordinates.length,
                coordinates
            });
        } catch (error) {
            return res.status(500).json({ success: false, error: error.message });
        }
    });

    return {
        router,
        createCoordinateCrawlJob,
        executeCoordinateCrawlJob,
        runPlatformCrawl
    };
}

module.exports = {
    createCrawlerExecutionRouter,
    filterStationsByRadius,
    normalizeCrawlMode,
    normalizeTargetLocation,
    normalizeTargetRequestParams,
    normalizeTestMode
};
