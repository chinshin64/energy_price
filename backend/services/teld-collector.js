'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');
const axios = require('axios');
const https = require('https');

/**
 * 特来电 采集器
 *
 * 对标 didi-signature-provider 的 class 风格：constructor + 采集方法。
 * 参考已验证脚本 ~/teld-decrypt-test.py (Python) 和 ~/teld-app-service.js (TESDecrypt 来源) 转写为 Node。
 *
 * 接口: https://{sgh1c/sgh2c/sgit1c}.teld.cn/api/invoke?SID={group-method}
 * 鉴权: C01 token，用 RefreshToken 调 ASRefreshToken 刷新。
 * 签名: 无请求签名，但有 SVER=TESDecrypt("yBb6fQbbiHx3g6Me", STS秒时间戳) 防篡改。
 * 请求加密: AES-CBC，teldAESEncrypt(UTS/UVER 动态)，信封 {UTS,UVER,Data,UUID}。
 * 响应解密: teldAESDecrypt 两阶段(外层固定 key 解 -> UTS/UVER 解内层 -> gzip)。
 *
 * AES 密钥(从 teld-decrypt-test.py 提取):
 *   business: key=b"ErYu78ijuVaM7Y0UqwvpO738uNC9ALF7", iv=b"Ol9mqvZ6ijnytr7O"
 *   token:    key=b"7fb498553e3c462988c3b9573692bd5f", iv=b"98d71fe589499967"
 */
class TeldCollector {
    constructor(options = {}) {
        this.browserSigner = options.browserSigner || null;
        // AES 密钥
        this.businessKey = Buffer.from(options.businessKey || 'ErYu78ijuVaM7Y0UqwvpO738uNC9ALF7', 'utf8');
        this.businessIv = Buffer.from(options.businessIv || 'Ol9mqvZ6ijnytr7O', 'utf8');
        this.tokenKey = Buffer.from(options.tokenKey || '7fb498553e3c462988c3b9573692bd5f', 'utf8');
        this.tokenIv = Buffer.from(options.tokenIv || '98d71fe589499967', 'utf8');

        // 设备/UA
        this.deviceId = options.deviceId || '8c922d61-603d-8b95-1b4b-2561aef8e8a2';
        this.appVersion = options.appVersion || '4.14.2';
        this.userAgent = options.userAgent
            || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 MicroMessenger';
        this.referer = options.referer
            || 'https://servicewechat.com/wx8d32c1a71ecd965d/561/page-frame.html';

        // RefreshToken：优先环境变量，其次从本地缓存文件读取
        this.refreshToken = options.refreshToken
            || process.env.TELDS_REFRESH_TOKEN
            || this.readLocalRefreshToken();
        this.refreshTokenPath = options.refreshTokenPath
            || path.join(__dirname, '..', 'data', 'teld_refresh.txt');

        this.c01Token = null;
        this.tokenExpiresAt = 0;

        // TESDecrypt 加载
        this.appServicePath = options.appServicePath
            || path.join(__dirname, '..', 'data', 'teld-app-service.js');
        this.tesDecryptFn = null;

        this.timeout = options.timeout || 15000;
        this.platform = 'teld';
        this.lastSignatureSource = 'node-vm';

        // 搜站域名轮询
        this.domains = options.domains || ['sgh1c.teld.cn', 'sgh2c.teld.cn', 'sgit1c.teld.cn'];
        this.refreshDomain = options.refreshDomain || 'sgit1c.teld.cn';
    }

    readLocalRefreshToken() {
        const candidates = [
            path.join(__dirname, '..', 'data', 'teld_refresh.txt'),
            path.join(process.env.HOME || '', 'teld_refresh.txt')
        ];
        for (const candidate of candidates) {
            try {
                if (fs.existsSync(candidate)) {
                    const token = fs.readFileSync(candidate, 'utf8').trim();
                    if (token) {
                        return token;
                    }
                }
            } catch (error) {
                // ignore
            }
        }
        return '';
    }

    saveLocalRefreshToken(token) {
        try {
            const dir = path.dirname(this.refreshTokenPath);
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(this.refreshTokenPath, token, { mode: 0o600 });
        } catch (error) {
            // ignore
        }
    }

