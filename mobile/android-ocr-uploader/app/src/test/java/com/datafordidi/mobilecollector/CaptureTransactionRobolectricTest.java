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
import org.robolectric.annotation.Config;

import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
public class CaptureTransactionRobolectricTest {
    private Context context;

    @Before
    public void setUp() {
        context = RuntimeEnvironment.getApplication();
        clear();
        BackfillRetryScheduler.setEnqueuerForTests((ignoredContext, ignoredPolicy, request) -> { });
    }

    @After
    public void tearDown() {
        CaptureTransactionCoordinator.setFailureInjectorForTests(null);
        BackfillRetryScheduler.setEnqueuerForTests(null);
        clear();
    }

    @Test
    public void restartAfterJournalRecoversChargingLocalAndOutbox() {
        expectCrashAt(CaptureTransactionCoordinator.FailurePoint.AFTER_JOURNAL, () ->
                CaptureTransactionCoordinator.commitCharging(
                        context,
                        "session-journal",
                        1,
                        "screen-journal",
                        "didi-charging",
                        "西安",
                        Collections.singletonList(charging("journal"))
                )
        );

        assertEquals(1, CaptureTransactionStore.entries(context).size());
        assertTrue(LocalStationStore.list(context).isEmpty());
        assertTrue(OutboxStore.pending(context).isEmpty());

        CaptureTransactionCoordinator.setFailureInjectorForTests(null);
        CaptureTransactionCoordinator.ReconcileResult recovered =
                CaptureTransactionCoordinator.reconcile(context);

        assertEquals(1, recovered.recovered);
        assertEquals(0, recovered.remaining);
        assertEquals(1, LocalStationStore.list(context).size());
        assertEquals(1, OutboxStore.pending(context).size());
        assertTrue(CaptureTransactionStore.entries(context).isEmpty());
    }

    @Test
    public void restartAfterLocalWriteAddsOnlyMissingOutboxWithoutDuplicatingLocal() {
        expectCrashAt(CaptureTransactionCoordinator.FailurePoint.AFTER_LOCAL, () ->
                CaptureTransactionCoordinator.commitCharging(
                        context,
                        "session-local",
                        2,
                        "screen-local",
                        "amap-charging",
                        "武汉",
                        Collections.singletonList(charging("local"))
                )
        );

        assertEquals(1, LocalStationStore.list(context).size());
        assertTrue(OutboxStore.pending(context).isEmpty());
        assertEquals(1, CaptureTransactionStore.entries(context).size());

        CaptureTransactionCoordinator.setFailureInjectorForTests(null);
        CaptureTransactionCoordinator.reconcile(context);
        CaptureTransactionCoordinator.reconcile(context);

        assertEquals(1, LocalStationStore.list(context).size());
        assertEquals(1, OutboxStore.pending(context).size());
        assertTrue(CaptureTransactionStore.entries(context).isEmpty());
    }

    @Test
    public void restartAfterOutboxWriteOnlyFinalizesJournal() {
        expectCrashAt(CaptureTransactionCoordinator.FailurePoint.AFTER_OUTBOX, () ->
                CaptureTransactionCoordinator.commitCharging(
                        context,
                        "session-outbox",
                        3,
                        "screen-outbox",
                        "didi-charging",
                        "西安",
                        Collections.singletonList(charging("outbox"))
                )
        );

        assertEquals(1, LocalStationStore.list(context).size());
        assertEquals(1, OutboxStore.pending(context).size());
        assertEquals(1, CaptureTransactionStore.entries(context).size());

        CaptureTransactionCoordinator.setFailureInjectorForTests(null);
        CaptureTransactionCoordinator.reconcile(context);

        assertEquals(1, LocalStationStore.list(context).size());
        assertEquals(1, OutboxStore.pending(context).size());
        assertTrue(CaptureTransactionStore.entries(context).isEmpty());
    }

