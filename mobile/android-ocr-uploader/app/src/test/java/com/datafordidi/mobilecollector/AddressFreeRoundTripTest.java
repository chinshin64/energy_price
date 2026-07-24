package com.datafordidi.mobilecollector;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import java.util.Arrays;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;

public class AddressFreeRoundTripTest {
    @Test
    public void stationRecordLocalOutboxAndHttpViewsPreserveAddressAndStripSecrets() throws Exception {
        DidiLocalStationParser.StationRecord station = new DidiLocalStationParser.StationRecord();
        station.platform = "generic-charging-test";
        station.stationName = "特来电无地址测试充电站";
        station.address = "旧对象地址仅用于兼容";
        station.priceFast = 0.88d;
        station.priceObserved = true;

        JSONObject stationJson = station.toJson();
        assertEquals("旧对象地址仅用于兼容", stationJson.getString("address"));

        JSONObject localLegacy = new JSONObject(stationJson.toString())
                .put("address", "旧Local地址")
                .put("raw", new JSONObject().put("address", "旧raw地址")
                        .put("authorization", "Bearer must-not-survive"));
        String originalLocal = localLegacy.toString();
        JSONObject localView = LocalStationStore.addressFreeView(Arrays.asList(localLegacy)).get(0);
        assertEquals("旧Local地址", localView.getString("address"));
        assertEquals("旧raw地址", localView.getJSONObject("raw").getString("address"));
        assertFalse(localView.getJSONObject("raw").has("authorization"));
        assertEquals(originalLocal, localLegacy.toString());

        JSONObject legacyStation = new JSONObject(stationJson.toString()).put("address", "旧outbox地址");
        JSONObject legacyBatch = new JSONObject()
                .put("batchId", "legacy")
                .put("attempts", 7)
                .put("lastError", "待重试")
                .put("localKeys", new JSONArray().put("stable-local-key"))
                .put("stations", new JSONArray().put(legacyStation
                        .put("nested", new JSONArray()
                                .put(new JSONObject().put("Address", "大小写旧地址"))
                                .put(new JSONObject().put("ADDR", JSONObject.NULL)))));
        String originalBatch = legacyBatch.toString();
        JSONObject outboxView = OutboxStore.addressFreeView(Arrays.asList(legacyBatch)).get(0);
        assertTrue(AddressFreePayload.containsAddressKey(outboxView));
        assertEquals(7, outboxView.getInt("attempts"));
        assertEquals("待重试", outboxView.getString("lastError"));
        assertEquals("stable-local-key", outboxView.getJSONArray("localKeys").getString(0));
        JSONArray httpStations = StationSyncClient.addressFreeStations(legacyBatch);
        assertEquals("旧outbox地址", httpStations.getJSONObject(0).getString("address"));
        assertEquals(originalBatch, legacyBatch.toString());
    }

    @Test
    public void legacyAddressAppearsInUiAddressField() throws Exception {
        JSONObject legacy = new JSONObject()
                .put("stationName", "特来电无地址测试充电站")
                .put("address", "西安市雁塔区旧地址1号")
                .put("availablePorts", 2)
                .put("totalPorts", 4)
                .put("priceFast", 0.88d)
                .put("raw", new JSONObject().put("observed", new JSONObject()
                        .put("ports", true).put("price", true)));
        String details = StationDisplayFormatter.details(legacy);
        assertEquals("西安市雁塔区旧地址1号", StationDisplayFormatter.address(legacy));
        assertTrue(details.contains("闲 2 / 忙 2 / 总 4"));
        assertTrue(details.contains("快 0.88"));
    }

    @Test
    public void identityUsesPlatformCityAndNameOnly() {
        String first = LocalStationStore.buildKey("didi-charging", "西安", "同名充电站");
        String same = LocalStationStore.buildKey("didi-charging", "西 安", "同名 充电站");
        String otherPlatform = LocalStationStore.buildKey("amap-charging", "西安", "同名充电站");
        String otherCity = LocalStationStore.buildKey("didi-charging", "武汉", "同名充电站");
        assertEquals(first, same);
        assertNotEquals(first, otherPlatform);
        assertNotEquals(first, otherCity);
        assertNotEquals(
                LocalStationStore.buildKey("didi-charging", "西安", "同名充电站", "same-name-1"),
                LocalStationStore.buildKey("didi-charging", "西安", "同名充电站", "same-name-2")
        );
    }

    @Test
    public void addressChangeCreatesNewObservation() {
        StationObservationTracker tracker = new StationObservationTracker();
        DidiLocalStationParser.StationRecord first = station("旧地址A");
        DidiLocalStationParser.StationRecord repeated = station("旧地址B");
        assertEquals(1, tracker.changed(
                "session-a", "page-1", "didi-charging", "西安", Arrays.asList(first)
        ).size());
        assertEquals(1, tracker.changed(
                "session-a", "page-1", "didi-charging", "西安", Arrays.asList(repeated)
        ).size());
    }

