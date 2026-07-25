'use strict';

const axios = require('axios');
const https = require('https');
const CryptoJS = require('crypto-js');

/**
 * 新电途(xdt / xdtev) 充电站采集器
 *
 * 对标 kuaidian-collector / starcharge-collector / ykc-collector 的 class 风格：
 *   constructor + 签名/加密 + collectByLocation + mapStation。
 *
 * 加密机制(反编译确证，已实测验证):
 *   1. 密钥派生(initNonceStr, 模块11579):
 *        T = pw (来自 /public/openapi/v0.1/user 响应)
 *        A(e) = e.split("").sort().join("")   // 字符串字符排序
 *        aesKey = A(T.substring(8,16)) + A(T.substring(0,8)) + "+9eqnp=="
 *   2. AES(模块76336): key = CryptoJS.enc.Base64.parse(aesKey)  ← 关键! Base64解析,非Utf8
 *        aesEncrypt(data,key) = AES.encrypt(JSON.stringify(data), key, {ECB, Pkcs7}).toString()
 *        aesDecrypt(data,key) = AES.decrypt(data.replace(/\s/g,''), key, {ECB, Pkcs7}).toString(Utf8)
 *   3. 签名 formatSignCommon(模块, be函数):
 *        sign = 随机字符串(诱饵)
 *        nonceStr = MD5( sortedKeys.reduce(k=v&) )   ← 真签名在 nonceStr 字段
 *        tm = +new Date
 *
 * 密钥来源: POST /public/openapi/v0.1/user 响应 {dk,pw,userId,userName}
 *   (Authorization 空, 匿名密钥交换; userName = usersessionname)
 *
 * 搜站: GET /asset/openapi/v0.4/charge-station-list?encryptData=<AES加密的业务参数>
 *   请求头: sign/tm/nonceStr/usersessionname/channel:22/Authorization:Bearer
 *   响应: {code:"10000",data:<AES加密>} → 解密出充电站数组
 *
 * 已验证: 解密 xdt.har [9] 响应得 10 个充电站(和平门全聚德等)
 */
const AES_KEY_SUFFIX = '+9eqnp==';
const DEFAULT_BASE_URL = 'https://app.xdtev.com';
const DEFAULT_CHANNEL = '22';
const DEFAULT_VERSION = '3.30260703.2';
const DEFAULT_REFERER = 'https://servicewechat.com/wx17ab5a15e61efc32/371/page-frame.html';

