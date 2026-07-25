'use strict';

const nodeCron = require('node-cron');

function scheduleError(code, message, statusCode = 400) {
    const error = new Error(message);
    error.code = code;
    error.statusCode = statusCode;
    return error;
}

function assertTimezone(timezone) {
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
    } catch {
        throw scheduleError('schedule_timezone_invalid', 'timezone must be a valid IANA time zone');
    }
}

class SchedulerManager {
    constructor(options = {}) {
        this.repository = options.repository;
        this.executor = options.executor;
        this.cron = options.cron || nodeCron;
        this.logger = options.logger || console;
        this.tasks = new Map();
        this.running = new Set();
        if (!this.repository || !this.executor) {
            throw new TypeError('scheduler repository and executor are required');
        }
        if (options.restoreOnStart !== false) this.restore();
    }

    restore() {
        const summary = { restoredCount: 0, disabledCount: 0, failures: [] };
        for (const schedule of this.repository.list()) {
            if (!schedule.enabled) continue;
            try {
                this.register(schedule);
                summary.restoredCount += 1;
            } catch (error) {
                this.quarantineInvalidSchedule(schedule, error);
                summary.disabledCount += 1;
                summary.failures.push({
                    scheduleId: schedule.id,
                    code: error.code || 'schedule_definition_invalid',
                });
            }
        }
        return summary;
    }

    listSchedules() {
        return this.repository.list().map(schedule => ({
            ...schedule,
            runtimeStatus: this.running.has(schedule.id)
                ? 'running'
                : (schedule.enabled && this.tasks.has(schedule.id) ? 'scheduled' : 'disabled'),
        }));
    }

    getSchedule(id) {
        return this.repository.getById(Number(id));
    }

    createSchedule(input = {}) {
        const definition = this.validateDefinition(input);
        const schedule = this.repository.create(definition);
        try {
            if (schedule.enabled) this.register(schedule);
        } catch (error) {
            this.repository.delete(schedule.id);
            throw error;
        }
        return this.getSchedule(schedule.id);
    }

    validateDefinition(input = {}) {
        const expression = String(input.cronExpression || '').trim();
        if (!this.cron.validate(expression)) {
            throw scheduleError('schedule_cron_invalid', 'cronExpression is invalid');
        }
        const timezone = String(input.timezone || 'Asia/Shanghai').trim();
        assertTimezone(timezone);
        const definition = { ...input, cronExpression: expression, timezone };
        return typeof this.executor.validate === 'function'
            ? this.executor.validate(definition)
            : definition;
    }

    register(schedule) {
        this.destroyTask(schedule.id);
        const definition = this.validateDefinition(schedule);
        const task = this.cron.schedule(
            definition.cronExpression,
            () => this.executeSchedule(schedule.id, 'scheduled'),
            {
                timezone: definition.timezone,
                noOverlap: true,
                name: `schedule-${schedule.id}`,
            }
        );
        this.tasks.set(schedule.id, task);
        this.updateNextRun(schedule.id, task);
        return task;
    }

    async executeSchedule(id, reason = 'manual') {
        const scheduleId = Number(id);
        const schedule = this.repository.getById(scheduleId);
        if (!schedule) throw scheduleError('schedule_not_found', 'Schedule not found', 404);
        if (this.running.has(scheduleId)) {
            throw scheduleError('schedule_already_running', 'Schedule is already running', 409);
        }

        const startedAt = new Date().toISOString();
        let markedStarted = false;
        this.running.add(scheduleId);
        try {
            this.repository.markRunStarted(scheduleId, startedAt);
            markedStarted = true;
            const result = await this.executor.execute({ ...schedule, triggerReason: reason });
            const status = ['success', 'partial', 'failed'].includes(result?.status)
                ? result.status
                : 'success';
            this.repository.markRunFinished(scheduleId, status, result || null, null, new Date().toISOString());
            return { schedule: this.repository.getById(scheduleId), result };
        } catch (error) {
            if (markedStarted) {
                this.repository.markRunFinished(
                    scheduleId,
                    'failed',
                    error.result || null,
                    error.message,
                    new Date().toISOString()
                );
            }
            throw error;
        } finally {
            this.running.delete(scheduleId);
            try {
                this.updateNextRun(scheduleId, this.tasks.get(scheduleId));
            } catch (error) {
                this.logger.warn(`Unable to update next run for schedule ${scheduleId}: ${error.message}`);
            }
        }
    }

    runNow(id) {
        return this.executeSchedule(id, 'manual');
    }

    startNow(id) {
        const scheduleId = Number(id);
        if (!this.repository.getById(scheduleId)) {
            throw scheduleError('schedule_not_found', 'Schedule not found', 404);
        }
        if (this.running.has(scheduleId)) {
            throw scheduleError('schedule_already_running', 'Schedule is already running', 409);
        }
        const execution = this.executeSchedule(scheduleId, 'manual');
        execution.catch(error => {
            this.logger.error(`Manual schedule ${scheduleId} failed: ${error.message}`);
        });
        return { scheduleId, status: 'accepted' };
    }

    deleteSchedule(id) {
        const scheduleId = Number(id);
        if (!this.repository.getById(scheduleId)) {
            throw scheduleError('schedule_not_found', 'Schedule not found', 404);
        }
        if (this.running.has(scheduleId)) {
            throw scheduleError('schedule_already_running', 'Running schedules cannot be deleted', 409);
        }
        this.destroyTask(scheduleId);
        this.repository.delete(scheduleId);
    }

    toggleSchedule(id, enabled) {
        const scheduleId = Number(id);
        if (this.running.has(scheduleId) && !enabled) {
            throw scheduleError('schedule_already_running', 'Running schedules cannot be disabled', 409);
        }
        const schedule = this.repository.setEnabled(scheduleId, Boolean(enabled));
        if (!schedule) throw scheduleError('schedule_not_found', 'Schedule not found', 404);
        if (schedule.enabled) {
            try {
                this.register(schedule);
            } catch (error) {
                this.quarantineInvalidSchedule(schedule, error);
                throw error;
            }
        }
        else {
            this.destroyTask(scheduleId);
            this.repository.setNextRun(scheduleId, null);
        }
        return this.repository.getById(scheduleId);
    }

    quarantineInvalidSchedule(schedule, error) {
        const scheduleId = Number(schedule.id);
        this.destroyTask(scheduleId);
        if (typeof this.repository.markConfigurationRequired === 'function') {
            this.repository.markConfigurationRequired(scheduleId, error.message);
        } else {
            this.repository.setEnabled(scheduleId, false);
            this.repository.setNextRun?.(scheduleId, null);
        }
        this.logger.warn(
            `Disabled invalid schedule ${scheduleId}: ${error.code || 'schedule_definition_invalid'}`
        );
    }

    updateNextRun(id, task) {
        const nextRun = task?.getNextRun?.();
        this.repository.setNextRun(id, nextRun ? nextRun.toISOString() : null);
    }

    destroyTask(id) {
        const task = this.tasks.get(Number(id));
        if (!task) return;
        task.destroy();
        this.tasks.delete(Number(id));
    }

    shutdown() {
        for (const id of Array.from(this.tasks.keys())) this.destroyTask(id);
    }
}

module.exports = SchedulerManager;
module.exports.assertTimezone = assertTimezone;
module.exports.scheduleError = scheduleError;
