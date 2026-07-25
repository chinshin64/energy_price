'use strict';

const express = require('express');
const { sendRouteError } = require('./http-response');

function createGeocodeRouter(options = {}) {
    const service = options.service;
    if (!service) throw new TypeError('service is required');
    const router = express.Router();

    router.get('/search', async (req, res) => {
        const keyword = typeof req.query.q === 'string' ? req.query.q.trim() : '';
        if (!keyword || keyword.length > 200) {
            return res.status(400).json({
                success: false,
                error: keyword ? 'q must not exceed 200 characters' : 'q required',
                code: keyword ? 'geocode_query_too_long' : 'geocode_query_required',
                requestId: req.requestId,
                data: [],
            });
        }
        try {
            const data = await service.search(keyword);
            return res.json({
                success: data.length > 0,
                data,
                error: data.length > 0 ? null : '未找到位置；如需全国街道级检索，请配置 AMAP_WEB_SERVICE_KEY',
            });
        } catch (error) {
            return sendRouteError(req, res, error, { code: 'geocode_search_failed' });
        }
    });

    return router;
}

module.exports = { createGeocodeRouter };
