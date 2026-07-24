package com.datafordidi.mobilecollector;

import android.content.Context;
import android.content.SharedPreferences;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

final class FalsePositiveCleanup {
    private static final String MIGRATION_PREFS = "standalone_ocr_migrations";
    private static final String V133_FEEDBACK_CLEANED = "v133_feedback_cleaned";
    private static final Set<String> REJECTED_NAMES = new HashSet<>(Arrays.asList(
            normalize("览模式查看基础电站列表。"),
            normalize("电站搜素"),
            normalize("目的地/电站名/功能"),
            normalize("充电站▼")
    ));

    private FalsePositiveCleanup() {
    }

    static void run(Context context) {
        LocalStationStore.removeStationNames(context, REJECTED_NAMES);
        OutboxStore.removeStationNames(context, REJECTED_NAMES);
        SharedPreferences migrations = context.getSharedPreferences(MIGRATION_PREFS, Context.MODE_PRIVATE);
        if (!migrations.getBoolean(V133_FEEDBACK_CLEANED, false)) {
            Set<String> removedKeys = LocalStationStore.removeCollectorFeedback(context);
            OutboxStore.removeCollectorFeedback(context, removedKeys);
            if (!migrations.edit().putBoolean(V133_FEEDBACK_CLEANED, true).commit()) {
                throw new IllegalStateException("无法记录清理迁移");
            }
        }
    }

    static boolean shouldRemove(String stationName) {
        return REJECTED_NAMES.contains(normalize(stationName));
    }

    static String normalize(String value) {
        return value == null ? "" : value.replaceAll("\\s+", "").trim();
    }
}
