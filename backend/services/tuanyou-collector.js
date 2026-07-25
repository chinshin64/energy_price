'use strict';

const crypto = require('crypto');
const axios = require('axios');
const https = require('https');
const { TuanyouCredentialProvider } = require('./tuanyou-credential-provider');

/**
 * 团油(车主邦) 采集器
 *
 * 对标 kuaidian-collector 的 class 风格：constructor + sign + collectByLocation + mapStation。
 * 团油与快电签名机制同构：MD5(appSecret + sorted(key+value) + appSecret).toLowerCase()
 *
 * 签名: MD5(appSecret + sorted(key+value) + appSecret).toLowerCase()
 * 匿名(token="")，响应明文 JSON {code,message,result:{totalCount,gasInfoList}}
 *
 * 搜站接口: gas/mapGasInfoListPage/4.0 (POST, application/x-www-form-urlencoded)
 *   参数 userLatStr/userLngStr/oilNo/sort/distance/brandTypes/pageIndex/pageSize/
 *        channelId:2/cityCode/isRecommend:0/czbTrace/platformType/scTestID:3/needTop:1/listType:0
 *
 * 公共参数: app_key/timestamp(毫秒)/token/shumeiID/fromScanCode/mp_version/sign
 */
class TuanyouCollector {
    constructor(options = {}) {
        this.browserSigner = options.browserSigner || null;
        this.credentialProvider = options.credentialProvider instanceof TuanyouCredentialProvider
            ? options.credentialProvider
            : new TuanyouCredentialProvider(options.credentials || options);
        this.timeout = options.timeout || 15000;
        // 平台标识与 config/settings.json 的 platform id 一致
        this.platform = 'tuanyou';
        this.lastSignatureSource = 'manual';
    }

    /**
     * 计算签名：MD5(appSecret + sorted(key+value) + appSecret).toLowerCase()
     * 复刻 utils/sign.js 的 generate 逻辑：
     *   - 按 key 字典序升序拼接 key+value
     *   - MD5(appSecret + serialized + appSecret).toLowerCase()
     * 与快电 sign() 完全同构。
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
     * 注入公共参数并签名，复刻 utils/ajax.js 的 w() 包装器：
     *   token(匿名空) / shumeiID / fromScanCode / mp_version / app_key / timestamp / sign
     */
    buildSignedParams(data = {}) {
        const credentials = this.credentialProvider.requireCredentials();
        const params = { ...data };
        params.token = credentials.token;
        params.shumeiID = credentials.shumeiID;
        params.fromScanCode = credentials.fromScanCode;
        params.mp_version = credentials.mpVersion;

        // 公共参数
        params.app_key = credentials.appKey;
        params.timestamp = String(Date.now());

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

    async buildSignedParamsWithBrowser(data = {}) {
        const params = this.buildSignedParams(data);
        if (!this.browserSigner || typeof this.browserSigner.sign !== 'function') {
            this.lastSignatureSource = 'manual';
            return params;
        }
        try {
            const browserInput = { ...params };
            delete browserInput.sign;
            const result = await this.browserSigner.sign('tuanyou', browserInput);
            const signature = typeof result === 'string' ? result : result?.sign;
            if (typeof signature !== 'string' || !/^[a-f\d]{32}$/i.test(signature)) {
                throw new Error('browser signer returned an invalid tuanyou signature');
            }
            params.sign = signature.toLowerCase();
            this.lastSignatureSource = 'browser';
        } catch {
            this.lastSignatureSource = 'manual-fallback';
        }
        return params;
    }

    async postForm(endpoint, data = {}) {
        const credentials = this.credentialProvider.requireCredentials();
        const url = `${credentials.host}/services/v3/${endpoint}`;
        this.credentialProvider.assertRequestUrl(url);
        const params = await this.buildSignedParamsWithBrowser(data);
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
            const error = new Error('Tuanyou request failed');
            error.code = 'tuanyou_request_failed';
            throw error;
        }

        return {
            status: response.status,
            headers: response.headers,
            data: response.data
        };
    }

    /**
     * 按坐标采集场站，返回已映射为 StationModel 字段的场站数组。
     * @param {number} lat 纬度
     * @param {number} lng 经度
     * @param {object} options {oilNo='92', pageIndex, pageSize, distance, cityCode}
     */
    async collectByLocation(lat, lng, options = {}) {
        const pageIndex = Math.max(1, Math.floor(Number(options.pageIndex) || 1));
        const pageSize = Math.min(50, Math.max(1, Math.floor(Number(options.pageSize) || 10)));
        const distance = options.distance !== undefined ? options.distance : 20;
        const oilNo = options.oilNo !== undefined ? String(options.oilNo) : '92';
        const cityCode = options.cityCode !== undefined ? options.cityCode : '';

        const endpoint = 'gas/mapGasInfoListPage/4.0';
        const data = {
            userLatStr: String(lat),
            userLngStr: String(lng),
            oilNo,
            sort: 0,
            distance,
            brandTypes: '',
            pageIndex,
            pageSize,
            channelId: 2,
            cityCode,
            isRecommend: 0,
            czbTrace: '',
            platformType: '',
            scTestID: 3,
            needTop: 1,
            listType: 0
        };

        const { data: body } = await this.postForm(endpoint, data);

        if (!body || typeof body !== 'object') {
            throw new Error(`团油响应非 JSON: ${String(body).slice(0, 200)}`);
        }
        if (Number(body.code) !== 200) {
            const error = new Error(`团油接口返回失败: code=${body.code} message=${body.message || body.msg || ''}`);
            error.code = 'tuanyou_api_error';
            error.responseBody = body;
            throw error;
        }

        const result = body.result || {};
        const totalCount = Number(result.totalCount) || 0;
        const list = Array.isArray(result.gasInfoList) ? result.gasInfoList : [];

        const stations = list.map(item => this.mapStation(item, oilNo)).filter(Boolean);

        return {
            platform: this.platform,
            endpoint,
            oilNo,
            totalCount,
            collectedCount: stations.length,
            stations
        };
    }

