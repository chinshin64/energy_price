package com.chinshin.energyprice.capture;

import android.accessibilityservice.AccessibilityService;
import android.graphics.Bitmap;
import android.graphics.ColorSpace;
import android.hardware.HardwareBuffer;
import android.os.Handler;
import android.os.Looper;
import android.view.Display;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.widget.Toast;

import com.chinshin.energyprice.data.CaptureRecord;
import com.chinshin.energyprice.data.EnergyDatabase;
import com.chinshin.energyprice.net.MobileSourcePayloadFactory;
import com.chinshin.energyprice.security.SecureConfigStore;
import com.chinshin.energyprice.ui.MainActivity;
import com.chinshin.energyprice.worker.SyncScheduler;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.Text;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.chinese.ChineseTextRecognizerOptions;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

public final class AmapFuelAccessibilityService extends AccessibilityService {
    private static final String AMAP_PACKAGE = "com.autonavi.minimap";
    private static final long SCAN_DELAY_MS = 650L;
    private static final long SCREENSHOT_GAP_MS = 1400L;

    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final AtomicBoolean screenshotBusy = new AtomicBoolean(false);
    private final Runnable scanRunnable = this::scanCurrentWindow;
    private TextRecognizer recognizer;
    private CaptureSessionState state;
    private long lastScreenshotAt;

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();
        recognizer = TextRecognition.getClient(new ChineseTextRecognizerOptions.Builder().build());
        state = new CaptureSessionState(this);
        SecureConfigStore.importProvisioningIfPresent(this);
        SyncScheduler.ensurePeriodic(this);
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        if (event == null || event.getPackageName() == null) return;
        if (!AMAP_PACKAGE.contentEquals(event.getPackageName())) return;
        main.removeCallbacks(scanRunnable);
        main.postDelayed(scanRunnable, SCAN_DELAY_MS);
    }

    @Override
    public void onInterrupt() {
        main.removeCallbacks(scanRunnable);
    }

    @Override
    public void onDestroy() {
        main.removeCallbacks(scanRunnable);
        if (recognizer != null) recognizer.close();
        executor.shutdownNow();
        super.onDestroy();
    }

    private void scanCurrentWindow() {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) return;
        List<String> nodeLines = new ArrayList<>();
        collectNodeText(root, nodeLines, 0);
        processLines(nodeLines);

        long now = System.currentTimeMillis();
        if (now - lastScreenshotAt < SCREENSHOT_GAP_MS || !screenshotBusy.compareAndSet(false, true)) return;
        lastScreenshotAt = now;
        takeScreenshot(Display.DEFAULT_DISPLAY, executor, new TakeScreenshotCallback() {
            @Override
            public void onSuccess(ScreenshotResult screenshot) {
                Bitmap mutable = null;
                HardwareBuffer buffer = screenshot.getHardwareBuffer();
                try {
                    ColorSpace colorSpace = screenshot.getColorSpace();
                    Bitmap hardware = Bitmap.wrapHardwareBuffer(buffer, colorSpace);
                    if (hardware != null) mutable = hardware.copy(Bitmap.Config.ARGB_8888, false);
                } finally {
                    buffer.close();
                }
                if (mutable == null) {
                    screenshotBusy.set(false);
                    return;
                }
                Bitmap bitmap = mutable;
                recognizer.process(InputImage.fromBitmap(bitmap, 0))
                        .addOnSuccessListener(executor, text -> {
                            List<String> merged = new ArrayList<>(nodeLines);
                            merged.addAll(linesFromOcr(text));
                            processLines(merged);
                        })
                        .addOnCompleteListener(executor, task -> {
                            bitmap.recycle();
                            screenshotBusy.set(false);
                        });
            }

            @Override
            public void onFailure(int errorCode) {
                screenshotBusy.set(false);
            }
        });
    }

    private void processLines(List<String> source) {
        if (source == null || source.isEmpty() || state == null) return;
        List<String> lines = dedupe(source);
        FuelCapture partial = FuelStationParser.parse(lines, System.currentTimeMillis());
        FuelCapture merged = state.merge(partial);
        if (merged == null || !merged.isCompleteForSubmission()) return;
        long now = System.currentTimeMillis();
        if (!state.shouldSave(merged, now)) return;
        try {
            CaptureRecord record = MobileSourcePayloadFactory.createRecord(this, merged);
            long id = EnergyDatabase.get(this).insert(record);
            if (id > 0) {
                state.markSaved(merged, now);
                SyncScheduler.enqueue(this);
                sendBroadcast(new android.content.Intent(MainActivity.ACTION_DATA_CHANGED).setPackage(getPackageName()));
                main.post(() -> Toast.makeText(this,
                        merged.stationName + " " + merged.gradeCode + "# 已记录", Toast.LENGTH_SHORT).show());
            }
        } catch (Exception ignored) {
            // Incomplete or malformed captures remain in session state for the next page event.
        }
    }

    private static void collectNodeText(AccessibilityNodeInfo node, List<String> out, int depth) {
        if (node == null || depth > 80) return;
        String prefix = (node.isSelected() || node.isChecked()) ? "__SELECTED__ " : "";
        CharSequence text = node.getText();
        if (text != null && text.length() > 0) out.add(prefix + text);
        CharSequence description = node.getContentDescription();
        if (description != null && description.length() > 0 && (text == null || !description.toString().contentEquals(text))) {
            out.add(prefix + description);
        }
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            if (child != null) collectNodeText(child, out, depth + 1);
        }
    }

    private static List<String> linesFromOcr(Text text) {
        List<String> out = new ArrayList<>();
        for (Text.TextBlock block : text.getTextBlocks()) {
            for (Text.Line line : block.getLines()) out.add(line.getText());
        }
        return out;
    }

    private static List<String> dedupe(List<String> source) {
        Set<String> set = new LinkedHashSet<>();
        for (String value : source) {
            if (value != null && !value.trim().isEmpty()) set.add(value.trim());
        }
        return new ArrayList<>(set);
    }
}
