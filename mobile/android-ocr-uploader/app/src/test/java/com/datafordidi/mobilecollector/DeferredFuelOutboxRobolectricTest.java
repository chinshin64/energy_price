package com.datafordidi.mobilecollector;

import android.content.Context;

import androidx.work.ExistingWorkPolicy;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;

import java.util.Collections;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

@RunWith(RobolectricTestRunner.class)
public class DeferredFuelOutboxRobolectricTest {
    private static final String OUTBOX_PREFS = "standalone_ocr_outbox";
    private Context context;

    @Before
    public void setUp() {
        context = RuntimeEnvironment.getApplication();
        clear();
        BackfillRetryScheduler.setEnqueuerForTests((ignoredContext, ignoredPolicy, request) -> { });
    }

    @After
    public void tearDown() {
        BackfillRetryScheduler.setEnqueuerForTests(null);
        clear();
    }

    @Test
    public void disabledFeatureSurvivesStoreReloadAndNeverReachesUploader() throws Exception {
        JSONObject original = enqueueDeferred("deferred-restart", "deferred-screen");
        String batchId = original.getString("batchId");

        Context reloadedContext = RuntimeEnvironment.getApplication();
        JSONObject reloaded = OutboxStore.findBatch(reloadedContext, batchId);
        assertNotNull(reloaded);
        assertTrue(OutboxStore.isDeferred(reloaded));
        assertEquals(1, OutboxStore.pendingStationCount(reloadedContext));
        assertTrue(OutboxStore.retryablePending(reloadedContext).isEmpty());

        AtomicInteger probes = new AtomicInteger();
        AtomicInteger posts = new AtomicInteger();
        StationUploadProcessor.Summary summary = StationUploadProcessor.drain(
                reloadedContext,
                (app, batch) -> {
                    posts.incrementAndGet();
                    return acknowledgement();
                },
                (app, batch) -> {
                    probes.incrementAndGet();
                    return false;
                }
        );

        assertEquals(1, probes.get());
        assertEquals(0, posts.get());
        assertEquals(0, summary.attempted);
        assertEquals(0, summary.promoted);
        assertTrue(OutboxStore.isDeferred(OutboxStore.findBatch(reloadedContext, batchId)));
    }

    @Test
    public void enabledFeaturePromotesAtomicallyAndUploadsExactlyOnce() throws Exception {
        JSONObject deferred = enqueueDeferred("deferred-enable", "enable-screen");
        String batchId = deferred.getString("batchId");
        AtomicInteger probes = new AtomicInteger();
        AtomicInteger posts = new AtomicInteger();

        StationUploadProcessor.Summary first = StationUploadProcessor.drain(
                context,
                (app, batch) -> {
                    posts.incrementAndGet();
                    assertEquals(batchId, batch.optString("batchId"));
                    assertFalse(OutboxStore.isDeferred(batch));
                    return acknowledgement();
                },
                (app, batch) -> {
                    probes.incrementAndGet();
                    return true;
                }
        );

        assertEquals(1, first.promoted);
        assertEquals(1, first.attempted);
        assertEquals(1, first.succeeded);
        assertEquals(1, probes.get());
        assertEquals(1, posts.get());
        assertTrue(OutboxStore.pending(context).isEmpty());

        StationUploadProcessor.Summary second = StationUploadProcessor.drain(
                context,
                (app, batch) -> {
                    posts.incrementAndGet();
                    return acknowledgement();
                },
                (app, batch) -> {
                    probes.incrementAndGet();
                    return true;
                }
        );
        assertEquals(0, second.attempted);
        assertEquals(1, probes.get());
        assertEquals(1, posts.get());
    }

    @Test
    public void explicitUserRetryRefreshesDeferredWorkImmediately() throws Exception {
        JSONObject deferred = enqueueDeferred("deferred-user-retry", "user-retry-screen");
        AtomicReference<ExistingWorkPolicy> policy = new AtomicReference<>();
        BackfillRetryScheduler.setEnqueuerForTests(
                (ignoredContext, selectedPolicy, request) -> policy.set(selectedPolicy)
        );

        BackfillUploadRunner.uploadAsync(context, deferred.optString("batchId"));

        assertEquals(ExistingWorkPolicy.REPLACE, policy.get());
        assertTrue(OutboxStore.isDeferred(OutboxStore.findBatch(
                context,
                deferred.optString("batchId")
        )));
    }

