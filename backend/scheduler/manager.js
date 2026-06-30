class SchedulerManager {
    constructor() {
        this.tasks = new Map();
        this.nextId = 1;
    }

    listSchedules() {
        return Array.from(this.tasks.values());
    }

    createSchedule(name, platforms, cronExpression) {
        const schedule = {
            id: this.nextId++,
            name,
            platforms,
            cronExpression,
            enabled: true,
            createdAt: new Date().toISOString()
        };
        this.tasks.set(schedule.id, schedule);
        return schedule;
    }

    deleteSchedule(id) {
        this.tasks.delete(Number(id));
        return true;
    }

    toggleSchedule(id, enabled) {
        const schedule = this.tasks.get(Number(id));
        if (!schedule) throw new Error('Schedule not found');
        schedule.enabled = Boolean(enabled);
        schedule.updatedAt = new Date().toISOString();
        return schedule;
    }
}

module.exports = SchedulerManager;
