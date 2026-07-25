'use strict';

class EdgeClient {
    constructor(options = {}) {
        this.config = options.config;
        this.stateStore = options.stateStore;
        this.fetch = options.fetch || global.fetch;
        if (!this.config || !this.stateStore || typeof this.fetch !== 'function') {
            throw new TypeError('edge client dependencies are required');
        }
    }

    async request(pathname, options = {}) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
        try {
            const response = await this.fetch(`${this.config.serverUrl}${pathname}`, {
                method: options.method || 'GET',
                headers: { accept: 'application/json', ...(options.headers || {}) },
                body: options.body === undefined ? undefined : JSON.stringify(options.body),
                signal: controller.signal
            });
            const text = await response.text();
            const payload = text ? JSON.parse(text) : {};
            if (!response.ok || payload.success === false) {
                const error = new Error(payload.error || `edge server request failed: HTTP ${response.status}`);
                error.statusCode = response.status;
                error.code = payload.code;
                throw error;
            }
            return payload.data;
        } finally {
            clearTimeout(timeout);
        }
    }

    async register(input) {
        const data = await this.request('/api/edge/v1/nodes/register', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-edge-enrollment-token': this.config.enrollmentToken
            },
            body: input
        });
        this.stateStore.update({
            nodeId: data.node.nodeId,
            sessionToken: data.sessionToken,
            registeredAt: data.node.registeredAt
        });
        return data.node;
    }

    nodeHeaders() {
        return {
            'content-type': 'application/json',
            'x-edge-node-id': this.stateStore.state.nodeId || '',
            authorization: `Bearer ${this.stateStore.state.sessionToken || ''}`
        };
    }

    heartbeat(body) {
        return this.request('/api/edge/v1/nodes/heartbeat', {
            method: 'POST', headers: this.nodeHeaders(), body
        });
    }

    pollTask() {
        return this.request('/api/edge/v1/tasks/poll', { headers: this.nodeHeaders() });
    }

    completeTask(taskId, body) {
        return this.request(`/api/edge/v1/tasks/${encodeURIComponent(taskId)}/result`, {
            method: 'POST', headers: this.nodeHeaders(), body
        });
    }

    createChildTask(body) {
        return this.request('/api/edge/v1/tasks', {
            method: 'POST', headers: this.nodeHeaders(), body
        });
    }
}

module.exports = { EdgeClient };
