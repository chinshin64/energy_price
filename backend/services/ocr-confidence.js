'use strict';

const path = require('path');
const fs = require('fs');
const { resolveDataRoot } = require('../config/runtime');
const FuelOcrConfidence = require('./fuel-ocr-confidence');

const dataRoot = resolveDataRoot(path.resolve(__dirname, '../..'), process.env.DATA_ROOT);

// ── 来源信任层级 ──
const SOURCE_TRUST = { manual: 100, 'api-curated': 80, 'mobile-ocr': 40 };

// ── 营销关键词（触发红灯） ──
const MARKETING_KEYWORDS = ['券', '优惠', '活动', '已减', '可用'];

// ── 场站名合法关键词 ──
const STATION_NAME_KEYWORDS = ['充电站', '充电中心', '超充站', '充电桩', '换电站', '加电站', '服务站', '充电场站', '超充中心'];

// ── 行政区划关键词 ──
const ADMIN_REGION_KEYWORDS = [
    '省', '市', '区', '县', '镇', '乡', '街', '路', '道',
    '自治州', '自治区', '特别行政区', '新区', '开发区', '高新区'
];

// ── 乱码字符正则：日文片假名/平假名 + 非常见Unicode ──
const GARBAGE_CHAR_RE = /[\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF\u0400-\u04FF\u0600-\u06FF]/;

// ── 维度权重 ──
const DIMENSION_WEIGHTS = {
    stationNameNorm: 0.30,
    priceReasonability: 0.25,
    portConsistency: 0.15,
    ocrConfidence: 0.15,
    addressCompleteness: 0.15
};
const STANDALONE_ANDROID_NO_ADDRESS_WEIGHTS = {
    stationNameNorm: 0.30,
    priceReasonability: 0.325,
    portConsistency: 0.225,
    ocrConfidence: 0.15
};
const STANDALONE_ANDROID_AGENTS = new Set(['android-ocr-agent', 'standalone-android-ocr']);

// ── 阈值 ──
const THRESHOLD = { green: 80, yellow: 60 };

/**
 * 对单条站场数据执行置信度评估
 * @param {Object} data - 站场数据（与 station model 字段对应）
 * @returns {{ score: number, light: 'green'|'yellow'|'red', dimensions: Object, hardRules: string[], sourceTrust: number }}
 */
