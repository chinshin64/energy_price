/**
 * 滴滴充电专用 OCR 解析器
 * 针对滴滴充电小程序页面结构优化
 */
class DidiOcrParser {
    constructor() {
        // 滴滴场站标题关键词
        this.stationTitleKeywords = [
            '充电站', '充电中心', '充电广场', '充电桩',
            '超充站', '快充站', '慢充站', '极充站', '小桔充电'
        ];
        // 排除关键词（不是场站标题）
        this.excludeKeywords = [
            '目的地', '附近充电站', '筛选', '评价', '详情',
            '搜索', '推荐', '热门', '最新', '导航', '距离',
            '登录后', '立即登录', '补充车辆', '首页', '我的',
            '超时占用费', '停车减免', '停车免费', '场站已暂停服务',
            '新站特惠', '优惠券', '领取优惠',
            '充电余额', '免费充电', '充电订单', '充电会员', '会员价',
            '充电须知', '充电费用', '开始充电', '可用充电余额',
            '信号好像不太好', '刷新试试', '网络异常', '加载失败', '重新加载', '刷新'
        ];
        // 价格类型关键词
        this.priceTypeKeywords = {
            fast: ['快充', '快', 'DC', '直流'],
            slow: ['慢充', '慢', 'AC', '交流'],
            super: ['超充', '超', '超级快充']
        };
    }

    /**
     * 从 OCR 识别结果中提取场站信息
     * @param {Array} ocrRows - OCR 识别的行数据
     * @param {Object} meta - 元数据
     * @returns {Array} 场站列表
     */
    extractStations(ocrRows, meta = {}) {
        if (!Array.isArray(ocrRows) || ocrRows.length === 0) {
            return [];
        }

        // 标准化行数据
        const rows = this.normalizeRows(ocrRows);

        // 识别场站标题行
        const titleRows = this.findStationTitles(rows);

        if (titleRows.length === 0) {
            return [];
        }

        const stations = [];

        for (let i = 0; i < titleRows.length; i += 1) {
            const titleRow = titleRows[i];
            const nextTitleRow = titleRows[i + 1] || null;
            // 获取该标题下方的相关行（场站信息带）
            const band = this.extractStationBand(rows, titleRow, nextTitleRow);

            // 解析场站信息
            const station = this.parseStationBand(band, titleRow, meta);
            if (station) {
                stations.push(station);
            }
        }

        return stations;
    }

    /**
     * 标准化 OCR 行数据
     */
    normalizeRows(ocrRows) {
        const rows = ocrRows.map((row, index) => {
            if (typeof row === 'string') {
                return { text: row, index, y: 0, x: 0 };
            }
            return {
                text: String(row.text || row.content || ''),
                index: row.index ?? index,
                y: row.boundingBox?.y ?? row.y ?? row.top ?? 0,
                x: row.boundingBox?.x ?? row.x ?? row.left ?? 0,
                width: row.boundingBox?.width ?? row.width ?? 0,
                height: row.boundingBox?.height ?? row.height ?? 0,
                confidence: row.confidence ?? 1
            };
        }).filter(row => row.text.trim());

        const normalizedCoordinateRows = rows.filter(row =>
            Number.isFinite(Number(row.y)) && Number(row.y) >= 0 && Number(row.y) <= 1
        );
        const likelyBottomOrigin = normalizedCoordinateRows.length > 0
            && normalizedCoordinateRows.length === rows.length
            && rows.some(row => row.y > 0.75 && /搜索|城市|首页|我的|筛选|列表|附近|地图|登录|加载更多|立即登录/.test(row.text));

        if (!likelyBottomOrigin) {
            return rows;
        }

        return rows.map(row => ({
            ...row,
            y: 1 - row.y
        }));
    }

