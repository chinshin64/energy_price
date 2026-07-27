#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PRODUCTION_V4_SHA256 =
    '1c117c5e30b945922ca56f86e210aaab76380e766886f41f384ebfad225432e3';
const PRODUCTION_V4_PATCHED_SHA256 =
    'd112195bf1867b7e7bf3d8e0cfd884180a4e4f4e88e07b2f5fa924e8a71f327c';
const PATCH_MARKER = "require('./mobile-source-fuel-wide-writer')";

const REQUIRE_BEFORE =
    "const { MobileSourceMysqlMigrator } = require('./mobile-source-mysql-migrator');";
const REQUIRE_AFTER = `${REQUIRE_BEFORE}
const { MobileSourceFuelWideWriter } = require('./mobile-source-fuel-wide-writer');`;

const CONSTRUCTOR_BEFORE = `        this.schemaValidator = options.schemaValidator
            || new MobileSourceMysqlMigrator({ connection: this.pool });`;
const CONSTRUCTOR_AFTER = `${CONSTRUCTOR_BEFORE}
        this.fuelWideWriter = options.fuelWideWriter
            || new MobileSourceFuelWideWriter({
                snapshotTable: 'mobile_ocr_station_snapshots',
                requireFuelStationType: true,
            });`;

const INGEST_BEFORE = `                    for (const quote of station.fuelQuotes || []) {
                        const quoteValues = [
                            sourceRecordId,
                            quote.quoteObservationId,
                            quote.quoteDedupKey,
                            quote.gradeCode,
                            quote.gradeLabel,
                            quote.gunCode,
                            quote.gunLabel,
                            quote.selectedAmount,
                            quote.grossDiscount,
                            quote.serviceFee,
                            quote.netDiscount,
                            quote.payableAmount,
                            quote.quoteEntry,
                            quote.needsReview ? 1 : 0,
                            quote.capturedAt || station.capturedAt || batch.capturedAt,
                            JSON.stringify(quote.raw || {}),
                        ];
                        await connection.execute(\`
                            INSERT INTO mobile_ocr_fuel_quotes (
                                source_record_id, quote_observation_id, quote_dedup_key,
                                grade_code, grade_label, gun_code, gun_label, selected_amount,
                                gross_discount, service_fee, net_discount, payable_amount,
                                quote_entry, needs_review, captured_at, raw_data
                            ) VALUES (\${quoteValues.map(() => '?').join(', ')})
                        \`, quoteValues);
                        acceptedQuoteCount += 1;
                    }`;
const INGEST_AFTER = `${INGEST_BEFORE}
                    await this.fuelWideWriter.upsertSourceRecord(
                        connection,
                        sourceRecordId
                    );`;

function sha256(content) {
    return crypto.createHash('sha256').update(content).digest('hex');
}

function patchError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function replaceExactlyOnce(source, before, after, label) {
    const first = source.indexOf(before);
    if (first < 0 || source.indexOf(before, first + before.length) >= 0) {
        throw patchError(
            'mobile_source_v4_patch_context_invalid',
            `production v4 patch context must occur exactly once: ${label}`
        );
    }
    return `${source.slice(0, first)}${after}${source.slice(first + before.length)}`;
}

function applyPatch(source, options = {}) {
    const expectedSha256 = options.expectedSha256 || PRODUCTION_V4_SHA256;
    if (source.includes(PATCH_MARKER)) {
        const originalSha256 = sha256(source);
        const expectedPatchedSha256 = options.expectedPatchedSha256
            || PRODUCTION_V4_PATCHED_SHA256;
        if (originalSha256 !== expectedPatchedSha256) {
            throw patchError(
                'mobile_source_v4_patch_sha_mismatch',
                'refusing an already-patched store that differs from the audited production file'
            );
        }
        return { content: source, alreadyPatched: true, originalSha256 };
    }
    const originalSha256 = sha256(source);
    if (originalSha256 !== expectedSha256) {
        throw patchError(
            'mobile_source_v4_patch_sha_mismatch',
            'refusing to patch a store that is not the audited production v4 file'
        );
    }
    let content = replaceExactlyOnce(
        source,
        REQUIRE_BEFORE,
        REQUIRE_AFTER,
        'writer require'
    );
    content = replaceExactlyOnce(
        content,
        CONSTRUCTOR_BEFORE,
        CONSTRUCTOR_AFTER,
        'writer constructor'
    );
    content = replaceExactlyOnce(
        content,
        INGEST_BEFORE,
        INGEST_AFTER,
        'same-transaction writer call'
    );
    return {
        content,
        alreadyPatched: false,
        originalSha256,
        patchedSha256: sha256(content),
    };
}

function parseArguments(argv) {
    const args = [...argv];
    const mode = args[0] === '--apply' ? 'apply' : 'check';
    if (args[0] === '--apply' || args[0] === '--check') args.shift();
    if (args.length !== 1) {
        throw patchError(
            'mobile_source_v4_patch_argument_invalid',
            'usage: patch-mobile-source-v4-fuel-wide-store.js [--check|--apply] <store-file>'
        );
    }
    return { mode, target: path.resolve(args[0]) };
}

function runCli(options = {}) {
    const argv = options.argv || process.argv.slice(2);
    const logger = options.logger || console.log;
    const { mode, target } = parseArguments(argv);
    const source = fs.readFileSync(target, 'utf8');
    const result = applyPatch(source);
    if (mode === 'check' || result.alreadyPatched) {
        logger(result.alreadyPatched
            ? 'production v4 fuel wide store patch already present'
            : 'production v4 fuel wide store patch check passed');
        return { mode, target, ...result };
    }
    const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '');
    const backup = `${target}.pre-fuel-wide-${timestamp}.bak`;
    const temporary = `${target}.fuel-wide-${process.pid}.tmp`;
    const targetStat = fs.statSync(target);
    fs.copyFileSync(target, backup, fs.constants.COPYFILE_EXCL);
    fs.writeFileSync(temporary, result.content, {
        encoding: 'utf8',
        mode: targetStat.mode,
        flag: 'wx',
    });
    fs.chownSync(temporary, targetStat.uid, targetStat.gid);
    fs.chmodSync(temporary, targetStat.mode);
    fs.renameSync(temporary, target);
    logger('production v4 fuel wide store patch applied; backup created');
    return { mode, target, backup, ...result };
}

if (require.main === module) {
    try {
        runCli();
    } catch (error) {
        const code = /^[a-z0-9_]+$/i.test(String(error?.code || ''))
            ? error.code
            : 'mobile_source_v4_patch_failed';
        console.error(`production v4 fuel wide store patch failed [${code}]`);
        process.exitCode = 1;
    }
}

module.exports = {
    PATCH_MARKER,
    PRODUCTION_V4_PATCHED_SHA256,
    PRODUCTION_V4_SHA256,
    applyPatch,
    parseArguments,
    runCli,
    sha256,
};
