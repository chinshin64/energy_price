package com.datafordidi.mobilecollector;

import android.content.Context;

import androidx.work.testing.WorkManagerTestInitHelper;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;

import java.util.Collections;
import java.util.Arrays;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

@RunWith(RobolectricTestRunner.class)
public class FuelQuotePersistenceRobolectricTest {
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
    public void quoteIsSavedInDurableDeferredOutboxUntilFeatureIsEnabled() throws Exception {
        FuelStationRecord station = FuelQuoteTest.stationWithQuote();
        List<String> keys = LocalStationStore.upsertFuel(
                context,
                "quote-session",
                1,
                "西安",
                Collections.singletonList(station)
        );
        assertEquals(1, LocalStationStore.list(context).size());
        JSONObject deferred = OutboxStore.enqueueFuel(
                context,
                "quote-session",
                1,
                "quote-screen",
                "amap-fuel",
                "西安",
                keys,
                Collections.singletonList(station),
                false
        );
        assertTrue(OutboxStore.isDeferred(deferred));
        assertEquals(1, OutboxStore.pending(context).size());
        assertTrue(OutboxStore.retryablePending(context).isEmpty());

        JSONObject batch = OutboxStore.enqueueFuel(
                context,
                "quote-session",
                1,
                "quote-screen",
                "amap-fuel",
                "西安",
                keys,
                Collections.singletonList(station),
                true
        );
        assertFalse(OutboxStore.isDeferred(batch));
        assertEquals(deferred.optString("batchId"), batch.optString("batchId"));
        assertEquals(FuelQuoteFeatureGate.FEATURE, batch.optString("feature"));
        JSONArray observations = batch.optJSONArray("observations");
        assertEquals(1, observations.length());
        JSONObject observation = observations.optJSONObject(0);
        assertFalse(observation.has("feature"));
        JSONObject fuel = observation.optJSONObject("fuelObservation");
        assertEquals("测试服务商", fuel.optString("providerName"));
        assertEquals(1, fuel.optJSONArray("fuelQuotes").length());
        assertTrue(observation.getJSONObject("stationObservation").isNull("address"));
        assertTrue(observation.getJSONObject("stationObservation").isNull("availablePorts"));
    }

    @Test
    public void mixedFuelBatchPromotesEveryObservationToTheBatchFeatureContract() throws Exception {
        FuelStationRecord quoteStation = FuelQuoteTest.stationWithQuote();
        FuelStationRecord legacyStation = new FuelStationRecord();
        legacyStation.platform = "amap-fuel";
        legacyStation.stationName = "普通价格加油站";
        legacyStation.captureContextId = "legacy-station-key";
        legacyStation.capturedAt = "2026-07-23T12:00:01Z";
        legacyStation.sourceStage = "screen-ocr-user-driven";
        legacyStation.localParser = "amap-fuel-android-ocr";
        FuelOffer legacyOffer = new FuelOffer();
        legacyOffer.gradeCode = "95";
        legacyOffer.gradeLabel = "95#汽油";
        legacyOffer.listPrice = 8.1d;
        legacyOffer.discountPrice = 7.8d;
        legacyOffer.capturedAt = legacyStation.capturedAt;
        legacyStation.fuelOffers.add(legacyOffer);
        List<FuelStationRecord> stations = Arrays.asList(quoteStation, legacyStation);
        List<String> keys = LocalStationStore.upsertFuel(
                context, "mixed-session", 1, "西安", stations
        );

        JSONObject batch = OutboxStore.enqueueFuel(
                context,
                "mixed-session",
                1,
                "mixed-screen",
                "amap-fuel",
                "西安",
                keys,
                stations,
                true
        );

        assertEquals(FuelQuoteFeatureGate.FEATURE, batch.optString("feature"));
        JSONArray observations = batch.optJSONArray("observations");
        assertEquals(2, observations.length());
        for (int index = 0; index < observations.length(); index++) {
            JSONObject observation = observations.optJSONObject(index);
            assertFalse(observation.has("feature"));
            JSONObject fuel = observation.optJSONObject("fuelObservation");
            assertFalse(fuel.optString("sourceStationKey").isEmpty());
            assertTrue(fuel.has("providerName"));
            assertTrue(fuel.has("providerEvidence"));
            assertTrue(fuel.has("fuelQuotes"));
        }
        ObservationEnvelope.requireValidBatch(batch);
    }

