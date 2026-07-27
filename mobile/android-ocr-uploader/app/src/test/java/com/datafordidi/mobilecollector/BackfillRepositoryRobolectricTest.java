package com.datafordidi.mobilecollector;

import android.content.Context;

import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkInfo;
import androidx.work.WorkManager;
import androidx.work.ExistingWorkPolicy;
import androidx.work.testing.WorkManagerTestInitHelper;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

import java.io.IOException;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.concurrent.Executor;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
public class BackfillRepositoryRobolectricTest {
    private Context context;

    @Before
    public void setUp() {
        context = RuntimeEnvironment.getApplication();
        for (String name : new String[]{
                "standalone_ocr_results",
                "standalone_ocr_outbox",
                "standalone_ocr_backfill_drafts",
                "standalone_ocr_backfill_transactions",
                "standalone_ocr_settings",
                "standalone_ocr_outbox_recovery"
        }) {
            context.getSharedPreferences(name, Context.MODE_PRIVATE).edit().clear().commit();
        }
        BackfillRetryScheduler.setEnqueuerForTests((ignoredContext, ignoredPolicy, request) -> { });
    }

    @After
    public void tearDown() {
        BackfillRetryScheduler.setEnqueuerForTests(null);
    }

    @Test
    public void strictAcknowledgeDeletesAllPhoneSnapshotsAndJournal() throws Exception {
        Saved saved = save("场站A", "ctx-a", 2, 8);
        StationSyncClient.UploadResult ack = StationSyncClient.parseAcknowledgement(
                201, acknowledgement("ingest-a", 101), true, 1
        );

        ManualBackfillRepository.acknowledge(context, saved.batch, ack.message);

        assertTrue(LocalStationStore.list(context).isEmpty());
        assertTrue(OutboxStore.pending(context).isEmpty());
        assertNull(ManualBackfillDraftStore.find(context, saved.identity));
        assertTrue(BackfillTransactionStore.entries(context).isEmpty());
    }

    @Test
    public void deleteJournalRecoversAfterLocalDeleteBeforeOutboxDelete() throws Exception {
        Saved saved = save("场站A", "ctx-a", 2, 8);
        JSONObject metadata = saved.batch.getJSONObject("manualBackfill");
        JSONObject operation = new JSONObject()
                .put("type", "delete")
                .put("stableIdentity", saved.identity)
                .put("batchId", saved.batch.getString("batchId"))
                .put("editId", metadata.getString("editId"))
                .put("revision", metadata.getInt("revision"));
        BackfillTransactionStore.put(context, "delete-interrupted", operation);
        LocalStationStore.removeStableIdentity(context, saved.identity);

        assertFalse(OutboxStore.pending(context).isEmpty());
        assertEquals(1, BackfillTransactionStore.entries(context).size());
        ManualBackfillRepository.reconcile(context);

        assertTrue(LocalStationStore.list(context).isEmpty());
        assertTrue(OutboxStore.pending(context).isEmpty());
        assertNull(ManualBackfillDraftStore.find(context, saved.identity));
        assertTrue(BackfillTransactionStore.entries(context).isEmpty());
    }

    @Test
    public void staleAckKeepsEditableRevisionTwoInRealStores() throws Exception {
        Saved first = save("场站A", "ctx-a", 2, 8);
        ManualBackfillDraftStore.State state = ManualBackfillDraftStore.find(context, first.identity);
        assertNotNull(state);
        state.open = true;
        state.draft.fastTotal = "9";
        ManualBackfillDraftStore.save(context, state);
        ManualBackfillRepository.SaveResult second = ManualBackfillRepository.save(context, state);
        JSONObject revisionTwoBatch = OutboxStore.findBatch(context, second.batchId);

        ManualBackfillRepository.acknowledge(context, first.batch, "旧ACK");

        assertNotNull(OutboxStore.findBatch(context, second.batchId));
        assertEquals(2, revisionTwoBatch.getJSONObject("manualBackfill").getInt("revision"));
        List<JSONObject> rows = LocalStationStore.list(context);
        JSONObject visible = StationResultPresenter.latestByStableIdentity(rows).get(0);
        assertTrue(StationDisplayFormatter.canEditBackfill(visible));
        assertEquals(9, visible.getInt("fastTotalPorts"));
    }