function evaluate(data = {}) {
    if (String(data.stationType || data.station_type || '').trim() === 'fuel') {
        return FuelOcrConfidence.evaluateFuel(data);
    }
    const hardRules = [];
    const dimensions = {};

    // ── 提取基础字段 ──
    const name = String(data.stationName || data.station_name || '').trim();
    const address = String(data.address || '').trim();
    const totalPorts = Number(data.totalPorts ?? data.total_ports ?? 0);
    const availablePorts = Number(data.availablePorts ?? data.available_ports ?? 0);
    const priceFast = Number(data.priceFast ?? data.price_fast ?? NaN);
    const priceSlow = Number(data.priceSlow ?? data.price_slow ?? NaN);
    const priceSuper = Number(data.priceSuper ?? data.price_super ?? NaN);
    const priceService = Number(data.priceService ?? data.price_service ?? NaN);
    const confidence = Number(data.confidence ?? data.raw?.confidence ?? 0.5);
    const sourceType = String(data.sourceType || data.source_type || data.raw?.sourceType || 'mobile-ocr').trim();
    const sourceAgent = String(
        data.sourceAgent
        || data.source_agent
        || data.raw?.sourceAgent
        || data.raw?.mobileSync?.meta?.sourceAgent
        || ''
    ).trim().toLowerCase();
    const standaloneAndroidWithoutAddress = sourceType === 'mobile-ocr'
        && STANDALONE_ANDROID_AGENTS.has(sourceAgent)
        && !address;

    // ── 硬规则1：营销词红灯 ──
    const hitMarketing = MARKETING_KEYWORDS.find(kw => name.includes(kw));
    if (hitMarketing) {
        hardRules.push('marketing_keyword:' + hitMarketing);
    }

    // ── 硬规则2：乱码字符红灯 ──
    if (GARBAGE_CHAR_RE.test(name)) {
        hardRules.push('garbage_chars');
    }

    // ── 硬规则3：无枪数无价格红灯 ──
    const hasAnyPrice = [priceFast, priceSlow, priceSuper, priceService].some(v => Number.isFinite(v) && v > 0);
    if (totalPorts === 0 && !hasAnyPrice) {
        hardRules.push('no_ports_no_price');
    }

    // ── 硬规则4：价格离谱红灯 ──
    const priceFields = [
        ['price_fast', priceFast],
        ['price_slow', priceSlow],
        ['price_super', priceSuper]
    ];
    for (const [label, val] of priceFields) {
        if (Number.isFinite(val) && val > 0 && (val > 5 || val < 0.1)) {
            hardRules.push('price_out_of_range:' + label + '=' + val);
        }
    }
    if (Number.isFinite(priceService) && priceService < 0) {
        hardRules.push('price_out_of_range:price_service=' + priceService);
    }

    // ── 有硬规则 → 直接红灯 ──
    if (hardRules.length > 0) {
        return {
            score: 0,
            light: 'red',
            dimensions: {},
            hardRules,
            sourceTrust: SOURCE_TRUST[sourceType] ?? SOURCE_TRUST['mobile-ocr']
        };
    }

    // ── 维度1：场站名规范性 (30%) ──
    if (!name) {
        dimensions.stationNameNorm = 0;
    } else if (STATION_NAME_KEYWORDS.some(kw => name.includes(kw))) {
        dimensions.stationNameNorm = 100;
    } else if (name.length >= 2) {
        dimensions.stationNameNorm = 50;
    } else {
        dimensions.stationNameNorm = 20;
    }

    // ── 维度2：价格合理性 (25%) ──
    const validPrices = [priceFast, priceSlow, priceSuper].filter(v => Number.isFinite(v) && v > 0);
    const validServiceFee = Number.isFinite(priceService) && priceService >= 0 ? priceService : null;

    if (validPrices.length === 0 && validServiceFee === null) {
        dimensions.priceReasonability = 30;
    } else {
        let priceScore = 0;
        let priceCount = 0;
        for (const p of validPrices) {
            priceCount++;
            if (p >= 0.3 && p <= 3.0) {
                priceScore += 100;
            } else if (p >= 0.1 && p <= 5.0) {
                priceScore += 50;
            } else {
                priceScore += 0;
            }
        }
        if (validServiceFee !== null) {
            priceCount++;
            if (validServiceFee >= 0 && validServiceFee <= 2.0) {
                priceScore += 100;
            } else if (validServiceFee <= 3.0) {
                priceScore += 50;
            } else {
                priceScore += 0;
            }
        }
        dimensions.priceReasonability = priceCount > 0 ? Math.round(priceScore / priceCount) : 30;
    }

    // ── 维度3：枪数一致性 (15%) ──
    if (totalPorts <= 0) {
        dimensions.portConsistency = 20;
    } else if (availablePorts <= totalPorts && availablePorts >= 0) {
        dimensions.portConsistency = 100;
    } else {
        dimensions.portConsistency = 30;
    }

    // ── 维度4：OCR置信度 (15%) ──
    const clampedConf = Math.max(0, Math.min(1, Number.isFinite(confidence) ? confidence : 0.5));
    dimensions.ocrConfidence = Math.round(clampedConf * 100);

    // ── 维度5：地址完整性 (15%) ──
    if (standaloneAndroidWithoutAddress) {
        dimensions.addressCompleteness = null;
    } else if (!address) {
        dimensions.addressCompleteness = 0;
    } else if (ADMIN_REGION_KEYWORDS.some(kw => address.includes(kw))) {
        dimensions.addressCompleteness = 100;
    } else if (address.length >= 4) {
        dimensions.addressCompleteness = 50;
    } else {
        dimensions.addressCompleteness = 20;
    }

    // ── 加权总分 ──
    let score = 0;
    const appliedWeights = standaloneAndroidWithoutAddress
        ? STANDALONE_ANDROID_NO_ADDRESS_WEIGHTS
        : DIMENSION_WEIGHTS;
    for (const [dim, weight] of Object.entries(appliedWeights)) {
        score += (dimensions[dim] || 0) * weight;
    }
    score = Math.round(score);
    const hasPorts = totalPorts > 0;
    if (standaloneAndroidWithoutAddress && hasAnyPrice !== hasPorts) {
        score = Math.min(score, THRESHOLD.green - 1);
    }

    const light = score >= THRESHOLD.green ? 'green'
        : score >= THRESHOLD.yellow ? 'yellow'
        : 'red';

    return {
        score,
        light,
        dimensions,
        hardRules: [],
        sourceTrust: SOURCE_TRUST[sourceType] ?? SOURCE_TRUST['mobile-ocr'],
        weightPolicy: standaloneAndroidWithoutAddress ? 'standalone-android-no-address' : 'default'
    };
}

