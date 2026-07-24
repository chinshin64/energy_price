package com.datafordidi.mobilecollector;

import android.content.Context;

import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

public final class StationUploadWorker extends Worker {
    public StationUploadWorker(@NonNull Context context, @NonNull WorkerParameters parameters) {
        super(context, parameters);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context app = getApplicationContext();
        CaptureTransactionCoordinator.reconcile(app);
        if (!OutboxStore.hasUploadWork(app)) return Result.success();
        try {
            if (!AppSettings.isUploadConfigured(app)) return Result.retry();
            StationSyncClient client = new StationSyncClient();
            StationUploadProcessor.Summary summary = StationUploadProcessor.drain(
                    app,
                    client::upload,
                    client::canPromoteDeferredFuelBatch
            );
            return summary.retryableFailed > 0 || OutboxStore.hasUploadWork(app)
                    ? Result.retry()
                    : Result.success();
        } catch (RuntimeException error) {
            return Result.retry();
        }
    }
}