    @Test
    public void sameNameContextsRemainStableAcrossPagesAndDoNotConflate() {
        StationObservationTracker tracker = new StationObservationTracker();
        DidiLocalStationParser.StationRecord firstCard = station("旧地址A");
        firstCard.transientIdentityText = "西安市雁塔区甲路1号";
        DidiLocalStationParser.StationRecord secondCard = station("旧地址B");
        secondCard.transientIdentityText = "西安市雁塔区乙路2号";
        assertEquals(2, tracker.changed(
                "session-a", "page-1", "didi-charging", "西安",
                Arrays.asList(firstCard, secondCard)
        ).size());
        String firstContext = firstCard.captureContextId;
        String secondContext = secondCard.captureContextId;
        assertNotEquals(firstContext, secondContext);

        DidiLocalStationParser.StationRecord nextPageFirst = station("地址变化不参与身份");
        nextPageFirst.transientIdentityText = "西安市雁塔区甲路I号";
        assertEquals(1, tracker.changed(
                "session-a", "page-2", "didi-charging", "西安",
                Arrays.asList(nextPageFirst)
        ).size());
        assertEquals(firstContext, nextPageFirst.captureContextId);

        DidiLocalStationParser.StationRecord reorderedSecond = station("不序列化地址");
        reorderedSecond.transientIdentityText = "西安市雁塔区乙路2号";
        DidiLocalStationParser.StationRecord reorderedFirst = station("不序列化地址");
        reorderedFirst.transientIdentityText = "西安市雁塔区甲路1号";
        tracker.previewChanged(
                "session-a", "page-3", "didi-charging", "西安",
                Arrays.asList(reorderedSecond, reorderedFirst)
        );
        assertEquals(secondContext, reorderedSecond.captureContextId);
        assertEquals(firstContext, reorderedFirst.captureContextId);
    }

    @Test
    public void twoSameNameStationsCanAppearOnSeparatePagesWithoutConflation() {
        StationObservationTracker tracker = new StationObservationTracker();
        DidiLocalStationParser.StationRecord firstPage = station("legacy-a");
        firstPage.transientIdentityText = "西安市未央区凤城一路1号";
        tracker.changed(
                "session-a", "page-1", "didi-charging", "西安", Arrays.asList(firstPage)
        );

        DidiLocalStationParser.StationRecord secondPage = station("legacy-b");
        secondPage.transientIdentityText = "西安市未央区凤城九路9号";
        assertEquals(1, tracker.changed(
                "session-a", "page-2", "didi-charging", "西安", Arrays.asList(secondPage)
        ).size());
        assertNotEquals(firstPage.captureContextId, secondPage.captureContextId);
    }

    @Test
    public void addresslessSameNameSameColumnOnDifferentPagesUsesDifferentIdentity() {
        StationObservationTracker tracker = new StationObservationTracker();
        DidiLocalStationParser.StationRecord firstPage = station("legacy-a");
        DidiLocalStationParser.StationRecord secondPage = station("legacy-b");

        tracker.changed(
                "session-a", "page-1", "didi-charging", "西安", Arrays.asList(firstPage)
        );
        tracker.changed(
                "session-a", "page-2", "didi-charging", "西安", Arrays.asList(secondPage)
        );

        assertNotEquals(firstPage.captureContextId, secondPage.captureContextId);
    }

    @Test
    public void addresslessStableResampleOnSamePageReusesIdentity() {
        StationObservationTracker tracker = new StationObservationTracker();
        DidiLocalStationParser.StationRecord firstSample = station("legacy-a");
        DidiLocalStationParser.StationRecord repeatedSample = station("legacy-b");
        firstSample.address = null;
        repeatedSample.address = null;

        assertEquals(1, tracker.changed(
                "session-a", "page-1", "didi-charging", "西安", Arrays.asList(firstSample)
        ).size());
        assertEquals(0, tracker.changed(
                "session-a", "page-1", "didi-charging", "西安", Arrays.asList(repeatedSample)
        ).size());
        assertEquals(firstSample.captureContextId, repeatedSample.captureContextId);
    }

    @Test
    public void observationIdentityIsIsolatedBySession() {
        StationObservationTracker tracker = new StationObservationTracker();
        DidiLocalStationParser.StationRecord firstSession = station("legacy-a");
        DidiLocalStationParser.StationRecord secondSession = station("legacy-b");

        assertEquals(1, tracker.changed(
                "session-a", "page-1", "didi-charging", "西安", Arrays.asList(firstSession)
        ).size());
        assertEquals(1, tracker.changed(
                "session-b", "page-1", "didi-charging", "西安", Arrays.asList(secondSession)
        ).size());
    }

    @Test
    public void rejectionReasonsAcceptOnlyFixedEnums() throws Exception {
        DidiLocalStationParser.StationRecord station = new DidiLocalStationParser.StationRecord();
        station.addRejectionReason("no-price-candidate");
        station.addRejectionReason("西安市某路地址邻文");
        JSONArray reasons = station.toJson().getJSONObject("raw")
                .getJSONObject("diagnostics").getJSONArray("rejectionReasons");
        assertEquals(1, reasons.length());
        assertEquals("no-price-candidate", reasons.getString(0));
    }

    private static DidiLocalStationParser.StationRecord station(String legacyAddress) {
        DidiLocalStationParser.StationRecord station = new DidiLocalStationParser.StationRecord();
        station.stationName = "同名充电站";
        station.address = legacyAddress;
        station.fastIdlePorts = 2;
        station.fastTotalPorts = 4;
        station.portsObserved = true;
        station.localParser = "generic";
        station.transientCardKey = "10:20:-";
        station.transientStaticSignature = "generic:column-2";
        return station;
    }
}