    @Test
    public void ordinaryFuelRestartRecoveryPreservesDeferredRulesWithoutEnablingFeature() {
        expectCrashAt(CaptureTransactionCoordinator.FailurePoint.AFTER_LOCAL, () ->
                CaptureTransactionCoordinator.commitFuel(
                        context,
                        "fuel-session",
                        4,
                        "fuel-screen",
                        "tuanyou",
                        "杭州",
                        Collections.singletonList(fuel())
                )
        );

        assertEquals(1, LocalStationStore.list(context).size());
        assertTrue(OutboxStore.pending(context).isEmpty());

        CaptureTransactionCoordinator.setFailureInjectorForTests(null);
        CaptureTransactionCoordinator.reconcile(context);

        JSONObject batch = OutboxStore.pending(context).get(0);
        assertEquals("fuel", batch.optString("stationType"));
        assertFalse(batch.has("feature"));
        assertFalse(OutboxStore.isDeferred(batch));
        assertTrue(CaptureTransactionStore.entries(context).isEmpty());
    }

    @Test
    public void acknowledgedBatchCannotBeRevivedByResidualJournal() {
        expectCrashAt(CaptureTransactionCoordinator.FailurePoint.AFTER_OUTBOX, () ->
                CaptureTransactionCoordinator.commitCharging(
                        context,
                        "session-ack",
                        5,
                        "screen-ack",
                        "didi-charging",
                        "西安",
                        Collections.singletonList(charging("ack"))
                )
        );
        CaptureTransactionCoordinator.setFailureInjectorForTests(null);
        CaptureTransactionStore.Entry residual = CaptureTransactionStore.entries(context).get(0);
        JSONObject batch = OutboxStore.pending(context).get(0);

        ManualBackfillRepository.acknowledge(context, batch, "47已落库");

        assertEquals("synced", LocalStationStore.list(context).get(0).optString("syncState"));
        assertTrue(OutboxStore.pending(context).isEmpty());
        assertTrue(CaptureTransactionStore.entries(context).isEmpty());

        CaptureTransactionStore.put(context, residual.id, residual.value);
        CaptureTransactionCoordinator.reconcile(context);

        assertEquals(1, LocalStationStore.list(context).size());
        assertEquals("synced", LocalStationStore.list(context).get(0).optString("syncState"));
        assertTrue(OutboxStore.pending(context).isEmpty());
        assertTrue(CaptureTransactionStore.entries(context).isEmpty());
    }

    @Test
    public void repeatedAcknowledgedCaptureDoesNotRegressSyncedState() {
        CaptureTransactionCoordinator.CommitResult first =
                CaptureTransactionCoordinator.commitCharging(
                        context,
                        "session-repeat",
                        8,
                        "screen-repeat",
                        "didi-charging",
                        "西安",
                        Collections.singletonList(charging("repeat"))
                );
        assertEquals(1, first.localKeys.size());
        JSONObject batch = OutboxStore.pending(context).get(0);
        ManualBackfillRepository.acknowledge(context, batch, "47已落库");

        CaptureTransactionCoordinator.CommitResult repeated =
                CaptureTransactionCoordinator.commitCharging(
                        context,
                        "session-repeat",
                        8,
                        "screen-repeat",
                        "didi-charging",
                        "西安",
                        Collections.singletonList(charging("repeat"))
                );
        LocalStationStore.markSync(
                context,
                repeated.localKeys,
                "pending",
                "等待回传"
        );

        assertTrue(repeated.localKeys.isEmpty());
        assertEquals(1, LocalStationStore.list(context).size());
        assertEquals("synced", LocalStationStore.list(context).get(0).optString("syncState"));
        assertTrue(OutboxStore.pending(context).isEmpty());
        assertTrue(CaptureTransactionStore.entries(context).isEmpty());
    }

    @Test
    public void fullOutboxCreatesNoNewLocalSnapshotOrJournal() throws Exception {
        JSONArray full = new JSONArray();
        for (int index = 0; index < 500; index++) {
            full.put(new JSONObject().put("batchId", "occupied-" + index));
        }
        context.getSharedPreferences("standalone_ocr_outbox", Context.MODE_PRIVATE)
                .edit()
                .putString("batches", full.toString())
                .commit();

        try {
            CaptureTransactionCoordinator.commitCharging(
                    context,
                    "session-full",
                    6,
                    "screen-full",
                    "didi-charging",
                    "西安",
                    Collections.singletonList(charging("full"))
            );
            fail("full outbox must reject the transaction");
        } catch (IllegalStateException expected) {
            assertEquals("回传队列已满", expected.getMessage());
        }

        assertTrue(LocalStationStore.list(context).isEmpty());
        assertTrue(CaptureTransactionStore.entries(context).isEmpty());
        assertEquals(500, new JSONArray(context
                .getSharedPreferences("standalone_ocr_outbox", Context.MODE_PRIVATE)
                .getString("batches", "[]")).length());
    }

