'use strict';

const express = require('express');
const { sendRouteError } = require('./http-response');

/**
 * 采集路由工厂
 *
 * POST /api/collect/kuaidian  body:{lat,lng,city?,pageIndex?,pageSize?}
 * POST /api/collect/teld       同上
 * POST /api/collect/tuanyou    body:{lat,lng,city?,oilNo?,pageIndex?,pageSize?,distance?,cityCode?}
 * POST /api/collect/star-charge body:{lat,lng,city?,page?,pagecount?,radius?}
 * POST /api/collect/ykc       body:{lat,lng,city?,cityId?,pageIndex?,pageSize?}
 * POST /api/collect/xdt       body:{lat,lng,city?,page?,pageSize?,sortRule?,radius?}
 *
 * 请求次数限制(双模式，对标 smart-crawler 的 testRequestLimit / perRunLimit)：
 *   - Agent 对话测试模式 (mode='agent-test')：每平台硬上限 5 次。
 *     用于 Codex/Agent 主动验证链路，参考 CODEPLAN.md "主动验证每平台 5 次以内"。
 *   - 产品实际使用模式 (默认)：严格按用户设置的请求次数限制(perRunLimit)。
 *     用户通过 body.perRunLimit 或产品配置指定；不设则无限制(null)。
 *
 * 判定方式：body.mode === 'agent-test' 走测试模式；其余走产品模式。
 * Agent 调用本路由时应显式传 mode:'agent-test'，避免误用产品模式突破测试边界。
 *
 * 入库时 raw_data 用 StationModel.serializeRawacted 自动脱敏。
 */
const AGENT_TEST_LIMIT_PER_PLATFORM = 5;

