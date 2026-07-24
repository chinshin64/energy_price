package com.datafordidi.mobilecollector;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import java.util.Arrays;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

public class FuelStationParserTest {
    private static final String CAPTURED_AT = "2026-07-23T03:30:00Z";

    @Test
    public void detectsTuanyouAndParsesExplicitSameCardPrices() {
        List<OcrRow> rows = Arrays.asList(
                row("92#·筛选", .78f, .11f, .18f, .03f),
                row("浙江石油西湖塘河站", .06f, .22f, .48f, .035f),
                row("团油价", .06f, .29f, .13f, .03f),
                row("7.06元/L", .07f, .33f, .19f, .04f),
                row("油站价¥7.39/L", .06f, .38f, .28f, .035f),
                row("1.2km", .75f, .23f, .16f, .03f)
        );
        assertEquals("tuanyou", FuelPlatformDetector.detect(rows, "com.czb.chezhubang"));
        List<FuelStationRecord> stations = FuelStationParser.extract(
                rows, "tuanyou", "screen-ocr-auto-scroll"
        );
        assertEquals(1, stations.size());
        FuelStationRecord station = stations.get(0);
        assertEquals("浙江石油西湖塘河站", station.stationName);
        assertEquals(1, station.fuelOffers.size());
        FuelOffer offer = station.fuelOffers.get(0);
        assertEquals("92", offer.gradeCode);
        assertEquals(7.06d, offer.discountPrice, 0.00001d);
        assertEquals(7.39d, offer.listPrice, 0.00001d);
        assertNull(offer.unclassifiedPrice);
    }

    @Test
    public void supportsMultipleGradesAndRejectsMarketingPaymentDistanceAndTime() {
        List<OcrRow> rows = Arrays.asList(
                row("中石化测试加油站", .06f, .20f, .5f, .04f),
                row("92# 团油价 7.10元/L", .06f, .27f, .35f, .035f),
                row("92# 油站价 7.40元/L", .06f, .31f, .35f, .035f),
                row("95# 优惠价 7.50元/L", .06f, .35f, .35f, .035f),
                row("95# 国标价 7.90元/L", .06f, .39f, .35f, .035f),
                row("满200元前20L¥6.66/L", .06f, .43f, .5f, .035f),
                row("订单实付 188.00元", .06f, .47f, .4f, .035f),
                row("07:00-22:00", .70f, .25f, .2f, .03f),
                row("500m", .75f, .30f, .15f, .03f)
        );
        List<FuelStationRecord> stations = FuelStationParser.extract(
                rows,
                FuelPlatformDetector.detect(rows, "com.example.fuel"),
                "screen-ocr-auto-scroll"
        );
        assertEquals(1, stations.size());
        assertEquals(2, stations.get(0).fuelOffers.size());
        for (FuelOffer offer : stations.get(0).fuelOffers) {
            assertFalse(Double.valueOf(6.66d).equals(offer.discountPrice));
            assertTrue(offer.listPrice >= offer.discountPrice);
        }
    }

    @Test
    public void uncertainFuelEvidenceProducesNoFuelPlatform() {
        assertEquals("", FuelPlatformDetector.detect(
                Arrays.asList(row("附近加油优惠", .1f, .2f, .5f, .04f)),
                "com.example.unknown"
        ));
        assertEquals("", FuelPlatformDetector.detect(
                Arrays.asList(row("团油", .1f, .2f, .5f, .04f)),
                "com.czb.chezhubang"
        ));
    }

    @Test
    public void parses95_98AndDieselZeroFixtures() {
        List<FuelStationRecord> stations = FuelStationParser.extract(
                Arrays.asList(
                        row("中石油西安真实测试加油站", .05f, .18f, .48f, .04f),
                        row("95# 油站价 8.2100元/L", .06f, .25f, .36f, .035f),
                        row("95# 团油价 7.9800元/L", .06f, .29f, .36f, .035f),
                        row("98# 油站价 9.0100元/L", .06f, .33f, .36f, .035f),
                        row("98# 优惠价 8.7600元/L", .06f, .37f, .36f, .035f),
                        row("0#柴油 挂牌价 7.4500元/L", .06f, .41f, .42f, .035f),
                        row("0#柴油 折后价 7.1200元/L", .06f, .45f, .42f, .035f)
                ),
                "tuanyou",
                "screen-ocr-auto-scroll"
        );

        assertEquals(1, stations.size());
        assertEquals(3, stations.get(0).fuelOffers.size());
        assertEquals("95", stations.get(0).fuelOffers.get(0).gradeCode);
        assertEquals("98", stations.get(0).fuelOffers.get(1).gradeCode);
        assertEquals("0", stations.get(0).fuelOffers.get(2).gradeCode);
        assertEquals("diesel", stations.get(0).fuelOffers.get(2).fuelType);
    }

