class AutomationController {
    constructor(config = {}) {
        this.config = config;
    }

    async runCollectionWorkflow(miniProgram) {
        return {
            success: false,
            reason: 'legacy_automation_controller_stub',
            message: 'Legacy automation controller is not included in this package. Use /api/method1/*, /api/method2/* and /api/method3/* for chain validation.',
            miniProgram: miniProgram?.id || miniProgram?.name || null
        };
    }
}

module.exports = AutomationController;
