const fs = require('fs');
const path = require('path');

class HarParser {
    constructor() {
        // HarParser 不持有目录监听状态 — 仅做 HAR 解析
    }
    /**
     * 解析 HAR 会话文件
     */
    async parseSessionFile(filePath) {
        return this.parseHAR(filePath);
    }

    async parseHAR(filePath) {
        const content = fs.readFileSync(filePath, 'utf8');
        const har = JSON.parse(content);
        
        const stations = [];
        let processedCount = 0;
        
        console.log(`\n📄 开始解析 HAR 文件: ${path.basename(filePath)}`);
        console.log(`   总请求数: ${har.log.entries.length}`);
        
        for (const entry of har.log.entries) {
            const url = entry.request.url;
            const response = entry.response;
            
            // 根据 URL 模式识别不同平台的 API
            if (this.isStationAPI(url)) {
                processedCount++;
                console.log(`   找到充电站 API: ${url.substring(0, 80)}...`);
                
                try {
                    let responseText = response.content.text;
                    
                    // 处理 Base64 编码的响应
                    const encoding = response.content.encoding;
                    if (encoding === 'base64' || this.isBase64(responseText)) {
                        console.log(`     解码 Base64 响应...`);
                        responseText = Buffer.from(responseText, 'base64').toString('utf8');
                    }
                    
                    const platform = this.detectPlatform(url);
                    const requestContext = this.buildRequestContext(entry.request);
                    console.log(`     平台: ${platform}`);
                    
                    const parsed = this.parseResponseByPlatform(platform, responseText, {
                        url,
                        request: requestContext,
                        sourceType: 'har-import',
                        sourceStage: 'har-import'
                    }).map(station => ({
                        ...station,
                        sourceType: station.sourceType || 'har-import',
                        sourceStage: station.sourceStage || 'har-import',
                        raw: {
                            ...(station.raw || {}),
                            source: 'har-import',
                            request: requestContext,
                            requestUrl: url
                        }
                    }));
                    
                    if (parsed && parsed.length > 0) {
                        console.log(`     ✅ 找到 ${parsed.length} 个场站`);
                        stations.push(...parsed);
                    } else {
                        console.log(`     ⚠️  未解析到场站数据`);
                    }
                } catch (error) {
                    console.error(`     ❌ 解析失败:`, error.message);
                }
            }
        }
        
        console.log(`\n✅ 解析完成:`);
        console.log(`   处理了 ${processedCount} 个充电站 API`);
        console.log(`   提取了 ${stations.length} 个场站数据\n`);
        
        return this.deduplicateStations(stations);
    }
    
    /**
     * 检查字符串是否为 Base64 编码
     */
    isBase64(str) {
        if (!str || str.trim() === '') return false;
        try {
            return Buffer.from(str, 'base64').toString('base64') === str;
        } catch (e) {
            return false;
        }
    }


    isStationAPI(url) {
        // 排除图片和静态资源
        if (url.match(/\.(png|jpg|jpeg|gif|svg|webp|css|js|json|woff|ttf)$/i)) {
            return false;
        }
        
        const patterns = [
            // 通用模式
            /charging.*station/i,
            /station.*list/i,
            /station.*detail/i,
            /map.*search/i,
            /nearby/i,
            /getStationList/i,
            /queryStation/i,
            /getoneinfo/i,
            /station\/get/i,
            /getcombinedetail/i,
            /getgasgunoilinfo/i,
            /getczbconnectorinfolist/i,
            
            // 特来电特定 API（更精确）
            /teld\.cn\/api\/invoke.*Station/i,
            /teld\.cn\/api\/invoke.*SCSC/i,  // SearchStation
            
            // 滴滴充电
            /didiglobal.*charging/i,
            /xiaojukeji.*charging/i,
            
            // 星星充电（扩展规则）
            /starcharge.*api/i,
            /starcharge.*stubGroup/i,          // 新增：stubGroup 相关
            /starcharge.*list.*query/i,        // 新增：list/query 相关
            /starcharge.*wechat.*stub/i,       // 新增：微信小程序相关
            /sccncdn.*stubGroup/i,             // 星星充电 CDN 域名
            /sccncdn.*list.*query/i,
            /starcharge.*api/i,
            
            // 其他平台
            /yunquickcharge.*api/i,
            /tuanyou.*station/i,
            /mapGasInfoListPage/i,
            /gas.*list/i,
            /kuaidian.*station/i
        ];
        
        return patterns.some(pattern => pattern.test(url));
    }

    detectPlatform(url) {
        if (url.includes('didiglobal') || url.includes('xiaojukeji')) return 'didi-charging';
        if (url.includes('telaidian') || url.includes('teld')) return 'teld';
        if (url.includes('starcharge') || url.includes('sccncdn')) return 'star-charge';
        if (url.includes('jiayudata')) return 'kuaidian';
        if (url.includes('nlktj')) return 'tuanyou';
        if (url.includes('ykc') || url.includes('yunquickcharge')) return 'ykc';
        if (url.includes('tuanyou')) return 'tuanyou';
        if (url.includes('kuaidian')) return 'kuaidian';
        
        return 'unknown';
    }

    buildRequestContext(request = {}) {
        return {
            method: request.method || 'GET',
            url: request.url || '',
            queryParams: this.parseUrlQueryParams(request.url || ''),
            bodyParams: this.parseRequestBody(request.postData),
            headers: this.toHeaderMap(request.headers)
        };
    }

    parseUrlQueryParams(url) {
        try {
            const params = {};
            const urlObj = new URL(url);
            urlObj.searchParams.forEach((value, key) => {
                params[key] = value;
            });
            return params;
        } catch (error) {
            return {};
        }
    }

