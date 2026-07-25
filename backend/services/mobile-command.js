const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');

const DEFAULT_LANDMARK_CONFIG_PATH = path.join(__dirname, '../config/mobile-landmarks.json');
const COORDINATE_PI = 3.1415926535897932384626;
const GCJ_A = 6378245.0;
const GCJ_EE = 0.00669342162296594323;

function cleanString(value) {
    return String(value || '').trim();
}

function normalizePlaceName(value) {
    return cleanString(value).replace(/\s+/g, '').replace(/市/g, '');
}

function normalizeCoordinatePoint(value, label, coordinateSystem, coordinateSource) {
    const lat = Number(value?.lat);
    const lng = Number(value?.lng);
    if (!isValidCoordinate(lat, lng)) {
        throw new Error(`invalid mobile landmark coordinate: ${label}`);
    }
    return {
        lat,
        lng,
        coordinateSystem,
        coordinateSource,
    };
}

function normalizeMobileLandmarkConfig(rawConfig, sourcePath = 'inline') {
    if (!rawConfig || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) {
        throw new Error('mobile landmark config must be an object');
    }
    const coordinateSystem = cleanString(rawConfig.coordinateSystem) || 'WGS84';
    const coordinateSource = cleanString(rawConfig.source) || 'mobile_landmarks_config';
    const rawCities = rawConfig.cities;
    if (!rawCities || typeof rawCities !== 'object' || Array.isArray(rawCities)) {
        throw new Error('mobile landmark config must define cities');
    }

    const cities = {};
    for (const [cityKey, cityConfig] of Object.entries(rawCities)) {
        const city = cleanString(cityKey);
        if (!city) {
            throw new Error(`invalid mobile landmark city in ${sourcePath}`);
        }
        if (!cityConfig || typeof cityConfig !== 'object' || Array.isArray(cityConfig)) {
            throw new Error(`mobile landmark city config invalid: ${city}`);
        }
        if (cities[city]) {
            throw new Error(`duplicate mobile landmark city: ${city}`);
        }
        const cityCoordinateSystem = cleanString(cityConfig.coordinateSystem) || coordinateSystem;
        const center = normalizeCoordinatePoint(
            cityConfig.center,
            `${city} center`,
            cityCoordinateSystem,
            'city_center_config'
        );
        const rawLandmarks = cityConfig.landmarks;
        if (!Array.isArray(rawLandmarks) || rawLandmarks.length === 0) {
            throw new Error(`mobile landmark city has no landmarks: ${city}`);
        }

        const landmarks = [];
        const landmarkByName = {};
        const landmarkByNormalizedName = {};
        rawLandmarks.forEach((item, index) => {
            const name = cleanString(item?.name);
            if (!name) {
                throw new Error(`mobile landmark name required: ${city}#${index}`);
            }
            const normalizedName = normalizePlaceName(name);
            if (landmarkByName[name] || landmarkByNormalizedName[normalizedName]) {
                throw new Error(`duplicate mobile landmark name: ${name}`);
            }
            const point = normalizeCoordinatePoint(
                item,
                `${city} ${name}`,
                cleanString(item.coordinateSystem) || cityCoordinateSystem,
                cleanString(item.coordinateSource) || coordinateSource
            );
            const landmark = { name, ...point };
            landmarks.push(landmark);
            landmarkByName[name] = landmark;
            landmarkByNormalizedName[normalizedName] = landmark;
        });

        cities[city] = {
            center,
            landmarks,
            landmarkByName,
            landmarkByNormalizedName,
        };
    }

    if (Object.keys(cities).length === 0) {
        throw new Error('mobile landmark config has no cities');
    }

    return {
        version: Number(rawConfig.version) || 1,
        coordinateSystem,
        coordinateSource,
        cities,
    };
}

function loadMobileLandmarkConfig(filePath = DEFAULT_LANDMARK_CONFIG_PATH) {
    const rawConfig = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return normalizeMobileLandmarkConfig(rawConfig, filePath);
}

function isValidCoordinate(lat, lng) {
    return Number.isFinite(lat)
        && Number.isFinite(lng)
        && lat >= -90
        && lat <= 90
        && lng >= -180
        && lng <= 180
        && (lat !== 0 || lng !== 0);
}

function normalizeCoordinateSystem(value, fallback = 'WGS84') {
    const normalized = cleanString(value).toUpperCase();
    return ['WGS84', 'GCJ02', 'BD09'].includes(normalized) ? normalized : fallback;
}

function isCoordinateInChina(lat, lng) {
    return lng >= 72.004 && lng <= 137.8347 && lat >= 0.8293 && lat <= 55.8271;
}

function transformLat(x, y) {
    let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
    ret += (20.0 * Math.sin(6.0 * x * COORDINATE_PI) + 20.0 * Math.sin(2.0 * x * COORDINATE_PI)) * 2.0 / 3.0;
    ret += (20.0 * Math.sin(y * COORDINATE_PI) + 40.0 * Math.sin(y / 3.0 * COORDINATE_PI)) * 2.0 / 3.0;
    ret += (160.0 * Math.sin(y / 12.0 * COORDINATE_PI) + 320 * Math.sin(y * COORDINATE_PI / 30.0)) * 2.0 / 3.0;
    return ret;
}

function transformLng(x, y) {
    let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
    ret += (20.0 * Math.sin(6.0 * x * COORDINATE_PI) + 20.0 * Math.sin(2.0 * x * COORDINATE_PI)) * 2.0 / 3.0;
    ret += (20.0 * Math.sin(x * COORDINATE_PI) + 40.0 * Math.sin(x / 3.0 * COORDINATE_PI)) * 2.0 / 3.0;
    ret += (150.0 * Math.sin(x / 12.0 * COORDINATE_PI) + 300.0 * Math.sin(x / 30.0 * COORDINATE_PI)) * 2.0 / 3.0;
    return ret;
}

function wgs84ToGcj02(lat, lng) {
    if (!isCoordinateInChina(lat, lng)) {
        return { lat, lng };
    }
    let dLat = transformLat(lng - 105.0, lat - 35.0);
    let dLng = transformLng(lng - 105.0, lat - 35.0);
    const radLat = lat / 180.0 * COORDINATE_PI;
    let magic = Math.sin(radLat);
    magic = 1 - GCJ_EE * magic * magic;
    const sqrtMagic = Math.sqrt(magic);
    dLat = (dLat * 180.0) / ((GCJ_A * (1 - GCJ_EE)) / (magic * sqrtMagic) * COORDINATE_PI);
    dLng = (dLng * 180.0) / (GCJ_A / sqrtMagic * Math.cos(radLat) * COORDINATE_PI);
    return { lat: lat + dLat, lng: lng + dLng };
}

function gcj02ToWgs84(lat, lng) {
    if (!isCoordinateInChina(lat, lng)) {
        return { lat, lng };
    }
    const gcj = wgs84ToGcj02(lat, lng);
    return {
        lat: lat * 2 - gcj.lat,
        lng: lng * 2 - gcj.lng
    };
}

function bd09ToGcj02(lat, lng) {
    const x = lng - 0.0065;
    const y = lat - 0.006;
    const z = Math.sqrt(x * x + y * y) - 0.00002 * Math.sin(y * COORDINATE_PI);
    const theta = Math.atan2(y, x) - 0.000003 * Math.cos(x * COORDINATE_PI);
    return {
        lat: z * Math.sin(theta),
        lng: z * Math.cos(theta)
    };
}

