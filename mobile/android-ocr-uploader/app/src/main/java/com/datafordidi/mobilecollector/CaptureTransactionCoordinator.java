package com.datafordidi.mobilecollector;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

final class CaptureTransactionCoordinator {
    enum FailurePoint {
        AFTER_JOURNAL,
        AFTER_LOCAL,
        AFTER_OUTBOX
    }

    interface FailureInjector {
        void after(FailurePoint point);
    }

    private static final Object LOCK = new Object();
    private static volatile FailureInjector failureInjector;

    private CaptureTransactionCoordinator() {
    }

    static CommitResult commitCharging(
            Context context,
            String sessionId,
            int pageIndex,
            String screenHash,
            String platform,
            String city,
            List<DidiLocalStationParser.StationRecord> stations
    ) {
        List<JSONObject> snapshots = LocalStationStore.prepareChargingSnapshots(
                sessionId,
                pageIndex,
                city,
                stations
        );
        JSONObject batch = OutboxStore.prepareChargingBatch(
                sessionId,
                pageIndex,
                screenHash,
                platform,
                city,
                snapshots
        );
        return commit(context, snapshots, batch);
    }

    static CommitResult commitFuel(
            Context context,
            String sessionId,
            int pageIndex,
            String screenHash,
            String platform,
            String city,
            List<FuelStationRecord> stations
    ) {
        List<JSONObject> snapshots = LocalStationStore.prepareFuelSnapshots(
                sessionId,
                pageIndex,
                city,
                stations
        );
        JSONObject batch = OutboxStore.prepareFuelBatch(
                sessionId,
                pageIndex,
                screenHash,
                platform,
                city,
                snapshots
        );
        return commit(context, snapshots, batch);
    }

    private static CommitResult commit(
            Context context,
            List<JSONObject> snapshots,
            JSONObject batch
    ) {
        Context app = context.getApplicationContext();
        String batchId = batch.optString("batchId").trim();
        if (batchId.isEmpty()) throw new IllegalArgumentException("采集事务缺少批次标识");
        OutboxStore.requireCapacity(app, batchId);
        JSONObject transaction = transaction(batchId, snapshots, batch);
        List<String> insertedKeys;
        synchronized (LOCK) {
            CaptureTransactionStore.put(app, batchId, transaction);
            inject(FailurePoint.AFTER_JOURNAL);
            insertedKeys = replay(app, new CaptureTransactionStore.Entry(batchId, transaction));
        }
        BackfillRetryScheduler.schedule(app);
        return new CommitResult(batchId, insertedKeys);
    }

    static ReconcileResult reconcile(Context context) {
        Context app = context.getApplicationContext();
        int recovered = 0;
        int remaining = 0;
        synchronized (LOCK) {
            List<CaptureTransactionStore.Entry> entries;
            try {
                entries = CaptureTransactionStore.entries(app);
            } catch (RuntimeException error) {
                return new ReconcileResult(0, 1);
            }
            for (CaptureTransactionStore.Entry entry : entries) {
                try {
                    replay(app, entry);
                    recovered++;
                } catch (RuntimeException error) {
                    remaining++;
                }
            }
        }
        if (recovered > 0) BackfillRetryScheduler.schedule(app);
        return new ReconcileResult(recovered, remaining);
    }

    private static List<String> replay(Context context, CaptureTransactionStore.Entry entry) {
        JSONObject transaction = AddressFreePayload.copyObject(entry.value);
        JSONObject batch = transaction.optJSONObject("batch");
        JSONArray snapshotArray = transaction.optJSONArray("snapshots");
        if (batch == null || snapshotArray == null || snapshotArray.length() == 0) {
            throw new IllegalStateException("采集事务内容不完整");
        }
        ObservationEnvelope.requireValidBatch(batch);
        StationSensitiveDataPolicy.requireSafeBatch(batch);
        List<JSONObject> snapshots = snapshots(snapshotArray);
        String batchId = batch.optString("batchId").trim();
        if (batchId.isEmpty() || !entry.id.equals(transaction.optString("transactionId"))
                || !batchId.equals(transaction.optString("batchId"))) {
            throw new IllegalStateException("采集事务标识不一致");
        }

        JSONObject existingBatch = OutboxStore.findBatch(context, batchId);
        if (existingBatch == null && LocalStationStore.allPreparedSnapshotsSynced(context, snapshots)) {
            CaptureTransactionStore.remove(context, entry.id);
            return new ArrayList<>();
        }

        OutboxStore.requireCapacity(context, batchId);
        List<String> insertedKeys = LocalStationStore.upsertPreparedSnapshots(context, snapshots);
        inject(FailurePoint.AFTER_LOCAL);
        OutboxStore.upsertPreparedBatch(context, batch);
        inject(FailurePoint.AFTER_OUTBOX);
        CaptureTransactionStore.remove(context, entry.id);
        return insertedKeys;
    }

    private static JSONObject transaction(
            String batchId,
            List<JSONObject> snapshots,
            JSONObject batch
    ) {
        JSONArray values = new JSONArray();
        for (JSONObject snapshot : snapshots) values.put(AddressFreePayload.copyObject(snapshot));
        JSONObject transaction = new JSONObject();
        try {
            transaction.put("schemaVersion", 1)
                    .put("transactionId", batchId)
                    .put("batchId", batchId)
                    .put("createdAt", batch.optString("capturedAt"))
                    .put("snapshots", values)
                    .put("batch", AddressFreePayload.copyObject(batch));
        } catch (Exception error) {
            throw new IllegalStateException("无法准备采集事务", error);
        }
        return transaction;
    }

    private static List<JSONObject> snapshots(JSONArray values) {
        List<JSONObject> output = new ArrayList<>();
        for (int index = 0; index < values.length(); index++) {
            JSONObject snapshot = values.optJSONObject(index);
            if (snapshot != null) output.add(AddressFreePayload.copyObject(snapshot));
        }
        return output;
    }

    private static void inject(FailurePoint point) {
        FailureInjector injector = failureInjector;
        if (injector != null) injector.after(point);
    }

    static void setFailureInjectorForTests(FailureInjector injector) {
        failureInjector = injector;
    }

    static final class CommitResult {
        final String batchId;
        final List<String> localKeys;

        CommitResult(String batchId, List<String> localKeys) {
            this.batchId = batchId;
            this.localKeys = new ArrayList<>(localKeys);
        }
    }

    static final class ReconcileResult {
        final int recovered;
        final int remaining;

        ReconcileResult(int recovered, int remaining) {
            this.recovered = recovered;
            this.remaining = remaining;
        }
    }
}