    /**
     * 查找场站标题行
     */
    findStationTitles(rows) {
        const titles = [];

        for (const row of rows) {
            if (this.isStationTitle(row.text) || this.isContextualStationTitle(row, rows)) {
                titles.push(row);
            }
        }

        // 按 Y 坐标排序（从上到下）
        return titles.sort((a, b) => a.y - b.y);
    }

    /**
     * 判断是否为场站标题
     */
    isStationTitle(text) {
        const compact = this.normalizeStationCandidate(text);
        if (!compact || this.isNoiseText(compact)) {
            return false;
        }
        if (this.isNonStationChargingText(compact)) {
            return false;
        }

        // 检查排除关键词
        for (const exclude of this.excludeKeywords) {
            if (compact.includes(exclude)) {
                return false;
            }
        }

        // 检查包含关键词
        for (const keyword of this.stationTitleKeywords) {
            if (compact.includes(keyword)) {
                return true;
            }
        }

        return this.hasStrongStationNamePattern(compact);
    }

    isContextualStationTitle(row, rows = []) {
        const compact = this.normalizeStationCandidate(row.text);
        if (!this.isPossibleStationName(compact)) {
            return false;
        }

        const y = Number(row.y) || 0;
        const x = Number(row.x) || 0;

        const sameLineText = rows
            .filter(item => {
                if (item === row) return false;
                const itemY = Number(item.y) || 0;
                return Math.abs(itemY - y) < 0.014 && Number(item.x || 0) > x;
            })
            .map(item => String(item.text || '').replace(/\s+/g, ''))
            .join(' ');
        const bandText = rows
            .filter(item => {
                if (item === row) return false;
                const itemY = Number(item.y) || 0;
                return itemY > y && itemY < y + 0.18;
            })
            .map(item => String(item.text || '').replace(/\s+/g, ''))
            .join(' ');

        const hasPriceOrPortSignal = this.hasPriceSignal(bandText) || this.hasPortSignal(`${sameLineText} ${bandText}`);
        const isHeaderResultTitle = y >= 0.12
            && y < 0.18
            && x >= 0.24
            && x <= 0.68
            && this.hasLocationStationNamePattern(compact)
            && hasPriceOrPortSignal;

        if ((y < 0.18 && !isHeaderResultTitle) || x > 0.72) {
            return false;
        }

        return (this.hasStrongStationNamePattern(compact) || this.hasLocationStationNamePattern(compact)) && hasPriceOrPortSignal
            || this.hasPortSignal(sameLineText);
    }

    isPossibleStationName(text) {
        const compact = this.normalizeStationCandidate(text);
        if (!compact || compact.length < 5 || compact.length > 42) {
            return false;
        }
        if (this.isNoiseText(compact) || this.isNonStationChargingText(compact)) {
            return false;
        }
        if (/^[¥￥]?\d/.test(compact)) {
            return false;
        }
        if (/搜索|附近|地图|筛选|常用|广告|跳过|您有|信息待完善|停车全天免费|停车减免|近期最大|分钟前有人充过|有人充过|服务费|超时|占用费|分钟|小时|券|余额|余額|余领|闲\d+\/\d+|km|公里|m$/.test(compact)) {
            return false;
        }
        if (/场站专属|场站优惠|即插即充|即播即充|私家车|常充|顺风|首单|补贴|车辆信息/.test(compact)) {
            return false;
        }
        if (/信号.*不好|刷新试试|网络异常|加载失败|重新加载|刷新|重试/.test(compact)) {
            return false;
        }
        if (/[A-Za-z][!ル刀口巴用分亡]{2,}/.test(compact)) {
            return false;
        }
        if (/^(地上|地下|快充|慢充|超充|私家车常充|电池防护|服务费8折券|场站优惠|7天内未跳枪)$/.test(compact)) {
            return false;
        }
        return /[\u4e00-\u9fa5]/.test(compact);
    }

    hasPriceSignal(text) {
        return /[¥￥]\s*\d+(\.\d+)?\s*\/?\s*(度|kWh|KWH)?/.test(text)
            || /\d+(\.\d+)?\s*元\s*\/?\s*(度|kWh|KWH)/.test(text);
    }