    parseRequestBody(postData) {
        if (!postData) {
            return {};
        }

        if (Array.isArray(postData.params) && postData.params.length > 0) {
            const params = {};
            for (const item of postData.params) {
                if (!item || !item.name) {
                    continue;
                }
                params[item.name] = item.value;
            }
            return params;
        }

        const text = String(postData.text || '').trim();
        if (!text) {
            return {};
        }

        try {
            return JSON.parse(text);
        } catch (error) {
            // Ignore JSON parse error and continue trying URL encoding.
        }

        try {
            const params = {};
            const searchParams = new URLSearchParams(text);
            for (const [key, value] of searchParams.entries()) {
                params[key] = value;
            }
            return params;
        } catch (error) {
            return {};
        }
    }

    toHeaderMap(headers = []) {
        if (!Array.isArray(headers)) {
            return {};
        }

        const map = {};
        for (const header of headers) {
            if (!header || !header.name) {
                continue;
            }
            map[String(header.name).toLowerCase()] = header.value;
        }
        return map;
    }

    parseResponseByPlatform(platform, responseText, context = {}) {
        try {
            const data = JSON.parse(responseText);
            
            switch (platform) {
                case 'didi-charging':
                    return this.parseDidiResponse(data, context);
                case 'teld':
                    return this.parseTeldResponse(data, context);
                case 'star-charge':
                    return this.parseStarChargeResponse(data, context);
                case 'kuaidian':
                    return this.parseKuaidianResponse(data, context);
                case 'tuanyou':
                    return this.parseTuanyouResponse(data, context);
                // 其他平台...
                default:
                    return this.parseGenericResponse(data, platform, context);
            }
        } catch (error) {
            console.error('JSON parse error:', error);
            return [];
        }
    }

    parseDidiResponse(data, context = {}) {
        // 滴滴充电 API 实际响应结构
        const stations = [];
        
        // 数据嵌套在 data.components[0].data 中
        let list = [];
        
        if (data.data && data.data.components && Array.isArray(data.data.components)) {
            // 新版 API 结构
            const component = data.data.components.find(c => c.componentId === 'homepage_station_card');
            if (component && component.data) {
                list = component.data;
            }
        } else if (data.data && data.data.station_list) {
            // 旧版 API 结构
            list = data.data.station_list;
        } else if (data.data && Array.isArray(data.data.list)) {
            list = data.data.list;
        } else if (data.data && typeof data.data === 'object') {
            // getoneinfo 等详情接口：单站对象
            const detail = data.data;
            if (detail.stationId || detail.fullStationId || detail.stationName || detail.businessSituation) {
                list = [detail];
            }
        }
        
        console.log(`     滴滴充电: 找到 ${list.length} 个场站记录`);
        
        for (const item of list) {
            // 价格处理：从 totalMarketPrice 或 totalSalePrice 提取
            let priceFast = null;
            let priceSlow = null;
            let priceSuper = null;
            const business = item.businessSituation || {};
            const fastPriceDetail = item.fastConnectorPriceDescription || {};
            const slowPriceDetail = item.slowConnectorPriceDescription || {};
            const superPriceDetail = item.superConnectorPriceDescription || {};
            
            if (item.totalMarketPrice) {
                const price = parseFloat(item.totalMarketPrice);
                if (!isNaN(price)) {
                    priceFast = price;
                }
            }
            
            if (item.totalSalePrice) {
                const price = parseFloat(item.totalSalePrice);
                if (!isNaN(price)) {
                    priceSlow = price;
                }
            }

            if (priceFast === null) {
                priceFast = this.firstNonNull([
                    this.pickNumber(fastPriceDetail, ['userPayTotalPrice', 'marketPrice', 'salePrice']),
                    this.pickNumber(item, ['fastPrice'])
                ]);
            }

            if (priceSlow === null) {
                priceSlow = this.firstNonNull([
                    this.pickNumber(slowPriceDetail, ['userPayTotalPrice', 'marketPrice', 'salePrice']),
                    this.pickNumber(item, ['slowPrice'])
                ]);
            }

            if (priceSuper === null) {
                priceSuper = this.firstNonNull([
                    this.pickNumber(superPriceDetail, ['userPayTotalPrice', 'marketPrice', 'salePrice']),
                    this.pickNumber(item, ['superPrice'])
                ]);
            }
            
            // 提取场站名称（允许为空）
            const stationName = item.stationName || item.name || item.fullStationName || null;
            const stationId = item.stationId || item.fullStationId || item.id || null;
            
            const fastConnectorList = Array.isArray(business.fastConnectorList) ? business.fastConnectorList : [];
            const slowConnectorList = Array.isArray(business.slowConnectorList) ? business.slowConnectorList : [];
            const superConnectorList = Array.isArray(business.superConnectorList) ? business.superConnectorList : [];

            const fastIdlePorts = this.toNonNegativeInt(this.firstNonNull([
                this.pickNumber(item, ['fastChargeIdleNum']),
                this.pickNumber(business, ['fastUsableNum']),
                this.countIdleConnectors(fastConnectorList)
            ]));
            const slowIdlePorts = this.toNonNegativeInt(this.firstNonNull([
                this.pickNumber(item, ['slowChargeIdleNum']),
                this.pickNumber(business, ['slowUsableNum']),
                this.countIdleConnectors(slowConnectorList)
            ]));
            const superIdlePorts = this.toNonNegativeInt(this.firstNonNull([
                this.pickNumber(item, ['superChargeIdleNum']),
                this.pickNumber(business, ['superUsableNum']),
                this.countIdleConnectors(superConnectorList)
            ]));
            const fastTotalPorts = this.toNonNegativeInt(this.firstNonNull([
                this.pickNumber(item, ['fastChargeNum']),
                this.pickNumber(business, ['fastTotalNum']),
                fastConnectorList.length > 0 ? fastConnectorList.length : null
            ]));
            const slowTotalPorts = this.toNonNegativeInt(this.firstNonNull([
                this.pickNumber(item, ['slowChargeNum']),
                this.pickNumber(business, ['slowTotalNum']),
                slowConnectorList.length > 0 ? slowConnectorList.length : null
            ]));
            const superTotalPorts = this.toNonNegativeInt(this.firstNonNull([
                this.pickNumber(item, ['superChargeNum']),
                this.pickNumber(business, ['superTotalNum']),
                superConnectorList.length > 0 ? superConnectorList.length : null
            ]));

            stations.push({
                platform: 'didi-charging',
                stationId: stationId,
                stationName: stationName,
                address: item.address || item.stationAddress || null,
                latitude: item.lat || item.latitude,
                longitude: item.lng || item.longitude,
                priceFast: priceFast,
                priceSlow: priceSlow,
                priceSuper: priceSuper,
                priceService: null,
                fastIdlePorts,
                fastTotalPorts,
                slowIdlePorts,
                slowTotalPorts,
                superIdlePorts,
                superTotalPorts,
                onlineFastPorts: fastIdlePorts + superIdlePorts,
                onlineSlowPorts: slowIdlePorts,
                availablePorts: fastIdlePorts + slowIdlePorts + superIdlePorts,
                totalPorts: fastTotalPorts + slowTotalPorts + superTotalPorts,
                sourceType: context.sourceType || null,
                sourceStage: context.sourceStage || null,
                raw: item
            });
        }
        
        return stations;
    }

