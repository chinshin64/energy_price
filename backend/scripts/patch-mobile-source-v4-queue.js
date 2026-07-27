#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const DEFAULT_QUEUE_LIMIT = 500;
const MAX_QUEUE_LIMIT = 5000;
const CONNECTION_ANCHOR =
    '    const connectionLimit = Number(env.MOBILE_SOURCE_MYSQL_POOL_SIZE || 10);';
const QUEUE_ANCHOR = '        queueLimit: 100,';
const V5_MARKERS = Object.freeze([
    'MobileSourceSplitMigrator',
    'mobile_ocr_source_record_cursor',
    'mobile_ocr_fuel_snapshots',
]);

function patchError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function occurrences(source, value) {
    return source.split(value).length - 1;
}

function patchSource(source) {
    const text = String(source);
    if (V5_MARKERS.some(marker => text.includes(marker))) {
        throw patchError(
            'mobile_source_v4_queue_patch_wrong_schema',
            'target contains v5 split-schema markers; refusing to patch'
        );
    }
    if (!text.includes('mobile_ocr_station_snapshots')) {
        throw patchError(
            'mobile_source_v4_queue_patch_contract_missing',
            'target does not contain the production v4 snapshot contract'
        );
    }
    if (text.includes('MOBILE_SOURCE_MYSQL_QUEUE_LIMIT')) {
        return { changed: false, source: text };
    }
    if (occurrences(text, CONNECTION_ANCHOR) !== 1 || occurrences(text, QUEUE_ANCHOR) !== 1) {
        throw patchError(
            'mobile_source_v4_queue_patch_anchor_invalid',
            'target does not contain exactly one expected v4 pool configuration'
        );
    }
    const queueConfiguration = [
        CONNECTION_ANCHOR,
        '    const requestedQueueLimit = Number(',
        `        env.MOBILE_SOURCE_MYSQL_QUEUE_LIMIT || ${DEFAULT_QUEUE_LIMIT}`,
        '    );',
        '    const queueLimit = Number.isInteger(requestedQueueLimit)',
        '            && requestedQueueLimit > 0',
        `            && requestedQueueLimit <= ${MAX_QUEUE_LIMIT}`,
        '        ? requestedQueueLimit',
        `        : ${DEFAULT_QUEUE_LIMIT};`,
    ].join('\n');
    const patched = text
        .replace(CONNECTION_ANCHOR, queueConfiguration)
        .replace(QUEUE_ANCHOR, '        queueLimit,');
    return { changed: true, source: patched };
}

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function validateJavaScript(source) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-source-v4-queue-'));
    const candidate = path.join(directory, 'candidate.js');
    try {
        fs.writeFileSync(candidate, source, { encoding: 'utf8', mode: 0o600 });
        const result = spawnSync(process.execPath, ['--check', candidate], {
            encoding: 'utf8',
            stdio: 'pipe',
        });
        if (result.status !== 0) {
            throw patchError(
                'mobile_source_v4_queue_patch_syntax_invalid',
                String(result.stderr || result.stdout || 'patched source failed syntax validation').trim()
            );
        }
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

function patchFile(target, options = {}) {
    const absolute = path.resolve(target);
    const before = fs.readFileSync(absolute, 'utf8');
    const result = patchSource(before);
    validateJavaScript(result.source);
    const summary = {
        target: absolute,
        changed: result.changed,
        beforeSha256: sha256(before),
        afterSha256: sha256(result.source),
        queueLimitDefault: DEFAULT_QUEUE_LIMIT,
        queueLimitMaximum: MAX_QUEUE_LIMIT,
    };
    if (!options.apply || !result.changed) return summary;

    const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '');
    const backup = `${absolute}.pre-queue-patch-${timestamp}`;
    fs.writeFileSync(backup, before, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    const stat = fs.statSync(absolute);
    const temporary = `${absolute}.${process.pid}.tmp`;
    try {
        fs.writeFileSync(temporary, result.source, {
            encoding: 'utf8',
            mode: stat.mode & 0o777,
            flag: 'wx',
        });
        fs.renameSync(temporary, absolute);
    } finally {
        fs.rmSync(temporary, { force: true });
    }
    return { ...summary, backup, applied: true };
}

function parseArguments(argv) {
    const values = [...argv];
    const targetIndex = values.indexOf('--target');
    if (targetIndex < 0 || !values[targetIndex + 1]) {
        throw patchError(
            'mobile_source_v4_queue_patch_argument_invalid',
            'usage: patch-mobile-source-v4-queue.js --target <file> [--check|--apply]'
        );
    }
    const modeFlags = values.filter(value => value === '--check' || value === '--apply');
    if (modeFlags.length > 1) {
        throw patchError(
            'mobile_source_v4_queue_patch_argument_invalid',
            'choose exactly one of --check or --apply'
        );
    }
    const allowed = new Set(['--target', values[targetIndex + 1], '--check', '--apply']);
    if (values.some(value => !allowed.has(value))) {
        throw patchError(
            'mobile_source_v4_queue_patch_argument_invalid',
            'unsupported patch argument'
        );
    }
    return {
        target: values[targetIndex + 1],
        apply: modeFlags[0] === '--apply',
    };
}

if (require.main === module) {
    try {
        const options = parseArguments(process.argv.slice(2));
        process.stdout.write(`${JSON.stringify(patchFile(options.target, options), null, 2)}\n`);
    } catch (error) {
        process.stderr.write(`v4 queue patch failed [${error.code || 'patch_failed'}]\n`);
        process.exitCode = 1;
    }
}

module.exports = {
    DEFAULT_QUEUE_LIMIT,
    MAX_QUEUE_LIMIT,
    V5_MARKERS,
    parseArguments,
    patchFile,
    patchSource,
    validateJavaScript,
};