    /**
     * 将团油原始场站对象映射为 StationModel.insert 所需字段。
     * 团油是加油平台，主要字段为油价(fuel92Price 等)与油站信息。
     *
     * 字段来源(已验证响应):
     *   gasName / gasAddress / gasAddressLongitude / gasAddressLatitude / distance
     *   oilNo(油号) / price1(国标价/枪价) / price2(团油优惠价) / gunPrice / price2BigDecimal
     *   gasId(可能为 null) / channelGasId / provinceCode
     */
    mapStation(item = {}, requestOilNo = '92') {
        if (!item || typeof item !== 'object') {
            return null;
        }

        const oilNo = String(item.oilNo ?? requestOilNo);
        const priceOfficial = this.toNumber(item.price1 ?? item.gunPrice); // 国标价/枪价
        const pricePromo = this.toNumber(item.price2 ?? item.price2BigDecimal); // 团油优惠价

        // 按 oilNo 将油价填入对应字段
        const fuelPrices = {
            fuel92Price: null,
            fuel95Price: null,
            fuel98Price: null,
            fuelDieselPrice: null
        };
        const oilKey = this.oilNoToKey(oilNo);
        if (oilKey && pricePromo !== null) {
            fuelPrices[oilKey] = pricePromo;
        }

        const stationName = item.gasName || item.name || null;
        // gasId 可能为 null，回退到 channelGasId；都没有则用 gasName 前缀
        const stationId = item.gasId || item.channelGasId
            || (stationName ? String(stationName).split('_')[0] : null);

        return {
            platform: this.platform,
            stationId: stationId ? String(stationId) : null,
            stationName,
            address: item.gasAddress || item.gasShortAddress || item.address || null,
            latitude: this.toNumber(item.gasAddressLatitude ?? item.latitude),
            longitude: this.toNumber(item.gasAddressLongitude ?? item.longitude),
            // 团油是加油平台：油价字段
            fuel92Price: fuelPrices.fuel92Price,
            fuel95Price: fuelPrices.fuel95Price,
            fuel98Price: fuelPrices.fuel98Price,
            fuelDieselPrice: fuelPrices.fuelDieselPrice,
            // 国标价/优惠价存入 service 字段以兼容统一视图(可选)
            priceService: priceOfficial,
            operator: this.extractOperator(item),
            // 加油平台无充电枪口概念，端口数置 0
            availablePorts: 0,
            totalPorts: 0,
            onlineFastPorts: 0,
            onlineSlowPorts: 0,
            fastIdlePorts: 0,
            fastTotalPorts: 0,
            slowIdlePorts: 0,
            slowTotalPorts: 0,
            superIdlePorts: 0,
            superTotalPorts: 0,
            sourceType: 'api-collector',
            sourceStage: 'tuanyou',
            raw: {
                ...item,
                source: 'api-collector',
                sourceStage: 'tuanyou',
                platform: this.platform,
                oilNo,
                priceOfficial,
                pricePromo
            }
        };
    }

    /**
     * 将油号映射到 StationModel 的油价字段名。
     * 92# -> fuel92Price, 95# -> fuel95Price, 98# -> fuel98Price, 0#/柴油 -> fuelDieselPrice
     */
    oilNoToKey(oilNo) {
        const text = String(oilNo || '').replace(/[#＃]/g, '').trim();
        if (/^92/.test(text)) return 'fuel92Price';
        if (/^95/.test(text)) return 'fuel95Price';
        if (/^98/.test(text)) return 'fuel98Price';
        if (/^(0|diesel|柴油)/i.test(text)) return 'fuelDieselPrice';
        return null;
    }

    /**
     * 从场站信息提取运营商名。团油 gasName 常以"品牌_站名"格式呈现，
     * 下划线前的部分通常为品牌/运营商。
     */
    extractOperator(item = {}) {
        const gasName = String(item.gasName || '').trim();
        if (gasName && gasName.includes('_')) {
            const prefix = gasName.split('_')[0].trim();
            // 前缀为编号(如 AJ423578934)时不算运营商
            if (prefix && !/^[A-Z]{1,3}\d+$/.test(prefix)) {
                return prefix;
            }
        }
        return null;
    }

    toNumber(value) {
        if (value === undefined || value === null || value === '') {
            return null;
        }
        const num = Number(value);
        return Number.isFinite(num) ? num : null;
    }

    assertConfigured() {
        this.credentialProvider.requireCredentials();
        return true;
    }
}

module.exports = TuanyouCollector;
