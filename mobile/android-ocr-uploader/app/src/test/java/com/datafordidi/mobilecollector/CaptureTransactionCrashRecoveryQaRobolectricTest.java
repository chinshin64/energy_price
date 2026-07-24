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

import java.util.Collections;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

@RunWith(RobolectricTestRunner.class)
public class CaptureTransactionCrashRecoveryQaRobolectricTest {
    private static final String CAPTURED_AT = "2026-07-24T02:30:00Z";
    private Context context;

    @Before
    public void setUp() {
        context = RuntimeEnvironment.getApplication();
        clearPersistentState();
        BackfillRetryScheduler.setEnqueuerForTests((ignoredContext, ignoredPolicy, request) -> { });
    }

    @After
    public void tearDown() {
        CaptureTransactionCoordinator.setFailureInjectorForTests(null);
        BackfillRetryScheduler.setEnqueuerForTests(null);
        clearPersistentState();
    }

    @Test
    public void crashAfterJournalReplaysOnceAndRepeatedRecoveryDoesNotDuplicate() {
        assertChargingRecovery(
                CaptureTransactionCoordinator.FailurePoint.AFTER_JOURNAL,
                0,
                0
        );
    }

    @Test
    public void crashAfterLocalReplaysOnceAndRepeatedRecoveryDoesNotDuplicate() {
        assertChargingRecovery(
                CaptureTransactionCoordinator.FailurePoint.AFTER_LOCAL,
                1,
                0
        );
    }

    @Test
    public void crashAfterOutboxReplaysOnceAndRepeatedRecoveryDoesNotDuplicate() {
        assertChargingRecovery(
                CaptureTransactionCoordinator.FailurePoint.AFTER_OUTBOX,
                1,
                1
        );
    }

    @Test
    public void fuelUsesTheSameDurableReplayAndStableIdentities() {
        FuelStationRecord station = fuel("高德测试加油站", "fuel-card");
        CaptureTransactionCoordinator.setFailureInjectorForTests(point -> {
            if (point == CaptureTransactionCoordinator.FailurePoint.AFTER_LOCAL) {
                throw new SimulatedProcessDeath();
            }
        });

        assertThrows(
                SimulatedProcessDeath.class,
                () -> CaptureTransactionCoordinator.commitFuel(
                        context,
                        "fuel-journal-session",
                        8,
                        "fuel-screen-hash",
                        "amap-fuel",
                        "西安",
                        Collections.singletonList(station)
                )
        );
        assertEquals(1, LocalStationStore.list(context).size());
        assertTrue(OutboxStore.pending(context).isEmpty());
        assertEquals(1, CaptureTransactionStore.entries(context).size());

        CaptureTransactionCoordinator.setFailureInjectorForTests(null);
        assertRecoveredOnceThenStable();

        JSONObject local = LocalStationStore.list(context).get(0);
        JSONObject batch = OutboxStore.pending(context).get(0);
        assertEquals("android-ocr-agent", local.optString("sourceAgent"));
        assertEquals(
                OutboxStore.batchId("fuel-journal-session", 8, "fuel-screen-hash"),
                batch.optString("batchId")
        );
        assertEquals(local.optString("localKey"), batch.optJSONArray("localKeys").optString(0));
    }

    @Test
    public void reconcileDoesNotMigrateFortyFiveLegacyRowsWithoutJournal() throws Exception {
        JSONArray legacyRows = new JSONArray();
        for (int index = 0; index < 45; index++) {
            legacyRows.put(new JSONObject()
                    .put("stationName", "历史场站-" + index)
                    .put("platform", "legacy-platform")
                    .put("city", "西安")
                    .put("localKey", "legacy-local-key-" + index)
                    .put("syncState", "local-only"));
        }
        context.getSharedPreferences("standalone_ocr_results", Context.MODE_PRIVATE)
                .edit()
                .putString("results", legacyRows.toString())
                .commit();

        CaptureTransactionCoordinator.ReconcileResult result =
                CaptureTransactionCoordinator.reconcile(context);

        assertEquals(0, result.recovered);
        assertEquals(0, result.remaining);
        assertEquals(45, LocalStationStore.list(context).size());
        assertTrue(OutboxStore.pending(context).isEmpty());
        assertTrue(CaptureTransactionStore.entries(context).isEmpty());
        for (int index = 0; index < 45; index++) {
            assertEquals(
                    "历史场站-" + index,
                    LocalStationStore.list(context).get(index).optString("stationName")
            );
        }
    }

    @Test
    public void acknowledgementClearsJournalAndEvenStaleIntentCannotReviveBatch() {
        CaptureTransactionCoordinator.setFailureInjectorForTests(point -> {
            if (point == CaptureTransactionCoordinator.FailurePoint.AFTER_OUTBOX) {
                throw new SimulatedProcessDeath();
            }
        });
        assertThrows(
                SimulatedProcessDeath.class,
                () -> CaptureTransactionCoordinator.commitCharging(
                        context,
                        "ack-journal-session",
                        9,
                        "ack-screen-hash",
                        "didi-charging",
                        "西安",
                        Collections.singletonList(charging("ACK后不复活测试站", "ack-card"))
                )
        );
        CaptureTransactionStore.Entry staleIntent =
                CaptureTransactionStore.entries(context).get(0);
        JSONObject batch = OutboxStore.pending(context).get(0);

        CaptureTransactionCoordinator.setFailureInjectorForTests(null);
        ManualBackfillRepository.acknowledge(context, batch, "47已落库");

        assertEquals("synced", LocalStationStore.list(context).get(0).optString("syncState"));
        assertTrue(OutboxStore.pending(context).isEmpty());
        assertTrue(CaptureTransactionStore.entries(context).isEmpty());

        CaptureTransactionStore.put(context, staleIntent.id, staleIntent.value);
        CaptureTransactionCoordinator.ReconcileResult result =
                CaptureTransactionCoordinator.reconcile(context);

        assertEquals(1, result.recovered);
        assertEquals(0, result.remaining);
        assertEquals(1, LocalStationStore.list(context).size());
        assertEquals("synced", LocalStationStore.list(context).get(0).optString("syncState"));
        assertTrue(OutboxStore.pending(context).isEmpty());
        assertTrue(CaptureTransactionStore.entries(context).isEmpty());
    }

