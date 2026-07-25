'use strict';

const express = require('express');
const { sendRouteError } = require('./http-response');

function positiveTemplateId(value) {
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id <= 0) {
        const error = new Error('template id must be a positive integer');
        error.code = 'template_id_invalid';
        error.statusCode = 400;
        throw error;
    }
    return id;
}

function createTemplatesRouter(options = {}) {
    const service = options.service;
    if (!service) throw new TypeError('service is required');
    const router = express.Router();

    router.post('/', (req, res) => {
        try {
            const result = service.create(req.body || {});
            res.json({
                success: true,
                message: result.skipped ? '模板样本已达到上限，本次未写入' : '模板保存成功',
                ...result,
            });
        } catch (error) {
            sendRouteError(req, res, error, { code: 'template_create_failed' });
        }
    });

    router.post('/batch', (req, res) => {
        try {
            const result = service.createBatch(req.body || {});
            res.json({
                success: true,
                message: `成功保存 ${result.successCount} 个模板`,
                count: result.successCount,
                data: result,
            });
        } catch (error) {
            sendRouteError(req, res, error, { code: 'template_batch_create_failed' });
        }
    });

    router.get('/', (req, res) => {
        try {
            res.json({ success: true, data: service.list() });
        } catch (error) {
            sendRouteError(req, res, error, { code: 'template_query_failed' });
        }
    });

    router.post('/deduplicate', (req, res) => {
        try {
            const result = service.deduplicate(req.body || {}, req.query || {});
            const actionText = result.dryRun ? '预览' : '清理';
            res.json({
                success: true,
                message: `${actionText}完成：共删除 ${result.removedCount} 条重复模板，重复组 ${result.duplicateGroupCount} 个`,
                data: result,
            });
        } catch (error) {
            sendRouteError(req, res, error, { code: 'template_deduplicate_failed' });
        }
    });

    // Fixed segments must precede /:id to avoid treating "platform" as an ID.
    router.get('/platform/:platform', (req, res) => {
        try {
            res.json({ success: true, data: service.listByPlatform(req.params.platform) });
        } catch (error) {
            sendRouteError(req, res, error, { code: 'template_platform_query_failed' });
        }
    });

    router.get('/:id', (req, res) => {
        try {
            const template = service.get(positiveTemplateId(req.params.id));
            if (!template) {
                return res.status(404).json({
                    success: false,
                    error: 'Template not found',
                    code: 'template_not_found',
                    requestId: req.requestId,
                });
            }
            return res.json({ success: true, data: template });
        } catch (error) {
            return sendRouteError(req, res, error, { code: 'template_query_failed' });
        }
    });

    router.put('/:id', (req, res) => {
        try {
            const result = service.update(positiveTemplateId(req.params.id), req.body || {});
            res.json({ success: true, message: '模板更新成功', changes: result.changes });
        } catch (error) {
            sendRouteError(req, res, error, { code: 'template_update_failed' });
        }
    });

    router.delete('/:id', (req, res) => {
        try {
            service.delete(positiveTemplateId(req.params.id));
            res.json({ success: true, message: '模板删除成功' });
        } catch (error) {
            sendRouteError(req, res, error, { code: 'template_delete_failed' });
        }
    });

    router.post('/:id/use', async (req, res) => {
        try {
            const data = await service.use(positiveTemplateId(req.params.id), req.body || {});
            res.json({
                success: true,
                message: `爬取成功，获取 ${data.stationCount} 个场站`,
                ...data,
            });
        } catch (error) {
            if (error.statusCode === 429) {
                return res.status(429).json({
                    success: false,
                    error: error.message,
                    code: error.code,
                    requestId: req.requestId,
                    runQuota: error.runQuota || null,
                    quotaStats: error.quotaStats || null,
                });
            }
            return sendRouteError(req, res, error, { code: 'template_execution_failed' });
        }
    });

    return router;
}

module.exports = { createTemplatesRouter, positiveTemplateId };
