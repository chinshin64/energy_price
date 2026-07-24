package com.datafordidi.mobilecollector;

import org.json.JSONObject;

final class StationIdentity {
    private static final String MANUAL_MARKER = "|manual-backfill|";

    private StationIdentity() {
    }

    static String fromRow(JSONObject row, int fallbackIndex) {
        if (row == null) return "legacy-snapshot-" + fallbackIndex;
        String localKey = compact(row.optString("localKey"));
        if (!localKey.isEmpty()) {
            return fromLocalKey(
                    localKey,
                    compact(row.optString("sessionId")),
                    row.has("pageIndex") ? String.valueOf(row.optInt("pageIndex")) : ""
            );
        }
        String base = "fuel".equals(row.optString("stationType"))
                ? LocalStationStore.buildFuelKey(
                        row.optString("platform"),
                        row.optString("city"),
                        row.optString("stationName"),
                        ""
                )
                : LocalStationStore.buildKey(
                        row.optString("platform"),
                        row.optString("city"),
                        row.optString("stationName")
                );
        String recordedTime = firstRecordedTime(row);
        if (!recordedTime.isEmpty()) {
            return base + "|legacy-snapshot-" + DeviceIdentity.sha256(recordedTime).substring(0, 16);
        }
        return base + "|legacy-snapshot-" + fallbackIndex;
    }

    static String fromLocalKey(String localKey, String sessionId, int pageIndex) {
        return fromLocalKey(compact(localKey), compact(sessionId), String.valueOf(pageIndex));
    }

    static String manualLocalKey(String stableIdentity, String editId, int revision) {
        return compact(stableIdentity) + MANUAL_MARKER + compact(editId) + "|" + Math.max(1, revision);
    }

    private static String fromLocalKey(String localKey, String sessionId, String pageIndex) {
        int manual = localKey.indexOf(MANUAL_MARKER);
        if (manual > 0) return localKey.substring(0, manual);
        String suffix = sessionId.isEmpty() || pageIndex.isEmpty() ? "" : "|" + sessionId + "|" + pageIndex;
        return !suffix.isEmpty() && localKey.endsWith(suffix)
                ? localKey.substring(0, localKey.length() - suffix.length())
                : localKey;
    }

    private static String compact(String value) {
        return value == null ? "" : value.replaceAll("\\s+", "").trim();
    }

    private static String firstRecordedTime(JSONObject row) {
        for (String key : new String[]{"capturedAt", "collectedAt", "snapshotAt"}) {
            String value = row.optString(key, "").trim();
            if (!value.isEmpty()) return value;
        }
        return "";
    }
}