    hasPortSignal(text) {
        return /(快|慢|超)?\s*(闲|空闲)\s*\d+\s*\/\s*\d+/.test(text)
            || /(快充|慢充|超充).*?\d+.*?(枪|个|支)/.test(text);
    }

    /**
     * 提取场站信息带（标题下方的相关行）
     */
    extractStationBand(rows, titleRow, nextTitleRow = null) {
        const band = [titleRow];
        const titleY = titleRow.y;
        const titleHeight = titleRow.height || 30;

        // 查找标题下方的行（Y 坐标在合理范围内）
        let maxY = titleY + titleHeight * 8; // 大约 8 行的高度
        if (nextTitleRow && Number.isFinite(nextTitleRow.y)) {
            maxY = Math.min(maxY, nextTitleRow.y - Math.max(titleHeight * 0.35, 0.008));
        }

        for (const row of rows) {
            if (row === titleRow) continue;
            const isSameLine = Math.abs(row.y - titleY) < Math.max(titleHeight * 1.2, 0.025);
            if ((row.y > titleY && row.y < maxY) || isSameLine) {
                band.push(row);
            }
        }

        // 按 Y 坐标排序
        return band.sort((a, b) => a.y - b.y);
    }

    /**
     * 解析场站信息带
     */
    parseStationBand(band, titleRow, meta = {}) {
        const texts = band.map(r => r.text);
        const combinedText = texts.join(' ');

        // 场站名称
        const stationName = this.cleanStationName(titleRow.text);
        if (!stationName || this.isNoiseText(stationName)) {
            return null;
        }
        if (!this.isDetailStage(meta) && this.isTruncatedName(stationName)) {
            return null;
        }

        // 地址
        const address = this.extractAddress(texts, stationName);

        // 枪数
        const portInfo = this.extractPorts(texts, combinedText);

        // 价格（包含分时价格）
        const priceInfo = this.extractPrices(texts, combinedText, portInfo);
        if (!this.isDetailStage(meta)
            && priceInfo.fast === null
            && priceInfo.slow === null
            && priceInfo.super === null
            && portInfo.fastTotal === 0
            && portInfo.slowTotal === 0
            && portInfo.superTotal === 0) {
            return null;
        }

        // 经纬度（OCR 无法获取，设为 null）
        const latitude = null;
        const longitude = null;

        return {
            platform: 'didi-charging',
            stationId: null, // OCR 无法获取
            stationName,
            address,
            latitude,
            longitude,
            priceFast: priceInfo.fast,
            priceSlow: priceInfo.slow,
            priceSuper: priceInfo.super,
            priceService: priceInfo.service,
            fastIdlePorts: portInfo.fastIdle,
            fastTotalPorts: portInfo.fastTotal,
            slowIdlePorts: portInfo.slowIdle,
            slowTotalPorts: portInfo.slowTotal,
            superIdlePorts: portInfo.superIdle,
            superTotalPorts: portInfo.superTotal,
            onlineFastPorts: portInfo.fastIdle + portInfo.superIdle,
            onlineSlowPorts: portInfo.slowIdle,
            availablePorts: portInfo.fastIdle + portInfo.slowIdle + portInfo.superIdle,
            totalPorts: portInfo.fastTotal + portInfo.slowTotal + portInfo.superTotal,
            sourceType: meta.sourceType || 'ocr',
            sourceStage: meta.sourceStage || 'page-capture',
            operator: meta.operator || null,
            raw: {
                ocrTexts: texts,
                priceSchedules: priceInfo.schedules,
                source: meta.source || 'page-ocr',
                sourceType: meta.sourceType || 'ocr',
                sourceStage: meta.sourceStage || 'page-capture',
                runId: meta.runId || null,
                city: meta.city || null,
                landmark: meta.landmark || null,
                capturedAt: meta.capturedAt || null,
                screenshotPath: meta.screenshotPath || null
            }
        };
    }

