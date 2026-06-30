const fs = require('fs');
const path = require('path');

/**
 * 签名自动刷新流程（M2）
 *
 * 触发方式：手动 POST /api/signature/refresh/:platform
 * 步骤编排：
 *   1. 调用 capture-recorder.startSession() 开启录制
 *   2. 通过DCC发送"打开小程序"指令
 *   3. 等待目标请求（超时5min）
 *   4. 从HAR中提取签名参数
 *   5. 写入语料库
 *   6. 返回刷新结果
 * 失败回退：返回人工入口提示
 * 请求频次限制：单平台每次≤5请求，每日≤2次自动刷新
 */

const REFRESH_TIMEOUT_MS = 5 * 60 * 1000;       // 5分钟超时
const MAX_REQUESTS_PER_REFRESH = 5;              // 单次刷新最多5个请求
const MAX_DAILY_REFRESHES = 2;                   // 每平台每日最多2次自动刷新
const POLL_INTERVAL_MS = 3000;                   // 轮询HAR间隔

// 平台 → 小程序打开指令映射
const PLATFORM_MINI_PROGRAM_COMMANDS = {
    'didi-charging': { action: 'open_mini_program', miniProgramId: 'wx06cb940499986937', page: 'pages/stationList/stationList' },
    'teld': { action: 'open_mini_program', miniProgramId: 'teld_appid', page: 'pages/index/index' },
    'star-charge': { action: 'open_mini_program', miniProgramId: 'star_charge_appid', page: 'pages/index/index' },
    'kuaidian': { action: 'open_mini_program', miniProgramId: 'kuaidian_appid', page: 'pages/index/index' },
    'tuanyou': { action: 'open_mini_program', miniProgramId: 'tuanyou_appid', page: 'pages/index/index' },
    'ykc': { action: 'open_mini_program', miniProgramId: 'ykc_appid', page: 'pages/index/index' }
};

// 平台 → 签名请求URL匹配模式
const PLATFORM_URL_PATTERNS = {
    'didi-charging': /xiaojukeji\.com\/station-api\/(homepage\/stationList|station\/getoneinfo)/i,
    'teld': /teld\.cn\/api/i,
    'star-charge': /star-charge\.com\/api/i,
    'kuaidian': /kuaidian\.com\/api/i,
    'tuanyou': /tuanyou\.com\/api/i,
    'ykc': /ykc\.com\/api/i
};

class SignatureRefreshService {
    constructor(options = {}) {
        this.captureRecorder = options.captureRecorder || null;
        this.mobileCommandService = options.mobileCommandService || null;
        this.extractSigner = options.extractSigner || null;
        this.corpusPath = options.corpusPath
            || process.env.DIDI_SIGNATURE_CORPUS_PATH
            || path.join(__dirname, '../../data/didi-signature-corpus.json');
        this.maxRequestsPerRefresh = options.maxRequestsPerRefresh || MAX_REQUESTS_PER_REFRESH;
        this.maxDailyRefreshes = options.maxDailyRefreshes || MAX_DAILY_REFRESHES;
        this.refreshTimeoutMs = options.refreshTimeoutMs || REFRESH_TIMEOUT_MS;
        this.pollIntervalMs = options.pollIntervalMs || POLL_INTERVAL_MS;
        this.dailyRefreshLog = {};   // { platform: { date: '2026-06-12', count: 1 } }
        this.activeRefreshes = {};   // { platform: { status, startedAt } }
    }

    /**
     * 触发签名刷新
     * @param {string} platform - 平台ID
     * @param {object} [options] - 可选参数
     * @returns {object} 刷新结果
     */
    async refresh(platform, options = {}) {
        // 1. 参数校验
        if (!PLATFORM_URL_PATTERNS[platform]) {
            return this.buildError(platform, 'unsupported_platform', `不支持的平台: ${platform}`);
        }

        // 2. 频次限制检查
        const rateLimitCheck = this.checkRateLimit(platform);
        if (!rateLimitCheck.allowed) {
            return this.buildError(platform, 'rate_limited', rateLimitCheck.message, {
                retryAfter: rateLimitCheck.retryAfter
            });
        }

        // 3. 防止并发刷新
        if (this.activeRefreshes[platform]) {
            return this.buildError(platform, 'already_running', `${platform} 正在刷新中`, {
                startedAt: this.activeRefreshes[platform].startedAt
            });
        }

        // 4. 依赖检查
        if (!this.captureRecorder) {
            return this.buildError(platform, 'no_recorder', 'capture-recorder 服务未初始化');
        }

        this.activeRefreshes[platform] = { status: 'running', startedAt: new Date().toISOString() };

        try {
            const result = await this.executeRefreshFlow(platform, options);
            this.recordRefresh(platform);
            return result;
        } catch (error) {
            return this.buildError(platform, 'refresh_failed', error.message, {
                manualFallback: this.getManualFallbackMessage(platform)
            });
        } finally {
            delete this.activeRefreshes[platform];
        }
    }

