'use strict';

class PlatformDiagnosticsService {
    constructor(options = {}) {
        this.apiTemplateModel = options.apiTemplateModel;
        this.runHistoryModel = options.runHistoryModel;
        this.getPlatformIds = options.getPlatformIds;
        if (!this.apiTemplateModel || !this.runHistoryModel || !this.getPlatformIds) {
            throw new TypeError('platform diagnostics service dependencies are required');
        }
    }

    list() {
        const templateCoverage = this.apiTemplateModel.getPlatformCoverage();
        const coverageMap = new Map(templateCoverage.map(item => [item.platform, item]));
        const recentRuns = this.runHistoryModel.getRuns(100);

        return this.getPlatformIds().map(platform => {
            const coverage = coverageMap.get(platform) || null;
            const latestRun = recentRuns.find(run => (
                run.runType === 'crawl-platforms-with-coordinates'
                && Array.isArray(run.resultSummary?.summary)
                && run.resultSummary.summary.some(item => item.platform === platform)
            ));
            const latestResult = latestRun?.resultSummary?.summary
                ?.find(item => item.platform === platform) || null;

            return {
                platform,
                hasActiveTemplate: Boolean(coverage && coverage.activeTemplates > 0),
                totalTemplates: coverage ? coverage.totalTemplates : 0,
                activeTemplates: coverage ? coverage.activeTemplates : 0,
                activeListTemplates: coverage ? coverage.activeListTemplates : 0,
                activeDetailTemplates: coverage ? coverage.activeDetailTemplates : 0,
                latestTemplateCreatedAt: coverage ? coverage.latestCreatedAt : null,
                latestTemplateUsedAt: coverage ? coverage.latestUsedAt : null,
                latestRunStatus: latestResult ? (latestResult.success ? 'success' : 'failed') : 'never_run',
                latestRunReason: latestResult?.reason || null,
            };
        });
    }
}

module.exports = PlatformDiagnosticsService;