    @Test
    public void keepsDualColumnAndVerticalCardsIndependent() {
        List<FuelStationRecord> columns = FuelStationParser.extract(
                Arrays.asList(
                        row("左侧石化加油站", .04f, .18f, .37f, .04f),
                        row("右侧石油加油站", .55f, .18f, .37f, .04f),
                        row("95# 团油价 7.1111元/L", .05f, .25f, .32f, .035f),
                        row("98# 团油价 8.2222元/L", .56f, .25f, .32f, .035f)
                ),
                "tuanyou",
                "screen-ocr-auto-scroll"
        );
        assertEquals(2, columns.size());
        assertEquals("95", columns.get(0).fuelOffers.get(0).gradeCode);
        assertEquals(7.1111d, columns.get(0).fuelOffers.get(0).discountPrice, 0.00001d);
        assertEquals("98", columns.get(1).fuelOffers.get(0).gradeCode);
        assertEquals(8.2222d, columns.get(1).fuelOffers.get(0).discountPrice, 0.00001d);

        List<FuelStationRecord> vertical = FuelStationParser.extract(
                Arrays.asList(
                        row("第一石化加油站", .05f, .12f, .45f, .04f),
                        row("95# 油站价 8.1000元/L", .06f, .19f, .34f, .035f),
                        row("第二石油加油站", .05f, .30f, .45f, .04f),
                        row("98# 油站价 9.2000元/L", .06f, .37f, .34f, .035f)
                ),
                "tuanyou",
                "screen-ocr-auto-scroll"
        );
        assertEquals(2, vertical.size());
        assertEquals("95", vertical.get(0).fuelOffers.get(0).gradeCode);
        assertEquals("98", vertical.get(1).fuelOffers.get(0).gradeCode);
    }

    @Test
    public void supportsOffsetFilterHeaderAndRejectsMarketingOnlyPrices() {
        List<FuelStationRecord> header = FuelStationParser.extract(
                Arrays.asList(
                        row("选择油号 98# · 筛选", .68f, .05f, .28f, .03f),
                        row("偏移标题能源加油站", .06f, .24f, .48f, .04f),
                        row("团油价", .06f, .31f, .14f, .03f),
                        row("8.4321元/L", .06f, .35f, .20f, .035f)
                ),
                "tuanyou",
                "screen-ocr-auto-scroll"
        );
        assertEquals(1, header.size());
        assertEquals("98", header.get(0).fuelOffers.get(0).gradeCode);

        assertTrue(FuelStationParser.extract(
                Arrays.asList(
                        row("营销测试石化加油站", .06f, .20f, .48f, .04f),
                        row("95# 满200元前20L¥6.6600/L", .06f, .28f, .48f, .04f),
                        row("会员券后实付188.00元", .06f, .34f, .4f, .04f)
                ),
                "tuanyou",
                "screen-ocr-auto-scroll"
        ).isEmpty());
    }

    @Test
    public void rejectsChargingAndFuelSemanticConflictBeforeParsing() {
        List<OcrRow> rows = Arrays.asList(
                row("95# 团油价 7.1000元/L", .05f, .20f, .35f, .04f),
                row("油站价 7.4000元/L", .05f, .25f, .35f, .04f),
                row("测试充电站 快充", .05f, .32f, .35f, .04f),
                row("可用枪 3 总枪 8 元/度", .05f, .38f, .4f, .04f)
        );
        assertTrue(FuelPlatformDetector.isConflict(rows));
        assertEquals("", FuelPlatformDetector.detect(rows, "com.czb.chezhubang"));
        ScreenContextResolver.ParsedScreen parsed = ScreenContextResolver.resolve(
                rows,
                "com.czb.chezhubang",
                "screen-ocr-auto-scroll"
        );
        assertEquals("conflict", parsed.stationType);
        assertTrue(parsed.isEmpty());
    }

