'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {publishRelease} = require('./server');

const [rootArg, apkArg, manifestArg] = process.argv.slice(2);
if (!rootArg || !apkArg || !manifestArg) {
  process.stderr.write('usage: node publish.js <release-root> <apk> <manifest-json>\n');
  process.exit(2);
}

const root = path.resolve(rootArg);
const apk = path.resolve(apkArg);
const manifest = JSON.parse(fs.readFileSync(path.resolve(manifestArg), 'utf8'));
publishRelease(root, apk, manifest);
process.stdout.write('release published\n');
