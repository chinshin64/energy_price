package com.datafordidi.mobilecollector;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import java.math.BigDecimal;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

public class FuelQuoteTest {
    private static final String CAPTURED_AT = "2026-07-23T12:00:00Z";

    @Test
    public void validatesTuanyouAndAmapMoneyExamplesWithBigDecimal() {
        FuelQuote tuanyou = quote("8.39", "1.34", "192.95");
        tuanyou.validateFormula();
        assertEquals(new BigDecimal("7.05"), tuanyou.netDiscount);
        assertFalse(tuanyou.needsReview);

        FuelQuote amap = quote("20.65", "3.30", "182.65");
        amap.validateFormula();
        assertEquals(new BigDecimal("17.35"), amap.netDiscount);
        assertFalse(amap.needsReview);
    }

    @Test
    public void missingServiceNeedsReviewButExplicitZeroIsValid() {
        FuelQuote missing = quote("8.39", null, "191.61");
        missing.validateFormula();
        assertTrue(missing.needsReview);
        assertEquals(null, missing.netDiscount);

        FuelQuote zero = quote("8.39", "0", "191.61");
        zero.validateFormula();
        assertFalse(zero.needsReview);
        assertEquals(new BigDecimal("8.39"), zero.netDiscount);
    }

    @Test
    public void mismatchBeyondOneCentNeedsReviewWithoutRewritingObservedPayable() {
        FuelQuote quote = quote("8.39", "1.34", "192.90");
        quote.validateFormula();
        assertTrue(quote.needsReview);
        assertEquals(new BigDecimal("192.90"), quote.payableAmount);
    }

    @Test
    public void quoteIdentityIsStableForRetryAndBusinessDedupIgnoresEntry() {
        FuelOffer offer = new FuelOffer();
        offer.gradeCode = "92";
        offer.gradeLabel = "92#汽油";
        offer.displayPrice = new BigDecimal("6.6300");
        FuelQuote inline = quote("20.65", "3.30", "182.65");
        inline.quoteEntry = "inline";
        inline.finalizeIdentity("amap-fuel", "station-key", offer, "测试服务商");
        FuelQuote popup = quote("20.65", "3.30", "182.65");
        popup.quoteEntry = "explanation_popup";
        popup.finalizeIdentity("amap-fuel", "station-key", offer, "测试服务商");

        assertEquals(inline.businessDedupKey(), popup.businessDedupKey());
        assertEquals(inline.quoteDedupKey, popup.quoteDedupKey);
        assertEquals(inline.quoteObservationId, popup.quoteObservationId);
        FuelStationRecord station = new FuelStationRecord();
        station.addQuote(inline);
        station.addQuote(popup);
        assertEquals(1, station.fuelQuotes.size());

        popup.capturedAt = "2026-07-23T12:01:00Z";
        popup.finalizeIdentity("amap-fuel", "station-key", offer, "测试服务商");
        assertNotEquals(inline.quoteDedupKey, popup.quoteDedupKey);
    }

    @Test
    public void quoteIdentityUsesNodeCompatibleUtcMillisGoldenVector() {
        FuelOffer offer = new FuelOffer();
        offer.gradeCode = "92";
        offer.gradeLabel = "92#汽油";
        offer.displayPrice = new BigDecimal("6.6300");
        FuelQuote quote = quote("20.65", "3.30", "182.65");

        quote.finalizeIdentity("amap-fuel", "station-key", offer, "测试服务商");

        assertEquals("2026-07-23T12:00:00.000Z", quote.capturedAt);
        // 服务端 v3 去重契约包含 platform，避免跨平台使用不同归一化规则时发生冲突。
        assertEquals(
                "435a6daa85e31d6942f1763c6f1e78694a281d1b160b33f1d6a8919c877c5c4f",
                quote.quoteDedupKey
        );
        assertEquals(
                "ba2c4a355035c0504c632c6dfde4d3571f83c5210680da9118e57c630a5a5261",
                quote.quoteObservationId
        );
    }

