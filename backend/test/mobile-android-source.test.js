'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const mobileRoot = path.resolve(__dirname, '../../mobile/android');

function read(relativePath) {
    return fs.readFileSync(path.join(mobileRoot, relativePath), 'utf8');
}

test('Android 移动采集端源码完整且自动化入口受 shell 权限保护', () => {
    const manifest = read('app/src/main/AndroidManifest.xml');
    const receiver = read('app/src/main/java/com/datafordidi/mobilecollector/AutomationCommandReceiver.java');
    const activity = read('app/src/main/java/com/datafordidi/mobilecollector/MainActivity.java');

    assert.match(manifest, /protectionLevel="signature"/);
    assert.match(manifest, /android:permission="android\.permission\.DUMP"/);
    assert.match(manifest, /usesCleartextTraffic="\$\{usesCleartextTraffic\}"/);
    assert.match(receiver, /ACTION_STOP/);
    assert.equal(activity.includes('handleAutomationIntent'), false);
});

test('Android 凭据使用 Keystore 且远端命令不能改写控制端点', () => {
    const settings = read('app/src/main/java/com/datafordidi/mobilecollector/CollectorSettings.java');
    const secretStore = read('app/src/main/java/com/datafordidi/mobilecollector/SecretStore.java');
    const commandService = read('app/src/main/java/com/datafordidi/mobilecollector/NetworkCommandService.java');

    assert.equal(settings.includes('.putString("token"'), false);
    assert.equal(settings.includes('.putString("deviceSessionId"'), false);
    assert.match(settings, /SecretStore\.encrypt/);
    assert.match(secretStore, /AndroidKeyStore/);
    assert.match(secretStore, /AES\/GCM\/NoPadding/);
    assert.equal(commandService.includes('payload.optString("serverUrl"'), false);
    assert.equal(commandService.includes('payload.optString("token"'), false);
    assert.match(commandService, /ALLOWED_LAUNCH_PACKAGES/);
});

test('Android Edge 协议上报隐私安全设备档案并保留旧移动通道回退', () => {
    const profile = read('app/src/main/java/com/datafordidi/mobilecollector/EdgeDeviceProfile.java');
    const client = read('app/src/main/java/com/datafordidi/mobilecollector/SyncClient.java');
    const commandService = read('app/src/main/java/com/datafordidi/mobilecollector/NetworkCommandService.java');
    const settings = read('app/src/main/java/com/datafordidi/mobilecollector/CollectorSettings.java');

    assert.match(profile, /fingerprintHash/);
    assert.match(profile, /installationIdHash/);
    assert.equal(/ANDROID_ID|Build\.getSerial|WifiInfo|getMacAddress/.test(profile), false);
    assert.match(client, /\/api\/edge\/v1\/nodes\/register/);
    assert.match(client, /\/api\/edge\/v1\/tasks\/poll/);
    assert.match(commandService, /pollEdgeTask/);
    assert.match(commandService, /pollCommand/);
    assert.match(commandService, /EDGE_REGISTRATION_RETRY_MS/);
    assert.match(client, /getEdgeEnrollmentToken/);
    assert.match(settings, /edgeEnrollmentCiphertext/);
    assert.match(commandService, /edge registration unavailable, keeping legacy channel/);
});