function normalizeProviderCoordinate(lat, lng, coordinateSystem) {
    const sourceSystem = normalizeCoordinateSystem(coordinateSystem);
    if (sourceSystem === 'BD09') {
        const gcj = bd09ToGcj02(lat, lng);
        return {
            ...gcj02ToWgs84(gcj.lat, gcj.lng),
            sourceSystem,
            transform: 'BD09_TO_GCJ02_TO_WGS84'
        };
    }
    if (sourceSystem === 'GCJ02') {
        return {
            ...gcj02ToWgs84(lat, lng),
            sourceSystem,
            transform: 'GCJ02_TO_WGS84'
        };
    }
    return {
        lat,
        lng,
        sourceSystem,
        transform: 'NONE'
    };
}

class MobileCommandService {
    constructor(options = {}) {
        this.dataDir = options.dataDir || path.join(__dirname, '../../data/mobile-commands');
        this.statePath = path.join(this.dataDir, 'state.json');
        this.countCityStats = options.countCityStats || (() => ({ total: 0, distinct: 0 }));
        this.leaseMs = Number(options.leaseMs) || 45 * 60 * 1000;
        const requestedOnlineTtlMs = Number(options.deviceOnlineTtlMs || process.env.MOBILE_DEVICE_ONLINE_TTL_MS);
        this.deviceOnlineTtlMs = Number.isFinite(requestedOnlineTtlMs) && requestedOnlineTtlMs > 0
            ? Math.max(5000, requestedOnlineTtlMs)
            : 30000;
        this.now = typeof options.now === 'function' ? options.now : () => Date.now();
        this.aiFeaturesEnabled = Boolean(options.aiFeaturesEnabled);
        this.landmarkConfig = options.landmarkConfig
            ? normalizeMobileLandmarkConfig(options.landmarkConfig, 'injected')
            : loadMobileLandmarkConfig(options.landmarkConfigPath || DEFAULT_LANDMARK_CONFIG_PATH);
        const dccUrl = this.clean(options.dcc?.url);
        const dccCommand = this.clean(options.dcc?.command);
        const requestedDccTimeoutMs = Math.max(1000, Number(options.dcc?.timeoutMs) || 8000);
        const maxDccTimeoutMs = Math.max(1000, Number(options.dcc?.maxTimeoutMs) || 12000);
        this.dcc = {
            enabled: Boolean(options.dcc?.enabled && (dccUrl || dccCommand)),
            url: dccUrl,
            command: dccCommand,
            cwd: this.clean(options.dcc?.cwd) || process.cwd(),
            timeoutMs: Math.min(requestedDccTimeoutMs, maxDccTimeoutMs),
            requestedTimeoutMs: requestedDccTimeoutMs,
            maxTimeoutMs: maxDccTimeoutMs,
            authHeader: this.clean(options.dcc?.authHeader),
            authToken: this.clean(options.dcc?.authToken)
        };
        fs.mkdirSync(this.dataDir, { recursive: true });
        this.state = this.loadState();
    }

    getClientConfig() {
        const capabilities = [
            'network-command-polling',
            'interactive-intent',
            'collect-landmark',
            'start-text-collection',
            'stop-collection',
            'set-mock-location',
            'clear-mock-location',
            'accessibility-tap-click-scroll',
            'visible-text-status'
        ];
        if (this.aiFeaturesEnabled && this.dcc.enabled) {
            capabilities.push('dcc-agent-chat');
        }
        return {
            endpoints: {
                poll: '/api/mobile-sync/commands/poll',
                result: '/api/mobile-sync/commands/:id/result',
                workflows: '/api/mobile-control/workflows',
                startCityIncrementWorkflow: '/api/mobile-control/workflows/city-increment/start',
                interactionConfig: '/api/mobile-control/interaction/config',
                submitIntent: '/api/mobile-control/intent',
                submitChat: '/api/mobile-control/chat'
            },
            pollIntervalMs: 2000,
            commandLeaseMs: this.leaseMs,
            capabilities
        };
    }

    getInteractionConfig() {
        return {
            supportedCities: this.getSupportedCities(),
            examples: [
                '查看手机状态',
                '读取当前页面',
                '停止采集',
                '查询上海、北京、广州，每个城市新增100条价格/枪数快照',
                '以上海虹桥站为地标采集90次下滑'
            ],
            defaults: {
                targetIncrement: 100,
                pagesPerLandmark: 90,
                minIntervalMs: 1800,
                maxIntervalMs: 4200,
                detailEnrichmentEnabled: false
            },
            intentParser: {
                primary: this.aiFeaturesEnabled && this.dcc.enabled ? 'dcc' : 'rule',
                aiFeaturesEnabled: this.aiFeaturesEnabled,
                dccConfigured: this.aiFeaturesEnabled && this.dcc.enabled,
                dccMode: this.aiFeaturesEnabled
                    ? (this.dcc.url ? 'http' : (this.dcc.command ? 'cli' : 'disabled'))
                    : 'planned',
                timeoutMs: this.dcc.timeoutMs,
                requestedTimeoutMs: this.dcc.requestedTimeoutMs,
                timeoutCapped: this.dcc.requestedTimeoutMs > this.dcc.timeoutMs,
                planned: !this.aiFeaturesEnabled,
                message: this.aiFeaturesEnabled
                    ? ''
                    : 'AI 对话解析已暂时下线，后续版本恢复；当前仅保留内置规则命令。'
            }
        };
    }

    getControlStatus() {
        this.advanceWorkflows();
        const pendingCommands = this.state.commands.filter(command => ['pending', 'running'].includes(command.status));
        return {
            interaction: this.getInteractionConfig(),
            counts: {
                workflows: this.state.workflows.length,
                runningWorkflows: this.state.workflows.filter(workflow => workflow.status === 'running').length,
                commands: this.state.commands.length,
                pendingCommands: pendingCommands.length,
                devices: this.state.devices.length,
                onlineDevices: this.listDevices(100).filter(device => device.online).length
            },
            latestCommand: this.listCommands(1)[0] || null,
            latestDevice: this.listDevices(1)[0] || null
        };
    }

    loadState() {
        try {
            if (!fs.existsSync(this.statePath)) {
                return { commands: [], workflows: [], chatSessions: [], devices: [] };
            }
            const parsed = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
            return {
                commands: Array.isArray(parsed.commands) ? parsed.commands : [],
                workflows: Array.isArray(parsed.workflows) ? parsed.workflows : [],
                chatSessions: Array.isArray(parsed.chatSessions) ? parsed.chatSessions : [],
                devices: Array.isArray(parsed.devices) ? parsed.devices : []
            };
        } catch (error) {
            return { commands: [], workflows: [], chatSessions: [], devices: [] };
        }
    }

