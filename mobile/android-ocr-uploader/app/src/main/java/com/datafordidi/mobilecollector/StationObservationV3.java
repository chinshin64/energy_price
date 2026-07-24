package com.datafordidi.mobilecollector;

import org.json.JSONArray;
import org.json.JSONObject;

import java.math.BigDecimal;

final class StationObservationV3 {
    static final int SCHEMA_VERSION = 3;

    private StationObservationV3() {
    }

    static JSONObject charging(DidiLocalStationParser.StationRecord station) {
        JSONObject common = common(
                "charging",
                station.stationName,
                station.address,
                station.portsObserved ? station.availablePorts() : null,
                station.portsObserved ? station.busyPorts() : null,
                station.portsObserved ? station.totalPorts() : null,
                station.capturedAt
        );
        JSONObject charging = new JSONObject();
        putDecimal(charging, "priceFast", station.priceFast);
        putDecimal(charging, "priceSlow", station.priceSlow);
        putDecimal(charging, "priceSuper", station.priceSuper);
        putDecimal(charging, "priceService", station.priceService);
        putNullable(charging, "fastIdlePorts", station.portsObserved ? station.fastIdlePorts : null);
        putNullable(charging, "fastTotalPorts", station.portsObserved ? station.fastTotalPorts : null);
        putNullable(charging, "slowIdlePorts", station.portsObserved ? station.slowIdlePorts : null);
        putNullable(charging, "slowTotalPorts", station.portsObserved ? station.slowTotalPorts : null);
        putNullable(charging, "superIdlePorts", station.portsObserved ? station.superIdlePorts : null);
        putNullable(charging, "superTotalPorts", station.portsObserved ? station.superTotalPorts : null);
        put(charging, "capturedAt", CaptureTime.requireUtc(station.capturedAt));
        put(charging, "sourceStage", clean(station.sourceStage));
        try {
            put(charging, "raw", safeRaw(station.rawJson()));
        } catch (Exception error) {
            throw new IllegalStateException("无法生成充电诊断字段", error);
        }
        return envelope("charging", common, "chargingObservation", charging);
    }

    static JSONObject fuel(FuelStationRecord station) {
        return fuel(station, FuelQuoteFeatureGate.requiresFeature(station));
    }

    static JSONObject fuel(FuelStationRecord station, boolean fuelQuoteFeature) {
        // 燃油侧无枪数据：common 信封不携带 ports。
        JSONObject common = common(
                "fuel",
                station.stationName,
                station.address,
                null,
                null,
                null,
                station.capturedAt
        );
        JSONObject fuel = station.typeSpecificJson(fuelQuoteFeature);
        return envelope("fuel", common, "fuelObservation", fuel);
    }

    static JSONObject fromLocalRow(JSONObject row) {
        if (row == null) throw new IllegalArgumentException("本地场站为空");
        boolean fuel = "fuel".equals(row.optString("stationType"));
        // 燃油侧无枪数据：即使旧本地 row 残留 ports 也不复活。
        JSONObject common = common(
                fuel ? "fuel" : "charging",
                row.optString("stationName"),
                row.isNull("address") ? null : row.optString("address"),
                fuel ? null : nullableInt(row, "availablePorts"),
                fuel ? null : nullableInt(row, "busyPorts"),
                fuel ? null : nullableInt(row, "totalPorts"),
                row.optString("capturedAt")
        );
        JSONObject detail;
        String key;
        if (fuel) {
            detail = AddressFreePayload.copyObject(row.optJSONObject("fuelObservation"));
            detail.remove("stationName");
            detail.remove("address");
            key = "fuelObservation";
        } else {
            detail = new JSONObject();
            putDecimalObject(detail, "priceFast", row.opt("priceFast"));
            putDecimalObject(detail, "priceSlow", row.opt("priceSlow"));
            putDecimalObject(detail, "priceSuper", row.opt("priceSuper"));
            putDecimalObject(detail, "priceService", row.opt("priceService"));
            for (String keyName : new String[]{
                    "fastIdlePorts", "fastTotalPorts", "slowIdlePorts", "slowTotalPorts",
                    "superIdlePorts", "superTotalPorts"
            }) {
                put(detail, keyName, row.has(keyName) && !row.isNull(keyName)
                        ? row.optInt(keyName) : JSONObject.NULL);
            }
            put(detail, "capturedAt", CaptureTime.requireUtc(row.optString("capturedAt")));
            put(detail, "sourceStage", clean(row.optString("sourceStage")));
            put(detail, "raw", safeRaw(row.optJSONObject("raw")));
            key = "chargingObservation";
        }
        JSONObject output = envelope(fuel ? "fuel" : "charging", common, key, detail);
        return output;
    }

