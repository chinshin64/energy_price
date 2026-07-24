package com.datafordidi.mobilecollector;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

public final class LocalStationStore {
    public static final String SOURCE_AGENT = "android-ocr-agent";
    private static final String PREFS = "standalone_ocr_results";
    private static final String KEY_RESULTS = "results";
    public static final int MAX_RESULTS = 1000;
    private static final Object LOCK = new Object();

    private LocalStationStore() {
    }

    static List<String> upsert(
            Context context,
            String sessionId,
            int pageIndex,
            String city,
            List<DidiLocalStationParser.StationRecord> stations
    ) {
        List<String> changedKeys = new ArrayList<>();
        if (stations == null || stations.isEmpty()) return changedKeys;
        synchronized (LOCK) {
            List<JSONObject> existing = readObjects(context);
            for (DidiLocalStationParser.StationRecord station : stations) {
                if (station == null || station.stationName == null || station.stationName.trim().isEmpty()) continue;
                try {
                    JSONObject row = station.toJson()
                            .put("city", city)
                            .put("stationObservation", StationObservationV3.charging(station)
                                    .optJSONObject("stationObservation"))
                            .put("sessionId", sessionId)
                            .put("pageIndex", pageIndex)
                            .put("capturedAt", CaptureTime.requireUtc(station.capturedAt))
                            .put("syncState", "pending")
                            .put("syncMessage", "等待回传");
                    String key = snapshotKey(row, sessionId, pageIndex, station.captureContextId);
                    row.put("localKey", key);
                    StationSensitiveDataPolicy.requireSafeUserDerived(row);
                    existing.add(0, row);
                    changedKeys.add(key);
                } catch (Exception ignored) {
                    // One malformed OCR item must not suppress other stations from the same screen.
                }
            }
            persist(context, existing);
        }
        return changedKeys;
    }

    static List<String> upsertFuel(
            Context context,
            String sessionId,
            int pageIndex,
            String city,
            List<FuelStationRecord> stations
    ) {
        List<String> changedKeys = new ArrayList<>();
        if (stations == null || stations.isEmpty()) return changedKeys;
        synchronized (LOCK) {
            List<JSONObject> existing = readObjects(context);
            for (FuelStationRecord station : stations) {
                if (station == null || station.stationName == null || station.stationName.trim().isEmpty()) continue;
                try {
                    JSONObject row = station.localRow(city)
                            .put("sessionId", sessionId)
                            .put("pageIndex", pageIndex)
                            .put("syncState", "pending")
                            .put("syncMessage", "等待回传");
                    String key = snapshotKey(row, sessionId, pageIndex, station.captureContextId);
                    row.put("localKey", key);
                    StationSensitiveDataPolicy.requireSafeUserDerived(row);
                    existing.add(0, row);
                    changedKeys.add(key);
                } catch (Exception ignored) {
                    // One malformed fuel item must not suppress the remaining stations.
                }
            }
            persist(context, existing);
        }
        return changedKeys;
    }

    static List<JSONObject> prepareChargingSnapshots(
            String sessionId,
            int pageIndex,
            String city,
            List<DidiLocalStationParser.StationRecord> stations
    ) {
        List<JSONObject> snapshots = new ArrayList<>();
        if (stations == null) return snapshots;
        Set<String> preparedKeys = new LinkedHashSet<>();
        for (DidiLocalStationParser.StationRecord station : stations) {
            if (station == null || station.stationName == null || station.stationName.trim().isEmpty()) continue;
            try {
                JSONObject row = station.toJson()
                        .put("city", city)
                        .put("stationObservation", StationObservationV3.charging(station)
                                .optJSONObject("stationObservation"))
                        .put("sessionId", sessionId)
                        .put("pageIndex", pageIndex)
                        .put("capturedAt", CaptureTime.requireUtc(station.capturedAt))
                        .put("syncState", "pending")
                        .put("syncMessage", "等待回传");
                String key = snapshotKey(row, sessionId, pageIndex, station.captureContextId);
                row.put("localKey", key);
                StationSensitiveDataPolicy.requireSafeUserDerived(row);
                if (preparedKeys.add(key)) snapshots.add(AddressFreePayload.copyObject(row));
            } catch (Exception ignored) {
                // One malformed OCR item must not suppress other stations from the same screen.
            }
        }
        return snapshots;
    }