    /**
     * 清理场站名称
     */
    cleanStationName(text) {
        let name = this.normalizeStationCandidate(text);

        // 移除常见的前缀
        name = name.replace(/^(推荐|热门|最新|附近)\s*/i, '');

        // 移除距离信息
        name = name.replace(/\d+(\.\d+)?(km|米|m)\s*$/i, '');
        name = name.replace(/[|「」【】]+/g, '');
        name = name.replace(/^[·•。]+/, '');

        return name || null;
    }

    normalizeStationCandidate(text) {
        return String(text || '')
            .replace(/\s+/g, '')
            .replace(/^[^\u4e00-\u9fa5]+/, '')
            .replace(/^(晚上|晚止)\d{1,2}[:：]?\d{0,2}[|丨]?[\d.Kk/sgS]*/, '');
    }

    /**
     * 提取地址
     */
    extractAddress(texts, stationName) {
        const addressKeywords = ['路', '街', '道', '区', '号', '栋', '层', '广场', '大厦', '园区', '中心'];

        for (const text of texts) {
            const compact = text.replace(/\s+/g, '');
            if (!compact || compact === stationName || this.isStationTitle(compact) || this.isNoiseText(compact)) {
                continue;
            }
            if (/电池防护|超时|占用费|登录|首页|我的|km|公里|米$|m$|停车(?!场)|减免|跳枪|有人充过|私家车|常充|可用券|张可用|即插|即播|分钟|小时/i.test(compact)) {
                continue;
            }
            // 检查是否包含地址关键词且长度合理
            const matchCount = addressKeywords.filter(k => compact.includes(k)).length;
            if (matchCount >= 1 && compact.length >= 5 && compact.length <= 90) {
                // 排除价格和枪数
                if (!/^\d+(\.\d+)?$/.test(compact) && !/枪|个|支|闲\d+\/\d+/.test(compact)) {
                    return compact;
                }
            }
        }

        return null;
    }

    /**
     * 提取价格（包含分时价格）
     */
    extractPrices(texts, combinedText, portInfo = {}) {
        const result = {
            fast: null,
            slow: null,
            super: null,
            service: null,
            schedules: [] // 分时价格
        };

        // 遍历每行文本，识别价格和分时价格
        for (const text of texts) {
            const compact = text.replace(/\s+/g, '');
            if (!compact || this.isNonEnergyPriceLine(compact)) {
                continue;
            }

            // 1. 尝试匹配分时价格
            const schedule = this.parsePriceSchedule(compact);
            if (schedule) {
                result.schedules.push(schedule);
                continue;
            }

            // 2. 尝试匹配带类型的价格
            for (const [type, keywords] of Object.entries(this.priceTypeKeywords)) {
                for (const keyword of keywords) {
                    if (compact.includes(keyword)) {
                        const price = this.extractPriceValue(compact, keyword);
                        if (price !== null && result[type] === null) {
                            result[type] = price;
                        }
                        break;
                    }
                }
            }

            // 3. 尝试匹配服务费
            if (compact.includes('服务费') || compact.includes('服务')) {
                const price = this.extractPriceValue(compact, '服务');
                if (price !== null && result.service === null) {
                    result.service = price;
                }
            }

            const fallbackPrice = this.extractEnergyPriceCandidate(compact);
            if (fallbackPrice !== null) {
                const targetType = this.inferPriceType(compact, portInfo);
                if (result[targetType] === null) {
                    result[targetType] = fallbackPrice;
                }
            }
        }

        // 4. 如果没有分时价格，尝试从整体文本提取
        if (result.schedules.length === 0) {
            result.schedules = this.extractSchedulesFromText(combinedText);
        }

        return result;
    }

