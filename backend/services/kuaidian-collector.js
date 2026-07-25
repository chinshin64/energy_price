'use strict';

const crypto = require('crypto');
const axios = require('axios');
const https = require('https');
const { KuaidianCredentialProvider } = require('./kuaidian-credential-provider');

/**
 * 快电(能链) 采集器
 *
 * 对标 didi-signature-provider 的 class 风格：constructor + 采集方法。
 * 参考已验证脚本 wx-analysis/kuaidian-verify.py (Python) 转写为 Node。
 *
 * 签名: MD5(appSecret + sorted(key+value) + appSecret).toLowerCase()
 * 匿名(token="")，响应明文 JSON {code,message,result:{totalCount,stationInfoList}}
 *
 * 搜站接口: charge/app/stationList (POST, application/x-www-form-urlencoded)
 *   参数 latitude/longitude/userLatStr/userLngStr/chargeType:1/distance/pageIndex/pageSize
 */
class KuaidianCollector {
    constructor(options = {}) {
        this.browserSigner = options.browserSigner || null;
        this.credentialProvider = options.credentialProvider instanceof KuaidianCredentialProvider
            ? options.credentialProvider
            : new KuaidianCredentialProvider(options.credentials || options);
        this.timeout = options.timeout || 15000;
        this.platform = 'kuaidian';
        this.lastSignatureSource = 'manual';
    }

    /**
     * 计算签名：MD5(appSecret + sorted(key+value) + appSecret).toLowerCase()
     * 复刻 app-service.js 模块 35659 的 generate 逻辑：
     *   - 删 sign 字段
     *   - null/undefined -> ""
     *   - 按 key 字典序升序拼接 key+value
     */
    sign(params) {
        const credentials = this.credentialProvider.requireCredentials();
        const signingPayload = {};
        for (const [key, value] of Object.entries(params)) {
            if (key === 'sign') {
                continue;
            }
            if (value === undefined || value === null || value === 'undefined') {
                signingPayload[key] = '';
            } else {
                signingPayload[key] = value;
            }
        }
        const serialized = Object.keys(signingPayload)
            .sort()
            .map(key => `${key}${signingPayload[key]}`)
            .join('');
        return crypto
            .createHash('md5')
            .update(`${credentials.appSecret}${serialized}${credentials.appSecret}`, 'utf8')
            .digest('hex')
            .toLowerCase();
    }

    /**
     * 注入公共参数并签名，复刻 hj 包装器 L：
     *   token(匿名空) / sensor_id / device_id / sa_distinct_id / sa_anonymous_id / ticket / app_name / C_TERMINNAL_TYPE / platformType
     */
    buildSignedParams(data = {}, permId = '') {
        const credentials = this.credentialProvider.requireCredentials();
        const params = { ...data };
        params.token = credentials.token;
        params.sensor_id = credentials.sensorId;
        params.device_id = credentials.deviceId;
        params.sa_distinct_id = credentials.saDistinctId;
        params.sa_anonymous_id = credentials.saAnonymousId;
        if (credentials.saAnonymousId) params.ticket = credentials.saAnonymousId;
        params.app_name = credentials.appName;
        params.C_TERMINNAL_TYPE = credentials.terminalType;
        params.platformType = credentials.platformType;
        if (permId) params.perm_id = permId;

        // 公共参数
        params.app_key = credentials.appKey;
        params.timestamp = String(Date.now());
        params.app_terminal = credentials.appTerminal;

        // 统一 null/undefined -> ""
        for (const key of Object.keys(params)) {
            if (params[key] === undefined || params[key] === null) {
                params[key] = '';
            } else if (typeof params[key] === 'number') {
                params[key] = String(params[key]);
            } else if (params[key] === 'undefined') {
                params[key] = '';
            }
        }

        params.sign = this.sign(params);
        return params;
    }

    async buildSignedParamsWithBrowser(data = {}, permId = '') {
        const params = this.buildSignedParams(data, permId);
        if (!this.browserSigner || typeof this.browserSigner.sign !== 'function') {
            this.lastSignatureSource = 'manual';
            return params;
        }
        try {
            const browserInput = { ...params };
            delete browserInput.sign;
            const result = await this.browserSigner.sign('kuaidian', browserInput);
            const signature = typeof result === 'string' ? result : result?.sign;
            if (typeof signature !== 'string' || !/^[a-f\d]{32}$/i.test(signature)) {
                throw new Error('browser signer returned an invalid kuaidian signature');
            }
            params.sign = signature.toLowerCase();
            this.lastSignatureSource = 'browser';
        } catch {
            this.lastSignatureSource = 'manual-fallback';
        }
        return params;
    }

    async postForm(endpoint, data = {}, permId = '') {
        const credentials = this.credentialProvider.requireCredentials();
        const url = `${credentials.host}/services/v3/${endpoint}`;
        this.credentialProvider.assertRequestUrl(url);
        const params = await this.buildSignedParamsWithBrowser(data, permId);
        const body = new URLSearchParams(
            Object.entries(params).filter(([, value]) => value !== undefined && value !== null)
        ).toString();

        // 172 系统代理 Charles(8888)：禁用代理直连，避免证书与代理干扰
        const httpsAgent = new https.Agent({
            proxy: false,
            rejectUnauthorized: true
        });

        let response;
        try {
            response = await axios.post(url, body, {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'User-Agent': credentials.userAgent,
                    Accept: '*/*',
                    Referer: credentials.referer,
                    xweb_xhr: '1'
                },
                httpsAgent,
                httpAgent: undefined,
                proxy: false,
                timeout: this.timeout
            });
        } catch {
            const error = new Error('Kuaidian request failed');
            error.code = 'kuaidian_request_failed';
            throw error;
        }

