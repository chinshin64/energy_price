const EventEmitter = require('events');

class SmartCollectionController extends EventEmitter {
    constructor(config = {}, realtimeCapture = null, harParser = null, options = {}) {
        super();
        this.config = config;
        this.realtimeCapture = realtimeCapture;
        this.harParser = harParser;
        this.options = options;
        this.sessions = new Map();
    }

    getScrollProfile(miniProgram = {}) {
        const defaults = { xRatio: 0.5, startYRatio: 0.72, endYRatio: 0.28, durationMs: 650 };
        return miniProgram.scrollProfile || defaults;
    }

    async switchCityWithLiveOcr(_session, _miniProgram, cityName) {
        const error = new Error(`switchCityWithLiveOcr is unavailable in the lightweight package. Use POST /api/method1/actions/switch-city for UI-verified city switching: ${cityName}`);
        error.reason = 'smart_controller_unavailable';
        throw error;
    }

    async runAutomationPreflight(platforms = [], options = {}) {
        return {
            success: true,
            mode: 'preflight-only',
            platforms,
            options,
            message: 'Legacy smart automation preflight is unavailable in this package. Use method1/method2/method3 independent chain APIs.'
        };
    }

    async startSmartSession(platforms = [], options = {}) {
        const session = this.createSession('smart-collect', platforms, options);
        return { success: true, sessionId: session.id, data: session, message: 'Session created in lightweight compatibility mode.' };
    }

    async startPageOcrSession(platforms = [], options = {}) {
        const session = this.createSession('page-ocr', platforms, options);
        return { success: true, sessionId: session.id, data: session, message: 'Page OCR session created in lightweight compatibility mode.' };
    }

    async performAutoScroll(sessionId, scrollCount = 1, scrollInterval = 2) {
        const session = this.getSession(sessionId);
        if (!session) return { success: false, reason: 'session_not_found' };
        session.logs.push({ at: new Date().toISOString(), level: 'warn', message: 'Legacy auto scroll is unavailable; use /api/method1/actions/scroll or run-adaptive.' });
        return { success: false, reason: 'legacy_auto_scroll_unavailable', scrollCount, scrollInterval };
    }

    getSession(sessionId) {
        return this.sessions.get(sessionId) || null;
    }

    getActiveSessions() {
        return Array.from(this.sessions.values());
    }

    cancelSession(sessionId) {
        const session = this.getSession(sessionId);
        if (!session) return { success: false, reason: 'session_not_found' };
        session.status = 'cancelled';
        session.updatedAt = new Date().toISOString();
        return { success: true, data: session };
    }

    requestFinishSession(sessionId) {
        const session = this.getSession(sessionId);
        if (!session) return { success: false, reason: 'session_not_found' };
        session.status = 'finished';
        session.updatedAt = new Date().toISOString();
        return { success: true, data: session };
    }

    attachCaptureSession(sessionId, captureSession) {
        const session = this.getSession(sessionId);
        if (session) session.captureSession = captureSession;
        return session;
    }

    finalizeCaptureSession(sessionId, result) {
        const session = this.getSession(sessionId);
        if (session) session.captureAnalysis = result;
        return session;
    }

    recordCaptureAnalysis(sessionId, analysis) {
        const session = this.getSession(sessionId);
        if (session) session.captureAnalysis = analysis;
        return session;
    }

    createSession(type, platforms, options) {
        const id = `${type}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
        const now = new Date().toISOString();
        const session = { id, type, platforms, options, status: 'created', logs: [], createdAt: now, updatedAt: now };
        this.sessions.set(id, session);
        return session;
    }
}

module.exports = SmartCollectionController;
