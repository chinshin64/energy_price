package com.datafordidi.mobilecollector;

import org.json.JSONArray;
import org.json.JSONObject;

import java.math.BigDecimal;

final class FuelOffer {
    static final String CURRENCY = "CNY";
    static final String UNIT = "CNY_PER_LITER";

    String fuelType = "fuel";
    String gradeCode;
    String gradeLabel;
    Double listPrice;
    Double discountPrice;
    Double unclassifiedPrice;
    BigDecimal displayPrice;
    BigDecimal stationPrice;
    BigDecimal nationalPrice;
    String discountKind = "none";
    JSONArray evidence = new JSONArray();
    JSONObject fieldSource = new JSONObject();
    String capturedAt;

    boolean valid() {
        if (clean(gradeCode).isEmpty() || clean(gradeLabel).isEmpty()) return false;
        if (!validPrice(listPrice) || !validPrice(discountPrice) || !validPrice(unclassifiedPrice)) return false;
        if (!validRolePrice(displayPrice)
                || !validRolePrice(stationPrice)
                || !validRolePrice(nationalPrice)) {
            return false;
        }
        if (listPrice == null && discountPrice == null && unclassifiedPrice == null && !hasRolePrice()) return false;
        return listPrice == null || discountPrice == null || discountPrice <= listPrice;
    }

    boolean hasRolePrice() {
        return displayPrice != null || stationPrice != null || nationalPrice != null;
    }

    JSONObject toJson() {
        if (!valid()) throw new IllegalArgumentException("燃油价格记录无效");
        JSONObject value = new JSONObject();
        put(value, "fuelType", clean(fuelType).isEmpty() ? "fuel" : clean(fuelType));
        put(value, "gradeCode", clean(gradeCode));
        put(value, "gradeLabel", clean(gradeLabel));
        putNullable(value, "listPrice", listPrice);
        putNullable(value, "discountPrice", discountPrice);
        putNullable(value, "unclassifiedPrice", unclassifiedPrice);
        if (hasRolePrice()) {
            putRolePrice(value, "displayPrice", displayPrice);
            putRolePrice(value, "stationPrice", stationPrice);
            putRolePrice(value, "nationalPrice", nationalPrice);
            put(value, "fieldSource", boundedFieldSource(fieldSource));
        }
        put(value, "discountKind", clean(discountKind).isEmpty() ? "none" : clean(discountKind));
        put(value, "currency", CURRENCY);
        put(value, "unit", UNIT);
        put(value, "evidence", boundedEvidence(evidence));
        put(value, "capturedAt", CaptureTime.requireUtc(capturedAt));
        return value;
    }

    static boolean validPrice(Double price) {
        if (price == null) return true;
        if (!Double.isFinite(price) || price <= 0d || price > 30d) return false;
        return BigDecimal.valueOf(price).stripTrailingZeros().scale() <= 4;
    }

    static boolean validRolePrice(BigDecimal price) {
        if (price == null) return true;
        // 油价（元/升）合理区间 3~20：覆盖 92/95/98 汽油与 0# 柴油，
        // 同时排除促销文案「加200省1」里被误抓的 2、200 片段等非价格数字。
        return price.signum() > 0
                && price.compareTo(new BigDecimal("3")) >= 0
                && price.compareTo(new BigDecimal("20")) <= 0
                && price.stripTrailingZeros().scale() <= 4;
    }

    private static JSONArray boundedEvidence(JSONArray source) {
        JSONArray output = new JSONArray();
        if (source == null) return output;
        for (int index = 0; index < Math.min(8, source.length()); index++) {
            JSONObject row = source.optJSONObject(index);
            if (row == null) continue;
            JSONObject safe = new JSONObject();
            put(safe, "kind", clean(row.optString("kind")));
            JSONObject box = row.optJSONObject("boundingBox");
            if (box != null) {
                JSONObject safeBox = new JSONObject();
                put(safeBox, "x", box.optDouble("x"));
                put(safeBox, "y", box.optDouble("y"));
                put(safeBox, "width", box.optDouble("width"));
                put(safeBox, "height", box.optDouble("height"));
                put(safe, "boundingBox", safeBox);
            }
            output.put(safe);
        }
        return output;
    }

    private static JSONObject boundedFieldSource(JSONObject source) {
        JSONObject output = new JSONObject();
        if (source == null) return output;
        for (String key : new String[]{"displayPrice", "stationPrice", "nationalPrice"}) {
            if ("ocr".equals(source.optString(key))) put(output, key, "ocr");
        }
        return output;
    }

    private static void putNullable(JSONObject target, String key, Double value) {
        put(target, key, value == null ? JSONObject.NULL : value);
    }

    private static void putRolePrice(JSONObject target, String key, BigDecimal value) {
        put(target, key, value == null
                ? JSONObject.NULL
                : value.stripTrailingZeros().toPlainString());
    }

    private static void put(JSONObject target, String key, Object value) {
        try {
            target.put(key, value);
        } catch (Exception error) {
            throw new IllegalStateException("无法序列化燃油价格", error);
        }
    }

    private static String clean(String value) {
        return value == null ? "" : value.trim();
    }
}
