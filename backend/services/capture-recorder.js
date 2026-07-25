const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const os = require('os');

class CaptureRecorderService {
    constructor(options = {}) {
        this.projectRoot = options.projectRoot || path.join(__dirname, '../..');
        this.dataDir = options.dataDir || path.join(this.projectRoot, 'data/capture-sessions');
        this.scriptPath = options.scriptPath || path.join(this.projectRoot, 'scripts/mitm-har-dump.py');
        this.configuredBin = this.clean(options.bin);
        this.listenHost = this.clean(options.listenHost) || '0.0.0.0';
        this.listenPort = Math.max(1, Number(options.listenPort) || 8899);
        this.defaultFilters = this.normalizeFilters(options.filters || {
            hosts: options.filterHosts || '',
            ips: options.filterIps || ''
        });
        this.activeProcess = null;
        this.activeSession = null;
        fs.mkdirSync(this.dataDir, { recursive: true });
    }

    getStatus() {
        const binary = this.resolveBinary();
        return {
            available: Boolean(binary && fs.existsSync(this.scriptPath)),
            binary,
            scriptPath: this.scriptPath,
            listenHost: this.listenHost,
            listenPort: this.listenPort,
            defaultFilters: this.defaultFilters,
            activeSession: this.getActiveSession(),
            recentSessions: this.listSessions(20)
        };
    }