    /**
     * 用 Node vm 加载 app-service.js，提取 TESDecrypt。
     * 复刻 teld-decrypt-test.py 里的 TES_LOADER：
     *   - 沙箱执行 webpack 打包的 app-service.js
     *   - 取出 utils/api/web/ajax/index.js 模块的 TESDecrypt
     */
    loadTesDecrypt() {
        if (this.tesDecryptFn) {
            return this.tesDecryptFn;
        }

        const code = fs.readFileSync(this.appServicePath, 'utf8');
        const modules = {};
        const moduleCache = {};

        function define(name, factory) {
            modules[name] = factory;
        }

        function makeRequire(current) {
            return function (request) {
                let resolved = request;
                if (request.startsWith('.')) {
                    const parts = current.split('/');
                    parts.pop();
                    for (const piece of request.split('/')) {
                        if (piece === '.') continue;
                        if (piece === '..') parts.pop();
                        else parts.push(piece);
                    }
                    resolved = parts.join('/');
                }

                const candidates = [resolved, `${resolved}.js`];
                let foundKey = null;
                for (const candidate of candidates) {
                    if (modules[candidate]) {
                        foundKey = candidate;
                        break;
                    }
                }
                if (!foundKey) {
                    for (const key of Object.keys(modules)) {
                        if (key === resolved || key.endsWith(`/${resolved}`) || resolved.endsWith(key)) {
                            foundKey = key;
                            break;
                        }
                    }
                }
                if (!foundKey) {
                    const tail = request.split('/').pop();
                    for (const key of Object.keys(modules)) {
                        if (key.split('/').pop() === tail) {
                            foundKey = key;
                            break;
                        }
                    }
                    if (!foundKey) {
                        throw new Error(`module not found: ${request}`);
                    }
                }

                if (moduleCache[foundKey]) {
                    return moduleCache[foundKey].exports;
                }
                const moduleObj = { exports: {} };
                moduleCache[foundKey] = moduleObj;
                try {
                    modules[foundKey](makeRequire(foundKey), moduleObj.exports, moduleObj);
                } catch (error) {
                    // 某些模块依赖 wx 运行时，加载失败可忽略
                }
                return moduleObj.exports;
            };
        }

        const sandbox = {
            console,
            __wxAppData: {},
            __wxAppCode__: {},
            __WXML_GLOBAL__: { entrys: {}, defines: {}, modules: {}, ops: [], wxs_nf_init: undefined, total_ops: 0 },
            __GWX_GLOBAL__: {},
            __vd_version_info__: {},
            Component: function () { return {}; },
            definePlugin: function () {},
            requirePlugin: function () {},
            Behavior: function () {},
            Page: function () {},
            App: function () {},
            getApp: function () { return {}; },
            getCurrentPages: function () { return []; },
            define,
            module: { exports: {} },
            exports: {},
            process: { env: {} },
            setTimeout,
            Buffer
        };
        sandbox.globalThis = sandbox;
        sandbox.global = sandbox;
        sandbox.self = sandbox;
        sandbox.require = makeRequire('__root__');

        vm.createContext(sandbox);
        vm.runInContext(code, sandbox, { filename: 'teld-app-service.js', timeout: 30000 });

        const moduleObj = { exports: {} };
        const targetKey = 'utils/api/web/ajax/index.js';
        if (!modules[targetKey]) {
            throw new Error('TESDecrypt 模块 utils/api/web/ajax/index.js 未找到');
        }
        modules[targetKey](makeRequire(targetKey), moduleObj.exports, moduleObj);

        const exportsObj = moduleObj.exports.exports || moduleObj.exports;
        const tesDecrypt = exportsObj.TESDecrypt;
        if (typeof tesDecrypt !== 'function') {
            throw new Error('TESDecrypt 函数提取失败');
        }
        this.tesDecryptFn = tesDecrypt;
        return tesDecrypt;
    }

    /**
     * SVER 防篡改值：TESDecrypt("yBb6fQbbiHx3g6Me", STS秒时间戳)
     */
    generateSver(sts) {
        const tesDecrypt = this.loadTesDecrypt();
        return tesDecrypt('yBb6fQbbiHx3g6Me', String(sts));
    }

    async resolveSver(sts) {
        if (!this.browserSigner || typeof this.browserSigner.sign !== 'function') {
            this.lastSignatureSource = 'node-vm';
            return this.generateSver(sts);
        }
        try {
            const result = await this.browserSigner.sign('teld', {
                key: 'yBb6fQbbiHx3g6Me',
                sts: String(sts)
            });
            if (typeof result !== 'string' || !/^[a-f\d]{40}$/i.test(result)) {
                throw new Error('browser signer returned an invalid teld SVER');
            }
            this.lastSignatureSource = 'browser';
            return result;
        } catch {
            this.lastSignatureSource = 'node-vm-fallback';
            return this.generateSver(sts);
        }
    }

