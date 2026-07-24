package com.datafordidi.mobilecollector;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.time.Instant;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/** App-sandboxed, bounded cache used to make OCR results visible before and after upload. */
public final class LocalStationStore {
    public static final String SOURCE_AGENT = "android-agent";
    private static final String PREFS = "local_station_results";
    private static final String KEY_RESULTS = "results";
    public static final int MAX_RESULTS = 1000;
    private static final Object LOCK = new Object();

    private LocalStationStore() {
    }

    public static List<String> upsertPage(
            Context context,
            String sessionId,
            int pageIndex,
            List<DidiLocalStationParser.StationRecord> stations
    ) {
        List<String> changedKeys = new ArrayList<>();
        if (stations == null || stations.isEmpty()) return changedKeys;
        synchronized (LOCK) {
            List<JSONObject> existing = readObjects(context);
            for (DidiLocalStationParser.StationRecord station : stations) {
                if (station == null || station.stationName == null || station.stationName.trim().isEmpty()) continue;
                try {
                    JSONObject row = station.toJson();
                    row.put("city", CollectorSettings.getCity(context));
                    String key = buildKey(row);
                    row.put("localKey", key);
                    row.put("sessionId", sessionId == null ? "" : sessionId);
                    row.put("pageIndex", pageIndex);
                    row.put("sourceAgent", SOURCE_AGENT);
                    row.put("capturedAt", Instant.now().toString());
                    row.put("syncState", "pending");
                    row.put("syncMessage", "等待回传");
                    removeByIdentity(existing, row);
                    existing.add(0, row);
                    changedKeys.add(key);
                } catch (Exception ignored) {
                    // A malformed single station must not prevent the rest of the page from being shown.
                }
            }
            persist(context, existing);
        }
        return changedKeys;
    }

    public static void markSync(Context context, List<String> keys, boolean success, String message) {
        if (keys == null || keys.isEmpty()) return;
        Set<String> targetKeys = new HashSet<>(keys);
        synchronized (LOCK) {
            List<JSONObject> rows = readObjects(context);
            for (JSONObject row : rows) {
                if (!targetKeys.contains(row.optString("localKey"))) continue;
                try {
                    row.put("syncState", success ? "synced" : "failed");
                    row.put("syncMessage", compactMessage(message));
                } catch (Exception ignored) {
                    // JSONObject values used here are always supported.
                }
            }
            persist(context, rows);
        }
    }

    public static List<JSONObject> list(Context context) {
        synchronized (LOCK) {
            return new ArrayList<>(readObjects(context));
        }
    }

    public static void clear(Context context) {
        synchronized (LOCK) {
            preferences(context).edit().remove(KEY_RESULTS).apply();
        }
    }

    private static List<JSONObject> readObjects(Context context) {
        List<JSONObject> rows = new ArrayList<>();
        String encoded = preferences(context).getString(KEY_RESULTS, "[]");
        try {
            JSONArray array = new JSONArray(encoded == null ? "[]" : encoded);
            for (int index = 0; index < array.length(); index++) {
                JSONObject row = array.optJSONObject(index);
                if (row != null) rows.add(row);
            }
        } catch (Exception ignored) {
            preferences(context).edit().remove(KEY_RESULTS).apply();
        }
        return rows;
    }

    private static void persist(Context context, List<JSONObject> rows) {
        JSONArray array = new JSONArray();
        int limit = Math.min(MAX_RESULTS, rows.size());
        for (int index = 0; index < limit; index++) array.put(rows.get(index));
        preferences(context).edit().putString(KEY_RESULTS, array.toString()).apply();
    }

    private static void removeByIdentity(List<JSONObject> rows, JSONObject incoming) {
        String key = buildKey(incoming);
        for (int index = rows.size() - 1; index >= 0; index--) {
            JSONObject current = rows.get(index);
            if (key.equals(buildKey(current))) {
                rows.remove(index);
                continue;
            }

            // Compatible migration for rows written before city became part of the local identity.
            String currentCity = compact(current.optString("city"));
            if (currentCity.isEmpty()
                    && compact(current.optString("platform")).equals(compact(incoming.optString("platform")))
                    && compact(current.optString("stationName")).equals(compact(incoming.optString("stationName")))) {
                rows.remove(index);
            }
        }
    }

    static String buildKey(JSONObject row) {
        return buildKey(row.optString("platform"), row.optString("city"), row.optString("stationName"));
    }

    static String buildKey(String platform, String city, String stationName) {
        return compact(platform) + "|" + compact(city) + "|" + compact(stationName);
    }

    private static String compact(String value) {
        return String.valueOf(value == null ? "" : value).replaceAll("\\s+", "").trim();
    }

    private static String compactMessage(String message) {
        String value = message == null ? "" : message.replaceAll("[\\r\\n]+", " ").trim();
        return value.length() <= 160 ? value : value.substring(0, 160);
    }

    private static SharedPreferences preferences(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
