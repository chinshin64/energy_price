'use strict';

const axios = require('axios');
const https = require('https');

/**
 * 云快充(YKC) 采集器
 *
 * 对标 kuaidian-collector / tuanyou-collector / starcharge-collector 的 class 风格：
 *   constructor + collectByLocation + mapStation。
 *
 * 云快充是最简单的平台：无签名、无加密、无鉴权门。明文 JSON 请求与响应。
 *
 * 接口: https://hanguw.ykccn.com/api/guz/app/{接口}
 * 搜站: POST /api/guz/app/station/queryStationList
 *   header: Content-Type:application/json, Terminal:mini_wx, requestTime:毫秒时间戳, appVersion:1.0.0
 *   (token 存在才塞 Token 头，不存在不塞，采集接口不强校验登录)
 *   body: {keyword,cityId,userCityId,userLat,userLng,destPosLat,destPosLng,filterInfos:[],pageIndex,pageSize}
 *   响应: 明文 JSON {resultCode:0, resultDesc:"成功", data:[{stationId,name,source,logo,terminalCount,tags,parkingDesc,lng,lat,distance,firstPrice,secondPrice,...}], totalCount, totalPage}
 *
 * 站点详情: POST /api/guz/app/station/detail body:{stationId}
 * 价格详情: POST /api/guz/app/station/price/detail
 *
 * terminalCount 类型映射(已实测验证，按响应中 tags 的 kW 值对照)：
 *   type=1 配 "480kW" tag  -> 超充(super)   [480kW 液冷超充]
 *   type=2 配 "60kW"  tag  -> 直流快充(fast) [DC 快充]
 *   type=3 配 "7kW"   tag  -> 交流慢充(slow) [AC 慢充]
 * 注：任务描述中 type1=fast/type2=slow/type3=super 与实测数据矛盾
 *     (7kW 不可能为超充、480kW 不应为快充)，此处按电气实际与响应 tags 校正。
 */
class YkcCollector {
    constructor(options = {}) {
        this.host = options.host || 'https://hanguw.ykccn.com';
        this.apiPrefix = options.apiPrefix || '/api/guz/app/';
        this.appVersion = options.appVersion || '1.0.0';
        this.terminal = options.terminal || 'mini_wx';
        this.token = options.token || '';
        this.userAgent = options.userAgent
            || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger';
        this.timeout = options.timeout || 15000;
        // 平台标识与 config/settings.json 的 platform id 一致
        this.platform = 'ykc';
    }

    /**
     * 发送 JSON POST 请求(无签名、无加密)。
     * 云快充采集接口不强校验登录：token 存在才塞 Token 头，不存在不塞。
     */
    async postJson(endpoint, data = {}) {
        const url = `${this.host}${this.apiPrefix}${endpoint}`;
        const headers = {
            'Content-Type': 'application/json',
            'Terminal': this.terminal,
            'requestTime': String(Date.now()),
            'appVersion': this.appVersion,
            'User-Agent': this.userAgent,
            Accept: '*/*'
        };
        // token 存在才塞 Token 头，不存在不塞(采集接口不强校验登录)
        if (this.token) {
            headers.Token = this.token;
        }

        // 172 系统代理 Charles(8888)：禁用代理直连，避免证书与代理干扰
        const httpsAgent = new https.Agent({
            proxy: false,
            rejectUnauthorized: true
        });

        const response = await axios.post(url, data, {
            headers,
            httpsAgent,
            httpAgent: undefined,
            proxy: false,
            timeout: this.timeout,
            transformResponse: [incomingData => incomingData] // 响应明文，避免 axios 预解析
        });

        // 明文响应自行 JSON.parse(云快充无加密)
        let parsed = response.data;
        if (typeof parsed === 'string' && parsed.length > 0) {
            try {
                parsed = JSON.parse(parsed);
            } catch (error) {
                throw new Error(`云快充响应 JSON 解析失败: ${error.message} body=${parsed.slice(0, 200)}`);
            }
        }

        return {
            status: response.status,
            headers: response.headers,
            data: parsed,
            requestParams: data
        };
    }

