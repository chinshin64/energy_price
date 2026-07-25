'use strict';

const crypto = require('crypto');
const axios = require('axios');
const https = require('https');
const sm2 = require('sm-crypto').sm2;

/**
 * 星星充电 采集器
 *
 * 对标 kuaidian-collector / tuanyou-collector 的 class 风格：constructor + 签名 + collectByLocation + mapStation。
 *
 * 网关: https://gateway.sccncdn.com/apph5/xcxApiV2/wechat
 * 签名: 无密钥双重 MD5。h(t)=md5(md5(v(t))+String(t.timestamp)).toUpperCase()
 *   - v(t): "k=v&k=v&..." 按对象 key 顺序，非 URL 编码，末尾去 &
 *   - X(t): Object.keys().sort() 排序重建对象
 *   - J(t,e): 同 v 但 e=true 时 value 做 encodeURIComponent
 * 请求加密: SM2。x_encode(t)="04"+sm2.doEncrypt(t, 公钥, 0)  cipher mode 0=C1C2C3
 * SM2 公钥(硬编码): 04BF7E8F5399634458895E49D71CD042C32BA22773EC929DCD8E9228BDF877F0929AAE8B12B7FCDF25D2BF63517CD23AC2737A9C78958BB0849C767DE4FC1A29CA
 * openId: ozGb50AawtgjUsfr5T6lYLv41IT4 (从 HAR 的 /wechatApi/openId/get 提取，固定值可长期复用)
 *
 * 搜站接口: /stubGroup/list/query/noUser (POST, application/x-www-form-urlencoded)
 *   参数: stubGroupTypes:"0,1", page, pagecount, searchScene:2(仅page1), lat, lng,
 *        radius:10000, orderType:1, equipmentType:0, preferredStationSearch:true
 *   header: Content-Type/channel-id:"100"/X-Encrypted:"true"/X-Ca-Timestamp/X-Ca-Signature/x-uid:openId/appVersion:"8.8.0.2"
 *   body: data=encodeURIComponent("04"+sm2 密文)
 *   响应: 明文 JSON {code:"200",data:[{id,name,address,gisGcj02Lat,gisGcj02Lng,totalFeeInfo,...}]}
 *
 * 已验证脚本: ~/starcharge-solve.js (返回上海 10 个充电站，code=200)
 * 之前 E00001 错误根因是请求头 x-uid 没传 openId，传了即成功。
 */
class StarchargeCollector {
    constructor(options = {}) {
        this.browserSigner = options.browserSigner || null;
        this.host = options.host || 'https://gateway.sccncdn.com/apph5/xcxApiV2/wechat';
        this.appVersion = options.appVersion || '8.8.0.2';
        this.channelId = options.channelId || '100';
        // openId 从 HAR 的 /wechatApi/openId/get 提取，固定值可长期复用
        // 之前 E00001 错误根因是 x-uid 没传 openId，传了即成功
        this.openId = options.openId
            || process.env.STARCHARGE_OPEN_ID
            || 'ozGb50AawtgjUsfr5T6lYLv41IT4';
        // SM2 公钥(硬编码，从源码提取)
        this.sm2PublicKey = options.sm2PublicKey
            || '04BF7E8F5399634458895E49D71CD042C32BA22773EC929DCD8E9228BDF877F0929AAE8B12B7FCDF25D2BF63517CD23AC2737A9C78958BB0849C767DE4FC1A29CA';
        this.userAgent = options.userAgent
            || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Mac MacWechat/WMPF';
        this.timeout = options.timeout || 15000;
        // 平台标识与 config/settings.json 的 platform id 一致
        this.platform = 'star-charge';
        this.lastSignatureSource = 'manual';
    }

    // ============ 真实源码签名函数 (精确复刻 ~/starcharge-solve.js) ============
    // 源码 offset ~812988: h=function(t){var e=f.default.md5(v(t));return(e=f.default.md5("".concat(e).concat(t.timestamp))).toUpperCase()}
    // h(t)=md5(md5(v(t))+String(t.timestamp)).toUpperCase()
    staticSign(t) {
        const inner = crypto.createHash('md5').update(this.buildKV(t)).digest('hex');
        const outer = crypto.createHash('md5')
            .update(String(inner) + String(t.timestamp))
            .digest('hex');
        return outer.toUpperCase();
    }