    startSession(input = {}) {
        const active = this.getActiveSession();
        if (active?.status === 'running') {
            return { ...active, reused: true };
        }

        // 检测端口占用：杀掉残留的 mitmdump 进程
        const listenPort = Math.max(1, Number(input.listenPort) || this.listenPort);
        try {
            const result = spawnSync('lsof', ['-i', `:${listenPort}`, '-t'], { timeout: 3000 });
            const pids = String(result.stdout || '').trim().split('\n').filter(Boolean);
            if (pids.length > 0) {
                for (const pid of pids) {
                    try { process.kill(Number(pid), 'SIGKILL'); } catch (_) {}
                }
                // 等待端口释放
                const deadline = Date.now() + 3000;
                while (Date.now() < deadline) {
                    const check = spawnSync('lsof', ['-i', `:${listenPort}`, '-t'], { timeout: 2000 });
                    if (!String(check.stdout || '').trim()) break;
                    require('util').promisify(setTimeout)(300);
                }
            }
        } catch (_) {}

        const binary = this.resolveBinary();
        if (!binary) {
            const error = new Error('mitmdump not found; install mitmproxy or set CAPTURE_RECORDER_BIN');
            error.statusCode = 503;
            throw error;
        }
        if (!fs.existsSync(this.scriptPath)) {
            const error = new Error(`capture recorder script not found: ${this.scriptPath}`);
            error.statusCode = 503;
            throw error;
        }

        const now = new Date().toISOString();
        const id = `capture-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
        const sessionDir = path.join(this.dataDir, id);
        fs.mkdirSync(sessionDir, { recursive: true });
        const harPath = path.join(sessionDir, 'session.har');
        const logPath = path.join(sessionDir, 'mitmdump.log');
        const statsPath = path.join(sessionDir, 'capture-stats.json');
        const metaPath = path.join(sessionDir, 'session.json');
        const listenHost = this.clean(input.listenHost) || this.listenHost;
        const filters = this.normalizeFilters(input.filters || {
            hosts: input.filterHosts || input.hosts || input.domains || '',
            ips: input.filterIps || input.ips || ''
        });
        const activeFilters = {
            hosts: filters.hosts.length > 0 ? filters.hosts : this.defaultFilters.hosts,
            ips: filters.ips.length > 0 ? filters.ips : this.defaultFilters.ips
        };
        const trafficPolicy = this.normalizeTrafficPolicy(input.trafficPolicy || input.policy || {});

        const session = {
            id,
            status: 'running',
            startedAt: now,
            endedAt: null,
            listenHost,
            listenPort,
            harPath,
            logPath,
            statsPath,
            metaPath,
            label: this.clean(input.label) || 'system-capture',
            scope: this.clean(input.scope) || 'manual-capture',
            platforms: Array.isArray(input.platforms) ? input.platforms : [],
            cities: Array.isArray(input.cities) ? input.cities : [],
            targets: Array.isArray(input.targets) ? input.targets : [],
            filters: activeFilters,
            trafficPolicy,
            systemProxy: {
                requested: Boolean(input.manageSystemProxy || input.autoSystemProxy || input.configureSystemProxy),
                enabled: false,
                restored: false,
                services: [],
                errors: []
            },
            pid: null,
            exitCode: null,
            exitSignal: null,
            stopRequested: false,
            error: null
        };
        this.writeSessionMeta(session);

        // Upstream proxy: route outbound traffic through specified proxy
        const upstreamProxy = this.clean(input.upstreamProxy || '');
        const args = [
            '--listen-host', listenHost,
            '--listen-port', String(listenPort),
            '--set', 'block_global=false',
            ...(upstreamProxy ? ['--mode', 'upstream:' + upstreamProxy] : []),
            '-s', this.scriptPath,
            '--set', `data_for_didi_har_path=${harPath}`,
            '--set', `data_for_didi_stats_path=${statsPath}`,
            '--set', `data_for_didi_filter_hosts=${activeFilters.hosts.join(',')}`,
            '--set', `data_for_didi_filter_ips=${activeFilters.ips.join(',')}`,
            '--set', `data_for_didi_block_hosts=${trafficPolicy.blockHosts.join(',')}`,
            '--set', `data_for_didi_block_url_keywords=${trafficPolicy.blockUrlKeywords.join(',')}`,
            '--set', `data_for_didi_allow_url_keywords=${trafficPolicy.allowUrlKeywords.join(',')}`
        ];

        // Location override: request-level override for target mini-program APIs.
        const overrideCity = String(input.overrideCity || input.city || '').trim();
        const overrideLat = Number(input.overrideLat || input.lat || 0);
        const overrideLng = Number(input.overrideLng || input.lng || 0);
        const hasCoordinateOverride = Number.isFinite(overrideLat)
            && Number.isFinite(overrideLng)
            && overrideLat !== 0
            && overrideLng !== 0;
        const hasLocationOverride = Boolean(overrideCity || hasCoordinateOverride);
        const locationOverrideScript = path.join(this.projectRoot, 'scripts/mitm-location-override.py');
        if (hasLocationOverride && fs.existsSync(locationOverrideScript)) {
            const overrideLabel = overrideCity || 'custom';
            args.push('-s', locationOverrideScript);
            args.push('--set', `data_for_didi_override_city=${overrideLabel}`);
            if (hasCoordinateOverride) {
                args.push('--set', `data_for_didi_override_lat=${overrideLat}`);
                args.push('--set', `data_for_didi_override_lng=${overrideLng}`);
            }
            session.locationOverride = {
                city: overrideLabel,
                lat: hasCoordinateOverride ? overrideLat : 0,
                lng: hasCoordinateOverride ? overrideLng : 0
            };
        }
        if (upstreamProxy) session.upstreamProxy = upstreamProxy;
        const child = spawn(binary, args, {
            cwd: this.projectRoot,
            env: { ...process.env },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        const logStream = fs.createWriteStream(logPath, { flags: 'a' });
        child.stdout.on('data', chunk => logStream.write(chunk));
        child.stderr.on('data', chunk => logStream.write(chunk));
        child.on('error', error => {
            session.status = 'failed';
            session.endedAt = new Date().toISOString();
            session.error = error.message;
            session.systemProxy = this.restoreSystemProxy(session.systemProxy);
            this.writeSessionMeta(session);
        });
        child.on('exit', (code, signal) => {
            const intentionalStop = session.stopRequested || signal === 'SIGTERM';
            session.status = intentionalStop || code === 0 ? 'stopped' : 'failed';
            session.endedAt = new Date().toISOString();
            session.exitCode = code;
            session.exitSignal = signal || null;
            session.systemProxy = this.restoreSystemProxy(session.systemProxy);
            this.writeSessionMeta(session);
            if (this.activeSession?.id === session.id) {
                this.activeSession = null;
                this.activeProcess = null;
            }
            logStream.end();
        });

        session.pid = child.pid;
        this.activeProcess = child;
        this.activeSession = session;
        if (session.systemProxy.requested) {
            session.systemProxy = this.enableSystemProxy(listenPort, input.proxyServices);
        }
        this.writeSessionMeta(session);
        return this.decorateSession(session);
    }

    stopSession() {
        const active = this.getActiveSession();
        if (!active || active.status !== 'running' || !this.activeProcess) {
            return {
                running: false,
                message: 'no active capture session',
                recentSessions: this.listSessions(5)
            };
        }

        this.activeSession.status = 'stopping';
        this.activeSession.endedAt = new Date().toISOString();
        this.activeSession.stopRequested = true;
        this.activeSession.systemProxy = this.restoreSystemProxy(this.activeSession.systemProxy);
        this.writeSessionMeta(this.activeSession);
        this.activeProcess.kill('SIGTERM');
        return this.decorateSession(this.activeSession);
    }

    readSession(id) {
        const sessionId = this.clean(id);
        if (!sessionId) {
            return null;
        }
        if (this.activeSession?.id === sessionId) {
            return this.decorateSession(this.activeSession);
        }
        const metaPath = path.join(this.dataDir, sessionId, 'session.json');
        if (!fs.existsSync(metaPath)) {
            return null;
        }
        try {
            return this.decorateSession(JSON.parse(fs.readFileSync(metaPath, 'utf8')));
        } catch (error) {
            return null;
        }
    }

    async waitForSession(id, options = {}) {
        const timeoutMs = Math.max(0, Number(options.timeoutMs) || 5000);
        const intervalMs = Math.max(50, Number(options.intervalMs) || 200);
        const startedAt = Date.now();
        let latest = this.readSession(id);

        while (Date.now() - startedAt < timeoutMs) {
            latest = this.readSession(id) || latest;
            if (latest && !['running', 'stopping'].includes(latest.status)) {
                return latest;
            }
            await this.sleep(intervalMs);
        }

        return latest || this.readSession(id);
    }

    getActiveSession() {
        if (!this.activeSession) {
            return null;
        }
        if (this.activeProcess?.exitCode !== null) {
            return null;
        }
        return this.decorateSession(this.activeSession);
    }

    listSessions(limit = 20) {
        if (!fs.existsSync(this.dataDir)) {
            return [];
        }
        return fs.readdirSync(this.dataDir, { withFileTypes: true })
            .filter(item => item.isDirectory())
            .map(item => path.join(this.dataDir, item.name, 'session.json'))
            .filter(filePath => fs.existsSync(filePath))
            .map(filePath => {
                try {
                    return this.decorateSession(JSON.parse(fs.readFileSync(filePath, 'utf8')));
                } catch (error) {
                    return null;
                }
            })
            .filter(Boolean)
            .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
            .slice(0, Math.max(1, Number(limit) || 20));
    }

    decorateSession(session = {}) {
        const harPath = session.harPath || '';
        const logPath = session.logPath || '';
        const statsPath = session.statsPath || '';
        const stats = this.readJsonFile(statsPath);
        const logDiagnostics = this.readLogDiagnostics(logPath);
        return {
            ...session,
            harExists: Boolean(harPath && fs.existsSync(harPath)),
            harSize: harPath && fs.existsSync(harPath) ? fs.statSync(harPath).size : 0,
            logSize: logPath && fs.existsSync(logPath) ? fs.statSync(logPath).size : 0,
            statsExists: Boolean(statsPath && fs.existsSync(statsPath)),
            statsSize: statsPath && fs.existsSync(statsPath) ? fs.statSync(statsPath).size : 0,
            stats,
            logDiagnostics
        };
    }

    writeSessionMeta(session = {}) {
        if (!session.metaPath) {
            return;
        }
        fs.writeFileSync(session.metaPath, JSON.stringify(this.decorateSession(session), null, 2));
    }

    resolveBinary() {
        if (this.configuredBin && fs.existsSync(this.configuredBin)) {
            return this.configuredBin;
        }
        const candidates = [
            this.configuredBin,
            path.join(this.projectRoot, '.venv-capture/bin/mitmdump'),
            path.join(this.projectRoot, 'venv-capture/bin/mitmdump'),
            path.join(this.projectRoot, '.venv/bin/mitmdump'),
            '/opt/homebrew/bin/mitmdump',
            '/usr/local/bin/mitmdump',
            '/usr/bin/mitmdump'
        ].filter(Boolean);
        for (const candidate of candidates) {
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        }
        const found = spawnSync('sh', ['-lc', 'command -v mitmdump'], { encoding: 'utf8' });
        return found.status === 0 ? this.clean(found.stdout) : '';
    }

    clean(value) {
        return String(value || '').trim();
    }

    normalizeFilters(input = {}) {
        return {
            hosts: this.normalizeFilterList(input.hosts || input.host || input.domains || input.domain || ''),
            ips: this.normalizeFilterList(input.ips || input.ip || '')
        };
    }

    normalizeTrafficPolicy(input = {}) {
        return {
            blockHosts: this.normalizeFilterList(input.blockHosts || input.blockHost || input.hosts || ''),
            blockUrlKeywords: this.normalizeFilterList(
                input.blockUrlKeywords
                || input.blockUrlKeyword
                || input.blockUrls
                || input.blockUrl
                || input.urls
                || ''
            ),
            allowUrlKeywords: this.normalizeFilterList(
                input.allowUrlKeywords
                || input.allowUrlKeyword
                || input.allowUrls
                || input.allowUrl
                || ''
            )
        };
    }

    normalizeFilterList(value) {
        const source = Array.isArray(value) ? value : String(value || '').split(/[\n,，;；|\s]+/);
        const seen = new Set();
        const result = [];
        source
            .map(item => this.clean(item).toLowerCase())
            .filter(Boolean)
            .forEach(item => {
                if (!seen.has(item)) {
                    seen.add(item);
                    result.push(item);
                }
            });
        return result;
    }

    readJsonFile(filePath) {
        if (!filePath || !fs.existsSync(filePath)) {
            return null;
        }
        try {
            return JSON.parse(fs.readFileSync(filePath, 'utf8'));
        } catch (error) {
            return null;
        }
    }

    readLogDiagnostics(logPath) {
        if (!logPath || !fs.existsSync(logPath)) {
            return null;
        }
        try {
            const stat = fs.statSync(logPath);
            const fd = fs.openSync(logPath, 'r');
            const maxBytes = 1024 * 1024;
            const length = Math.min(stat.size, maxBytes);
            const buffer = Buffer.alloc(length);
            fs.readSync(fd, buffer, 0, length, Math.max(0, stat.size - length));
            fs.closeSync(fd);
            return this.parseLogDiagnostics(buffer.toString('utf8'));
        } catch (error) {
            return null;
        }
    }

    parseLogDiagnostics(content = '') {
        const diagnostics = {
            clientConnectCount: 0,
            serverConnectCount: 0,
            tlsHandshakeErrorCount: 0,
            proxyTrafficSeen: false,
            lastServerHost: '',
            lastTlsError: ''
        };

        for (const line of String(content || '').split(/\r?\n/)) {
            if (line.includes('client connect')) {
                diagnostics.clientConnectCount += 1;
            }
            if (line.includes('server connect')) {
                diagnostics.serverConnectCount += 1;
                const hostMatch = line.match(/server connect\s+([^\s]+)/);
                if (hostMatch) {
                    diagnostics.lastServerHost = hostMatch[1];
                }
            }
            if (line.includes('Client TLS handshake failed')) {
                diagnostics.tlsHandshakeErrorCount += 1;
                diagnostics.lastTlsError = line;
                const hostMatch = line.match(/certificate for\s+([^\s]+)/);
                if (hostMatch) {
                    diagnostics.lastServerHost = hostMatch[1];
                }
            }
        }

        diagnostics.proxyTrafficSeen = diagnostics.clientConnectCount > 0 || diagnostics.serverConnectCount > 0;
        return diagnostics;
    }

    enableSystemProxy(listenPort, requestedServices = null) {
        const state = {
            requested: true,
            enabled: false,
            restored: false,
            enabledAt: new Date().toISOString(),
            restoreAt: null,
            proxyHost: '127.0.0.1',
            proxyPort: Math.max(1, Number(listenPort) || this.listenPort),
            services: [],
            errors: []
        };

        if (os.platform() !== 'darwin') {
            state.errors.push('system proxy management only supports macOS');
            return state;
        }

        const services = this.resolveProxyServices(requestedServices);
        if (services.length === 0) {
            state.errors.push('no enabled macOS network services found');
            return state;
        }

        for (const service of services) {
            const serviceState = {
                name: service,
                web: this.readProxyState(service, false),
                secureWeb: this.readProxyState(service, true),
                applied: false,
                error: ''
            };
            try {
                this.runNetworkSetup(['-setwebproxy', service, state.proxyHost, String(state.proxyPort)]);
                this.runNetworkSetup(['-setwebproxystate', service, 'on']);
                this.runNetworkSetup(['-setsecurewebproxy', service, state.proxyHost, String(state.proxyPort)]);
                this.runNetworkSetup(['-setsecurewebproxystate', service, 'on']);
                serviceState.applied = true;
                state.enabled = true;
            } catch (error) {
                serviceState.error = error.message;
                state.errors.push(`${service}: ${error.message}`);
            }
            state.services.push(serviceState);
        }

        return state;
    }

    restoreSystemProxy(state = null) {
        if (!state || !state.requested || state.restored) {
            return state;
        }

        const nextState = {
            ...state,
            restored: false,
            restoreAt: new Date().toISOString(),
            restoreErrors: []
        };

        for (const service of Array.isArray(state.services) ? state.services : []) {
            if (!service?.applied) {
                continue;
            }
            try {
                this.restoreProxyState(service.name, false, service.web);
                this.restoreProxyState(service.name, true, service.secureWeb);
            } catch (error) {
                nextState.restoreErrors.push(`${service.name}: ${error.message}`);
            }
        }

        nextState.restored = nextState.restoreErrors.length === 0;
        return nextState;
    }

    resolveProxyServices(requestedServices = null) {
        if (Array.isArray(requestedServices) && requestedServices.length > 0) {
            return requestedServices.map(item => this.clean(item)).filter(Boolean);
        }

        const configured = this.normalizeFilterList(process.env.CAPTURE_PROXY_SERVICES || '');
        if (configured.length > 0) {
            return configured;
        }

        const output = this.runNetworkSetup(['-listallnetworkservices'], { allowFailure: true });
        return String(output || '')
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(line => line && !line.startsWith('An asterisk') && !line.startsWith('*'));
    }

    readProxyState(service, secure = false) {
        const output = this.runNetworkSetup([secure ? '-getsecurewebproxy' : '-getwebproxy', service], { allowFailure: true });
        return this.parseProxyState(output);
    }

    parseProxyState(output = '') {
        const state = {
            enabled: false,
            server: '',
            port: '',
            authenticated: false
        };
        for (const line of String(output || '').split(/\r?\n/)) {
            const [rawKey, ...valueParts] = line.split(':');
            const key = String(rawKey || '').trim().toLowerCase();
            const value = valueParts.join(':').trim();
            if (key === 'enabled') {
                state.enabled = /^yes$/i.test(value);
            } else if (key === 'server') {
                state.server = value;
            } else if (key === 'port') {
                state.port = value;
            } else if (key === 'authenticated proxy enabled') {
                state.authenticated = /^(1|yes|true)$/i.test(value);
            }
        }
        return state;
    }

    restoreProxyState(service, secure = false, previous = {}) {
        const setProxyCommand = secure ? '-setsecurewebproxy' : '-setwebproxy';
        const setStateCommand = secure ? '-setsecurewebproxystate' : '-setwebproxystate';
        if (previous?.enabled && previous.server && previous.port) {
            this.runNetworkSetup([setProxyCommand, service, previous.server, String(previous.port)]);
            this.runNetworkSetup([setStateCommand, service, 'on']);
        } else {
            this.runNetworkSetup([setStateCommand, service, 'off']);
        }
    }

    runNetworkSetup(args = [], options = {}) {
        const result = spawnSync('/usr/sbin/networksetup', args, {
            encoding: 'utf8',
            timeout: 5000
        });
        const output = String(result.stdout || '').trim();
        const errorOutput = String(result.stderr || '').trim();
        if (result.status !== 0 && !options.allowFailure) {
            throw new Error(errorOutput || output || `networksetup exited ${result.status}`);
        }
        return output || errorOutput;
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = CaptureRecorderService;
