package com.datafordidi.mobilecollector;

import org.json.JSONObject;

import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

final class CollectorFeedbackCleanup {
    static final String START_AT = "2026-07-22T08:39:00";
    static final String END_AT = "2026-07-22T08:48:00";
    private static final Pattern NUMBERED_VALUE = Pattern.compile("^[1-9]\\d{0,2}[.、，,]?(.*)$");

    private CollectorFeedbackCleanup() {
    }

    static boolean shouldRemove(JSONObject station, String capturedAt) {
        if (station == null || !withinWindow(capturedAt)) return false;
        JSONObject raw = station.optJSONObject("raw");
        if (raw == null || !"generic-android".equals(raw.optString("localParser"))) return false;
        JSONObject observed = raw.optJSONObject("observed");
        if (observed != null && (observed.optBoolean("price") || observed.optBoolean("ports")
                || observed.optBoolean("busy"))) return false;
        if (hasNumber(station, "priceFast") || hasNumber(station, "priceSlow")
                || hasNumber(station, "priceSuper")) return false;
        if (positive(station, "fastTotalPorts") || positive(station, "slowTotalPorts")
                || positive(station, "superTotalPorts") || positive(station, "totalPorts")) return false;
        String name = compact(station.optString("stationName"));
        String address = compact(station.optString("address"));
        Matcher matcher = NUMBERED_VALUE.matcher(address);
        return !name.isEmpty() && matcher.matches() && name.equals(compact(matcher.group(1)));
    }

    static RemovalResult removeRows(List<JSONObject> rows) {
        Set<String> removedKeys = new LinkedHashSet<>();
        int removedRows = 0;
        if (rows == null) return new RemovalResult(0, removedKeys);
        for (int index = rows.size() - 1; index >= 0; index--) {
            JSONObject row = rows.get(index);
            if (!shouldRemove(row, row.optString("capturedAt"))) continue;
            String key = row.optString("localKey").trim();
            if (!key.isEmpty()) removedKeys.add(key);
            rows.remove(index);
            removedRows++;
        }
        return new RemovalResult(removedRows, removedKeys);
    }

    private static boolean withinWindow(String capturedAt) {
        String value = capturedAt == null ? "" : capturedAt.trim();
        return value.compareTo(START_AT) >= 0 && value.compareTo(END_AT) < 0;
    }

    private static boolean hasNumber(JSONObject json, String key) {
        return json.opt(key) instanceof Number;
    }

    private static boolean positive(JSONObject json, String key) {
        return json.optInt(key, 0) > 0;
    }

    private static String compact(String value) {
        if (value == null || "null".equals(value)) return "";
        return value.replaceAll("\\s+", "").trim();
    }

    static final class RemovalResult {
        final int removedRows;
        final Set<String> removedKeys;

        RemovalResult(int removedRows, Set<String> removedKeys) {
            this.removedRows = removedRows;
            this.removedKeys = removedKeys;
        }
    }
}
