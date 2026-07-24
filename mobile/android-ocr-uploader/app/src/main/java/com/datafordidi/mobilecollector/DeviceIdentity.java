package com.datafordidi.mobilecollector;

import android.content.Context;
import android.content.SharedPreferences;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.UUID;

final class DeviceIdentity {
    private DeviceIdentity() {
    }

    static synchronized String get(Context context) {
        SharedPreferences preferences = context.getSharedPreferences("standalone_ocr_identity", Context.MODE_PRIVATE);
        String installationId = preferences.getString("installationId", "");
        if (installationId == null || installationId.trim().isEmpty()) {
            installationId = UUID.randomUUID().toString();
            if (!preferences.edit().putString("installationId", installationId).commit()) {
                throw new IllegalStateException("无法保存安装标识");
            }
        }
        return "ocr-" + sha256(installationId.trim() + ":" + context.getPackageName()).substring(0, 24);
    }

    static String sha256(String value) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256")
                    .digest(String.valueOf(value).getBytes(StandardCharsets.UTF_8));
            StringBuilder output = new StringBuilder(digest.length * 2);
            for (byte item : digest) output.append(String.format("%02x", item & 0xff));
            return output.toString();
        } catch (Exception error) {
            throw new IllegalStateException("无法生成安装标识摘要", error);
        }
    }
}
