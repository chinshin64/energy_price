package com.datafordidi.mobilecollector;

import android.content.Context;
final class BackfillUploadRunner {
    private BackfillUploadRunner() {
    }

    static void flushManualAsync(Context context) {
        ManualBackfillRepository.reconcile(context.getApplicationContext());
        BackfillRetryScheduler.schedule(context);
    }

    static void uploadAsync(Context context, String batchId) {
        if (batchId == null || batchId.trim().isEmpty()) return;
        BackfillRetryScheduler.refreshNow(context);
    }
}