    parseTeldResponse(data, context = {}) {
        // 特来电 API 响应格式
        const stations = [];
        const list = data.Data || data.data || [];
        if (!Array.isArray(list)) {
            return stations;
        }
        
        for (const item of list) {
            if (!item || typeof item !== 'object') {
                continue;
            }
            const stationName = item.StationName || item.name || null;
            const stationId = item.StationID || item.stationId || null;
            const fastIdlePorts = this.toNonNegativeInt(item.FastIdleNum || item.FastAvailableNum || item.DirectIdleNum);
            const slowIdlePorts = this.toNonNegativeInt(item.SlowIdleNum || item.SlowAvailableNum || item.AlternateIdleNum);
            const superIdlePorts = this.toNonNegativeInt(item.SuperIdleNum || item.SuperAvailableNum);
            const fastTotalPorts = this.toNonNegativeInt(item.FastNum || item.DirectNum);
            const slowTotalPorts = this.toNonNegativeInt(item.SlowNum || item.AlternateNum);
            const superTotalPorts = this.toNonNegativeInt(item.SuperNum);
            
            stations.push({
                platform: 'teld',
                stationId: stationId,
                stationName: stationName,
                address: item.Address || null,
                latitude: item.StationLat,
                longitude: item.StationLng,
                priceFast: item.FastPrice,
                priceSlow: item.SlowPrice,
                priceSuper: item.SuperPrice,
                priceService: item.ServicePrice,
                fastIdlePorts,
                fastTotalPorts,
                slowIdlePorts,
                slowTotalPorts,
                superIdlePorts,
                superTotalPorts,
                onlineFastPorts: fastIdlePorts + superIdlePorts,
                onlineSlowPorts: slowIdlePorts,
                availablePorts: this.firstNonNull([
                    this.pickNumber(item, ['AvailableNum']),
                    fastIdlePorts + slowIdlePorts + superIdlePorts
                ]),
                totalPorts: this.firstNonNull([
                    this.pickNumber(item, ['TotalNum']),
                    fastTotalPorts + slowTotalPorts + superTotalPorts
                ]),
                sourceType: context.sourceType || null,
                sourceStage: context.sourceStage || null,
                raw: item
            });
        }
        
        return stations;
    }

    parseStarChargeResponse(data, context = {}) {
        const priceDetailStations = this.parseStarChargePriceDetail(data, context);
        if (priceDetailStations.length > 0) {
            return priceDetailStations;
        }

        const list = this.extractCandidateList(data);
        return list.map(item => this.normalizeStationItem(item, 'star-charge', context)).filter(Boolean);
    }

    parseStarChargePriceDetail(data, context = {}) {
        const chargingPrices = Array.isArray(data?.data?.chargingPrices)
            ? data.data.chargingPrices
            : [];
        if (chargingPrices.length === 0) {
            return [];
        }

        const stationId = this.getFirstDefined(
            { ...context.request?.queryParams, ...context.request?.bodyParams, ...(data?.data || {}) },
            ['stubGroupId', 'id']
        );
        const priceInfo = this.extractStarChargePriceSummary(chargingPrices);
        const servicePrice = this.firstNonNull([
            priceInfo.service,
            this.pickNumber(data, ['data.parkingInfo.servicePrice'])
        ]);

        return [{
            platform: 'star-charge',
            stationId: stationId || null,
            stationName: null,
            address: null,
            latitude: null,
            longitude: null,
            priceFast: priceInfo.fast,
            priceSlow: priceInfo.slow,
            priceSuper: priceInfo.super,
            priceService: servicePrice,
            fastIdlePorts: 0,
            fastTotalPorts: 0,
            slowIdlePorts: 0,
            slowTotalPorts: 0,
            superIdlePorts: 0,
            superTotalPorts: 0,
            onlineFastPorts: 0,
            onlineSlowPorts: 0,
            availablePorts: null,
            totalPorts: null,
            sourceType: context.sourceType || null,
            sourceStage: context.sourceStage || null,
            raw: {
                source: context.sourceType || 'har-import',
                chargingPrices
            }
        }];
    }

