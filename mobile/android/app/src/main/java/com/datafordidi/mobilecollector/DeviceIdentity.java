package com.datafordidi.mobilecollector;

import android.annotation.SuppressLint;
import android.content.Context;
import android.content.SharedPreferences;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.UUID;

@SuppressLint("ApplySharedPref")
final class DeviceIdentity {
    private DeviceIdentity() {
    }

    static synchronized String get(Context context) {
        SharedPreferences preferences = context.getSharedPreferences("collector_identity", Context.MODE_PRIVATE);
        String stored = preferences.getString("installationId", "");
        if (stored == null || stored.trim().isEmpty()) {
            stored = UUID.randomUUID().toString();
            if (!preferences.edit().putString("installationId", stored).commit()) {
                throw new IllegalStateException("unable to persist device identity");
            }
        }
        return "collector-" + hash(stored.trim() + ":" + context.getPackageName()).substring(0, 20);
    }

    static String hash(String value) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256")
                    .digest(String.valueOf(value).getBytes(StandardCharsets.UTF_8));
            StringBuilder output = new StringBuilder(digest.length * 2);
            for (byte item : digest) {
                output.append(String.format("%02x", item & 0xff));
            }
            return output.toString();
        } catch (Exception error) {
            throw new IllegalStateException("unable to derive device identity", error);
        }
    }
}
