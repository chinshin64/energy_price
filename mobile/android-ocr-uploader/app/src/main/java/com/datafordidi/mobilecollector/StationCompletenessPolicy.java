package com.datafordidi.mobilecollector;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * 场站记录完整度统一策略。
 *
 * <p>充电与燃油使用不同字段集合，但判定入口统一，避免 UI 与模型各自维护规则。
 */
final class StationCompletenessPolicy {

    enum Level {
        /** 字段完整，无需人工复核。 */
        COMPLETE,
        /** 允许保留，但缺少部分业务字段。 */
        INCOMPLETE,
        /** 站名为空或不合规，不能形成有效记录。 */
        INVALID
    }

    private StationCompletenessPolicy() {
    }

    static Level evaluate(JSONObject row) {
        if (row == null) return Level.INVALID;
        String stationName = row.optString("stationName", "").trim();
        if (stationName.isEmpty()) return Level.INVALID;
        if (StationSensitiveDataPolicy.isSensitive(stationName)) return Level.INVALID;

        if (StationDisplayFormatter.isFuel(row)) {
            return StationDisplayFormatter.hasPrice(row) ? Level.COMPLETE : Level.INCOMPLETE;
        }
        boolean hasAddress = StationDisplayFormatter.hasAddress(row);
        boolean hasPrice = StationDisplayFormatter.hasPrice(row);
        boolean hasPorts = StationDisplayFormatter.hasPorts(row);
        if (hasAddress && hasPrice && hasPorts) return Level.COMPLETE;
        if (hasPrice || hasPorts) return Level.INCOMPLETE;
        return Level.INCOMPLETE;
    }

    static List<String> missingFields(JSONObject row) {
        List<String> output = new ArrayList<>();
        if (row == null) return output;
        if (StationDisplayFormatter.isFuel(row)) {
            if (!StationDisplayFormatter.hasPrice(row)) output.add("price");
            return output;
        }
        if (!StationDisplayFormatter.hasAddress(row)) output.add("address");
        if (!StationDisplayFormatter.hasPrice(row)) output.add("price");
        if (!StationDisplayFormatter.hasPorts(row)) output.add("ports");
        return output;
    }

    static JSONArray missingFieldsArray(JSONObject row) {
        JSONArray array = new JSONArray();
        for (String field : missingFields(row)) array.put(field);
        return array;
    }

    static boolean needsReview(JSONObject row) {
        return evaluate(row) != Level.COMPLETE;
    }

    static String statusLabel(JSONObject row) {
        Level level = evaluate(row);
        if (level == Level.INVALID) return "invalid";
        if (level == Level.INCOMPLETE) return "incomplete";
        return "valid";
    }
}
