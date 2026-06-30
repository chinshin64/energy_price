#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const CONFIG = {
    safeBaseUrl: trimTrailingSlash(process.env.SAFE_GUARDIAN_URL || process.env.GUARDIAN_PUBLIC_BASE_URL || ''),
    localBaseUrl: trimTrailingSlash(process.env.BLUE_TEAM_LOCAL_BASE_URL || process.env.LOCAL_BLUE_TEAM_BASE_URL || 'http://127.0.0.1:50080'),
    token: String(process.env.GUARDIAN_BLUE_TEAM_AGENT_TOKEN || process.env.MOBILE_SYNC_TOKEN || '').trim(),
    authHeader: String(process.env.GUARDIAN_BLUE_TEAM_REMOTE_AUTH_HEADER || 'x-mobile-sync-token').trim(),
    agentId: String(process.env.BLUE_TEAM_AGENT_ID || process.env.AGENT_ID || 'blue-agent-172').trim(),
    pollIntervalMs: positiveInt(process.env.BLUE_TEAM_AGENT_POLL_INTERVAL_MS, 5000),
    realtimeSyncIntervalMs: positiveInt(process.env.BLUE_TEAM_AGENT_REALTIME_SYNC_INTERVAL_MS, 30000),
    reportLimit: positiveInt(process.env.BLUE_TEAM_AGENT_REPORT_LIMIT, 100),
    requestTimeoutMs: positiveInt(process.env.BLUE_TEAM_AGENT_REQUEST_TIMEOUT_MS, 15000),
    statePath: process.env.BLUE_TEAM_AGENT_STATE_PATH || path.join(__dirname, '../data/safe-guardian-agent-state.json'),
};

function trimTrailingSlash(value) {
    return String(value || '').trim().replace(/\/+$/, '');
}

function positiveInt(value, fallback) {
    const num = Number(value);
    return Number.isFinite(num) && num > 0 ? Math.floor(num) : fallback;
}

function requireConfig() {
    const missing = [];
    if (!CONFIG.safeBaseUrl) missing.push('SAFE_GUARDIAN_URL');
    if (!CONFIG.localBaseUrl) missing.push('BLUE_TEAM_LOCAL_BASE_URL');
    if (!CONFIG.token) missing.push('GUARDIAN_BLUE_TEAM_AGENT_TOKEN');
    if (missing.length) throw new Error(`missing required env: ${missing.join(', ')}`);
}

function loadState() {
    try {
        return JSON.parse(fs.readFileSync(CONFIG.statePath, 'utf8'));
    } catch {
        return { lastEventId: '0', lastAutoSyncedAt: '', importedReports: {} };
    }
}

