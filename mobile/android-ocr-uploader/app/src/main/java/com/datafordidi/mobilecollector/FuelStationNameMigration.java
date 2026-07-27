package com.datafordidi.mobilecollector;

import android.content.Context;
import android.content.SharedPreferences;

import com.datafordidi.ocruploader.BuildConfig;

/**
 * Applies idempotent, local-only display normalization to historical fuel snapshots.
 */
final class FuelStationNameMigration {
    private static final String PREFS = "standalone_ocr_fuel_name_migration";
    private static final String VERSION = "version";

    private FuelStationNameMigration() {
    }

    static int run(Context context) {
        Context app = context.getApplicationContext();
        SharedPreferences preferences = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        if (preferences.getInt(VERSION, -1) == BuildConfig.VERSION_CODE) return 0;
        int changed = LocalStationStore.normalizeFuelStationNames(app);
        if (!preferences.edit().putInt(VERSION, BuildConfig.VERSION_CODE).commit()) {
            throw new IllegalStateException("无法保存燃油站名迁移状态");
        }
        return changed;
    }
}
