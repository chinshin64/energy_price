package com.datafordidi.mobilecollector;

import org.json.JSONObject;

import java.util.Locale;

final class AppUpdatePolicy {
    static final long STARTUP_INTERVAL_MS = 24L * 60L * 60L * 1000L;
    static final long MAX_APK_BYTES = 100L * 1024L * 1024L;

    private AppUpdatePolicy() {
    }

    static boolean due(long now, long lastCheckedAt) {
        return lastCheckedAt <= 0 || now - lastCheckedAt >= STARTUP_INTERVAL_MS || now < lastCheckedAt;
    }

    static Manifest parse(JSONObject value, String expectedPackage, long currentVersionCode) {
        if (value == null) throw new IllegalArgumentException("update_manifest_invalid");
        String packageName = clean(value.optString("packageName"));
        String versionName = clean(value.optString("versionName"));
        String apkPath = clean(value.optString("apkPath"));
        String sha256 = clean(value.optString("sha256")).toLowerCase(Locale.ROOT);
        long versionCode = value.optLong("versionCode", -1);
        long size = value.optLong("size", -1);
        if (!clean(expectedPackage).equals(packageName)
                || versionName.isEmpty()
                || versionCode <= 0
                || size <= 0 || size > MAX_APK_BYTES
                || !sha256.matches("[0-9a-f]{64}")
                || !apkPath.matches("apk/[A-Za-z0-9._-]+\\.apk")) {
            throw new IllegalArgumentException("update_manifest_invalid");
        }
        return new Manifest(packageName, versionName, versionCode, sha256, size, apkPath);
    }

    static boolean isNewer(Manifest manifest, long currentVersionCode) {
        return manifest != null && manifest.versionCode > currentVersionCode;
    }

    static final class Manifest {
        final String packageName;
        final String versionName;
        final long versionCode;
        final String sha256;
        final long size;
        final String apkPath;

        Manifest(String packageName, String versionName, long versionCode, String sha256, long size, String apkPath) {
            this.packageName = packageName;
            this.versionName = versionName;
            this.versionCode = versionCode;
            this.sha256 = sha256;
            this.size = size;
            this.apkPath = apkPath;
        }
    }

    private static String clean(String value) {
        return value == null ? "" : value.trim();
    }
}