    @Test
    public void sharedPreferencesDraftRestoresEveryTypedField() throws Exception {
        JSONObject source = source("场站A", "ctx-a");
        ManualBackfillDraftStore.State state = ManualBackfillDraftStore.getOrCreate(context, source);
        state.draft.fastIdle = "3";
        state.draft.fastTotal = "9";
        state.draft.slowIdle = "1";
        state.draft.slowTotal = "2";
        state.open = true;
        ManualBackfillDraftStore.save(context, state);

        ManualBackfillDraftStore.State restored = ManualBackfillDraftStore.findOpen(context);
        assertNotNull(restored);
        assertEquals("3", restored.draft.fastIdle);
        assertEquals("9", restored.draft.fastTotal);
        assertEquals("1", restored.draft.slowIdle);
        assertEquals("2", restored.draft.slowTotal);
    }

    @Test
    public void workerProcessorContinuesAfterOneBatchFails() throws Exception {
        Saved failed = save("场站A", "ctx-a", 2, 8);
        Saved succeeded = save("场站B", "ctx-b", 1, 4);
        StationUploadProcessor.Summary summary = StationUploadProcessor.drain(context, (app, batch) -> {
            String name = batch.getJSONArray("observations").getJSONObject(0)
                    .getJSONObject("stationObservation").getString("stationName");
            if ("场站A".equals(name)) throw new IllegalStateException("离线");
            return new StationSyncClient.UploadResult("已回传 1 条", true, false, "ingest-b");
        });

        assertEquals(2, summary.attempted);
        assertEquals(1, summary.succeeded);
        assertEquals(1, summary.failed);
        assertEquals(1, summary.retryableFailed);
        assertEquals(0, summary.manualReview);
        assertNotNull(OutboxStore.findBatch(context, failed.batch.getString("batchId")));
        assertNull(OutboxStore.findBatch(context, succeeded.batch.getString("batchId")));
    }

    @Test
    public void permanentFailureIsRetainedForManualReviewAndNotDrainedAgain() throws Exception {
        Saved saved = save("场站协议冲突", "ctx-conflict", 2, 8);

        StationUploadProcessor.Summary first = StationUploadProcessor.drain(
                context,
                (app, batch) -> {
                    throw UploadFailure.forHttpStatus(409);
                }
        );

        assertEquals(1, first.attempted);
        assertEquals(0, first.retryableFailed);
        assertEquals(1, first.manualReview);
        JSONObject retained = OutboxStore.findBatch(context, saved.batch.getString("batchId"));
        assertNotNull(retained);
        assertTrue(OutboxStore.requiresManualReview(retained));
        assertTrue(OutboxStore.retryablePending(context).isEmpty());
        assertEquals("manual-review", LocalStationStore.list(context).get(0).optString("syncState"));

        StationUploadProcessor.Summary second = StationUploadProcessor.drain(
                context,
                (app, batch) -> {
                    throw new AssertionError("manual-review batch must not upload automatically");
                }
        );
        assertEquals(0, second.attempted);
        assertNotNull(OutboxStore.findBatch(context, saved.batch.getString("batchId")));
    }

    @Test
    public void transientNetworkFailureRemainsInAutomaticRetryQueue() throws Exception {
        Saved saved = save("场站网络重试", "ctx-network", 1, 4);

        StationUploadProcessor.Summary summary = StationUploadProcessor.drain(
                context,
                (app, batch) -> {
                    throw new IOException("offline");
                }
        );

        assertEquals(1, summary.retryableFailed);
        assertEquals(0, summary.manualReview);
        JSONObject retained = OutboxStore.findBatch(context, saved.batch.getString("batchId"));
        assertNotNull(retained);
        assertFalse(OutboxStore.requiresManualReview(retained));
        assertEquals(1, OutboxStore.retryablePending(context).size());
        assertEquals("failed", LocalStationStore.list(context).get(0).optString("syncState"));
    }

