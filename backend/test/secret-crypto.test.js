'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { SecretCrypto, SECRET_PREFIX } = require('../services/secret-crypto');

const TEST_KEY = Buffer.alloc(32, 7).toString('base64');

test('AES-GCM 密文可解密且不会包含明文', () => {
    const vault = new SecretCrypto({ key: TEST_KEY });
    const encrypted = vault.encrypt('commercial-secret');
    assert.equal(encrypted.startsWith(SECRET_PREFIX), true);
    assert.equal(encrypted.includes('commercial-secret'), false);
    assert.equal(vault.decrypt(encrypted), 'commercial-secret');
    assert.equal(vault.storageState(encrypted), 'encrypted');
});

test('密文被篡改时失败关闭', () => {
    const vault = new SecretCrypto({ key: TEST_KEY });
    const encrypted = vault.encrypt('commercial-secret');
    const [iv, tag, cipherText] = encrypted.slice(SECRET_PREFIX.length).split('.');
    const cipherBytes = Buffer.from(cipherText, 'base64url');
    cipherBytes[0] ^= 0x01;
    const tampered = `${SECRET_PREFIX}${iv}.${tag}.${cipherBytes.toString('base64url')}`;
    assert.throws(
        () => vault.decrypt(tampered),
        error => error.code === 'settings_secret_decryption_failed'
    );
});

test('未配置主密钥时可兼容读取旧值但拒绝新增明文凭据', () => {
    const vault = new SecretCrypto({ key: '', allowPlaintext: false });
    assert.equal(vault.decrypt('legacy-secret'), 'legacy-secret');
    assert.equal(vault.storageState('legacy-secret'), 'legacy_plaintext');
    assert.throws(
        () => vault.encrypt('new-secret'),
        error => error.code === 'settings_encryption_key_required' && error.statusCode === 503
    );
});