    parseKuaidianResponse(data, context = {}) {
        if (Array.isArray(data?.result) && data.result.length > 0) {
            const stationId = this.getFirstDefined(
                { ...context.request?.queryParams, ...context.request?.bodyParams },
                ['stationCode', 'stationId', 'czbStationId']
            );
            const connectorSummary = this.extractKuaidianConnectorSummary(data.result);
            if (stationId || connectorSummary.totalPorts > 0) {
                return [{
                    platform: 'kuaidian',
                    stationId: stationId || null,
                    stationName: null,
                    address: null,
                    latitude: null,
                    longitude: null,
                    priceFast: null,
                    priceSlow: null,
                    priceSuper: null,
                    priceService: null,
                    fastIdlePorts: connectorSummary.fastIdlePorts,
                    fastTotalPorts: connectorSummary.fastTotalPorts,
                    slowIdlePorts: connectorSummary.slowIdlePorts,
                    slowTotalPorts: connectorSummary.slowTotalPorts,
                    superIdlePorts: connectorSummary.superIdlePorts,
                    superTotalPorts: connectorSummary.superTotalPorts,
                    onlineFastPorts: connectorSummary.fastIdlePorts + connectorSummary.superIdlePorts,
                    onlineSlowPorts: connectorSummary.slowIdlePorts,
                    availablePorts: connectorSummary.availablePorts,
                    totalPorts: connectorSummary.totalPorts,
                    sourceType: context.sourceType || null,
                    sourceStage: context.sourceStage || null,
                    raw: {
                        source: context.sourceType || 'har-import',
                        connectors: data.result
                    }
                }];
            }
        }

        const list = this.extractCandidateList(data);
        return list.map(item => this.normalizeStationItem(item, 'kuaidian', context)).filter(Boolean);
    }

    parseTuanyouResponse(data, context = {}) {
        const gunInfo = data?.result?.gasOilGunInfoResponseDtoList;
        if (Array.isArray(gunInfo) && gunInfo.length > 0) {
            const gasId = this.getFirstDefined(context.request?.bodyParams || {}, ['gasId']) || null;
            const fuelCounts = this.extractFuelCountsFromGunInfo(gunInfo);
            return [{
                platform: 'tuanyou',
                stationId: gasId,
                stationName: null,
                address: null,
                latitude: null,
                longitude: null,
                priceFast: null,
                priceSlow: null,
                priceSuper: null,
                priceService: null,
                fastIdlePorts: 0,
                fastTotalPorts: 0,
                slowIdlePorts: 0,
                slowTotalPorts: 0,
                superIdlePorts: 0,
                superTotalPorts: 0,
                onlineFastPorts: 0,
                onlineSlowPorts: 0,
                availablePorts: null,
                totalPorts: null,
                fuel92Count: fuelCounts['92'] ?? null,
                fuel95Count: fuelCounts['95'] ?? null,
                fuel98Count: fuelCounts['98'] ?? null,
                fuelDieselCount: fuelCounts.diesel ?? null,
                sourceType: context.sourceType || null,
                sourceStage: context.sourceStage || null,
                raw: {
                    ...data.result,
                    source: context.sourceType || 'har-import'
                }
            }];
        }

        const list = this.extractCandidateList(data);
        return list.map(item => this.normalizeStationItem(item, 'tuanyou', context)).filter(Boolean);
    }

    parseGenericResponse(data, platform, context = {}) {
        const list = this.extractCandidateList(data);
        return list.map(item => this.normalizeStationItem(item, platform, context)).filter(Boolean);
    }

    deduplicateStations(stations) {
        const bestByKey = new Map();
        for (const station of stations) {
            const keys = this.getStationDedupKeys(station);
            if (keys.length === 0) {
                continue;
            }

            const existing = keys.map(key => bestByKey.get(key)).find(Boolean) || null;
            const merged = existing
                ? this.mergeStations(existing, station)
                : station;

            for (const key of this.getStationDedupKeys(merged)) {
                bestByKey.set(key, merged);
            }
        }

        return Array.from(new Set(bestByKey.values()));
    }

    getStationDedupKeys(station = {}) {
        const keys = [];
        const platform = station.platform || '';
        const stationId = station.stationId ? String(station.stationId).trim() : '';
        if (stationId) {
            keys.push([platform, `id:${stationId}`].join('|'));
        }

        const fallbackParts = [
            station.stationName || '',
            station.address || '',
            station.latitude || '',
            station.longitude || ''
        ];
        if (fallbackParts.some(Boolean)) {
            keys.push([platform, ...fallbackParts].join('|'));
        }

        return keys;
    }

    mergeStations(existing, incoming) {
        const merged = { ...existing };
        const stringFields = ['platform', 'stationId', 'stationName', 'address', 'sourceType', 'sourceStage'];
        const numericFields = [
            'latitude', 'longitude',
            'priceFast', 'priceSlow', 'priceSuper', 'priceService',
            'fuel92Price', 'fuel95Price', 'fuel98Price', 'fuelDieselPrice'
        ];
        const maxNumericFields = [
            'fastIdlePorts', 'fastTotalPorts', 'slowIdlePorts', 'slowTotalPorts', 'superIdlePorts', 'superTotalPorts',
            'onlineFastPorts', 'onlineSlowPorts', 'availablePorts', 'totalPorts',
            'fuel92Count', 'fuel95Count', 'fuel98Count', 'fuelDieselCount'
        ];

        for (const field of stringFields) {
            merged[field] = this.pickBestString(existing[field], incoming[field]);
        }

        for (const field of numericFields) {
            merged[field] = this.pickBestNumber(existing[field], incoming[field]);
        }

        for (const field of maxNumericFields) {
            merged[field] = this.pickMaxNumber(existing[field], incoming[field]);
        }

        merged.raw = this.pickBestRaw(existing.raw, incoming.raw);
        return merged;
    }

