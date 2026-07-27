'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {createServer, publishRelease} = require('../server');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-update-'));
  const source = path.join(root, 'source.apk');
  fs.writeFileSync(source, 'signed-apk-fixture');
  const data = fs.readFileSync(source);
  const manifest = {
    packageName: 'com.datafordidi.ocruploader',
    versionName: '2.3.1',
    versionCode: 37,
    sha256: crypto.createHash('sha256').update(data).digest('hex'),
    size: data.length,
    apkFile: 'information-auto-recognition-v2.3.1.apk',
    abi: 'arm64-v8a',
  };
  publishRelease(root, source, manifest);
  return {root, manifest};
}

async function request(server, url, options) {
  const address = server.address();
  return fetch(`http://127.0.0.1:${address.port}${url}`, options);
}

test('latest and apk responses have constrained contracts', async (t) => {
  const {root, manifest} = fixture();
  const server = createServer(root).listen(0, '127.0.0.1');
  t.after(() => { server.close(); fs.rmSync(root, {recursive: true, force: true}); });
  await new Promise(resolve => server.once('listening', resolve));
  const latest = await request(server, '/api/mobile-update/latest?packageName=com.datafordidi.ocruploader&versionCode=36&abi=arm64-v8a');
  assert.equal(latest.status, 200);
  assert.equal(latest.headers.get('cache-control'), 'no-store');
  const body = await latest.json();
  assert.equal(body.versionCode, 37);
  assert.equal(body.apkPath, `apk/${manifest.apkFile}`);
  const apk = await request(server, `/api/mobile-update/${body.apkPath}`);
  assert.equal(apk.status, 200);
  assert.equal(apk.headers.get('content-type'), 'application/vnd.android.package-archive');
  assert.equal(apk.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(apk.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.match(apk.headers.get('etag'), /^"sha256-/);
});

test('method, traversal and unpublished apk are rejected', async (t) => {
  const {root} = fixture();
  const server = createServer(root).listen(0, '127.0.0.1');
  t.after(() => { server.close(); fs.rmSync(root, {recursive: true, force: true}); });
  await new Promise(resolve => server.once('listening', resolve));
  assert.equal((await request(server, '/api/mobile-update/latest', {method: 'POST'})).status, 405);
  assert.equal((await request(server, '/api/mobile-update/latest?packageName=other&versionCode=36&abi=arm64-v8a')).status, 400);
  assert.equal((await request(server, '/api/mobile-update/latest?packageName=com.datafordidi.ocruploader&versionCode=36&abi=x86')).status, 400);
  assert.equal((await request(server, '/api/mobile-update/apk/%2e%2e%2fcurrent.json')).status, 404);
  assert.equal((await request(server, '/api/mobile-update/apk/other.apk')).status, 404);
});

test('publish validates digest and atomically exposes manifest', () => {
  const {root, manifest} = fixture();
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'current.json'))).sha256, manifest.sha256);
  assert.throws(() => publishRelease(root, path.join(root, 'source.apk'), {...manifest, size: 1}), /artifact_mismatch/);
  fs.writeFileSync(path.join(root, 'different.apk'), 'different-signed-apk');
  const different = fs.readFileSync(path.join(root, 'different.apk'));
  assert.throws(
      () => publishRelease(root, path.join(root, 'different.apk'), {
        ...manifest,
        sha256: crypto.createHash('sha256').update(different).digest('hex'),
        size: different.length,
      }),
      /immutable_artifact_conflict/
  );
  fs.rmSync(root, {recursive: true, force: true});
});

test('corrupt manifest is not served', async (t) => {
  const {root} = fixture();
  fs.writeFileSync(path.join(root, 'current.json'), '{"apkFile":"../secret.apk"}');
  const server = createServer(root).listen(0, '127.0.0.1');
  t.after(() => { server.close(); fs.rmSync(root, {recursive: true, force: true}); });
  await new Promise(resolve => server.once('listening', resolve));
  assert.equal((await request(server, '/api/mobile-update/latest?packageName=com.datafordidi.ocruploader&versionCode=36&abi=arm64-v8a')).status, 404);
});
