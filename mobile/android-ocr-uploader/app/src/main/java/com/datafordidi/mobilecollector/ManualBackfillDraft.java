package com.datafordidi.mobilecollector;

import org.json.JSONObject;

import java.math.BigDecimal;
import java.util.LinkedHashMap;
import java.util.Iterator;
import java.util.Map;

final class ManualBackfillDraft {
    static final String PRICE = "price";
    static final String ADDRESS = "address";
    static final String FAST_IDLE = "fastIdle";
    static final String FAST_TOTAL = "fastTotal";
    static final String SLOW_IDLE = "slowIdle";
    static final String SLOW_TOTAL = "slowTotal";
    static final String SUPER_IDLE = "superIdle";
    static final String SUPER_TOTAL = "superTotal";

    String priceKey = "priceFast";
    String address = "";
    String price = "";
    String fastIdle = "";
    String fastTotal = "";
    String slowIdle = "";
    String slowTotal = "";
    String superIdle = "";
    String superTotal = "";

    static ManualBackfillDraft fromRow(JSONObject row) {
        ManualBackfillDraft draft = new ManualBackfillDraft();
        draft.priceKey = mainPriceKey(row);
        draft.address = row == null || row.isNull("address") ? "" : row.optString("address");
        draft.price = decimal(row == null ? null : row.opt(draft.priceKey));
        draft.fastIdle = port(row, "fastIdlePorts", "fastTotalPorts");
        draft.fastTotal = total(row, "fastTotalPorts");
        draft.slowIdle = port(row, "slowIdlePorts", "slowTotalPorts");
        draft.slowTotal = total(row, "slowTotalPorts");
        draft.superIdle = port(row, "superIdlePorts", "superTotalPorts");
        draft.superTotal = total(row, "superTotalPorts");
        return draft;
    }

    static ManualBackfillDraft fromJson(JSONObject value) {
        ManualBackfillDraft draft = new ManualBackfillDraft();
        if (value == null) return draft;
        draft.priceKey = allowedPriceKey(value.optString("priceKey"))
                ? value.optString("priceKey") : "priceFast";
        draft.price = value.optString(PRICE);
        draft.address = value.optString(ADDRESS);
        draft.fastIdle = value.optString(FAST_IDLE);
        draft.fastTotal = value.optString(FAST_TOTAL);
        draft.slowIdle = value.optString(SLOW_IDLE);
        draft.slowTotal = value.optString(SLOW_TOTAL);
        draft.superIdle = value.optString(SUPER_IDLE);
        draft.superTotal = value.optString(SUPER_TOTAL);
        return draft;
    }

    JSONObject toJson() {
        JSONObject value = new JSONObject();
        put(value, "priceKey", priceKey);
        put(value, PRICE, clean(price));
        put(value, ADDRESS, clean(address));
        put(value, FAST_IDLE, clean(fastIdle));
        put(value, FAST_TOTAL, clean(fastTotal));
        put(value, SLOW_IDLE, clean(slowIdle));
        put(value, SLOW_TOTAL, clean(slowTotal));
        put(value, SUPER_IDLE, clean(superIdle));
        put(value, SUPER_TOTAL, clean(superTotal));
        return value;
    }