    pickBestString(currentValue, incomingValue) {
        const current = String(currentValue || '').trim();
        const incoming = String(incomingValue || '').trim();
        if (!incoming) {
            return currentValue ?? null;
        }
        if (!current) {
            return incomingValue;
        }
        return incoming.length > current.length ? incomingValue : currentValue;
    }

    pickBestNumber(currentValue, incomingValue) {
        const current = Number(currentValue);
        const incoming = Number(incomingValue);
        const hasCurrent = Number.isFinite(current);
        const hasIncoming = Number.isFinite(incoming);

        if (!hasIncoming) {
            return hasCurrent ? currentValue : null;
        }
        if (!hasCurrent) {
            return incomingValue;
        }

        if (incoming > 0 && current <= 0) {
            return incomingValue;
        }

        const incomingPrecision = this.getNumericPrecision(incoming);
        const currentPrecision = this.getNumericPrecision(current);
        if (incomingPrecision > currentPrecision && incoming > 0) {
            return incomingValue;
        }

        return currentValue;
    }

    pickBestRaw(currentRaw, incomingRaw) {
        const currentScore = currentRaw && typeof currentRaw === 'object'
            ? Object.keys(currentRaw).length
            : 0;
        const incomingScore = incomingRaw && typeof incomingRaw === 'object'
            ? Object.keys(incomingRaw).length
            : 0;
        return incomingScore >= currentScore ? incomingRaw : currentRaw;
    }

    getNumericPrecision(value) {
        const text = String(value ?? '');
        const index = text.indexOf('.');
        return index >= 0 ? text.length - index - 1 : 0;
    }

    pickMaxNumber(currentValue, incomingValue) {
        const current = Number(currentValue);
        const incoming = Number(incomingValue);
        const hasCurrent = Number.isFinite(current);
        const hasIncoming = Number.isFinite(incoming);

        if (!hasIncoming) {
            return hasCurrent ? currentValue : null;
        }
        if (!hasCurrent) {
            return incomingValue;
        }

        return incoming > current ? incomingValue : currentValue;
    }

    extractCandidateList(data) {
        const directCandidates = [
            data,
            data?.data,
            data?.data?.list,
            data?.data?.records,
            data?.data?.items,
            data?.result,
            data?.result?.list,
            data?.result?.items,
            data?.result?.records,
            data?.result?.chargeStationInfoList
        ].filter(Boolean);

        for (const candidate of directCandidates) {
            if (this.isStationObjectCandidate(candidate)) {
                return [candidate];
            }
            const list = this.findStationArray(candidate);
            if (list.length > 0) {
                return list;
            }
        }

        return this.findStationArray(data);
    }

    isStationObjectCandidate(candidate) {
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
            return false;
        }

        const score = this.scoreStationCandidate(candidate);
        if (score < 4) {
            return false;
        }

        const hasNameOrId = Boolean(this.getFirstDefined(candidate, [
            'stationName', 'name', 'fullStationName', 'title', 'StationName',
            'stationId', 'stationCode', 'id', 'fullStationId', 'StationID',
            'gasName', 'gasId'
        ]));
        const hasLocation = this.pickNumber(candidate, [
            'lat', 'latitude', 'stationLat', 'StationLat', 'gisGcj02Lat', 'gcj02Lat', 'gasAddressLatitude'
        ]) !== null && this.pickNumber(candidate, [
            'lng', 'longitude', 'lon', 'stationLng', 'StationLng', 'gisGcj02Lng', 'gcj02Lng', 'gasAddressLongitude'
        ]) !== null;
        const hasAddress = Boolean(this.getFirstDefined(candidate, ['address', 'addr', 'stationAddress', 'Address', 'gasAddress']));