    private void assertChargingRecovery(
            CaptureTransactionCoordinator.FailurePoint failurePoint,
            int expectedLocalBeforeRecovery,
            int expectedOutboxBeforeRecovery
    ) {
        DidiLocalStationParser.StationRecord station =
                charging("小桔充电西安原子恢复站", "charging-card");
        CaptureTransactionCoordinator.setFailureInjectorForTests(point -> {
            if (point == failurePoint) throw new SimulatedProcessDeath();
        });

        assertThrows(
                SimulatedProcessDeath.class,
                () -> CaptureTransactionCoordinator.commitCharging(
                        context,
                        "charging-journal-session",
                        7,
                        "charging-screen-hash",
                        "didi-charging",
                        "西安",
                        Collections.singletonList(station)
                )
        );

        assertEquals(expectedLocalBeforeRecovery, LocalStationStore.list(context).size());
        assertEquals(expectedOutboxBeforeRecovery, OutboxStore.pending(context).size());
        assertEquals(1, CaptureTransactionStore.entries(context).size());

        CaptureTransactionCoordinator.setFailureInjectorForTests(null);
        assertRecoveredOnceThenStable();

        List<JSONObject> localRows = LocalStationStore.list(context);
        List<JSONObject> batches = OutboxStore.pending(context);
        String expectedBatchId = OutboxStore.batchId(
                "charging-journal-session",
                7,
                "charging-screen-hash"
        );
        String localKey = localRows.get(0).optString("localKey");
        assertEquals("android-ocr-agent", localRows.get(0).optString("sourceAgent"));
        assertEquals(expectedBatchId, batches.get(0).optString("batchId"));
        assertEquals(localKey, batches.get(0).optJSONArray("localKeys").optString(0));

        CaptureTransactionCoordinator.commitCharging(
                context,
                "charging-journal-session",
                7,
                "charging-screen-hash",
                "didi-charging",
                "西安",
                Collections.singletonList(station)
        );
        assertEquals(1, LocalStationStore.list(context).size());
        assertEquals(1, OutboxStore.pending(context).size());
        assertTrue(CaptureTransactionStore.entries(context).isEmpty());
        assertEquals(localKey, LocalStationStore.list(context).get(0).optString("localKey"));
        assertEquals(expectedBatchId, OutboxStore.pending(context).get(0).optString("batchId"));
    }

    private void assertRecoveredOnceThenStable() {
        CaptureTransactionCoordinator.ReconcileResult recovered =
                CaptureTransactionCoordinator.reconcile(context);
        assertEquals(1, recovered.recovered);
        assertEquals(0, recovered.remaining);
        assertEquals(1, LocalStationStore.list(context).size());
        assertEquals(1, OutboxStore.pending(context).size());
        assertTrue(CaptureTransactionStore.entries(context).isEmpty());

        CaptureTransactionCoordinator.ReconcileResult repeated =
                CaptureTransactionCoordinator.reconcile(context);
        assertEquals(0, repeated.recovered);
        assertEquals(0, repeated.remaining);
        assertEquals(1, LocalStationStore.list(context).size());
        assertEquals(1, OutboxStore.pending(context).size());
        assertTrue(CaptureTransactionStore.entries(context).isEmpty());
    }

    private static DidiLocalStationParser.StationRecord charging(String name, String contextId) {
        DidiLocalStationParser.StationRecord station = new DidiLocalStationParser.StationRecord();
        station.platform = "didi-charging";
        station.stationName = name;
        station.address = "陕西省西安市雁塔区测试路7号";
        station.capturedAt = CAPTURED_AT;
        station.sourceStage = "screen-ocr-user-driven";
        station.captureContextId = contextId;
        station.priceFast = 0.85d;
        station.priceObserved = true;
        station.fastIdlePorts = 2;
        station.fastTotalPorts = 5;
        station.portsObserved = true;
        return station;
    }

    private static FuelStationRecord fuel(String name, String contextId) {
        FuelStationRecord station = new FuelStationRecord();
        station.platform = "amap-fuel";
        station.stationName = name;
        station.address = "陕西省西安市雁塔区测试路8号";
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

    private void clearPersistentState() {
        context.getSharedPreferences("standalone_ocr_results", Context.MODE_PRIVATE)
                .edit().clear().commit();
        context.getSharedPreferences("standalone_ocr_outbox", Context.MODE_PRIVATE)
                .edit().clear().commit();
        context.getSharedPreferences(CaptureTransactionStore.PREFS, Context.MODE_PRIVATE)
                .edit().clear().commit();
    }

    private static final class SimulatedProcessDeath extends RuntimeException {
    }
}