    // 源码: v=function(t){var e="";for(var n in t)e+="".concat(n,"=").concat(t[n],"&");return e.slice(0,-1)}
    // "k=v&k=v&..." 按对象 key 顺序，非 URL 编码，末尾去 &
    buildKV(t) {
        let e = '';
        for (const n in t) {
            e += `${n}=${t[n]}&`;
        }
        return e.slice(0, -1);
    }

    // 源码: X=function(t){for(var e=Object.keys(t).sort(),n={},r=0;r<e.length;r++)n[e[r]]=t[e[r]];return n}
    // Object.keys().sort() 排序重建对象
    sortKeys(t) {
        const e = Object.keys(t).sort();
        const n = {};
        for (let r = 0; r < e.length; r++) {
            n[e[r]] = t[e[r]];
        }
        return n;
    }

    // 源码: J=function(t,e){var n="";for(var r in t)n+="".concat(r,"=").concat(e?encodeURIComponent(t[r]):t[r],"&");return n.substr(0,n.length-1)}
    // 同 buildKV 但 encode=true 时 value 做 encodeURIComponent
    buildKVEncoded(t, encode) {
        let n = '';
        for (const r in t) {
            n += `${r}=${encode ? encodeURIComponent(t[r]) : t[r]}&`;
        }
        return n.substr(0, n.length - 1);
    }

    // 源码: x.encode = function(t){return "04" + sm2.doEncrypt(t, PUBKEY, 0)}
    // cipher mode 0=C1C2C3
    sm2Encrypt(t) {
        return '04' + sm2.doEncrypt(t, this.sm2PublicKey, 0);
    }