    /**
     * 从文本中提取价格数值
     */
    extractPriceValue(text, keyword) {
        if (this.isNonEnergyPriceLine(text)) {
            return null;
        }
        // 移除关键词后的文本
        const afterKeyword = text.split(keyword).pop() || '';

        // 优先匹配带明确价格符号或单位的数值，避免把“空闲12/24”误识别成价格。
        const patterns = [
            /[¥￥]\s*(\d+(?:\.\d{1,4})?)/,
            /(\d+(?:\.\d{1,4})?)\s*(元\/度|元\/千瓦时|元|\/度|\/千瓦时|千瓦时)/
        ];

        for (const pattern of patterns) {
            const match = afterKeyword.match(pattern);
            if (match && match[1]) {
                const price = parseFloat(match[1]);
                if (!isNaN(price) && price > 0 && price < 10) {
                    return price;
                }
            }
        }

        const fallbackMatches = Array.from(afterKeyword.matchAll(/(?:^|[^\d./])(\d+(?:\.\d{1,4})?)(?!\s*\/)/g));
        for (const match of fallbackMatches) {
            const price = parseFloat(match[1]);
            if (!isNaN(price) && price > 0 && price < 10) {
                return price;
            }
        }

        return null;
    }

    extractEnergyPriceCandidate(text) {
        if (this.isNonEnergyPriceLine(text)) {
            return null;
        }

        const patterns = [
            /[¥￥]\s*(\d+(?:\.\d{1,4})?)\s*(?:元)?\s*(?:\/?(?:度|千瓦时|kWh|KWH)|\/)/,
            /(\d+(?:\.\d{1,4})?)\s*(?:元)?\s*(?:\/?(?:度|千瓦时|kWh|KWH)|\/)/
        ];

        for (const pattern of patterns) {
            const match = text.match(pattern);
            if (match && match[1]) {
                const price = parseFloat(match[1]);
                if (this.isValidEnergyPrice(price)) {
                    return price;
                }
            }
        }

        const loose = text.match(/(?:^|[^0-9])([0-2](?:\.\d{1,4})?)(?:$|[^0-9/])/);
        if (loose && this.hasEnergyContext(text)) {
            const price = parseFloat(loose[1]);
            if (this.isValidEnergyPrice(price)) {
                return price;
            }
        }

        return null;
    }

    inferPriceType(text, portInfo = {}) {
        if (/超(?!时)|超级/.test(text)) {
            return 'super';
        }
        if (/慢|交流|AC/i.test(text)) {
            return 'slow';
        }
        if (/快|直流|DC/i.test(text)) {
            return 'fast';
        }
        if ((portInfo.superTotal || 0) > 0 && (portInfo.fastTotal || 0) === 0) {
            return 'super';
        }
        if ((portInfo.slowTotal || 0) > 0 && (portInfo.fastTotal || 0) === 0 && (portInfo.superTotal || 0) === 0) {
            return 'slow';
        }
        return 'fast';
    }

    isValidEnergyPrice(price) {
        return !isNaN(price) && price >= 0.2 && price <= 3.5;
    }

    hasEnergyContext(text) {
        return /度|千瓦时|电价|充电|快|慢|超|闲\d+\/\d+/.test(text);
    }

    isNonEnergyPriceLine(text) {
        return /超时|占用费|分钟|停车|减免|优惠|已减|券|红包|新站特惠|km|公里|米$|m$/i.test(text)
            || /闲\d+\/\d+/.test(text)
            || /^(\d+\/\d+)$/.test(text);
    }