    @Test
    public void strictAckRetainsLocalAndClearsQuoteOutboxForOrdinaryCapture() throws Exception {
        FuelStationRecord station = FuelQuoteTest.stationWithQuote();
        List<String> keys = LocalStationStore.upsertFuel(
                context,
                "quote-session",
                2,
                "西安",
                Collections.singletonList(station)
        );
        JSONObject batch = OutboxStore.enqueueFuel(
                context,
                "quote-session",
                2,
                "quote-screen-2",
                "amap-fuel",
                "西安",
                keys,
                Collections.singletonList(station),
                true
        );
        JSONObject data = new JSONObject()
                .put("persisted", true)
                .put("sourceNode", "47-mysql")
                .put("sourceAgent", LocalStationStore.SOURCE_AGENT)
                .put("acceptedCount", 1)
                .put("acceptedStationCount", 1)
                .put("acceptedQuoteCount", 1)
                .put("ingestId", "quote-ingest")
                .put("firstSourceRecordId", 201)
                .put("lastSourceRecordId", 201);
        StationSyncClient.UploadResult ack = StationSyncClient.parseAcknowledgement(
                201,
                new JSONObject().put("success", true).put("data", data).toString(),
                false,
                1,
                true,
                1
        );

        ManualBackfillRepository.acknowledge(context, batch, ack.message);

        List<JSONObject> local = LocalStationStore.list(context);
        assertEquals(1, local.size());
        assertEquals("synced", local.get(0).optString("syncState"));
        assertTrue(OutboxStore.pending(context).isEmpty());
    }

    @Test
    public void manualFuelBackfillPreservesProviderThreePricesQuotesAndFeatureMarker() throws Exception {
        FuelStationRecord station = FuelQuoteTest.stationWithQuote();
        LocalStationStore.upsertFuel(
                context,
                "quote-session",
                3,
                "西安",
                Collections.singletonList(station)
        );
        JSONObject source = LocalStationStore.list(context).get(0);
        ManualBackfillDraftStore.State state = ManualBackfillDraftStore.getOrCreate(context, source);
        state.fuelDraft.grades.get(0).discountPrice = "6.62";

        ManualBackfillRepository.SaveResult saved = ManualBackfillRepository.save(context, state);

        assertTrue(saved.saved);
        JSONObject batch = OutboxStore.findBatch(context, saved.batchId);
        assertEquals(FuelQuoteFeatureGate.FEATURE, batch.optString("feature"));
        assertTrue(OutboxStore.isDeferred(batch));
        assertTrue(OutboxStore.retryablePending(context).isEmpty());
        JSONObject observation = batch.optJSONArray("observations").optJSONObject(0);
        JSONObject fuel = observation.optJSONObject("fuelObservation");
        assertEquals("测试服务商", fuel.optString("providerName"));
        assertEquals(1, fuel.optJSONArray("fuelQuotes").length());
        JSONObject offer = fuel.optJSONArray("fuelOffers").optJSONObject(0);
        assertEquals("6.63", offer.optString("displayPrice"));
        assertEquals("7.86", offer.optString("stationPrice"));
        assertEquals("8.12", offer.optString("nationalPrice"));
        assertEquals(6.62d, offer.optDouble("discountPrice"), 0.00001d);
        ObservationEnvelope.requireValidBatch(batch);
    }

    private void clear() {
        for (String name : new String[]{
                "standalone_ocr_results",
                "standalone_ocr_outbox",
                "standalone_ocr_backfill_drafts",
                "standalone_ocr_backfill_transactions"
        }) {
            context.getSharedPreferences(name, Context.MODE_PRIVATE).edit().clear().commit();
        }
    }
}