        const permIdHeader = response.headers['x-perm-id'] || '';
        return {
            status: response.status,
            headers: response.headers,
            data: response.data,
            permId: permIdHeader
        };
    }

    /**
     * 按坐标采集场站，返回已映射为 StationModel 字段的场站数组。
     * @param {number} lat 纬度
     * @param {number} lng 经度
     * @param {object} options {pageIndex, pageSize, distance, chargeType, permId}
     */
    async collectByLocation(lat, lng, options = {}) {
        const pageIndex = Math.max(1, Math.floor(Number(options.pageIndex) || 1));
        const pageSize = Math.min(50, Math.max(1, Math.floor(Number(options.pageSize) || 10)));
        const distance = options.distance !== undefined ? options.distance : 20;
        const chargeType = options.chargeType !== undefined ? options.chargeType : 1;

        const endpoint = 'charge/app/stationList';
        const data = {
            pageIndex,
            distance,
            chargeType,
            pageSize,
            tagId: -1,
            latitude: lat,
            longitude: lng,
            userLatStr: String(lat),
            userLngStr: String(lng),
            stationCardParkingAbTest: '0'
        };

        const { data: body } = await this.postForm(endpoint, data, options.permId || '');

        if (!body || typeof body !== 'object') {
            throw new Error(`快电响应非 JSON: ${String(body).slice(0, 200)}`);
        }
        if (Number(body.code) !== 200) {
            const error = new Error(`快电接口返回失败: code=${body.code} message=${body.message || body.msg || ''}`);
            error.code = 'kuaidian_api_error';
            error.responseBody = body;
            throw error;
        }

        const result = body.result || {};
        const totalCount = Number(result.totalCount) || 0;
        const list = Array.isArray(result.chargeStationInfoList)
            ? result.chargeStationInfoList
            : (Array.isArray(result.stationInfoList) ? result.stationInfoList : []);

        const stations = list.map(item => this.mapStation(item)).filter(Boolean);

        return {
            platform: this.platform,
            endpoint,
            totalCount,
            collectedCount: stations.length,
            stations
        };
    }

    /**
     * 将快电原始场站对象映射为 StationModel.insert 所需字段。
     * 字段来源(已验证响应):
     *   stationName / price(快电price) / stationLat / stationLng / distance / directLeftCount(直流空闲)
     *   superLeftCount(超充空闲) / alternateLeftCount(交流慢充) / operatorName / stationCode
     */
    mapStation(item = {}) {
        if (!item || typeof item !== 'object') {
            return null;
        }

        const toInt = value => {
            const num = Number(value);
            return Number.isFinite(num) && num >= 0 ? Math.floor(num) : 0;
        };

        const stationName = item.stationName || item.name || null;
        const stationId = item.stationCode || item.code || item.stationId || null;
        const latitude = this.toNumber(item.stationLat ?? item.latitude ?? item.lat);
        const longitude = this.toNumber(item.stationLng ?? item.longitude ?? item.lng);

        // 价格：快电 price 字段(元/度)
        const priceFast = this.toNumber(item.price ?? item.chargeFee ?? item.totalFee);
        const priceSuper = this.toNumber(item.superPrice);
        const priceSlow = this.toNumber(item.slowPrice ?? item.alternatePrice);
        const priceService = this.toNumber(item.serviceFee ?? item.servicePrice);

        // 枪口空闲/总数
        const directLeftCount = item.directLeftCount !== undefined ? item.directLeftCount : item.fastIdleNum;
        const superLeftCount = item.superLeftCount !== undefined ? item.superLeftCount : item.superIdleNum;
        const alternateLeftCount = item.alternateLeftCount !== undefined ? item.alternateLeftCount : item.slowIdleNum;

        const directTotalCount = item.directTotalCount !== undefined ? item.directTotalCount : item.fastNum;
        const superTotalCount = item.superTotalCount !== undefined ? item.superTotalCount : item.superNum;
        const alternateTotalCount = item.alternateTotalCount !== undefined ? item.alternateTotalCount : item.slowNum;

        const fastIdlePorts = toInt(directLeftCount);
        const superIdlePorts = toInt(superLeftCount);
        const slowIdlePorts = toInt(alternateLeftCount);
        const fastTotalPorts = toInt(directTotalCount);
        const superTotalPorts = toInt(superTotalCount);
        const slowTotalPorts = toInt(alternateTotalCount);

        const availablePorts = fastIdlePorts + slowIdlePorts + superIdlePorts;
        const totalPorts = fastTotalPorts + slowTotalPorts + superTotalPorts;

        return {
            platform: this.platform,
            stationId: stationId ? String(stationId) : null,
            stationName,
            address: item.address || item.stationAddress || null,
            latitude,
            longitude,
            priceFast,
            priceSlow,
            priceSuper,
            priceService,
            fastIdlePorts,
            fastTotalPorts,
            slowIdlePorts,
            slowTotalPorts,
            superIdlePorts,
            superTotalPorts,
            onlineFastPorts: fastIdlePorts + superIdlePorts,
            onlineSlowPorts: slowIdlePorts,
            availablePorts,
            totalPorts,
            operator: item.operatorName || item.operator || null,
            sourceType: 'api-collector',
            sourceStage: 'kuaidian',
            raw: {
                ...item,
                source: 'api-collector',
                sourceStage: 'kuaidian',
                platform: this.platform
            }
        };
    }

    toNumber(value) {
        if (value === undefined || value === null || value === '') {
            return null;
        }
        const num = Number(value);
        return Number.isFinite(num) ? num : null;
    }
}

module.exports = KuaidianCollector;
