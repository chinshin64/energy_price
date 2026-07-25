package com.chinshin.energyprice.security;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import org.json.JSONObject;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.io.FileInputStream;
import java.io.ByteArrayOutputStream;
import java.security.KeyStore;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.List;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

public final class SecureConfigStore {
    private static final String PREFS = "secure_mobile_source";
    private static final String KEY_ALIAS = "energy_price_ingest_v1";
    private static final String KEY_URL = "root_url";
    private static final String KEY_TOKEN_CIPHER = "token_cipher";
    private static final String KEY_TOKEN_IV = "token_iv";
    private static final String PROVISIONING_FILE = "ocr-provisioning.json";

    private SecureConfigStore() {}

    public static boolean importProvisioningIfPresent(Context context) {
        List<File> candidates = new ArrayList<>();
        candidates.add(new File(context.getFilesDir(), PROVISIONING_FILE));
        if (context.getExternalFilesDir(null) != null) {
            candidates.add(new File(context.getExternalFilesDir(null), PROVISIONING_FILE));
        }
        for (File file : candidates) {
            if (!file.isFile()) continue;
            try {
                String json = readUtf8(file);
                JSONObject object = new JSONObject(json);
                String url = normalizeRootUrl(object.getString("url"));
                String token = object.getString("token").trim();
                if (token.length() < 32) throw new IllegalArgumentException("token too short");
                store(context, url, token);
                if (!file.delete()) file.deleteOnExit();
                return true;
            } catch (Exception e) {
                return false;
            }
        }
        return false;
    }

    public static boolean isConfigured(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        return prefs.contains(KEY_URL) && prefs.contains(KEY_TOKEN_CIPHER) && prefs.contains(KEY_TOKEN_IV);
    }

    public static Config read(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String url = prefs.getString(KEY_URL, null);
        String cipher = prefs.getString(KEY_TOKEN_CIPHER, null);
        String iv = prefs.getString(KEY_TOKEN_IV, null);
        if (url == null || cipher == null || iv == null) return null;
        try {
            Cipher decrypt = Cipher.getInstance("AES/GCM/NoPadding");
            decrypt.init(Cipher.DECRYPT_MODE, getOrCreateKey(), new GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)));
            byte[] plain = decrypt.doFinal(Base64.decode(cipher, Base64.NO_WRAP));
            return new Config(url, new String(plain, StandardCharsets.UTF_8));
        } catch (Exception e) {
            return null;
        }
    }

    private static String readUtf8(File file) throws Exception {
        try (FileInputStream input = new FileInputStream(file);
             ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[4096];
            int count;
            while ((count = input.read(buffer)) >= 0) output.write(buffer, 0, count);
            return output.toString(StandardCharsets.UTF_8.name());
        }
    }

    private static void store(Context context, String url, String token) throws Exception {
        Cipher encrypt = Cipher.getInstance("AES/GCM/NoPadding");
        byte[] iv = new byte[12];
        new SecureRandom().nextBytes(iv);
        encrypt.init(Cipher.ENCRYPT_MODE, getOrCreateKey(), new GCMParameterSpec(128, iv));
        byte[] cipher = encrypt.doFinal(token.getBytes(StandardCharsets.UTF_8));
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putString(KEY_URL, url)
                .putString(KEY_TOKEN_IV, Base64.encodeToString(iv, Base64.NO_WRAP))
                .putString(KEY_TOKEN_CIPHER, Base64.encodeToString(cipher, Base64.NO_WRAP))
                .apply();
    }

    private static SecretKey getOrCreateKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
        keyStore.load(null);
        if (keyStore.containsAlias(KEY_ALIAS)) {
            return (SecretKey) keyStore.getKey(KEY_ALIAS, null);
        }
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build());
        return generator.generateKey();
    }

    private static String normalizeRootUrl(String raw) throws Exception {
        String value = raw.trim();
        while (value.endsWith("/")) value = value.substring(0, value.length() - 1);
        java.net.URI uri = java.net.URI.create(value);
        if (!"https".equalsIgnoreCase(uri.getScheme())) throw new IllegalArgumentException("HTTPS required");
        if (uri.getHost() == null || uri.getPort() != -1) throw new IllegalArgumentException("root URL with no port required");
        if (uri.getPath() != null && !uri.getPath().isEmpty()) throw new IllegalArgumentException("root URL must not contain a path");
        return value;
    }

    public static final class Config {
        private final String rootUrl;
        private final String token;
        public Config(String rootUrl, String token) {
            this.rootUrl = rootUrl;
            this.token = token;
        }
        public String rootUrl() { return rootUrl; }
        public String token() { return token; }
    }
}
