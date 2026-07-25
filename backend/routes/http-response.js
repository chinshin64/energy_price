'use strict';

function sendRouteError(req, res, error, options = {}) {
    const statusCode = Number(error?.statusCode || error?.status || options.statusCode || 500);
    return res.status(statusCode).json({
        success: false,
        error: error?.message || options.message || 'Internal server error',
        code: error?.code || options.code || 'internal_error',
        requestId: req.requestId,
    });
}

function sendReasonError(req, res, error, reason, statusCode = 500) {
    return res.status(statusCode).json({
        success: false,
        reason,
        code: reason,
        error: error?.message || String(error || reason),
        requestId: req.requestId,
    });
}

module.exports = { sendReasonError, sendRouteError };