    @Test
    public void schedulerDoesNotEnqueueWorkForManualReviewOnlyQueue() throws Exception {
        Saved saved = save("场站人工处理", "ctx-manual", 1, 4);
        OutboxStore.markFailed(
                context,
                saved.batch.getString("batchId"),
                "HTTP 422",
                UploadFailure.Disposition.MANUAL_REVIEW
        );
        AtomicInteger scheduled = new AtomicInteger();
        BackfillRetryScheduler.setEnqueuerForTests(
                (ignoredContext, ignoredPolicy, request) -> scheduled.incrementAndGet()
        );

        BackfillRetryScheduler.schedule(context);

        assertEquals(0, scheduled.get());
        assertEquals(1, OutboxStore.pending(context).size());
    }

    @Test
    public void appUpgradeRequeuesValidatedLegacyHttp400OnlyOnce() throws Exception {
        Saved saved = save("场站历史400", "ctx-legacy-400", 1, 4);
        String batchId = saved.batch.getString("batchId");
        OutboxStore.markFailed(
                context,
                batchId,
                "HTTP 400",
                UploadFailure.Disposition.MANUAL_REVIEW
        );
        assertEquals(1, OutboxRecoveryPolicy.recoverAfterUpgrade(context, true, 25));
        JSONObject recovered = OutboxStore.findBatch(context, batchId);
        assertNotNull(recovered);
        assertFalse(OutboxStore.requiresManualReview(recovered));
        assertEquals(0, recovered.optInt("attempts", -1));

        OutboxStore.markFailed(
                context,
                batchId,
                "HTTP 400",
                UploadFailure.Disposition.MANUAL_REVIEW
        );
        assertEquals(0, OutboxRecoveryPolicy.recoverAfterUpgrade(context, true, 25));
        assertTrue(OutboxStore.requiresManualReview(OutboxStore.findBatch(context, batchId)));
    }

    @Test
    public void recoveryKeepsInvalidAndNonLegacyManualReviewBatches() throws Exception {
        Saved invalid = save("场站非法历史数据", "ctx-invalid", 1, 4);
        Saved permanent = save("场站明确拒绝", "ctx-permanent", 1, 4);
        OutboxStore.markFailed(
                context,
                invalid.batch.getString("batchId"),
                "HTTP 400",
                UploadFailure.Disposition.MANUAL_REVIEW
        );
        OutboxStore.markFailed(
                context,
                permanent.batch.getString("batchId"),
                "HTTP 422 field_required",
                UploadFailure.Disposition.MANUAL_REVIEW
        );
        JSONArray raw = new JSONArray(context.getSharedPreferences(
                "standalone_ocr_outbox",
                Context.MODE_PRIVATE
        ).getString("batches", "[]"));
        for (int index = 0; index < raw.length(); index++) {
            JSONObject batch = raw.getJSONObject(index);
            if (!invalid.batch.getString("batchId").equals(batch.optString("batchId"))) continue;
            batch.getJSONArray("observations")
                    .getJSONObject(0)
                    .getJSONObject("stationObservation")
                    .remove("stationName");
        }
        context.getSharedPreferences("standalone_ocr_outbox", Context.MODE_PRIVATE)
                .edit()
                .putString("batches", raw.toString())
                .commit();

        assertEquals(0, OutboxStore.requeueValidatedLegacyHttp400(context));
        JSONArray retained = new JSONArray(context.getSharedPreferences(
                "standalone_ocr_outbox",
                Context.MODE_PRIVATE
        ).getString("batches", "[]"));
        assertEquals(2, retained.length());
        for (int index = 0; index < retained.length(); index++) {
            assertEquals("manual-review", retained.getJSONObject(index)
                    .optString("failureDisposition"));
        }
    }

    @Test
    public void activityStartHookSchedulesConnectedUniqueWorker() throws Exception {
        AtomicInteger scheduled = new AtomicInteger();
        BackfillRetryScheduler.setEnqueuerForTests(
                (ignoredContext, ignoredPolicy, request) -> scheduled.incrementAndGet()
        );
        save("场站A", "ctx-a", 2, 8);
        scheduled.set(0);
        MainActivity.schedulePendingUploads(context);
        assertTrue(scheduled.get() >= 1);

        OneTimeWorkRequest request = BackfillRetryScheduler.createRequest();
        assertEquals(NetworkType.CONNECTED, request.getWorkSpec().constraints.getRequiredNetworkType());
        assertTrue(request.getTags().contains(BackfillRetryScheduler.UNIQUE_WORK_NAME));
    }