    saveState() {
        fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 2));
    }

    listCommands(limit = 100) {
        return this.state.commands
            .slice()
            .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
            .slice(0, Math.max(1, Number(limit) || 100));
    }

    listWorkflows() {
        return this.state.workflows
            .slice()
            .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
            .map(workflow => this.decorateWorkflow(workflow));
    }

    listChatSessions(limit = 20) {
        return (this.state.chatSessions || [])
            .slice()
            .sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)))
            .slice(0, Math.max(1, Number(limit) || 20));
    }

    getChatSession(sessionId) {
        return (this.state.chatSessions || []).find(session => session.id === sessionId) || null;
    }

    listDevices(limit = 50) {
        return (this.state.devices || [])
            .slice()
            .sort((a, b) => String(b.lastSeenAt || b.registeredAt).localeCompare(String(a.lastSeenAt || a.registeredAt)))
            .map(device => this.decorateDevice(device))
            .slice(0, Math.max(1, Number(limit) || 50));
    }

    decorateDevice(device = {}) {
        const lastSeenAt = device.lastSeenAt || device.registeredAt || '';
        const lastSeenMs = Date.parse(lastSeenAt);
        const lastSeenAgeMs = Number.isFinite(lastSeenMs)
            ? Math.max(0, this.now() - lastSeenMs)
            : null;
        const online = Boolean(
            device.commandServiceRunning !== false
            && lastSeenAgeMs !== null
            && lastSeenAgeMs <= this.deviceOnlineTtlMs
        );
        return {
            ...device,
            online,
            status: online ? 'online' : 'offline',
            lastSeenAgeMs,
            onlineTtlMs: this.deviceOnlineTtlMs
        };
    }

    registerDevice(input = {}) {
        const now = new Date().toISOString();
        const deviceId = this.clean(input.deviceId || input.device_id || input.model || 'unknown');
        if (!Array.isArray(this.state.devices)) {
            this.state.devices = [];
        }

        let device = this.state.devices.find(item => item.deviceId === deviceId);
        if (!device) {
            device = {
                id: this.newId('dev'),
                deviceId,
                deviceSessionId: this.newId('ds'),
                registeredAt: now,
                firstSeenAt: now
            };
            this.state.devices.push(device);
        }

        Object.assign(device, {
            deviceId,
            deviceSessionId: this.clean(input.deviceSessionId) || device.deviceSessionId || this.newId('ds'),
            manufacturer: this.clean(input.manufacturer),
            model: this.clean(input.model),
            androidVersion: this.clean(input.androidVersion),
            appVersion: this.clean(input.appVersion),
            serverUrl: this.clean(input.serverUrl),
            city: this.clean(input.city),
            platform: this.clean(input.platform),
            relayNode: this.clean(input.relayNode),
            remoteAddress: this.clean(input.remoteAddress),
            commandServiceRunning: input.commandServiceRunning === undefined ? true : Boolean(input.commandServiceRunning),
            lastSeenAt: now,
            lastRegisteredAt: now,
            status: 'online'
        });
        this.saveState();
        return {
            ...device,
            dialogueMode: 'authenticated-long-poll',
            pollIntervalMs: 2000,
            serverTime: now
        };
    }

    touchDevice(input = {}) {
        const deviceId = this.clean(input.deviceId || input.device_id || input.model || 'unknown');
        if (!Array.isArray(this.state.devices)) {
            this.state.devices = [];
        }
        const now = new Date().toISOString();
        let device = this.state.devices.find(item => item.deviceId === deviceId);
        if (!device) {
            device = {
                id: this.newId('dev'),
                deviceId,
                deviceSessionId: this.clean(input.deviceSessionId) || this.newId('ds'),
                registeredAt: now,
                firstSeenAt: now
            };
            this.state.devices.push(device);
        }
        device.deviceSessionId = this.clean(input.deviceSessionId) || device.deviceSessionId || this.newId('ds');
        device.serverUrl = this.clean(input.serverUrl) || device.serverUrl || '';
        device.city = this.clean(input.city) || device.city || '';
        device.platform = this.clean(input.platform) || device.platform || '';
        device.relayNode = this.clean(input.relayNode) || device.relayNode || '';
        device.remoteAddress = this.clean(input.remoteAddress) || device.remoteAddress || '';
        device.commandServiceRunning = input.commandServiceRunning === undefined ? true : Boolean(input.commandServiceRunning);
        device.lastSeenAt = now;
        device.lastPollAt = input.poll ? now : device.lastPollAt || null;
        device.lastResultAt = input.result ? now : device.lastResultAt || null;
        device.status = 'online';
        return device;
    }

    decorateWorkflow(workflow = {}) {
        const cities = Array.isArray(workflow.cities) ? workflow.cities : [];
        const currentStats = {};
        let completed = 0;
        let total = 0;
        for (const city of cities) {
            const stats = this.countCityStats(city);
            const baseline = Number(workflow.baselines?.[city]?.total || 0);
            const target = Number(workflow.targets?.[city] || baseline);
            const current = Number(stats.total || 0);
            const cityTotal = Math.max(0, target - baseline);
            const cityCompleted = Math.max(0, Math.min(cityTotal, current - baseline));
            currentStats[city] = {
                ...stats,
                baselineRecords: baseline,
                targetRecords: target,
                addedRecords: Math.max(0, current - baseline),
                addedSnapshots: Math.max(0, current - baseline),
                targetIncrement: Math.max(0, target - baseline),
                remainingRecords: Math.max(0, target - current),
                progressPercent: cityTotal > 0 ? Math.min(100, Math.round((cityCompleted / cityTotal) * 100)) : 100
            };
            completed += cityCompleted;
            total += cityTotal;
        }

        return {
            ...workflow,
            currentStats,
            progress: {
                completed,
                total,
                remaining: Math.max(0, total - completed),
                percent: total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 100
            }
        };
    }

    enqueueCommand(input = {}) {
        const type = this.clean(input.type);
        if (!type) {
            throw new Error('command type required');
        }
        const inputPayload = input.payload && typeof input.payload === 'object' ? input.payload : {};
        const now = new Date().toISOString();
        const command = {
            id: input.id || this.newId('cmd'),
            type,
            deviceId: this.clean(input.deviceId) || '*',
            payload: this.decorateCommandPayload(type, inputPayload),
            workflowId: input.workflowId || null,
            status: 'pending',
            attempts: 0,
            leaseUntil: null,
            result: null,
            error: null,
            createdAt: now,
            updatedAt: now,
            dispatchedAt: null,
            completedAt: null
        };
        this.state.commands.push(command);
        this.saveState();
        return command;
    }

    pollCommand(deviceId = 'unknown', meta = {}) {
        this.advanceWorkflows();
        const now = Date.now();
        const actualDeviceId = this.clean(deviceId) || 'unknown';
        this.touchDevice({
            ...meta,
            deviceId: actualDeviceId,
            poll: true
        });
        for (const command of this.state.commands) {
            if (command.status === 'running' && command.leaseUntil && Date.parse(command.leaseUntil) < now) {
                command.status = 'pending';
                command.leaseUntil = null;
                command.updatedAt = new Date().toISOString();
            }
        }

        const command = this.state.commands.find(item => {
            if (item.status !== 'pending') {
                return false;
            }
            return item.deviceId === '*' || item.deviceId === actualDeviceId;
        });

        if (!command) {
            this.saveState();
            return null;
        }

        const dispatchedAt = new Date();
        command.status = 'running';
        command.deviceId = actualDeviceId;
        command.attempts = Number(command.attempts || 0) + 1;
        command.dispatchedAt = dispatchedAt.toISOString();
        command.leaseUntil = new Date(dispatchedAt.getTime() + this.leaseMs).toISOString();
        command.updatedAt = command.dispatchedAt;
        this.saveState();
        return command;
    }

    completeCommand(commandId, body = {}) {
        const command = this.state.commands.find(item => item.id === commandId);
        if (!command) {
            throw new Error(`command not found: ${commandId}`);
        }
        const ok = body.success !== false;
        if (body.deviceId || body.device_id) {
            this.touchDevice({
                deviceId: body.deviceId || body.device_id,
                deviceSessionId: body.deviceSessionId || body.device_session_id,
                result: true,
                commandServiceRunning: true
            });
        }
        command.status = ok ? 'succeeded' : 'failed';
        command.result = body.result || null;
        command.error = body.error || null;
        command.completedAt = new Date().toISOString();
        command.updatedAt = command.completedAt;
        command.leaseUntil = null;
        if (!ok && command.workflowId && this.retryOrFailWorkflowCommand(command)) {
            this.saveState();
            return command;
        }
        this.saveState();
        this.advanceWorkflows();
        return command;
    }

    startCityIncrementWorkflow(input = {}) {
        const cities = this.normalizeCities(input.cities);
        const targetIncrement = Math.max(1, Number(input.targetIncrement) || 100);
        const now = new Date().toISOString();
        const baselines = {};
        const targets = {};
        for (const city of cities) {
            const stats = this.countCityStats(city);
            baselines[city] = stats;
            targets[city] = Number(stats.total || 0) + targetIncrement;
        }

        const workflow = {
            id: this.newId('mwf'),
            type: 'city-increment',
            status: 'running',
            deviceId: this.clean(input.deviceId) || '*',
            cities,
            targetIncrement,
            baselines,
            targets,
            currentCityIndex: 0,
            landmarkCursor: {},
            pagesPerLandmark: Math.max(1, Number(input.pagesPerLandmark) || 90),
            minIntervalMs: Math.max(1000, Number(input.minIntervalMs) || 1800),
            maxIntervalMs: Math.max(1000, Number(input.maxIntervalMs) || 4200),
            noGrowthSeconds: Math.max(30, Number(input.noGrowthSeconds) || 120),
            detailEnrichmentEnabled: Boolean(input.detailEnrichmentEnabled),
            maxCommandRetries: Math.max(0, input.maxCommandRetries === undefined ? 2 : Number(input.maxCommandRetries) || 0),
            commandFailureCount: 0,
            createdAt: now,
            updatedAt: now,
            completedAt: null,
            error: null
        };

        this.state.workflows.push(workflow);
        this.saveState();
        this.advanceWorkflows();
        return workflow;
    }

    async submitIntent(input = {}) {
        const instruction = this.clean(input.instruction || input.text || input.prompt);
        if (!instruction) {
            throw new Error('instruction required');
        }

        const parsed = await this.parseIntentInstructionWithDcc(instruction, input);
        return this.executeParsedIntent(instruction, parsed, input);
    }

    async submitChatMessage(input = {}) {
        const instruction = this.clean(input.message || input.instruction || input.text || input.prompt);
        if (!instruction) {
            throw new Error('message required');
        }

        const now = new Date().toISOString();
        const session = this.ensureChatSession(input.sessionId, now);
        const userMessage = {
            id: this.newId('msg'),
            role: 'user',
            content: instruction,
            createdAt: now
        };
        session.messages.push(userMessage);

        let result;
        try {
            const parsed = await this.parseIntentInstructionWithDcc(instruction, {
                ...input,
                conversation: this.getDccConversationContext(session)
            });
            result = this.executeParsedIntent(instruction, parsed, input);
            const assistantMessage = {
                id: this.newId('msg'),
                role: 'assistant',
                content: parsed.reply || result.message || '已解析并下发到手机执行队列',
                createdAt: new Date().toISOString(),
                meta: {
                    kind: result.kind,
                    parseSource: parsed.parseSource,
                    dccError: parsed.dccError || null,
                    dccSkipped: parsed.dccSkipped || null,
                    commandId: result.command?.id || null,
                    workflowId: result.workflow?.id || null
                }
            };
            session.messages.push(assistantMessage);
            session.updatedAt = assistantMessage.createdAt;
            session.lastResult = result;
            this.saveState();
            return { session, result, assistantMessage };
        } catch (error) {
            const assistantMessage = {
                id: this.newId('msg'),
                role: 'assistant',
                content: `解析失败：${error.message}`,
                createdAt: new Date().toISOString(),
                meta: { error: error.message }
            };
            session.messages.push(assistantMessage);
            session.updatedAt = assistantMessage.createdAt;
            this.saveState();
            throw error;
        }
    }

    ensureChatSession(sessionId, now = new Date().toISOString()) {
        if (!Array.isArray(this.state.chatSessions)) {
            this.state.chatSessions = [];
        }

        const requestedId = this.clean(sessionId);
        let session = requestedId ? this.getChatSession(requestedId) : null;
        if (!session) {
            session = {
                id: requestedId || this.newId('chat'),
                title: '手机采集对话',
                messages: [],
                createdAt: now,
                updatedAt: now,
                lastResult: null
            };
            this.state.chatSessions.push(session);
        }
        if (!Array.isArray(session.messages)) {
            session.messages = [];
        }
        return session;
    }

    getDccConversationContext(session = {}) {
        return (Array.isArray(session.messages) ? session.messages : [])
            .slice(-10)
            .map(message => ({
                role: message.role,
                content: message.content,
                createdAt: message.createdAt
            }));
    }

    executeParsedIntent(instruction, parsed, input = {}) {
        if (parsed.action === 'abort-and-stop') {
            const aborted = this.abortActiveWorkflows(`interactive stop: ${instruction}`);
            const command = this.enqueueCommand({
                type: 'stop_collection',
                deviceId: input.deviceId,
                payload: { instruction }
            });
            return {
                kind: 'command',
                message: `已停止 ${aborted.workflows} 个工作流，并下发停止采集指令`,
                instruction,
                parsed,
                command,
                aborted
            };
        }

        if (parsed.action === 'workflow') {
            const workflow = this.startCityIncrementWorkflow({
                cities: parsed.cities,
                targetIncrement: parsed.targetIncrement,
                pagesPerLandmark: parsed.pagesPerLandmark,
                minIntervalMs: parsed.minIntervalMs,
                maxIntervalMs: parsed.maxIntervalMs,
                noGrowthSeconds: parsed.noGrowthSeconds,
                detailEnrichmentEnabled: parsed.detailEnrichmentEnabled,
                maxCommandRetries: parsed.maxCommandRetries,
                deviceId: input.deviceId
            });
            return {
                kind: 'workflow',
                message: `已创建手机采集工作流：${workflow.cities.join('、')}，每城新增 ${workflow.targetIncrement} 条价格/枪数快照`,
                instruction,
                parsed,
                workflow
            };
        }

        const command = this.enqueueCommand({
            type: parsed.commandType,
            deviceId: input.deviceId,
            payload: {
                ...parsed.payload,
                instruction
            }
        });
        return {
            kind: 'command',
            message: `已下发手机指令：${parsed.label || parsed.commandType}`,
            instruction,
            parsed,
            command
        };
    }

    advanceWorkflows() {
        let changed = false;
        for (const workflow of this.state.workflows) {
            if (workflow.status !== 'running') {
                continue;
            }
            if (this.hasActiveWorkflowCommand(workflow.id)) {
                continue;
            }
            const city = workflow.cities[workflow.currentCityIndex];
            if (!city) {
                workflow.status = 'succeeded';
                workflow.completedAt = new Date().toISOString();
                workflow.updatedAt = workflow.completedAt;
                changed = true;
                continue;
            }

            const currentStats = this.countCityStats(city);
            if (Number(currentStats.total || 0) >= Number(workflow.targets[city] || 0)) {
                workflow.currentCityIndex += 1;
                workflow.updatedAt = new Date().toISOString();
                changed = true;
                continue;
            }

            const landmarks = this.getCityLandmarkNames(city);
            const cursor = Number(workflow.landmarkCursor[city] || 0);
            if (cursor >= landmarks.length) {
                workflow.status = 'failed';
                workflow.error = `${city} landmarks exhausted before target reached`;
                workflow.completedAt = new Date().toISOString();
                workflow.updatedAt = workflow.completedAt;
                changed = true;
                continue;
            }

            const keyword = landmarks[cursor];
            const landmarkTarget = this.resolveLandmarkTarget(city, keyword);
            workflow.landmarkCursor[city] = cursor + 1;
            workflow.updatedAt = new Date().toISOString();
            this.state.commands.push({
                id: this.newId('cmd'),
                type: 'collect_landmark',
                deviceId: workflow.deviceId || '*',
                workflowId: workflow.id,
                status: 'pending',
                attempts: 0,
                leaseUntil: null,
                result: null,
                error: null,
                createdAt: workflow.updatedAt,
                updatedAt: workflow.updatedAt,
                dispatchedAt: null,
                completedAt: null,
                payload: {
                    city,
                    keyword,
                    lat: landmarkTarget.lat,
                    lng: landmarkTarget.lng,
                    coordinateSystem: landmarkTarget.coordinateSystem,
                    coordinateSource: landmarkTarget.coordinateSource,
                    targetRecords: workflow.targets[city],
                    baselineRecords: workflow.baselines[city]?.total || 0,
                    targetSnapshots: workflow.targets[city],
                    baselineSnapshots: workflow.baselines[city]?.total || 0,
                    targetIncrement: workflow.targetIncrement,
                    targetDistinct: null,
                    baselineDistinct: workflow.baselines[city]?.distinct || 0,
                    pagesPerLandmark: workflow.pagesPerLandmark,
                    minIntervalMs: workflow.minIntervalMs,
                    maxIntervalMs: workflow.maxIntervalMs,
                    noGrowthSeconds: workflow.noGrowthSeconds,
                    detailEnrichmentEnabled: workflow.detailEnrichmentEnabled
                }
            });
            changed = true;
        }
        if (changed) {
            this.saveState();
        }
    }

    hasActiveWorkflowCommand(workflowId) {
        return this.state.commands.some(command =>
            command.workflowId === workflowId
            && ['pending', 'running'].includes(command.status)
        );
    }

    abortActiveWorkflows(reason = 'aborted') {
        const now = new Date().toISOString();
        let workflowCount = 0;
        let commandCount = 0;
        for (const workflow of this.state.workflows) {
            if (workflow.status === 'running') {
                workflow.status = 'aborted';
                workflow.error = reason;
                workflow.completedAt = now;
                workflow.updatedAt = now;
                workflowCount += 1;
            }
        }
        for (const command of this.state.commands) {
            if (['pending', 'running'].includes(command.status) && command.workflowId) {
                command.status = 'aborted';
                command.error = reason;
                command.completedAt = now;
                command.updatedAt = now;
                command.leaseUntil = null;
                commandCount += 1;
            }
        }
        if (workflowCount > 0 || commandCount > 0) {
            this.saveState();
        }
        return { workflows: workflowCount, commands: commandCount };
    }

    parseIntentInstruction(instruction, input = {}) {
        const normalized = this.normalizeInstruction(instruction);
        const cities = this.extractCities(normalized, input.cities);
        const targetIncrement = this.extractTargetIncrement(normalized, input.targetIncrement);
        const pagesPerLandmark = this.extractPagesPerLandmark(normalized, input.pagesPerLandmark);
        const minIntervalMs = Math.max(1000, Number(input.minIntervalMs) || 1800);
        const maxIntervalMs = Math.max(minIntervalMs, Number(input.maxIntervalMs) || 4200);
        const noGrowthSeconds = Math.max(30, Number(input.noGrowthSeconds) || 120);
        const detailEnrichmentEnabled = input.detailEnrichmentEnabled === undefined
            ? /详情|补全|完整/.test(normalized) && !/不.*详情|关闭.*详情|不要.*补全/.test(normalized)
            : Boolean(input.detailEnrichmentEnabled);
        const maxCommandRetries = Math.max(0, input.maxCommandRetries === undefined ? 2 : Number(input.maxCommandRetries) || 0);

        if (/停止|结束|取消|停掉|中止|终止/.test(normalized)) {
            return { action: 'abort-and-stop', commandType: 'stop_collection', label: '停止采集' };
        }
        if (/状态|在线|连通|检查|查看手机|手机情况|是否运行/.test(normalized)) {
            return { action: 'command', commandType: 'status', label: '查看手机状态', payload: {} };
        }
        if (/读取当前|识别当前|当前页面|页面文字|可见文本/.test(normalized)) {
            return {
                action: 'command',
                commandType: 'collect_visible_text',
                label: '读取当前页面',
                payload: { limit: Number(input.limit) || 160 }
            };
        }
        if (/打开微信|启动微信|回到微信/.test(normalized)) {
            return {
                action: 'command',
                commandType: 'open_app',
                label: '打开微信',
                payload: { packageName: 'com.tencent.mm' }
            };
        }
        if (/返回|后退/.test(normalized)) {
            return { action: 'command', commandType: 'back', label: '返回上一页', payload: {} };
        }
        if (/下滑|滚动|滑动/.test(normalized) && !/采集|查询|获取/.test(normalized)) {
            return { action: 'command', commandType: 'scroll', label: '执行一次下滑', payload: {} };
        }

        if (/采集|查询|获取|开始|执行|切换|切到/.test(normalized)) {
            if (cities.length === 0) {
                throw new Error(`未识别到城市。支持城市：${this.getSupportedCities().join('、')}`);
            }

            const keyword = this.extractLandmarkKeyword(normalized, cities);
            const wantsLandmark = Boolean(input.keyword)
                || /地标|附近|周边|以.*为中心|为地标|定位到|切到/.test(normalized)
                || (keyword && cities.length === 1 && !/每个|各|分别|多城市/.test(normalized));
            if (wantsLandmark && cities.length === 1) {
                return {
                    action: 'command',
                    commandType: 'collect_landmark',
                    label: `采集地标 ${keyword || cities[0]}`,
                    payload: {
                        city: cities[0],
                        keyword: input.keyword || keyword || cities[0],
                        pagesPerLandmark,
                        minIntervalMs,
                        maxIntervalMs,
                        noGrowthSeconds,
                        detailEnrichmentEnabled,
                        targetRecords: Number(input.targetRecords) || 0,
                        baselineRecords: Number(input.baselineRecords) || 0,
                        targetDistinct: Number(input.targetDistinct) || 0,
                        baselineDistinct: Number(input.baselineDistinct) || 0
                    }
                };
            }

            return {
                action: 'workflow',
                cities,
                targetIncrement,
                pagesPerLandmark,
                minIntervalMs,
                maxIntervalMs,
                noGrowthSeconds,
                detailEnrichmentEnabled,
                maxCommandRetries
            };
        }

        throw new Error('未能识别需求。可以输入：查看手机状态、停止采集、读取当前页面、查询上海北京广州每个100个。');
    }

    async parseIntentInstructionWithDcc(instruction, input = {}) {
        const deterministic = this.parseDeterministicRuleIntent(instruction, input);
        if (deterministic) {
            return {
                ...deterministic,
                parseSource: 'rule-deterministic',
                dccSkipped: 'deterministic_command'
            };
        }

        if (!this.aiFeaturesEnabled || !this.dcc.enabled) {
            return {
                ...this.parseIntentInstruction(instruction, input),
                parseSource: this.aiFeaturesEnabled ? 'rule' : 'rule-ai-disabled'
            };
        }

        try {
            const parsed = await this.parseIntentWithDcc(instruction, input);
            return {
                ...parsed,
                parseSource: 'dcc'
            };
        } catch (error) {
            return {
                ...this.parseIntentInstruction(instruction, input),
                parseSource: 'rule-fallback',
                dccError: error.message
            };
        }
    }

    parseDeterministicRuleIntent(instruction, input = {}) {
        const normalized = this.normalizeInstruction(instruction);
        if (/停止|结束|取消|停掉|中止|终止/.test(normalized)) {
            return { action: 'abort-and-stop', commandType: 'stop_collection', label: '停止采集' };
        }
        if (/状态|在线|连通|检查|查看手机|手机情况|是否运行/.test(normalized)) {
            return { action: 'command', commandType: 'status', label: '查看手机状态', payload: {} };
        }
        if (/读取当前|识别当前|当前页面|页面文字|可见文本/.test(normalized)) {
            return {
                action: 'command',
                commandType: 'collect_visible_text',
                label: '读取当前页面',
                payload: { limit: Number(input.limit) || 160 }
            };
        }
        if (/打开微信|启动微信|回到微信/.test(normalized)) {
            return {
                action: 'command',
                commandType: 'open_app',
                label: '打开微信',
                payload: { packageName: 'com.tencent.mm' }
            };
        }
        if (/返回|后退/.test(normalized)) {
            return { action: 'command', commandType: 'back', label: '返回上一页', payload: {} };
        }
        if (/下滑|滚动|滑动/.test(normalized) && !/采集|查询|获取/.test(normalized)) {
            return { action: 'command', commandType: 'scroll', label: '执行一次下滑', payload: {} };
        }
        return null;
    }

    async parseIntentWithDcc(instruction, input = {}) {
        const payload = {
            task: 'data_for_didi_mobile_intent_parse',
            instruction,
            context: {
                supportedCities: this.getSupportedCities(),
                supportedCommands: [
                    'status',
                    'collect_visible_text',
                    'open_app',
                    'back',
                    'scroll',
                    'stop_collection',
                    'collect_landmark',
                    'set_mock_location'
                ],
                defaults: this.getInteractionConfig().defaults,
                conversation: Array.isArray(input.conversation) ? input.conversation : [],
                input
            },
            outputSchema: {
                action: 'workflow | command | abort-and-stop',
                commandType: 'status | collect_visible_text | open_app | back | scroll | stop_collection | collect_landmark | set_mock_location',
                reply: '用于展示给用户的简短中文回复',
                cities: ['上海'],
                targetIncrement: 100,
                pagesPerLandmark: 90,
                minIntervalMs: 1800,
                maxIntervalMs: 4200,
                noGrowthSeconds: 120,
                detailEnrichmentEnabled: false,
                payload: {}
            }
        };
        const response = await this.requestDcc(payload);
        return this.normalizeDccIntentResponse(response, instruction, input);
    }

    async requestDcc(payload) {
        if (this.dcc.url) {
            return this.postJson(this.dcc.url, payload, this.dcc.timeoutMs);
        }
        if (this.dcc.command) {
            return this.postCommand(this.dcc.command, this.buildDccPrompt(payload), this.dcc.timeoutMs);
        }
        throw new Error('dcc is not configured');
    }

    buildDccPrompt(payload) {
        return [
            '你是 data_for_didi 手机采集控制 agent。',
            '你的任务是把用户自然语言解析为手机采集命令或工作流，不要执行真实采集，也不要调用外部工具。',
            '只能输出一个 JSON 对象，不要 Markdown，不要解释。',
            'JSON 字段要求：',
            '- action: workflow | command | abort-and-stop',
            '- commandType: status | collect_visible_text | open_app | back | scroll | stop_collection | collect_landmark | set_mock_location',
            '- reply: 简短中文回复，用于展示给用户',
            '- cities: workflow 或 collect_landmark 涉及的城市数组',
            '- targetIncrement: 每个城市本次新增价格/枪数快照数，默认 100',
            '- pagesPerLandmark/minIntervalMs/maxIntervalMs/noGrowthSeconds/detailEnrichmentEnabled/maxCommandRetries',
            '- payload: 单条 command 的参数。',
            '计数口径必须是“本次新增快照数”，不是最终总量，也不是去重场站总数。重复场站在不同时间采到价格/枪数时仍算新增快照。',
            '如果用户只是问状态、读取当前页面、返回、下滑、打开微信或停止，必须输出 action="command" 或 action="abort-and-stop"，不要输出 workflow，也不要附带 cities。',
            '只支持 context.supportedCities 和 context.supportedCommands 中列出的城市/命令。',
            '输入如下：',
            JSON.stringify(payload)
        ].join('\n');
    }

    normalizeDccIntentResponse(response, instruction, input = {}) {
        const unwrapped = this.unwrapDccPayload(response);
        if (!unwrapped || typeof unwrapped !== 'object' || Array.isArray(unwrapped)) {
            throw new Error('dcc returned invalid intent payload');
        }

        const candidate = unwrapped.intent || unwrapped.parsed || unwrapped.command || unwrapped.workflow || unwrapped;
        const normalizedInstruction = this.normalizeInstruction(instruction);
        const actionText = this.clean(candidate.action || candidate.kind || candidate.intent || candidate.type).toLowerCase();
        const commandType = this.clean(candidate.commandType || candidate.command_type || candidate.command || candidate.type);
        const payload = candidate.payload && typeof candidate.payload === 'object' ? candidate.payload : {};
        const mappedCommandType = this.mapDccCommandType(commandType || actionText);

        if (['stop', 'abort', 'cancel', 'abort-and-stop', 'stop_collection'].includes(actionText)
            || mappedCommandType === 'stop_collection') {
            return { action: 'abort-and-stop', commandType: 'stop_collection', label: '停止采集', reply: candidate.reply || '已准备停止当前采集任务' };
        }

        const explicitWorkflow = ['workflow', 'city-increment', 'city_increment'].includes(actionText);
        const candidateCities = candidate.cities || payload.cities || [];
        const hasCandidateCities = Array.isArray(candidateCities)
            ? candidateCities.length > 0
            : Boolean(this.clean(candidateCities));
        const isWorkflow = explicitWorkflow || (!mappedCommandType && hasCandidateCities);
        if (isWorkflow) {
            const cities = this.normalizeCities(candidate.cities || payload.cities || input.cities);
            return {
                action: 'workflow',
                cities,
                targetIncrement: this.positiveNumber(candidate.targetIncrement ?? candidate.target_increment ?? payload.targetIncrement ?? input.targetIncrement, this.extractTargetIncrement(normalizedInstruction, input.targetIncrement)),
                pagesPerLandmark: this.positiveNumber(candidate.pagesPerLandmark ?? candidate.pages_per_landmark ?? payload.pagesPerLandmark ?? input.pagesPerLandmark, this.extractPagesPerLandmark(normalizedInstruction, input.pagesPerLandmark)),
                minIntervalMs: Math.max(1000, Number(candidate.minIntervalMs ?? payload.minIntervalMs ?? input.minIntervalMs) || 1800),
                maxIntervalMs: Math.max(1000, Number(candidate.maxIntervalMs ?? payload.maxIntervalMs ?? input.maxIntervalMs) || 4200),
                noGrowthSeconds: Math.max(30, Number(candidate.noGrowthSeconds ?? payload.noGrowthSeconds ?? input.noGrowthSeconds) || 120),
                detailEnrichmentEnabled: Boolean(candidate.detailEnrichmentEnabled ?? payload.detailEnrichmentEnabled ?? input.detailEnrichmentEnabled ?? false),
                maxCommandRetries: Math.max(0, Number(candidate.maxCommandRetries ?? payload.maxCommandRetries ?? input.maxCommandRetries ?? 2) || 0),
                reply: candidate.reply || payload.reply || ''
            };
        }

        if (!mappedCommandType) {
            throw new Error(`dcc returned unsupported command: ${commandType || actionText}`);
        }

        if (mappedCommandType === 'collect_landmark') {
            const cities = this.normalizeCities(candidate.cities || payload.cities || candidate.city || payload.city || input.cities);
            return {
                action: 'command',
                commandType: 'collect_landmark',
                label: `采集地标 ${payload.keyword || candidate.keyword || cities[0]}`,
                reply: candidate.reply || payload.reply || '',
                payload: {
                    ...payload,
                    city: this.clean(candidate.city || payload.city) || cities[0],
                    keyword: this.clean(candidate.keyword || payload.keyword || input.keyword) || cities[0],
                    pagesPerLandmark: this.positiveNumber(candidate.pagesPerLandmark ?? payload.pagesPerLandmark ?? input.pagesPerLandmark, this.extractPagesPerLandmark(normalizedInstruction, input.pagesPerLandmark)),
                    minIntervalMs: Math.max(1000, Number(candidate.minIntervalMs ?? payload.minIntervalMs ?? input.minIntervalMs) || 1800),
                    maxIntervalMs: Math.max(1000, Number(candidate.maxIntervalMs ?? payload.maxIntervalMs ?? input.maxIntervalMs) || 4200),
                    noGrowthSeconds: Math.max(30, Number(candidate.noGrowthSeconds ?? payload.noGrowthSeconds ?? input.noGrowthSeconds) || 120),
                    detailEnrichmentEnabled: Boolean(candidate.detailEnrichmentEnabled ?? payload.detailEnrichmentEnabled ?? input.detailEnrichmentEnabled ?? false)
                }
            };
        }

        return {
            action: 'command',
            commandType: mappedCommandType,
            label: candidate.label || payload.label || mappedCommandType,
            reply: candidate.reply || payload.reply || '',
            payload
        };
    }

    unwrapDccPayload(response) {
        let payload = response;
        for (const key of ['data', 'result', 'output']) {
            if (payload && typeof payload === 'object' && payload[key] !== undefined) {
                payload = payload[key];
            }
        }
        if (typeof payload === 'string') {
            const trimmed = payload.trim();
            try {
                return JSON.parse(trimmed);
            } catch (error) {
                const candidates = this.extractJsonObjects(trimmed);
                if (candidates.length > 0) {
                    return candidates[candidates.length - 1];
                }
                throw new Error('dcc returned non-json text');
            }
        }
        return payload;
    }

    mapDccCommandType(value) {
        const normalized = this.clean(value).toLowerCase().replace(/[-\s]/g, '_');
        const aliases = {
            status: 'status',
            phone_status: 'status',
            visible_text: 'collect_visible_text',
            collect_visible_text: 'collect_visible_text',
            read_page: 'collect_visible_text',
            open_app: 'open_app',
            open_wechat: 'open_app',
            back: 'back',
            scroll: 'scroll',
            swipe: 'scroll',
            stop: 'stop_collection',
            stop_collection: 'stop_collection',
            collect_landmark: 'collect_landmark',
            landmark: 'collect_landmark',
            set_mock_location: 'set_mock_location',
            mock_location: 'set_mock_location',
            location: 'set_mock_location'
        };
        return aliases[normalized] || '';
    }

    postJson(url, payload, timeoutMs) {
        return new Promise((resolve, reject) => {
            let parsedUrl;
            try {
                parsedUrl = new URL(url);
            } catch (error) {
                reject(new Error(`invalid dcc url: ${url}`));
                return;
            }
            const body = JSON.stringify(payload);
            const client = parsedUrl.protocol === 'https:' ? https : http;
            const headers = {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body)
            };
            if (this.dcc.authHeader && this.dcc.authToken) {
                headers[this.dcc.authHeader] = this.dcc.authToken;
            }
            const request = client.request({
                method: 'POST',
                hostname: parsedUrl.hostname,
                port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
                path: `${parsedUrl.pathname}${parsedUrl.search}`,
                headers,
                timeout: timeoutMs
            }, (response) => {
                const chunks = [];
                response.on('data', chunk => chunks.push(chunk));
                response.on('end', () => {
                    const text = Buffer.concat(chunks).toString('utf8');
                    if (response.statusCode < 200 || response.statusCode >= 300) {
                        reject(new Error(`dcc http ${response.statusCode}: ${text.slice(0, 200)}`));
                        return;
                    }
                    try {
                        resolve(text ? JSON.parse(text) : {});
                    } catch (error) {
                        resolve(text);
                    }
                });
            });
            request.on('timeout', () => request.destroy(new Error('dcc request timeout')));
            request.on('error', reject);
            request.write(body);
            request.end();
        });
    }

    postCommand(command, stdinText, timeoutMs) {
        return new Promise((resolve, reject) => {
            const child = spawn(command, {
                cwd: this.dcc.cwd || process.cwd(),
                env: {
                    ...process.env,
                    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'
                },
                shell: true,
                stdio: ['pipe', 'pipe', 'pipe']
            });
            const stdout = [];
            const stderr = [];
            let settled = false;
            const timer = setTimeout(() => {
                if (settled) {
                    return;
                }
                settled = true;
                child.kill('SIGTERM');
                reject(new Error('dcc command timeout'));
            }, timeoutMs);

            child.stdout.on('data', chunk => stdout.push(chunk));
            child.stderr.on('data', chunk => stderr.push(chunk));
            child.on('error', error => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timer);
                reject(error);
            });
            child.on('close', code => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timer);
                const out = Buffer.concat(stdout).toString('utf8');
                const err = Buffer.concat(stderr).toString('utf8');
                if (code !== 0) {
                    reject(new Error(`dcc command exited ${code}: ${(err || out).slice(0, 300)}`));
                    return;
                }
                try {
                    resolve(this.parseDccCommandOutput(out));
                } catch (error) {
                    reject(error);
                }
            });
            child.stdin.end(stdinText);
        });
    }

    parseDccCommandOutput(text) {
        const trimmed = String(text || '').trim();
        if (!trimmed) {
            throw new Error('dcc command returned empty output');
        }
        try {
            return JSON.parse(trimmed);
        } catch (error) {
            const candidates = this.extractJsonObjects(trimmed);
            if (candidates.length === 0) {
                throw new Error(`dcc command returned non-json output: ${trimmed.slice(0, 200)}`);
            }
            return candidates[candidates.length - 1];
        }
    }

    extractJsonObjects(text) {
        const source = String(text || '');
        const objects = [];
        let start = -1;
        let depth = 0;
        let inString = false;
        let escaped = false;

        for (let index = 0; index < source.length; index += 1) {
            const char = source[index];
            if (inString) {
                if (escaped) {
                    escaped = false;
                } else if (char === '\\') {
                    escaped = true;
                } else if (char === '"') {
                    inString = false;
                }
                continue;
            }

            if (char === '"') {
                inString = true;
                continue;
            }
            if (char === '{') {
                if (depth === 0) {
                    start = index;
                }
                depth += 1;
                continue;
            }
            if (char !== '}' || depth === 0) {
                continue;
            }

            depth -= 1;
            if (depth !== 0 || start < 0) {
                continue;
            }

            const candidate = source.slice(start, index + 1);
            start = -1;
            try {
                objects.push(JSON.parse(candidate));
            } catch (error) {
                // Ignore non-JSON brace blocks from logs and keep scanning.
            }
        }
        return objects;
    }

    normalizeInstruction(value) {
        return String(value || '')
            .replace(/[，、；;]/g, ',')
            .replace(/\s+/g, '')
            .replace(/市/g, '')
            .trim();
    }

    extractCities(instruction, rawCities) {
        const explicit = this.normalizeCities(rawCities || []);
        if ((Array.isArray(rawCities) && rawCities.length > 0) || (typeof rawCities === 'string' && rawCities.trim())) {
            return explicit;
        }
        const cities = this.getSupportedCities().filter(city => instruction.includes(city));
        return Array.from(new Set(cities));
    }

    extractTargetIncrement(instruction, fallback) {
        if (Number(fallback) > 0) {
            return Math.max(1, Number(fallback));
        }
        const patterns = [
            /每(?:个)?(?:城市)?(?:新增|采集|查询|获取|大概|约)?(\d+)(?:个|条|座|场站|站)?/,
            /(?:新增|采集|查询|获取|大概|约)(\d+)(?:个|条|座|场站|站)/,
            /(\d+)(?:个|条|座|场站|站)/
        ];
        for (const pattern of patterns) {
            const match = instruction.match(pattern);
            if (match) {
                return Math.max(1, Number(match[1]));
            }
        }
        return 100;
    }

    extractPagesPerLandmark(instruction, fallback) {
        if (Number(fallback) > 0) {
            return Math.max(1, Number(fallback));
        }
        const match = instruction.match(/(?:下滑|滑动|滚动)(\d+)(?:次|页)?/);
        if (match) {
            return Math.max(1, Number(match[1]));
        }
        return 90;
    }

    extractLandmarkKeyword(instruction, cities) {
        for (const city of cities) {
            const known = this.getCityLandmarkNames(city)
                .find(keyword => instruction.includes(keyword.replace(/市/g, '')));
            if (known) {
                return known;
            }
        }
        const quoted = instruction.match(/[“"']([^“”"']{2,30})[”"']/);
        if (quoted) {
            return quoted[1];
        }
        if (cities.length === 1) {
            const city = cities[0];
            const match = instruction.match(new RegExp(`${city}([^,，。；;\\s]{2,24})`));
            if (match) {
                const keyword = `${city}${match[1]}`
                    .replace(/(采集|查询|获取|开始|执行|切换|切到|场站|数据|价格|新增|每个|大概|左右|附近|周边|地标|为中心|为地标|定位到).*/g, '')
                    .trim();
                if (keyword.length >= city.length + 2) {
                    return keyword;
                }
            }
        }
        return '';
    }

    retryOrFailWorkflowCommand(command) {
        const workflow = this.state.workflows.find(item => item.id === command.workflowId);
        if (!workflow || workflow.status !== 'running') {
            return false;
        }
        workflow.commandFailureCount = Number(workflow.commandFailureCount || 0) + 1;
        const payload = command.payload && typeof command.payload === 'object' ? command.payload : {};
        const retryCount = Number(payload.retryCount || 0);
        const maxRetries = Math.max(0, Number(workflow.maxCommandRetries || 0));
        const now = new Date().toISOString();
        workflow.updatedAt = now;
        if (retryCount < maxRetries) {
            this.state.commands.push({
                id: this.newId('cmd'),
                type: command.type,
                deviceId: workflow.deviceId || command.deviceId || '*',
                workflowId: workflow.id,
                status: 'pending',
                attempts: 0,
                leaseUntil: null,
                result: null,
                error: null,
                createdAt: now,
                updatedAt: now,
                dispatchedAt: null,
                completedAt: null,
                payload: {
                    ...this.decorateCommandPayload(command.type, payload),
                    retryCount: retryCount + 1,
                    retryOfCommandId: command.id
                }
            });
            return true;
        }

        workflow.status = 'failed';
        workflow.error = `workflow command failed after ${maxRetries + 1} attempts: ${payload.city || ''} ${payload.keyword || ''} ${command.error || ''}`.trim();
        workflow.completedAt = now;
        return true;
    }

    normalizeCities(cities) {
        const list = Array.isArray(cities) ? cities : String(cities || '').split(/[,，\s]+/);
        const normalized = Array.from(new Set(list.map(city => this.clean(city)).filter(Boolean)));
        const unsupported = normalized.find(city => !this.landmarkConfig.cities[city]);
        if (unsupported) {
            throw new Error(`unsupported city for mobile workflow: ${unsupported}`);
        }
        return normalized.length > 0 ? normalized : ['上海', '北京', '广州'];
    }

    getSupportedCities() {
        return Object.keys(this.landmarkConfig.cities);
    }

    getCityLandmarkNames(city) {
        return (this.landmarkConfig.cities[city]?.landmarks || []).map(landmark => landmark.name);
    }

    decorateCommandPayload(type, payload = {}) {
        if (type === 'collect_landmark') {
            return this.decorateLandmarkPayload(payload);
        }
        if (type === 'set_mock_location') {
            return this.decorateMockLocationPayload(payload);
        }
        return payload;
    }

    decorateMockLocationPayload(payload = {}) {
        const lat = Number(payload.lat);
        const lng = Number(payload.lng);
        if (!isValidCoordinate(lat, lng)) {
            throw new Error('set_mock_location requires valid lat/lng');
        }
        const providerCoordinate = normalizeProviderCoordinate(lat, lng, payload.coordinateSystem);
        const city = this.clean(payload.city);
        const keyword = this.clean(payload.keyword || payload.name || city || '自定义位置');
        const accuracy = Number(payload.accuracy);
        return {
            ...payload,
            city,
            keyword,
            lat: providerCoordinate.lat,
            lng: providerCoordinate.lng,
            accuracy: Number.isFinite(accuracy) && accuracy > 0 && accuracy <= 1000 ? accuracy : 20,
            coordinateSystem: 'WGS84',
            inputLat: lat,
            inputLng: lng,
            inputCoordinateSystem: providerCoordinate.sourceSystem,
            coordinateTransform: providerCoordinate.transform,
            coordinateSource: this.clean(payload.coordinateSource) || 'operator_app_manual'
        };
    }

    decorateLandmarkPayload(payload = {}) {
        const city = this.clean(payload.city);
        const keyword = this.clean(payload.keyword) || city;
        const explicitLat = Number(payload.lat);
        const explicitLng = Number(payload.lng);
        if (isValidCoordinate(explicitLat, explicitLng)) {
            const providerCoordinate = normalizeProviderCoordinate(explicitLat, explicitLng, payload.coordinateSystem);
            return {
                ...payload,
                city,
                keyword,
                lat: providerCoordinate.lat,
                lng: providerCoordinate.lng,
                coordinateSystem: 'WGS84',
                inputLat: explicitLat,
                inputLng: explicitLng,
                inputCoordinateSystem: providerCoordinate.sourceSystem,
                coordinateTransform: providerCoordinate.transform,
                coordinateSource: this.clean(payload.coordinateSource) || 'explicit_payload',
            };
        }
        const target = this.resolveLandmarkTarget(city, keyword);
        return {
            ...payload,
            city,
            keyword,
            lat: target.lat,
            lng: target.lng,
            coordinateSystem: target.coordinateSystem,
            coordinateSource: target.coordinateSource,
        };
    }

    resolveLandmarkTarget(city, keyword) {
        const normalizedCity = this.clean(city);
        const normalizedKeyword = this.clean(keyword) || normalizedCity;
        const cityConfig = this.landmarkConfig.cities[normalizedCity];
        if (!cityConfig) {
            throw new Error(`unsupported city for mobile landmark: ${normalizedCity || 'unknown'}`);
        }
        if (!normalizedKeyword || normalizePlaceName(normalizedKeyword) === normalizePlaceName(normalizedCity)) {
            return {
                ...cityConfig.center,
            };
        }
        const landmark = cityConfig.landmarkByName[normalizedKeyword]
            || cityConfig.landmarkByNormalizedName[normalizePlaceName(normalizedKeyword)];
        if (landmark) {
            return {
                lat: landmark.lat,
                lng: landmark.lng,
                coordinateSystem: landmark.coordinateSystem,
                coordinateSource: landmark.coordinateSource,
            };
        }
        throw new Error(`missing configured coordinates for mobile landmark: ${normalizedCity} ${normalizedKeyword}`.trim());
    }

    positiveNumber(value, fallback) {
        const number = Number(value);
        return Number.isFinite(number) && number > 0 ? Math.max(1, number) : fallback;
    }

    clean(value) {
        return String(value || '').trim();
    }

    newId(prefix) {
        return `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    }
}

module.exports = MobileCommandService;
module.exports.loadMobileLandmarkConfig = loadMobileLandmarkConfig;
module.exports.normalizeMobileLandmarkConfig = normalizeMobileLandmarkConfig;