    /**
     * 解析分时价格条目
     */
    parsePriceSchedule(text) {
        // 时间范围模式
        const timePatterns = [
            /(\d{1,2}:\d{2})\s*[-~至]\s*(\d{1,2}:\d{2})/,  // 08:00-12:00
            /(\d{1,2})\s*点?\s*[-~至]\s*(\d{1,2})\s*点?/,  // 8点-12点
            /(早|上午|下午|晚)\s*(\d{1,2})\s*[-~至]\s*(早|上午|下午|晚)?\s*(\d{1,2})/, // 早8-晚8
        ];

        let startTime = null;
        let endTime = null;

        for (const pattern of timePatterns) {
            const match = text.match(pattern);
            if (match) {
                if (pattern === timePatterns[0]) {
                    startTime = match[1];
                    endTime = match[2];
                } else if (pattern === timePatterns[1]) {
                    startTime = `${match[1].padStart(2, '0')}:00`;
                    endTime = `${match[2].padStart(2, '0')}:00`;
                } else if (pattern === timePatterns[2]) {
                    // 中文时间处理
                    const startPeriod = match[1];
                    const startHour = parseInt(match[2], 10);
                    const endPeriod = match[3] || startPeriod;
                    const endHour = parseInt(match[4], 10);

                    startTime = this.chineseTimeToHM(startPeriod, startHour);
                    endTime = this.chineseTimeToHM(endPeriod, endHour);
                }
                break;
            }
        }

        if (!startTime) {
            return null;
        }

        // 提取价格 - 时间段后面的价格
        // 格式：08:00-12:00 0.75 或 08:00-12:00 ¥0.75
        const afterTime = text.replace(/\d{1,2}:\d{2}\s*[-~至]\s*\d{1,2}:\d{2}/, '').trim();
        const priceMatch = afterTime.match(/[¥￥]?\s*(\d+(?:\.\d{1,4})?)/);
        const price = priceMatch ? parseFloat(priceMatch[1]) : null;

        if (price === null || price <= 0 || price > 10) {
            // 价格应该在 0-10 元/度范围内
            return null;
        }

        // 推断类型
        let type = null;
        for (const [t, keywords] of Object.entries(this.priceTypeKeywords)) {
            for (const keyword of keywords) {
                if (text.includes(keyword)) {
                    type = t;
                    break;
                }
            }
            if (type) break;
        }

        return {
            start_time: startTime,
            end_time: endTime,
            price,
            schedule_type: type
        };
    }

    /**
     * 中文时间转换为 HH:mm
     */
    chineseTimeToHM(period, hour) {
        let h = hour;
        if ((period === '下午' || period === '晚') && h < 12) {
            h += 12;
        }
        return `${String(h).padStart(2, '0')}:00`;
    }

    /**
     * 从整体文本提取分时价格
     */
    extractSchedulesFromText(text) {
        const schedules = [];

        // 查找所有时间-价格对
        // 模式：时间段 + 价格
        const pattern = /(\d{1,2}:\d{2})\s*[-~至]\s*(\d{1,2}:\d{2})[^\d]*(\d+(?:\.\d{1,4})?)/g;
        let match;

        while ((match = pattern.exec(text)) !== null) {
            const startTime = match[1];
            const endTime = match[2];
            const price = parseFloat(match[3]);

            if (!isNaN(price) && price > 0 && price <= 3.5) {
                schedules.push({
                    start_time: startTime,
                    end_time: endTime,
                    price,
                    schedule_type: null
                });
            }
        }

        return schedules;
    }

    isDetailStage(meta = {}) {
        return /detail|详情/i.test(String(meta.sourceStage || meta.stage || ''));
    }

    isTruncatedName(name) {
        return /\.{2,}|…|\\.\\.\\./.test(String(name || ''));
    }

    isNoiseText(text) {
        const compact = String(text || '').replace(/\s+/g, '');
        if (!compact) {
            return true;
        }
        if (/登录后|立即登录|一键登录|微信授权|手机号登录|补充车辆|首页|我的|授权|隐私|用户协议/.test(compact)) {
            return true;
        }
        if (/信号.*不好|刷新试试|网络异常|加载失败|重新加载|刷新|重试/.test(compact)) {
            return true;
        }
        if (/超时占用费|停车减免|停车全天|场站已暂停|暂停服务|电池防护|新站特惠|优惠券|领取优惠/.test(compact)) {
            return true;
        }
        if (/可用券|张可用|充电余额|可用充电|即插即充|即播即充|私家车|常充|跳枪|有人充过|分钟|小时|场站专属|场站优惠|顺风|首单|补贴|车辆信息/.test(compact)) {
            return true;
        }
        if (/^\d+(\.\d+)?(km|公里|米|m)$/i.test(compact)) {
            return true;
        }
        if (/^[¥￥]?\d+(\.\d+)?(\/?度|元|\/)?$/.test(compact)) {
            return true;
        }
        return false;
    }

