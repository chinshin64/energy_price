'use strict';

const { redactText } = require('./sensitive-redactor');
const { normalizeExecutableSchedule } = require('./scheduled-validation-policy');

class ScheduledValidationExecutor {
    constructor(options = {}) {
        this.orchestrator = options.orchestrator;
        this.runHistoryModel = options.runHistoryModel;
        if (!this.orchestrator || !this.runHistoryModel) {
            throw new TypeError('scheduled validation executor dependencies are required');
        }
    }

    validate(schedule = {}) {
        return normalizeExecutableSchedule(schedule);
    }

    async execute(schedule = {}) {
        const definition = this.validate(schedule);
        const payload = definition.payload;
        const platforms = definition.platforms;
        const runId = this.runHistoryModel.startRun('scheduled-validation', {
            scheduleId: definition.id,
            scheduleName: definition.name,
            platforms,
            target: payload.target,
            chain: payload.chain,
            triggerReason: definition.triggerReason || 'scheduled',
        });
        const summary = [];
        for (const platform of platforms) {
            try {
                this.runHistoryModel.appendLog(runId, `开始执行定时小规模访问验证: ${platform}`);
                const result = await this.orchestrator.run({
                    chain: 'method3',
                    target: {
                        ...payload.target,
                        platform,
                        maxPages: payload.maxPages,
                        maxRequestCount: payload.maxRequestCount,
                        maxQps: payload.maxQps,
                    },
                    mode: payload.mode || 'list',
                });
                summary.push({
                    platform,
                    success: result.success === true,
                    chainRunId: result.run?.id || null,
                    status: result.run?.status || (result.success ? 'passed' : 'failed'),
                    reason: result.run?.reason || null,
                });
            } catch (error) {
                summary.push({ platform, success: false, reason: redactText(error.message) });
                this.runHistoryModel.appendLog(runId, `定时验证失败 ${platform}: ${error.message}`, 'error');
            }
        }

        const successCount = summary.filter(item => item.success).length;
        const status = successCount === summary.length && summary.length > 0
            ? 'success'
            : (successCount > 0 ? 'partial' : 'failed');
        const result = {
            status,
            runId,
            platformCount: platforms.length,
            successCount,
            failedCount: summary.length - successCount,
            summary,
        };
        this.runHistoryModel.finishRun(
            runId,
            status,
            result,
            status === 'failed' ? 'All scheduled method3 validations failed' : null
        );
        return result;
    }
}

module.exports = ScheduledValidationExecutor;