    /**
     * 生成 UTS：毫秒时间戳字符串 + "uts"，取前 16 位作为内层 AES key。
     */
    generateUts() {
        const ts = `${Date.now()}uts`;
        return { uts: ts, key: ts.slice(0, 16) };
    }

    /**
     * 生成 UVER：16 位随机 hex 作为内层 AES iv。
     */
    generateUver() {
        return crypto.randomBytes(8).toString('hex').slice(0, 16);
    }

    /**
     * 根据 key 长度推导 AES 算法：
     *   16 字节 -> aes-128-cbc (内层 UTS16/UVER)
     *   32 字节 -> aes-256-cbc (外层固定 key，Python PyCryptodome 自动适配)
     */
    aesAlgorithm(key) {
        const len = Buffer.byteLength(key);
        if (len === 16) return 'aes-128-cbc';
        if (len === 32) return 'aes-256-cbc';
        throw new Error(`不支持的 AES key 长度: ${len}`);
    }

    /**
     * AES-CBC 加密 (PKCS7 填充)。
     */
    aesEncrypt(plaintext, key, iv) {
        const cipher = crypto.createCipheriv(this.aesAlgorithm(key), key, iv);
        const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
        return encrypted;
    }

    /**
     * AES-CBC 解密 (PKCS7 去填充)。
     */
    aesDecrypt(ciphertext, key, iv) {
        const decipher = crypto.createDecipheriv(this.aesAlgorithm(key), key, iv);
        const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        return decrypted;
    }

    /**
     * 请求加密：信封 {UTS, UVER, Data, UUID}
     *   - 内层明文 = JSON(业务参数)
     *   - 内层密文 = AES(明文, UTS16key, UVER)
     *   - Data = base64(内层密文)
     */
    encryptRequest(data = {}) {
        const { uts, key } = this.generateUts();
        const uver = this.generateUver();
        const plaintext = JSON.stringify(data);
        const inner = this.aesEncrypt(plaintext, Buffer.from(key, 'utf8'), Buffer.from(uver, 'utf8'));
        return {
            UTS: uts,
            UVER: uver,
            Data: inner.toString('base64'),
            UUID: crypto.randomUUID()
        };
    }

    /**
     * 响应解密：两阶段
     *   - 外层：固定 key(先 business 后 token) 解出 {UTS, UVER, Data}
     *   - 内层：AES(Data, UTS16key, UVER) 解出明文
     *   - 若明文是 "H4sI..." 则 gzip 解压
     *
     * 响应 data 字段有时是 base64 字符串，有时是 {data: "base64"} 信封，
     * 这里统一归一为字符串再解密。
     */
    decryptResponse(payload) {
        let b64 = payload;
        if (b64 && typeof b64 === 'object' && !Array.isArray(b64)) {
            // 信封 {data: "base64"} 或 {Data: "base64"}
            b64 = b64.data || b64.Data || b64;
        }
        if (typeof b64 !== 'string') {
            throw new Error(`响应解密失败：data 不是字符串 (${typeof b64})`);
        }
        const raw = Buffer.from(b64, 'base64');
        let lastError = null;

        for (const [key, iv] of [[this.businessKey, this.businessIv], [this.tokenKey, this.tokenIv]]) {
            try {
                const outerJson = this.aesDecrypt(raw, key, iv).toString('utf8');
                const outer = JSON.parse(outerJson);
                const uts16 = (String(outer.UTS) + 'uts').slice(0, 16);
                const uver = outer.UVER;
                const inner = Buffer.from(outer.Data, 'base64');
                const midText = this.aesDecrypt(inner, Buffer.from(uts16, 'utf8'), Buffer.from(uver, 'utf8')).toString('utf8');
                let mid = JSON.parse(midText);
                // 业务类响应内层是 "H4sI..." gzip 字符串
                if (typeof mid === 'string' && mid.slice(0, 4) === 'H4sI') {
                    const decompressed = zlib.gunzipSync(Buffer.from(mid, 'base64')).toString('utf8');
                    mid = JSON.parse(decompressed);
                }
                return mid;
            } catch (error) {
                lastError = error;
            }
        }
        throw lastError || new Error('响应解密失败');
    }

