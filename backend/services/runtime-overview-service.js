'use strict';

class RuntimeOverviewService {
    constructor(options = {}) {
        this.config = options.config || {};
        this.getMiniPrograms = options.getMiniPrograms;
        this.method1Service = options.method1Service;
        this.captureRecorderService = options.captureRecorderService;
        this.apiTemplateModel = options.apiTemplateModel;
        this.selfHealService = options.selfHealService;
        this.testChainOrchestrator = options.testChainOrchestrator || null;
        this.logger = options.logger || console;
        if (!this.getMiniPrograms || !this.method1Service || !this.captureRecorderService
            || !this.apiTemplateModel || !this.selfHealService) {
            throw new TypeError('runtime overview service dependencies are required');
        }
    }

    async getOverview() {
        const runtimeMode = 'full';
        return {
            runtimeMode,
            runtimeSummary: this.buildRuntimeModeSummary(runtimeMode),
            chainStatus: await this.buildDynamicChainStatus(runtimeMode),
            collectionModes: this.buildCollectionModes(),
            platforms: this.getMiniPrograms(),
            automation: this.config.automation,
            rateLimit: this.config.rateLimit,
            aiFeatures: this.selfHealService.getAiFeatureStatus(),
            selfHeal: this.selfHealService.getRuntimeMetadata(),
        };
    }

    buildRuntimeModeSummary(mode) {
        const isPreview = mode === 'preview';
        return {
            mode,
            title: isPreview ? '本地预览模式' : '完整执行模式',
            description: isPreview ? '预览' : '完整',
            restrictions: [],
        };
    }

    buildCollectionModes() {
        return {
            page: [
                {
                    id: 'page-auto',
                    name: '自动下滑 OCR',
                    recommended: false,
                    description: '由系统尝试控制页面下滑并执行 OCR 识别，适合可稳定自动滚动的平台。',
                },
                {
                    id: 'page-assisted',
                    name: '人工辅助模式',
                    recommended: true,
                    description: '用户手动在微信小程序中下滑，系统后台周期截图并做 OCR 增量识别。适合 macOS 微信小程序场景。',
                },
            ],
        };
    }

    buildChainStatus() {
        return {
            page: {
                chain: 'page', label: '页面自动化识别', enabled: true, available: true,
                blockingReason: '', capabilities: ['窗口截图', 'OCR 识别', '单页识别', '人工辅助增量采集'],
                lastStatus: 'idle', recommendedMode: 'page-assisted', notes: ['人工辅助优先'],
            },
            har: {
                chain: 'har', label: '后台自动化识别', enabled: true, available: true,
                blockingReason: '', capabilities: ['自动化流程编排', '内置录包服务', 'HAR 自动分析', '模板学习'],
                lastStatus: 'idle', notes: ['录包/HAR'],
            },
            api: {
                chain: 'api', label: '流量自动化识别', enabled: true, available: true,
                blockingReason: '', capabilities: ['模板请求', '坐标爬取', '详情补齐', '配额控制'],
                lastStatus: 'idle', notes: ['模板/签名'],
            },
        };
    }

    async buildDynamicChainStatus() {
        if (this.testChainOrchestrator) {
            try {
                const result = await this.testChainOrchestrator.getStatus();
                return this.buildOrchestratorChainStatus(result);
            } catch (error) {
                this.logger.warn(`Unified chain status unavailable: ${error.message}`);
            }
        }

        const status = this.buildChainStatus();
        let windowStatus = {
            hasWechatWindow: false,
            hasTargetWindow: false,
            reason: 'wechat_status_unavailable',
        };
        let recorder = { available: false, reason: 'capture_status_unavailable' };
        let coverageList = [];
        let templateStatusAvailable = true;
        try {
            windowStatus = await this.method1Service.getWindowStatus({ platform: 'didi-charging' });
        } catch (error) {
            this.logger.warn(`Method 1 window status unavailable: ${error.message}`);
        }
        try {
            recorder = this.captureRecorderService.getStatus();
        } catch (error) {
            this.logger.warn(`Capture recorder status unavailable: ${error.message}`);
        }
        try {
            coverageList = this.apiTemplateModel.getPlatformCoverage();
        } catch (error) {
            templateStatusAvailable = false;
            this.logger.warn(`Template coverage unavailable: ${error.message}`);
        }
        const coverageMap = new Map(coverageList.map(item => [item.platform, item]));

        if (!windowStatus.hasWechatWindow) {
            status.page.available = false;
            status.page.blockingReason = windowStatus.reason || 'wechat_not_running';
            status.page.notes = ['微信未就绪'];
        } else if (!windowStatus.hasTargetWindow) {
            status.page.blockingReason = windowStatus.reason || 'target_window_missing';
            status.page.notes = ['target_missing'];
        }

        if (!recorder.available) {
            status.har.available = false;
            status.har.blockingReason = 'capture_recorder_unavailable';
            status.har.notes = ['mitmdump_missing'];
        } else if (recorder.activeSession) {
            status.har.notes = [`recording:${recorder.activeSession.listenHost}:${recorder.activeSession.listenPort}`];
        } else {
            status.har.notes = ['ready'];
        }

        const didiCoverage = coverageMap.get('didi-charging');
        if (!templateStatusAvailable) {
            status.api.available = false;
            status.api.blockingReason = 'template_status_unavailable';
            status.api.notes = ['template_status_unavailable'];
        } else if (!didiCoverage || !didiCoverage.activeListTemplates) {
            status.api.available = false;
            status.api.blockingReason = 'template_missing';
            status.api.notes = ['template_missing'];
        } else {
            status.api.notes = [
                `list=${didiCoverage.activeListTemplates || 0}`,
                `detail=${didiCoverage.activeDetailTemplates || 0}`,
            ];
        }
        return status;
    }

    buildOrchestratorChainStatus(result = {}) {
        const status = this.buildChainStatus();
        const mappings = [
            ['page', 'method1'],
            ['har', 'method2'],
            ['api', 'method3'],
        ];
        for (const [targetKey, sourceKey] of mappings) {
            const source = result.chains?.[sourceKey] || {};
            status[targetKey] = {
                ...status[targetKey],
                available: Boolean(source.available),
                blockingReason: source.blockingReason || '',
                lastStatus: source.status || 'unknown',
                notes: source.recommendedAction ? [source.recommendedAction] : [],
            };
        }
        return status;
    }
}

module.exports = RuntimeOverviewService;
