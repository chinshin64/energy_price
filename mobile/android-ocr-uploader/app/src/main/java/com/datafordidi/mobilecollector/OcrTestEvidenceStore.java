package com.datafordidi.mobilecollector;

import android.content.Context;

import com.datafordidi.ocruploader.BuildConfig;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;

/**
 * Debug-only, opt-in storage for one local OCR fixture.
 *
 * <p>No evidence is logged or uploaded. A marker in the app-private files directory must be
 * created explicitly through {@code adb shell run-as} before a capture.
 */
final class OcrTestEvidenceStore {
    static final String ENABLE_FILE = "ocr-test-evidence.enable";
    static final String LATEST_FILE = "ocr-test-evidence-latest.json";
    private static final int MAX_ROWS = 200;
    private static final int MAX_TEXT_LENGTH = 160;

    private OcrTestEvidenceStore() {
    }

    static void capture(
            Context context,
            List<OcrRow> rows,
            String sourceStage,
            String capturedAt
    ) {
        if (!enabled(context)) return;
        File output = new File(context.getFilesDir(), LATEST_FILE);
        File temporary = new File(context.getFilesDir(), LATEST_FILE + ".tmp");
        try {
            JSONObject snapshot = new JSONObject();
            snapshot.put("capturedAt", CaptureTime.requireUtc(capturedAt));
            snapshot.put("sourceStage", clean(sourceStage));
            JSONArray serializedRows = new JSONArray();
            if (rows != null) {
                for (int index = 0; index < Math.min(rows.size(), MAX_ROWS); index++) {
                    OcrRow row = rows.get(index);
                    if (row == null) continue;
                    JSONObject serialized = row.toJson();
                    serialized.put("text", sanitizeText(row.text));
                    serializedRows.put(serialized);
                }
            }
            snapshot.put("rows", serializedRows);
            byte[] bytes = snapshot.toString().getBytes(StandardCharsets.UTF_8);
            try (FileOutputStream stream = new FileOutputStream(temporary, false)) {
                stream.write(bytes);
                stream.getFD().sync();
            }
            if (output.exists() && !output.delete()) {
                temporary.delete();
                return;
            }
            if (!temporary.renameTo(output)) temporary.delete();
        } catch (Exception ignored) {
            temporary.delete();
        }
    }

    static boolean enabled(Context context) {
        return BuildConfig.DEBUG
                && context != null
                && new File(context.getFilesDir(), ENABLE_FILE).isFile();
    }

    private static String sanitizeText(String value) {
        String text = clean(value);
        text = text.replaceAll("(?i)https?://\\S+", "[url]");
        text = text.replaceAll("(?i)bearer\\s+\\S+", "[credential]");
        text = text.replaceAll("(?i)\\b[0-9a-f]{32,}\\b", "[identifier]");
        return text.length() <= MAX_TEXT_LENGTH ? text : text.substring(0, MAX_TEXT_LENGTH);
    }

    private static String clean(String value) {
        return value == null ? "" : value.replaceAll("[\\r\\n]+", " ").trim();
    }
}