    // 源码: p = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, ...)
    genNonce() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, t => {
            const e = (16 * Math.random()) | 0;
            return (t === 'x' ? e : (3 & e) | 8).toString(16);
        });
    }

    /**
     * 构造已签名+加密的请求体与请求头。
     * 复刻源码 stubGroupListQuery 调用处的包装逻辑：
     *   d = {...data, timestamp: f}; delete userId
     *   g = X({...d, nonce: p}); 过滤 null/undefined
     *   sig = h(g); cipher = x_encode(J(g, true)); body = "data="+encodeURIComponent(cipher)
     * @param {object} dataObj 业务参数
     * @param {boolean} noUser 是否走 noUser 路径(匿名搜站)
     * @returns {{url,body,headers,requestParams}}
     */
    buildSignedRequest(dataObj, noUser = true) {
        const ts = Date.now(); // f = new Date().getTime()
        const nonce = this.genNonce(); // p

        // d = {...e.data, timestamp: f}; delete userId if present & !transmitUserId
        const d = Object.assign({}, dataObj, { timestamp: ts });
        delete d.userId;

        // g = X({...d, nonce: p}) 排序; 过滤 null/undefined
        const g = this.sortKeys(Object.assign({}, d, { nonce }));
        for (const key in g) {
            if (g[key] === null || g[key] === undefined) {
                delete g[key];
            }
        }

        const sig = this.staticSign(g); // X-Ca-Signature
        const cipher = this.sm2Encrypt(this.buildKVEncoded(g, true));
        const body = 'data=' + encodeURIComponent(cipher);

        const apiPath = '/stubGroup/list/query';
        const fullPath = apiPath + (noUser ? '/noUser' : '');
        const url = this.host + fullPath;

        // headers 严格对齐 HAR entry6
        const headers = {
            'Content-Type': 'application/x-www-form-urlencoded',
            'channel-id': this.channelId,
            'Authorization': '',
            'X-Encrypted': 'true',
            'X-Ca-Timestamp': String(ts),
            'appVersion': this.appVersion,
            'X-Ca-Signature': sig,
            'x-uid': this.openId, // 关键: x-uid = openId
            'userId': '',
            'positCity': '',
            'User-Agent': this.userAgent
        };

        return { url, body, headers, requestParams: g };
    }

    async buildSignedRequestWithBrowser(dataObj, noUser = true) {
        const request = this.buildSignedRequest(dataObj, noUser);
        if (!this.browserSigner || typeof this.browserSigner.sign !== 'function') {
            this.lastSignatureSource = 'manual';
            return request;
        }
        try {
            const result = await this.browserSigner.sign('star-charge', {
                signatureParams: request.requestParams,
                plaintext: this.buildKVEncoded(request.requestParams, true),
                publicKey: this.sm2PublicKey,
                cipherMode: 0
            });
            if (
                typeof result?.signature !== 'string'
                || !/^[a-f\d]{32}$/i.test(result.signature)
                || typeof result?.encryptedData !== 'string'
                || !result.encryptedData.startsWith('04')
            ) {
                throw new Error('browser signer returned an invalid star-charge result');
            }
            request.headers['X-Ca-Signature'] = result.signature.toUpperCase();
            request.body = `data=${encodeURIComponent(result.encryptedData)}`;
            this.lastSignatureSource = 'browser';
        } catch {
            this.lastSignatureSource = 'manual-fallback';
        }
        return request;
    }

    async postForm(dataObj, noUser = true) {
        const { url, body, headers, requestParams } = await this.buildSignedRequestWithBrowser(dataObj, noUser);

        // 172 系统代理 Charles(8888)：禁用代理直连，避免证书与代理干扰
        const httpsAgent = new https.Agent({
            proxy: false,
            rejectUnauthorized: true
        });

        const response = await axios.post(url, body, {
            headers,
            httpsAgent,
            httpAgent: undefined,
            proxy: false,
            timeout: this.timeout
        });

        return {
            status: response.status,
            headers: response.headers,
            data: response.data,
            requestParams
        };
    }

    /**
     * 按坐标采集场站，返回已映射为 StationModel 字段的场站数组。
     * @param {number} lat 纬度(高德 gcj02)
     * @param {number} lng 经度(高德 gcj02)
     * @param {object} options {page, pagecount, radius}
     */
    async collectByLocation(lat, lng, options = {}) {
        const page = Math.max(1, Math.floor(Number(options.page) || 1));
        const pagecount = Math.min(50, Math.max(1, Math.floor(Number(options.pagecount) || 10)));
        const radius = options.radius !== undefined ? options.radius : 10000;

        // stubGroup/list/query 参数 (源码 stubGroupListQuery 调用处)
        // searchScene: page===1?2:null -> page1 时 =2
        const data = {
            stubGroupTypes: '0,1',
            page,
            pagecount,
            searchScene: page === 1 ? 2 : null,
            lat,
            lng,
            radius,
            orderType: 1,
            equipmentType: 0,
            preferredStationSearch: true
        };

        const { data: body } = await this.postForm(data, true);

        if (!body || typeof body !== 'object') {
            throw new Error(`星星充电响应非 JSON: ${String(body).slice(0, 200)}`);
        }
        if (String(body.code) !== '200') {
            const error = new Error(
                `星星充电接口返回失败: code=${body.code} message=${body.text || body.message || body.msg || ''}`
            );
            error.code = 'starcharge_api_error';
            error.responseBody = body;
            throw error;
        }

        const list = Array.isArray(body.data) ? body.data : [];

        const stations = list.map(item => this.mapStation(item)).filter(Boolean);

        return {
            platform: this.platform,
            endpoint: '/stubGroup/list/query/noUser',
            totalCount: list.length,
            collectedCount: stations.length,
            stations
        };
    }

    /**
     * 将星星充电原始场站对象映射为 StationModel.insert 所需字段。
     *
     * 字段来源(已验证响应):
     *   id->stationId / name->stationName / address->address
     *   gisGcj02Lat->latitude / gisGcj02Lng->longitude (高德 gcj02 坐标)
     *   totalFeeInfo: 价格时段数组字符串 [[endTime, eleAmount, serviceAmount, ...],...]
     *   acCnt/dcCnt/acIdleCnt/dcIdleCnt: 交流/直流 总数/空闲
     *   stubGroupType/chargeMode/equipmentUpKw/equipmentOperatorId: 元数据
     */
    mapStation(item = {}) {
        if (!item || typeof item !== 'object') {
            return null;
        }

        const toInt = value => {
            const num = Number(value);
            return Number.isFinite(num) && num >= 0 ? Math.floor(num) : 0;
        };

        const stationId = item.id || item.stubGroupId || null;
        const stationName = item.name || item.stubGroupName || null;

        // totalFeeInfo: 价格时段数组，提取当前时段电价
        // 格式: [[endTime, eleAmount, serviceAmount, ...], ...]
        // 时段按 endTime 升序，23:59=2359 为兜底；当前时间落在 <=endTime 的第一个时段
        const { priceFast, priceService, currentFeeInfo } = this.parseTotalFeeInfo(item.totalFeeInfo);

        // 偏好 extraInfo.actualFee 作为回退(更精确的当前价)
        const actualFee = this.extractActualFee(item);
        const resolvedPriceFast = priceFast ?? actualFee.eleAmount ?? null;
        const resolvedPriceService = priceService ?? actualFee.serviceAmount ?? null;

        // 枪口: 直流(dc)对应快充，交流(ac)对应慢充
        const fastIdlePorts = toInt(item.dcIdleCnt);
        const slowIdlePorts = toInt(item.acIdleCnt);
        const fastTotalPorts = toInt(item.dcCnt);
        const slowTotalPorts = toInt(item.acCnt);
        const superIdlePorts = 0;
        const superTotalPorts = 0;

        const availablePorts = fastIdlePorts + slowIdlePorts + superIdlePorts;
        const totalPorts = fastTotalPorts + slowTotalPorts + superTotalPorts;

        // chargeMode: 0=超充, 1=交流慢充, 2=交直流
        const chargeMode = item.chargeMode;

        return {
            platform: this.platform,
            stationId: stationId ? String(stationId) : null,
            stationName,
            address: item.address || null,
            latitude: this.toNumber(item.gisGcj02Lat ?? item.lat),
            longitude: this.toNumber(item.gisGcj02Lng ?? item.lng),
            priceFast: resolvedPriceFast,
            priceSlow: chargeMode === 1 ? resolvedPriceFast : null,
            priceSuper: chargeMode === 0 ? resolvedPriceFast : null,
            priceService: resolvedPriceService,
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
            operator: item.equipmentOperatorId || item.cspId || null,
            sourceType: 'api-collector',
            sourceStage: 'star-charge',
            raw: {
                ...item,
                source: 'api-collector',
                sourceStage: 'star-charge',
                platform: this.platform,
                currentFeeInfo,
                actualFee,
                chargeMode,
                equipmentUpKw: item.equipmentUpKw
            }
        };
    }

    /**
     * 解析 totalFeeInfo 提取当前时段电价。
     * totalFeeInfo 为字符串化的数组: "[[endTime, eleAmount, serviceAmount, ...],...]"
     * 时段按 endTime 升序，当前时间(HHMM)落在 <=endTime 的第一个时段；
     * 若都大于当前时间取第一个，若都小于取最后一个(2359 兜底)。
     * @returns {{priceFast, priceService, currentFeeInfo}}
     */
    parseTotalFeeInfo(totalFeeInfo) {
        const empty = { priceFast: null, priceService: null, currentFeeInfo: null };
        if (!totalFeeInfo) {
            return empty;
        }
        let segments;
        try {
            // totalFeeInfo 是字符串化的数组，需要解析
            const text = typeof totalFeeInfo === 'string' ? totalFeeInfo : JSON.stringify(totalFeeInfo);
            segments = JSON.parse(text);
        } catch (error) {
            return empty;
        }
        if (!Array.isArray(segments) || segments.length === 0) {
            return empty;
        }

        // 当前时间 HHMM
        const now = new Date();
        const currentHHMM = now.getHours() * 100 + now.getMinutes();

        // 找当前时段: 第一个 endTime >= currentHHMM；若都小于则取最后一个
        let current = null;
        for (const seg of segments) {
            if (!Array.isArray(seg) || seg.length < 3) {
                continue;
            }
            const endTime = Number(seg[0]);
            const eleAmount = Number(seg[1]);
            const serviceAmount = Number(seg[2]);
            if (!Number.isFinite(endTime) || !Number.isFinite(eleAmount) || !Number.isFinite(serviceAmount)) {
                continue;
            }
            if (current === null) {
                current = { endTime, eleAmount, serviceAmount };
            }
            if (endTime >= currentHHMM) {
                current = { endTime, eleAmount, serviceAmount };
                break;
            }
        }

        if (!current) {
            return empty;
        }
        return {
            priceFast: current.eleAmount,
            priceService: current.serviceAmount,
            currentFeeInfo: current
        };
    }

    /**
     * 从 extraInfo.stubGroupFeeInfo.actualFee 提取当前实际费用(回退值)。
     */
    extractActualFee(item = {}) {
        const feeInfo = item.extraInfo && item.extraInfo.stubGroupFeeInfo;
        const actual = feeInfo && feeInfo.actualFee;
        if (!actual) {
            return { eleAmount: null, serviceAmount: null, totalFee: null };
        }
        return {
            eleAmount: this.toNumber(actual.eleAmount),
            serviceAmount: this.toNumber(actual.serviceAmount),
            totalFee: this.toNumber(actual.totalFee)
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

module.exports = StarchargeCollector;
