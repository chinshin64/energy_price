'use strict';

const {
    normalizeTaskType,
    normalizeValidationPayload,
} = require('./scheduled-validation-policy');

function inputError(code, message) {
    const error = new Error(message);
    error.code = code;
    error.statusCode = 400;
    return error;
}

class ScheduleApplicationService {
    constructor(options = {}) {
        this.scheduler = options.scheduler;
        this.selfHealService = options.selfHealService;
        this.appSettingModel = options.appSettingModel;
        this.getPlatformIds = options.getPlatformIds;
        this.defaultTimezone = String(options.defaultTimezone || 'Asia/Shanghai');
        if (!this.scheduler || !this.selfHealService || !this.appSettingModel || !this.getPlatformIds) {
            throw new TypeError('schedule application service dependencies are required');
        }
    }

    list() {
        return this.scheduler.listSchedules().map(schedule => this.selfHealService.enrichSchedule(schedule));
    }

    get(id) {
        return this.scheduler.getSchedule(id);
    }

    create(payload = {}) {
        const definition = this.normalizeDefinition(payload);
        if (payload.selfHealSettings && typeof payload.selfHealSettings === 'object'
            && !Array.isArray(payload.selfHealSettings)) {
            this.appSettingModel.saveSelfHealSettings(payload.selfHealSettings);
        }
        return this.selfHealService.enrichSchedule(this.scheduler.createSchedule(definition));
    }

    normalizeDefinition(payload = {}) {
        const name = String(payload.name || '').trim();
        if (!name || name.length > 120) {
            throw inputError('schedule_name_invalid', 'name is required and must not exceed 120 characters');
        }
        if (!Array.isArray(payload.platforms) || payload.platforms.length === 0 || payload.platforms.length > 20) {
            throw inputError('schedule_platforms_invalid', 'platforms must contain between 1 and 20 items');
        }
        const allowed = new Set(this.getPlatformIds());
        const platforms = Array.from(new Set(payload.platforms.map(value => String(value || '').trim()).filter(Boolean)));
        const unsupported = platforms.find(platform => !allowed.has(platform));
        if (platforms.length === 0 || unsupported) {
            throw inputError('schedule_platforms_invalid', unsupported
                ? `unsupported platform: ${unsupported}`
                : 'platforms must contain at least one supported platform');
        }
        const cronExpression = String(payload.cronExpression || '').trim();
        const timezone = String(payload.timezone || this.defaultTimezone).trim();
        const taskType = normalizeTaskType(payload.taskType);
        const taskPayload = normalizeValidationPayload(payload.payload);
        if (Buffer.byteLength(JSON.stringify(taskPayload), 'utf8') > 32 * 1024) {
            throw inputError('schedule_payload_too_large', 'schedule payload must not exceed 32 KiB');
        }
        return {
            name,
            platforms,
            cronExpression,
            timezone,
            taskType,
            payload: taskPayload,
            enabled: payload.enabled !== false,
        };
    }

    startNow(id) {
        return this.scheduler.startNow(id);
    }

    toggle(id, enabled) {
        if (typeof enabled !== 'boolean') {
            throw inputError('schedule_enabled_invalid', 'enabled must be a boolean');
        }
        return this.selfHealService.enrichSchedule(this.scheduler.toggleSchedule(id, enabled));
    }

    delete(id) {
        this.scheduler.deleteSchedule(id);
        this.appSettingModel.deleteScheduleRecovery?.(id);
    }

    drill(id, payload = {}) {
        const schedule = this.scheduler.getSchedule(id);
        if (!schedule) {
            const error = new Error('Schedule not found');
            error.code = 'schedule_not_found';
            error.statusCode = 404;
            throw error;
        }
        const platforms = Array.isArray(schedule.platforms) ? schedule.platforms : [];
        const diagnosis = this.selfHealService.diagnose({ ...payload, platforms, scheduleId: id });
        const run = this.selfHealService.recordDiagnosis(diagnosis, {
            scheduleId: id,
            scheduleName: schedule.name || '',
            platform: platforms[0] || '',
        });
        const recovery = this.appSettingModel.saveScheduleRecovery(id, {
            status: diagnosis.status === 'recoverable' ? '已生成排查方案' : '需人工介入',
            summary: diagnosis.status === 'recoverable'
                ? `当前 ${diagnosis.currentChainLabel}，将先修复当前能力`
                : `当前 ${diagnosis.currentChainLabel}，等待人工处理`,
            at: run.createdAt,
        });
        return {
            schedule: {
                ...this.selfHealService.enrichSchedule(schedule),
                last_recovery_status: recovery.status,
                last_recovery_summary: recovery.summary,
                last_recovery_at: recovery.at,
            },
            diagnosis,
            run,
        };
    }
}

module.exports = ScheduleApplicationService;
