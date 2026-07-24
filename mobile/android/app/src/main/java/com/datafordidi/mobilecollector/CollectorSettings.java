package com.datafordidi.mobilecollector;

import android.annotation.SuppressLint;
import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import java.util.concurrent.ThreadLocalRandom;

@SuppressLint("ApplySharedPref")
public final class CollectorSettings {
    private static final String TAG = "DataForDidiSettings";
    private static final String PREFS = "collector_settings";
    private static final String DEFAULT_SERVER_URL = "http://47.111.139.230:50080";
    private static final String TOKEN_KEY = "tokenCiphertext";
    private static final String LEGACY_TOKEN_KEY = "token";
    private static final String DEVICE_SESSION_KEY = "deviceSessionCiphertext";
    private static final String LEGACY_DEVICE_SESSION_KEY = "deviceSessionId";
    private static final String EDGE_SESSION_KEY = "edgeSessionCiphertext";
    private static final String EDGE_ENROLLMENT_KEY = "edgeEnrollmentCiphertext";
    private static final String EDGE_PARENT_NODE_KEY = "edgeParentNodeId";
    private static final String RAW_OCR_UPLOAD_KEY = "rawOcrUploadEnabled";
    private static final int MIN_INTERVAL_FLOOR_MS = 1500;
    private static final int DEFAULT_MIN_INTERVAL_MS = 2500;
    private static final int DEFAULT_MAX_INTERVAL_MS = 6500;

    private CollectorSettings() {
    }

    public static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    public static String getServerUrl(Context context) {
        return sanitizeServerUrl(prefs(context).getString("serverUrl", DEFAULT_SERVER_URL));
    }

    public static String getToken(Context context) {
        return readSecret(context, TOKEN_KEY, LEGACY_TOKEN_KEY);
    }

    public static boolean hasToken(Context context) {
        return !getToken(context).isEmpty();
    }

    public static void migrateSecrets(Context context) {
        getToken(context);
        getDeviceSessionId(context);
        getEdgeSessionToken(context);
        getEdgeEnrollmentToken(context);
    }

    public static String getDeviceSessionId(Context context) {
        return readSecret(context, DEVICE_SESSION_KEY, LEGACY_DEVICE_SESSION_KEY);
    }

    public static void saveDeviceSessionId(Context context, String deviceSessionId) {
        saveSecret(context, DEVICE_SESSION_KEY, LEGACY_DEVICE_SESSION_KEY, deviceSessionId, false);
    }

    public static String getEdgeSessionToken(Context context) {
        return readSecret(context, EDGE_SESSION_KEY, "edgeSessionToken");
    }

    public static void saveEdgeSessionToken(Context context, String value) {
        saveSecret(context, EDGE_SESSION_KEY, "edgeSessionToken", value, false);
    }

    public static void clearEdgeSessionToken(Context context) {
        saveEdgeSessionToken(context, "");
    }

    public static String getEdgeEnrollmentToken(Context context) {
        String value = readSecret(context, EDGE_ENROLLMENT_KEY, "edgeEnrollmentToken");
        return value.isEmpty() ? getToken(context) : value;
    }

    public static boolean hasEdgeEnrollmentToken(Context context) {
        return !getEdgeEnrollmentToken(context).isEmpty();
    }

    public static void saveEdgeEnrollmentToken(Context context, String value) {
        String normalized = value == null ? "" : value.trim();
        if (normalized.isEmpty()) return;
        saveSecret(context, EDGE_ENROLLMENT_KEY, "edgeEnrollmentToken", normalized, true);
        clearEdgeSessionToken(context);
    }

    public static String getEdgeParentNodeId(Context context) {
        return prefs(context).getString(EDGE_PARENT_NODE_KEY, "");
    }

    public static void saveEdgeParentNodeId(Context context, String value) {
        String normalized = value == null ? "" : value.trim();
        if (normalized.length() > 128) normalized = normalized.substring(0, 128);
        if (!prefs(context).edit().putString(EDGE_PARENT_NODE_KEY, normalized).commit()) {
            throw new IllegalStateException("unable to persist edge parent node id");
        }
    }

    public static String getPlatform(Context context) {
        return prefs(context).getString("platform", "didi-charging");
    }

    public static String getCity(Context context) {
        return prefs(context).getString("city", "");
    }

    public static int getMinIntervalMillis(Context context) {
        int legacy = prefs(context).getInt("intervalMillis", DEFAULT_MIN_INTERVAL_MS);
        return Math.max(MIN_INTERVAL_FLOOR_MS, prefs(context).getInt("minIntervalMillis", legacy));
    }

