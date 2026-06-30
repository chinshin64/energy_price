const fs = require('fs');
const path = require('path');

class MobileSupervisorService {
    constructor(options = {}) {
        this.dataDir = options.dataDir || path.join(__dirname, '../../data/mobile-supervisor');
        this.maxRecentEvents = Number(options.maxRecentEvents || 200);
        this.enabled = options.enabled !== false;
        this.sessionStates = new Map();
        fs.mkdirSync(this.dataDir, { recursive: true });
    }

    getClientConfig() {
        if (!this.enabled) {
            return {
                endpoint: '/api/mobile-sync/supervisor',
                recentEndpoint: '/api/mobile-sync/supervisor/recent',
                actions: [],
                pageTypes: [],
                mode: 'planned',
                enabled: false,
                message: 'AI 监督已暂时下线，后续版本恢复。'
            };
        }
        return {
            endpoint: '/api/mobile-sync/supervisor',
            recentEndpoint: '/api/mobile-sync/supervisor/recent',
            actions: ['NONE', 'BACK', 'SCROLL', 'WAIT', 'STOP'],
            pageTypes: ['LIST', 'DETAIL', 'SCANNER', 'LOGIN', 'MARKETING', 'EMPTY', 'UNKNOWN'],
            mode: 'hybrid-rule-ai-supervisor',
            enabled: true
        };
    }

    ingestEvent(payload = {}) {
        const event = this.normalizeEvent(payload);
        const decision = this.decide(event, payload);
        event.serverDecision = decision;
        event.clientDecision = this.normalizeClientDecision(payload);
        event.pageType = decision.pageType;
        event.action = decision.action;
        event.reason = decision.reason;
        event.sameHashCount = decision.sameHashCount;
        event.sameSignatureCount = decision.sameSignatureCount;
        event.recoveryCount = decision.recoveryCount;
        this.appendEvent(event);
        return {
            accepted: true,
            sessionId: event.sessionId,
            pageIndex: event.pageIndex,
            pageType: event.pageType,
            action: event.action,
            reason: event.reason,
            decision
        };
    }

    getRecent(limit = 100) {
        const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
        const file = this.eventsFile();
        if (!fs.existsSync(file)) {
            return [];
        }
        const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
        return lines.slice(-safeLimit).map(line => {
            try {
                return JSON.parse(line);
            } catch (error) {
                return null;
            }
        }).filter(Boolean).reverse();
    }

    normalizeEvent(payload) {
        const decision = payload.decision || {};
        return {
            receivedAt: new Date().toISOString(),
            clientVersion: this.clean(payload.clientVersion),
            platform: this.clean(payload.platform),
            city: this.clean(payload.city),
            deviceId: this.clean(payload.deviceId),
            appPackage: this.clean(payload.appPackage),
            currentPackageName: this.clean(payload.currentPackageName || payload.foregroundPackage || payload.appPackage),
            currentClassName: this.clean(payload.currentClassName || payload.foregroundClass),
            sessionId: this.clean(payload.sessionId || decision.sessionId) || `mobile-${Date.now()}`,
            pageIndex: this.toInt(payload.pageIndex ?? decision.pageIndex, 0),
            stage: this.clean(payload.sourceStage || payload.stage || decision.stage) || 'phone-auto-scroll',
            screenshotHash: this.clean(payload.screenshotHash || decision.screenshotHash),
            pageType: this.clean(payload.pageType || decision.pageType) || 'UNKNOWN',
            action: this.clean(payload.action || decision.action) || 'NONE',
            reason: this.clean(payload.reason || decision.reason),
            localStationCount: this.toInt(payload.localStationCount ?? decision.localStationCount, 0),
            rowCount: this.toInt(payload.rowCount ?? decision.rowCount, 0),
            sameHashCount: this.toInt(payload.sameHashCount ?? decision.sameHashCount, 0),
            sameSignatureCount: this.toInt(payload.sameSignatureCount ?? decision.sameSignatureCount, 0),
            recoveryCount: this.toInt(payload.recoveryCount ?? decision.recoveryCount, 0),
            textSample: this.clean(payload.textSample || decision.textSample).slice(0, 500),
            raw: payload
        };
    }

