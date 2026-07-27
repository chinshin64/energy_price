package com.datafordidi.mobilecollector;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

final class FuelStationRecord {
    String platform;
    String stationName;
    String address;
    String capturedAt;
    String sourceStage;
    String localParser;
    String captureMode = "unknown";
    String packageCategory = "unknown";
    String captureContextId = "";
    String providerName;
    JSONObject providerEvidence;
    String observedStationName;
    String stationNameMatchMethod;
    final List<FuelOffer> fuelOffers = new ArrayList<>();
    final List<FuelQuote> fuelQuotes = new ArrayList<>();

    JSONObject observationJson(String city) {
        return observationJson(city, false);
    }

    JSONObject observationJson(String city, boolean forceFuelQuoteFeature) {
        if (clean(stationName).isEmpty() || (fuelOffers.isEmpty() && fuelQuotes.isEmpty())) {
            throw new IllegalArgumentException("燃油场站记录不完整");
        }
        boolean fuelQuoteFeature = forceFuelQuoteFeature || FuelQuoteFeatureGate.requiresFeature(this);
        JSONObject envelope = StationObservationV3.fuel(this, fuelQuoteFeature);
        JSONObject fuel = envelope.optJSONObject("fuelObservation");
        put(fuel, "platform", clean(platform));
        put(fuel, "city", clean(city));
        ObservationEnvelope.requireValid(envelope);
        return envelope;
    }

    JSONObject typeSpecificJson(boolean fuelQuoteFeature) {
        JSONArray offers = new JSONArray();
        for (FuelOffer offer : fuelOffers) {
            if (offer != null) offers.put(offer.toJson());
        }
        JSONArray quotes = new JSONArray();
        for (FuelQuote quote : fuelQuotes) {
            if (quote != null) quotes.put(quote.toJson());
        }
        if (offers.length() == 0 && quotes.length() == 0) {
            throw new IllegalArgumentException("燃油场站没有有效价格或报价");
        }
        JSONObject fuel = new JSONObject();
        put(fuel, "capturedAt", CaptureTime.requireUtc(capturedAt));
        put(fuel, "fuelOffers", offers);
        if (fuelQuoteFeature) {
            put(fuel, "sourceStationKey", sourceStationKey());
            put(fuel, "providerName", clean(providerName).isEmpty() ? JSONObject.NULL : clean(providerName));
            put(fuel, "providerEvidence", providerEvidence == null
                    ? JSONObject.NULL
                    : AddressFreePayload.copyObject(providerEvidence));
            put(fuel, "fuelQuotes", quotes);
        }
        JSONObject diagnostics = new JSONObject();
        put(diagnostics, "mode", clean(captureMode));
        put(diagnostics, "packageCategory", clean(packageCategory));
        put(diagnostics, "quality", quotes.length() > 0 ? "fuel-quote-observed" : "fuel-price-observed");
        if (!clean(observedStationName).isEmpty()) {
            put(diagnostics, "observedStationName", clean(observedStationName));
            put(diagnostics, "stationNameMatchMethod", clean(stationNameMatchMethod));
        }
        JSONObject raw = new JSONObject();
        put(raw, "sourceType", "mobile-ocr");
        put(raw, "sourceAgent", LocalStationStore.SOURCE_AGENT);
        put(raw, "sourceStage", clean(sourceStage));
        put(raw, "localParser", clean(localParser));
        put(raw, "diagnostics", diagnostics);
        put(fuel, "raw", raw);
        return fuel;
    }

    JSONObject localRow(String city) {
        JSONObject envelope = observationJson(city);
        JSONObject fuel = envelope.optJSONObject("fuelObservation");
        JSONObject common = envelope.optJSONObject("stationObservation");
        JSONObject row = new JSONObject();
        put(row, "schemaVersion", StationObservationV3.SCHEMA_VERSION);
        put(row, "stationType", "fuel");
        put(row, "platform", clean(platform));
        put(row, "city", clean(city));
        if (fuel.has("sourceStationKey")) put(row, "sourceStationKey", fuel.optString("sourceStationKey"));
        put(row, "stationName", common.optString("stationName"));
        put(row, "address", common.opt("address"));
        // 燃油侧无枪数据：本地 row 不写 ports。
        JSONObject quality = common.optJSONObject("quality");
        put(row, "needsReview", quality != null && quality.optBoolean("needsReview"));
        put(row, "missingFields", quality == null ? new JSONArray() : quality.optJSONArray("missingFields"));
        put(row, "capturedAt", common.optString("capturedAt"));
        put(row, "sourceAgent", LocalStationStore.SOURCE_AGENT);
        put(row, "stationObservation", common);
        put(row, "fuelObservation", fuel);
        return row;
    }

    String sourceStationKey() {
        String context = clean(captureContextId);
        if (!context.isEmpty()) return context;
        // 跨渠道去重：同一油站无论从高德还是团油采集都应合并为一条，key 不含 platform。
        return DeviceIdentity.sha256(clean(stationName)).substring(0, 12);
    }

    void addQuote(FuelQuote incoming) {
        if (incoming == null || !incoming.valid()) return;
        String key = incoming.businessDedupKey();
        for (FuelQuote existing : fuelQuotes) {
            if (existing != null && key.equals(existing.businessDedupKey())) return;
        }
        if (fuelQuotes.size() < FuelQuoteFeatureGate.CLIENT_MAX_QUOTES) fuelQuotes.add(incoming);
    }

    FuelOffer offerForGrade(String gradeCode) {
        String expected = clean(gradeCode).replace("#", "");
        for (FuelOffer offer : fuelOffers) {
            if (offer != null && expected.equals(clean(offer.gradeCode))) return offer;
        }
        return null;
    }

    private static void put(JSONObject target, String key, Object value) {
        try {
            target.put(key, value);
        } catch (Exception error) {
            throw new IllegalStateException("无法序列化燃油场站", error);
        }
    }

    private static String clean(String value) {
        return value == null ? "" : value.trim();
    }
}
