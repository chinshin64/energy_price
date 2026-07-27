package com.datafordidi.mobilecollector;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Keeps persisted and newly generated fuel quote identities aligned with the server v3 seed.
 */
final class FuelQuoteIdentityPolicy {
    private FuelQuoteIdentityPolicy() {
    }

    static int repairBatch(JSONObject batch) {
        if (batch == null || !"fuel".equals(batch.optString("stationType"))) return 0;
        JSONArray observations = batch.optJSONArray("observations");
        if (observations == null) return 0;
        int repaired = 0;
        String platform = batch.optString("platform");
        for (int observationIndex = 0; observationIndex < observations.length(); observationIndex++) {
            JSONObject observation = observations.optJSONObject(observationIndex);
            JSONObject fuel = observation == null ? null : observation.optJSONObject("fuelObservation");
            if (fuel == null) continue;
            String sourceStationKey = fuel.optString("sourceStationKey");
            String providerName = fuel.isNull("providerName") ? "" : fuel.optString("providerName");
            JSONArray offers = fuel.optJSONArray("fuelOffers");
            JSONArray quotes = fuel.optJSONArray("fuelQuotes");
            if (quotes == null) continue;
            for (int quoteIndex = 0; quoteIndex < quotes.length(); quoteIndex++) {
                JSONObject quote = quotes.optJSONObject(quoteIndex);
                JSONObject offer = offerForGrade(
                        offers,
                        quote == null ? "" : quote.optString("gradeCode")
                );
                if (FuelQuote.repairJsonIdentity(
                        platform,
                        sourceStationKey,
                        offer,
                        quote,
                        providerName
                )) {
                    repaired++;
                }
            }
        }
        return repaired;
    }

    private static JSONObject offerForGrade(JSONArray offers, String gradeCode) {
        if (offers == null) return null;
        for (int index = 0; index < offers.length(); index++) {
            JSONObject offer = offers.optJSONObject(index);
            if (offer != null && gradeCode.equals(offer.optString("gradeCode"))) return offer;
        }
        return null;
    }
}
