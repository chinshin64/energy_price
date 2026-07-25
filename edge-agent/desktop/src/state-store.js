'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

class StateStore {
    constructor(filePath) {
        this.filePath = filePath;
        fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
        this.state = this.load();
        if (!this.state.installationSecret) {
            this.state.installationSecret = crypto.randomBytes(32).toString('base64url');
            this.save();
        }
    }

    load() {
        try {
            const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            return {};
        }
    }

    save() {
        const temporary = `${this.filePath}.${process.pid}.tmp`;
        fs.writeFileSync(temporary, JSON.stringify(this.state, null, 2), { mode: 0o600 });
        fs.renameSync(temporary, this.filePath);
    }

    update(patch) {
        Object.assign(this.state, patch);
        this.save();
        return { ...this.state };
    }
}

module.exports = { StateStore };