    static List<JSONObject> prepareFuelSnapshots(
            String sessionId,
            int pageIndex,
            String city,
            List<FuelStationRecord> stations
    ) {
        List<JSONObject> snapshots = new ArrayList<>();
        if (stations == null) return snapshots;
        Set<String> preparedKeys = new LinkedHashSet<>();
        for (FuelStationRecord station : stations) {
            if (station == null || station.stationName == null || station.stationName.trim().isEmpty()) continue;
            try {
                JSONObject row = station.localRow(city)
                        .put("sessionId", sessionId)
                        .put("pageIndex", pageIndex)
                        .put("syncState", "pending")
                        .put("syncMessage", "等待回传");
                String key = snapshotKey(row, sessionId, pageIndex, station.captureContextId);
                row.put("localKey", key);
                StationSensitiveDataPolicy.requireSafeUserDerived(row);
                if (preparedKeys.add(key)) snapshots.add(AddressFreePayload.copyObject(row));
            } catch (Exception ignored) {
                // One malformed fuel item must not suppress the remaining stations.
            }
        }
        return snapshots;
    }

    static List<String> upsertPreparedSnapshots(Context context, List<JSONObject> snapshots) {
        List<String> keys = preparedKeys(snapshots);
        if (keys.isEmpty()) throw new IllegalArgumentException("没有可保存的本地场站");
        List<String> insertedKeys = new ArrayList<>();
        synchronized (LOCK) {
            List<JSONObject> rows = readObjects(context);
            Set<String> existingKeys = new HashSet<>();
            for (JSONObject row : rows) existingKeys.add(row.optString("localKey"));
            boolean changed = false;
            for (int index = snapshots.size() - 1; index >= 0; index--) {
                JSONObject snapshot = AddressFreePayload.copyObject(snapshots.get(index));
                String key = snapshot.optString("localKey").trim();
                if (key.isEmpty() || existingKeys.contains(key)) continue;
                StationSensitiveDataPolicy.requireSafeUserDerived(snapshot);
                rows.add(0, snapshot);
                existingKeys.add(key);
                insertedKeys.add(key);
                changed = true;
            }
            if (changed) persist(context, rows, true);
        }
        return insertedKeys;
    }

    static boolean allPreparedSnapshotsSynced(Context context, List<JSONObject> snapshots) {
        List<String> keys = preparedKeys(snapshots);
        if (keys.isEmpty()) return false;
        synchronized (LOCK) {
            Set<String> synced = new HashSet<>();
            for (JSONObject row : readObjects(context)) {
                if ("synced".equals(row.optString("syncState"))) synced.add(row.optString("localKey"));
            }
            return synced.containsAll(keys);
        }
    }

    static List<String> preparedKeys(List<JSONObject> snapshots) {
        List<String> keys = new ArrayList<>();
        Set<String> seen = new LinkedHashSet<>();
        if (snapshots != null) for (JSONObject snapshot : snapshots) {
            String key = snapshot == null ? "" : snapshot.optString("localKey").trim();
            if (!key.isEmpty() && seen.add(key)) keys.add(key);
        }
        return keys;
    }

    static void markSync(Context context, List<String> keys, String state, String message) {
        if (keys == null || keys.isEmpty()) return;
        String normalizedState = "synced".equals(state)
                || "failed".equals(state)
                || "manual-review".equals(state)
                || "local-only".equals(state)
                ? state
                : "pending";
        Set<String> targets = new HashSet<>(keys);
        synchronized (LOCK) {
            List<JSONObject> rows = readObjects(context);
            for (JSONObject row : rows) {
                if (!targets.contains(row.optString("localKey"))) continue;
                try {
                    row.put("syncState", normalizedState);
                    row.put("syncMessage", compactMessage(message));
                } catch (Exception ignored) {
                    // JSONObject accepts the values above.
                }
            }
            persist(context, rows);
        }
    }

    static List<JSONObject> list(Context context) {
        synchronized (LOCK) {
            return addressFreeView(readObjects(context));
        }
    }

    static List<JSONObject> addressFreeView(List<JSONObject> rows) {
        List<JSONObject> output = new ArrayList<>();
        if (rows != null) for (JSONObject row : rows) output.add(AddressFreePayload.copyObject(row));
        return output;
    }

    static int countByState(Context context, String state) {
        int count = 0;
        synchronized (LOCK) {
            for (JSONObject row : readObjects(context)) {
                if (String.valueOf(state).equals(row.optString("syncState"))) count++;
            }
        }
        return count;
    }

    static void clearCompleted(Context context) {
        synchronized (LOCK) {
            List<JSONObject> rows = readObjects(context);
            for (int index = rows.size() - 1; index >= 0; index--) {
                if ("synced".equals(rows.get(index).optString("syncState"))) rows.remove(index);
            }
            persist(context, rows);
        }
    }

    static void upsertBackfillSnapshot(Context context, JSONObject snapshot) {
        if (snapshot == null || snapshot.optString("localKey").trim().isEmpty()) {
            throw new IllegalArgumentException("回填快照缺少本地标识");
        }
        JSONObject safeSnapshot = AddressFreePayload.copyObject(snapshot);
        StationSensitiveDataPolicy.requireSafeUserDerived(safeSnapshot);
        synchronized (LOCK) {
            List<JSONObject> rows = readObjects(context);
            String localKey = safeSnapshot.optString("localKey");
            for (int index = rows.size() - 1; index >= 0; index--) {
                if (localKey.equals(rows.get(index).optString("localKey"))) rows.remove(index);
            }
            rows.add(0, safeSnapshot);
            persist(context, rows, true);
        }
    }

