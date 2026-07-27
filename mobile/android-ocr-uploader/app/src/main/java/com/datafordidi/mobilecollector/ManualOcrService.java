package com.datafordidi.mobilecollector;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.res.ColorStateList;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.PixelFormat;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.SystemClock;
import android.util.DisplayMetrics;
import android.util.Log;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.Text;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.chinese.ChineseTextRecognizerOptions;

import java.nio.ByteBuffer;
import java.util.List;
import java.util.ArrayList;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * 手动 OCR 悬浮采集服务。
 *
 * <p>高德加油按用户显式选择的 92#、95# 顺序采集；缺少某档时可以跳过。
 * MediaProjection 仅截屏，不代替用户操作高德页面。
 */
public final class ManualOcrService extends Service {
    private static final String TAG = "ManualOcr";
    static final String ACTION_STOP = "com.datafordidi.ocruploader.MANUAL_STOP";
    static final String ACTION_RESULT_UPDATED = "com.datafordidi.ocruploader.MANUAL_RESULT_UPDATED";
    static final String ACTION_MANUAL_CAPTURE = "com.datafordidi.ocruploader.MANUAL_CAPTURE";
    static final String EXTRA_STATUS = "status";
    static final String EXTRA_RESULT_CODE = "resultCode";
    static final String EXTRA_RESULT_DATA = "resultData";
    static final String EXTRA_PLATFORM = "platform";
    private static final String CHANNEL_ID = "manual_ocr_capture";
    private static final int NOTIFICATION_ID = 42;

    private final AmapFuelSessionReconciler amapFuelSessionReconciler =
            new AmapFuelSessionReconciler();
    private final GuidedFuelCaptureState guidedFuelCaptureState =
            new GuidedFuelCaptureState();
    private HandlerThread workerThread;
    private Handler worker;
    private TextRecognizer recognizer;
    private MediaProjection mediaProjection;
    private VirtualDisplay virtualDisplay;
    private ImageReader imageReader;
    private WindowManager windowManager;
    private View floatControl;
    private TextView floatStatus;
    private Button floatPrimaryButton;
    private Button floatSkipButton;
    private Button floatStopButton;
    private String platform;
    private String sessionId;
    private int pageIndex;
    private boolean captureInFlight;
    private volatile boolean running;
    private static volatile boolean runningState;

