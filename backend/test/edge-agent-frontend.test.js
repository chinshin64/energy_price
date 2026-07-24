'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadController(elements) {
    const source = fs.readFileSync(path.join(__dirname, '../../frontend/public/edge-agent-control.js'), 'utf8');
    const window = {};
    vm.runInNewContext(source, { window });
    return window.EdgeAgentControl.createController({
        document: { getElementById: id => elements[id] || null },
        escapeHtml: value => String(value).replace(/[&<>"']/g, character => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        })[character]),
        formatTime: value => value || '-'
    });
}

test('协同控制面渲染节点和任务且转义外部字段', () => {
    const elements = {
        edgeOrchestrationStatus: { textContent: '', className: '' },
        edgeNodeList: { innerHTML: '' },
        edgeTaskList: { innerHTML: '' }
    };
    const controller = loadController(elements);
    controller.render({
        status: { nodes: { total: 1, online: 1, geoVerified: 1 }, tasks: { running: 1, pending: 0 } },
        nodes: [{
            nodeId: '<node-1>', online: true, platform: 'android', version: '0.3.0',
            geo: { country: '中国', province: '陕西省', city: '西安市' },
            egressIp: '172.23.x.x', capabilities: ['android.wechat.collect'], activeTaskCount: 1,
            lastSeenAt: '2026-07-16T10:00:00Z'
        }],
        tasks: [{
            type: 'collect_landmark', status: 'running', targetNodeId: '<node-1>',
            requiredGeo: { city: '西安市' }, origin: 'server', attemptCount: 1, maxAttempts: 3
        }]
    });
    assert.match(elements.edgeOrchestrationStatus.textContent, /在线 1\/1/);
    assert.match(elements.edgeNodeList.innerHTML, /&lt;node-1&gt;/);
    assert.doesNotMatch(elements.edgeNodeList.innerHTML, /<node-1>/);
    assert.match(elements.edgeTaskList.innerHTML, /collect_landmark/);
});
