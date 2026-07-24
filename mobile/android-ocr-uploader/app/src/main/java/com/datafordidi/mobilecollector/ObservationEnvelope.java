package com.datafordidi.mobilecollector;

import org.json.JSONArray;
import org.json.JSONObject;

final class ObservationEnvelope {
    private ObservationEnvelope() {
    }

    static JSONObject charging(DidiLocalStationParser.StationRecord station, String city) {
        JSONObject envelope = StationObservationV3.charging(station);
        requireValid(envelope);
        return envelope;
    }

    static void requireValid(JSONObject value) {
        if (value == null) throw new IllegalArgumentException("observation 为空");
        int schemaVersion = value.optInt("schemaVersion", -1);
        if (schemaVersion == 2) {
            requireLegacyV2(value);
            return;
        }
        if (schemaVersion != StationObservationV3.SCHEMA_VERSION) {
            throw new IllegalArgumentException("仅支持 observation schema v2/v3");
        }
        String type = value.optString("stationType");
        boolean charging = value.optJSONObject("chargingObservation") != null;
        boolean fuel = value.optJSONObject("fuelObservation") != null;
        if (charging == fuel
                || ("charging".equals(type) && !charging)
                || ("fuel".equals(type) && !fuel)
                || (!"charging".equals(type) && !"fuel".equals(type))) {
            throw new IllegalArgumentException("场站类型与 observation 不互斥");
        }
        StationObservationV3.validateCommon(value.optJSONObject("stationObservation"));
        if (AddressFreePayload.containsSensitiveKey(value)) {
            throw new IllegalArgumentException("observation 包含敏感字段");
        }
        if (charging) {
            JSONObject detail = value.optJSONObject("chargingObservation");
            if (FuelPayloadPolicy.containsKey(detail, "fuelOffers")
                    || FuelPayloadPolicy.containsKey(detail, "fuelQuotes")) {
                throw new IllegalArgumentException("充电记录不能包含燃油价格");
            }
        } else {
            JSONObject detail = value.optJSONObject("fuelObservation");
            FuelPayloadPolicy.requireNoChargingFields(value);
            validateFuelExtension(value, detail, false);
        }
    }

    static void requireValidBatch(JSONObject batch) {
        if (batch == null) throw new IllegalArgumentException("回传批次为空");
        int schemaVersion = batch.has("schemaVersion") ? batch.optInt("schemaVersion", -1) : 1;
        if (schemaVersion == 1) {
            JSONArray stations = batch.optJSONArray("stations");
            if (batch.has("observations") || stations == null || stations.length() == 0) {
                throw new IllegalArgumentException("v1 仅支持充电 stations");
            }
            return;
        }
        if (schemaVersion != 2 && schemaVersion != StationObservationV3.SCHEMA_VERSION) {
            throw new IllegalArgumentException("不支持的回传 schemaVersion");
        }
        if (batch.has("stations")) throw new IllegalArgumentException("v2/v3 只能使用 observations");
        JSONArray observations = batch.optJSONArray("observations");
        if (observations == null || observations.length() == 0) {
            throw new IllegalArgumentException("observation 批次为空");
        }
        String type = batch.optString("stationType");
        String batchFeature = batch.optString("feature");
        for (int index = 0; index < observations.length(); index++) {
            JSONObject observation = observations.optJSONObject(index);
            requireValid(observation);
            if (observation.optInt("schemaVersion") != schemaVersion) {
                throw new IllegalArgumentException("批次与 observation schema 不一致");
            }
            if (!type.equals(observation.optString("stationType"))) {
                throw new IllegalArgumentException("批次与 observation 类型不一致");
            }
            if (schemaVersion == 2 && !batchFeature.equals(observation.optString("feature"))) {
                throw new IllegalArgumentException("批次与 observation 能力不一致");
            }
            if (schemaVersion == StationObservationV3.SCHEMA_VERSION
                    && FuelQuoteFeatureGate.requiresFeature(observation)
                    && !FuelQuoteFeatureGate.FEATURE.equals(batchFeature)) {
                throw new IllegalArgumentException("v3 燃油报价批次缺少能力标识");
            }
        }
    }

    private static void requireLegacyV2(JSONObject value) {
        String type = value.optString("stationType");
        boolean charging = value.optJSONObject("chargingObservation") != null;
        boolean fuel = value.optJSONObject("fuelObservation") != null;
        if (charging == fuel || ("charging".equals(type) != charging) || ("fuel".equals(type) != fuel)) {
            throw new IllegalArgumentException("v2 场站类型不互斥");
        }
        JSONObject payload = charging
                ? value.optJSONObject("chargingObservation")
                : value.optJSONObject("fuelObservation");
        if (payload == null || AddressFreePayload.containsSensitiveKey(payload)) {
            throw new IllegalArgumentException("v2 observation 字段不安全");
        }
        if (charging && FuelPayloadPolicy.containsKey(payload, "fuelOffers")) {
            throw new IllegalArgumentException("充电记录不能包含燃油价格");
        }
        if (fuel) {
            FuelPayloadPolicy.requireNoChargingFields(value);
            validateFuelExtension(value, payload, true);
        }
    }

    private static void validateFuelExtension(JSONObject envelope, JSONObject fuel, boolean requireEnvelopeFeature) {
        if (fuel == null) throw new IllegalArgumentException("燃油 observation 为空");
        boolean extension = FuelQuoteFeatureGate.requiresFeature(envelope);
        String feature = envelope.optString("feature");
        if (requireEnvelopeFeature && extension && !FuelQuoteFeatureGate.FEATURE.equals(feature)) {
            throw new IllegalArgumentException("燃油报价能力字段缺失");
        }
        if (!feature.isEmpty() && !FuelQuoteFeatureGate.FEATURE.equals(feature)) {
            throw new IllegalArgumentException("不支持的燃油能力");
        }
        JSONArray offers = fuel.optJSONArray("fuelOffers");
        if (offers == null || offers.length() > FuelQuoteFeatureGate.CLIENT_MAX_OFFERS) {
            throw new IllegalArgumentException("燃油油号数量无效");
        }
        JSONArray quotes = fuel.optJSONArray("fuelQuotes");
        if (quotes != null && quotes.length() > FuelQuoteFeatureGate.CLIENT_MAX_QUOTES) {
            throw new IllegalArgumentException("燃油报价数量无效");
        }
        if (quotes != null) {
            for (int index = 0; index < quotes.length(); index++) {
                FuelQuote.requireValidJson(quotes.optJSONObject(index));
            }
        }
    }
}
