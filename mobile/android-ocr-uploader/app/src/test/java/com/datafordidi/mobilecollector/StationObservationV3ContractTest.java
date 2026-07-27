package com.datafordidi.mobilecollector;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;

import java.util.Collections;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

@RunWith(RobolectricTestRunner.class)
public class StationObservationV3ContractTest {
    @Test
    public void chargingGoldenPayloadUsesPublicCommonFieldsAndNullableSemantics() throws Exception {
        DidiLocalStationParser.StationRecord station = new DidiLocalStationParser.StationRecord();
        station.platform = "didi-charging";
        station.stationName = "小桔充电西安测试站";
        station.address = "陕西省西安市雁塔区测试路1号";
        station.fastIdlePorts = 3;
        station.fastTotalPorts = 8;
        station.slowIdlePorts = 1;
        station.slowTotalPorts = 2;
        station.portsObserved = true;
        station.priceFast = 0.85d;
        station.priceService = 0.1d;
        station.priceObserved = true;
        station.capturedAt = "2026-07-24T08:30:00.123Z";
        station.sourceStage = "screen-ocr-user-driven";

        JSONObject observation = ObservationEnvelope.charging(station, "西安");
        ObservationEnvelope.requireValid(observation);

        assertEquals(3, observation.getInt("schemaVersion"));
        JSONObject common = observation.getJSONObject("stationObservation");
        assertEquals(station.address, common.getString("address"));
        assertEquals(4, common.getInt("availablePorts"));
        assertEquals(6, common.getInt("busyPorts"));
        assertEquals(10, common.getInt("totalPorts"));
        assertEquals("charging-gun", common.getString("portSemantics"));
        assertEquals("valid", common.getJSONObject("quality").getString("status"));
        JSONObject charging = observation.getJSONObject("chargingObservation");
        assertEquals("0.85", charging.getString("priceFast"));
        assertEquals("0.1", charging.getString("priceService"));
        assertFalse(observation.has("fuelObservation"));
    }

    @Test
    public void actualRequestPayloadKeepsV3DeviceSessionAgentAndAddress() throws Exception {
        Context context = RuntimeEnvironment.getApplication();
        DidiLocalStationParser.StationRecord station = new DidiLocalStationParser.StationRecord();
        station.stationName = "高德充电测试站";
        station.address = "湖北省武汉市洪山区测试大道2号";
        station.capturedAt = "2026-07-24T09:30:00Z";
        station.sourceStage = "screen-ocr-user-driven";
        JSONObject observation = ObservationEnvelope.charging(station, "武汉");
        JSONObject batch = new JSONObject()
                .put("schemaVersion", 3)
                .put("stationType", "charging")
                .put("platform", "amap-charging")
                .put("city", "武汉")
                .put("sessionId", "capture-session-v3")
                .put("pageIndex", 4)
                .put("capturedAt", station.capturedAt)
                .put("observations", new JSONArray().put(observation));

        JSONObject payload = StationSyncClient.buildPayload(
                context, batch, batch.getJSONArray("observations"), false
        );

        assertEquals(3, payload.getInt("schemaVersion"));
        assertEquals("android-ocr-agent", payload.getString("sourceAgent"));
        assertFalse(payload.getString("deviceSessionId").isEmpty());
        assertFalse(payload.getString("deviceId").isEmpty());
        assertEquals(station.address, payload.getJSONArray("observations").getJSONObject(0)
                .getJSONObject("stationObservation").getString("address"));
        assertFalse(payload.has("batchId"));
        assertFalse(payload.has("screenHash"));
        assertFalse(AddressFreePayload.containsSensitiveKey(payload));
    }

    @Test
    public void v3CapabilitySupportsBackendCompatibilityShape() {
        assertTrue(StationSyncClient.supportsSchemaV3(
                "{\"success\":true,\"data\":{\"capabilities\":{\"schemaVersion\":2,"
                        + "\"latestSchemaVersion\":3,\"supportedSchemaVersions\":[1,2,3]}}}"
        ));
        assertTrue(StationSyncClient.supportsSchemaV3(
                "{\"success\":true,\"data\":{\"capabilities\":{\"schemaVersion\":3}}}"
        ));
        assertFalse(StationSyncClient.supportsSchemaV3(
                "{\"success\":true,\"data\":{\"capabilities\":{\"schemaVersion\":2,"
                        + "\"supportedSchemaVersions\":[1,2]}}}"
        ));
    }

    @Test
    public void fuelGoldenPayloadKeepsAddressWithoutGunState() {
        FuelStationRecord station = new FuelStationRecord();
        station.platform = "tuanyou";
        station.stationName = "团油武汉测试站";
        station.address = "湖北省武汉市江岸区测试路3号";
        station.capturedAt = "2026-07-24T10:30:00Z";
        station.sourceStage = "screen-ocr-user-driven";
        FuelOffer offer = new FuelOffer();
        offer.gradeCode = "92";
        offer.gradeLabel = "92#";
        offer.listPrice = 7.4d;
        offer.discountPrice = 7.1d;
        offer.capturedAt = station.capturedAt;
        station.fuelOffers.add(offer);

        JSONObject observation = station.observationJson("武汉");
        ObservationEnvelope.requireValid(observation);

        JSONObject common = observation.optJSONObject("stationObservation");
        assertNotNull(common);
        // 燃油侧不采集地址：common 不生成 address 键。
        assertFalse(common.has("address"));
        // 燃油侧无枪数据：common 不携带 ports/portSemantics。
        assertFalse(common.has("availablePorts"));
        assertFalse(common.has("busyPorts"));
        assertFalse(common.has("totalPorts"));
        assertFalse(common.has("portSemantics"));
        JSONObject fuel = observation.optJSONObject("fuelObservation");
        assertNotNull(fuel);
        assertFalse(fuel.has("address"));
        assertFalse(fuel.has("availablePorts"));
        assertEquals(1, fuel.optJSONArray("fuelOffers").length());
    }
}