    @Test
    public void committingNewSnapshotLeavesFortyFiveLegacyRowsUntouched() throws Exception {
        JSONArray legacy = new JSONArray();
        Set<String> names = new HashSet<>();
        for (int index = 0; index < 45; index++) {
            String name = "历史场站" + index;
            names.add(name);
            legacy.put(new JSONObject()
                    .put("stationName", name)
                    .put("platform", "legacy")
                    .put("city", "西安")
                    .put("localKey", "legacy-" + index)
                    .put("syncState", "local-only"));
        }
        context.getSharedPreferences("standalone_ocr_results", Context.MODE_PRIVATE)
                .edit()
                .putString("results", legacy.toString())
                .commit();

        CaptureTransactionCoordinator.CommitResult committed =
                CaptureTransactionCoordinator.commitCharging(
                        context,
                        "session-compatible",
                        7,
                        "screen-compatible",
                        "didi-charging",
                        "西安",
                        Collections.singletonList(charging("compatible"))
                );

        assertNotNull(committed);
        List<JSONObject> rows = LocalStationStore.list(context);
        assertEquals(46, rows.size());
        Set<String> after = new HashSet<>();
        for (JSONObject row : rows) after.add(row.optString("stationName"));
        assertTrue(after.containsAll(names));
        assertEquals(1, OutboxStore.pending(context).size());
    }

    private void expectCrashAt(
            CaptureTransactionCoordinator.FailurePoint expectedPoint,
            Runnable action
    ) {
        CaptureTransactionCoordinator.setFailureInjectorForTests(point -> {
            if (point == expectedPoint) throw new SimulatedProcessDeath(point.name());
        });
        try {
            action.run();
            fail("expected simulated process death at " + expectedPoint);
        } catch (SimulatedProcessDeath expected) {
            assertEquals(expectedPoint.name(), expected.getMessage());
        }
    }

    private DidiLocalStationParser.StationRecord charging(String suffix) {
        DidiLocalStationParser.StationRecord station = new DidiLocalStationParser.StationRecord();
        station.platform = "didi-charging";
        station.stationName = "事务测试充电站-" + suffix;
        station.address = "西安市高新区科技一路" + Math.abs(suffix.hashCode() % 100) + "号";
        station.capturedAt = "2026-07-24T03:00:00.000Z";
        station.sourceStage = "screen-ocr-auto-scroll";
        station.localParser = "transaction-test";
        station.captureContextId = "card-" + suffix;
        station.portsObserved = true;
        station.fastIdlePorts = 2;
        station.fastTotalPorts = 4;
        station.priceFast = 0.88d;
        station.priceObserved = true;
        return station;
    }

    private FuelStationRecord fuel() {
        FuelStationRecord station = new FuelStationRecord();
        station.platform = "tuanyou";
        station.stationName = "事务测试加油站";
        station.address = "杭州市西湖区文一路18号";
        station.capturedAt = "2026-07-24T03:10:00.000Z";
        station.sourceStage = "screen-ocr-user-driven";
        station.localParser = "transaction-fuel-test";
        station.captureContextId = "fuel-card";
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
        for (String name : new String[]{
                "standalone_ocr_results",
                "standalone_ocr_outbox",
                CaptureTransactionStore.PREFS,
                "standalone_ocr_backfill_transactions",
                "standalone_ocr_backfill_drafts",
                "standalone_ocr_settings"
        }) {
            context.getSharedPreferences(name, Context.MODE_PRIVATE).edit().clear().commit();
        }
    }

    private static final class SimulatedProcessDeath extends RuntimeException {
        SimulatedProcessDeath(String message) {
            super(message);
        }
    }
}
