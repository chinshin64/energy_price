package com.datafordidi.mobilecollector;

import android.content.Context;

import org.json.JSONObject;

final class DeferredFuelUploadPromoter {
    private DeferredFuelUploadPromoter() {
    }

    static int promote(Context context, CapabilityProbe probe) {
        Context app = context.getApplicationContext();
        int promoted = 0;
        for (JSONObject batch : OutboxStore.deferredFuel(app)) {
            String batchId = batch.optString("batchId", "").trim();
            if (batchId.isEmpty()) continue;
            boolean enabled;
            try {
                enabled = probe.canUpload(app, batch);
            } catch (Exception ignored) {
                enabled = false;
            }
            if (!enabled || !OutboxStore.promoteDeferred(app, batchId)) continue;
            LocalStationStore.markSync(
                    app,
                    OutboxStore.localKeys(batch),
                    "pending",
                    "等待回传"
            );
            promoted++;
        }
        return promoted;
    }

    interface CapabilityProbe {
        boolean canUpload(Context context, JSONObject batch) throws Exception;
    }
}
