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
    private static final String ANDROID_KEY_STORE = "AndroidKeyStore";
    private static final String KEY_ALIAS = "data_for_didi_mobile_sync_v1";
    private static final String CIPHER = "AES/GCM/NoPadding";
    private static final String PREFIX = "v1.";

    private SecretStore() {
    }

    static String encrypt(String plaintext) {
        String value = plaintext == null ? "" : plaintext.trim();
        if (value.isEmpty()) {
            return "";
        }
        try {
            Cipher cipher = Cipher.getInstance(CIPHER);
            cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey());
            byte[] ciphertext = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
            return PREFIX
                    + encode(cipher.getIV())
                    + "."
                    + encode(ciphertext);
        } catch (Exception error) {
            throw new IllegalStateException("unable to encrypt mobile credential", error);
        }
    }

    static String decrypt(String encoded) {
        String value = encoded == null ? "" : encoded.trim();
        if (value.isEmpty()) {
            return "";
        }
        String[] parts = value.split("\\.", -1);
        if (parts.length != 3 || !"v1".equals(parts[0])) {
            throw new IllegalStateException("unsupported mobile credential format");
        }
        try {
            Cipher cipher = Cipher.getInstance(CIPHER);
            cipher.init(
                    Cipher.DECRYPT_MODE,
                    getOrCreateKey(),
                    new GCMParameterSpec(128, decode(parts[1]))
            );
            return new String(cipher.doFinal(decode(parts[2])), StandardCharsets.UTF_8);
        } catch (Exception error) {
            throw new IllegalStateException("unable to decrypt mobile credential", error);
        }
    }

    private static SecretKey getOrCreateKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance(ANDROID_KEY_STORE);
        keyStore.load(null);
        java.security.Key existing = keyStore.getKey(KEY_ALIAS, null);
        if (existing instanceof SecretKey) {
            return (SecretKey) existing;
        }

        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEY_STORE);
        generator.init(new KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
        )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
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
