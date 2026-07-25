'use strict';

const fs = require('fs');
const path = require('path');
const {
    validateRecord,
    validateHistory,
    generate,
    DEFAULT_INPUT,
    DEFAULT_OUTPUT
} = require('./generate-platform-security-test-report');

function parseArgs(argv) {
    const args = { input: null, history: DEFAULT_INPUT, output: DEFAULT_OUTPUT };
    for (let index = 2; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--input') args.input = path.resolve(argv[++index]);
        else if (arg === '--history') args.history = path.resolve(argv[++index]);
        else if (arg === '--output') args.output = path.resolve(argv[++index]);
        else throw new Error(`unknown argument: ${arg}`);
    }
    if (!args.input) throw new Error('--input <record.json> is required');
    return args;
}

function appendRecord(options) {
    const record = validateRecord(JSON.parse(fs.readFileSync(options.input, 'utf8')));
    const history = validateHistory(JSON.parse(fs.readFileSync(options.history, 'utf8')));
    if (history.records.some(item => item.id === record.id)) {
        throw new Error(`record id already exists: ${record.id}`);
    }

    history.records.push(record);
    history.updatedAt = new Date().toISOString();
    validateHistory(history);

    const tempPath = `${options.history}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(history, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tempPath, options.history);
    const generated = generate(options.history, options.output);
    return { appendedId: record.id, recordCount: history.records.length, ...generated };
}

if (require.main === module) {
    try {
        console.log(JSON.stringify(appendRecord(parseArgs(process.argv)), null, 2));
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}

module.exports = { appendRecord, parseArgs };