    /**
     * 按坐标采集场站，返回已映射为 StationModel 字段的场站数组。
     * @param {number} lat 纬度(高德 gcj02)
     * @param {number} lng 经度(高德 gcj02)
     * @param {object} options {cityId='021', pageIndex, pageSize, keyword}
     */
    async collectByLocation(lat, lng, options = {}) {
        const pageIndex = Math.max(1, Math.floor(Number(options.pageIndex) || 1));
        const pageSize = Math.min(50, Math.max(1, Math.floor(Number(options.pageSize) || 10)));
        const cityId = options.cityId !== undefined ? String(options.cityId) : '021';
        const keyword = options.keyword !== undefined ? String(options.keyword) : '';

        const endpoint = 'station/queryStationList';
        const data = {
            keyword,
            cityId,
            userCityId: cityId,
            userLat: lat,
            userLng: lng,
            destPosLat: lat,
            destPosLng: lng,
            filterInfos: [],
            pageIndex,
            pageSize
        };

        const { data: body } = await this.postJson(endpoint, data);

        if (!body || typeof body !== 'object') {
            throw new Error(`云快充响应非 JSON: ${String(body).slice(0, 200)}`);
        }
        if (Number(body.resultCode) !== 0) {
            const error = new Error(
                `云快充接口返回失败: resultCode=${body.resultCode} message=${body.resultDesc || body.message || ''}`
            );
            error.code = 'ykc_api_error';
            error.responseBody = body;
            throw error;
        }

        const list = Array.isArray(body.data) ? body.data : [];
        const totalCount = Number(body.totalCount) || list.length;

        const stations = list.map(item => this.mapStation(item, { lat, lng })).filter(Boolean);

        return {
            platform: this.platform,
            endpoint,
            totalCount,
            collectedCount: stations.length,
            stations
        };
    }

    /**
     * 将云快充原始场站对象映射为 StationModel.insert 所需字段。
     *
     * 字段来源(已验证响应)：
     *   stationId -> stationId / name -> stationName
     *   lng/lat -> longitude/latitude (响应中为字符串，需转数字)
     *   terminalCount: [{total, free, type}] 按 type 汇总各类型枪口
     *   firstPrice -> 电价(元/度) / secondPrice -> 会员优惠价
     *   tags -> 元数据(功率等) / source -> 运营商网络标识
     */
    mapStation(item = {}, queryLocation = {}) {
        if (!item || typeof item !== 'object') {
            return null;
        }

        const toInt = value => {
            const num = Number(value);
            return Number.isFinite(num) && num >= 0 ? Math.floor(num) : 0;
        };

        const stationId = item.stationId || null;
        const stationName = item.name || item.stationName || null;

        // terminalCount 类型映射(按实测 tags 的 kW 值校正)：
        //   type=1 -> 超充(super, 480kW)
        //   type=2 -> 直流快充(fast, 60kW)
        //   type=3 -> 交流慢充(slow, 7kW)
        let superIdlePorts = 0;
        let superTotalPorts = 0;
        let fastIdlePorts = 0;
        let fastTotalPorts = 0;
        let slowIdlePorts = 0;
        let slowTotalPorts = 0;

        const terminalCount = Array.isArray(item.terminalCount) ? item.terminalCount : [];
        for (const tc of terminalCount) {
            const total = toInt(tc.total);
            const free = toInt(tc.free);
            const type = Number(tc.type);
            if (type === 1) {
                // 超充(super)
                superIdlePorts += free;
                superTotalPorts += total;
            } else if (type === 2) {
                // 直流快充(fast)
                fastIdlePorts += free;
                fastTotalPorts += total;
            } else if (type === 3) {
                // 交流慢充(slow)
                slowIdlePorts += free;
                slowTotalPorts += total;
            }
        }

        const availablePorts = fastIdlePorts + slowIdlePorts + superIdlePorts;
        const totalPorts = fastTotalPorts + slowTotalPorts + superTotalPorts;

        // 价格：firstPrice 为电价(元/度)，secondPrice 为会员优惠价
        const priceFast = this.toNumber(item.firstPrice);
        const priceService = this.toNumber(item.secondPrice);

        return {
            platform: this.platform,
            stationId: stationId ? String(stationId) : null,
            stationName,
            address: item.address || null,
            latitude: this.toNumber(item.lat ?? queryLocation.lat),
            longitude: this.toNumber(item.lng ?? queryLocation.lng),
            priceFast,
            priceSlow: null,
            priceSuper: null,
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
            operator: this.extractOperator(item),
            sourceType: 'api-collector',
            sourceStage: 'ykc',
            raw: {
                ...item,
                source: 'api-collector',
                sourceStage: 'ykc',
                platform: this.platform,
                queryLocation
            }
        };
    }

    /**
     * 从场站信息提取运营商名。
     * source 字段: 0=逸安启自营, 2=特来电 等；name 常以运营商名开头。
     */
    extractOperator(item = {}) {
        const name = String(item.name || '').trim();
        // 已知运营商名前缀匹配
        const knownOperators = ['特来电', '逸安启', '星星充电', '国家电网', '小桔充电', '驴充充', '云快充'];
        for (const op of knownOperators) {
            if (name.startsWith(op)) {
                return op;
            }
        }
        // source 标识回退
        const sourceMap = { 0: '逸安启', 2: '特来电' };
        const op = sourceMap[item.source];
        return op || null;
    }

    toNumber(value) {
        if (value === undefined || value === null || value === '') {
            return null;
        }
        const num = Number(value);
        return Number.isFinite(num) ? num : null;
    }
}

module.exports = YkcCollector;
