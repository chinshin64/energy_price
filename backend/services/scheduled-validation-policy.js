'use strict';

const DEFAULT_TASK_TYPE = 'validation';
const DEFAULT_RADIUS_KM = 20;
const MAX_RADIUS_KM = 50;
const MAX_PAGES = 1;
const MAX_REQUEST_COUNT = 5;
const MAX_QPS = 1;

function policyError(code, message, statusCode = 400) {
    const error = new Error(message);
    error.code = code;
    error.statusCode = statusCode;
    return error;
}

function isObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function numberInRange(value, options) {
    const {
        fallback,
        minimum,
        maximum,
        integer = false,
        code,
        message,
    } = options;
    if (value === undefined || value === null || value === '') return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)
        || (integer && !Number.isInteger(parsed))
        || parsed < minimum
        || parsed > maximum) {
        throw policyError(code, message);
    }
    return parsed;
}

function normalizeTaskType(value) {
    const taskType = String(value || DEFAULT_TASK_TYPE).trim().toLowerCase();
    if (taskType !== DEFAULT_TASK_TYPE) {
        throw policyError('schedule_task_type_unsupported', 'taskType must be validation');
    }
    return taskType;
}

function normalizeValidationPayload(rawPayload) {
    if (!isObject(rawPayload)) {
        throw policyError('schedule_payload_invalid', 'payload with a method3 target is required');
    }
    if (String(rawPayload.chain || '').trim().toLowerCase() !== 'method3') {
        throw policyError('schedule_chain_unsupported', 'scheduled execution only supports method3');
    }

    const rawTarget = rawPayload.target;
    if (!isObject(rawTarget)) {
        throw policyError('schedule_target_invalid', 'payload.target is required');
    }
    const city = String(rawTarget.city || '').trim();
    const lat = Number(rawTarget.lat);
    const lng = Number(rawTarget.lng);
    if (!city || city.length > 80 || !Number.isFinite(lat) || !Number.isFinite(lng)
        || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        throw policyError('schedule_target_invalid', 'target city and valid lat/lng are required');
    }

    const coordinateSystem = String(rawTarget.coordinateSystem || 'WGS84').trim().toUpperCase();
    if (!['WGS84', 'GCJ02'].includes(coordinateSystem)) {
        throw policyError(
            'schedule_coordinate_system_invalid',
            'coordinateSystem must be WGS84 or GCJ02'
        );
    }
    const mode = String(rawPayload.mode || 'list').trim().toLowerCase();
    if (!['list', 'detail'].includes(mode)) {
        throw policyError('schedule_mode_invalid', 'mode must be list or detail');
    }

    return {
        chain: 'method3',
        mode,
        target: {
            city,
            lat,
            lng,
            coordinateSystem,
            radiusKm: numberInRange(rawTarget.radiusKm, {
                fallback: DEFAULT_RADIUS_KM,
                minimum: 1,
                maximum: MAX_RADIUS_KM,
                code: 'schedule_radius_invalid',
                message: `target.radiusKm must be between 1 and ${MAX_RADIUS_KM}`,
            }),
        },
        maxPages: numberInRange(rawPayload.maxPages, {
            fallback: MAX_PAGES,
            minimum: 1,
            maximum: MAX_PAGES,
            integer: true,
            code: 'schedule_max_pages_invalid',
            message: `maxPages must be ${MAX_PAGES}`,
        }),
        maxRequestCount: numberInRange(rawPayload.maxRequestCount, {
            fallback: MAX_REQUEST_COUNT,
            minimum: 1,
            maximum: MAX_REQUEST_COUNT,
            integer: true,
            code: 'schedule_request_limit_invalid',
            message: `maxRequestCount must be an integer between 1 and ${MAX_REQUEST_COUNT}`,
        }),
        maxQps: numberInRange(rawPayload.maxQps, {
            fallback: MAX_QPS,
            minimum: 0.1,
            maximum: MAX_QPS,
            code: 'schedule_qps_invalid',
            message: `maxQps must be between 0.1 and ${MAX_QPS}`,
        }),
    };
}

function normalizeExecutableSchedule(schedule = {}) {
    const platforms = Array.isArray(schedule.platforms)
        ? Array.from(new Set(schedule.platforms.map(value => String(value || '').trim()).filter(Boolean)))
        : [];
    if (platforms.length === 0 || platforms.length > 20) {
        throw policyError(
            'schedule_platforms_invalid',
            'scheduled validation must contain between 1 and 20 platforms'
        );
    }
    return {
        ...schedule,
        taskType: normalizeTaskType(schedule.taskType),
        platforms,
        payload: normalizeValidationPayload(schedule.payload),
    };
}

module.exports = {
    DEFAULT_RADIUS_KM,
    DEFAULT_TASK_TYPE,
    MAX_PAGES,
    MAX_QPS,
    MAX_RADIUS_KM,
    MAX_REQUEST_COUNT,
    normalizeExecutableSchedule,
    normalizeTaskType,
    normalizeValidationPayload,
    policyError,
};
