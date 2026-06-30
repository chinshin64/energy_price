'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { redactObject } = require('./sensitive-redactor');

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

function makeId(prefix) {
    return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

class RequestStrategyStore {
    constructor(options = {}) {
        this.projectRoot = options.projectRoot || path.join(__dirname, '../..');
        this.dataDir = options.dataDir || path.join(this.projectRoot, 'data');
        this.failureEventsPath = options.failureEventsPath || path.join(this.dataDir, 'request-failure-events.jsonl');
        this.analysesPath = options.analysesPath || path.join(this.dataDir, 'agent-analyses.jsonl');
        this.patchesPath = options.patchesPath || path.join(this.dataDir, 'request-strategy-patches.jsonl');
        this.strategiesPath = options.strategiesPath || path.join(this.dataDir, 'request-strategies.json');
        ensureDir(this.dataDir);
        if (!fs.existsSync(this.strategiesPath)) {
            fs.writeFileSync(this.strategiesPath, JSON.stringify({ strategies: [] }, null, 2));
        }
    }

    appendFailureEvent(event) {
        const item = {
            id: event.id || makeId('fail'),
            createdAt: event.createdAt || new Date().toISOString(),
            ...redactObject(event),
        };
        this._appendJsonl(this.failureEventsPath, item);
        return item;
    }

    appendAnalysis(analysis) {
        const item = {
            id: analysis.id || makeId('analysis'),
            createdAt: analysis.createdAt || new Date().toISOString(),
            ...redactObject(analysis),
        };
        this._appendJsonl(this.analysesPath, item);
        return item;
    }

    appendPatch(patch) {
        const item = {
            id: patch.id || makeId('patch'),
            status: patch.status || 'pending',
            createdAt: patch.createdAt || new Date().toISOString(),
            ...redactObject(patch),
        };
        this._appendJsonl(this.patchesPath, item);
        return item;
    }

    listFailureEvents(limit = 50) {
        return this._readJsonlTail(this.failureEventsPath, limit);
    }

    listAnalyses(limit = 50) {
        return this._readJsonlTail(this.analysesPath, limit);
    }

    listPatches(limit = 50) {
        return this._readJsonlTail(this.patchesPath, limit);
    }

    listStrategies() {
        try {
            return JSON.parse(fs.readFileSync(this.strategiesPath, 'utf8'));
        } catch {
            return { strategies: [] };
        }
    }

    upsertStrategy(strategy) {
        const state = this.listStrategies();
        const strategies = Array.isArray(state.strategies) ? state.strategies : [];
        const idx = strategies.findIndex(item => item.id === strategy.id);
        const next = { ...strategy, updatedAt: new Date().toISOString() };
        if (idx >= 0) strategies[idx] = { ...strategies[idx], ...next };
        else strategies.push(next);
        fs.writeFileSync(this.strategiesPath, JSON.stringify({ strategies }, null, 2));
        return next;
    }

    findPatch(id) {
        return this._readJsonlAll(this.patchesPath).find(item => item.id === id) || null;
    }

    markPatch(id, status, extra = {}) {
        const all = this._readJsonlAll(this.patchesPath);
        let found = null;
        const updated = all.map(item => {
            if (item.id !== id) return item;
            found = { ...item, ...extra, status, updatedAt: new Date().toISOString() };
            return found;
        });
        if (!found) return null;
        fs.writeFileSync(this.patchesPath, updated.map(item => JSON.stringify(item)).join('\n') + '\n');
        return found;
    }

    _appendJsonl(filePath, item) {
        ensureDir(path.dirname(filePath));
        fs.appendFileSync(filePath, JSON.stringify(item) + '\n');
    }

    _readJsonlAll(filePath) {
        if (!fs.existsSync(filePath)) return [];
        return fs.readFileSync(filePath, 'utf8')
            .split('\n')
            .map(line => line.trim())
            .filter(Boolean)
            .map(line => {
                try { return JSON.parse(line); } catch { return null; }
            })
            .filter(Boolean);
    }

    _readJsonlTail(filePath, limit) {
        const all = this._readJsonlAll(filePath);
        return all.slice(Math.max(0, all.length - Number(limit || 50))).reverse();
    }
}

module.exports = RequestStrategyStore;