    @Test
    public void repairsLegacyJsonIdentityUsingServerV3Seed() throws Exception {
        JSONObject offer = new JSONObject()
                .put("gradeCode", "92")
                .put("displayPrice", "6.630")
                .put("stationPrice", JSONObject.NULL)
                .put("nationalPrice", JSONObject.NULL);
        JSONObject quote = new JSONObject()
                .put("quoteObservationId", "a".repeat(64))
                .put("quoteDedupKey", "b".repeat(64))
                .put("gradeCode", "92")
                .put("gunCode", JSONObject.NULL)
                .put("selectedAmount", "200.00")
                .put("grossDiscount", "20.65")
                .put("serviceFee", "3.30")
                .put("payableAmount", "182.65")
                .put("capturedAt", CAPTURED_AT);

        assertTrue(FuelQuote.repairJsonIdentity(
                "amap-fuel",
                "station-key",
                offer,
                quote,
                "测试服务商"
        ));
        assertEquals(
                "435a6daa85e31d6942f1763c6f1e78694a281d1b160b33f1d6a8919c877c5c4f",
                quote.getString("quoteDedupKey")
        );
        assertEquals(
                "ba2c4a355035c0504c632c6dfde4d3571f83c5210680da9118e57c630a5a5261",
                quote.getString("quoteObservationId")
        );
        assertFalse(FuelQuote.repairJsonIdentity(
                "amap-fuel",
                "station-key",
                offer,
                quote,
                "测试服务商"
        ));
    }

    @Test
    public void featureGateFailsClosedAndRequiresExactPlatformAndManualMode() throws Exception {
        String enabled = "{\"success\":true,\"data\":{\"features\":{\"fuel-quote-v1\":{"
                + "\"enabled\":true,\"platforms\":[\"tuanyou\",\"amap-fuel\"],"
                + "\"captureMode\":\"user-driven-ocr\",\"maxOffersPerStation\":8,"
                + "\"maxQuotesPerObservation\":128}}}}";
        assertTrue(FuelQuoteFeatureGate.enabled(enabled, "amap-fuel"));
        assertFalse(FuelQuoteFeatureGate.enabled(enabled, "generic-fuel-x"));
        assertFalse(FuelQuoteFeatureGate.enabled(enabled.replace("user-driven-ocr", "automatic"), "amap-fuel"));
        assertFalse(FuelQuoteFeatureGate.enabled(enabled.replace("\"enabled\":true", "\"enabled\":false"), "amap-fuel"));
        assertFalse(FuelQuoteFeatureGate.enabled("", "amap-fuel"));

        JSONArray oneObservation = new JSONArray().put(new JSONObject()
                .put("fuelObservation", new JSONObject()
                        .put("fuelOffers", new JSONArray().put(new JSONObject()))
                        .put("fuelQuotes", new JSONArray())));
        assertTrue(FuelQuoteFeatureGate.supportsBatch(enabled, "amap-fuel", oneObservation));
        assertFalse(FuelQuoteFeatureGate.supportsBatch(
                enabled.replace("\"maxOffersPerStation\":8", "\"maxOffersPerStation\":0"),
                "amap-fuel",
                oneObservation
        ));
        assertFalse(FuelQuoteFeatureGate.supportsBatch(
                enabled.replace("\"maxOffersPerStation\":8", "\"maxOffersPerStation\":1"),
                "amap-fuel",
                new JSONArray().put(new JSONObject().put(
                        "fuelObservation",
                        new JSONObject()
                                .put("fuelOffers", new JSONArray()
                                        .put(new JSONObject())
                                        .put(new JSONObject()))
                                .put("fuelQuotes", new JSONArray())
                ))
        ));
    }

