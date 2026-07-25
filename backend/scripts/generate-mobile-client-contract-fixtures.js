'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '../..');
const contractRoot = path.join(__dirname, '../test/mobile-client-contract');
const androidRoot = path.join(projectRoot, 'mobile/android-ocr-uploader');
const iosRoot = path.join(projectRoot, 'mobile/ios');

function run(command, args, options = {}) {
    const result = spawnSync(command, args, {
        cwd: options.cwd || projectRoot,
        env: options.env || process.env,
        encoding: 'utf8',
        stdio: options.stdio || 'pipe',
        maxBuffer: 16 * 1024 * 1024,
    });
    if (result.error || result.status !== 0) {
        const detail = [result.stderr, result.stdout]
            .map(value => String(value || '').trim())
            .filter(Boolean)
            .join('\n')
            .slice(-12000);
        throw new Error(`${command} failed${detail ? `:\n${detail}` : ''}`, {
            cause: result.error,
        });
    }
}

function generateAndroidFixture(tempRoot) {
    const output = path.join(tempRoot, 'android-production.json');
    const initScript = path.join(contractRoot, 'android/include-contract-test.gradle');
    const testDir = path.join(contractRoot, 'android');
    run(path.join(androidRoot, 'gradlew'), [
        '--no-daemon',
        '--console=plain',
        '-I', initScript,
        `-Dmobile.contract.testDir=${testDir}`,
        `-Dmobile.contract.fixtureOutput=${output}`,
        'testDebugUnitTest',
        '--tests', 'com.datafordidi.mobilecollector.ProductionPayloadFixtureTest',
    ], { cwd: androidRoot });
    return readFixture(output);
}

function generateIosFixture(tempRoot) {
    const moduleDir = path.join(tempRoot, 'ios-module');
    fs.mkdirSync(moduleDir, { recursive: true });
    const swiftSdk = process.env.MOBILE_CONTRACT_SWIFT_SDK
        || '/Library/Developer/CommandLineTools/SDKs/MacOSX15.5.sdk';
    if (!fs.statSync(swiftSdk).isDirectory()) {
        throw new Error('a Swift-compiler-compatible macOS SDK is required');
    }
    const moduleBinary = path.join(moduleDir, 'libStationOCRCore.dylib');
    run('swiftc', [
        '-sdk', swiftSdk,
        '-emit-library',
        '-emit-module',
        '-module-name', 'StationOCRCore',
        '-emit-module-path', path.join(moduleDir, 'StationOCRCore.swiftmodule'),
        path.join(iosRoot, 'Sources/StationOCRCore/Models.swift'),
        '-o', moduleBinary,
    ]);
    const executable = path.join(tempRoot, 'ios-production-fixture');
    run('swiftc', [
        '-sdk', swiftSdk,
        '-I', moduleDir,
        '-L', moduleDir,
        '-lStationOCRCore',
        path.join(iosRoot, 'DataForDidiOCRApp/AppConfiguration.swift'),
        path.join(iosRoot, 'DataForDidiOCRApp/CollectedStation.swift'),
        path.join(iosRoot, 'DataForDidiOCRApp/StationSyncClient.swift'),
        path.join(contractRoot, 'ios/ProductionPayloadFixture.swift'),
        '-o', executable,
    ]);
    const output = path.join(tempRoot, 'ios-production.json');
    run(executable, [output], {
        env: {
            ...process.env,
            DYLD_LIBRARY_PATH: [
                moduleDir,
                process.env.DYLD_LIBRARY_PATH,
            ].filter(Boolean).join(path.delimiter),
        },
    });
    return readFixture(output);
}

function readFixture(filePath) {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size < 2 || stat.size > 1024 * 1024) {
        throw new Error('generated mobile client contract fixture has an invalid size');
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function outputPath(argv = process.argv.slice(2)) {
    const index = argv.indexOf('--output');
    if (index < 0 || !argv[index + 1]) {
        throw new Error('Usage: node generate-mobile-client-contract-fixtures.js --output <file>');
    }
    return path.resolve(argv[index + 1]);
}

function main() {
    const destination = outputPath();
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-client-contract-'));
    try {
        const fixtures = [
            generateAndroidFixture(tempRoot),
            generateIosFixture(tempRoot),
        ];
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        const temporary = `${destination}.${process.pid}.tmp`;
        fs.writeFileSync(temporary, `${JSON.stringify(fixtures, null, 2)}\n`, {
            encoding: 'utf8',
            mode: 0o600,
        });
        fs.renameSync(temporary, destination);
        process.stdout.write(`${destination}\n`);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        process.stderr.write(`mobile client contract fixture generation failed: ${error.message}\n`);
        process.exitCode = 1;
    }
}

module.exports = {
    generateAndroidFixture,
    generateIosFixture,
    readFixture,
};
