'use strict';

const express = require('express');
const { Readable, pipeline } = require('node:stream');
const { sendRouteError } = require('./http-response');

function createExportRouter(options = {}) {
    const service = options.service;
    const logger = options.logger || console;
    if (!service) throw new TypeError('service is required');
    const router = express.Router();

    router.get('/csv', (req, res) => {
        let prepared;
        try {
            prepared = service.prepare({ platform: req.query.platform, limit: req.query.limit });
        } catch (error) {
            return sendRouteError(req, res, error, { code: 'station_export_failed' });
        }

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${prepared.filename}"`);
        res.setHeader('X-Export-Total-Rows', String(prepared.totalRows));
        res.setHeader('X-Export-Row-Count', String(prepared.exportRows));
        res.setHeader('X-Export-Truncated', String(prepared.truncated));
        pipeline(Readable.from(prepared.lines), res, error => {
            if (!error) return;
            logger.error(`CSV export stream failed requestId=${req.requestId}: ${error.message}`);
            if (!res.destroyed) res.destroy(error);
        });
        return undefined;
    });

    return router;
}

module.exports = { createExportRouter };
