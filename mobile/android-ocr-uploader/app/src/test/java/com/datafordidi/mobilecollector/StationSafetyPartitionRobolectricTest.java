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

import java.util.Arrays;
import java.util.Collections;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

@RunWith(RobolectricTestRunner.class)
public class StationSafetyPartitionRobolectricTest {
    private static final String CAPTURED_AT = "2026-07-24T09:00:00Z";
    private static final String MOCK_PHONE = "138" + "1234" + "5678";
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
    public void chargingMixedBatchUsesOneSafeListForLocalOutboxAndTracker() throws Exception {
        DidiLocalStationParser.StationRecord safe = charging("安全充电场站", "safe-charging");
        DidiLocalStationParser.StationRecord sensitive =
                charging("敏感候选充电场站", "sensitive-charging");
        sensitive.priceEvidence = new JSONArray().put(
                new JSONObject().put("text", "手机号 " + MOCK_PHONE)
        );
        List<DidiLocalStationParser.StationRecord> candidates = Arrays.asList(safe, sensitive);
        StationObservationTracker tracker = new StationObservationTracker();
        List<DidiLocalStationParser.StationRecord> changed = tracker.previewChanged(
                "charging-mixed-session",
                "charging-screen",
                "didi-charging",
                "西安",
                candidates
        );

        StationSafetyPartition.Result<DidiLocalStationParser.StationRecord> partition =
                StationSafetyPartition.charging(changed, "西安");
        assertEquals(1, partition.safe.size());
        assertEquals(1, partition.rejectedCount);
        assertEquals("安全充电场站", partition.safe.get(0).stationName);

        List<String> keys = LocalStationStore.upsert(
                context,
                "charging-mixed-session",
                1,
                "西安",
                partition.safe
        );
        OutboxStore.enqueue(
                context,
                "charging-mixed-session",
                1,
                "charging-mixed-screen",
                "didi-charging",
                "西安",
                keys,
                partition.safe
        );
        tracker.commit(
                "charging-mixed-session",
                "charging-screen",
                "didi-charging",
                "西安",
                partition.safe
        );

        assertOnlySafeStationPersisted("安全充电场站", "敏感候选充电场站");
        List<DidiLocalStationParser.StationRecord> remaining = tracker.previewChanged(
                "charging-mixed-session",
                "charging-screen",
                "didi-charging",
                "西安",
                candidates
        );
        assertEquals(1, remaining.size());
        assertEquals("敏感候选充电场站", remaining.get(0).stationName);
    }

    @Test
    public void fuelMixedBatchRecomputesFeatureAfterRejectedQuoteAndKeepsSafeReady() throws Exception {
        FuelStationRecord safe = ordinaryFuel("安全加油站", "safe-fuel");
        FuelStationRecord sensitive = FuelQuoteTest.stationWithQuote();
        sensitive.stationName = "敏感候选加油站";
        sensitive.captureContextId = "sensitive-fuel";
        sensitive.providerEvidence = new JSONObject()
                .put("kind", "provider-attribution")
                .put("text", "测试服务商 access_token=" + "unsafe_" + "credential_123");
        List<FuelStationRecord> candidates = Arrays.asList(safe, sensitive);
        FuelObservationTracker tracker = new FuelObservationTracker();
        List<FuelStationRecord> changed = tracker.previewChanged(
                "fuel-mixed-session",
                "amap-fuel",
                "西安",
                candidates
        );

        StationSafetyPartition.Result<FuelStationRecord> partition =
                StationSafetyPartition.fuel(changed, "西安");
        assertEquals(1, partition.safe.size());
        assertEquals(1, partition.rejectedCount);
        assertFalse(partition.quoteFeatureRequired);
        assertEquals("安全加油站", partition.safe.get(0).stationName);

        List<String> keys = LocalStationStore.upsertFuel(
                context,
                "fuel-mixed-session",
                2,
                "西安",
                partition.safe
        );
        JSONObject batch = OutboxStore.enqueueFuel(
                context,
                "fuel-mixed-session",
                2,
                "fuel-mixed-screen",
                "amap-fuel",
                "西安",
                keys,
                partition.safe,
                false
        );
        tracker.commit("fuel-mixed-session", "amap-fuel", "西安", partition.safe);

        assertFalse(batch.has("feature"));
        assertFalse(OutboxStore.isDeferred(batch));
        assertOnlySafeStationPersisted("安全加油站", "敏感候选加油站");
        List<FuelStationRecord> remaining = tracker.previewChanged(
                "fuel-mixed-session",
                "amap-fuel",
                "西安",
                candidates
        );
        assertEquals(1, remaining.size());
        assertEquals("敏感候选加油站", remaining.get(0).stationName);
    }

