package com.datafordidi.mobilecollector;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 燃油场站质量策略。
 *
 * <p>燃油侧无地址、无枪数据，质量只与站名和有效油价 offer 相关。
 */
final class FuelQualityPolicy {

    private FuelQualityPolicy() {
    }

    static JSONObject evaluate(FuelStationRecord station) {
        JSONObject quality = new JSONObject();
        boolean hasName = station != null
                && station.stationName != null
                && !station.stationName.trim().isEmpty();
        boolean hasValidOffer = station != null && !station.fuelOffers.isEmpty();
        if (!hasName) {
            put(quality, "status", "invalid");
            put(quality, "needsReview", true);
            put(quality, "missingFields", new JSONArray().put("stationName"));
        } else if (!hasValidOffer) {
            put(quality, "status", "incomplete");
            put(quality, "needsReview", true);
            put(quality, "missingFields", new JSONArray().put("price"));
        } else {
            put(quality, "status", "valid");
            put(quality, "needsReview", false);
            put(quality, "missingFields", new JSONArray());
        }
        return quality;
    }

    private static void put(JSONObject target, String key, Object value) {
        try {
            target.put(key, value);
        } catch (Exception error) {
            throw new IllegalStateException("无法序列化燃油质量字段", error);
        }
    }
}