    /**
     * 刷新 C01 token：用 RefreshToken 调 ASRefreshToken。
     * 参考 teld-decrypt-test.py 中的刷新逻辑。
     */
    async refreshTokenIfNeeded() {
        const now = Date.now();
        if (this.c01Token && now < this.tokenExpiresAt) {
            return this.c01Token;
        }

        if (!this.refreshToken) {
            throw new Error('缺少特来电 RefreshToken，请设置环境变量 TELDS_REFRESH_TOKEN 或 data/teld_refresh.txt');
        }

        const payload = this.encryptRequest({
            DeviceId: this.deviceId,
            DeviceType: 'SP',
            ReqSource: 10,
            RefreshToken: this.refreshToken
        });

        const sts = String(Math.floor(Date.now() / 1000));
        const sver = await this.resolveSver(sts);
        const body = {
            refreshToken: JSON.stringify(payload),
            TELDAppID: '',
            'X-Token': '',
            STS: sts,
            SVER: sver,
            SSDI: this.deviceId,
            SCOI: '',
            SCOL: '',
            SRS: 'SP'
        };

        const data = await this.invoke('CUS-WEBUI-ASRefreshToken', this.refreshDomain, body, '');
        const decrypted = this.decryptResponse(data.data);
        const token = decrypted.AccessToken || decrypted.accessToken;
        if (!token) {
            const error = new Error(`特来电 token 刷新失败: ${JSON.stringify(decrypted).slice(0, 200)}`);
            error.code = 'teld_refresh_failed';
            throw error;
        }

        this.c01Token = token;
        // 提前 5 分钟过期，保守刷新
        this.tokenExpiresAt = now + 55 * 60 * 1000;
        this.saveLocalRefreshToken(this.refreshToken);
        return token;
    }

    /**
     * 调用特来电 invoke 接口。
     * @param {string} sid 例如 AAPI-V0700-SCSC-SearchStation
     * @param {string} domain 例如 sgh1c.teld.cn
     * @param {object} params 表单参数
     * @param {string} token C01 token
     */
    async invoke(sid, domain, params, token = '') {
        const url = `https://${domain}/api/invoke?SID=${sid}`;
        const body = new URLSearchParams(
            Object.entries(params).filter(([, value]) => value !== undefined && value !== null)
        ).toString();
        const requestId = `${this.deviceId}_${Date.now()}_WX_SP`;
        const deviceParam = `network=wifi&lat=31.2304&lng=121.4737&app_version=${this.appVersion}&device_name=Mac15,7&client_version=${this.appVersion}`;

        // 172 系统代理 Charles(8888)：禁用代理直连
        const httpsAgent = new https.Agent({
            proxy: false,
            rejectUnauthorized: true
        });

        const response = await axios.post(url, body, {
            headers: {
                Host: domain,
                'Teld-RequestID': requestId,
                TELDAppID: '',
                'x-sps-v': '1.0',
                xweb_xhr: '1',
                'Teld-RpcID': '0.1',
                Device: encodeURIComponent(deviceParam),
                AppVersion: this.appVersion,
                'User-Agent': this.userAgent,
                AppOS: 'WX_SP',
                'Content-Type': 'application/x-www-form-urlencoded',
                Accept: '*/*',
                Referer: this.referer,
                'X-Token': token
            },
            httpsAgent,
            proxy: false,
            timeout: this.timeout
        });

        return {
            status: response.status,
            data: response.data
        };
    }