    @Test
    public void ordinaryFuelChargingAndLegacyReadyBatchesAreNotDeferred() throws Exception {
        FuelStationRecord fuel = ordinaryFuel();
        List<String> fuelKeys = LocalStationStore.upsertFuel(
                context,
                "ordinary-fuel-session",
                1,
                "西安",
                Collections.singletonList(fuel)
        );
        JSONObject fuelBatch = OutboxStore.enqueueFuel(
                context,
                "ordinary-fuel-session",
                1,
                "ordinary-fuel-screen",
                "tuanyou",
                "西安",
                fuelKeys,
                Collections.singletonList(fuel),
                false
        );
        assertFalse(OutboxStore.isDeferred(fuelBatch));

        DidiLocalStationParser.StationRecord charging = new DidiLocalStationParser.StationRecord();
        charging.platform = "didi-charging";
        charging.stationName = "普通充电场站";
        charging.capturedAt = "2026-07-24T09:00:00Z";
        charging.sourceStage = "screen-ocr-user-driven";
        JSONObject chargingBatch = OutboxStore.enqueue(
                context,
                "ordinary-charging-session",
                2,
                "ordinary-charging-screen",
                "didi-charging",
                "西安",
                Collections.singletonList("charging-key"),
                Collections.singletonList(charging)
        );
        assertFalse(OutboxStore.isDeferred(chargingBatch));

        assertEquals(2, OutboxStore.retryablePending(context).size());
        assertTrue(OutboxStore.hasRetryablePending(context));
    }

    @Test
    public void fullQueueRejectsDeferredWithoutOverwritingExistingTasks() throws Exception {
        JSONArray full = new JSONArray();
        for (int index = 0; index < 500; index++) {
            full.put(new JSONObject().put("batchId", "existing-" + index));
        }
        context.getSharedPreferences(OUTBOX_PREFS, Context.MODE_PRIVATE)
                .edit()
                .putString("batches", full.toString())
                .commit();
        FuelStationRecord station = FuelQuoteTest.stationWithQuote();

        try {
            OutboxStore.enqueueFuel(
                    context,
                    "queue-full-session",
                    1,
                    "queue-full-screen",
                    "amap-fuel",
                    "西安",
                    Collections.singletonList("new-local-key"),
                    Collections.singletonList(station),
                    false
            );
            fail("the 501st durable task must be rejected");
        } catch (IllegalStateException expected) {
            assertTrue(expected.getMessage().contains("队列已满"));
        }

        JSONArray retained = new JSONArray(context.getSharedPreferences(
                OUTBOX_PREFS,
                Context.MODE_PRIVATE
        ).getString("batches", "[]"));
        assertEquals(500, retained.length());
        assertEquals("existing-0", retained.getJSONObject(0).getString("batchId"));
        assertTrue(LocalStationStore.list(context).isEmpty());
    }

    private JSONObject enqueueDeferred(String sessionId, String screenHash) throws Exception {
        FuelStationRecord station = FuelQuoteTest.stationWithQuote();
        List<String> keys = LocalStationStore.upsertFuel(
                context,
                sessionId,
                1,
                "西安",
                Collections.singletonList(station)
        );
        JSONObject batch = OutboxStore.enqueueFuel(
                context,
                sessionId,
                1,
                screenHash,
                "amap-fuel",
                "西安",
                keys,
                Collections.singletonList(station),
                false
        );
        assertTrue(OutboxStore.isDeferred(batch));
        assertEquals(FuelQuoteFeatureGate.FEATURE, batch.optString("feature"));
        return batch;
    }

    private static FuelStationRecord ordinaryFuel() {
        FuelStationRecord station = new FuelStationRecord();
        station.platform = "tuanyou";
        station.stationName = "普通价格加油站";
        station.capturedAt = "2026-07-24T08:30:00Z";
        station.sourceStage = "screen-ocr-user-driven";
        station.captureContextId = "ordinary-fuel";
        FuelOffer offer = new FuelOffer();
        offer.gradeCode = "92";
        offer.gradeLabel = "92#";
        offer.listPrice = 7.4d;
        offer.discountPrice = 7.1d;
        offer.capturedAt = station.capturedAt;
        station.fuelOffers.add(offer);
        return station;
    }

    private static StationSyncClient.UploadResult acknowledgement() {
        return new StationSyncClient.UploadResult("已回传 1 条", false, false, "ingest-deferred");
    }

    private void clear() {
        for (String name : new String[]{
                "standalone_ocr_results",
                OUTBOX_PREFS,
                "standalone_ocr_backfill_drafts",
                "standalone_ocr_backfill_transactions",
                "standalone_ocr_settings"
        }) {
            context.getSharedPreferences(name, Context.MODE_PRIVATE).edit().clear().commit();
        }
    }
}