    decide(event, payload = {}) {
        const rows = this.normalizeRows(payload.ocrRows || payload.rows || payload.textBlocks);
        const text = rows.length > 0 ? this.joinRows(rows) : event.textSample;
        const state = this.getSessionState(event.sessionId);
        const pageType = this.classifyPage(rows, text, event);
        const signature = this.buildSignature(rows, text);
        this.updateState(state, pageType, event.screenshotHash, signature);

        const decision = {
            sessionId: event.sessionId,
            pageIndex: event.pageIndex,
            stage: event.stage,
            screenshotHash: event.screenshotHash || null,
            pageType,
            action: 'NONE',
            reason: '服务端判断页面正常，继续既有采集步骤',
            sameHashCount: state.sameHashCount,
            sameSignatureCount: state.sameSignatureCount,
            recoveryCount: state.recoveryCount,
            localStationCount: event.localStationCount,
            rowCount: rows.length || event.rowCount,
            textSample: text.slice(0, 260)
        };

        if (this.isOutsideWechat(event, text)) {
            return this.withRecovery(decision, state, 'STOP', '当前前台不在微信小程序内，停止采集以避免误操作');
        }

        if (pageType === 'SCANNER' || pageType === 'LOGIN' || pageType === 'MARKETING') {
            return this.withRecovery(decision, state, 'BACK', `服务端识别到阻塞页面: ${pageType}，返回上一层`);
        }

        if (pageType === 'EMPTY') {
            if (state.emptyCount >= 3) {
                return this.withRecovery(decision, state, 'STOP', '连续空页面，停止采集等待人工确认');
            }
            decision.action = 'WAIT';
            decision.reason = '页面暂未读取到文本，等待下一帧';
            return decision;
        }

        if (pageType === 'UNKNOWN') {
            if (state.unknownCount >= 2 || this.looksLikeWechatHomeOrChat(text)) {
                return this.withRecovery(decision, state, 'STOP', '连续未知页面或已离开目标小程序，停止采集等待人工确认');
            }
            decision.action = 'WAIT';
            decision.reason = '服务端首次识别未知页面，先等待下一帧避免盲目返回';
            return decision;
        }

        if (event.stage.includes('detail') && state.sameSignatureCount >= 3) {
            return this.withRecovery(decision, state, 'BACK', '详情页连续无变化，返回列表继续');
        }

        if (pageType === 'LIST' && state.sameSignatureCount >= 3) {
            return this.withRecovery(decision, state, 'SCROLL', '列表页连续重复，服务端要求补一次下滑');
        }

        return decision;
    }

    normalizeClientDecision(payload = {}) {
        const decision = payload.clientDecision || payload.decision || null;
        if (!decision || typeof decision !== 'object') {
            return null;
        }
        return {
            pageType: this.clean(decision.pageType),
            action: this.clean(decision.action),
            reason: this.clean(decision.reason),
            sameHashCount: this.toInt(decision.sameHashCount, 0),
            sameSignatureCount: this.toInt(decision.sameSignatureCount, 0),
            recoveryCount: this.toInt(decision.recoveryCount, 0)
        };
    }

    normalizeRows(rows) {
        if (!Array.isArray(rows)) {
            return [];
        }
        return rows.map((row, index) => {
            if (typeof row === 'string') {
                return { text: this.clean(row), x: 0, y: 0, width: 0, height: 0, index };
            }
            if (!row || typeof row !== 'object') {
                return null;
            }
            const box = row.boundingBox || row.bounds || {};
            return {
                text: this.clean(row.text || row.content || row.value),
                x: this.toNumber(row.x, box.x, box.left, 0),
                y: this.toNumber(row.y, box.y, box.top, 0),
                width: this.toNumber(row.width, box.width, 0),
                height: this.toNumber(row.height, box.height, 0),
                index
            };
        }).filter(row => row && row.text);
    }