    /**
     * 执行刷新流程的6个步骤
     */
    async executeRefreshFlow(platform, options = {}) {
        const steps = [];

        // Step 1: 开启录制
        let session;
        try {
            session = this.captureRecorder.startSession({
                filterHosts: this.getHostFilter(platform)
            });
            steps.push({ step: 'start_session', status: 'ok', sessionId: session.id });
        } catch (error) {
            steps.push({ step: 'start_session', status: 'failed', error: error.message });
            throw new Error(`开启录制失败: ${error.message}`);
        }

        // Step 2: 通过DCC发送打开小程序指令
        if (this.mobileCommandService && this.mobileCommandService.dcc?.enabled) {
            try {
                const command = PLATFORM_MINI_PROGRAM_COMMANDS[platform];
                await this.sendDccCommand(platform, command);
                steps.push({ step: 'dcc_command', status: 'ok', command: command.action });
            } catch (error) {
                steps.push({ step: 'dcc_command', status: 'warn', error: error.message });
                // DCC失败不阻断，可以人工操作
            }
        } else {
            steps.push({ step: 'dcc_command', status: 'skipped', reason: 'DCC未启用' });
        }

        // Step 3: 等待目标请求（轮询HAR文件）
        let extractedSignatures = [];
        try {
            extractedSignatures = await this.waitForSignatureRequests(
                platform,
                session,
                options.timeoutMs || this.refreshTimeoutMs
            );
            steps.push({
                step: 'wait_for_requests',
                status: extractedSignatures.length > 0 ? 'ok' : 'timeout',
                foundCount: extractedSignatures.length
            });
        } catch (error) {
            steps.push({ step: 'wait_for_requests', status: 'failed', error: error.message });
        }

        // Step 4: 提取签名参数
        let signatures = [];
        if (extractedSignatures.length > 0 && this.extractSigner) {
            signatures = this.extractSigner.extractBatch(extractedSignatures, platform);
            steps.push({
                step: 'extract_signatures',
                status: signatures.length > 0 ? 'ok' : 'no_signature',
                extractedCount: signatures.length
            });
        } else if (extractedSignatures.length > 0) {
            // 没有extractSigner时，用简化提取
            signatures = this.simpleExtractSignatures(platform, extractedSignatures);
            steps.push({
                step: 'extract_signatures',
                status: signatures.length > 0 ? 'ok' : 'no_signature',
                extractedCount: signatures.length,
                mode: 'simple'
            });
        } else {
            steps.push({ step: 'extract_signatures', status: 'skipped', reason: '无请求' });
        }

        // Step 5: 停止录制
        try {
            const stopResult = this.captureRecorder.stopSession();
            steps.push({ step: 'stop_session', status: 'ok' });
        } catch (error) {
            steps.push({ step: 'stop_session', status: 'warn', error: error.message });
        }

        // Step 6: 写入语料库
        let writtenCount = 0;
        if (signatures.length > 0) {
            writtenCount = this.writeToCorpus(signatures);
            steps.push({ step: 'write_corpus', status: 'ok', writtenCount });
        } else {
            steps.push({ step: 'write_corpus', status: 'skipped', reason: '无签名' });
        }

        const success = signatures.length > 0;
        return {
            success,
            platform,
            signatureCount: signatures.length,
            writtenCount,
            steps,
            refreshedAt: new Date().toISOString(),
            ...(success ? {} : { manualFallback: this.getManualFallbackMessage(platform) })
        };
    }

