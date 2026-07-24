package com.datafordidi.mobilecollector;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

@RunWith(RobolectricTestRunner.class)
public final class AndroidProductionV3PayloadFixtureTest {
    @Test
    public void buildsFixtureThroughProductionSerializerAndOptionallyWritesIt() throws Exception {
        Context context = RuntimeEnvironment.getApplication();
        DidiLocalStationParser.StationRecord station = new DidiLocalStationParser.StationRecord();
        station.platform = "didi-charging";
        station.stationName = "Android生产序列化契约充电站";
        station.address = "陕西省西安市高新区科技二路88号A座";
        station.fastIdlePorts = 3;
        station.fastTotalPorts = 8;
        station.slowIdlePorts = 1;
        station.slowTotalPorts = 2;
        station.portsObserved = true;
        station.priceFast = 0.85d;
        station.priceSlow = 0.62d;
        station.priceService = 0.10d;
        station.priceObserved = true;
        station.capturedAt = "2026-07-24T08:30:00Z";
        station.sourceStage = "screen-ocr-user-driven";

        JSONObject observation = ObservationEnvelope.charging(station, "西安");
        JSONObject batch = new JSONObject()
                .put("schemaVersion", StationObservationV3.SCHEMA_VERSION)
                .put("stationType", "charging")
                .put("platform", station.platform)
                .put("city", "西安")
                .put("sessionId", "android-production-contract")
                .put("pageIndex", 7)
                .put("screenHash", DeviceIdentity.sha256("android-production-contract-screen"))
                .put("capturedAt", station.capturedAt)
                .put("observations", new JSONArray().put(observation));
        JSONObject payload = StationSyncClient.buildPayload(
                context,
                batch,
                batch.getJSONArray("observations"),
                false
        );
        StationSensitiveDataPolicy.requireSafePayload(payload);
        String idempotencyKey = StationSyncClient.idempotencyKey(
                payload.getString("deviceId"),
                batch.getString("sessionId"),
                batch.getInt("pageIndex"),
                batch.getString("screenHash")
        );
        JSONObject fixture = new JSONObject()
                .put("serializer", "android-production-java")
                .put("sourceAgent", LocalStationStore.SOURCE_AGENT)
                .put("idempotencyKey", idempotencyKey)
                .put("payload", payload);

        assertEquals("android-production-java", fixture.getString("serializer"));
        assertEquals(LocalStationStore.SOURCE_AGENT, payload.getString("sourceAgent"));
        assertFalse(idempotencyKey.isEmpty());
        JSONObject common = payload.getJSONArray("observations").getJSONObject(0)
                .getJSONObject("stationObservation");
        assertEquals(station.address, common.getString("address"));
        assertEquals(4, common.getInt("availablePorts"));
        assertEquals(6, common.getInt("busyPorts"));
        assertEquals(10, common.getInt("totalPorts"));
        assertEquals("0.85", payload.getJSONArray("observations").getJSONObject(0)
                .getJSONObject("chargingObservation").getString("priceFast"));

        String output = System.getProperty("mobile.contract.fixtureOutput", "").trim();
        if (!output.isEmpty()) {
            Path target = Path.of(output).toAbsolutePath().normalize();
            Files.createDirectories(target.getParent());
            Files.write(target, fixture.toString().getBytes(StandardCharsets.UTF_8));
            assertTrue(Files.size(target) > 0L);
        }
    }
}