    static int removeStableIdentity(Context context, String stableIdentity) {
        String expected = stableIdentity == null ? "" : stableIdentity.trim();
        if (expected.isEmpty()) return 0;
        synchronized (LOCK) {
            List<JSONObject> rows = readObjects(context);
            int removed = removeStableIdentity(rows, expected);
            if (removed > 0) persist(context, rows, true);
            return removed;
        }
    }

    static int removeStableIdentity(List<JSONObject> rows, String stableIdentity) {
        String expected = stableIdentity == null ? "" : stableIdentity.trim();
        if (expected.isEmpty() || rows == null) return 0;
        int removed = 0;
        for (int index = rows.size() - 1; index >= 0; index--) {
            if (expected.equals(StationIdentity.fromRow(rows.get(index), index))) {
                rows.remove(index);
                removed++;
            }
        }
        return removed;
    }

    static int removeStationNames(Context context, Set<String> rejectedNames) {
        if (rejectedNames == null || rejectedNames.isEmpty()) return 0;
        synchronized (LOCK) {
            List<JSONObject> rows = readObjects(context);
            int removed = 0;
            for (int index = rows.size() - 1; index >= 0; index--) {
                String name = FalsePositiveCleanup.normalize(rows.get(index).optString("stationName"));
                if (rejectedNames.contains(name)) {
                    rows.remove(index);
                    removed++;
                }
            }
            if (removed > 0) persist(context, rows);
            return removed;
        }
    }

    static Set<String> removeCollectorFeedback(Context context) {
        synchronized (LOCK) {
            List<JSONObject> rows = readObjects(context);
            CollectorFeedbackCleanup.RemovalResult removal = CollectorFeedbackCleanup.removeRows(rows);
            if (removal.removedRows > 0) persist(context, rows);
            return removal.removedKeys;
        }
    }

    static String key(String platform, String city, String stationName) {
        return compact(platform) + "|" + compact(city) + "|" + compact(stationName);
    }

    static String buildKey(String platform, String city, String stationName) {
        return key(platform, city, stationName);
    }

    static String buildKey(String platform, String city, String stationName, String captureContextId) {
        String base = key(platform, city, stationName);
        String context = compact(captureContextId);
        return context.isEmpty() ? base : base + "|" + context;
    }

    static String buildFuelKey(
            String platform,
            String city,
            String stationName,
            String captureContextId
    ) {
        return "fuel|" + buildKey(platform, city, stationName, captureContextId);
    }

    private static String snapshotKey(JSONObject row, String sessionId, int pageIndex, String captureContextId) {
        String base = "fuel".equals(row.optString("stationType"))
                ? buildFuelKey(
                        row.optString("platform"),
                        row.optString("city"),
                        row.optString("stationName"),
                        captureContextId
                )
                : buildKey(
                        row.optString("platform"),
                        row.optString("city"),
                        row.optString("stationName"),
                        captureContextId
                );
        return base
                + "|" + compact(sessionId) + "|" + pageIndex;
    }

    private static List<JSONObject> readObjects(Context context) {
        List<JSONObject> rows = new ArrayList<>();
        try {
            JSONArray array = new JSONArray(prefs(context).getString(KEY_RESULTS, "[]"));
            for (int index = 0; index < array.length(); index++) {
                JSONObject row = array.optJSONObject(index);
                if (row != null) rows.add(row);
            }
        } catch (Exception error) {
            prefs(context).edit().remove(KEY_RESULTS).apply();
        }
        return rows;
    }

    private static void persist(Context context, List<JSONObject> rows) {
        persist(context, rows, false);
    }

    private static void persist(Context context, List<JSONObject> rows, boolean synchronous) {
        JSONArray array = new JSONArray();
        for (int index = 0; index < Math.min(MAX_RESULTS, rows.size()); index++) array.put(rows.get(index));
        SharedPreferences.Editor editor = prefs(context).edit().putString(KEY_RESULTS, array.toString());
        if (synchronous) {
            if (!editor.commit()) throw new IllegalStateException("无法保存回填结果");
        } else {
            editor.apply();
        }
    }

    private static String compact(String value) {
        return String.valueOf(value == null ? "" : value).replaceAll("\\s+", "").trim();
    }

    private static String compactMessage(String value) {
        String output = value == null ? "" : value.replaceAll("[\\r\\n]+", " ").trim();
        return output.length() <= 180 ? output : output.substring(0, 180);
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
