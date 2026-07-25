'use strict';

const crypto = require('crypto');

const SECRET_PREFIX = 'enc:v1:';
const ALGORITHM = 'aes-256-gcm';
const AAD = Buffer.from('blue-team-settings:v1', 'utf8');

function secretError(code, message) {
    const error = new Error(message);
    error.code = code;
    error.statusCode = 503;
    return error;
}

function decodeKey(value) {
    const text = String(value || '').trim();
    if (!text) return null;

    let key;
    if (/^(?:hex:)?[a-f0-9]{64}$/i.test(text)) {
        key = Buffer.from(text.replace(/^hex:/i, ''), 'hex');
    } else {
        const encoded = text.replace(/^base64:/i, '');
        key = Buffer.from(encoded, 'base64');
    }

    if (key.length !== 32) {
        throw secretError(
            'settings_encryption_key_invalid',
            'SETTINGS_ENCRYPTION_KEY must decode to exactly 32 bytes'
        );
    }
    return key;
}

class SecretCrypto {
    constructor(options = {}) {
        this.key = decodeKey(options.key ?? process.env.SETTINGS_ENCRYPTION_KEY);
        this.allowPlaintext = options.allowPlaintext !== undefined
            ? options.allowPlaintext === true
            : /^(1|true|yes|on)$/i.test(String(process.env.ALLOW_PLAINTEXT_SECRETS || ''));
    }

    isConfigured() {
        return Boolean(this.key);
    }

    isEncrypted(value) {
        return String(value || '').startsWith(SECRET_PREFIX);
    }

    encrypt(value) {
        const plaintext = String(value || '');
        if (!plaintext) return '';
        if (!this.key) {
            if (this.allowPlaintext) return plaintext;
            throw secretError(
                'settings_encryption_key_required',
                'SETTINGS_ENCRYPTION_KEY is required before saving credentials'
            );
        }

        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv(ALGORITHM, this.key, iv);
        cipher.setAAD(AAD);
        const encrypted = Buffer.concat([
            cipher.update(plaintext, 'utf8'),
            cipher.final()
        ]);
        const tag = cipher.getAuthTag();
        return `${SECRET_PREFIX}${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`;
    }

    decrypt(value) {
        const stored = String(value || '');
        if (!stored || !this.isEncrypted(stored)) return stored;
        if (!this.key) {
            throw secretError(
                'settings_encryption_key_required',
                'SETTINGS_ENCRYPTION_KEY is required to decrypt stored credentials'
            );
        }

        try {
            const payload = stored.slice(SECRET_PREFIX.length);
            const [ivText, tagText, cipherText, ...extra] = payload.split('.');
            if (!ivText || !tagText || !cipherText || extra.length > 0) throw new Error('invalid payload');
            const decipher = crypto.createDecipheriv(
                ALGORITHM,
                this.key,
                Buffer.from(ivText, 'base64url')
            );
            decipher.setAAD(AAD);
            decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
            return Buffer.concat([
                decipher.update(Buffer.from(cipherText, 'base64url')),
                decipher.final()
            ]).toString('utf8');
        } catch {
            throw secretError(
                'settings_secret_decryption_failed',
                'Stored credential could not be decrypted with SETTINGS_ENCRYPTION_KEY'
            );
        }
    }

    storageState(value) {
        const stored = String(value || '');
        if (!stored) return 'empty';
        return this.isEncrypted(stored) ? 'encrypted' : 'legacy_plaintext';
    }
}

const defaultSecretCrypto = new SecretCrypto();

module.exports = {
    SecretCrypto,
    defaultSecretCrypto,
    decodeKey,
    SECRET_PREFIX
};
