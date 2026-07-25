'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

function sanitizeFilename(name) {
    const raw = String(name || '').trim();
    if (!raw || raw !== path.basename(raw) || raw.includes('..') || raw.length > 255) return null;
    if (!/^[a-zA-Z0-9._-]+$/.test(raw)) return null;
    return raw;
}

function validateHarUpload(filename, content) {
    const safeFilename = sanitizeFilename(filename);
    if (!safeFilename || !['.har', '.json'].includes(path.extname(safeFilename).toLowerCase())) {
        const error = new Error('HAR upload filename must use .har or .json');
        error.statusCode = 400;
        error.code = 'invalid_har_filename';
        throw error;
    }
    if (typeof content !== 'string' || !content.trim()) {
        const error = new Error('HAR upload content must be a non-empty string');
        error.statusCode = 400;
        error.code = 'invalid_har_content';
        throw error;
    }
    return safeFilename;
}

function isPathUnderRoot(root, inputPath) {
    const resolved = path.resolve(inputPath);
    return resolved.startsWith(root + path.sep) || resolved === root;
}

function createHarWorkflowRouter(options = {}) {
    const dataRoot = path.resolve(options.dataRoot || 'data');
    const harParser = options.harParser;
    const stationModel = options.stationModel;
    const smartCrawler = options.smartCrawler;
    const runHistoryModel = options.runHistoryModel;
    const apiTemplateModel = options.apiTemplateModel;
    const redactObject = typeof options.redactObject === 'function' ? options.redactObject : value => value;
    const logger = options.logger || console;

    if (!harParser || !stationModel || !smartCrawler || !runHistoryModel || !apiTemplateModel) {
        throw new TypeError('har workflow router dependencies are required');
    }

    const router = express.Router();

    function ensureDataPath(filePath, fieldName) {
        if (!filePath) {
            const error = new Error(`${fieldName} required`);
            error.statusCode = 400;
            throw error;
        }
        if (!isPathUnderRoot(dataRoot, filePath)) {
            const error = new Error(`${fieldName} must be under data/ directory`);
            error.statusCode = 403;
            throw error;
        }
        return filePath;
    }

    function writeTempFile(prefix, safeFilename, content) {
        const tempDir = path.join(dataRoot, 'temp');
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true, mode: 0o700 });
        }
        const tempFile = path.join(tempDir, `${prefix}-${crypto.randomUUID()}-${safeFilename}`);
        fs.writeFileSync(tempFile, content, { encoding: 'utf8', mode: 0o600 });
        return tempFile;
    }

    router.post('/parse-har', async (req, res) => {
        try {
            const filePath = ensureDataPath(req.body?.filePath, 'filePath');
            const stations = await harParser.parseSessionFile(filePath);
            if (stations.length > 0) {
                stationModel.insertBatch(stations);
            }
            res.json({
                success: true,
                message: `Parsed ${stations.length} stations`,
                data: stations
            });
        } catch (error) {
            res.status(error.statusCode || 500).json({ success: false, error: error.message, code: error.code });
        }
    });

    router.post('/parse-har-upload', async (req, res) => {
        let tempFile = null;
        try {
            const safeFilename = validateHarUpload(req.body?.filename, req.body?.content);
            tempFile = writeTempFile('upload', safeFilename, req.body.content);
            const stations = await harParser.parseSessionFile(tempFile);
            if (stations.length > 0) {
                stationModel.insertBatch(stations);
            }
            res.json({
                success: true,
                message: `解析成功，找到 ${stations.length} 个场站`,
                stationCount: stations.length,
                data: redactObject(stations)
            });
        } catch (error) {
            logger.error?.('解析上传文件失败:', error);
            res.status(error.statusCode || 500).json({ success: false, error: error.message, code: error.code });
        } finally {
            if (tempFile && fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
        }
    });

    router.post('/crawler/learn', async (req, res) => {
        try {
            const harFilePath = ensureDataPath(req.body?.harFilePath, 'harFilePath');
            const patterns = await smartCrawler.learnFromHAR(harFilePath);
            res.json({
                success: true,
                message: `学习到 ${patterns.length} 个 API 模式`,
                patterns: patterns.map(pattern => ({
                    platform: pattern.platform,
                    method: pattern.method,
                    baseUrl: pattern.baseUrl,
                    templateScope: pattern.templateScope || 'list',
                    variableParams: Object.keys(pattern.variableParams || {})
                }))
            });
        } catch (error) {
            logger.error?.('学习失败:', error);
            res.status(error.statusCode || 500).json({ success: false, error: error.message, code: error.code });
        }
    });

    router.post('/crawler/learn-upload', async (req, res) => {
        let safeFilename;
        try {
            safeFilename = validateHarUpload(req.body?.filename, req.body?.content);
        } catch (error) {
            return res.status(error.statusCode || 400).json({ success: false, error: error.message, code: error.code });
        }

        const runId = runHistoryModel.startRun('learn-upload', {
            filename: safeFilename,
            contentLength: req.body.content.length
        });
        let tempFile = null;
        try {
            runHistoryModel.appendLog(runId, `开始学习 HAR: ${safeFilename}`);
            tempFile = writeTempFile('learn', safeFilename, req.body.content);
            const patterns = await smartCrawler.learnFromHAR(tempFile);
            runHistoryModel.appendLog(runId, `学习完成，识别模板 ${patterns.length} 条`);
            runHistoryModel.finishRun(runId, 'success', { patternCount: patterns.length });
            res.json({
                success: true,
                message: `学习到 ${patterns.length} 个 API 模式`,
                patterns: apiTemplateModel.publicTemplates(patterns)
            });
        } catch (error) {
            logger.error?.('学习失败:', error);
            runHistoryModel.appendLog(runId, `HAR 学习失败: ${error.message}`, 'error');
            runHistoryModel.finishRun(runId, 'failed', null, error.message);
            res.status(500).json({ success: false, error: error.message });
        } finally {
            if (tempFile && fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
        }
    });

    return router;
}

module.exports = {
    createHarWorkflowRouter,
    isPathUnderRoot,
    sanitizeFilename,
    validateHarUpload
};