function createCollectRouter(options = {}) {
    const stationModel = options.stationModel;
    const KuaidianCollector = options.KuaidianCollector;
    const TeldCollector = options.TeldCollector;
    const TuanyouCollector = options.TuanyouCollector;
    const StarchargeCollector = options.StarchargeCollector;
    const YkcCollector = options.YkcCollector;
    const XdtCollector = options.XdtCollector;
    const browserSigner = options.browserSigner || null;
    const kuaidianCredentialProvider = options.kuaidianCredentialProvider || null;
    const tuanyouCredentialProvider = options.tuanyouCredentialProvider || null;
    const logger = typeof options.logger === 'function' ? options.logger : null;

    if (!stationModel) {
        throw new TypeError('stationModel is required');
    }

    const router = express.Router();

    // 每平台请求预算(按模式分别记账)
    // agent-test: limit=5，进程级累计
    // product: limit=perRunLimit(可为null=无限)，单次请求级
    const agentTestBudgets = new Map(); // platform -> { used }

    function isAgentTestMode(body = {}) {
        return String(body.mode || '').trim() === 'agent-test';
    }

    // 解析产品模式下的用户请求限制。
    // null/undefined/'' → 无限制(用户未设置)
    // 0 → 明确禁止(用户设置为0)
    // 正整数 → 该上限
    function resolveProductLimit(body = {}) {
        const raw = body.perRunLimit ?? body.maxRequests ?? body.limit ?? null;
        if (raw === null || raw === undefined || raw === '') {
            return null; // 无限制
        }
        const num = Math.floor(Number(raw));
        if (!Number.isFinite(num) || num < 0) {
            return null; // 无效值视为无限制
        }
        return num; // 0 = 禁止, 正整数 = 上限
    }

    function consumeBudget(platform, body) {
        if (isAgentTestMode(body)) {
            // Agent 测试模式：每平台硬上限 5 次，进程级累计
            if (!agentTestBudgets.has(platform)) {
                agentTestBudgets.set(platform, { used: 0 });
            }
            const budget = agentTestBudgets.get(platform);
            if (budget.used >= AGENT_TEST_LIMIT_PER_PLATFORM) {
                const error = new Error(
                    `Agent 测试请求已达上限：${platform} 最多 ${AGENT_TEST_LIMIT_PER_PLATFORM} 次`
                );
                error.code = 'AGENT_TEST_REQUEST_LIMIT_EXCEEDED';
                error.statusCode = 429;
                error.requestBudget = {
                    mode: 'agent-test',
                    platform,
                    limit: AGENT_TEST_LIMIT_PER_PLATFORM,
                    used: budget.used
                };
                throw error;
            }
            budget.used += 1;
            return {
                mode: 'agent-test',
                platform,
                limit: AGENT_TEST_LIMIT_PER_PLATFORM,
                used: budget.used,
                unlimited: false
            };
        }

        // 产品模式：按用户设置的 perRunLimit，不设则无限制
        const limit = resolveProductLimit(body);
        if (limit === null) {
            return { mode: 'product', platform, limit: null, used: null, unlimited: true };
        }
        // 产品模式按"单次请求"记账(每次路由调用消耗1次)，limit 在 body 传入即本次上限校验
        // 单次路由调用只发 1 个采集请求，故 used<=limit 恒成立；真正多请求由调度层(smart-crawler)管控
        // 这里仅做单次保护：limit=0 时拒绝
        if (limit === 0) {
            const error = new Error(`产品请求限制为 0：${platform} 不允许请求`);
            error.code = 'PRODUCT_REQUEST_LIMIT_ZERO';
            error.statusCode = 429;
            throw error;
        }
        return { mode: 'product', platform, limit, used: 1, unlimited: false };
    }

    function isBudgetExceeded(error) {
        return error?.code === 'AGENT_TEST_REQUEST_LIMIT_EXCEEDED'
            || error?.code === 'PRODUCT_REQUEST_LIMIT_ZERO';
    }

    function createCollector(CollectorClass, platform) {
        if (!CollectorClass) {
            const error = new Error(`${platform} collector is not configured`);
            error.statusCode = 503;
            error.code = `${platform}_collector_unavailable`;
            throw error;
        }
        return new CollectorClass({
            browserSigner,
            ...(platform === 'kuaidian' ? { credentialProvider: kuaidianCredentialProvider } : {}),
            ...(platform === 'tuanyou' ? { credentialProvider: tuanyouCredentialProvider } : {}),
        });
    }

    function parseCoordinate(value, fieldName) {
        const num = Number(value);
        if (!Number.isFinite(num)) {
            const error = new Error(`${fieldName} must be a finite number`);
            error.statusCode = 400;
            error.code = `invalid_${fieldName}`;
            throw error;
        }
        return num;
    }

    function insertStations(stations) {
        let inserted = 0;
        let updated = 0;
        for (const station of stations) {
            try {
                const result = stationModel.insert(station);
                if (result && (result.changes > 0 || result.lastInsertRowid)) {
                    // INSERT OR IGNORE / UPDATE 均以 changes>0 计为成功
                    if (result.lastInsertRowid) {
                        inserted += 1;
                    } else {
                        updated += 1;
                    }
                }
            } catch (error) {
                if (logger) {
                    logger(`入库失败: ${station.stationName || station.stationId} - ${error.message}`, 'error');
                }
            }
        }
        return { inserted, updated };
    }

    /**
     * POST /api/collect/kuaidian
     * body: {lat, lng, city?, pageIndex?, pageSize?, distance?}
     */
    router.post('/kuaidian', async (req, res) => {
        try {
            const lat = parseCoordinate(req.body?.lat, 'lat');
            const lng = parseCoordinate(req.body?.lng, 'lng');
            const city = req.body?.city || null;
            const pageIndex = Math.max(1, Math.floor(Number(req.body?.pageIndex) || 1));
            const pageSize = Math.min(50, Math.max(1, Math.floor(Number(req.body?.pageSize) || 10)));
            const distance = req.body?.distance !== undefined ? req.body?.distance : 20;

            consumeBudget('kuaidian', req.body);
            const collector = createCollector(KuaidianCollector, 'kuaidian');
            const result = await collector.collectByLocation(lat, lng, { pageIndex, pageSize, distance });

            const storeResult = insertStations(result.stations);
            if (logger) {
                logger(`快电采集完成: 采集 ${result.collectedCount} 站，入库 ${storeResult.inserted} 更新 ${storeResult.updated}`, 'info');
            }

            res.json({
                success: true,
                data: {
                    platform: 'kuaidian',
                    city,
                    totalCount: result.totalCount,
                    collectedCount: result.collectedCount,
                    insertedCount: storeResult.inserted,
                    updatedCount: storeResult.updated,
                    stations: result.stations.map(s => ({
                        stationId: s.stationId,
                        stationName: s.stationName,
                        address: s.address,
                        priceFast: s.priceFast,
                        availablePorts: s.availablePorts,
                        totalPorts: s.totalPorts
                    }))
                }
            });
        } catch (error) {
            if (isBudgetExceeded(error)) {
                return res.status(error.statusCode || 429).json({
                    success: false,
                    error: error.message,
                    code: error.code,
                    requestBudget: error.requestBudget,
                    requestId: req.requestId
                });
            }
            return sendRouteError(req, res, error, { code: 'kuaidian_collect_failed' });
        }
    });

    /**
     * POST /api/collect/teld
     * body: {lat, lng, city?, pageNum?, itemNumPerPage?, locationFilterValue?}
     */
    router.post('/teld', async (req, res) => {
        try {
            const lat = parseCoordinate(req.body?.lat, 'lat');
            const lng = parseCoordinate(req.body?.lng, 'lng');
            const city = req.body?.city || null;
            const pageNum = Math.max(1, Math.floor(Number(req.body?.pageNum) || 1));
            const itemNumPerPage = Math.min(50, Math.max(1, Math.floor(Number(req.body?.itemNumPerPage) || 10)));
            const locationFilterValue = req.body?.locationFilterValue !== undefined
                ? req.body?.locationFilterValue
                : 50;

            consumeBudget('teld', req.body);
            const collector = createCollector(TeldCollector, 'teld');
            const result = await collector.collectByLocation(lat, lng, { pageNum, itemNumPerPage, locationFilterValue });

            const storeResult = insertStations(result.stations);
            if (logger) {
                logger(`特来电采集完成: 采集 ${result.collectedCount} 站，入库 ${storeResult.inserted} 更新 ${storeResult.updated}`, 'info');
            }

            res.json({
                success: true,
                data: {
                    platform: 'teld',
                    city,
                    itemCount: result.itemCount,
                    currentPage: result.currentPage,
                    pageCount: result.pageCount,
                    collectedCount: result.collectedCount,
                    insertedCount: storeResult.inserted,
                    updatedCount: storeResult.updated,
                    stations: result.stations.map(s => ({
                        stationId: s.stationId,
                        stationName: s.stationName,
                        address: s.address,
                        priceFast: s.priceFast,
                        availablePorts: s.availablePorts,
                        totalPorts: s.totalPorts
                    }))
                }
            });
        } catch (error) {
            if (isBudgetExceeded(error)) {
                return res.status(error.statusCode || 429).json({
                    success: false,
                    error: error.message,
                    code: error.code,
                    requestBudget: error.requestBudget,
                    requestId: req.requestId
                });
            }
            return sendRouteError(req, res, error, { code: 'teld_collect_failed' });
        }
    });

    /**
     * POST /api/collect/tuanyou
     * body: {lat, lng, city?, oilNo?, pageIndex?, pageSize?, distance?, cityCode?, mode?, perRunLimit?}
     */
    router.post('/tuanyou', async (req, res) => {
        try {
            const lat = parseCoordinate(req.body?.lat, 'lat');
            const lng = parseCoordinate(req.body?.lng, 'lng');
            const city = req.body?.city || null;
            const oilNo = req.body?.oilNo !== undefined ? String(req.body?.oilNo) : '92';
            const pageIndex = Math.max(1, Math.floor(Number(req.body?.pageIndex) || 1));
            const pageSize = Math.min(50, Math.max(1, Math.floor(Number(req.body?.pageSize) || 10)));
            const distance = req.body?.distance !== undefined ? req.body?.distance : 20;
            const cityCode = req.body?.cityCode !== undefined ? req.body?.cityCode : '';

            consumeBudget('tuanyou', req.body);
            const collector = createCollector(TuanyouCollector, 'tuanyou');
            const result = await collector.collectByLocation(lat, lng, { oilNo, pageIndex, pageSize, distance, cityCode });

            const storeResult = insertStations(result.stations);
            if (logger) {
                logger(`团油采集完成: 采集 ${result.collectedCount} 站，入库 ${storeResult.inserted} 更新 ${storeResult.updated}`, 'info');
            }

            res.json({
                success: true,
                data: {
                    platform: 'tuanyou',
                    city,
                    oilNo,
                    totalCount: result.totalCount,
                    collectedCount: result.collectedCount,
                    insertedCount: storeResult.inserted,
                    updatedCount: storeResult.updated,
                    stations: result.stations.map(s => ({
                        stationId: s.stationId,
                        stationName: s.stationName,
                        address: s.address,
                        fuel92Price: s.fuel92Price,
                        fuel95Price: s.fuel95Price,
                        fuel98Price: s.fuel98Price,
                        fuelDieselPrice: s.fuelDieselPrice,
                        operator: s.operator
                    }))
                }
            });
        } catch (error) {
            if (isBudgetExceeded(error)) {
                return res.status(error.statusCode || 429).json({
                    success: false,
                    error: error.message,
                    code: error.code,
                    requestBudget: error.requestBudget,
                    requestId: req.requestId
                });
            }
            return sendRouteError(req, res, error, { code: 'tuanyou_collect_failed' });
        }
    });

    /**
     * POST /api/collect/star-charge
     * body: {lat, lng, city?, page?, pagecount?, radius?, mode?, perRunLimit?}
     */
    router.post('/star-charge', async (req, res) => {
        try {
            const lat = parseCoordinate(req.body?.lat, 'lat');
            const lng = parseCoordinate(req.body?.lng, 'lng');
            const city = req.body?.city || null;
            const page = Math.max(1, Math.floor(Number(req.body?.page) || 1));
            const pagecount = Math.min(50, Math.max(1, Math.floor(Number(req.body?.pagecount) || 10)));
            const radius = req.body?.radius !== undefined ? req.body?.radius : 10000;

            consumeBudget('star-charge', req.body);
            const collector = createCollector(StarchargeCollector, 'star-charge');
            const result = await collector.collectByLocation(lat, lng, { page, pagecount, radius });

            const storeResult = insertStations(result.stations);
            if (logger) {
                logger(`星星充电采集完成: 采集 ${result.collectedCount} 站，入库 ${storeResult.inserted} 更新 ${storeResult.updated}`, 'info');
            }

            res.json({
                success: true,
                data: {
                    platform: 'star-charge',
                    city,
                    totalCount: result.totalCount,
                    collectedCount: result.collectedCount,
                    insertedCount: storeResult.inserted,
                    updatedCount: storeResult.updated,
                    stations: result.stations.map(s => ({
                        stationId: s.stationId,
                        stationName: s.stationName,
                        address: s.address,
                        priceFast: s.priceFast,
                        priceService: s.priceService,
                        availablePorts: s.availablePorts,
                        totalPorts: s.totalPorts
                    }))
                }
            });
        } catch (error) {
            if (isBudgetExceeded(error)) {
                return res.status(error.statusCode || 429).json({
                    success: false,
                    error: error.message,
                    code: error.code,
                    requestBudget: error.requestBudget,
                    requestId: req.requestId
                });
            }
            return sendRouteError(req, res, error, { code: 'starcharge_collect_failed' });
        }
    });

    /**
     * POST /api/collect/ykc
     * body: {lat, lng, city?, cityId?, pageIndex?, pageSize?, keyword?, mode?, perRunLimit?}
     * 云快充最简单：无签名、无加密、无鉴权门，明文 JSON 请求/响应。
     */
    router.post('/ykc', async (req, res) => {
        try {
            const lat = parseCoordinate(req.body?.lat, 'lat');
            const lng = parseCoordinate(req.body?.lng, 'lng');
            const city = req.body?.city || null;
            const cityId = req.body?.cityId !== undefined ? String(req.body?.cityId) : '021';
            const pageIndex = Math.max(1, Math.floor(Number(req.body?.pageIndex) || 1));
            const pageSize = Math.min(50, Math.max(1, Math.floor(Number(req.body?.pageSize) || 10)));
            const keyword = req.body?.keyword !== undefined ? String(req.body?.keyword) : '';

            consumeBudget('ykc', req.body);
            const collector = createCollector(YkcCollector, 'ykc');
            const result = await collector.collectByLocation(lat, lng, { cityId, pageIndex, pageSize, keyword });

            const storeResult = insertStations(result.stations);
            if (logger) {
                logger(`云快充采集完成: 采集 ${result.collectedCount} 站，入库 ${storeResult.inserted} 更新 ${storeResult.updated}`, 'info');
            }

            res.json({
                success: true,
                data: {
                    platform: 'ykc',
                    city,
                    cityId,
                    totalCount: result.totalCount,
                    collectedCount: result.collectedCount,
                    insertedCount: storeResult.inserted,
                    updatedCount: storeResult.updated,
                    stations: result.stations.map(s => ({
                        stationId: s.stationId,
                        stationName: s.stationName,
                        address: s.address,
                        priceFast: s.priceFast,
                        priceService: s.priceService,
                        availablePorts: s.availablePorts,
                        totalPorts: s.totalPorts,
                        fastIdlePorts: s.fastIdlePorts,
                        fastTotalPorts: s.fastTotalPorts,
                        slowIdlePorts: s.slowIdlePorts,
                        slowTotalPorts: s.slowTotalPorts,
                        superIdlePorts: s.superIdlePorts,
                        superTotalPorts: s.superTotalPorts
                    }))
                }
            });
        } catch (error) {
            if (isBudgetExceeded(error)) {
                return res.status(error.statusCode || 429).json({
                    success: false,
                    error: error.message,
                    code: error.code,
                    requestBudget: error.requestBudget,
                    requestId: req.requestId
                });
            }
            return sendRouteError(req, res, error, { code: 'ykc_collect_failed' });
        }
    });

    /**
     * POST /api/collect/xdt
     * body: {lat, lng, city?, page?, pageSize?, sortRule?, radius?, mode?, perRunLimit?}
     * 新电途: AES-ECB 加密业务参数 + formatSignCommon 签名( nonceStr=MD5 真签名, sign=诱饵)
     */
    router.post('/xdt', async (req, res) => {
        try {
            const lat = parseCoordinate(req.body?.lat, 'lat');
            const lng = parseCoordinate(req.body?.lng, 'lng');
            const city = req.body?.city || null;
            const page = Math.max(1, Math.floor(Number(req.body?.page) || 1));
            const pageSize = Math.min(50, Math.max(1, Math.floor(Number(req.body?.pageSize) || 10)));
            const sortRule = req.body?.sortRule !== undefined ? String(req.body.sortRule) : '01';
            const radius = req.body?.radius !== undefined ? Number(req.body.radius) : 10000;

            consumeBudget('xdt', req.body);
            const collector = createCollector(XdtCollector, 'xdt');
            const result = await collector.collectByLocation(lat, lng, { page, pageSize, sortRule, radius });

            const storeResult = insertStations(result.stations);
            if (logger) {
                logger(`新电途采集完成: 采集 ${result.collectedCount} 站，入库 ${storeResult.inserted} 更新 ${storeResult.updated}`, 'info');
            }

            res.json({
                success: true,
                data: {
                    platform: 'xdt',
                    city,
                    totalCount: result.totalCount,
                    collectedCount: result.collectedCount,
                    insertedCount: storeResult.inserted,
                    updatedCount: storeResult.updated,
                    stations: result.stations.map(s => ({
                        stationId: s.stationId,
                        stationName: s.stationName,
                        address: s.address,
                        priceFast: s.priceFast,
                        priceService: s.priceService,
                        availablePorts: s.availablePorts,
                        totalPorts: s.totalPorts,
                        fastIdlePorts: s.fastIdlePorts,
                        fastTotalPorts: s.fastTotalPorts,
                        slowIdlePorts: s.slowIdlePorts,
                        slowTotalPorts: s.slowTotalPorts,
                        superIdlePorts: s.superIdlePorts,
                        superTotalPorts: s.superTotalPorts
                    }))
                }
            });
        } catch (error) {
            if (isBudgetExceeded(error)) {
                return res.status(error.statusCode || 429).json({
                    success: false,
                    error: error.message,
                    code: error.code,
                    requestBudget: error.requestBudget,
                    requestId: req.requestId
                });
            }
            return sendRouteError(req, res, error, { code: 'xdt_collect_failed' });
        }
    });

    /**
     * GET /api/collect/budget
     * 查看请求预算使用情况。
     * 仅返回 agent-test 模式的进程级累计(产品模式无进程级预算，按单次请求/调度层管理)。
     */
    router.get('/budget', (req, res) => {
        const agentTest = [];
        for (const [platform, budget] of agentTestBudgets) {
            agentTest.push({
                mode: 'agent-test',
                platform,
                limit: AGENT_TEST_LIMIT_PER_PLATFORM,
                used: budget.used,
                remaining: Math.max(0, AGENT_TEST_LIMIT_PER_PLATFORM - budget.used)
            });
        }
        res.json({
            success: true,
            data: {
                agentTest,
                product: {
                    description: '产品模式按用户设置的 perRunLimit 限制；不设则无限制',
                    fields: ['perRunLimit', 'maxRequests', 'limit']
                }
            }
        });
    });

    return router;
}

module.exports = { createCollectRouter };
