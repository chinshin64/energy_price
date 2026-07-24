package com.datafordidi.mobilecollector;

import android.content.Context;

import androidx.work.BackoffPolicy;
import androidx.work.Constraints;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkManager;

import java.time.Duration;

final class BackfillRetryScheduler {
    static final String UNIQUE_WORK_NAME = "standalone-ocr-station-upload";
    private static final Object LOCK = new Object();
    private static Enqueuer enqueuer = BackfillRetryScheduler::enqueueWithWorkManager;

    private BackfillRetryScheduler() {
    }

    static void schedule(Context context) {
        if (context == null) return;
        Context app = context.getApplicationContext();
        if (!OutboxStore.hasUploadWork(app)) return;
        synchronized (LOCK) {
            enqueuer.enqueue(app, ExistingWorkPolicy.KEEP, createRequest());
        }
    }

    static void resetAfterProvisioning(Context context) {
        if (context == null) return;
        Context app = context.getApplicationContext();
        if (!OutboxStore.hasUploadWork(app)) return;
        synchronized (LOCK) {
            enqueuer.enqueue(app, ExistingWorkPolicy.REPLACE, createRequest());
        }
    }

    static void refreshNow(Context context) {
        resetAfterProvisioning(context);
    }

    static OneTimeWorkRequest createRequest() {
        Constraints constraints = new Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build();
        return new OneTimeWorkRequest.Builder(StationUploadWorker.class)
                .setConstraints(constraints)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, Duration.ofSeconds(10))
                .addTag(UNIQUE_WORK_NAME)
                .build();
    }

    static void setEnqueuerForTests(Enqueuer replacement) {
        synchronized (LOCK) {
            enqueuer = replacement == null
                    ? BackfillRetryScheduler::enqueueWithWorkManager
                    : replacement;
        }
    }

    private static void enqueueWithWorkManager(
            Context context,
            ExistingWorkPolicy policy,
            OneTimeWorkRequest request
    ) {
        WorkManager.getInstance(context).enqueueUniqueWork(
                UNIQUE_WORK_NAME,
                policy,
                request
        );
    }

    interface Enqueuer {
        void enqueue(
                Context context,
                ExistingWorkPolicy policy,
                OneTimeWorkRequest request
        );
    }
}