    /**
     * 轮询等待签名请求
     */
    async waitForSignatureRequests(platform, session, timeoutMs) {
        const startTime = Date.now();
        const urlPattern = PLATFORM_URL_PATTERNS[platform];
        const results = [];

        while (Date.now() - startTime < timeoutMs) {
            await this.sleep(this.pollIntervalMs);

            const harPath = this.getHarPath(session);
            if (!harPath || !fs.existsSync(harPath)) continue;

            try {
                const har = JSON.parse(fs.readFileSync(harPath, 'utf8'));
                const entries = har.log?.entries || [];

                for (const entry of entries) {
                    const url = entry.request?.url || '';
                    if (urlPattern.test(url) && !this.isEntryAlreadyProcessed(entry, results)) {
                        results.push(entry);
                        if (results.length >= this.maxRequestsPerRefresh) {
                            return results;
                        }
                    }
                }
            } catch (error) {
                // HAR文件可能还在写入中，忽略解析错误
            }

            if (results.length > 0) {
                // 收到第一个后再等一小段时间收集更多
                await this.sleep(Math.min(10000, timeoutMs - (Date.now() - startTime)));
                break;
            }
        }

        return results;
    }

    /**
     * 通过DCC发送打开小程序指令
     */
    async sendDccCommand(platform, command) {
        if (!this.mobileCommandService) {
            throw new Error('mobileCommandService 未初始化');
        }

        const dcc = this.mobileCommandService.dcc;
        if (!dcc?.enabled) {
            throw new Error('DCC 未启用');
        }

        // 构造打开小程序的指令
        const intent = {
            action: command.action,
            platform,
            miniProgramId: command.miniProgramId,
            page: command.page
        };

        // 尝试通过DCC URL发送
        if (dcc.url) {
            return this.postDccUrl(dcc, intent);
        }

        // 尝试通过DCC CLI命令发送
        if (dcc.command) {
            return this.postDccCommand(dcc, intent);
        }

        throw new Error('DCC 无可用连接方式');
    }

