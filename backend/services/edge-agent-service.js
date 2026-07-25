'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MAX_CAPABILITIES = 64;
const MAX_TASK_PAYLOAD_BYTES = 256 * 1024;
const MAX_EVENTS = 3000;
const TASK_TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);

function clean(value, maxLength = 160) {
    return String(value || '').trim().slice(0, maxLength);
}

function uniqueStrings(value, limit = MAX_CAPABILITIES) {
    const items = Array.isArray(value) ? value : [];
    return Array.from(new Set(items.map(item => clean(item, 120)).filter(Boolean))).slice(0, limit);
}

function safeEqual(left, right) {
    const leftBuffer = Buffer.from(String(left || ''));
    const rightBuffer = Buffer.from(String(right || ''));
    return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function hashSecret(value) {
    return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function boundedJson(value, maxBytes = MAX_TASK_PAYLOAD_BYTES) {
    const normalized = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const serialized = JSON.stringify(normalized);
    if (Buffer.byteLength(serialized) > maxBytes) throw new Error('edge task payload is too large');
    return JSON.parse(serialized);
}

function normalizeGeoName(value) {
    return clean(value, 80)
        .toLowerCase()
        .replace(/\s+/g, '')
        .replace(/(特别行政区|自治区|自治州|省|市|地区|盟|县|区)$/u, '');
}

function normalizeRequiredGeo(value = {}) {
    return {
        country: clean(value.country, 80),
        province: clean(value.province || value.region, 80),
        city: clean(value.city, 80)
    };
}

function geoContains(scope = {}, target = {}) {
    for (const key of ['country', 'province', 'city']) {
        if (!target[key]) continue;
        if (scope[key] && normalizeGeoName(scope[key]) !== normalizeGeoName(target[key])) return false;
    }
    return true;
}

function geoMatch(nodeGeo = {}, requiredGeo = {}, policy = 'strict') {
    if (!nodeGeo.verified) return { matched: false, score: 0, level: 'unverified' };
    const countryMatch = !requiredGeo.country
        || normalizeGeoName(nodeGeo.country) === normalizeGeoName(requiredGeo.country);
    const provinceMatch = !requiredGeo.province
        || normalizeGeoName(nodeGeo.province) === normalizeGeoName(requiredGeo.province);
    const cityMatch = !requiredGeo.city
        || normalizeGeoName(nodeGeo.city) === normalizeGeoName(requiredGeo.city);
    if (countryMatch && provinceMatch && cityMatch) {
        return { matched: true, score: requiredGeo.city ? 100 : requiredGeo.province ? 70 : 40, level: 'exact' };
    }
    if (policy === 'province-fallback' && countryMatch && provinceMatch && requiredGeo.province) {
        return { matched: true, score: 55, level: 'province' };
    }
    return { matched: false, score: 0, level: 'mismatch' };
}

function maskIp(value) {
    const ip = clean(value, 128);
    if (!ip) return '';
    if (ip.includes(':')) return `${ip.split(':').slice(0, 3).join(':')}::`;
    const parts = ip.split('.');
    return parts.length === 4 ? `${parts[0]}.${parts[1]}.x.x` : '';
}

class EdgeAgentService {
    constructor(options = {}) {
        this.statePath = options.statePath || path.join(process.cwd(), 'data', 'edge-agents', 'state.json');
        this.geoResolver = options.geoResolver;
        if (!this.geoResolver || typeof this.geoResolver.resolve !== 'function') {
            throw new TypeError('edge geo resolver is required');
        }
        this.enrollmentToken = clean(options.enrollmentToken ?? process.env.EDGE_AGENT_ENROLLMENT_TOKEN, 1000);
        this.production = options.production ?? String(process.env.NODE_ENV || '').toLowerCase() === 'production';
        if (this.production && !this.enrollmentToken) {
            throw new Error('EDGE_AGENT_ENROLLMENT_TOKEN is required in production');
        }
        this.now = typeof options.now === 'function' ? options.now : () => Date.now();
        this.onlineTtlMs = Math.max(5000, Number(options.onlineTtlMs || process.env.EDGE_AGENT_ONLINE_TTL_MS || 45000));
        this.leaseMs = Math.max(5000, Number(options.leaseMs || process.env.EDGE_TASK_LEASE_MS || 120000));
        this.maxAttempts = Math.max(1, Math.min(10, Number(options.maxAttempts || 3)));
        fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
        this.state = this.loadState();
        this.recoverExpiredLeases();
    }

    loadState() {
        try {
            const parsed = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
            return {
                nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
                tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
                events: Array.isArray(parsed.events) ? parsed.events : []
            };
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            return { nodes: [], tasks: [], events: [] };
        }
    }

    saveState() {
        const temporary = `${this.statePath}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(temporary, JSON.stringify(this.state, null, 2), { mode: 0o600 });
        fs.renameSync(temporary, this.statePath);
    }

    newId(prefix) {
        return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
    }

    assertEnrollmentToken(value) {
        if (!this.enrollmentToken && !this.production) return;
        if (!safeEqual(clean(value, 1000), this.enrollmentToken)) {
            const error = new Error('edge agent enrollment token is invalid');
            error.code = 'edge_enrollment_denied';
            error.statusCode = 401;
            throw error;
        }
    }

    async registerNode(input = {}, context = {}) {
        this.assertEnrollmentToken(context.enrollmentToken);
        const nodeId = clean(input.nodeId, 128);
        if (!/^[a-zA-Z0-9._:-]{6,128}$/.test(nodeId)) throw new Error('valid edge nodeId is required');
        const parentNodeId = clean(input.parentNodeId, 128);
        if (parentNodeId && parentNodeId === nodeId) throw new Error('edge node cannot be its own parent');
        if (parentNodeId && !this.state.nodes.some(node => node.nodeId === parentNodeId)) {
            throw new Error('edge parent node is not registered');
        }

        const observedIp = clean(context.observedIp, 128);
        const geo = await this.resolveGeo(observedIp);
        const now = new Date(this.now()).toISOString();
        const sessionToken = crypto.randomBytes(32).toString('base64url');
        let node = this.state.nodes.find(item => item.nodeId === nodeId);
        const normalized = {
            nodeId,
            parentNodeId,
            nodeType: clean(input.nodeType || 'worker', 40),
            platform: clean(input.platform || 'unknown', 40).toLowerCase(),
            version: clean(input.version, 80),
            capabilities: uniqueStrings(input.capabilities),
            delegatedCapabilities: uniqueStrings(input.delegatedCapabilities),
            delegatedRegions: this.normalizeDelegatedRegions(input.delegatedRegions),
            canDelegate: input.canDelegate === true,
            fingerprintHash: /^[a-f0-9]{32,128}$/i.test(clean(input.fingerprintHash, 128))
                ? clean(input.fingerprintHash, 128).toLowerCase()
                : '',
            deviceProfile: this.normalizeDeviceProfile(input.deviceProfile),
            observedIp,
            egressIp: observedIp,
            geo,
            geoVerifiedAt: geo.verified ? now : null,
            sessionTokenHash: hashSecret(sessionToken),
            registeredAt: node?.registeredAt || now,
            lastSeenAt: now,
            status: 'online',
            commandServiceRunning: input.commandServiceRunning !== false
        };
        if (node) Object.assign(node, normalized);
        else {
            node = normalized;
            this.state.nodes.push(node);
        }
        this.recordEvent('node.registered', { nodeId, parentNodeId, geo: this.publicGeo(geo) });
        this.saveState();
        return { node: this.publicNode(node, true), sessionToken };
    }

    async heartbeat(nodeId, input = {}, context = {}) {
        const node = this.authenticateNode(nodeId, context.sessionToken);
        const observedIp = clean(context.observedIp, 128);
        const geo = await this.resolveGeo(observedIp);
        node.lastSeenAt = new Date(this.now()).toISOString();
        node.status = 'online';
        node.observedIp = observedIp;
        node.egressIp = observedIp;
        node.geo = geo;
        if (geo.verified) node.geoVerifiedAt = node.lastSeenAt;
        if (input.version) node.version = clean(input.version, 80);
        if (input.capabilities) node.capabilities = uniqueStrings(input.capabilities);
        if (input.deviceProfile) node.deviceProfile = this.normalizeDeviceProfile(input.deviceProfile);
        node.commandServiceRunning = input.commandServiceRunning !== false;
        this.recoverExpiredLeases(false);
        this.assignWaitingTasks();
        this.saveState();
        return this.publicNode(node, true);
    }

    authenticateNode(nodeId, sessionToken) {
        const normalizedId = clean(nodeId, 128);
        const node = this.state.nodes.find(item => item.nodeId === normalizedId);
        if (!node || !safeEqual(node.sessionTokenHash, hashSecret(sessionToken))) {
            const error = new Error('edge node authentication failed');
            error.code = 'edge_node_unauthorized';
            error.statusCode = 401;
            throw error;
        }
        return node;
    }

    createTask(input = {}, issuer = { type: 'server' }) {
        this.recoverExpiredLeases(false);
        const capability = clean(input.capability, 120);
        const type = clean(input.type, 120);
        if (!capability || !type) throw new Error('edge task capability and type are required');
        const requiredGeo = normalizeRequiredGeo(input.requiredGeo || {});
        const geoPolicy = ['strict', 'province-fallback', 'manual'].includes(input.geoPolicy)
            ? input.geoPolicy
            : 'strict';
        const issuerNode = issuer.type === 'node'
            ? this.authenticateNode(issuer.nodeId, issuer.sessionToken)
            : null;
        if (issuerNode) this.assertDelegation(issuerNode, input, capability, requiredGeo);

        const idempotencyKey = clean(input.idempotencyKey, 160);
        if (idempotencyKey) {
            const existing = this.state.tasks.find(task => task.idempotencyKey === idempotencyKey
                && task.issuerNodeId === (issuerNode?.nodeId || 'server'));
            if (existing) return this.publicTask(existing);
        }

        const now = new Date(this.now()).toISOString();
        const task = {
            id: this.newId('task'),
            parentTaskId: clean(input.parentTaskId, 128) || null,
            origin: issuerNode ? 'child-agent' : 'server',
            issuerNodeId: issuerNode?.nodeId || 'server',
            targetNodeId: clean(input.targetNodeId, 128) || null,
            capability,
            type,
            payload: boundedJson(input.payload),
            requiredGeo,
            geoPolicy,
            status: 'pending',
            leaseOwner: null,
            leaseUntil: null,
            attemptCount: 0,
            maxAttempts: Math.max(1, Math.min(10, Number(input.maxAttempts || this.maxAttempts))),
            priority: Math.max(0, Math.min(100, Number(input.priority || 50))),
            idempotencyKey,
            createdAt: now,
            updatedAt: now,
            result: null,
            error: null,
            executionGeo: null,
            assignmentReason: null
        };
        if (task.targetNodeId) this.assertTargetAllowed(task, issuerNode);
        else this.assignTask(task, issuerNode);
        this.state.tasks.push(task);
        this.recordEvent('task.created', {
            taskId: task.id,
            issuerNodeId: task.issuerNodeId,
            targetNodeId: task.targetNodeId,
            requiredGeo
        });
        this.saveState();
        return this.publicTask(task);
    }

    pollTask(nodeId, sessionToken) {
        const node = this.authenticateNode(nodeId, sessionToken);
        node.lastSeenAt = new Date(this.now()).toISOString();
        this.recoverExpiredLeases(false);
        this.assignWaitingTasks();
        const task = this.state.tasks
            .filter(item => item.status === 'pending' && item.targetNodeId === node.nodeId)
            .sort((left, right) => right.priority - left.priority || left.createdAt.localeCompare(right.createdAt))[0];
        if (!task) {
            this.saveState();
            return null;
        }
        task.status = 'running';
        task.leaseOwner = node.nodeId;
        task.leaseUntil = new Date(this.now() + this.leaseMs).toISOString();
        task.attemptCount += 1;
        task.updatedAt = new Date(this.now()).toISOString();
        task.executionGeo = this.publicGeo(node.geo);
        this.recordEvent('task.leased', { taskId: task.id, nodeId: node.nodeId, attempt: task.attemptCount });
        this.saveState();
        return this.publicTask(task);
    }

    completeTask(nodeId, sessionToken, taskId, input = {}) {
        const node = this.authenticateNode(nodeId, sessionToken);
        const task = this.state.tasks.find(item => item.id === clean(taskId, 128));
        if (!task) throw new Error('edge task not found');
        if (task.leaseOwner !== node.nodeId || task.status !== 'running') {
            const error = new Error('edge task is not leased to this node');
            error.statusCode = 409;
            throw error;
        }
        const retryable = input.success !== true
            && input.retryable === true
            && task.attemptCount < task.maxAttempts;
        task.status = input.success === true ? 'succeeded' : retryable ? 'pending' : 'failed';
        task.result = boundedJson(input.result || {}, 512 * 1024);
        task.error = clean(input.error, 1000) || null;
        task.executionGeo = this.publicGeo(node.geo);
        task.leaseOwner = null;
        task.leaseUntil = null;
        if (retryable) task.targetNodeId = null;
        task.updatedAt = new Date(this.now()).toISOString();
        this.recordEvent(retryable ? 'task.retry_requested' : 'task.completed', {
            taskId: task.id,
            nodeId: node.nodeId,
            status: task.status,
            attempt: task.attemptCount
        });
        if (retryable) this.assignTask(task, null);
        this.saveState();
        return this.publicTask(task);
    }

    cancelTask(taskId, actor = 'server') {
        const task = this.state.tasks.find(item => item.id === clean(taskId, 128));
        if (!task) throw new Error('edge task not found');
        if (!TASK_TERMINAL_STATUSES.has(task.status)) {
            task.status = 'cancelled';
            task.leaseUntil = null;
            task.updatedAt = new Date(this.now()).toISOString();
            this.recordEvent('task.cancelled', { taskId: task.id, actor: clean(actor, 128) });
            this.saveState();
        }
        return this.publicTask(task);
    }

    assignWaitingTasks() {
        for (const task of this.state.tasks) {
            if (task.status === 'pending' && !task.targetNodeId) this.assignTask(task, null);
        }
    }

    assignTask(task, issuerNode = null) {
        if (task.geoPolicy === 'manual') {
            task.assignmentReason = 'manual_assignment_required';
            return null;
        }
        const candidates = this.state.nodes
            .filter(node => this.isOnline(node))
            .filter(node => node.capabilities.includes(task.capability))
            .filter(node => !issuerNode || node.nodeId === issuerNode.nodeId || node.parentNodeId === issuerNode.nodeId)
            .map(node => ({ node, match: geoMatch(node.geo, task.requiredGeo, task.geoPolicy) }))
            .filter(item => item.match.matched || !Object.values(task.requiredGeo).some(Boolean))
            .map(item => ({
                ...item,
                score: item.match.score + (this.activeTaskCount(item.node.nodeId) === 0 ? 20 : 0)
            }))
            .sort((left, right) => right.score - left.score || right.node.lastSeenAt.localeCompare(left.node.lastSeenAt));
        const selected = candidates[0];
        if (!selected) {
            task.assignmentReason = 'no_matching_online_node';
            return null;
        }
        task.targetNodeId = selected.node.nodeId;
        task.assignmentReason = `geo:${selected.match.level};score:${selected.score}`;
        return selected.node;
    }

    assertDelegation(node, input, capability, requiredGeo) {
        if (!node.canDelegate) {
            const error = new Error('edge node is not allowed to delegate tasks');
            error.statusCode = 403;
            throw error;
        }
        const allowedCapabilities = node.delegatedCapabilities.length > 0
            ? node.delegatedCapabilities
            : node.capabilities;
        if (!allowedCapabilities.includes(capability)) {
            const error = new Error('edge task capability is outside delegated scope');
            error.statusCode = 403;
            throw error;
        }
        if (node.delegatedRegions.length > 0
            && !node.delegatedRegions.some(scope => geoContains(scope, requiredGeo))) {
            const error = new Error('edge task geography is outside delegated scope');
            error.statusCode = 403;
            throw error;
        }
        if (input.parentTaskId) {
            const parentTask = this.state.tasks.find(task => task.id === clean(input.parentTaskId, 128));
            if (!parentTask || ![node.nodeId, node.parentNodeId].includes(parentTask.targetNodeId)) {
                const error = new Error('edge parent task is outside node scope');
                error.statusCode = 403;
                throw error;
            }
        }
    }

    assertTargetAllowed(task, issuerNode) {
        const target = this.state.nodes.find(node => node.nodeId === task.targetNodeId);
        if (!target) throw new Error('edge target node not found');
        if (!target.capabilities.includes(task.capability)) throw new Error('edge target lacks required capability');
        if (issuerNode && target.nodeId !== issuerNode.nodeId && target.parentNodeId !== issuerNode.nodeId) {
            const error = new Error('edge target is outside child agent scope');
            error.statusCode = 403;
            throw error;
        }
        const match = geoMatch(target.geo, task.requiredGeo, task.geoPolicy);
        if (Object.values(task.requiredGeo).some(Boolean) && !match.matched) {
            const error = new Error('edge target IP geography does not satisfy task policy');
            error.statusCode = 409;
            throw error;
        }
        task.assignmentReason = `explicit;geo:${match.level}`;
    }

    recoverExpiredLeases(save = true) {
        let changed = false;
        const now = this.now();
        for (const task of this.state.tasks) {
            if (task.status !== 'running' || !task.leaseUntil || Date.parse(task.leaseUntil) > now) continue;
            task.status = task.attemptCount >= task.maxAttempts ? 'failed' : 'pending';
            task.error = task.status === 'failed' ? 'task lease expired after maximum attempts' : 'task lease expired';
            task.leaseOwner = null;
            task.leaseUntil = null;
            task.updatedAt = new Date(now).toISOString();
            if (task.status === 'pending') task.targetNodeId = null;
            this.recordEvent('task.lease_expired', { taskId: task.id, status: task.status });
            changed = true;
        }
        if (changed && save) this.saveState();
        return changed;
    }

    listNodes(options = {}) {
        return this.state.nodes
            .map(node => this.publicNode(node, options.includeIp === true))
            .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt));
    }

    listTasks(options = {}) {
        const limit = Math.max(1, Math.min(500, Number(options.limit || 100)));
        return this.state.tasks.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit)
            .map(task => this.publicTask(task));
    }

    getStatus() {
        const nodes = this.listNodes();
        return {
            nodes: {
                total: nodes.length,
                online: nodes.filter(node => node.online).length,
                delegating: nodes.filter(node => node.canDelegate).length,
                geoVerified: nodes.filter(node => node.geo?.verified).length
            },
            tasks: Object.fromEntries(['pending', 'running', 'succeeded', 'failed', 'cancelled']
                .map(status => [status, this.state.tasks.filter(task => task.status === status).length]))
        };
    }

    isOnline(node) {
        return Boolean(node.lastSeenAt)
            && this.now() - Date.parse(node.lastSeenAt) <= this.onlineTtlMs
            && node.commandServiceRunning !== false;
    }

    activeTaskCount(nodeId) {
        return this.state.tasks.filter(task => task.targetNodeId === nodeId
            && ['pending', 'running'].includes(task.status)).length;
    }

    publicNode(node, includeIp = false) {
        return {
            nodeId: node.nodeId,
            parentNodeId: node.parentNodeId || null,
            nodeType: node.nodeType,
            platform: node.platform,
            version: node.version,
            capabilities: [...node.capabilities],
            delegatedCapabilities: [...node.delegatedCapabilities],
            delegatedRegions: node.delegatedRegions.map(item => ({ ...item })),
            canDelegate: Boolean(node.canDelegate),
            fingerprintHash: node.fingerprintHash,
            deviceProfile: { ...node.deviceProfile },
            egressIp: includeIp ? node.egressIp : maskIp(node.egressIp),
            geo: this.publicGeo(node.geo),
            geoVerifiedAt: node.geoVerifiedAt,
            registeredAt: node.registeredAt,
            lastSeenAt: node.lastSeenAt,
            online: this.isOnline(node),
            status: this.isOnline(node) ? 'online' : 'offline',
            activeTaskCount: this.activeTaskCount(node.nodeId)
        };
    }

    publicTask(task) {
        return JSON.parse(JSON.stringify(task));
    }

    publicGeo(geo = {}) {
        return {
            country: clean(geo.country, 80),
            province: clean(geo.province, 80),
            city: clean(geo.city, 80),
            asn: clean(geo.asn, 120),
            verified: geo.verified === true,
            source: clean(geo.source, 80)
        };
    }

    normalizeDeviceProfile(profile = {}) {
        const source = profile && typeof profile === 'object' && !Array.isArray(profile) ? profile : {};
        const allowed = [
            'manufacturer', 'model', 'osName', 'osVersion', 'osBuild', 'architecture',
            'cpuCount', 'memoryMb', 'hostnameHash', 'installationIdHash', 'appVersion',
            'wechatInstalled', 'wechatRunning', 'screenWidth', 'screenHeight', 'locale', 'timezone'
        ];
        return Object.fromEntries(allowed.filter(key => source[key] !== undefined).map(key => {
            const value = source[key];
            if (typeof value === 'boolean') return [key, value];
            if (typeof value === 'number') return [key, Number.isFinite(value) ? value : 0];
            return [key, clean(value, 160)];
        }));
    }

    normalizeDelegatedRegions(value) {
        return (Array.isArray(value) ? value : []).slice(0, 64).map(normalizeRequiredGeo)
            .filter(item => Object.values(item).some(Boolean));
    }

    async resolveGeo(ip) {
        try {
            return await this.geoResolver.resolve(ip);
        } catch (error) {
            return {
                ip: clean(ip, 128), country: '', province: '', city: '', asn: '',
                verified: false, source: `resolver-error:${clean(error.message, 80)}`
            };
        }
    }

    recordEvent(type, detail = {}) {
        this.state.events.unshift({
            id: this.newId('evt'),
            type: clean(type, 120),
            detail: boundedJson(detail, 64 * 1024),
            createdAt: new Date(this.now()).toISOString()
        });
        this.state.events = this.state.events.slice(0, MAX_EVENTS);
    }
}

module.exports = {
    EdgeAgentService,
    geoContains,
    geoMatch,
    hashSecret,
    normalizeRequiredGeo
};
