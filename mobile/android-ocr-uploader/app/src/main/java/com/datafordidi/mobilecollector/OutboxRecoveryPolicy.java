package com.datafordidi.mobilecollector;

import android.content.Context;
import android.content.SharedPreferences;

import com.datafordidi.ocruploader.BuildConfig;

/**
 * Gives legacy, non-diagnostic HTTP 400 batches one controlled retry after an app upgrade.
 */
final class OutboxRecoveryPolicy {
    private static final String PREFS = "standalone_ocr_outbox_recovery";
    private static final String LAST_RECOVERY_VERSION = "lastRecoveryVersion";

    private OutboxRecoveryPolicy() {
    }

    static int recoverAfterUpgrade(Context context) {
        return recoverAfterUpgrade(
                context,
                AppSettings.isUploadConfigured(context),
                BuildConfig.VERSION_CODE
        );
    }

    static int recoverAfterUpgrade(Context context, boolean uploadConfigured, int versionCode) {
        Context app = context.getApplicationContext();
        if (!uploadConfigured) return 0;
        SharedPreferences preferences = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        if (preferences.getInt(LAST_RECOVERY_VERSION, -1) == versionCode) return 0;

        int recovered = OutboxStore.requeueValidatedLegacyHttp400(app);
        if (!preferences.edit()
                .putInt(LAST_RECOVERY_VERSION, versionCode)
                .commit()) {
            throw new IllegalStateException("无法保存回传恢复状态");
        }
        if (recovered > 0) BackfillRetryScheduler.resetAfterProvisioning(app);
        return recovered;
    }
}
