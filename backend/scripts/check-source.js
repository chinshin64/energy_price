'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const backendRoot = path.resolve(__dirname, '..');
const projectRoot = path.resolve(backendRoot, '..');
const roots = [
    backendRoot,
    path.join(projectRoot, 'frontend', 'public'),
    path.join(projectRoot, 'scripts'),
];
const ignoredDirectories = new Set(['node_modules', '.git', 'build', 'dist']);

function collectJavaScriptFiles(root, result = []) {
    if (!fs.existsSync(root)) {
        return result;
    }
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (entry.isDirectory() && ignoredDirectories.has(entry.name)) {
            continue;
        }
        const absolutePath = path.join(root, entry.name);
        if (entry.isDirectory()) {
            collectJavaScriptFiles(absolutePath, result);
        } else if (entry.isFile() && /\.(?:js|mjs|cjs)$/.test(entry.name)) {
            result.push(absolutePath);
        }
    }
    return result;
}

const files = roots.flatMap(root => collectJavaScriptFiles(root)).sort();
const failures = [];

for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.status !== 0) {
        failures.push({
            file: path.relative(projectRoot, file),
            output: String(result.stderr || result.stdout || '').trim(),
        });
    }
}

if (failures.length > 0) {
    for (const failure of failures) {
        console.error(`Syntax check failed: ${failure.file}`);
        console.error(failure.output);
    }
    process.exitCode = 1;
} else {
    console.log(`Syntax check passed for ${files.length} JavaScript files.`);
}