    /**
     * 按坐标采集场站，返回已映射为 StationModel 字段的场站数组。
     * @param {number} lat 纬度
     * @param {number} lng 经度
     * @param {object} options {pageNum, itemNumPerPage, locationFilterValue}
     */
    async collectByLocation(lat, lng, options = {}) {
        const token = await this.refreshTokenIfNeeded();

        const pageNum = Math.max(1, Math.floor(Number(options.pageNum) || 1));
        const itemNumPerPage = Math.min(50, Math.max(1, Math.floor(Number(options.itemNumPerPage) || 10)));
        const locationFilterValue = options.locationFilterValue !== undefined
            ? options.locationFilterValue
            : 50;

        const param = {
            pageNum,
            itemNumPerPage,
            locationFilterType: '1',
            lng,
            lat,
            sortType: '1',
            coordinateType: 'gaode',
            keyword: '',
            rideShareTag: '',
            source: 'wxsp',
            locationFilterValue,
            stationType: '2',
            tagInfo: []
        };

        const enc = this.encryptRequest(param);
        const sts = String(Math.floor(Date.now() / 1000));
        const sver = await this.resolveSver(sts);
        const body = {
            param: JSON.stringify(enc),
            TELDAppID: '',
            'X-Token': token,
            STS: sts,
            SVER: sver,
            SSDI: this.deviceId,
            SCOI: '',
            SCOL: '',
            SRS: 'SP'
        };

        const domain = this.domains[(pageNum - 1) % this.domains.length];
        const sid = 'AAPI-V0700-SCSC-SearchStation';
        const { data: responseBody } = await this.invoke(sid, domain, body, token);

        if (!responseBody || typeof responseBody !== 'object') {
            throw new Error(`特来电响应非 JSON: ${String(responseBody).slice(0, 200)}`);
        }
        if (String(responseBody.state) !== '1') {
            const error = new Error(`特来电接口返回失败: state=${responseBody.state} errcode=${responseBody.errcode || ''} errmsg=${responseBody.errmsg || ''}`);
            error.code = 'teld_api_error';
            error.responseBody = responseBody;
            throw error;
        }

        const decrypted = this.decryptResponse(responseBody.data);
        const stations = Array.isArray(decrypted.stations) ? decrypted.stations : [];
        const mapped = stations.map(item => this.mapStation(item)).filter(Boolean);

        return {
            platform: this.platform,
            sid,
            domain,
            itemCount: Number(decrypted.itemCount) || mapped.length,
            currentPage: Number(decrypted.currentPage) || pageNum,
            pageCount: Number(decrypted.pageCount) || 0,
            collectedCount: mapped.length,
            stations: mapped
        };
    }

    /**
     * 将特来电原始场站对象映射为 StationModel.insert 所需字段。
     * 字段来源(已验证响应):
     *   name / nowPrice / slowTerminalIdleNum / stationAddress / stations(枪口列表)
     */
    mapStation(item = {}) {
        if (!item || typeof item !== 'object') {
            return null;
        }

        const toInt = value => {
            const num = Number(value);
            return Number.isFinite(num) && num >= 0 ? Math.floor(num) : 0;
        };

        const stationName = item.name || item.StationName || null;
        const stationId = item.stationId || item.StationID || item.id || null;
        const latitude = this.toNumber(item.lat ?? item.StationLat ?? item.latitude);
        const longitude = this.toNumber(item.lng ?? item.StationLng ?? item.longitude);

        const priceFast = this.toNumber(item.nowPrice ?? item.fastPrice ?? item.FastPrice);
        const priceSlow = this.toNumber(item.slowPrice ?? item.SlowPrice);
        const priceSuper = this.toNumber(item.superPrice ?? item.SuperPrice);
        const priceService = this.toNumber(item.servicePrice ?? item.ServicePrice);

        // 枪口：特来电返回 slowTerminalIdleNum 等字段
        const fastIdlePorts = toInt(item.fastTerminalIdleNum ?? item.FastIdleNum);
        const slowIdlePorts = toInt(item.slowTerminalIdleNum ?? item.SlowIdleNum);
        const superIdlePorts = toInt(item.superTerminalIdleNum ?? item.SuperIdleNum);

        // 从 stations(枪口列表) 聚合总数
        const gunList = Array.isArray(item.stations) ? item.stations : [];
        const countGuns = (typeKey) => {
            return gunList.filter(gun => {
                const gunType = String(gun.connectorType || gun.type || '').toLowerCase();
                return gunType === typeKey;
            }).length;
        };
        const fastTotalPorts = toInt(item.fastTerminalNum) || countGuns('fast') || countGuns('dc');
        const slowTotalPorts = toInt(item.slowTerminalNum) || countGuns('slow') || countGuns('ac');
        const superTotalPorts = toInt(item.superTerminalNum) || countGuns('super');

        const availablePorts = fastIdlePorts + slowIdlePorts + superIdlePorts;
        const totalPorts = fastTotalPorts + slowTotalPorts + superTotalPorts;

        return {
            platform: this.platform,
            stationId: stationId ? String(stationId) : null,
            stationName,
            address: item.stationAddress || item.address || item.Address || null,
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
            operator: item.operatorName || item.operator || '特来电',
            sourceType: 'api-collector',
            sourceStage: 'teld',
            raw: {
                ...item,
                source: 'api-collector',
                sourceStage: 'teld',
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

module.exports = TeldCollector;
