#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const StationModel = require('../backend/models/station');

const inputPath = process.env.OCR_RESULT_PATH || '/tmp/didi-stations-result.json';

if (!fs.existsSync(inputPath)) {
  console.error(`OCR 结果文件不存在：${inputPath}`);
  process.exit(1);
}

const rawText = fs.readFileSync(inputPath, 'utf8');
let rows;
try {
  rows = JSON.parse(rawText);
} catch (error) {
  console.error(`OCR 结果 JSON 解析失败：${error.message}`);
  process.exit(1);
}

if (!Array.isArray(rows)) {
  console.error('OCR 结果格式错误：根节点必须是数组');
  process.exit(1);
}

function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function toInt(value) {
  const num = Number(value);
  return Number.isFinite(num) ? Math.max(0, Math.floor(num)) : 0;
}

const stations = rows
  .filter(item => item && (item.name || item.stationName))
  .map((item, index) => {
    const fastIdle = toInt(item.fastIdle);
    const fastTotal = toInt(item.fastTotal);
    const slowIdle = toInt(item.slowIdle);
    const slowTotal = toInt(item.slowTotal);
    const superIdle = toInt(item.superIdle);
    const superTotal = toInt(item.superTotal);

    return {
      platform: 'didi-charging',
      stationId: item.stationId || `ocr-${String(item.name || item.stationName).trim()}-${index}`,
      stationName: String(item.name || item.stationName).trim(),
      address: item.address || null,
      latitude: toNumber(item.latitude ?? item.lat),
      longitude: toNumber(item.longitude ?? item.lng),
      priceFast: toNumber(item.price),
      priceSlow: slowTotal > 0 ? toNumber(item.price) : null,
      priceSuper: superTotal > 0 ? toNumber(item.price) : null,
      priceService: null,
      fastIdlePorts: fastIdle,
      fastTotalPorts: fastTotal,
      slowIdlePorts: slowIdle,
      slowTotalPorts: slowTotal,
      superIdlePorts: superIdle,
      superTotalPorts: superTotal,
      onlineFastPorts: fastIdle + superIdle,
      onlineSlowPorts: slowIdle,
      availablePorts: fastIdle + slowIdle + superIdle,
      totalPorts: fastTotal + slowTotal + superTotal,
      sourceType: 'wechat-ocr',
      sourceStage: 'manual-scroll-import',
      raw: {
        ...item,
        source: 'wechat-ocr',
        sourceType: 'wechat-ocr',
        sourceStage: 'manual-scroll-import',
        importedFrom: path.basename(inputPath)
      }
    };
  });

if (stations.length === 0) {
  console.error('OCR 结果中没有可导入的场站');
  process.exit(1);
}

const result = StationModel.insertBatch(stations);
console.log(JSON.stringify({
  success: true,
  inputPath,
  parsedCount: rows.length,
  importCount: stations.length,
  ...result
}, null, 2));
