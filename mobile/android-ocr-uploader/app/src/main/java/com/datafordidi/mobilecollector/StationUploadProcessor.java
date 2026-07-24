package com.datafordidi.mobilecollector;

import android.content.Context;
import android.content.Intent;

import org.json.JSONObject;

final class StationUploadProcessor {
    private StationUploadProcessor() {
    }

    static Summary drain(Context context, Uploader uploader) {
        StationSyncClient client = new StationSyncClient();
        return drain(context, uploader, client::canPromoteDeferredFuelBatch);
    }

    static Summary drain(
            Context context,
            Uploader uploader,
            DeferredFuelUploadPromoter.CapabilityProbe capabilityProbe
    ) {
        Context app = context.getApplicationContext();
        CaptureTransactionCoordinator.reconcile(app);
        ManualBackfillRepository.reconcile(app);
        Summary summary = new Summary();
        summary.promoted = DeferredFuelUploadPromoter.promote(app, capabilityProbe);
        for (JSONObject listed : OutboxStore.retryablePending(app)) {
            String batchId = listed.optString("batchId", "").trim();
            if (batchId.isEmpty()) continue;
            summary.attempted++;
            try {
                StationSyncClient.UploadResult acknowledgement = uploader.upload(app, listed);
                ManualBackfillRepository.acknowledge(app, listed, acknowledgement.message);
                summary.succeeded++;
            } catch (Exception error) {
                UploadFailure.Disposition disposition = UploadFailure.disposition(error);
                OutboxStore.markFailed(app, batchId, safeMessage(error), disposition);
                boolean manual = listed.optJSONObject("manualBackfill") != null;
                boolean retryable = disposition == UploadFailure.Disposition.RETRYABLE;
                LocalStationStore.markSync(
                        app,
                        OutboxStore.localKeys(listed),
                        retryable ? "failed" : "manual-review",
                        manual && retryable
                                ? "回填完成·待回传"
                                : retryable ? "待重试" : "需人工处理"
                );
                if (retryable) summary.retryableFailed++;
                else summary.manualReview++;
                summary.failed++;
            }
        }
        CaptureTransactionCoordinator.reconcile(app);
        app.sendBroadcast(new Intent(OcrCaptureService.ACTION_RESULT_UPDATED).setPackage(app.getPackageName()));
        return summary;
    }

    private static String safeMessage(Exception error) {
        String message = error == null ? "回传失败" : error.getMessage();
        if (message == null || message.trim().isEmpty()) return "回传失败";
        String value = message.replaceAll("[\\r\\n]+", " ").trim();
        return value.length() <= 160 ? value : value.substring(0, 160);
    }

    interface Uploader {
        StationSyncClient.UploadResult upload(Context context, JSONObject batch) throws Exception;
    }

    static final class Summary {
        int attempted;
        int succeeded;
        int failed;
        int retryableFailed;
        int manualReview;
        int promoted;
    }
}