    Validation validateAndBuild(JSONObject source, String backfilledAt) {
        JSONObject row = AddressFreePayload.copyObject(source);
        Map<String, String> errors = new LinkedHashMap<>();
        JSONObject fieldSource = new JSONObject();
        String safeAddress = StationObservationV3.sanitizeAddress(address);
        if (!clean(address).isEmpty() && safeAddress == null) {
            errors.put(ADDRESS, "请输入有效场站地址");
        } else {
            Object previous = row.opt("address");
            put(row, "address", safeAddress == null ? JSONObject.NULL : safeAddress);
            if (!String.valueOf(previous).equals(String.valueOf(row.opt("address")))) {
                put(fieldSource, "address", "manual");
            }
        }

        Double parsedPrice = parsePrice(price, errors);
        if (parsedPrice != null) {
            double before = number(row, priceKey);
            put(row, priceKey, parsedPrice);
            if (Double.compare(before, parsedPrice) != 0) put(fieldSource, priceKey, "manual");
        }

        applyPair(row, "fastIdlePorts", "fastTotalPorts", FAST_IDLE, FAST_TOTAL,
                fastIdle, fastTotal, errors, fieldSource);
        applyPair(row, "slowIdlePorts", "slowTotalPorts", SLOW_IDLE, SLOW_TOTAL,
                slowIdle, slowTotal, errors, fieldSource);
        applyPair(row, "superIdlePorts", "superTotalPorts", SUPER_IDLE, SUPER_TOTAL,
                superIdle, superTotal, errors, fieldSource);

        recomputeTotals(row);
        if (!hasPrice(row)) errors.put("form", "请至少填写一个 0.2～3.5 的有效价格");
        if (!hasPorts(row)) errors.put("form", "请至少填写一类有效枪数");
        if (!errors.isEmpty()) return Validation.failure(errors);

        String editedAt = CaptureTime.requireUtc(backfilledAt);
        JSONObject raw = row.optJSONObject("raw");
        raw = raw == null ? new JSONObject() : AddressFreePayload.copyObject(raw);
        JSONObject observed = raw.optJSONObject("observed");
        observed = observed == null ? new JSONObject() : observed;
        put(observed, "price", true);
        put(observed, "ports", true);
        put(observed, "busy", true);
        put(raw, "observed", observed);
        put(raw, "manualBackfill", true);
        put(raw, "backfilledAt", editedAt);
        JSONObject existingSources = raw.optJSONObject("fieldSource");
        existingSources = existingSources == null ? new JSONObject() : existingSources;
        Iterator<String> sourceKeys = fieldSource.keys();
        while (sourceKeys.hasNext()) put(existingSources, sourceKeys.next(), "manual");
        put(raw, "fieldSource", existingSources);
        put(row, "raw", raw);
        put(row, "backfilledAt", editedAt);
        put(row, "syncState", "pending");
        put(row, "syncMessage", "回填完成·待回传");
        row.remove("addr");
        put(row, "schemaVersion", StationObservationV3.SCHEMA_VERSION);
        put(row, "stationType", "charging");
        put(row, "sourceAgent", LocalStationStore.SOURCE_AGENT);
        put(row, "busyPorts", row.optInt("totalPorts") - row.optInt("availablePorts"));
        put(row, "stationObservation", StationObservationV3.fromLocalRow(row)
                .optJSONObject("stationObservation"));
        return Validation.success(row, contentFingerprint(row));
    }

    private static void applyPair(
            JSONObject row,
            String idleKey,
            String totalKey,
            String idleField,
            String totalField,
            String idleText,
            String totalText,
            Map<String, String> errors,
            JSONObject fieldSource
    ) {
        String idleValue = clean(idleText);
        String totalValue = clean(totalText);
        if (idleValue.isEmpty() && totalValue.isEmpty()) return;
        if (idleValue.isEmpty() || totalValue.isEmpty()) {
            String message = "闲置和总数需要成对填写";
            if (idleValue.isEmpty()) errors.put(idleField, message);
            if (totalValue.isEmpty()) errors.put(totalField, message);
            return;
        }
        Integer idle = parseInteger(idleValue, idleField, errors);
        Integer total = parseInteger(totalValue, totalField, errors);
        if (idle == null || total == null) return;
        if (idle > total) {
            errors.put(idleField, "闲置数不能大于总数");
            return;
        }
        int oldIdle = Math.max(0, row.optInt(idleKey));
        int oldTotal = Math.max(0, row.optInt(totalKey));
        put(row, idleKey, idle);
        put(row, totalKey, total);
        if (oldIdle != idle) put(fieldSource, idleKey, "manual");
        if (oldTotal != total) put(fieldSource, totalKey, "manual");
    }

    private static Double parsePrice(String value, Map<String, String> errors) {
        String text = clean(value);
        if (text.isEmpty()) return null;
        try {
            double parsed = new BigDecimal(text).doubleValue();
            if (!Double.isFinite(parsed) || parsed < 0.2d || parsed > 3.5d) {
                errors.put(PRICE, "价格需在 0.2～3.5 之间");
                return null;
            }
            return parsed;
        } catch (NumberFormatException error) {
            errors.put(PRICE, "请输入有效价格");
            return null;
        }
    }