    @Test
    public void strictFuelQuoteAckRequiresStationQuoteCountsAndSourceRange() throws Exception {
        JSONObject data = new JSONObject()
                .put("persisted", true)
                .put("sourceNode", "47-mysql")
                .put("sourceAgent", LocalStationStore.SOURCE_AGENT)
                .put("acceptedCount", 1)
                .put("acceptedStationCount", 1)
                .put("acceptedQuoteCount", 2)
                .put("ingestId", "fuel-quote-ingest")
                .put("firstSourceRecordId", 101)
                .put("lastSourceRecordId", 101);
        String response = new JSONObject().put("success", true).put("data", data).toString();
        StationSyncClient.parseAcknowledgement(201, response, false, 1, true, 2);

        data.put("acceptedQuoteCount", 1);
        try {
            StationSyncClient.parseAcknowledgement(
                    201,
                    new JSONObject().put("success", true).put("data", data).toString(),
                    false,
                    1,
                    true,
                    2
            );
            fail("quote count mismatch must retain local data");
        } catch (IllegalStateException expected) {
            assertTrue(expected.getMessage().contains("燃油报价"));
        }
    }

    @Test
    public void ordinaryFuelV2AckAlsoRequiresStationCountAndSourceRange() throws Exception {
        JSONObject data = new JSONObject()
                .put("persisted", true)
                .put("sourceNode", "47-mysql")
                .put("sourceAgent", LocalStationStore.SOURCE_AGENT)
                .put("acceptedCount", 1)
                .put("acceptedStationCount", 1)
                .put("ingestId", "fuel-ingest")
                .put("firstSourceRecordId", 301)
                .put("lastSourceRecordId", 301);
        String response = new JSONObject().put("success", true).put("data", data).toString();
        StationSyncClient.parseAcknowledgement(201, response, false, 1, false, 0, true);

        data.remove("firstSourceRecordId");
        try {
            StationSyncClient.parseAcknowledgement(201, new JSONObject()
                    .put("success", true).put("data", data).toString(), false, 1, false, 0, true);
            fail("ordinary fuel v2 must retain local data without durable source range");
        } catch (IllegalStateException expected) {
            assertTrue(expected.getMessage().contains("场站"));
        }
    }

    @Test
    public void v3ObservationKeepsFeatureMarkerAtBatchLevel() throws Exception {
        FuelStationRecord station = stationWithQuote();
        JSONObject envelope = station.observationJson("西安");
        assertFalse(envelope.has("feature"));
        assertEquals(1, StationSyncClient.countFuelQuotes(new JSONArray().put(envelope)));
        ObservationEnvelope.requireValid(envelope);

        JSONObject quote = station.fuelQuotes.get(0).toJson();
        quote.put("unknownPaymentField", "must-reject");
        try {
            FuelQuote.requireValidJson(quote);
            fail("unknown quote fields must be rejected");
        } catch (IllegalArgumentException expected) {
            assertTrue(expected.getMessage().contains("未知字段"));
        }
    }

    static FuelStationRecord stationWithQuote() {
        FuelStationRecord station = new FuelStationRecord();
        station.platform = "amap-fuel";
        station.stationName = "高德测试加油站";
        station.captureContextId = "station-key";
        station.capturedAt = CAPTURED_AT;
        station.sourceStage = "screen-ocr-user-driven";
        station.localParser = "amap-fuel-android-ocr";
        station.providerName = "测试服务商";
        FuelOffer offer = new FuelOffer();
        offer.gradeCode = "92";
        offer.gradeLabel = "92#汽油";
        offer.displayPrice = new BigDecimal("6.6300");
        offer.stationPrice = new BigDecimal("7.8600");
        offer.nationalPrice = new BigDecimal("8.1200");
        offer.discountPrice = 6.63d;
        offer.listPrice = 7.86d;
        offer.capturedAt = CAPTURED_AT;
        station.fuelOffers.add(offer);
        FuelQuote quote = quote("20.65", "3.30", "182.65");
        quote.finalizeIdentity(station.platform, station.sourceStationKey(), offer, station.providerName);
        station.addQuote(quote);
        return station;
    }

    private static FuelQuote quote(String gross, String service, String payable) {
        FuelQuote quote = new FuelQuote();
        quote.gradeCode = "92";
        quote.gradeLabel = "92#汽油";
        quote.selectedAmount = FuelQuote.money("200.00");
        quote.grossDiscount = FuelQuote.money(gross);
        quote.serviceFee = FuelQuote.money(service);
        quote.payableAmount = FuelQuote.money(payable);
        quote.quoteEntry = "inline";
        quote.capturedAt = CAPTURED_AT;
        return quote;
    }
}
