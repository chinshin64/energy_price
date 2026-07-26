package com.chinshin.energyprice.capture;

import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.graphics.drawable.GradientDrawable;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.Looper;
import android.provider.Settings;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.view.WindowMetrics;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

import com.chinshin.energyprice.R;
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

import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * User-driven screen capture. The floating button is hidden before each burst so it is not
 * included in OCR. Three frames are captured for each tap to improve small-text/CP recognition.
 */
public final class FloatingCaptureService extends Service {
    public static final String ACTION_START = "com.chinshin.energyprice.FLOATING_CAPTURE_START";
    public static final String ACTION_STOP = "com.chinshin.energyprice.FLOATING_CAPTURE_STOP";
    public static final String ACTION_CAPTURE = "com.chinshin.energyprice.FLOATING_CAPTURE_NOW";
    public static final String ACTION_STATUS_CHANGED = "com.chinshin.energyprice.FLOATING_CAPTURE_STATUS";
    public static final String EXTRA_RESULT_CODE = "result_code";
    public static final String EXTRA_RESULT_DATA = "result_data";
    public static final String EXTRA_STATUS = "status";

    private static final String CHANNEL_ID = "floating_screen_capture";
    private static final int NOTIFICATION_ID = 1201;
    private static final int BURST_FRAME_COUNT = 3;
    private static final long FRAME_GAP_MS = 320L;
    private static final long OVERLAY_HIDE_DELAY_MS = 300L;
    private static final long CAPTURE_TIMEOUT_MS = 9000L;
    private static final int PROVIDER_CONFIRM_FRAMES = 2;

    private static volatile boolean running;
    private static volatile String lastStatus = "未启动悬浮截屏";

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final ExecutorService ocrExecutor = Executors.newSingleThreadExecutor();
    private final AtomicBoolean ocrBusy = new AtomicBoolean(false);
    private final AtomicBoolean captureInProgress = new AtomicBoolean(false);
    private final AtomicBoolean stopping = new AtomicBoolean(false);
    private final AtomicInteger pendingFrames = new AtomicInteger(0);
    private final Map<String, Integer> providerVotes = new HashMap<>();

    private HandlerThread captureThread;
    private Handler captureHandler;
    private TextRecognizer recognizer;
    private CaptureSessionState state;
    private MediaProjection projection;
    private VirtualDisplay virtualDisplay;
    private ImageReader imageReader;
    private long lastFrameAt;
    private String lastPublishedStatus;
    private String providerVoteStation;

    private WindowManager overlayWindowManager;
    private View overlayView;
    private TextView overlayStatus;
    private WindowManager.LayoutParams overlayParams;
    private boolean overlayAdded;

    private final Runnable captureTimeout = () -> {
        if (!captureInProgress.compareAndSet(true, false)) return;
        pendingFrames.set(0);
        ocrBusy.set(false);
        showOverlay();
        publishStatus("截屏超时，请保持高德页面静止后重试");
    };

    public static boolean isRunning() {
        return running;
    }

    public static String lastStatus() {
        return lastStatus;
    }

    public static Intent startIntent(Context context, int resultCode, Intent resultData) {
        return new Intent(context, FloatingCaptureService.class)
                .setAction(ACTION_START)
                .putExtra(EXTRA_RESULT_CODE, resultCode)
                .putExtra(EXTRA_RESULT_DATA, resultData);
    }

    public static Intent stopIntent(Context context) {
        return new Intent(context, FloatingCaptureService.class).setAction(ACTION_STOP);
    }