class XdtCollector {
    constructor(options = {}) {
        this.browserSigner = options.browserSigner || null;
        this.host = options.host || DEFAULT_BASE_URL;
        this.channel = options.channel || DEFAULT_CHANNEL;
        this.version = options.version || DEFAULT_VERSION;
        this.referer = options.referer || DEFAULT_REFERER;
        // 凭证来自 /public/openapi/v0.1/user 响应(匿名密钥交换)
        this.pw = options.pw || process.env.XDT_PW || '';
        this.dk = options.dk || process.env.XDT_DK || '';
        this.userId = options.userId || process.env.XDT_USER_ID || '';
        this.userName = options.userName || process.env.XDT_USER_NAME || '';
        this.userAgent = options.userAgent
            || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) NetType/WIFI MiniProgramEnv/Mac MacWechat/WMPF';
        this.timeout = options.timeout || 15000;
        // 平台标识与 config/settings.json 的 platform id 一致
        this.platform = 'xdt';
        this.lastSignatureSource = 'manual';
    }

    // ============ 密钥派生 (反编译模块11579) ============
    // A(e) = e.split("").sort().join("")
    static sortChars(str) {
        return String(str || '').split('').sort().join('');
    }

    // aesKey = sort(pw[8:16]) + sort(pw[0:8]) + "+9eqnp=="  (24字符)
    // 关键: CryptoJS.enc.Base64.parse(aesKey) → 16字节 = AES-128 key
    deriveAesKey(pw) {
        const t = pw || this.pw;
        return XdtCollector.sortChars(t.substring(8, 16))
            + XdtCollector.sortChars(t.substring(0, 8))
            + AES_KEY_SUFFIX;
    }

    makeKey(pw) {
        const aesKeyStr = this.deriveAesKey(pw);
        return CryptoJS.enc.Base64.parse(aesKeyStr); // 16 bytes = AES-128
    }

    // ============ AES 加解密 (关键: Base64.parse key, 非 Utf8) ============
    aesEncrypt(data, keyWA) {
        const plain = typeof data === 'string' ? data : JSON.stringify(data);
        return CryptoJS.AES.encrypt(plain, keyWA, {
            mode: CryptoJS.mode.ECB,
            padding: CryptoJS.pad.Pkcs7
        }).toString();
    }

    aesDecrypt(ciphertext, keyWA) {
        const clean = String(ciphertext || '').replace(/[\r\n\s]/g, '');
        const out = CryptoJS.AES.decrypt(clean, keyWA, {
            mode: CryptoJS.mode.ECB,
            padding: CryptoJS.pad.Pkcs7
        }).toString(CryptoJS.enc.Utf8);
        return JSON.parse(out);
    }

    // ============ 签名 formatSignCommon (反编译 be 函数) ============
    randomString(len) {
        const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
        let s = '';
        for (let i = 0; i < len; i++) {
            s += chars[Math.floor(Math.random() * chars.length)];
        }
        return s;
    }

    // sign = 随机诱饵; nonceStr = MD5(sorted k=v& 串); tm = 时间戳
    // o = {...data, sign, nonceStr: initNonceStr, tm}
    formatSignCommon(data, initNonceStr) {
        const sign = this.randomString(32); // 诱饵
        const tm = Date.now();
        const o = Object.assign({}, data, { sign, nonceStr: initNonceStr, tm });
        const signStr = Object.keys(o).sort().reduce((acc, k) => acc + k + '=' + o[k] + '&', '');
        const nonceStrMd5 = CryptoJS.MD5(signStr).toString();
        return { sign, tm: String(tm), nonceStr: nonceStrMd5 };
    }

    async resolveFormatSignCommon(data, initNonceStr) {
        if (!this.browserSigner || typeof this.browserSigner.sign !== 'function') {
            this.lastSignatureSource = 'manual';
            return this.formatSignCommon(data, initNonceStr);
        }
        try {
            const result = await this.browserSigner.sign('xdt', {
                data: { ...data },
                initNonceStr: String(initNonceStr || '')
            });
            const normalizedResult = result && typeof result === 'object'
                ? {
                    sign: String(result.sign || ''),
                    tm: String(result.tm || ''),
                    nonceStr: String(result.nonceStr || '')
                }
                : null;
            if (
                !normalizedResult?.sign
                || !/^\d{13}$/.test(normalizedResult.tm)
                || !/^[a-f\d]{32}$/i.test(normalizedResult.nonceStr)
            ) {
                throw new Error('browser signer returned an invalid xdt result');
            }
            this.lastSignatureSource = 'browser';
            return normalizedResult;
        } catch {
            this.lastSignatureSource = 'manual-fallback';
            return this.formatSignCommon(data, initNonceStr);
        }
    }

    // initNonceStr(模块 SET_USER_SESSIONNAME): userId 派生
    // s.substring(2,3) + s.substring(17,34) + s.substring(50)
    deriveInitNonceStr(userId) {
        const s = userId || this.userId;
        return s.substring(2, 3) + s.substring(17, 34) + s.substring(50);
    }

    // ============ HTTP 请求 ============
    async httpsGet(url, headers) {
        // 172 系统代理 Charles(8888)：禁用代理直连，避免证书与代理干扰
        const httpsAgent = new https.Agent({
            proxy: false,
            rejectUnauthorized: true
        });

        const response = await axios.get(url, {
            headers,
            httpsAgent,
            httpAgent: undefined,
            proxy: false,
            timeout: this.timeout,
            transformResponse: [incomingData => incomingData] // 响应密文，避免 axios 预解析
        });

        return {
            status: response.status,
            headers: response.headers,
            body: response.data
        };
    }

    /**
     * 按坐标采集场站，返回已映射为 StationModel 字段的场站数组。
     * @param {number} lat 纬度(高德 gcj02)
     * @param {number} lng 经度(高德 gcj02)
     * @param {object} options {page=1, pageSize=10, sortRule='01', radius=10000}
     */
    async collectByLocation(lat, lng, options = {}) {
        const page = Math.max(1, Math.floor(Number(options.page) || 1));
        const pageSize = Math.min(50, Math.max(1, Math.floor(Number(options.pageSize) || 10)));
        const sortRule = options.sortRule !== undefined ? String(options.sortRule) : '01';
        const radius = options.radius !== undefined ? Number(options.radius) : 10000;

        const keyWA = this.makeKey();
        const initNonceStr = this.deriveInitNonceStr();

        // 业务参数(与 xdt.har [9] 解密后的 encryptData 一致)
        const bizData = {
            supportSuperPrice: '1',
            lon: lng,
            lat: lat,
            pageIndex: page,
            pageSize: pageSize,
            sortRule: sortRule,
            radius: radius
        };

        // 加密业务参数 → encryptData
        const encryptData = this.aesEncrypt(bizData, keyWA);

        // 签名(sign 是诱饵, nonceStr 是真 MD5 签名)
        const signHeaders = await this.resolveFormatSignCommon({ encryptData }, initNonceStr);

        const query = 'encryptData=' + encodeURIComponent(encryptData);
        const url = this.host + '/asset/openapi/v0.4/charge-station-list?' + query;

        const headers = {
            Host: 'app.xdtev.com',
            Connection: 'keep-alive',
            Authorization: 'Bearer ',
            sign: signHeaders.sign,
            'xweb_xhr': '1',
            tm: signHeaders.tm,
            usersessionname: this.userName,
            'User-Agent': this.userAgent,
            channel: this.channel,
            'Content-Type': 'application/json;charset=UTF-8',
            nonceStr: signHeaders.nonceStr,
            version: this.version,
            Accept: '*/*',
            'Sec-Fetch-Site': 'cross-site',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Dest': 'empty',
            Referer: this.referer,
            'Accept-Encoding': 'gzip, deflate, br',
            'Accept-Language': 'zh-CN,zh;q=0.9'
        };

        const res = await this.httpsGet(url, headers);

        let parsed;
        try {
            parsed = JSON.parse(res.body);
        } catch (error) {
            throw new Error(`新电途响应 JSON 解析失败: ${error.message} body=${String(res.body).slice(0, 200)}`);
        }

        if (String(parsed.code) !== '10000') {
            const err = new Error(
                `新电途接口返回失败: code=${parsed.code} ret=${parsed.ret} msg=${parsed.msg || ''}`
            );
            err.code = 'xdt_api_error';
            err.responseBody = parsed;
            throw err;
        }

        if (!parsed.data) {
            return {
                platform: this.platform,
                endpoint: '/asset/openapi/v0.4/charge-station-list',
                totalCount: 0,
                collectedCount: 0,
                stations: []
            };
        }

        const list = this.aesDecrypt(parsed.data, keyWA);
        const stationList = Array.isArray(list) ? list : [];

        const stations = stationList.map(item => this.mapStation(item)).filter(Boolean);

        return {
            platform: this.platform,
            endpoint: '/asset/openapi/v0.4/charge-station-list',
            totalCount: stationList.length,
            collectedCount: stations.length,
            stations
        };
    }

    /**
     * 将新电途原始场站对象映射为 StationModel.insert 所需字段。
     *
     * 字段来源(已验证 xdt.har [9] 响应):
     *   stationId -> stationId / stationName -> stationName
     *   stationAddr -> address / cityName -> (raw)
     *   lat/lon -> latitude/longitude (高德 gcj02)
     *   acPileNum/acPileFreeNum -> 交流慢充(slow) 总数/空闲
     *   dcPileNum/dcPileFreeNum -> 直流快充(fast) 总数/空闲
     *   superPileNum/superPileFreeNum -> 超充(super) 总数/空闲
     *   freeNums -> 总空闲 / openGunNum -> 总数
     *   chargePrice -> "电费:HH:MM~HH:MM,price;..." 当前时段电价
     *   servicePrice -> "服务费:HH:MM~HH:MM,price;..." 当前时段服务费
     *   operName/operId -> 运营商
     */
    mapStation(item = {}) {
        if (!item || typeof item !== 'object') {
            return null;
        }

        const toInt = value => {
            const num = Number(value);
            return Number.isFinite(num) && num >= 0 ? Math.floor(num) : 0;
        };

        const stationId = item.stationId || null;
        const stationName = item.stationName || null;

        // 枪口: 直流(dc)对应快充, 交流(ac)对应慢充, super 对应超充
        const fastIdlePorts = toInt(item.dcPileFreeNum);
        const fastTotalPorts = toInt(item.dcPileNum);
        const slowIdlePorts = toInt(item.acPileFreeNum);
        const slowTotalPorts = toInt(item.acPileNum);
        const superIdlePorts = toInt(item.superPileFreeNum);
        const superTotalPorts = toInt(item.superPileNum);

        const availablePorts = toInt(item.freeNums) || (fastIdlePorts + slowIdlePorts + superIdlePorts);
        const totalPorts = toInt(item.openGunNum) || (fastTotalPorts + slowTotalPorts + superTotalPorts);

        // 价格: 解析 chargePrice/servicePrice 的当前时段
        const { priceFast, priceService, currentFeeInfo } = this.parsePriceString(item.chargePrice, item.servicePrice);

        return {
            platform: this.platform,
            stationId: stationId ? String(stationId) : null,
            stationName,
            address: item.stationAddr || null,
            latitude: this.toNumber(item.lat),
            longitude: this.toNumber(item.lon),
            priceFast,
            priceSlow: slowTotalPorts > 0 ? priceFast : null,
            priceSuper: superTotalPorts > 0 ? priceFast : null,
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
            operator: item.operName || item.operId || null,
            sourceType: 'api-collector',
            sourceStage: 'xdt',
            raw: {
                ...item,
                source: 'api-collector',
                sourceStage: 'xdt',
                platform: this.platform,
                currentFeeInfo
            }
        };
    }

    /**
     * 解析 chargePrice/servicePrice 字符串提取当前时段电价与服务费。
     * 格式: "电费:00:00~24:00,1.5" 或 "电费:00:00~07:00,0.5467;07:00~10:00,0.8312;..."
     * 时段按 endTime 升序，当前时间(HHMM)落在 <=endTime 的第一个时段；
     * 24:00 为兜底；若都大于当前时间取第一个。
     * @returns {{priceFast, priceService, currentFeeInfo}}
     */
    parsePriceString(chargePriceStr, servicePriceStr) {
        const empty = { priceFast: null, priceService: null, currentFeeInfo: null };
        const charge = this.parseTimeSlots(chargePriceStr);
        const service = this.parseTimeSlots(servicePriceStr);

        return {
            priceFast: charge.price,
            priceService: service.price,
            currentFeeInfo: {
                charge: charge.current,
                service: service.current
            }
        };
    }

    parseTimeSlots(text) {
        const empty = { price: null, current: null };
        const raw = String(text || '').trim();
        if (!raw) {
            return empty;
        }
        // 去掉前缀 "电费:" / "服务费:"
        const body = raw.replace(/^[^:]+:/, '');
        const segments = body.split(';').filter(Boolean);
        if (segments.length === 0) {
            return empty;
        }

        const now = new Date();
        const currentHHMM = now.getHours() * 100 + now.getMinutes();

        let current = null;
        for (const seg of segments) {
            // seg: "00:00~07:00,0.5467"
            const match = seg.match(/^(\d{1,2}):(\d{2})~(\d{1,2}):(\d{2}),([\d.]+)/);
            if (!match) {
                continue;
            }
            const startHH = Number(match[1]);
            const startMM = Number(match[2]);
            const endHH = Number(match[3]);
            const endMM = Number(match[4]);
            const price = Number(match[5]);
            if (!Number.isFinite(price)) {
                continue;
            }
            const startTime = startHH * 100 + startMM;
            const endTime = endHH * 100 + endMM;
            const slot = { startTime, endTime, price, raw: seg };
            if (current === null) {
                current = slot;
            }
            // 当前时间落在 [start, end] 内，或 <= endTime 的第一个时段
            if (currentHHMM >= startTime && currentHHMM <= endTime) {
                current = slot;
                break;
            }
            if (currentHHMM < startTime && current === null) {
                current = slot;
            }
        }

        if (!current) {
            // 兜底取最后一个(通常是 24:00 时段)
            const last = segments[segments.length - 1];
            const match = last.match(/,([\d.]+)$/);
            if (match) {
                return { price: Number(match[1]), current: { price: Number(match[1]), raw: last } };
            }
            return empty;
        }
        return { price: current.price, current };
    }

    toNumber(value) {
        if (value === undefined || value === null || value === '') {
            return null;
        }
        const num = Number(value);
        return Number.isFinite(num) ? num : null;
    }
}

module.exports = XdtCollector;