    async postDccUrl(dcc, intent) {
        const httpModule = dcc.url.startsWith('https') ? require('https') : require('http');
        return new Promise((resolve, reject) => {
            const body = JSON.stringify(intent);
            const url = new URL(dcc.url);
            const options = {
                hostname: url.hostname,
                port: url.port,
                path: url.pathname + url.search,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body)
                },
                timeout: dcc.timeoutMs
            };

            if (dcc.authHeader && dcc.authToken) {
                options.headers[dcc.authHeader] = dcc.authToken;
            }

            const req = httpModule.request(options, (res) => {
                let data = '';
                res.on('data', chunk => { data += chunk; });
                res.on('end', () => {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve({ status: res.statusCode, data });
                    } else {
                        reject(new Error(`DCC returned ${res.statusCode}: ${data}`));
                    }
                });
            });

            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('DCC request timeout')); });
            req.write(body);
            req.end();
        });
    }

    async postDccCommand(dcc, intent) {
        const { spawn } = require('child_process');
        return new Promise((resolve, reject) => {
            const proc = spawn(dcc.command, [], {
                cwd: dcc.cwd,
                stdio: ['pipe', 'pipe', 'pipe'],
                timeout: dcc.timeoutMs
            });
            let stdout = '';
            let stderr = '';
            proc.stdout.on('data', chunk => { stdout += chunk; });
            proc.stderr.on('data', chunk => { stderr += chunk; });
            proc.on('close', code => {
                if (code === 0) resolve({ stdout, stderr });
                else reject(new Error(`DCC command exited ${code}: ${stderr}`));
            });
            proc.on('error', reject);
            proc.stdin.write(JSON.stringify(intent));
            proc.stdin.end();
        });
    }

    /**
     * 简化版签名提取（不依赖 ExtractSignerUnified）
     */
    simpleExtractSignatures(platform, harEntries) {
        const results = [];
        for (const entry of harEntries) {
            const url = entry.request?.url || '';
            const qs = entry.request?.queryString || [];
            const query = {};
            for (const item of qs) {
                if (item.name) query[item.name] = item.value;
            }

            let hasSignature = false;
            if (platform === 'didi-charging') hasSignature = Boolean(query.wsgsig);
            else hasSignature = Boolean(query.token || query.sign);

            if (hasSignature) {
                results.push({
                    platform,
                    signatureParams: query,
                    capturedAt: entry.startedDateTime || new Date().toISOString(),
                    method: entry.request?.method || 'GET',
                    baseUrl: url.split('?')[0],
                    source: 'auto-refresh'
                });
            }
        }
        return results;
    }

    /**
     * 写入语料库
     */
    writeToCorpus(signatures) {
        let writtenCount = 0;
        let corpus = [];
        let payload = { meta: {}, entries: [] };

        try {
            const raw = fs.readFileSync(this.corpusPath, 'utf8');
            payload = JSON.parse(raw);
            corpus = payload.entries || payload;
        } catch (error) {
            // 文件不存在，创建新的
        }

        if (!Array.isArray(payload.entries)) {
            payload = { meta: payload.meta || {}, entries: Array.isArray(corpus) ? corpus : [] };
        }

        for (const sig of signatures) {
            const entry = this.signatureToCorpusEntry(sig);
            if (entry) {
                payload.entries.push(entry);
                writtenCount++;
            }
        }

        payload.meta.lastRefreshedAt = new Date().toISOString();
        fs.writeFileSync(this.corpusPath, JSON.stringify(payload, null, 2), 'utf8');
        return writtenCount;
    }

    signatureToCorpusEntry(sig) {
        if (!sig || !sig.signatureParams) return null;
        return {
            platform: sig.platform,
            scope: sig.scope || 'list',
            method: sig.method || 'GET',
            baseUrl: sig.baseUrl || '',
            city: sig.city || '',
            keyword: sig.keyword || '',
            lat: sig.lat || null,
            lng: sig.lng || null,
            capturedAt: sig.capturedAt || new Date().toISOString(),
            createdAt: new Date().toISOString(),
            source: 'auto-refresh',
            active: true,
            hasToken: Boolean(sig.signatureParams.token || sig.signatureParams.wsgsig),
            replayable: true,
            queryParams: sig.queryParams || sig.signatureParams || {},
            bodyParams: sig.bodyParams || {},
            headers: sig.headers || {}
        };
    }

    // ============ 频次限制 ============

    checkRateLimit(platform) {
        const today = new Date().toISOString().slice(0, 10);
        const log = this.dailyRefreshLog[platform];

        if (!log || log.date !== today) {
            return { allowed: true };
        }

        if (log.count >= this.maxDailyRefreshes) {
            return {
                allowed: false,
                message: `${platform} 今日已达刷新上限 (${this.maxDailyRefreshes}次/天)`,
                retryAfter: this.getMsUntilTomorrow()
            };
        }

        return { allowed: true, remainingToday: this.maxDailyRefreshes - log.count };
    }

    recordRefresh(platform) {
        const today = new Date().toISOString().slice(0, 10);
        if (!this.dailyRefreshLog[platform] || this.dailyRefreshLog[platform].date !== today) {
            this.dailyRefreshLog[platform] = { date: today, count: 0 };
        }
        this.dailyRefreshLog[platform].count++;
    }

    getMsUntilTomorrow() {
        const now = new Date();
        const tomorrow = new Date(now);
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(0, 0, 0, 0);
        return tomorrow.getTime() - now.getTime();
    }

    // ============ 辅助方法 ============

    getHostFilter(platform) {
        const patterns = PLATFORM_URL_PATTERNS[platform];
        if (!patterns) return '';
        // 从正则提取域名
        const source = patterns.source;
        const hostMatch = source.match(/\\?([a-z0-9.-]+\.[a-z]+)/i);
        return hostMatch ? hostMatch[1] : '';
    }

    getHarPath(session) {
        if (!session?.id) return null;
        return path.join(
            this.captureRecorder?.dataDir || path.join(__dirname, '../../data/capture-sessions'),
            session.id,
            'session.har'
        );
    }

    isEntryAlreadyProcessed(entry, processedList) {
        const entryUrl = entry.request?.url || '';
        return processedList.some(p => p.request?.url === entryUrl);
    }

    getManualFallbackMessage(platform) {
        return `自动刷新失败，请手动操作：1. 打开微信小程序 2. 浏览${platform}页面 3. 导出HAR文件后通过 /api/parse-har-upload 接口上传`;
    }

    buildError(platform, code, message, extra = {}) {
        return {
            success: false,
            platform,
            code,
            error: message,
            ...extra
        };
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * 获取当前刷新状态
     */
    getStatus() {
        const platforms = Object.keys(PLATFORM_URL_PATTERNS);
        const active = {};
        for (const [platform, info] of Object.entries(this.activeRefreshes)) {
            active[platform] = info;
        }

        const rateLimits = {};
        for (const platform of platforms) {
            const check = this.checkRateLimit(platform);
            rateLimits[platform] = {
                remainingToday: check.remainingToday ?? this.maxDailyRefreshes,
                limit: this.maxDailyRefreshes
            };
        }

        return {
            activeRefreshes: active,
            rateLimits,
            supportedPlatforms: platforms
        };
    }
}

module.exports = SignatureRefreshService;
