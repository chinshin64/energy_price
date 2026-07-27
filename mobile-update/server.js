'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const DEFAULT_ROOT = path.join(__dirname, 'releases');
const MANIFEST = 'current.json';

function validateManifest(value) {
  if (!value || typeof value !== 'object') throw new Error('manifest_invalid');
  const apkFile = String(value.apkFile || '');
  if (!/^[A-Za-z0-9._-]+\.apk$/.test(apkFile) || path.basename(apkFile) !== apkFile) {
    throw new Error('manifest_apk_invalid');
  }
  if (!/^[0-9a-f]{64}$/.test(String(value.sha256 || ''))) throw new Error('manifest_sha_invalid');
  if (!Number.isSafeInteger(value.versionCode) || value.versionCode <= 0
      || !Number.isSafeInteger(value.size) || value.size <= 0
      || typeof value.packageName !== 'string' || !value.packageName
      || typeof value.versionName !== 'string' || !value.versionName) {
    throw new Error('manifest_invalid');
  }
  if (value.abi !== 'arm64-v8a') throw new Error('manifest_abi_invalid');
  return Object.freeze({...value, apkFile});
}

function readManifest(root) {
  return validateManifest(JSON.parse(fs.readFileSync(path.join(root, MANIFEST), 'utf8')));
}

function safeApk(root, file) {
  if (!/^[A-Za-z0-9._-]+\.apk$/.test(file) || path.basename(file) !== file) return null;
  const apkRoot = fs.realpathSync(path.join(root, 'apk'));
  const candidate = fs.realpathSync(path.join(apkRoot, file));
  return candidate.startsWith(apkRoot + path.sep) ? candidate : null;
}

function json(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(data);
}

function createServer(root = DEFAULT_ROOT) {
  return http.createServer((req, res) => {
    try {
      if (req.method !== 'GET') return json(res, 405, {success: false, error: 'method_not_allowed'});
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/api/mobile-update/latest') {
        const manifest = readManifest(root);
        const requestedPackage = url.searchParams.get('packageName');
        const requestedVersion = url.searchParams.get('versionCode');
        const requestedAbi = url.searchParams.get('abi');
        if (requestedPackage !== manifest.packageName
            || requestedAbi !== manifest.abi
            || !/^[0-9]+$/.test(requestedVersion || '')) {
          return json(res, 400, {success: false, error: 'client_invalid'});
        }
        return json(res, 200, {
          packageName: manifest.packageName,
          versionName: manifest.versionName,
          versionCode: manifest.versionCode,
          sha256: manifest.sha256,
          size: manifest.size,
          apkPath: `apk/${manifest.apkFile}`,
          abi: manifest.abi,
        });
      }
      const prefix = '/api/mobile-update/apk/';
      if (!url.pathname.startsWith(prefix)) return json(res, 404, {success: false, error: 'not_found'});
      const encoded = url.pathname.slice(prefix.length);
      const file = decodeURIComponent(encoded);
      const manifest = readManifest(root);
      if (file !== manifest.apkFile) return json(res, 404, {success: false, error: 'not_found'});
      const target = safeApk(root, file);
      if (!target) return json(res, 404, {success: false, error: 'not_found'});
      const stat = fs.statSync(target);
      res.writeHead(200, {
        'Content-Type': 'application/vnd.android.package-archive',
        'Content-Length': stat.size,
        'Cache-Control': 'public, max-age=31536000, immutable',
        'ETag': `"sha256-${manifest.sha256}"`,
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': `attachment; filename="${file}"`,
      });
      fs.createReadStream(target).pipe(res);
    } catch {
      json(res, 404, {success: false, error: 'not_found'});
    }
  });
}

function sha256(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function publishRelease(root, sourceApk, inputManifest) {
  const manifest = validateManifest({...inputManifest, apkFile: path.basename(inputManifest.apkFile || sourceApk)});
  const stat = fs.statSync(sourceApk);
  if (stat.size !== manifest.size || sha256(sourceApk) !== manifest.sha256) throw new Error('artifact_mismatch');
  const apkRoot = path.join(root, 'apk');
  fs.mkdirSync(apkRoot, {recursive: true});
  const apkTemp = path.join(apkRoot, `.${manifest.apkFile}.${process.pid}.tmp`);
  const apkTarget = path.join(apkRoot, manifest.apkFile);
  if (fs.existsSync(apkTarget)) {
    if (fs.statSync(apkTarget).size !== manifest.size || sha256(apkTarget) !== manifest.sha256) {
      throw new Error('immutable_artifact_conflict');
    }
  } else {
    fs.copyFileSync(sourceApk, apkTemp);
    fs.renameSync(apkTemp, apkTarget);
  }
  const manifestTemp = path.join(root, `.${MANIFEST}.${process.pid}.tmp`);
  fs.writeFileSync(manifestTemp, JSON.stringify(manifest) + '\n', {mode: 0o640});
  fs.renameSync(manifestTemp, path.join(root, MANIFEST));
}

if (require.main === module) {
  const root = path.resolve(process.env.MOBILE_UPDATE_ROOT || DEFAULT_ROOT);
  const host = process.env.MOBILE_UPDATE_HOST || '127.0.0.1';
  const port = Number(process.env.MOBILE_UPDATE_PORT || 50082);
  createServer(root).listen(port, host);
}

module.exports = {createServer, publishRelease, readManifest, validateManifest};
