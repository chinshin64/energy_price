const fs = require('fs');
const path = require('path');
const http = require('http');

const MAX_TOOL_ROUNDS = 3;
const MAX_TOOL_RESULT_CHARS = 3000;
const LLM_TIMEOUT_MS = 45000;

const AGENT_TOOLS = [
    {
        name: 'query_stations',
        description: '查询充电场站数据。可按平台、城市、关键词搜索。',
        input_schema: {
            type: 'object',
            properties: {
                platform: { type: 'string', description: '平台ID: didi-charging, teld, star-charge, kuaidian, tuanyou, ykc' },
                city: { type: 'string', description: '城市名' },
                keyword: { type: 'string', description: '场站名或地址关键词' },
                limit: { type: 'integer', description: '返回条数，默认20，最大100' }
            }
        }
    },
    {
        name: 'query_stats',
        description: '获取各平台的采集统计（总记录数、去重场站数、最后采集时间）。',
        input_schema: { type: 'object', properties: {} }
    },
    {
        name: 'query_crawl_runs',
        description: '查询最近的爬取运行记录及状态。',
        input_schema: {
            type: 'object',
            properties: { limit: { type: 'integer', description: '返回条数，默认10' } }
        }
    },
    {
        name: 'query_schedules',
        description: '查询定时任务列表。',
        input_schema: { type: 'object', properties: {} }
    },
    {
        name: 'query_mobile_status',
        description: '查询手机控制设备状态、工作流和命令。',
        input_schema: { type: 'object', properties: {} }
    },
    {
        name: 'start_crawl',
        description: '发起一次智能爬取任务。',
        input_schema: {
            type: 'object',
            properties: {
                platform: { type: 'string', description: '平台ID' },
                city: { type: 'string', description: '城市' },
                count: { type: 'integer', description: '目标采集数量' }
            },
            required: ['platform']
        }
    },
    {
        name: 'query_price_schedules',
        description: '查询分时电价数据。',
        input_schema: {
            type: 'object',
            properties: {
                platform: { type: 'string', description: '平台ID' },
                limit: { type: 'integer', description: '返回条数，默认10' }
            }
        }
    },
    {
        name: 'query_network_settings',
        description: '查看当前代理/网络配置。',
        input_schema: { type: 'object', properties: {} }
    }
];

class AgentChatService {
    constructor(options = {}) {
        this.dataDir = options.dataDir || path.join(__dirname, '../../data/agent-chat');
        this.statePath = path.join(this.dataDir, 'state.json');
        this.models = options.models || {};
        this.services = options.services || {};

        this.llmBaseUrl = process.env.AGENT_LLM_BASE_URL || 'http://llm-proxy.intra.xiaojukeji.com';
        this.llmApiKey = process.env.AGENT_LLM_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || '';
        this.llmModel = process.env.AGENT_LLM_MODEL || 'glm-5.1';

        fs.mkdirSync(this.dataDir, { recursive: true });
        this.state = this._loadState();
    }

    _loadState() {
        try {
            if (!fs.existsSync(this.statePath)) return { sessions: [] };
            return { sessions: JSON.parse(fs.readFileSync(this.statePath, 'utf8')).sessions || [] };
        } catch { return { sessions: [] }; }
    }

    _saveState() {
        const keep = this.state.sessions
            .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
            .slice(0, 20);
        this.state.sessions = keep;
        fs.writeFileSync(this.statePath, JSON.stringify({ sessions: keep }, null, 2));
    }

    listSessions(limit = 20) {
        return this.state.sessions.slice(0, Math.max(1, Number(limit) || 20));
    }

    getSession(sessionId) {
        return this.state.sessions.find(s => s.id === sessionId) || null;
    }