    public static Intent captureIntent(Context context) {
        return new Intent(context, FloatingCaptureService.class).setAction(ACTION_CAPTURE);
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
        captureThread = new HandlerThread("energy-price-floating-capture");
        captureThread.start();
        captureHandler = new Handler(captureThread.getLooper());
        recognizer = TextRecognition.getClient(new ChineseTextRecognizerOptions.Builder().build());
        state = new CaptureSessionState(this);
        SecureConfigStore.importProvisioningIfPresent(this);
        SyncScheduler.ensurePeriodic(this);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) return START_NOT_STICKY;
        String action = intent.getAction();
        if (ACTION_STOP.equals(action)) {
            stopCapture("悬浮截屏已停止");
            return START_NOT_STICKY;
        }
        if (ACTION_CAPTURE.equals(action)) {
            requestCaptureBurst();
            return START_NOT_STICKY;
        }
        if (!ACTION_START.equals(action)) return START_NOT_STICKY;

        startForeground(NOTIFICATION_ID, buildNotification("正在启动悬浮截屏"));
        int resultCode = intent.getIntExtra(EXTRA_RESULT_CODE, Activity.RESULT_CANCELED);
        Intent resultData = intent.getParcelableExtra(EXTRA_RESULT_DATA);
        if (resultCode != Activity.RESULT_OK || resultData == null) {
            stopCapture("未获得系统截屏授权");
            return START_NOT_STICKY;
        }