/**
 * merge 时低信任源不覆盖高信任源
 * @param {number} existingTrust - 已有记录信任分
 * @param {number} incomingTrust - 新记录信任分
 * @param {*} existingValue - 已有字段值
 * @param {*} incomingValue - 新字段值
 * @returns {*} 应采用的值
 */
function trustMerge(existingTrust, incomingTrust, existingValue, incomingValue) {
    const hasExisting = existingValue !== null && existingValue !== undefined && existingValue !== '';
    const hasIncoming = incomingValue !== null && incomingValue !== undefined && incomingValue !== '';
    if (!hasIncoming) return existingValue;
    if (!hasExisting) return incomingValue;
    if (incomingTrust >= existingTrust) return incomingValue;
    return existingValue;
}

/**
 * 写入红灯拦截日志到 data/ocr-rejected/
 * @param {Object} data - 原始数据
 * @param {Object} result - evaluate() 返回结果
 */
function writeRejectedLog(data, result) {
    const rejectedDir = path.join(dataRoot, 'ocr-rejected');
    if (!fs.existsSync(rejectedDir)) {
        fs.mkdirSync(rejectedDir, { recursive: true });
    }

    const dateStr = new Date().toISOString().slice(0, 10);
    const logFile = path.join(rejectedDir, dateStr + '.jsonl');
    const entry = {
        timestamp: new Date().toISOString(),
        score: result.score,
        light: result.light,
        hardRules: result.hardRules,
        dimensions: result.dimensions,
        stationName: data.stationName || data.station_name || null,
        stationId: data.stationId || data.station_id || null,
        platform: data.platform || null,
        address: data.address || null,
        raw: data.raw || null
    };

    try {
        fs.appendFileSync(logFile, JSON.stringify(entry) + '\n', 'utf8');
    } catch (err) {
        console.error('写入红灯日志失败:', err.message);
    }
}

/**
 * 批量评估 + 分流
 * @param {Array} dataArray - 站场数据数组
 * @returns {{ green: Array, yellow: Array, red: Array, results: Array }}
 */
function batchEvaluate(dataArray = []) {
    const green = [];
    const yellow = [];
    const red = [];
    const results = [];

    for (const data of dataArray) {
        const result = evaluate(data);
        results.push({ data, result });

        if (result.light === 'red') {
            red.push(data);
            writeRejectedLog(data, result);
        } else if (result.light === 'yellow') {
            data._confidenceResult = result;
            yellow.push(data);
        } else {
            data._confidenceResult = result;
            green.push(data);
        }
    }

    return { green, yellow, red, results };
}

module.exports = {
    evaluate,
    batchEvaluate,
    trustMerge,
    writeRejectedLog,
    SOURCE_TRUST,
    DIMENSION_WEIGHTS,
    STANDALONE_ANDROID_NO_ADDRESS_WEIGHTS,
    STANDALONE_ANDROID_AGENTS,
    THRESHOLD,
    MARKETING_KEYWORDS,
    STATION_NAME_KEYWORDS,
    ADMIN_REGION_KEYWORDS,
    GARBAGE_CHAR_RE
};