    isNonStationChargingText(text) {
        const compact = String(text || '').replace(/\s+/g, '');
        return /充电余额|可用充电|免费充电|充电订单|充电会员|会员价|充电须知|充电费用|开始充电|补充车辆|解锁|福利|活动|优惠|奖励|收藏|搜索附近|即插即充|即播即充/.test(compact);
    }

    hasStrongStationNamePattern(text) {
        const compact = String(text || '').replace(/\s+/g, '');
        return this.stationTitleKeywords.some(keyword => compact.includes(keyword))
            || /(小桔|万马爱充|特来电|星星充电|云快充|新电途|开迈斯|国家电网|南方电网|蔚来|小鹏|理想|特斯拉|玖桔|驴充充|依威|全日充|能链|bp\s*pulse|bppulse).*(站|中心|广场|大厦|车库)/i.test(compact)
            || /(超快充|超级充电|智能充电|来充电|蔚来超充|小鹏超充|小鹏S4超快充|bp\s*pulse快充|bppulse快充).*(站|中心|广场|大厦|车库)/i.test(compact);
    }

    hasLocationStationNamePattern(text) {
        const compact = String(text || '').replace(/\s+/g, '');
        return /(站|出发层|到达层|停车场|车库|广场|中心|园区|大厦|天地|机场|枢纽)/.test(compact)
            && !/(搜索|附近|地图|登录|立即登录|加载更多|首页|我的)/.test(compact);
    }

    /**
     * 提取枪数
     */
    extractPorts(texts, combinedText) {
        const result = {
            fastIdle: 0,
            fastTotal: 0,
            slowIdle: 0,
            slowTotal: 0,
            superIdle: 0,
            superTotal: 0
        };

        // 模式：空闲/总数 或 空闲个/总个
        const portPattern = /(\d+)\s*\/\s*(\d+)/;
        const idlePattern = /空闲|可用|闲/;
        const totalPattern = /总|全部/;

        for (const text of texts) {
            const compact = text.replace(/\s+/g, '');

            // 快充
            if (/快充|快/.test(compact)) {
                const match = compact.match(portPattern);
                if (match) {
                    result.fastIdle = Math.max(result.fastIdle, parseInt(match[1], 10));
                    result.fastTotal = Math.max(result.fastTotal, parseInt(match[2], 10));
                }
            }

            // 慢充
            if (/慢充|慢/.test(compact)) {
                const match = compact.match(portPattern);
                if (match) {
                    result.slowIdle = Math.max(result.slowIdle, parseInt(match[1], 10));
                    result.slowTotal = Math.max(result.slowTotal, parseInt(match[2], 10));
                }
            }

            // 超充
            if (/超充|超/.test(compact)) {
                const match = compact.match(portPattern);
                if (match) {
                    result.superIdle = Math.max(result.superIdle, parseInt(match[1], 10));
                    result.superTotal = Math.max(result.superTotal, parseInt(match[2], 10));
                }
            }
        }

        // 如果没有找到分类型的，尝试从整体提取
        if (result.fastTotal === 0 && result.slowTotal === 0 && result.superTotal === 0) {
            const allMatch = combinedText.match(portPattern);
            if (allMatch) {
                result.fastIdle = parseInt(allMatch[1], 10);
                result.fastTotal = parseInt(allMatch[2], 10);
            }
        }

        return result;
    }
}

module.exports = DidiOcrParser;