    private static Integer parseInteger(String value, String field, Map<String, String> errors) {
        if (!value.matches("\\d+")) {
            errors.put(field, "请输入非负整数");
            return null;
        }
        try {
            return Integer.valueOf(value);
        } catch (NumberFormatException error) {
            errors.put(field, "数值过大");
            return null;
        }
    }

    private static void recomputeTotals(JSONObject row) {
        int available = nonNegative(row, "fastIdlePorts")
                + nonNegative(row, "slowIdlePorts")
                + nonNegative(row, "superIdlePorts");
        int total = nonNegative(row, "fastTotalPorts")
                + nonNegative(row, "slowTotalPorts")
                + nonNegative(row, "superTotalPorts");
        put(row, "availablePorts", available);
        put(row, "totalPorts", total);
        put(row, "onlineFastPorts", nonNegative(row, "fastIdlePorts") + nonNegative(row, "superIdlePorts"));
        put(row, "onlineSlowPorts", nonNegative(row, "slowIdlePorts"));
    }

    private static boolean hasPrice(JSONObject row) {
        return number(row, "priceFast") > 0d || number(row, "priceSlow") > 0d || number(row, "priceSuper") > 0d;
    }

    private static boolean hasPorts(JSONObject row) {
        return nonNegative(row, "fastTotalPorts") > 0
                || nonNegative(row, "slowTotalPorts") > 0
                || nonNegative(row, "superTotalPorts") > 0;
    }

    private static String contentFingerprint(JSONObject row) {
        String content = row.optString("platform") + "|" + row.optString("city") + "|"
                + row.optString("stationName") + "|" + row.optString("address") + "|"
                + number(row, "priceFast") + "|"
                + number(row, "priceSlow") + "|" + number(row, "priceSuper") + "|"
                + nonNegative(row, "fastIdlePorts") + "/" + nonNegative(row, "fastTotalPorts") + "|"
                + nonNegative(row, "slowIdlePorts") + "/" + nonNegative(row, "slowTotalPorts") + "|"
                + nonNegative(row, "superIdlePorts") + "/" + nonNegative(row, "superTotalPorts") + "|"
                + row.optString("capturedAt");
        return DeviceIdentity.sha256(content);
    }

    private static String mainPriceKey(JSONObject row) {
        if (number(row, "priceFast") > 0d) return "priceFast";
        if (number(row, "priceSuper") > 0d) return "priceSuper";
        if (number(row, "priceSlow") > 0d) return "priceSlow";
        return "priceFast";
    }

    private static boolean allowedPriceKey(String key) {
        return "priceFast".equals(key) || "priceSlow".equals(key) || "priceSuper".equals(key);
    }

    private static String port(JSONObject row, String idleKey, String totalKey) {
        return nonNegative(row, totalKey) > 0 ? String.valueOf(nonNegative(row, idleKey)) : "";
    }

    private static String total(JSONObject row, String key) {
        int value = nonNegative(row, key);
        return value > 0 ? String.valueOf(value) : "";
    }

    private static int nonNegative(JSONObject row, String key) {
        return row == null ? 0 : Math.max(0, row.optInt(key));
    }

    private static double number(JSONObject row, String key) {
        Object value = row == null ? null : row.opt(key);
        return value instanceof Number ? ((Number) value).doubleValue() : 0d;
    }

    private static String decimal(Object value) {
        if (!(value instanceof Number) || ((Number) value).doubleValue() <= 0d) return "";
        return BigDecimal.valueOf(((Number) value).doubleValue()).stripTrailingZeros().toPlainString();
    }

    private static String clean(String value) {
        return value == null ? "" : value.trim();
    }

    private static void put(JSONObject target, String key, Object value) {
        try {
            target.put(key, value);
        } catch (Exception error) {
            throw new IllegalStateException("无法序列化回填字段", error);
        }
    }

    static final class Validation {
        final JSONObject row;
        final String fingerprint;
        final Map<String, String> errors;

        private Validation(JSONObject row, String fingerprint, Map<String, String> errors) {
            this.row = row;
            this.fingerprint = fingerprint;
            this.errors = errors;
        }

        static Validation success(JSONObject row, String fingerprint) {
            return new Validation(row, fingerprint, new LinkedHashMap<>());
        }

        static Validation failure(Map<String, String> errors) {
            return new Validation(null, "", new LinkedHashMap<>(errors));
        }

        boolean valid() {
            return errors.isEmpty();
        }
    }
}
