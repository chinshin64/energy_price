package com.datafordidi.mobilecollector;

import org.json.JSONArray;
import org.json.JSONObject;

final class FuelQuoteFeatureGate {
    static final String FEATURE = "fuel-quote-v1";
    static final String CAPTURE_MODE = "user-driven-ocr";
    static final int CLIENT_MAX_OFFERS = 8;
    static final int CLIENT_MAX_QUOTES = 128;

    private FuelQuoteFeatureGate() {
    }

    static boolean enabled(String responseText, String platform) {
        return capability(responseText, platform) != null;
    }

    static boolean supportsBatch(String responseText, String platform, JSONArray observations) {
        Capability capability = capability(responseText, platform);
        if (capability == null || observations == null) return false;
        for (int index = 0; index < observations.length(); index++) {
            JSONObject observation = observations.optJSONObject(index);
            JSONObject fuel = observation == null ? null : observation.optJSONObject("fuelObservation");
            if (fuel == null) return false;
            JSONArray offers = fuel.optJSONArray("fuelOffers");
            JSONArray quotes = fuel.optJSONArray("fuelQuotes");
            if (offers == null || offers.length() > capability.maxOffersPerStation
                    || (quotes != null && quotes.length() > capability.maxQuotesPerObservation)) {
                return false;
            }
        }
        return true;
    }

    private static Capability capability(String responseText, String platform) {
        try {
            JSONObject root = new JSONObject(responseText == null ? "" : responseText);
            JSONObject data = root.optJSONObject("data");
            if (!root.optBoolean("success", false) || data == null) return null;
            JSONObject features = data.optJSONObject("features");
            if (features == null) {
                JSONObject capabilities = data.optJSONObject("capabilities");
                features = capabilities == null ? null : capabilities.optJSONObject("features");
            }
            JSONObject feature = features == null ? null : features.optJSONObject(FEATURE);
            if (feature == null
                    || !feature.optBoolean("enabled", false)
                    || !CAPTURE_MODE.equals(feature.optString("captureMode"))
                    || feature.optInt("maxOffersPerStation", 0) <= 0
                    || feature.optInt("maxQuotesPerObservation", 0) <= 0) {
                return null;
            }
            JSONArray platforms = feature.optJSONArray("platforms");
            if (platforms == null) return null;
            for (int index = 0; index < platforms.length(); index++) {
                if (clean(platform).equals(platforms.optString(index))) {
                    return new Capability(
                            feature.optInt("maxOffersPerStation"),
                            feature.optInt("maxQuotesPerObservation")
                    );
                }
            }
            return null;
        } catch (Exception ignored) {
            return null;
        }
    }

    static boolean requiresFeature(FuelStationRecord station) {
        if (station == null) return false;
        if (!clean(station.providerName).isEmpty()
                || station.providerEvidence != null
                || !station.fuelQuotes.isEmpty()) {
            return true;
        }
        for (FuelOffer offer : station.fuelOffers) {
            if (offer != null && offer.hasRolePrice()) return true;
        }
        return false;
    }

    static boolean requiresFeature(JSONObject observation) {
        if (observation == null) return false;
        JSONObject fuel = observation.optJSONObject("fuelObservation");
        if (fuel == null) return false;
        if (!fuel.isNull("providerName") || !fuel.isNull("providerEvidence")) return true;
        JSONArray quotes = fuel.optJSONArray("fuelQuotes");
        if (quotes != null && quotes.length() > 0) return true;
        JSONArray offers = fuel.optJSONArray("fuelOffers");
        if (offers != null) {
            for (int index = 0; index < offers.length(); index++) {
                JSONObject offer = offers.optJSONObject(index);
                if (offer != null && (!offer.isNull("displayPrice")
                        || !offer.isNull("stationPrice")
                        || !offer.isNull("nationalPrice"))) {
                    return true;
                }
            }
        }
        return false;
    }

    private static String clean(String value) {
        return value == null ? "" : value.trim();
    }

    private static final class Capability {
        final int maxOffersPerStation;
        final int maxQuotesPerObservation;

        Capability(int maxOffersPerStation, int maxQuotesPerObservation) {
            this.maxOffersPerStation = maxOffersPerStation;
            this.maxQuotesPerObservation = maxQuotesPerObservation;
        }
    }
}