    static boolean isRunning() {
        return runningState;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        workerThread = new HandlerThread("manual-ocr-worker");
        workerThread.start();
        worker = new Handler(workerThread.getLooper());
        recognizer = TextRecognition.getClient(new ChineseTextRecognizerOptions.Builder().build());
        windowManager = (WindowManager) getSystemService(Context.WINDOW_SERVICE);
        createNotificationChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            requestStop();
            return START_NOT_STICKY;
        }
        if (running) {
            return START_NOT_STICKY;
        }
        platform = intent == null ? "" : intent.getStringExtra(EXTRA_PLATFORM);
        if (platform == null) platform = "";
        int resultCode = intent == null ? 0 : intent.getIntExtra(EXTRA_RESULT_CODE, 0);
        Intent resultData = intent == null ? null : intent.getParcelableExtra(EXTRA_RESULT_DATA);
        if (resultCode == 0 || resultData == null) {
            stopAndCleanup();
            return START_NOT_STICKY;
        }
        startMediaProjectionForeground();
        MediaProjectionManager manager = (MediaProjectionManager) getSystemService(Context.MEDIA_PROJECTION_SERVICE);
        if (manager == null) {
            stopAndCleanup();
            return START_NOT_STICKY;
        }
        mediaProjection = manager.getMediaProjection(resultCode, resultData);
        if (mediaProjection == null) {
            stopAndCleanup();
            return START_NOT_STICKY;
        }
        running = true;
        runningState = true;
        sessionId = newManualSessionId();
        setupDisplay();
        showFloatButton();
        announce(isGuidedAmap()
                ? "目标 92#\n先在高德选中 92#"
                : "悬浮识别已启动");
        return START_NOT_STICKY;
    }

    private void startMediaProjectionForeground() {
        Notification value = notification();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                    NOTIFICATION_ID,
                    value,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
            );
            return;
        }
        startForeground(NOTIFICATION_ID, value);
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        stopAndCleanup();
        super.onDestroy();
    }

    private void stopAndCleanup() {
        running = false;
        runningState = false;
        captureInFlight = false;
        removeFloatButton();
        if (worker != null) worker.removeCallbacksAndMessages(null);
        if (virtualDisplay != null) virtualDisplay.release();
        virtualDisplay = null;
        if (imageReader != null) imageReader.close();
        imageReader = null;
        if (mediaProjection != null) mediaProjection.stop();
        mediaProjection = null;
        if (recognizer != null) recognizer.close();
        recognizer = null;
        if (workerThread != null) workerThread.quitSafely();
        workerThread = null;
        stopForeground(STOP_FOREGROUND_REMOVE);
    }

    private void requestStop() {
        announce("已停止");
        stopAndCleanup();
        stopSelf();
    }

    private void setupDisplay() {
        DisplayMetrics metrics = new DisplayMetrics();
        windowManager.getDefaultDisplay().getRealMetrics(metrics);
        imageReader = ImageReader.newInstance(
                metrics.widthPixels,
                metrics.heightPixels,
                PixelFormat.RGBA_8888,
                2
        );
        virtualDisplay = mediaProjection.createVirtualDisplay(
                "manual-ocr",
                metrics.widthPixels,
                metrics.heightPixels,
                metrics.densityDpi,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                imageReader.getSurface(),
                null,
                worker
        );
    }

    private void showFloatButton() {
        if (floatControl != null) return;
        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setPadding(dp(8), dp(7), dp(8), dp(8));
        panel.setBackground(roundedBackground(0xF21F2937, 12));
        panel.setElevation(dp(6));

        LinearLayout header = new LinearLayout(this);
        header.setOrientation(LinearLayout.HORIZONTAL);
        header.setGravity(Gravity.CENTER_VERTICAL);
        header.setPadding(dp(2), 0, dp(2), dp(5));

        TextView title = new TextView(this);
        title.setText("OCR 识别 · " + ManualOcrOverlayFormatter.platformLabel(platform));
        title.setTextColor(0xFFFFFFFF);
        title.setTextSize(11f);
        title.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        title.setSingleLine(true);
        title.setContentDescription("OCR 识别，当前平台"
                + ManualOcrOverlayFormatter.platformLabel(platform));
        header.addView(title, new LinearLayout.LayoutParams(
                0,
                LinearLayout.LayoutParams.WRAP_CONTENT,
                1f
        ));

        TextView dragHint = new TextView(this);
        dragHint.setText("拖动");
        dragHint.setTextColor(0xFFCBD5E1);
        dragHint.setTextSize(9f);
        dragHint.setGravity(Gravity.END | Gravity.CENTER_VERTICAL);
        header.addView(dragHint, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
        ));
        panel.addView(header, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
        ));

        TextView status = new TextView(this);
        status.setTextColor(0xFFFFFFFF);
        status.setTextSize(10.5f);
        status.setGravity(Gravity.START | Gravity.CENTER_VERTICAL);
        status.setText(isGuidedAmap()
                ? "目标 92#\n先在高德选中 92#"
                : "点击下方按钮识别当前页面");
        status.setPadding(dp(8), dp(5), dp(8), dp(5));
        status.setMinHeight(dp(46));
        status.setMaxLines(5);
        status.setLineSpacing(dp(1), 1f);
        status.setBackground(roundedBackground(0xFF111827, 8));
        status.setContentDescription("OCR 识别状态");
        panel.addView(status, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
        ));

        LinearLayout actions = new LinearLayout(this);
        actions.setOrientation(LinearLayout.HORIZONTAL);
        actions.setPadding(0, dp(6), 0, 0);
        Button primary = actionButton("识别 92#", 0xFFFFFFFF, 0xFF2563EB);
        primary.setContentDescription("识别当前页面");
        Button skip = actionButton("跳过 92#", 0xFF1E3A8A, 0xFFDBEAFE);
        skip.setContentDescription("跳过当前油号");
        Button stop = actionButton("停止", 0xFFFFFFFF, 0xFFB91C1C);
        stop.setContentDescription("停止 OCR 识别并结束屏幕截取");
        actions.addView(primary, new LinearLayout.LayoutParams(0, dp(38), 1.15f));
        LinearLayout.LayoutParams skipParams = new LinearLayout.LayoutParams(0, dp(38), 1f);
        skipParams.setMarginStart(dp(5));
        actions.addView(skip, skipParams);
        LinearLayout.LayoutParams stopParams = new LinearLayout.LayoutParams(
                0,
                dp(38),
                0.78f
        );
        stopParams.setMarginStart(dp(5));
        actions.addView(stop, stopParams);
        panel.addView(actions, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
        ));

        WindowManager.LayoutParams params = new WindowManager.LayoutParams(
                dp(246),
                LinearLayout.LayoutParams.WRAP_CONTENT,
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                        ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                        : WindowManager.LayoutParams.TYPE_PHONE,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
                PixelFormat.TRANSLUCENT
        );
        params.gravity = Gravity.TOP | Gravity.START;
        params.x = Math.max(
                dp(10),
                getResources().getDisplayMetrics().widthPixels - dp(256)
        );
        params.y = dp(100);
        header.setOnTouchListener(new View.OnTouchListener() {
            private float startX;
            private float startY;
            private int startParamsX;
            private int startParamsY;

            @Override
            public boolean onTouch(View v, MotionEvent event) {
                switch (event.getAction()) {
                    case MotionEvent.ACTION_DOWN:
                        startX = event.getRawX();
                        startY = event.getRawY();
                        startParamsX = params.x;
                        startParamsY = params.y;
                        return true;
                    case MotionEvent.ACTION_MOVE:
                        params.x = startParamsX + (int) (event.getRawX() - startX);
                        params.y = startParamsY + (int) (event.getRawY() - startY);
                        windowManager.updateViewLayout(floatControl, params);
                        return true;
                    case MotionEvent.ACTION_UP:
                        return true;
                }
                return false;
            }
        });
        primary.setOnClickListener(v -> worker.post(this::onPrimaryAction));
        skip.setOnClickListener(v -> worker.post(this::onSkipAction));
        stop.setOnClickListener(v -> requestStop());
        floatControl = panel;
        floatStatus = status;
        floatPrimaryButton = primary;
        floatSkipButton = skip;
        floatStopButton = stop;
        try {
            windowManager.addView(floatControl, params);
            updateActionButtons();
        } catch (RuntimeException error) {
            Log.e(TAG, "无法显示悬浮控件", error);
            requestStop();
        }
    }

    private Button actionButton(String text, int textColor, int backgroundColor) {
        Button button = new Button(this);
        button.setText(text);
        button.setTextColor(textColor);
        button.setBackground(roundedButtonBackground(backgroundColor, 8));
        button.setTextSize(10f);
        button.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        button.setAllCaps(false);
        button.setGravity(Gravity.CENTER);
        button.setMinWidth(0);
        button.setMinHeight(0);
        button.setPadding(dp(3), 0, dp(3), 0);
        return button;
    }

    private GradientDrawable roundedBackground(int color, int radiusDp) {
        GradientDrawable background = new GradientDrawable();
        background.setColor(color);
        background.setCornerRadius(dp(radiusDp));
        return background;
    }

    private RippleDrawable roundedButtonBackground(int color, int radiusDp) {
        return new RippleDrawable(
                ColorStateList.valueOf(0x33FFFFFF),
                roundedBackground(color, radiusDp),
                null
        );
    }

    private void removeFloatButton() {
        if (floatControl != null) {
            try {
                windowManager.removeView(floatControl);
            } catch (RuntimeException ignored) {
            }
            floatControl = null;
            floatStatus = null;
            floatPrimaryButton = null;
            floatSkipButton = null;
            floatStopButton = null;
        }
    }

    private void onPrimaryAction() {
        if (captureInFlight) {
            announce("正在识别，请稍候");
            return;
        }
        if (isGuidedAmap() && guidedFuelCaptureState.done()) {
            guidedFuelCaptureState.reset();
            amapFuelSessionReconciler.reset();
            sessionId = newManualSessionId();
            pageIndex = 0;
            announce("目标 92#\n先在高德选中 92#");
            updateActionButtons();
            return;
        }
        String targetGrade = isGuidedAmap() ? guidedFuelCaptureState.expectedGrade() : "";
        captureInFlight = true;
        updateActionButtons();
        announce(targetGrade.isEmpty()
                ? "正在识别当前页面"
                : "正在识别 " + targetGrade + "#");
        captureOnce(targetGrade);
    }

    private void onSkipAction() {
        if (!isGuidedAmap() || captureInFlight || guidedFuelCaptureState.done()) return;
        String skippedGrade = guidedFuelCaptureState.expectedGrade();
        if (!guidedFuelCaptureState.skip(skippedGrade)) return;
        if (guidedFuelCaptureState.done()) {
            announce(skippedGrade + "# 已跳过\n本站完成");
        } else {
            announce(skippedGrade + "# 已跳过\n请在高德选中 "
                    + guidedFuelCaptureState.expectedGrade() + "#");
        }
        updateActionButtons();
    }

    private boolean isGuidedAmap() {
        return "amap-fuel".equals(platform);
    }

    static String newManualSessionId() {
        return "manual-ocr-" + UUID.randomUUID();
    }

    private void updateActionButtons() {
        Button primary = floatPrimaryButton;
        Button skip = floatSkipButton;
        Button stop = floatStopButton;
        if (primary == null || skip == null || stop == null) return;
        primary.post(() -> {
            stop.setEnabled(running);
            stop.setAlpha(running ? 1f : 0.55f);
            if (!isGuidedAmap()) {
                primary.setText(captureInFlight ? "识别中" : "点击识别");
                primary.setEnabled(!captureInFlight);
                skip.setVisibility(View.GONE);
                return;
            }
            if (guidedFuelCaptureState.done()) {
                primary.setText("下一站");
                primary.setEnabled(!captureInFlight);
                skip.setVisibility(View.GONE);
                return;
            }
            String grade = guidedFuelCaptureState.expectedGrade();
            primary.setText(captureInFlight ? "识别中" : "识别 " + grade + "#");
            primary.setEnabled(!captureInFlight);
            skip.setText("跳过 " + grade + "#");
            skip.setEnabled(!captureInFlight);
            skip.setVisibility(View.VISIBLE);
        });
    }

    private void captureOnce(String targetGrade) {
        if (!running || imageReader == null) return;
        if (!setFloatingControlVisible(false, true)) {
            captureInFlight = false;
            announce("截图准备失败");
            updateActionButtons();
            return;
        }
        SystemClock.sleep(250L);
        final long start = SystemClock.elapsedRealtime();
        Bitmap bitmap = null;
        try {
            while (bitmap == null && SystemClock.elapsedRealtime() - start < 3_000L) {
                Image image = imageReader.acquireLatestImage();
                if (image == null) {
                    SystemClock.sleep(50);
                    continue;
                }
                try {
                    bitmap = bitmapFromImage(image);
                } finally {
                    image.close();
                }
            }
        } finally {
            setFloatingControlVisible(true, false);
        }
        if (bitmap == null) {
            captureInFlight = false;
            announce("截图失败");
            updateActionButtons();
            return;
        }
        final Bitmap frame = bitmap;
        InputImage inputImage = InputImage.fromBitmap(frame, 0);
        recognizer.process(inputImage)
                .addOnSuccessListener(
                        worker::post,
                        text -> handleRecognition(text, frame, targetGrade)
                )
                .addOnFailureListener(worker::post, error -> {
                    Log.e(TAG, "OCR failed", error);
                    frame.recycle();
                    captureInFlight = false;
                    announce("识别失败");
                    updateActionButtons();
                });
    }

    private boolean setFloatingControlVisible(boolean visible, boolean waitForUi) {
        View control = floatControl;
        if (control == null) return false;
        CountDownLatch applied = new CountDownLatch(1);
        control.post(() -> {
            if (control == floatControl) {
                control.setVisibility(visible ? View.VISIBLE : View.INVISIBLE);
            }
            applied.countDown();
        });
        if (!waitForUi) return true;
        try {
            return applied.await(800L, TimeUnit.MILLISECONDS);
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            return false;
        }
    }

    private Bitmap bitmapFromImage(Image image) {
        return OcrRowExtractor.bitmapFromImage(image);
    }

    private void handleRecognition(Text text, Bitmap bitmap, String targetGrade) {
        try {
            String capturedAt = CaptureTime.nowUtc();
            String sourceStage = "screen-ocr-manual-float";
            List<OcrRow> rows = OcrRowExtractor.fromText(text, bitmap.getWidth(), bitmap.getHeight());
            OcrTestEvidenceStore.capture(this, rows, sourceStage, capturedAt);
            if (ScreenContextResolver.isCollectorPage(rows)) {
                announce("等待场站页面");
                return;
            }
            if (ScreenContextResolver.isBlockedPage(rows)) {
                announce("敏感页面已暂停");
                return;
            }
            ScreenContextResolver.ParsedScreen parsed;
            if (FuelPlatformHint.isExplicit(platform)) {
                parsed = ScreenContextResolver.resolveWithHint(rows, platform, sourceStage);
            } else {
                parsed = ScreenContextResolver.resolve(rows, "", sourceStage);
            }
            boolean guidedCapture = isGuidedAmap()
                    && ("92".equals(targetGrade) || "95".equals(targetGrade));
            boolean waitingForAmapPair = false;
            AmapFuelSessionReconciler.PendingPreview pendingPreview = null;
            if ("fuel".equals(parsed.stationType) && "amap-fuel".equals(parsed.platform)) {
                if (guidedCapture && guidedFuelCaptureState.hasStationBinding()) {
                    List<FuelStationRecord> matched = new ArrayList<>();
                    for (FuelStationRecord station : parsed.fuelStations) {
                        if (guidedFuelCaptureState.canonicalize(station)) matched.add(station);
                    }
                    if (matched.isEmpty()) {
                        announce("站名与上一档不一致\n请返回同一油站");
                        return;
                    }
                    parsed = ScreenContextResolver.ParsedScreen.fuel(
                            parsed.platform,
                            parsed.city,
                            matched,
                            parsed.rejectionReasons,
                            parsed.priceEvidence
                    );
                }
                AmapFuelSessionReconciler.Result reconciliation = guidedCapture
                        ? amapFuelSessionReconciler.reconcileGuided(
                                parsed.platform,
                                rows,
                                parsed.fuelStations,
                                targetGrade
                        )
                        : amapFuelSessionReconciler.reconcile(
                                parsed.platform,
                                rows,
                                parsed.fuelStations
                        );
                waitingForAmapPair = reconciliation.waitingForPair;
                pendingPreview = reconciliation.pendingPreview;
                if (guidedCapture && !reconciliation.stations.isEmpty()
                        && !guidedFuelCaptureState.acceptsStation(
                                reconciliation.stations.get(0).stationName
                        )) {
                    announce("站名与上一档不一致\n请返回同一油站");
                    return;
                }
                parsed = ScreenContextResolver.ParsedScreen.fuel(
                        parsed.platform,
                        parsed.city,
                        reconciliation.stations,
                        parsed.rejectionReasons,
                        parsed.priceEvidence
                );
            }
            emitDiagnostics(rows, parsed);
            if ("fuel".equals(parsed.stationType)) {
                for (FuelStationRecord station : parsed.fuelStations) {
                    station.capturedAt = CaptureTime.requireUtc(capturedAt);
                    station.sourceStage = sourceStage;
                    station.captureMode = FuelQuoteFeatureGate.CAPTURE_MODE;
                    for (FuelOffer offer : station.fuelOffers) offer.capturedAt = station.capturedAt;
                    for (FuelQuote quote : station.fuelQuotes) {
                        quote.capturedAt = station.capturedAt;
                        quote.validateFormula();
                        quote.finalizeIdentity(
                                station.platform,
                                station.sourceStationKey(),
                                station.offerForGrade(quote.gradeCode),
                                station.providerName
                        );
                    }
                }
                if (!parsed.fuelStations.isEmpty()) {
                    CaptureTransactionCoordinator.CommitResult committed =
                            CaptureTransactionCoordinator.commitFuel(
                                    this,
                                    sessionId,
                                    pageIndex++,
                                    screenHash(rows),
                                    parsed.platform,
                                    parsed.city,
                                    parsed.fuelStations
                            );
                    boolean uploadConfigured = AppSettings.isUploadConfigured(this);
                    LocalStationStore.markSync(
                            this,
                            committed.localKeys,
                            uploadConfigured ? "pending" : "local-only",
                            uploadConfigured ? "等待回传" : "未配置回传"
                    );
                    if (guidedCapture && !guidedFuelCaptureState.markCaptured(
                            targetGrade,
                            parsed.fuelStations.get(0)
                    )) {
                        throw new IllegalStateException("显式油号采集状态推进失败");
                    }
                }
            } else {
                for (DidiLocalStationParser.StationRecord station : parsed.stations) {
                    station.capturedAt = CaptureTime.requireUtc(capturedAt);
                    station.captureMode = "manual-float";
                }
                if (!parsed.stations.isEmpty()) {
                    LocalStationStore.upsert(this, sessionId, 0, parsed.city, parsed.stations);
                }
            }
            int count = parsed.isEmpty() ? 0 : parsed.size();
            String status;
            if (guidedCapture && count > 0) {
                status = targetGrade + "# 已识别";
                if (guidedFuelCaptureState.done()) {
                    status += "\n本站完成";
                } else {
                    status += "\n请在高德选中 "
                            + guidedFuelCaptureState.expectedGrade() + "#";
                }
            } else if (guidedCapture && pendingPreview != null) {
                status = targetGrade + "# 字段不足\n"
                        + ManualOcrOverlayFormatter.guidedMissing(pendingPreview)
                        + "\n请停留报价页后重试";
            } else if (guidedCapture) {
                status = targetGrade + "# 未识别完整\n请停留在支付报价页";
            } else if (count == 0 && pendingPreview != null) {
                status = ManualOcrOverlayFormatter.pending(pendingPreview);
            } else if (count == 0) {
                status = waitingForAmapPair
                        ? "OCR · 已缓存\n等待支付页或另一档价格"
                        : "OCR\n未识别到场站字段";
            } else if (ManualOcrOverlayFormatter.hasPairedAmapGrades(parsed)) {
                status = "OCR · 完成\n已生成 92#/95#\n可继续下一站";
            } else {
                status = "OCR · 完成\n已识别 " + count + " 条";
            }
            announce(status);
        } catch (Exception error) {
            Log.e(TAG, "结果处理失败", error);
            announce("结果处理失败");
        } finally {
            captureInFlight = false;
            updateActionButtons();
            bitmap.recycle();
        }
    }

    private void emitDiagnostics(List<OcrRow> rows, ScreenContextResolver.ParsedScreen parsed) {
        OcrDiagnostics.Builder builder = new OcrDiagnostics.Builder()
                .rowCount(rows == null ? 0 : rows.size())
                .platform(parsed == null ? "" : parsed.platform)
                .stationType(parsed == null ? "" : parsed.stationType)
                .stationCount(parsed == null ? 0 : parsed.size());
        if (parsed != null) {
            for (String reason : parsed.rejectionReasons) builder.addRejectionReason(reason);
            for (org.json.JSONObject evidence : parsed.priceEvidence) builder.addPriceEvidence(evidence);
        }
        Log.i(TAG, builder.build().toShortLog() + " stage=manual-float");
    }

    private static String screenHash(List<OcrRow> rows) {
        StringBuilder seed = new StringBuilder();
        if (rows != null) {
            for (OcrRow row : rows) {
                if (row == null) continue;
                seed.append(row.text).append('|')
                        .append(Math.round(row.x * 1000f)).append(',')
                        .append(Math.round(row.y * 1000f)).append(';');
            }
        }
        return DeviceIdentity.sha256(seed.toString());
    }

    private void announce(String status) {
        TextView statusView = floatStatus;
        if (statusView != null) {
            String text = ManualOcrOverlayFormatter.statusBody(status);
            statusView.post(() -> statusView.setText(text));
        }
        sendBroadcast(new Intent(ACTION_RESULT_UPDATED)
                .setPackage(getPackageName())
                .putExtra(EXTRA_STATUS, status));
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "手动 OCR 识别",
                NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription("悬浮按钮手动识别当前屏幕");
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) manager.createNotificationChannel(channel);
    }

    private Notification notification() {
        Intent stopIntent = new Intent(this, ManualOcrService.class).setAction(ACTION_STOP);
        PendingIntent stopPending = PendingIntent.getService(
                this,
                0,
                stopIntent,
                PendingIntent.FLAG_IMMUTABLE
        );
        return new Notification.Builder(this, CHANNEL_ID)
                .setContentTitle("手动 OCR 悬浮按钮运行中")
                .setContentText("点击悬浮按钮识别当前屏幕")
                .setSmallIcon(android.R.drawable.ic_menu_search)
                .addAction(new Notification.Action.Builder(
                        null,
                        "停止",
                        stopPending
                ).build())
                .build();
    }

    private int dp(int px) {
        return (int) (px * getResources().getDisplayMetrics().density);
    }
}