    @Test
    public void v3EnvelopeIsMutuallyExclusiveAndFuelUsesCommonStationFields() {
        FuelStationRecord station = new FuelStationRecord();
        station.platform = "tuanyou";
        station.stationName = "测试加油站";
        station.capturedAt = CAPTURED_AT;
        station.sourceStage = "screen-ocr-auto-scroll";
        station.localParser = "tuanyou-android-ocr";
        FuelOffer offer = new FuelOffer();
        offer.gradeCode = "92";
        offer.gradeLabel = "92#";
        offer.listPrice = 7.4d;
        offer.discountPrice = 7.1d;
        offer.capturedAt = CAPTURED_AT;
        station.fuelOffers.add(offer);

        JSONObject envelope = station.observationJson("杭州");
        ObservationEnvelope.requireValid(envelope);
        assertEquals(3, envelope.optInt("schemaVersion"));
        assertEquals("fuel", envelope.optString("stationType"));
        assertNull(envelope.optJSONObject("chargingObservation"));
        JSONObject fuel = envelope.optJSONObject("fuelObservation");
        assertNotNull(fuel);
        JSONObject common = envelope.optJSONObject("stationObservation");
        assertNotNull(common);
        assertTrue(common.isNull("address"));
        assertTrue(common.isNull("availablePorts"));
        assertFalse(fuel.has("availablePorts"));
        assertFalse(fuel.has("priceFast"));
        assertFalse(fuel.has("address"));
        assertFalse(envelope.has("feature"));
        assertFalse(fuel.has("providerName"));
        assertFalse(fuel.has("providerEvidence"));
        assertFalse(fuel.has("fuelQuotes"));
        assertFalse(fuel.has("sourceStationKey"));
        JSONObject legacyOffer = fuel.optJSONArray("fuelOffers").optJSONObject(0);
        assertFalse(legacyOffer.has("displayPrice"));
        assertFalse(legacyOffer.has("stationPrice"));
        assertFalse(legacyOffer.has("nationalPrice"));

        JSONObject invalid = new JSONObject();
        put(invalid, "schemaVersion", 2);
        put(invalid, "stationType", "fuel");
        put(invalid, "fuelObservation", new JSONObject());
        put(invalid, "chargingObservation", new JSONObject());
        boolean rejected = false;
        try {
            ObservationEnvelope.requireValid(invalid);
        } catch (IllegalArgumentException expected) {
            rejected = true;
        }
        assertTrue(rejected);
    }

    @Test
    public void fuelBackfillValidatesRangePrecisionAndDiscountOrder() {
        FuelBackfillDraft draft = new FuelBackfillDraft();
        draft.addGrade("95#");
        FuelBackfillDraft.GradeDraft grade = draft.grades.get(0);
        grade.listPrice = "7.9000";
        grade.discountPrice = "7.1234";
        FuelBackfillDraft.Validation valid = draft.validate(CAPTURED_AT);
        assertTrue(valid.valid());
        assertEquals(1, valid.offers.length());

        grade.discountPrice = "8.0000";
        assertFalse(draft.validate(CAPTURED_AT).valid());
        grade.discountPrice = "7.12345";
        assertFalse(draft.validate(CAPTURED_AT).valid());
        grade.discountPrice = "0";
        assertFalse(draft.validate(CAPTURED_AT).valid());
    }

    @Test
    public void fuelCapabilityDefaultsToFailClosed() {
        assertFalse(StationSyncClient.supportsFuelV2(""));
        assertFalse(StationSyncClient.supportsFuelV2(
                "{\"success\":true,\"data\":{\"capabilities\":{\"schemaVersion\":1}}}"
        ));
        assertTrue(StationSyncClient.supportsFuelV2(
                "{\"success\":true,\"data\":{\"capabilities\":{\"schemaVersion\":2,"
                        + "\"stationTypes\":[\"charging\",\"fuel\"]}}}"
        ));
        assertFalse(StationSyncClient.supportsFuelV2(
                "{\"success\":true,\"data\":{\"capabilities\":{\"schemaVersion\":3,"
                        + "\"stationTypes\":[\"charging\",\"fuel\"]}}}"
        ));
    }

    @Test
    public void fuelCapabilityIgnoresBackendStorageMetadata() {
        assertTrue(StationSyncClient.supportsFuelV2(
                "{\"success\":true,\"data\":{\"storage\":{\"database\":\"energy_price\"},"
                        + "\"capabilities\":{\"schemaVersion\":2,"
                        + "\"stationTypes\":[\"charging\",\"fuel\"]}}}"
        ));
    }