function saveState(state) {
    fs.mkdirSync(path.dirname(CONFIG.statePath), { recursive: true });
    fs.writeFileSync(CONFIG.statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function authHeaders(extra = {}) {
    return {
        [CONFIG.authHeader]: CONFIG.token,
        'x-blue-team-agent-id': CONFIG.agentId,
        ...extra,
    };
}

async function requestJson(baseUrl, apiPath, options = {}) {
    const target = new URL(apiPath, `${baseUrl}/`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CONFIG.requestTimeoutMs);
    const headers = {
        Accept: 'application/json',
        ...(options.headers || {}),
    };
    const requestOptions = {
        method: options.method || 'GET',
        headers,
        signal: controller.signal,
    };
    if (options.body !== undefined) {
        headers['Content-Type'] = 'application/json';
        requestOptions.body = JSON.stringify(options.body);
    }
    try {
        const response = await fetch(target, requestOptions);
        const text = await response.text();
        let payload;
        try {
            payload = text ? JSON.parse(text) : {};
        } catch {
            payload = { success: false, raw: text };
        }
        if (!response.ok || payload.success === false) {
            const error = new Error(payload.error || `HTTP ${response.status}`);
            error.statusCode = response.status;
            error.payload = payload;
            throw error;
        }
        return payload;
    } finally {
        clearTimeout(timeout);
    }
}

async function requestText(baseUrl, apiPath) {
    const target = new URL(apiPath, `${baseUrl}/`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CONFIG.requestTimeoutMs);
    try {
        const response = await fetch(target, { signal: controller.signal });
        const text = await response.text();
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
        return text;
    } finally {
        clearTimeout(timeout);
    }
}

function unwrap(payload) {
    if (payload && payload.success === true && payload.data !== undefined) return payload.data;
    return payload;
}

async function heartbeat() {
    return requestJson(CONFIG.safeBaseUrl, '/api/blue-team/agent/heartbeat', {
        method: 'POST',
        headers: authHeaders(),
        body: {
            agentId: CONFIG.agentId,
            sourceHost: CONFIG.localBaseUrl.replace(/^https?:\/\//, ''),
            version: 'blue-team-safe-guardian-agent/v1',
            status: 'online',
            meta: {
                pollIntervalMs: CONFIG.pollIntervalMs,
                realtimeSyncIntervalMs: CONFIG.realtimeSyncIntervalMs,
            },
        },
    });
}

async function pollTasks() {
    const payload = await requestJson(CONFIG.safeBaseUrl, '/api/blue-team/agent/tasks/poll', {
        method: 'POST',
        headers: authHeaders(),
        body: {
            agentId: CONFIG.agentId,
            sourceHost: CONFIG.localBaseUrl.replace(/^https?:\/\//, ''),
            limit: 5,
        },
    });
    return unwrap(payload).tasks || [];
}

async function reportTaskResult(taskId, status, result = null, error = null) {
    return requestJson(CONFIG.safeBaseUrl, `/api/blue-team/agent/tasks/${encodeURIComponent(taskId)}/result`, {
        method: 'POST',
        headers: authHeaders(),
        body: {
            agentId: CONFIG.agentId,
            sourceHost: CONFIG.localBaseUrl.replace(/^https?:\/\//, ''),
            status,
            result,
            error,
        },
    });
}

async function importReports(reports) {
    if (!reports.length) return { imported: [], failed: [] };
    const payload = await requestJson(CONFIG.safeBaseUrl, '/api/blue-team/agent/reports/import', {
        method: 'POST',
        headers: authHeaders(),
        body: {
            agentId: CONFIG.agentId,
            sourceHost: CONFIG.localBaseUrl.replace(/^https?:\/\//, ''),
            reports,
        },
    });
    return unwrap(payload);
}

function normalizeReportList(payload) {
    const data = unwrap(payload);
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.data)) return data.data;
    if (data && Array.isArray(data.reports)) return data.reports;
    return [];
}

async function exportReports(limit, reportIds = []) {
    try {
        const payload = await requestJson(CONFIG.localBaseUrl, '/api/blue-team/reports/export', {
            method: 'POST',
            body: { limit, reportIds, sanitize: false },
        });
        const exported = unwrap(payload) || {};
        return Array.isArray(exported.reports) ? exported.reports : [];
    } catch (error) {
        log('warn', `batch export unavailable, fallback to list/detail: ${error.message}`);
    }

    const listPayload = await requestJson(CONFIG.localBaseUrl, `/api/blue-team/reports?limit=${limit}`);
    const list = normalizeReportList(listPayload);
    const ids = reportIds.length ? reportIds : list.map(item => item.reportId || item.id).filter(Boolean).slice(0, limit);
    const byId = new Map(list.map(item => [item.reportId || item.id, item]).filter(([id]) => id));
    const reports = [];
    for (const reportId of ids) {
        const detailPayload = await requestJson(CONFIG.localBaseUrl, `/api/blue-team/reports/${encodeURIComponent(reportId)}?sanitize=false`);
        const detail = unwrap(detailPayload);
        let markdown = '';
        try {
            markdown = await requestText(CONFIG.localBaseUrl, `/api/blue-team/reports/${encodeURIComponent(reportId)}/download?format=markdown&sanitize=false`);
        } catch (error) {
            log('warn', `markdown fallback failed for ${reportId}: ${error.message}`);
        }
        reports.push({ summary: byId.get(reportId) || { reportId }, report: detail, markdown });
    }
    return reports;
}

async function exportReportsByEvents(state) {
    if (!state.lastEventId) return [];
    try {
        const payload = await requestJson(CONFIG.localBaseUrl, `/api/blue-team/reports/events?after=${encodeURIComponent(state.lastEventId)}`);
        const data = unwrap(payload) || {};
        const events = Array.isArray(data.events) ? data.events : [];
        if (!events.length) return [];
        const reportIds = [...new Set(events.map(item => item.reportId || item.id).filter(Boolean))];
        if (data.lastEventId) state.lastEventId = data.lastEventId;
        return exportReports(Math.min(CONFIG.reportLimit, reportIds.length || CONFIG.reportLimit), reportIds);
    } catch (error) {
        log('debug', `events endpoint unavailable: ${error.message}`);
        return [];
    }
}

function filterChangedReports(state, reports) {
    if (!state.importedReports || typeof state.importedReports !== 'object') state.importedReports = {};
    const changed = [];
    for (const item of reports) {
        const report = item.report || item.detail || item;
        const summary = item.summary || {};
        const reportId = report.reportId || report.id || summary.reportId || summary.id;
        if (!reportId) continue;
        const version = report.version || report.updatedAt || report.finishedAt || summary.updatedAt || summary.syncedAt || JSON.stringify(report).length;
        if (state.importedReports[reportId] === version) continue;
        state.importedReports[reportId] = version;
        changed.push(item);
    }
    return changed;
}

async function syncReports(payload = {}, state = loadState()) {
    const reportIds = Array.isArray(payload.reportIds) ? payload.reportIds.filter(Boolean) : [];
    const limit = positiveInt(payload.limit, CONFIG.reportLimit);
    const reports = reportIds.length ? await exportReports(limit, reportIds) : await exportReports(limit);
    const changed = reportIds.length ? reports : filterChangedReports(state, reports);
    const imported = await importReports(changed);
    saveState(state);
    return {
        requested: reportIds.length || limit,
        exported: reports.length,
        changed: changed.length,
        imported: imported.imported || [],
        failed: imported.failed || [],
    };
}

async function realtimeSync(state) {
    let reports = await exportReportsByEvents(state);
    if (!reports.length) reports = await exportReports(CONFIG.reportLimit);
    const changed = filterChangedReports(state, reports);
    const imported = await importReports(changed);
    state.lastAutoSyncedAt = new Date().toISOString();
    saveState(state);
    if (changed.length || (imported.failed || []).length) {
        log('info', `realtime sync exported=${reports.length} changed=${changed.length} imported=${(imported.imported || []).length} failed=${(imported.failed || []).length}`);
    }
}

async function handleTask(task, state) {
    try {
        if (task.taskType === 'sync-reports') {
            const result = await syncReports(task.payload || {}, state);
            await reportTaskResult(task.id, result.failed.length ? 'failed' : 'completed', result, result.failed.length ? 'some reports failed' : null);
            return;
        }
        await reportTaskResult(task.id, 'failed', null, `unsupported taskType: ${task.taskType}`);
    } catch (error) {
        await reportTaskResult(task.id, 'failed', null, error.message);
    }
}

function log(level, message) {
    const levels = { debug: 10, info: 20, warn: 30, error: 40 };
    const current = levels[String(process.env.BLUE_TEAM_AGENT_LOG_LEVEL || 'info').toLowerCase()] || 20;
    if ((levels[level] || 20) < current) return;
    console.log(`[${new Date().toISOString()}] [${level}] ${message}`);
}

async function main() {
    requireConfig();
    const state = loadState();
    log('info', `agent=${CONFIG.agentId} safe=${CONFIG.safeBaseUrl} local=${CONFIG.localBaseUrl}`);
    let lastRealtimeSyncAt = 0;
    while (true) {
        try {
            await heartbeat();
            const tasks = await pollTasks();
            for (const task of tasks) {
                await handleTask(task, state);
            }
            if (Date.now() - lastRealtimeSyncAt >= CONFIG.realtimeSyncIntervalMs) {
                await realtimeSync(state);
                lastRealtimeSyncAt = Date.now();
            }
        } catch (error) {
            log('error', error.stack || error.message);
        }
        await new Promise(resolve => setTimeout(resolve, CONFIG.pollIntervalMs));
    }
}

main().catch(error => {
    console.error(error.stack || error.message);
    process.exit(1);
});