    classifyPage(rows, text, event) {
        const compact = this.compact(text);
        if (!compact) {
            return 'EMPTY';
        }
        if (compact.includes('相册') && (compact.includes('扫码') || compact.includes('扫一扫'))) {
            return 'SCANNER';
        }
        if (this.countMatches(compact, ['手机号登录', '微信授权', '立即登录', '一键登录', '授权登录', '绑定手机', '同意并登录']) >= 2) {
            return 'LOGIN';
        }
        if (this.countMatches(compact, ['即将打开', '将打开', '取消', '允许', '打开小程序', '需要获取你的地理位置', '申请获取你的位置权限', '位置权限', '拒绝', '地理位置']) >= 2) {
            return 'MARKETING';
        }
        if (this.countMatches(compact, ['领取优惠', '新人专享', '立即参与', '活动规则', '优惠券', '限时活动', '立即领取', '开通会员']) >= 3) {
            return 'MARKETING';
        }
        if (this.countMatches(compact, ['小红书', '条评论', '留下你的想法', '关注', '回复', '淘宝服务']) >= 2) {
            return 'MARKETING';
        }
        if (this.isDetailPage(rows, compact)) {
            return 'DETAIL';
        }
        if (this.isListPage(rows, compact)) {
            return 'LIST';
        }
        if (this.looksLikeWechatHomeOrChat(compact) || this.isNonMiniProgramWechat(event, compact)) {
            return 'UNKNOWN';
        }
        return 'UNKNOWN';
    }

    isOutsideWechat(event, text) {
        const pkg = this.clean(event.currentPackageName || event.appPackage);
        if (pkg && pkg !== 'com.tencent.mm') {
            return true;
        }
        return this.compact(text).includes('文件管理')
            && this.compact(text).includes('应用商店')
            && this.compact(text).includes('系统工具');
    }

    isNonMiniProgramWechat(event, text) {
        const cls = this.clean(event.currentClassName);
        if (cls.includes('AppBrand')) {
            return false;
        }
        return this.looksLikeWechatHomeOrChat(text);
    }

    looksLikeWechatHomeOrChat(text) {
        const compact = this.compact(text);
        return this.countMatches(compact, ['文件传输助手', '聊天记录', '通讯录', '发现', '我', '最近使用的小程序']) >= 2
            || this.countMatches(compact, ['微信', '小程序', '最近', '暂无内容', '搜索']) >= 4;
    }

    isDetailPage(rows, text) {
        const strong = this.countMatches(text, ['场站详情', '站点详情', '站点地址', '详细地址', '营业时间', '费用详情', '收费标准', '充电费用', '当前时段', '枪编号', '枪桩信息']) > 0;
        const hasAddress = this.hasAddress(rows);
        const hasPrice = this.hasEnergyPrice(text);
        const hasPort = this.hasPortSummary(text);
        return strong && (hasAddress || hasPrice || hasPort);
    }

    isListPage(rows, text) {
        const listChrome = this.countMatches(text, ['附近充电站', '推荐排序', '距离最近', '筛选', '地图']) >= 1;
        const stationTitleCount = rows.filter(row => this.isStationTitleCandidate(row.text)).length;
        return listChrome
            || (stationTitleCount >= 2 && (this.hasEnergyPrice(text) || this.hasPortSummary(text)))
            || (stationTitleCount >= 1 && /(?:km|公里|m)/i.test(text) && (this.hasEnergyPrice(text) || this.hasPortSummary(text)));
    }

    isStationTitleCandidate(text) {
        const value = this.compact(text).replace(/^[^\u4e00-\u9fa5]+/, '');
        if (value.length < 5 || value.length > 42 || !/[\u4e00-\u9fa5]/.test(value)) {
            return false;
        }
        if (/^[¥￥]?\d/.test(value) || this.hasEnergyPrice(value) || this.hasPortSummary(value)) {
            return false;
        }
        return !/(登录|首页|我的|超时|停车|优惠|余额|订单|会员|须知|费用|福利|活动|奖励|搜索|附近|地图|筛选|广告|跳过|服务费|场站优惠|停车减免|分钟前有人充过)/.test(value);
    }