    public static int getMaxIntervalMillis(Context context) {
        int legacy = prefs(context).getInt("intervalMillis", DEFAULT_MAX_INTERVAL_MS);
        int min = getMinIntervalMillis(context);
        return Math.max(min, prefs(context).getInt("maxIntervalMillis", Math.max(DEFAULT_MAX_INTERVAL_MS, legacy)));
    }

    public static int getRandomIntervalMillis(Context context) {
        int min = getMinIntervalMillis(context);
        int max = getMaxIntervalMillis(context);
        if (max <= min) {
            return min;
        }
        return ThreadLocalRandom.current().nextInt(min, max + 1);
    }

    public static int getMaxPages(Context context) {
        return Math.max(0, prefs(context).getInt("maxPages", 100));
    }

    public static boolean isDetailEnrichmentEnabled(Context context) {
        return prefs(context).getBoolean("detailEnrichmentEnabled", true);
    }

    public static boolean isAiSupervisorEnabled(Context context) {
        return prefs(context).getBoolean("aiSupervisorEnabled", true);
    }

    public static boolean isTestEvidenceEnabled(Context context) {
        return prefs(context).getBoolean("testEvidenceEnabled", true);
    }

    public static boolean isRawOcrUploadEnabled(Context context) {
        return prefs(context).getBoolean(RAW_OCR_UPLOAD_KEY, false);
    }

    public static void save(
            Context context,
            String serverUrl,
            String token,
            String platform,
            String city,
            int minIntervalMillis,
            int maxIntervalMillis,
            int maxPages,
            boolean detailEnrichmentEnabled,
            boolean aiSupervisorEnabled,
            boolean testEvidenceEnabled,
            boolean rawOcrUploadEnabled
    ) {
        int safeMin = Math.min(300000, Math.max(MIN_INTERVAL_FLOOR_MS, minIntervalMillis));
        int safeMax = Math.min(300000, Math.max(safeMin, maxIntervalMillis));
        SharedPreferences.Editor editor = prefs(context).edit()
                .putString("serverUrl", sanitizeServerUrl(serverUrl))
                .putString("platform", platform == null ? "didi-charging" : platform.trim())
                .putString("city", city == null ? "" : city.trim())
                .putInt("minIntervalMillis", safeMin)
                .putInt("maxIntervalMillis", safeMax)
                .putInt("maxPages", Math.min(1000, Math.max(0, maxPages)))
                .putBoolean("detailEnrichmentEnabled", detailEnrichmentEnabled)
                .putBoolean("aiSupervisorEnabled", aiSupervisorEnabled)
                .putBoolean("testEvidenceEnabled", testEvidenceEnabled)
                .putBoolean(RAW_OCR_UPLOAD_KEY, rawOcrUploadEnabled);
        String normalizedToken = token == null ? "" : token.trim();
        if (!normalizedToken.isEmpty()) {
            editor.putString(TOKEN_KEY, SecretStore.encrypt(normalizedToken));
        }
        editor.remove(LEGACY_TOKEN_KEY);
        if (!editor.commit()) {
            throw new IllegalStateException("unable to persist collector settings");
        }
    }

    public static String sanitizeServerUrl(String value) {
        return ServerEndpointValidator.normalize(value, DEFAULT_SERVER_URL);
    }

    private static String readSecret(Context context, String encryptedKey, String legacyKey) {
        SharedPreferences preferences = prefs(context);
        String encrypted = preferences.getString(encryptedKey, "");
        if (encrypted != null && !encrypted.trim().isEmpty()) {
            try {
                return SecretStore.decrypt(encrypted);
            } catch (IllegalStateException error) {
                Log.e(TAG, "stored credential cannot be decrypted: " + encryptedKey);
                return "";
            }
        }

        String legacy = preferences.getString(legacyKey, "");
        if (legacy == null || legacy.trim().isEmpty()) {
            if (preferences.contains(legacyKey)) {
                preferences.edit().remove(legacyKey).commit();
            }
            return "";
        }
        String normalized = legacy.trim();
        saveSecret(context, encryptedKey, legacyKey, normalized, true);
        return normalized;
    }

    private static void saveSecret(
            Context context,
            String encryptedKey,
            String legacyKey,
            String value,
            boolean preserveWhenEmpty
    ) {
        String normalized = value == null ? "" : value.trim();
        SharedPreferences.Editor editor = prefs(context).edit().remove(legacyKey);
        if (!normalized.isEmpty()) {
            editor.putString(encryptedKey, SecretStore.encrypt(normalized));
        } else if (!preserveWhenEmpty) {
            editor.remove(encryptedKey);
        }
        if (!editor.commit()) {
            throw new IllegalStateException("unable to persist encrypted credential");
        }
    }
}
