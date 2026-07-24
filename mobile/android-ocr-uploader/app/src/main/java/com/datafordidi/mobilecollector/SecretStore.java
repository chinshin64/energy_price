package com.datafordidi.mobilecollector;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

final class SecretStore {
    private static final String KEY_STORE = "AndroidKeyStore";
    private static final String KEY_ALIAS = "standalone_ocr_uploader_provisioning_v1";
    private static final String TRANSFORMATION = "AES/GCM/NoPadding";

    private SecretStore() {
    }

    static String encrypt(String plaintext) {
        try {
            Cipher cipher = Cipher.getInstance(TRANSFORMATION);
            cipher.init(Cipher.ENCRYPT_MODE, key());
            return "v1." + encode(cipher.getIV()) + "."
                    + encode(cipher.doFinal(plaintext.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception error) {
            throw new IllegalStateException("无法保护回传配置", error);
        }
    }

    static String decrypt(String encoded) {
        String[] parts = encoded == null ? new String[0] : encoded.split("\\.", -1);
        if (parts.length != 3 || !"v1".equals(parts[0])) throw new IllegalStateException("回传配置格式无效");
        try {
            Cipher cipher = Cipher.getInstance(TRANSFORMATION);
            cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, decode(parts[1])));
            return new String(cipher.doFinal(decode(parts[2])), StandardCharsets.UTF_8);
        } catch (Exception error) {
            throw new IllegalStateException("无法读取回传配置", error);
        }
    }

    private static SecretKey key() throws Exception {
        KeyStore keyStore = KeyStore.getInstance(KEY_STORE);
        keyStore.load(null);
        java.security.Key existing = keyStore.getKey(KEY_ALIAS, null);
        if (existing instanceof SecretKey) return (SecretKey) existing;
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEY_STORE);
        generator.init(new KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
        ).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .build());
        return generator.generateKey();
    }

    private static String encode(byte[] value) {
        return Base64.encodeToString(value, Base64.NO_WRAP | Base64.URL_SAFE);
    }

    private static byte[] decode(String value) {
        return Base64.decode(value, Base64.NO_WRAP | Base64.URL_SAFE);
    }
}
