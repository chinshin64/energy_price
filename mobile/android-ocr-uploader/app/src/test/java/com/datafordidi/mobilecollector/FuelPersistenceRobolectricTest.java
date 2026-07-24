package com.datafordidi.mobilecollector;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;

import androidx.work.testing.WorkManagerTestInitHelper;

import java.util.Collections;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

@RunWith(RobolectricTestRunner.class)
public class FuelPersistenceRobolectricTest {
    private Context context;

    @Before
    public void setUp() {
        context = RuntimeEnvironment.getApplication();
        WorkManagerTestInitHelper.initializeTestWorkManager(context);
        clear();
    }

    @After
    public void tearDown() {
        clear();
    }

    @Test
    public void fuelLocalAndOutboxUseV3WithPublicStationObservation() throws Exception {
        FuelStationRecord station = station();
        List<String> keys = LocalStationStore.upsertFuel(
                context, "fuel-session", 2, "杭州", Collections.singletonList(station)
        );
        assertEquals(1, keys.size());
        JSONObject batch = OutboxStore.enqueueFuel(
                context,
                "fuel-session",
                2,
                "screen-hash",
                "tuanyou",
                "杭州",
                keys,
                Collections.singletonList(station)
        );
        assertEquals(3, batch.optInt("schemaVersion"));
        assertEquals("fuel", batch.optString("stationType"));
        assertFalse(batch.has("stations"));
        JSONArray observations = batch.optJSONArray("observations");
        assertNotNull(observations);
        ObservationEnvelope.requireValid(observations.optJSONObject(0));

        List<JSONObject> rows = LocalStationStore.list(context);
        assertEquals(1, rows.size());
        JSONObject row = rows.get(0);
        assertTrue(StationDisplayFormatter.isFuel(row));
        assertEquals(
                "92#  优惠价 7.1 元/升  挂牌价 7.4 元/升",
                StationDisplayFormatter.fuelOfferSummary(row)
        );
        String serialized = row.toString();
        assertTrue(serialized.contains("\"address\":null"));
        // 燃油侧无枪数据：row 不含 ports 字段。
        assertFalse(serialized.contains("availablePorts"));
        assertFalse(serialized.contains("priceFast"));
    }

    @Test
    public void fuelBackfillUsesRevisionJournalV3BatchAndStrictAckCleanup() throws Exception {
        FuelStationRecord station = station();
        List<String> keys = LocalStationStore.upsertFuel(
                context, "fuel-session", 3, "杭州", Collections.singletonList(station)
        );
        OutboxStore.enqueueFuel(
                context,
                "fuel-session",
                3,
                "screen-hash-backfill",
                "tuanyou",
                "杭州",
                keys,
                Collections.singletonList(station)
        );
        JSONObject source = LocalStationStore.list(context).get(0);
        ManualBackfillDraftStore.State state = ManualBackfillDraftStore.getOrCreate(context, source);
        state.fuelDraft.grades.get(0).discountPrice = "7.05";
        ManualBackfillRepository.SaveResult saved = ManualBackfillRepository.save(context, state);
        assertTrue(saved.saved);
        assertEquals(1, saved.revision);
        JSONObject batch = OutboxStore.findBatch(context, saved.batchId);
        assertEquals(3, batch.optInt("schemaVersion"));
        assertEquals("fuel", batch.optString("stationType"));
        assertNotNull(batch.optJSONObject("manualBackfill"));
        ObservationEnvelope.requireValid(batch.optJSONArray("observations").optJSONObject(0));

        StationSyncClient.UploadResult ack = StationSyncClient.parseAcknowledgement(
                200,
                "{\"success\":true,\"data\":{\"persisted\":true,\"sourceNode\":\"47-mysql\","
                        + "\"sourceAgent\":\"android-ocr-agent\","
                        + "\"acceptedCount\":1,\"ingestId\":\"fuel-ingest\","
                        + "\"firstSourceRecordId\":88,\"lastSourceRecordId\":88}}",
                true,
                1
        );
        ManualBackfillRepository.acknowledge(context, batch, ack.message);
        assertTrue(LocalStationStore.list(context).isEmpty());
        assertTrue(OutboxStore.pending(context).isEmpty());
        assertTrue(BackfillTransactionStore.entries(context).isEmpty());
    }

    @Test
    public void ordinaryAckAfterBackendStorageSwitchRetainsLocalAndClearsOutbox() throws Exception {
        FuelStationRecord station = station();
        List<String> keys = LocalStationStore.upsertFuel(
                context, "fuel-session", 4, "杭州", Collections.singletonList(station)
        );
        JSONObject batch = OutboxStore.enqueueFuel(
                context,
                "fuel-session",
                4,
                "screen-hash-storage-switch",
                "tuanyou",
                "杭州",
                keys,
                Collections.singletonList(station)
        );
        JSONObject ackPayload = new JSONObject()
                .put("success", true)
                .put("data", new JSONObject()
                        .put("persisted", true)
                        .put("sourceNode", "47-mysql")
                        .put("sourceAgent", LocalStationStore.SOURCE_AGENT)
                        .put("storageDatabase", "energy_price")
                        .put("acceptedCount", 1)
                        .put("ingestId", "fuel-storage-switch")
                        .put("firstSourceRecordId", 93)
                        .put("lastSourceRecordId", 93));
        StationSyncClient.UploadResult ack = StationSyncClient.parseAcknowledgement(
                201,
                ackPayload.toString(),
                false,
                1
        );

        ManualBackfillRepository.acknowledge(context, batch, ack.message);

        List<JSONObject> rows = LocalStationStore.list(context);
        assertEquals(1, rows.size());
        assertEquals("synced", rows.get(0).optString("syncState"));
        assertTrue(OutboxStore.pending(context).isEmpty());
        assertTrue(BackfillTransactionStore.entries(context).isEmpty());
    }

    private FuelStationRecord station() {
        FuelStationRecord station = new FuelStationRecord();
        station.platform = "tuanyou";
        station.stationName = "浙江石油测试加油站";
        station.capturedAt = "2026-07-23T03:30:00Z";
        station.sourceStage = "screen-ocr-auto-scroll";
        station.localParser = "tuanyou-android-ocr";
        station.captureContextId = "fuel-card-1";
        FuelOffer offer = new FuelOffer();
        offer.fuelType = "gasoline";
        offer.gradeCode = "92";
        offer.gradeLabel = "92#";
        offer.listPrice = 7.4d;
        offer.discountPrice = 7.1d;
        offer.discountKind = "explicit";
        offer.capturedAt = station.capturedAt;
        station.fuelOffers.add(offer);
        return station;
    }

    private void clear() {
        context.getSharedPreferences("standalone_ocr_results", Context.MODE_PRIVATE).edit().clear().commit();
        context.getSharedPreferences("standalone_ocr_outbox", Context.MODE_PRIVATE).edit().clear().commit();
        context.getSharedPreferences("standalone_ocr_backfill_drafts", Context.MODE_PRIVATE).edit().clear().commit();
        context.getSharedPreferences("standalone_ocr_backfill_transactions", Context.MODE_PRIVATE)
                .edit().clear().commit();
    }
}