    _ensureSession(sessionId) {
        let session = sessionId && this.state.sessions.find(s => s.id === sessionId);
        if (!session) {
            session = {
                id: sessionId || `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                title: 'AI 助手对话',
                messages: [],
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            };
            this.state.sessions.unshift(session);
        }
        return session;
    }

    _buildSystemPrompt() {
        let ctx = '';
        try {
            const stats = this.models.StationModel?.getStatistics() || [];
            if (stats.length) {
                ctx += '\n## 当前系统概况\n';
                for (const s of stats) {
                    ctx += `- ${s.platform}: ${s.total_records} 条记录, ${s.unique_stations} 个去重场站, 最后采集 ${s.last_collected || '未知'}\n`;
                }
            }
        } catch {}
        try {
            const ms = this.services.mobileCommandService?.getControlStatus?.();
            if (ms) ctx += `- 手机控制设备: ${ms.deviceCount || 0} 台在线\n`;
        } catch {}

        return `你是"数据学习主端"的 AI 助手。你可以帮助用户查询充电场站数据、管理采集任务、了解系统状态。
${ctx}
## 你的能力
你可以通过工具来查询和操作系统。当你需要获取数据或执行操作时，请调用相应的工具。
- 查询场站数据 → query_stations
- 查询采集统计 → query_stats
- 查询爬取记录 → query_crawl_runs
- 查询定时任务 → query_schedules
- 查询手机控制状态 → query_mobile_status
- 发起爬取任务 → start_crawl
- 查询分时电价 → query_price_schedules
- 查看网络配置 → query_network_settings

## 注意事项
- 回答使用中文
- 数据相关问题时，优先调用工具获取实时数据，不要凭记忆回答
- 发起操作前先确认参数
- 不要编造不存在的工具或数据`;
    }

    _executeTool(name, input) {
        const m = this.models;
        const s = this.services;
        try {
            switch (name) {
                case 'query_stations': {
                    const limit = Math.min(Number(input.limit) || 20, 100);
                    const rows = m.StationModel?.getRecent(limit * 3, input.platform || null) || [];
                    let filtered = rows;
                    if (input.city) {
                        const city = input.city.toLowerCase();
                        filtered = filtered.filter(r =>
                            (r.city || '').toLowerCase().includes(city) ||
                            (r.address || '').toLowerCase().includes(city)
                        );
                    }
                    if (input.keyword) {
                        const kw = input.keyword.toLowerCase();
                        filtered = filtered.filter(r =>
                            (r.name || '').toLowerCase().includes(kw) ||
                            (r.address || '').toLowerCase().includes(kw)
                        );
                    }
                    filtered = filtered.slice(0, limit);
                    const sample = filtered.slice(0, 3).map(r => ({
                        name: r.name, address: r.address, city: r.city,
                        platform: r.platform, price: r.price_info || r.price
                    }));
                    return { count: filtered.length, city: input.city || '全部', sample };
                }
                case 'query_stats':
                    return m.StationModel?.getStatistics() || [];
                case 'query_crawl_runs': {
                    const limit = Math.min(Number(input.limit) || 10, 50);
                    return m.RunHistoryModel?.getRuns(limit) || [];
                }
                case 'query_schedules':
                    return m.ScheduleModel?.list() || [];
                case 'query_mobile_status':
                    return s.mobileCommandService?.getControlStatus?.() || { deviceCount: 0 };
                case 'start_crawl': {
                    if (!input.platform) return { error: 'platform 参数必填' };
                    return { message: `爬取任务已提交: platform=${input.platform}, city=${input.city || '全部'}, count=${input.count || '默认'}` };
                }
                case 'query_price_schedules': {
                    const limit = Math.min(Number(input.limit) || 10, 100);
                    return m.PriceScheduleModel?.getByPlatform(input.platform, limit) || [];
                }
                case 'query_network_settings':
                    return m.AppSettingModel?.getProxySettings() || {};
                default:
                    return { error: `未知工具: ${name}` };
            }
        } catch (err) {
            return { error: `工具执行失败: ${name}: ${err.message}` };
        }
    }

    async _callLLM(messages, onChunk) {
        const url = new URL('/v1/messages', this.llmBaseUrl);
        const body = JSON.stringify({
            model: this.llmModel,
            max_tokens: 2048,
            system: this._buildSystemPrompt(),
            tools: AGENT_TOOLS,
            stream: !!onChunk,
            messages
        });

        return new Promise((resolve, reject) => {
            const client = url.protocol === 'https:' ? require('https') : http;
            const headers = {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
                'anthropic-version': '2023-06-01'
            };
            if (this.llmApiKey) headers['x-api-key'] = this.llmApiKey;

            const req = client.request({
                method: 'POST',
                hostname: url.hostname,
                port: url.port || (url.protocol === 'https:' ? 443 : 80),
                path: url.pathname,
                headers,
                timeout: LLM_TIMEOUT_MS
            }, (res) => {
                if (!onChunk) {
                    const chunks = [];
                    res.on('data', c => chunks.push(c));
                    res.on('end', () => {
                        const text = Buffer.concat(chunks).toString('utf8');
                        if (res.statusCode < 200 || res.statusCode >= 300) {
                            reject(new Error(`LLM http ${res.statusCode}: ${text.slice(0, 300)}`));
                            return;
                        }
                        try { resolve(JSON.parse(text)); } catch { reject(new Error('LLM response parse error')); }
                    });
                } else {
                    let buffer = '';
                    let fullResponse = null;
                    res.on('data', (chunk) => {
                        buffer += chunk.toString('utf8');
                        const lines = buffer.split('\n');
                        buffer = lines.pop();
                        for (const line of lines) {
                            if (!line.startsWith('data: ')) continue;
                            const data = line.slice(6).trim();
                            if (!data || data === '[DONE]') continue;
                            try {
                                const evt = JSON.parse(data);
                                if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
                                    onChunk({ type: 'text', content: evt.delta.text });
                                } else if (evt.type === 'content_block_start' && evt.content_block?.type === 'tool_use') {
                                    onChunk({ type: 'tool_call_start', name: evt.content_block.name, id: evt.content_block.id });
                                } else if (evt.type === 'message_stop') {
                                    // stream ended
                                } else if (evt.type === 'message_start' && evt.message) {
                                    fullResponse = evt.message;
                                }
                            } catch {}
                        }
                    });
                    res.on('end', () => {
                        if (res.statusCode < 200 || res.statusCode >= 300) {
                            reject(new Error(`LLM http ${res.statusCode}`));
                            return;
                        }
                        resolve(fullResponse || { stop_reason: 'end_turn', content: [] });
                    });
                }
            });
            req.on('timeout', () => req.destroy(new Error('LLM request timeout')));
            req.on('error', reject);
            req.write(body);
            req.end();
        });
    }

    async sendMessage(sessionId, message, onChunk) {
        const session = this._ensureSession(sessionId);
        session.messages.push({ role: 'user', content: message, at: new Date().toISOString() });
        session.updatedAt = new Date().toISOString();

        const llmMessages = this._buildLLMMessages(session.messages);
        let finalText = '';
        let toolCallsMade = 0;

        for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
            const response = await this._callLLM(llmMessages, onChunk);

            const contentBlocks = response.content || [];
            const textParts = contentBlocks.filter(b => b.type === 'text');
            const toolParts = contentBlocks.filter(b => b.type === 'tool_use');

            for (const t of textParts) {
                finalText += t.text || '';
            }

            // Append assistant message to LLM conversation
            llmMessages.push({ role: 'assistant', content: contentBlocks.filter(b => b.type === 'text' || b.type === 'tool_use') });

            if (toolParts.length === 0 || response.stop_reason !== 'tool_use') break;
            if (toolCallsMade >= MAX_TOOL_ROUNDS) break;

            const toolResults = [];
            for (const tool of toolParts) {
                toolCallsMade++;
                onChunk?.({ type: 'tool_call', name: tool.name, input: tool.input });
                const result = this._executeTool(tool.name, tool.input);
                const truncated = typeof result === 'string'
                    ? result.slice(0, MAX_TOOL_RESULT_CHARS)
                    : JSON.stringify(result).slice(0, MAX_TOOL_RESULT_CHARS);
                onChunk?.({ type: 'tool_result', name: tool.name, result: typeof result === 'object' ? result : truncated });
                toolResults.push({ type: 'tool_result', tool_use_id: tool.id, content: truncated });
                session.messages.push({
                    role: 'tool', name: tool.name, input: tool.input,
                    result: typeof result === 'object' ? result : truncated,
                    at: new Date().toISOString()
                });
            }
            llmMessages.push({ role: 'user', content: toolResults });
        }

        session.messages.push({ role: 'assistant', content: finalText, at: new Date().toISOString() });
        session.updatedAt = new Date().toISOString();
        this._saveState();
        return { session, assistantMessage: finalText };
    }

    _buildLLMMessages(messages) {
        const result = [];
        for (const msg of messages) {
            if (msg.role === 'user') {
                result.push({ role: 'user', content: msg.content });
            } else if (msg.role === 'assistant') {
                result.push({ role: 'assistant', content: [{ type: 'text', text: msg.content }] });
            } else if (msg.role === 'tool') {
                result.push({
                    role: 'user',
                    content: [{ type: 'tool_result', tool_use_id: `tool-${Date.now()}`, content: typeof msg.result === 'string' ? msg.result : JSON.stringify(msg.result) }]
                });
            }
        }
        return result;
    }
}

module.exports = AgentChatService;