        return hasNameOrId && (hasLocation || hasAddress);
    }

    findStationArray(node, depth = 0) {
        if (!node || depth > 6) {
            return [];
        }

        if (Array.isArray(node)) {
            const stationItems = node.filter(item => this.scoreStationCandidate(item) >= 3);
            if (stationItems.length > 0) {
                return stationItems;
            }

            for (const item of node) {
                const found = this.findStationArray(item, depth + 1);
                if (found.length > 0) {
                    return found;
                }
            }

            return [];
        }

        if (typeof node !== 'object') {
            return [];
        }

        const priorityKeys = [
            'chargeStationInfoList',
            'stationList',
            'stations',
            'list',
            'records',
            'items',
            'rows',
            'data',
            'result'
        ];

        for (const key of priorityKeys) {
            if (node[key] !== undefined) {
                const found = this.findStationArray(node[key], depth + 1);
                if (found.length > 0) {
                    return found;
                }
            }
        }

        for (const value of Object.values(node)) {
            const found = this.findStationArray(value, depth + 1);
            if (found.length > 0) {
                return found;
            }
        }

        return [];
    }

    scoreStationCandidate(item) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            return 0;
        }

        let score = 0;
        const keys = Object.keys(item);

        if (this.getFirstDefined(item, ['stationName', 'name', 'fullStationName', 'title', 'gasName'])) score += 1;
        if (this.getFirstDefined(item, ['stationId', 'stationCode', 'id', 'fullStationId', 'StationID', 'gasId'])) score += 1;
        if (this.getFirstDefined(item, ['address', 'addr', 'stationAddress', 'Address', 'gasAddress'])) score += 1;
        if (this.pickNumber(item, ['lat', 'latitude', 'stationLat', 'StationLat', 'gisGcj02Lat', 'gasAddressLatitude'])) score += 1;
        if (this.pickNumber(item, ['lng', 'longitude', 'lon', 'stationLng', 'StationLng', 'gisGcj02Lng', 'gasAddressLongitude'])) score += 1;
        if (keys.some(key => /charge|stub|station/i.test(key))) score += 1;

        return score;
    }

    normalizeStationItem(item, platform, context = {}) {
        const stationName = this.getFirstDefined(item, [
            'stationName', 'name', 'fullStationName', 'station_name', 'title', 'StationName', 'gasName'
        ]);
        const stationId = this.getFirstDefined(item, [
            'stationId', 'stationCode', 'id', 'station_id', 'fullStationId', 'StationID', 'gasId'
        ]);
        const latitude = this.pickNumber(item, [
            'lat', 'latitude', 'stationLat', 'StationLat', 'gisGcj02Lat', 'gcj02Lat', 'gasAddressLatitude'
        ]);
        const longitude = this.pickNumber(item, [
            'lng', 'longitude', 'lon', 'stationLng', 'StationLng', 'gisGcj02Lng', 'gcj02Lng', 'gasAddressLongitude'
        ]);

        if (!stationName && !stationId) {
            return null;
        }

        const fastIdlePorts = this.toNonNegativeInt(this.firstNonNull([
            this.pickNumber(item, ['fastChargeIdleNum', 'dcIdleCnt', 'directLeftCount']),
            this.sumNumbers(item, ['fastChargeIdleNum', 'dcIdleCnt', 'directLeftCount'])
        ]));
        const slowIdlePorts = this.toNonNegativeInt(this.firstNonNull([
            this.pickNumber(item, ['slowChargeIdleNum', 'acIdleCnt', 'alternateLeftCount']),
            this.sumNumbers(item, ['slowChargeIdleNum', 'acIdleCnt', 'alternateLeftCount'])
        ]));
        const superIdlePorts = this.toNonNegativeInt(this.firstNonNull([
            this.pickNumber(item, ['superChargeIdleNum', 'superLeftCount']),
            this.sumNumbers(item, ['superChargeIdleNum', 'superLeftCount'])
        ]));
        const fastTotalPorts = this.toNonNegativeInt(this.firstNonNull([
            this.pickNumber(item, ['fastChargeNum', 'dcCnt', 'directCount']),
            this.sumNumbers(item, ['fastChargeNum', 'dcCnt', 'directCount'])
        ]));
        const slowTotalPorts = this.toNonNegativeInt(this.firstNonNull([
            this.pickNumber(item, ['slowChargeNum', 'acCnt', 'alternateCount']),
            this.sumNumbers(item, ['slowChargeNum', 'acCnt', 'alternateCount'])
        ]));
        const superTotalPorts = this.toNonNegativeInt(this.firstNonNull([
            this.pickNumber(item, ['superChargeNum', 'superCount']),
            this.sumNumbers(item, ['superChargeNum', 'superCount'])
        ]));
        const inferredAvailable = fastIdlePorts + slowIdlePorts + superIdlePorts;
        const inferredTotal = fastTotalPorts + slowTotalPorts + superTotalPorts;
        const fuelSummary = platform === 'tuanyou'
            ? this.extractFuelSummary(item, context)
            : {};

        return {
            platform,
            stationId: stationId || null,
            stationName: stationName || null,
            address: this.getFirstDefined(item, ['address', 'addr', 'stationAddress', 'Address', 'gasAddress']) || null,
            latitude,
            longitude,
            priceFast: this.pickNumber(item, [
                'fastPrice', 'dcPrice', 'fast_price', 'FastPrice',
                'extraInfo.stubGroupFeeInfo.actualFee.eleAmount',
                'totalFee', 'originFeeInfo.totalFee', 'discountFeeInfo.totalFee',
                'price', 'memberPrice', 'originalPrice', 'vipPrice',
                'price2BigDecimal', 'gunPrice', 'price2', 'price1',
                'directTotalPrice', 'directMemberPrice', 'directVipPrice'
            ]),
            priceSlow: this.pickNumber(item, [
                'slowPrice', 'acPrice', 'slow_price', 'SlowPrice',
                'originFeeInfo.eleAmount', 'discountFeeInfo.eleAmount',
                'alternateTotalPrice', 'alternateMemberPrice', 'alternateVipPrice'
            ]),
            priceSuper: this.pickNumber(item, [
                'superPrice', 'super_price', 'SuperPrice',
                'superChargePrice', 'superGunPrice'
            ]),
            priceService: this.pickNumber(item, [
                'serviceFee', 'service_fee', 'ServicePrice',
                'extraInfo.stubGroupFeeInfo.actualFee.serviceAmount',
                'originFeeInfo.serviceAmount', 'discountFeeInfo.serviceAmount'
            ]),
            fastIdlePorts,
            fastTotalPorts,
            slowIdlePorts,
            slowTotalPorts,
            superIdlePorts,
            superTotalPorts,
            fuel92Price: fuelSummary.fuel92Price ?? null,
            fuel95Price: fuelSummary.fuel95Price ?? null,
            fuel98Price: fuelSummary.fuel98Price ?? null,
            fuelDieselPrice: fuelSummary.fuelDieselPrice ?? null,
            fuel92Count: fuelSummary.fuel92Count ?? null,
            fuel95Count: fuelSummary.fuel95Count ?? null,
            fuel98Count: fuelSummary.fuel98Count ?? null,
            fuelDieselCount: fuelSummary.fuelDieselCount ?? null,
            onlineFastPorts: this.firstNonNull([
                this.sumNumbers(item, ['dcIdleCnt', 'fastChargeIdleNum', 'superChargeIdleNum', 'directLeftCount']),
                this.sumNumbers(item, ['directLeftCount', 'superLeftCount']),
                this.pickNumber(item, ['FastAvailableNum']),
                fastIdlePorts + superIdlePorts
            ]),
            onlineSlowPorts: this.firstNonNull([
                this.sumNumbers(item, ['acIdleCnt', 'slowChargeIdleNum']),
                this.pickNumber(item, ['alternateLeftCount']),
                this.pickNumber(item, ['SlowAvailableNum']),
                slowIdlePorts
            ]),
            availablePorts: this.firstNonNull([
                this.pickNumber(item, ['availableCount', 'available', 'AvailableNum']),
                inferredAvailable
            ]),
            totalPorts: this.firstNonNull([
                this.pickNumber(item, ['totalCount', 'total', 'TotalNum']),
                inferredTotal,
                this.sumNumbers(item, ['alternateCount', 'directCount', 'superCount', 'acCnt', 'dcCnt'])
            ]),
            sourceType: context.sourceType || null,
            sourceStage: context.sourceStage || null,
            raw: item
        };
    }

    extractFuelSummary(item, context = {}) {
        const fuelMap = {};
        const applyFuel = (label, payload = {}) => {
            if (label === '92') {
                if (payload.price !== undefined) fuelMap.fuel92Price = payload.price;
                if (payload.count !== undefined) fuelMap.fuel92Count = payload.count;
            } else if (label === '95') {
                if (payload.price !== undefined) fuelMap.fuel95Price = payload.price;
                if (payload.count !== undefined) fuelMap.fuel95Count = payload.count;
            } else if (label === '98') {
                if (payload.price !== undefined) fuelMap.fuel98Price = payload.price;
                if (payload.count !== undefined) fuelMap.fuel98Count = payload.count;
            } else if (label === 'diesel') {
                if (payload.price !== undefined) fuelMap.fuelDieselPrice = payload.price;
                if (payload.count !== undefined) fuelMap.fuelDieselCount = payload.count;
            }
        };

        const oilLabel = this.normalizeFuelLabel(this.getFirstDefined(item, ['oilNo', 'oilName']));
        const userPrice = this.firstNonNull([
            this.pickNumber(item, ['czbPrice', 'userPrice', 'price2BigDecimal']),
            this.pickNumber(item, ['price2'])
        ]);
        const gunPrice = this.firstNonNull([
            this.pickNumber(item, ['gunPrice', 'officialPrice']),
            this.pickNumber(item, ['price1'])
        ]);

        if (oilLabel) {
            applyFuel(oilLabel, { price: userPrice ?? gunPrice ?? undefined });
        }

        const fuelCounts = this.extractFuelCountsFromGunInfo(item.gasOilGunInfoResponseDtoList || []);
        for (const [label, count] of Object.entries(fuelCounts)) {
            applyFuel(label, { count });
        }

        const requestOilLabel = this.normalizeFuelLabel(this.getFirstDefined(context.request?.bodyParams || {}, ['oilNo']));
        if (requestOilLabel && fuelMap[this.getFuelPriceKey(requestOilLabel)] === undefined && userPrice !== null) {
            applyFuel(requestOilLabel, { price: userPrice });
        }

        return fuelMap;
    }

    extractStarChargePriceSummary(chargingPrices = []) {
        const summary = { fast: null, slow: null, super: null, service: null };

        for (const group of chargingPrices) {
            const firstPrice = Array.isArray(group?.prices) ? group.prices[0] : null;
            if (!firstPrice) {
                continue;
            }

            const totalPrice = this.firstNonNull([
                this.pickNumber(firstPrice, ['originPrice.totalPrice']),
                this.pickNumber(firstPrice, ['memberActPrice.totalPrice']),
                this.pickNumber(firstPrice, ['commonActPrice.totalPrice']),
                this.pickNumber(firstPrice, ['minPrice'])
            ]);
            const servicePrice = this.firstNonNull([
                this.pickNumber(firstPrice, ['originPrice.servicePrice']),
                this.pickNumber(firstPrice, ['memberActPrice.servicePrice']),
                this.pickNumber(firstPrice, ['commonActPrice.servicePrice'])
            ]);

            const mappedType = this.mapStarChargePriceType(group?.type);
            if (mappedType === 'slow') {
                summary.slow = summary.slow ?? totalPrice;
            } else if (mappedType === 'super') {
                summary.super = summary.super ?? totalPrice;
            } else {
                summary.fast = summary.fast ?? totalPrice;
            }

            if (summary.service === null && servicePrice !== null) {
                summary.service = servicePrice;
            }
        }

        return summary;
    }

    mapStarChargePriceType(type) {
        if (type === 2 || type === '2') return 'slow';
        if (type === 3 || type === '3') return 'super';
        return 'fast';
    }

    extractKuaidianConnectorSummary(connectors = []) {
        const summary = {
            fastIdlePorts: 0,
            fastTotalPorts: 0,
            slowIdlePorts: 0,
            slowTotalPorts: 0,
            superIdlePorts: 0,
            superTotalPorts: 0,
            availablePorts: 0,
            totalPorts: 0
        };

        for (const connector of connectors) {
            const bucket = this.classifyKuaidianConnector(connector);
            const isIdle = this.isConnectorIdle(connector);
            summary.availablePorts += isIdle ? 1 : 0;
            summary.totalPorts += 1;

            if (bucket === 'slow') {
                summary.slowTotalPorts += 1;
                summary.slowIdlePorts += isIdle ? 1 : 0;
            } else if (bucket === 'super') {
                summary.superTotalPorts += 1;
                summary.superIdlePorts += isIdle ? 1 : 0;
            } else {
                summary.fastTotalPorts += 1;
                summary.fastIdlePorts += isIdle ? 1 : 0;
            }
        }

        return summary;
    }

    classifyKuaidianConnector(connector = {}) {
        const typeName = String(this.getFirstDefined(connector, ['czbConnectorTypeName']) || '').trim();
        const displayType = String(this.getFirstDefined(connector, ['displayConnectorType']) || '').trim();
        const powerDesc = String(this.getFirstDefined(connector, ['powerDesc']) || '').trim();

        if (/交流|慢/.test(typeName) || displayType === '1') {
            return 'slow';
        }
        if (/超充/.test(typeName) || /^480kW|^600kW/i.test(powerDesc) || displayType === '99') {
            return 'super';
        }
        return 'fast';
    }

    isConnectorIdle(connector = {}) {
        const statusCode = this.pickNumber(connector, ['status', 'czbStatus']);
        if (statusCode === 1) {
            return true;
        }

        const statusText = String(this.getFirstDefined(connector, ['statusDesc']) || '').trim();
        return /空闲|可用|available|idle/i.test(statusText);
    }

    extractFuelCountsFromGunInfo(groups = []) {
        const counts = {};
        if (!Array.isArray(groups)) {
            return counts;
        }

        for (const group of groups) {
            const oilList = Array.isArray(group?.oilList) ? group.oilList : [];
            for (const oil of oilList) {
                const label = this.normalizeFuelLabel(this.getFirstDefined(oil, ['oilNo', 'oilName']));
                if (!label) {
                    continue;
                }
                const gunList = Array.isArray(oil.gunList) ? oil.gunList : [];
                counts[label] = gunList.length;
            }
        }

        return counts;
    }

    normalizeFuelLabel(value) {
        const text = String(value ?? '').trim();
        if (!text) {
            return null;
        }
        if (/92/.test(text)) return '92';
        if (/95/.test(text)) return '95';
        if (/98/.test(text)) return '98';
        if (/柴油|0#|diesel/i.test(text)) return 'diesel';
        return null;
    }

    getFuelPriceKey(label) {
        if (label === '92') return 'fuel92Price';
        if (label === '95') return 'fuel95Price';
        if (label === '98') return 'fuel98Price';
        if (label === 'diesel') return 'fuelDieselPrice';
        return '';
    }

    getFirstDefined(obj, paths) {
        for (const pathKey of paths) {
            const value = this.getPathValue(obj, pathKey);
            if (value !== undefined && value !== null && value !== '') {
                return value;
            }
        }

        return null;
    }

    pickNumber(obj, paths) {
        const value = this.getFirstDefined(obj, paths);
        if (value === null) {
            return null;
        }

        const num = Number(value);
        return Number.isFinite(num) ? num : null;
    }

    getPathValue(obj, pathKey) {
        return pathKey.split('.').reduce((acc, key) => {
            if (acc === undefined || acc === null) {
                return undefined;
            }
            return acc[key];
        }, obj);
    }

    firstNonNull(values) {
        for (const value of values) {
            if (value !== null && value !== undefined) {
                return value;
            }
        }

        return null;
    }

    sumNumbers(obj, paths) {
        const numbers = paths
            .map(pathKey => this.pickNumber(obj, [pathKey]))
            .filter(value => value !== null);

        if (numbers.length === 0) {
            return null;
        }

        return numbers.reduce((sum, value) => sum + value, 0);
    }

    toNonNegativeInt(value) {
        const num = Number(value);
        if (!Number.isFinite(num)) {
            return 0;
        }
        return Math.max(0, Math.round(num));
    }

    countIdleConnectors(connectors) {
        if (!Array.isArray(connectors) || connectors.length === 0) {
            return null;
        }

        return connectors.reduce((count, connector) => {
            const statusCode = this.pickNumber(connector, ['conDetailStatus', 'status', 'connectorStatus']);
            if (statusCode === 1) {
                return count + 1;
            }

            const statusText = String(
                this.getFirstDefined(connector, ['conDetailStatusDesc', 'statusDesc', 'statusText']) || ''
            ).toLowerCase();

            if (/idle|free|available|空闲|可用|正常/.test(statusText)) {
                return count + 1;
            }

            return count;
        }, 0);
    }

    scoreStationData(station) {
        if (!station || typeof station !== 'object') {
            return 0;
        }

        let score = 0;
        if (station.stationName) score += 1;
        if (station.stationId) score += 2;
        if (station.address) score += 2;
        if (station.latitude !== null && station.latitude !== undefined) score += 1;
        if (station.longitude !== null && station.longitude !== undefined) score += 1;
        if (station.priceFast !== null && station.priceFast !== undefined) score += 2;
        if (station.priceSlow !== null && station.priceSlow !== undefined) score += 2;
        if (station.priceService !== null && station.priceService !== undefined) score += 1;
        if (this.toNonNegativeInt(station.totalPorts) > 0) score += 2;
        if (this.toNonNegativeInt(station.availablePorts) > 0) score += 2;
        if (this.toNonNegativeInt(station.fastTotalPorts) > 0) score += 2;
        if (this.toNonNegativeInt(station.slowTotalPorts) > 0) score += 2;
        if (this.toNonNegativeInt(station.superTotalPorts) > 0) score += 2;

        const raw = station.raw;
        if (raw && typeof raw === 'object') {
            if (raw.businessSituation) score += 3;
            if (raw.fastConnectorPriceDescription) score += 2;
            if (raw.slowConnectorPriceDescription) score += 2;
            if (raw.occupancyInfo) score += 1;
            if (Array.isArray(raw.dpolicyPriceList) && raw.dpolicyPriceList.length > 0) score += 1;
            if (Array.isArray(raw.stubGroupDetailFeeInfos) && raw.stubGroupDetailFeeInfos.length > 0) score += 2;
            if (Array.isArray(raw.aggregatedPrices) && raw.aggregatedPrices.length > 0) score += 2;
        }

        return score;
}


}

module.exports = HarParser;