    @Test
    public void allRejectedReturnsSafeEmptyResultWithoutWritingStores() throws Exception {
        DidiLocalStationParser.StationRecord sensitive =
                charging("敏感候选充电场站", "all-rejected");
        sensitive.priceEvidence = new JSONArray().put(
                new JSONObject().put("text", "订单号 DIDI-10003")
        );

        StationSafetyPartition.Result<DidiLocalStationParser.StationRecord> partition =
                StationSafetyPartition.charging(Collections.singletonList(sensitive), "西安");
        assertTrue(partition.allRejected());
        assertTrue(partition.safe.isEmpty());
        assertEquals(1, partition.rejectedCount);
        assertTrue(LocalStationStore.list(context).isEmpty());
        assertTrue(OutboxStore.pending(context).isEmpty());
    }

    private void assertOnlySafeStationPersisted(String safeName, String sensitiveName) {
        List<JSONObject> local = LocalStationStore.list(context);
        assertEquals(1, local.size());
        assertEquals(safeName, local.get(0).optString("stationName"));
        assertFalse(local.get(0).toString().contains(sensitiveName));

        List<JSONObject> pending = OutboxStore.pending(context);
        assertEquals(1, pending.size());
        JSONArray observations = pending.get(0).optJSONArray("observations");
        assertEquals(1, observations == null ? 0 : observations.length());
        JSONObject common = observations == null
                ? null
                : observations.optJSONObject(0).optJSONObject("stationObservation");
        assertEquals(safeName, common == null ? "" : common.optString("stationName"));
        assertFalse(pending.get(0).toString().contains(sensitiveName));
    }

    private static DidiLocalStationParser.StationRecord charging(String name, String contextId) {
        DidiLocalStationParser.StationRecord station = new DidiLocalStationParser.StationRecord();
        station.platform = "didi-charging";
        station.stationName = name;
        station.capturedAt = CAPTURED_AT;
        station.sourceStage = "screen-ocr-user-driven";
        station.captureContextId = contextId;
        station.priceFast = 0.85d;
        station.priceObserved = true;
        station.fastIdlePorts = 2;
        station.fastTotalPorts = 4;
        station.portsObserved = true;
        return station;
    }

    private static FuelStationRecord ordinaryFuel(String name, String contextId) {
        FuelStationRecord station = new FuelStationRecord();
        station.platform = "amap-fuel";
        station.stationName = name;
        station.capturedAt = CAPTURED_AT;
        station.sourceStage = "screen-ocr-user-driven";
        station.localParser = "amap-fuel-android-ocr";
        station.captureContextId = contextId;
        FuelOffer offer = new FuelOffer();
        offer.fuelType = "gasoline";
        offer.gradeCode = "92";
        offer.gradeLabel = "92#汽油";
        offer.listPrice = 7.86d;
        offer.discountPrice = 6.63d;
        offer.discountKind = "explicit";
        offer.capturedAt = CAPTURED_AT;
        station.fuelOffers.add(offer);
        return station;
    }

    private void clear() {
        context.getSharedPreferences("standalone_ocr_results", Context.MODE_PRIVATE)
                .edit().clear().commit();
        context.getSharedPreferences("standalone_ocr_outbox", Context.MODE_PRIVATE)
                .edit().clear().commit();
    }
}