    static JSONObject common(
            String stationType,
            String stationName,
            String address,
            Integer availablePorts,
            Integer busyPorts,
            Integer totalPorts,
            String capturedAt
    ) {
        String name = clean(stationName);
        if (name.isEmpty()) throw new IllegalArgumentException("场站名称为空");
        StationSensitiveDataPolicy.requireSafeField("stationName", name);
        String safeAddress = sanitizeAddress(address);
        JSONObject common = new JSONObject();
        put(common, "stationName", name);
        put(common, "address", safeAddress == null ? JSONObject.NULL : safeAddress);
        put(common, "capturedAt", CaptureTime.requireUtc(capturedAt));
        JSONArray missing = new JSONArray();
        if (safeAddress == null) missing.put("address");
        if ("fuel".equals(stationType)) {
            // 燃油侧无枪数据：不写 ports/portSemantics，不做 ports 校验。
            JSONObject quality = new JSONObject();
            put(quality, "status", missing.length() > 0 ? "incomplete" : "valid");
            put(quality, "needsReview", missing.length() > 0);
            put(quality, "missingFields", missing);
            put(common, "quality", quality);
            return common;
        }
        validatePorts(availablePorts, busyPorts, totalPorts);
        putNullable(common, "availablePorts", availablePorts);
        putNullable(common, "busyPorts", busyPorts);
        putNullable(common, "totalPorts", totalPorts);
        put(common, "portSemantics", "charging-gun");
        if (availablePorts == null) missing.put("availablePorts");
        if (busyPorts == null) missing.put("busyPorts");
        if (totalPorts == null) missing.put("totalPorts");
        JSONObject quality = new JSONObject();
        put(quality, "status", missing.length() > 0 ? "incomplete" : "valid");
        put(quality, "needsReview", missing.length() > 0);
        put(quality, "missingFields", missing);
        put(common, "quality", quality);
        return common;
    }

    static String sanitizeAddress(String value) {
        String address = clean(value).replaceAll("[\\r\\n\\t]+", " ").replaceAll("\\s{2,}", " ");
        if (address.isEmpty()) return null;
        StationSensitiveDataPolicy.requireSafeField("address", address);
        if (address.length() > 1024) address = address.substring(0, 1024).trim();
        if (address.length() < 5) return null;
        return address;
    }

    static void validateCommon(JSONObject common) {
        String stationName = common == null ? "" : clean(common.optString("stationName"));
        if (stationName.isEmpty()) {
            throw new IllegalArgumentException("stationObservation 不完整");
        }
        StationSensitiveDataPolicy.requireSafeField("stationName", stationName);
        if (!common.isNull("address") && sanitizeAddress(common.optString("address")) == null) {
            throw new IllegalArgumentException("场站地址不安全");
        }
        validatePorts(
                nullableInt(common, "availablePorts"),
                nullableInt(common, "busyPorts"),
                nullableInt(common, "totalPorts")
        );
        CaptureTime.requireUtc(common.optString("capturedAt"));
    }

    private static JSONObject envelope(
            String stationType,
            JSONObject common,
            String detailKey,
            JSONObject detail
    ) {
        JSONObject output = new JSONObject();
        put(output, "schemaVersion", SCHEMA_VERSION);
        put(output, "stationType", stationType);
        put(output, "stationObservation", common);
        put(output, detailKey, detail);
        return output;
    }

    private static JSONObject safeRaw(JSONObject source) {
        JSONObject safe = AddressFreePayload.copyObject(source);
        if (AddressFreePayload.containsSensitiveKey(safe)) {
            throw new IllegalArgumentException("诊断字段包含敏感信息");
        }
        return safe;
    }

    private static void validatePorts(Integer available, Integer busy, Integer total) {
        if (available == null && busy == null && total == null) return;
        if (available == null || busy == null || total == null
                || available < 0 || busy < 0 || total < 0
                || available > total || busy > total || available + busy != total
                || total > 10000) {
            throw new IllegalArgumentException("枪状态字段不一致");
        }
    }

    private static Integer nullableInt(JSONObject value, String key) {
        if (value == null || !value.has(key) || value.isNull(key)) return null;
        Object raw = value.opt(key);
        if (!(raw instanceof Number)) throw new IllegalArgumentException("枪状态字段类型错误");
        return ((Number) raw).intValue();
    }

    private static void putNullable(JSONObject target, String key, Integer value) {
        put(target, key, value == null ? JSONObject.NULL : value);
    }

    private static void putDecimal(JSONObject target, String key, Double value) {
        put(target, key, value == null
                ? JSONObject.NULL
                : BigDecimal.valueOf(value).stripTrailingZeros().toPlainString());
    }

    private static void putDecimalObject(JSONObject target, String key, Object value) {
        if (value == null || value == JSONObject.NULL) {
            put(target, key, JSONObject.NULL);
            return;
        }
        try {
            BigDecimal decimal = value instanceof Number
                    ? BigDecimal.valueOf(((Number) value).doubleValue())
                    : new BigDecimal(String.valueOf(value));
            put(target, key, decimal.stripTrailingZeros().toPlainString());
        } catch (NumberFormatException error) {
            put(target, key, JSONObject.NULL);
        }
    }

    private static String clean(String value) {
        return value == null ? "" : value.trim();
    }

    private static void put(JSONObject target, String key, Object value) {
        try {
            target.put(key, value);
        } catch (Exception error) {
            throw new IllegalStateException("无法序列化 stationObservation v3", error);
        }
    }
}
