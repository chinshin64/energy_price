package com.datafordidi.mobilecollector;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.nio.charset.StandardCharsets;
import java.util.UUID;

final class AppSettings {
    static final String PROVISIONING_FILE = "ocr-provisioning.json";
    private static final String PREFS = "standalone_ocr_settings";

    private AppSettings() {
    }

    static String getUploadUrl(Context context) {
        return compact(prefs(context).getString("uploadUrl", "")).replaceAll("/+$", "");
    }

    static String getUploadToken(Context context) {
        String encrypted = compact(prefs(context).getString("uploadTokenCiphertext", ""));
        return encrypted.isEmpty() ? "" : SecretStore.decrypt(encrypted);
    }

    static boolean isUploadConfigured(Context context) {
        return !getUploadUrl(context).isEmpty() && !getUploadToken(context).isEmpty();
    }

    static void provision(Context context, String url, String token) {
        String normalizedUrl = compact(url).replaceAll("/+$", "");
        String normalizedToken = compact(token);
        String storedToken = compact(prefs(context).getString("uploadTokenCiphertext", ""));
        if (normalizedUrl.isEmpty() || (normalizedToken.isEmpty() && storedToken.isEmpty())) {
            throw new IllegalArgumentException("回传配置不完整");
        }
        try {
            UploadEndpointPolicy.requireHttpsBaseUrl(normalizedUrl);
        } catch (IllegalStateException error) {
            throw new IllegalArgumentException(error.getMessage(), error);
        }
        SharedPreferences.Editor editor = prefs(context).edit()
                .putString("uploadUrl", normalizedUrl)
                .remove("allowCleartext");
        if (!normalizedToken.isEmpty()) {
            editor.putString("uploadTokenCiphertext", SecretStore.encrypt(normalizedToken));
        }
        if (!editor.commit()) {
            throw new IllegalStateException("无法保存回传配置");
        }
        BackfillRetryScheduler.resetAfterProvisioning(context);
    }

    static boolean importProvisioningFile(Context context) {
        File file = new File(context.getFilesDir(), PROVISIONING_FILE);
        if (!file.isFile()) return false;
        try {
            JSONObject value = new JSONObject(read(file));
            provision(
                    context,
                    value.optString("url", getUploadUrl(context)),
                    value.optString("token", "")
            );
            return true;
        } catch (Exception error) {
            throw new IllegalStateException("设备预置失败", error);
        } finally {
            if (!file.delete()) file.deleteOnExit();
        }
    }

    static String getDeviceSessionId(Context context) {
        SharedPreferences preferences = prefs(context);
        String current = preferences.getString("deviceSessionId", "");
        if (current != null && !current.trim().isEmpty()) return current.trim();
        String created = "ocr-device-" + UUID.randomUUID();
        if (!preferences.edit().putString("deviceSessionId", created).commit()) {
            throw new IllegalStateException("无法保存设备标识");
        }
        return created;
    }

    private static String read(File file) throws Exception {
        try (FileInputStream input = new FileInputStream(file);
             ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[4096];
            int count;
            while ((count = input.read(buffer)) >= 0) output.write(buffer, 0, count);
            return output.toString(StandardCharsets.UTF_8.name());
        }
    }

    private static String compact(String value) {
        return value == null ? "" : value.trim();
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