    @Test
    public void recursivelyRejectsFuelChargingFieldsAndChargingFuelOffers() {
        for (String forbidden : Arrays.asList(
                "priceFast",
                "available_ports",
                "onlineSuperPorts",
                "slowBusyGuns",
                "address"
        )) {
            JSONObject nested = new JSONObject();
            put(nested, forbidden, 1);
            JSONObject evidence = new JSONObject();
            put(evidence, "evidence", nested);
            JSONObject fuel = new JSONObject();
            put(fuel, "raw", new JSONArray().put(evidence));
            JSONObject envelope = new JSONObject();
            put(envelope, "schemaVersion", 2);
            put(envelope, "stationType", "fuel");
            put(envelope, "fuelObservation", fuel);
            assertRejected(envelope);
        }

        JSONObject charging = new JSONObject();
        JSONObject raw = new JSONObject();
        put(raw, "fuel_offers", new JSONArray());
        put(charging, "raw", raw);
        JSONObject chargingEnvelope = new JSONObject();
        put(chargingEnvelope, "schemaVersion", 2);
        put(chargingEnvelope, "stationType", "charging");
        put(chargingEnvelope, "chargingObservation", charging);
        assertRejected(chargingEnvelope);
    }

    @Test
    public void batchSchemaIsExactAndChargingIdentityRemainsCompatible() {
        JSONObject v1 = new JSONObject();
        put(v1, "schemaVersion", 1);
        JSONObject legacyStation = new JSONObject();
        put(legacyStation, "stationName", "旧充电站");
        put(v1, "stations", new JSONArray().put(legacyStation));
        ObservationEnvelope.requireValidBatch(v1);

        JSONObject future = new JSONObject();
        put(future, "schemaVersion", 3);
        put(future, "observations", new JSONArray().put(new JSONObject()));
        assertBatchRejected(future);

        String oldChargingKey = LocalStationStore.buildKey(
                "didi-charging",
                "西安",
                "同名场站",
                "same-card"
        );
        assertEquals("didi-charging|西安|同名场站|same-card", oldChargingKey);
        String fuelKey = LocalStationStore.buildFuelKey(
                "didi-charging",
                "西安",
                "同名场站",
                "same-card"
        );
        assertEquals("fuel|" + oldChargingKey, fuelKey);
        assertFalse(oldChargingKey.equals(fuelKey));
    }

    @Test
    public void v2ChargingBatchUsesObservationsOnUpload() {
        JSONObject charging = new JSONObject();
        put(charging, "stationName", "v2充电测试站");
        JSONObject observation = new JSONObject();
        put(observation, "schemaVersion", 2);
        put(observation, "stationType", "charging");
        put(observation, "chargingObservation", charging);
        JSONObject batch = new JSONObject();
        put(batch, "schemaVersion", 2);
        put(batch, "stationType", "charging");
        put(batch, "observations", new JSONArray().put(observation));
        ObservationEnvelope.requireValidBatch(batch);

        JSONObject payload = new JSONObject();
        try {
            StationSyncClient.addBatchRecords(
                    payload,
                    batch,
                    AddressFreePayload.copyArray(batch.optJSONArray("observations"))
            );
        } catch (Exception error) {
            throw new AssertionError(error);
        }
        assertEquals(2, payload.optInt("schemaVersion"));
        assertEquals("charging", payload.optString("stationType"));
        assertEquals(1, payload.optJSONArray("observations").length());
        assertFalse(payload.has("stations"));
    }

    @Test
    public void fuelPriceRequiresAtMostFourDecimals() {
        FuelOffer four = offer(7.1234d);
        FuelOffer five = offer(7.12345d);
        assertTrue(four.valid());
        assertFalse(five.valid());
    }

    private static OcrRow row(String value, float x, float y, float width, float height) {
        return new OcrRow(value, .96f, x, y, width, height);
    }

    private static void put(JSONObject target, String key, Object value) {
        try {
            target.put(key, value);
        } catch (Exception error) {
            throw new AssertionError(error);
        }
    }

    private static FuelOffer offer(double value) {
        FuelOffer offer = new FuelOffer();
        offer.gradeCode = "95";
        offer.gradeLabel = "95#";
        offer.listPrice = value;
        return offer;
    }

    private static void assertRejected(JSONObject value) {
        boolean rejected = false;
        try {
            ObservationEnvelope.requireValid(value);
        } catch (IllegalArgumentException expected) {
            rejected = true;
        }
        assertTrue(rejected);
    }

    private static void assertBatchRejected(JSONObject value) {
        boolean rejected = false;
        try {
            ObservationEnvelope.requireValidBatch(value);
        } catch (IllegalArgumentException expected) {
            rejected = true;
        }
        assertTrue(rejected);
    }
}
