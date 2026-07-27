package com.datafordidi.mobilecollector;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * 本机记录的展示筛选条件。该对象只读取记录，不改写 OCR 原始值。
 */
final class StationRecordFilter {
    static final StationRecordFilter EMPTY = new StationRecordFilter("", null, null);

    final String nameQuery;
    final Long startEpochMillis;
    final Long endEpochMillis;

    StationRecordFilter(String nameQuery, Long startEpochMillis, Long endEpochMillis) {
        if (!isValidRange(startEpochMillis, endEpochMillis)) {
            throw new IllegalArgumentException("结束时间不能早于开始时间");
        }
        this.nameQuery = nameQuery == null ? "" : nameQuery;
        this.startEpochMillis = startEpochMillis;
        this.endEpochMillis = endEpochMillis;
    }

    StationRecordFilter withNameQuery(String value) {
        return new StationRecordFilter(value, startEpochMillis, endEpochMillis);
    }

    StationRecordFilter withStart(Long value) {
        return new StationRecordFilter(nameQuery, value, endEpochMillis);
    }

    StationRecordFilter withEnd(Long value) {
        return new StationRecordFilter(nameQuery, startEpochMillis, value);
    }

    boolean isActive() {
        return !normalize(nameQuery).isEmpty()
                || startEpochMillis != null
                || endEpochMillis != null;
    }

    List<JSONObject> apply(List<JSONObject> rows) {
        List<JSONObject> output = new ArrayList<>();
        if (rows == null) return output;
        String query = normalize(nameQuery);
        boolean hasTimeCondition = startEpochMillis != null || endEpochMillis != null;
        for (JSONObject row : rows) {
            if (row == null) continue;
            if (!query.isEmpty() && !normalize(stationName(row)).contains(query)) continue;
            if (hasTimeCondition) {
                Long capturedAt = CaptureTime.capturedAtEpochMillis(row);
                if (capturedAt == null) continue;
                if (startEpochMillis != null && capturedAt < startEpochMillis) continue;
                if (endEpochMillis != null && capturedAt > endEpochMillis) continue;
            }
            output.add(row);
        }
        return output;
    }

    static boolean isValidRange(Long start, Long end) {
        return start == null || end == null || end >= start;
    }

    static String stationName(JSONObject row) {
        if (row == null) return "";
        String root = clean(row.optString("stationName"));
        if (!root.isEmpty()) return root;
        JSONObject common = row.optJSONObject("stationObservation");
        String commonName = common == null ? "" : clean(common.optString("stationName"));
        if (!commonName.isEmpty()) return commonName;
        JSONObject fuel = row.optJSONObject("fuelObservation");
        return fuel == null ? "" : clean(fuel.optString("stationName"));
    }

    private static String normalize(String value) {
        return clean(value).replaceAll("\\s+", " ").toLowerCase(Locale.ROOT);
    }

    private static String clean(String value) {
        return value == null ? "" : value.trim();
    }
}