    hasAddress(rows) {
        return rows.some(row => {
            const text = this.compact(row.text);
            return text.length >= 6
                && text.length <= 90
                && /(省|市|区|县|镇|路|街|道|号|栋|楼|大厦|广场|园区|停车场|地下)/.test(text)
                && !this.hasEnergyPrice(text)
                && !this.hasPortSummary(text);
        });
    }

    hasEnergyPrice(text) {
        return /[¥￥]?\d+(?:\.\d+)?(?:元)?\/?(?:度|千瓦时|kWh|KWH)/.test(text)
            || /(电价|服务费|充电费).*?\d+(?:\.\d+)?/.test(text);
    }

    hasPortSummary(text) {
        return /(快|慢|超)?(?:闲|空闲)\d+\/\d+/.test(text)
            || /(快充|慢充|超充).*?\d+.*?(枪|个|支)/.test(text);
    }

    getSessionState(sessionId) {
        const key = sessionId || 'default';
        if (!this.sessionStates.has(key)) {
            this.sessionStates.set(key, {
                lastHash: '',
                lastSignature: '',
                sameHashCount: 0,
                sameSignatureCount: 0,
                unknownCount: 0,
                emptyCount: 0,
                recoveryCount: 0
            });
        }
        return this.sessionStates.get(key);
    }

    updateState(state, pageType, hash, signature) {
        const safeHash = this.clean(hash);
        if (safeHash && safeHash === state.lastHash) {
            state.sameHashCount += 1;
        } else {
            state.sameHashCount = 1;
            state.lastHash = safeHash;
        }
        const safeSignature = this.clean(signature);
        if (safeSignature && safeSignature === state.lastSignature) {
            state.sameSignatureCount += 1;
        } else {
            state.sameSignatureCount = 1;
            state.lastSignature = safeSignature;
        }
        state.unknownCount = pageType === 'UNKNOWN' ? state.unknownCount + 1 : 0;
        state.emptyCount = pageType === 'EMPTY' ? state.emptyCount + 1 : 0;
    }

    withRecovery(decision, state, action, reason) {
        state.recoveryCount += 1;
        return {
            ...decision,
            action,
            reason,
            recoveryCount: state.recoveryCount,
            sameHashCount: state.sameHashCount,
            sameSignatureCount: state.sameSignatureCount
        };
    }

    buildSignature(rows, fallbackText = '') {
        const source = rows.length > 0
            ? rows
                .map(row => ({ row, text: this.compact(row.text) }))
                .filter(item => item.text && !this.isVolatileText(item.row, item.text))
                .map(item => item.text)
                .join(' ')
            : this.compact(fallbackText);
        return source.slice(0, 180);
    }

    isVolatileText(row, text) {
        return (row && (row.y < 0.10 || row.y > 0.92))
            || /(?:OCR采集中|0CR采集中|暂停|重启|停止|晚上|上午|下午|\d{1,2}:\d{2}|\d+(?:\.\d+)?K\/s|5G|HD)/.test(text);
    }

    joinRows(rows) {
        return rows.map(row => this.compact(row.text)).filter(Boolean).join(' ');
    }

    countMatches(text, keywords) {
        return keywords.reduce((count, keyword) => text.includes(keyword) ? count + 1 : count, 0);
    }

    compact(value) {
        return String(value || '').replace(/\s+/g, '').trim();
    }

    appendEvent(event) {
        fs.appendFileSync(this.eventsFile(), `${JSON.stringify(event)}\n`);
    }

    eventsFile() {
        return path.join(this.dataDir, 'events.jsonl');
    }

    clean(value) {
        return String(value || '').trim();
    }

    toInt(value, fallback) {
        const number = Number(value);
        return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : fallback;
    }

    toNumber(...values) {
        for (const value of values) {
            const number = Number(value);
            if (Number.isFinite(number)) {
                return number;
            }
        }
        return 0;
    }
}

module.exports = MobileSupervisorService;