    @Test
    public void workManagerKeepsOnePersistentUniqueRequestAcrossRepeatedSchedules() throws Exception {
        Executor direct = Runnable::run;
        androidx.work.Configuration configuration = new androidx.work.Configuration.Builder()
                .setExecutor(direct)
                .setTaskExecutor(direct)
                .build();
        WorkManagerTestInitHelper.initializeTestWorkManager(context, configuration);
        save("场站A", "ctx-a", 2, 8);
        BackfillRetryScheduler.setEnqueuerForTests(null);

        BackfillRetryScheduler.schedule(context);
        BackfillRetryScheduler.schedule(context);

        List<WorkInfo> work = WorkManager.getInstance(context)
                .getWorkInfosForUniqueWork(BackfillRetryScheduler.UNIQUE_WORK_NAME)
                .get();
        assertEquals(1, work.size());
        assertTrue(work.get(0).getTags().contains(BackfillRetryScheduler.UNIQUE_WORK_NAME));
    }

    @Test
    public void provisioningResetReplacesBackoffWhileOrdinaryScheduleKeepsIt() throws Exception {
        AtomicReference<ExistingWorkPolicy> policy = new AtomicReference<>();
        AtomicReference<OneTimeWorkRequest> request = new AtomicReference<>();
        BackfillRetryScheduler.setEnqueuerForTests((ignoredContext, selectedPolicy, selectedRequest) -> {
            policy.set(selectedPolicy);
            request.set(selectedRequest);
        });
        save("场站A", "ctx-a", 2, 8);

        BackfillRetryScheduler.schedule(context);
        assertEquals(ExistingWorkPolicy.KEEP, policy.get());
        assertEquals(
                NetworkType.CONNECTED,
                request.get().getWorkSpec().constraints.getRequiredNetworkType()
        );

        BackfillRetryScheduler.resetAfterProvisioning(context);
        assertEquals(ExistingWorkPolicy.REPLACE, policy.get());
        assertEquals(
                NetworkType.CONNECTED,
                request.get().getWorkSpec().constraints.getRequiredNetworkType()
        );
        assertEquals(
                androidx.work.BackoffPolicy.EXPONENTIAL,
                request.get().getWorkSpec().backoffPolicy
        );
    }

    private Saved save(String name, String contextId, int idle, int total) throws Exception {
        JSONObject source = source(name, contextId);
        LocalStationStore.upsertBackfillSnapshot(context, source);
        ManualBackfillDraftStore.State state = ManualBackfillDraftStore.getOrCreate(context, source);
        state.draft.fastIdle = String.valueOf(idle);
        state.draft.fastTotal = String.valueOf(total);
        ManualBackfillRepository.SaveResult result = ManualBackfillRepository.save(context, state);
        assertTrue(result.saved);
        String identity = StationIdentity.fromRow(source, 0);
        return new Saved(identity, OutboxStore.findBatch(context, result.batchId));
    }

    private static JSONObject source(String name, String contextId) throws Exception {
        String localKey = LocalStationStore.buildKey("didi-charging", "西安", name, contextId)
                + "|session-1|1";
        return new JSONObject()
                .put("platform", "didi-charging")
                .put("city", "西安")
                .put("stationName", name)
                .put("localKey", localKey)
                .put("sessionId", "session-1")
                .put("pageIndex", 1)
                .put("capturedAt", "2026-07-23T02:00:00Z")
                .put("priceFast", 1.05d)
                .put("syncState", "local-only");
    }

    private static String acknowledgement(String ingestId, long recordId) throws Exception {
        return new JSONObject().put("success", true).put("data", new JSONObject()
                .put("persisted", true)
                .put("sourceNode", "47-mysql")
                .put("sourceAgent", LocalStationStore.SOURCE_AGENT)
                .put("acceptedCount", 1)
                .put("ingestId", ingestId)
                .put("firstSourceRecordId", recordId)
                .put("lastSourceRecordId", recordId)).toString();
    }

    private static final class Saved {
        final String identity;
        final JSONObject batch;

        Saved(String identity, JSONObject batch) {
            this.identity = identity;
            this.batch = batch;
        }
    }
}
