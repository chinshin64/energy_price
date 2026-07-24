package com.datafordidi.mobilecollector;

import android.content.Context;
import android.graphics.Bitmap;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.List;

public class TestRunRecorder {
    private final Context context;
    private final File runDir;
    private final File eventsFile;

    public TestRunRecorder(Context context, String sessionId) {
        this.context = context.getApplicationContext();
        File root = context.getExternalFilesDir("test-runs");
        if (root == null) {
            root = new File(context.getFilesDir(), "test-runs");
        }
        runDir = new File(root, sanitize(sessionId));
        if (!runDir.exists()) {
            runDir.mkdirs();
        }
        eventsFile = new File(runDir, "events.jsonl");
    }

    public File getRunDir() {
        return runDir;
    }

    public void recordFrame(
            int pageIndex,
            String stage,
            String screenshotHash,
            List<OcrRow> rows,
            AiSupervisor.Decision decision,
            Bitmap bitmap
    ) {
        try {
            String screenshotFile = null;
            if (bitmap != null && CollectorSettings.isTestEvidenceEnabled(context)) {
                screenshotFile = saveScreenshot(pageIndex, stage, screenshotHash, bitmap);
            }

            JSONObject event = new JSONObject()
                    .put("capturedAt", Instant.now().toString())
                    .put("pageIndex", pageIndex)
                    .put("stage", stage == null ? "" : stage)
                    .put("screenshotHash", screenshotHash == null ? JSONObject.NULL : screenshotHash)
                    .put("screenshotFile", screenshotFile == null ? JSONObject.NULL : screenshotFile)
                    .put("decision", decision == null ? JSONObject.NULL : decision.toJson())
                    .put("ocrRows", rowsToJson(rows));
            appendJsonLine(event);
        } catch (Exception ignored) {
            // Evidence capture must not block collection.
        }
    }

    public void recordEvent(String type, String message) {
        try {
            JSONObject event = new JSONObject()
                    .put("capturedAt", Instant.now().toString())
                    .put("type", type)
                    .put("message", message == null ? "" : message);
            appendJsonLine(event);
        } catch (Exception ignored) {
        }
    }

    private String saveScreenshot(int pageIndex, String stage, String screenshotHash, Bitmap bitmap) throws Exception {
        File screenshotsDir = new File(runDir, "screenshots");
        if (!screenshotsDir.exists()) {
            screenshotsDir.mkdirs();
        }
        String safeHash = screenshotHash == null || screenshotHash.trim().isEmpty()
                ? String.valueOf(System.currentTimeMillis())
                : screenshotHash.trim();
        File file = new File(screenshotsDir, pageIndex + "-" + sanitize(stage) + "-" + sanitize(safeHash) + ".jpg");
        try (FileOutputStream output = new FileOutputStream(file)) {
            bitmap.compress(Bitmap.CompressFormat.JPEG, 58, output);
        }
        return file.getAbsolutePath();
    }

    private void appendJsonLine(JSONObject event) throws Exception {
        try (OutputStreamWriter writer = new OutputStreamWriter(
                new FileOutputStream(eventsFile, true),
                StandardCharsets.UTF_8
        )) {
            writer.write(event.toString());
            writer.write('\n');
        }
    }

    private JSONArray rowsToJson(List<OcrRow> rows) {
        JSONArray array = new JSONArray();
        if (rows == null) {
            return array;
        }
        for (OcrRow row : rows) {
            try {
                array.put(row.toJson());
            } catch (Exception ignored) {
            }
        }
        return array;
    }

    private static String sanitize(String value) {
        return String.valueOf(value == null ? "" : value)
                .replaceAll("[^a-zA-Z0-9._-]", "_")
                .replaceAll("_+", "_");
    }
}