        try {
            startProjection(resultCode, resultData);
        } catch (Exception e) {
            stopCapture("截屏启动失败: " + safeMessage(e));
        }
        return START_NOT_STICKY;
    }

    private void startProjection(int resultCode, Intent resultData) {
        stopping.set(false);
        releaseProjection();
        providerVotes.clear();
        providerVoteStation = null;

        MediaProjectionManager manager = (MediaProjectionManager) getSystemService(MEDIA_PROJECTION_SERVICE);
        projection = manager.getMediaProjection(resultCode, resultData);
        if (projection == null) throw new IllegalStateException("MediaProjection unavailable");
        projection.registerCallback(new MediaProjection.Callback() {
            @Override
            public void onStop() {
                captureHandler.post(() -> stopCapture("系统已结束截屏授权"));
            }
        }, captureHandler);

        WindowManager windowManager = (WindowManager) getSystemService(WINDOW_SERVICE);
        WindowMetrics metrics = windowManager.getMaximumWindowMetrics();
        Rect bounds = metrics.getBounds();
        int width = Math.max(1, bounds.width());
        int height = Math.max(1, bounds.height());
        int densityDpi = getResources().getDisplayMetrics().densityDpi;

        imageReader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 4);
        imageReader.setOnImageAvailableListener(this::onImageAvailable, captureHandler);
        virtualDisplay = projection.createVirtualDisplay(
                "EnergyPriceFloatingCapture",
                width,
                height,
                densityDpi,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                imageReader.getSurface(),
                null,
                captureHandler
        );
        running = true;
        showOverlay();
        publishStatus("已启动：到高德详情页或支付页后点击悬浮窗“截屏识别”");
    }

    private void requestCaptureBurst() {
        if (!running || projection == null) {
            publishStatus("截屏服务未启动");
            return;
        }
        if (!captureInProgress.compareAndSet(false, true)) {
            publishStatus("正在识别上一张截图，请稍候");
            return;
        }
        providerVotes.clear();
        pendingFrames.set(0);
        lastFrameAt = 0L;
        hideOverlay();
        publishStatus("正在截屏识别，请保持页面静止");
        captureHandler.removeCallbacks(captureTimeout);
        captureHandler.postDelayed(() -> pendingFrames.set(BURST_FRAME_COUNT), OVERLAY_HIDE_DELAY_MS);
        captureHandler.postDelayed(captureTimeout, CAPTURE_TIMEOUT_MS);
    }

    private void onImageAvailable(ImageReader reader) {
        Image image = null;
        try {
            image = reader.acquireLatestImage();
            if (image == null || !captureInProgress.get() || pendingFrames.get() <= 0) return;
            long now = System.currentTimeMillis();
            if (now - lastFrameAt < FRAME_GAP_MS || !ocrBusy.compareAndSet(false, true)) return;
            lastFrameAt = now;
            pendingFrames.decrementAndGet();
            Bitmap bitmap = imageToBitmap(image);
            if (bitmap == null) {
                ocrBusy.set(false);
                return;
            }
            analyze(bitmap);
        } catch (Exception e) {
            ocrBusy.set(false);
            publishStatus("截屏处理失败: " + safeMessage(e));
            finishCaptureBurst();
        } finally {
            if (image != null) image.close();
        }
    }

    private void analyze(Bitmap fullBitmap) {
        Bitmap providerCrop = createProviderCrop(fullBitmap);
        recognizer.process(InputImage.fromBitmap(fullBitmap, 0))
                .addOnSuccessListener(ocrExecutor, fullText -> {
                    List<String> lines = linesFromOcr(fullText, fullBitmap);
                    if (providerCrop == null) {
                        finishFrame(fullBitmap, null, lines);
                        return;
                    }
                    recognizer.process(InputImage.fromBitmap(providerCrop, 0))
                            .addOnSuccessListener(ocrExecutor, text -> lines.addAll(plainLinesFromOcr(text)))
                            .addOnFailureListener(ocrExecutor, ignored -> { })
                            .addOnCompleteListener(ocrExecutor, task -> finishFrame(fullBitmap, providerCrop, lines));
                })
                .addOnFailureListener(ocrExecutor, error -> {
                    recycle(fullBitmap);
                    recycle(providerCrop);
                    ocrBusy.set(false);
                    publishStatus("OCR 失败: " + safeMessage(error));
                    finishCaptureBurst();
                });
    }

    private void finishFrame(Bitmap fullBitmap, Bitmap providerCrop, List<String> lines) {
        boolean saved = false;
        try {
            saved = processLines(lines);
        } finally {
            recycle(fullBitmap);
            recycle(providerCrop);
            ocrBusy.set(false);
        }
        if (saved) pendingFrames.set(0);
        if (pendingFrames.get() <= 0) finishCaptureBurst();
    }

    private void finishCaptureBurst() {
        if (!captureInProgress.compareAndSet(true, false)) return;
        pendingFrames.set(0);
        captureHandler.removeCallbacks(captureTimeout);
        showOverlay();
    }

    private boolean processLines(List<String> source) {
        if (source == null || source.isEmpty() || state == null) {
            publishStatus("截图成功，但未识别到文字");
            return false;
        }
        List<String> lines = dedupe(source);
        FuelCapture partial = FuelStationParser.parse(lines, System.currentTimeMillis());
        applyProviderConsensus(partial);
        FuelCapture merged = state.merge(partial);
        if (merged == null) {
            publishStatus("截图成功，未识别到高德加油字段");
            return false;
        }
        publishStatus(statusFor(merged));
        if (!merged.isCompleteForSubmission()) return false;
        long now = System.currentTimeMillis();
        if (!state.shouldSave(merged, now)) return false;
        try {
            CaptureRecord record = MobileSourcePayloadFactory.createRecord(this, merged);
            long id = EnergyDatabase.get(this).insert(record);
            if (id <= 0) return false;
            state.markSaved(merged, now);
            SyncScheduler.enqueue(this);
            sendBroadcast(new Intent(MainActivity.ACTION_DATA_CHANGED).setPackage(getPackageName()));
            String savedStatus = merged.stationName + " " + merged.gradeCode + "# 已记录";
            publishStatus(savedStatus);
            ContextCompat.getMainExecutor(this).execute(() -> Toast.makeText(this, savedStatus, Toast.LENGTH_LONG).show());
            return true;
        } catch (Exception e) {
            publishStatus("记录失败: " + safeMessage(e));
            return false;
        }
    }

    private void applyProviderConsensus(FuelCapture capture) {
        if (capture == null) return;
        if (notBlank(capture.stationName) && !capture.stationName.equals(providerVoteStation)) {
            providerVoteStation = capture.stationName;
            providerVotes.clear();
        }
        if (!notBlank(capture.providerName)) return;
        String candidate = capture.providerName;
        int votes = providerVotes.getOrDefault(candidate, 0) + 1;
        providerVotes.put(candidate, votes);
        if (votes < PROVIDER_CONFIRM_FRAMES) {
            capture.providerName = null;
            capture.providerEvidenceText = null;
        }
    }

    private void showOverlay() {
        mainHandler.post(() -> {
            if (!running || !Settings.canDrawOverlays(this)) return;
            if (overlayWindowManager == null) overlayWindowManager = (WindowManager) getSystemService(WINDOW_SERVICE);
            if (overlayView == null) createOverlayView();
            try {
                if (!overlayAdded) {
                    overlayWindowManager.addView(overlayView, overlayParams);
                    overlayAdded = true;
                }
                overlayView.setVisibility(View.VISIBLE);
                updateOverlayStatus(lastStatus);
            } catch (Exception e) {
                overlayAdded = false;
                publishStatus("悬浮窗显示失败: " + safeMessage(e));
            }
        });
    }

    private void hideOverlay() {
        mainHandler.post(() -> {
            if (overlayView != null) overlayView.setVisibility(View.GONE);
        });
    }

    private void removeOverlay() {
        mainHandler.post(() -> {
            if (overlayWindowManager != null && overlayView != null && overlayAdded) {
                try {
                    overlayWindowManager.removeView(overlayView);
                } catch (Exception ignored) {
                }
            }
            overlayAdded = false;
            overlayView = null;
            overlayStatus = null;
        });
    }

    private void createOverlayView() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(10), dp(8), dp(10), dp(8));
        GradientDrawable background = new GradientDrawable();
        background.setColor(Color.argb(225, 28, 31, 38));
        background.setCornerRadius(dp(14));
        root.setBackground(background);

        overlayStatus = new TextView(this);
        overlayStatus.setTextColor(Color.WHITE);
        overlayStatus.setTextSize(12f);
        overlayStatus.setMaxLines(4);
        overlayStatus.setMaxWidth(dp(260));
        overlayStatus.setPadding(dp(4), 0, dp(4), dp(5));
        root.addView(overlayStatus, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
        ));

        LinearLayout actions = new LinearLayout(this);
        actions.setOrientation(LinearLayout.HORIZONTAL);
        actions.setGravity(Gravity.CENTER_VERTICAL);

        Button capture = new Button(this);
        capture.setText("截屏识别");
        capture.setTextSize(13f);
        capture.setOnClickListener(v -> requestCaptureBurst());
        actions.addView(capture, new LinearLayout.LayoutParams(dp(112), dp(48)));

        Button stop = new Button(this);
        stop.setText("停止");
        stop.setTextSize(13f);
        stop.setOnClickListener(v -> stopCapture("悬浮截屏已停止"));
        LinearLayout.LayoutParams stopParams = new LinearLayout.LayoutParams(dp(72), dp(48));
        stopParams.leftMargin = dp(6);
        actions.addView(stop, stopParams);
        root.addView(actions);

        overlayParams = new WindowManager.LayoutParams(
                WindowManager.LayoutParams.WRAP_CONTENT,
                WindowManager.LayoutParams.WRAP_CONTENT,
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
                PixelFormat.TRANSLUCENT
        );
        overlayParams.gravity = Gravity.TOP | Gravity.END;
        overlayParams.x = dp(12);
        overlayParams.y = dp(220);

        root.setOnTouchListener(new View.OnTouchListener() {
            private int startX;
            private int startY;
            private float downX;
            private float downY;
            private boolean moved;

            @Override
            public boolean onTouch(View v, MotionEvent event) {
                switch (event.getActionMasked()) {
                    case MotionEvent.ACTION_DOWN:
                        startX = overlayParams.x;
                        startY = overlayParams.y;
                        downX = event.getRawX();
                        downY = event.getRawY();
                        moved = false;
                        return true;
                    case MotionEvent.ACTION_MOVE:
                        int dx = Math.round(event.getRawX() - downX);
                        int dy = Math.round(event.getRawY() - downY);
                        if (Math.abs(dx) > dp(4) || Math.abs(dy) > dp(4)) moved = true;
                        overlayParams.x = Math.max(0, startX - dx);
                        overlayParams.y = Math.max(0, startY + dy);
                        if (overlayAdded) overlayWindowManager.updateViewLayout(root, overlayParams);
                        return true;
                    case MotionEvent.ACTION_UP:
                    case MotionEvent.ACTION_CANCEL:
                        return moved;
                    default:
                        return false;
                }
            }
        });
        overlayView = root;
    }

    private void updateOverlayStatus(String status) {
        if (overlayStatus == null) return;
        String value = status == null || status.trim().isEmpty() ? "等待截屏" : status;
        overlayStatus.setText(value);
    }

    private static Bitmap imageToBitmap(Image image) {
        if (image.getPlanes().length == 0) return null;
        Image.Plane plane = image.getPlanes()[0];
        ByteBuffer buffer = plane.getBuffer();
        int width = image.getWidth();
        int height = image.getHeight();
        int pixelStride = plane.getPixelStride();
        int rowStride = plane.getRowStride();
        int rowPadding = Math.max(0, rowStride - pixelStride * width);
        int paddedWidth = width + rowPadding / Math.max(1, pixelStride);
        Bitmap padded = Bitmap.createBitmap(paddedWidth, height, Bitmap.Config.ARGB_8888);
        padded.copyPixelsFromBuffer(buffer);
        Bitmap cropped = Bitmap.createBitmap(padded, 0, 0, width, height);
        if (cropped != padded) padded.recycle();
        return cropped;
    }

    private static Bitmap createProviderCrop(Bitmap source) {
        if (source == null || source.getWidth() < 2 || source.getHeight() < 2) return null;
        int top = Math.max(0, (int) (source.getHeight() * 0.58f));
        int bottom = Math.min(source.getHeight(), (int) (source.getHeight() * 0.995f));
        int height = bottom - top;
        if (height < 2) return null;
        Bitmap crop = Bitmap.createBitmap(source, 0, top, source.getWidth(), height);
        float scale = Math.min(2.4f, 2600f / Math.max(1f, crop.getWidth()));
        if (scale <= 1.05f) return crop;
        Bitmap enlarged = Bitmap.createScaledBitmap(
                crop,
                Math.max(1, Math.round(crop.getWidth() * scale)),
                Math.max(1, Math.round(crop.getHeight() * scale)),
                true
        );
        if (enlarged != crop) crop.recycle();
        return enlarged;
    }

    private static List<String> linesFromOcr(Text text, Bitmap bitmap) {
        List<String> out = new ArrayList<>();
        List<VisualCandidate> gradeCandidates = new ArrayList<>();
        List<VisualCandidate> amountCandidates = new ArrayList<>();
        for (Text.TextBlock block : text.getTextBlocks()) {
            for (Text.Line line : block.getLines()) {
                String lineText = line.getText();
                if (lineText != null && !lineText.trim().isEmpty()) out.add(lineText.trim());
                for (Text.Element element : line.getElements()) {
                    Rect box = element.getBoundingBox();
                    if (box == null) continue;
                    String token = normalizeVisualToken(element.getText());
                    if (token.matches("(?:92|95)[#号]?")) {
                        String grade = token.startsWith("95") ? "95" : "92";
                        gradeCandidates.add(new VisualCandidate(grade, blueScore(bitmap, box, true)));
                    }
                    if (token.matches("(?:¥|￥|#|Y)?200(?:\\.00)?(?:元)?")) {
                        amountCandidates.add(new VisualCandidate("200", blueScore(bitmap, box, false)));
                    }
                }
            }
        }
        VisualCandidate selectedGrade = selectedCandidate(gradeCandidates, 6, 3);
        if (selectedGrade != null) out.add("__SELECTED__ " + selectedGrade.value + "#");
        VisualCandidate selectedAmount = selectedCandidate(amountCandidates, 12, 5);
        if (selectedAmount != null) out.add("__SELECTED__ ¥200");
        return out;
    }

    private static List<String> plainLinesFromOcr(Text text) {
        List<String> out = new ArrayList<>();
        for (Text.TextBlock block : text.getTextBlocks()) {
            for (Text.Line line : block.getLines()) {
                String value = line.getText();
                if (value != null && !value.trim().isEmpty()) out.add(value.trim());
            }
        }
        return out;
    }

    private static VisualCandidate selectedCandidate(List<VisualCandidate> candidates, int minimum, int margin) {
        VisualCandidate best = null;
        VisualCandidate second = null;
        for (VisualCandidate candidate : candidates) {
            if (best == null || candidate.score > best.score) {
                second = best;
                best = candidate;
            } else if (second == null || candidate.score > second.score) {
                second = candidate;
            }
        }
        if (best == null || best.score < minimum) return null;
        if (second != null && best.score < second.score + margin) return null;
        return best;
    }

    private static int blueScore(Bitmap bitmap, Rect source, boolean grade) {
        int left;
        int right;
        int top;
        int bottom;
        if (grade) {
            left = Math.max(0, source.left - Math.max(16, source.width() / 3));
            right = Math.min(bitmap.getWidth(), source.right + Math.max(16, source.width() / 3));
            top = Math.max(0, source.top - 4);
            bottom = Math.min(bitmap.getHeight(), source.bottom + Math.max(30, source.height()));
        } else {
            left = Math.max(0, source.left - Math.max(60, source.width()));
            right = Math.min(bitmap.getWidth(), source.right + Math.max(60, source.width()));
            top = Math.max(0, source.top - Math.max(12, source.height() / 2));
            bottom = Math.min(bitmap.getHeight(), source.bottom + Math.max(20, source.height()));
        }
        int score = 0;
        for (int y = top; y < bottom; y += 2) {
            for (int x = left; x < right; x += 2) {
                int color = bitmap.getPixel(x, y);
                int r = (color >> 16) & 0xff;
                int g = (color >> 8) & 0xff;
                int b = color & 0xff;
                if (b >= 105 && b >= r + 18 && b >= g + 4) score++;
            }
        }
        return score;
    }

    private static String normalizeVisualToken(String value) {
        return value == null ? "" : value.replaceAll("\\s+", "").replace('＃', '#');
    }

    private static List<String> dedupe(List<String> source) {
        Set<String> values = new LinkedHashSet<>();
        for (String value : source) {
            if (value != null && !value.trim().isEmpty()) values.add(value.trim());
        }
        return new ArrayList<>(values);
    }

    private static String statusFor(FuelCapture capture) {
        List<String> found = new ArrayList<>();
        if (notBlank(capture.stationName)) found.add(capture.stationName);
        if (notBlank(capture.gradeCode)) found.add(capture.gradeCode + "#");
        if (capture.amountYuan != null) found.add("¥" + capture.amountYuan);
        if (capture.stationPrice != null) found.add(String.format(Locale.CHINA, "油站价 %.2f", capture.stationPrice));
        if (capture.displayPrice != null) found.add(String.format(Locale.CHINA, "优惠价 %.2f", capture.displayPrice));
        if (capture.discountAmount != null) found.add(String.format(Locale.CHINA, "优惠 %.2f", capture.discountAmount));
        if (capture.serviceFee != null) found.add(String.format(Locale.CHINA, "服务费 %.2f", capture.serviceFee));
        if (notBlank(capture.providerName)) found.add("CP " + capture.providerName);
        if (found.isEmpty()) return "截图成功，等待识别高德加油页面";

        List<String> missing = new ArrayList<>();
        if (!notBlank(capture.stationName)) missing.add("站名");
        if (!("92".equals(capture.gradeCode) || "95".equals(capture.gradeCode))) missing.add("油号");
        if (capture.amountYuan == null || capture.amountYuan != 200) missing.add("200元");
        if (capture.stationPrice == null) missing.add("油站价");
        if (capture.displayPrice == null) missing.add("优惠价");
        if (capture.discountAmount == null) missing.add("优惠金额");
        if (capture.serviceFee == null) missing.add("服务费");
        if (!notBlank(capture.providerName)) missing.add("CP");
        String suffix = missing.isEmpty() ? "" : "；待补 " + String.join("/", missing);
        return String.join(" · ", found) + suffix;
    }

    private void publishStatus(String status) {
        if (status == null || status.trim().isEmpty()) return;
        lastStatus = status;
        mainHandler.post(() -> updateOverlayStatus(status));
        if (!status.equals(lastPublishedStatus)) {
            lastPublishedStatus = status;
            NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            manager.notify(NOTIFICATION_ID, buildNotification(status));
            sendBroadcast(new Intent(ACTION_STATUS_CHANGED)
                    .setPackage(getPackageName())
                    .putExtra(EXTRA_STATUS, status));
        }
    }

    private Notification buildNotification(String text) {
        PendingIntent openApp = PendingIntent.getActivity(
                this,
                0,
                new Intent(this, MainActivity.class),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        PendingIntent capture = PendingIntent.getService(
                this,
                1,
                captureIntent(this),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        PendingIntent stop = PendingIntent.getService(
                this,
                2,
                stopIntent(this),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_launcher_foreground)
                .setContentTitle("油价悬浮截屏")
                .setContentText(text)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
                .setContentIntent(openApp)
                .addAction(0, "截屏识别", capture)
                .addAction(0, "停止", stop)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .build();
    }

    private void createNotificationChannel() {
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "悬浮截屏采集",
                NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription("手动截取高德加油详情页和支付页并进行 OCR");
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        manager.createNotificationChannel(channel);
    }

    private void stopCapture(String reason) {
        if (!stopping.compareAndSet(false, true)) return;
        running = false;
        captureInProgress.set(false);
        pendingFrames.set(0);
        captureHandler.removeCallbacks(captureTimeout);
        lastStatus = reason;
        removeOverlay();
        releaseProjection();
        sendBroadcast(new Intent(ACTION_STATUS_CHANGED)
                .setPackage(getPackageName())
                .putExtra(EXTRA_STATUS, reason));
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    private void releaseProjection() {
        if (imageReader != null) {
            imageReader.setOnImageAvailableListener(null, null);
            imageReader.close();
            imageReader = null;
        }
        if (virtualDisplay != null) {
            virtualDisplay.release();
            virtualDisplay = null;
        }
        MediaProjection current = projection;
        projection = null;
        if (current != null) {
            try {
                current.stop();
            } catch (Exception ignored) {
            }
        }
    }

    @Override
    public void onDestroy() {
        running = false;
        captureInProgress.set(false);
        removeOverlay();
        releaseProjection();
        if (recognizer != null) recognizer.close();
        ocrExecutor.shutdownNow();
        if (captureThread != null) captureThread.quitSafely();
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private static void recycle(Bitmap bitmap) {
        if (bitmap != null && !bitmap.isRecycled()) bitmap.recycle();
    }

    private static boolean notBlank(String value) {
        return value != null && !value.trim().isEmpty();
    }

    private static String safeMessage(Throwable error) {
        if (error == null || error.getMessage() == null || error.getMessage().trim().isEmpty()) return "未知错误";
        return error.getMessage();
    }

    private static final class VisualCandidate {
        final String value;
        final int score;

        VisualCandidate(String value, int score) {
            this.value = value;
            this.score = score;
        }
    }
}
