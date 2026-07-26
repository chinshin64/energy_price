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
import java.util.HashSet;
import java.util.LinkedHashMap;
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
 * Two-stage, user-driven capture flow:
 * 1) detail page caches station name, explicit grade when available, station price and display price;
 * 2) payment page captures gross discount, payable amount and provider, then derives service fee.
 * When a grade is absent, two display prices for the same station are ranked: lower=92#, higher=95#.
 */
public final class TwoStageFloatingCaptureService extends Service {
    public static final String ACTION_START = "com.chinshin.energyprice.TWO_STAGE_START";
    public static final String ACTION_STOP = "com.chinshin.energyprice.TWO_STAGE_STOP";
    public static final String ACTION_CAPTURE_DETAIL = "com.chinshin.energyprice.TWO_STAGE_DETAIL";
    public static final String ACTION_CAPTURE_PAYMENT = "com.chinshin.energyprice.TWO_STAGE_PAYMENT";
    public static final String ACTION_STATUS_CHANGED = "com.chinshin.energyprice.TWO_STAGE_STATUS";
    public static final String EXTRA_RESULT_CODE = "result_code";
    public static final String EXTRA_RESULT_DATA = "result_data";
    public static final String EXTRA_STATUS = "status";

    private static final String CHANNEL_ID = "two_stage_screen_capture";
    private static final int NOTIFICATION_ID = 1301;
    private static final int BURST_FRAME_COUNT = 3;
    private static final long FRAME_GAP_MS = 330L;
    private static final long OVERLAY_HIDE_DELAY_MS = 320L;
    private static final long CAPTURE_TIMEOUT_MS = 10000L;
    private static final double PRICE_MATCH_TOLERANCE = 0.08d;

    private static volatile boolean running;
    private static volatile String lastStatus = "未启动两阶段截屏";

    private enum Mode { DETAIL, PAYMENT }

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final ExecutorService ocrExecutor = Executors.newSingleThreadExecutor();
    private final AtomicBoolean ocrBusy = new AtomicBoolean(false);
    private final AtomicBoolean captureInProgress = new AtomicBoolean(false);
    private final AtomicBoolean stopping = new AtomicBoolean(false);
    private final AtomicInteger pendingFrames = new AtomicInteger(0);
    private final Map<String, List<FuelCapture>> stationCandidates = new LinkedHashMap<>();
    private final Set<String> savedCandidateIdentities = new HashSet<>();

    private HandlerThread captureThread;
    private Handler captureHandler;
    private TextRecognizer recognizer;
    private MediaProjection projection;
    private VirtualDisplay virtualDisplay;
    private ImageReader imageReader;
    private long lastFrameAt;
    private String lastPublishedStatus;
    private Mode currentMode;
    private FuelCapture burstCapture;
    private String currentStationKey;
    private Double currentDisplayPrice;

    private WindowManager overlayWindowManager;
    private View overlayView;
    private TextView overlayStatus;
    private WindowManager.LayoutParams overlayParams;
    private boolean overlayAdded;

    private final Runnable captureTimeout = () -> {
        if (!captureInProgress.compareAndSet(true, false)) return;
        pendingFrames.set(0);
        ocrBusy.set(false);
        burstCapture = null;
        showOverlay();
        publishStatus("截屏超时，请保持页面静止后重试");
    };

    public static boolean isRunning() {
        return running;
    }

    public static String lastStatus() {
        return lastStatus;
    }

    public static Intent startIntent(Context context, int resultCode, Intent resultData) {
        return new Intent(context, TwoStageFloatingCaptureService.class)
                .setAction(ACTION_START)
                .putExtra(EXTRA_RESULT_CODE, resultCode)
                .putExtra(EXTRA_RESULT_DATA, resultData);
    }

    public static Intent stopIntent(Context context) {
        return new Intent(context, TwoStageFloatingCaptureService.class).setAction(ACTION_STOP);
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
        captureThread = new HandlerThread("energy-price-two-stage-capture");
        captureThread.start();
        captureHandler = new Handler(captureThread.getLooper());
        recognizer = TextRecognition.getClient(new ChineseTextRecognizerOptions.Builder().build());
        SecureConfigStore.importProvisioningIfPresent(this);
        SyncScheduler.ensurePeriodic(this);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) return START_NOT_STICKY;
        String action = intent.getAction();
        if (ACTION_STOP.equals(action)) {
            stopCapture("两阶段悬浮截屏已停止");
            return START_NOT_STICKY;
        }
        if (ACTION_CAPTURE_DETAIL.equals(action)) {
            requestCapture(Mode.DETAIL);
            return START_NOT_STICKY;
        }
        if (ACTION_CAPTURE_PAYMENT.equals(action)) {
            requestCapture(Mode.PAYMENT);
            return START_NOT_STICKY;
        }
        if (!ACTION_START.equals(action)) return START_NOT_STICKY;

        startForeground(NOTIFICATION_ID, buildNotification("正在启动两阶段悬浮截屏"));
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
        stationCandidates.clear();
        savedCandidateIdentities.clear();
        currentStationKey = null;
        currentDisplayPrice = null;

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
                "EnergyPriceTwoStageCapture",
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
        publishStatus("已启动：详情页点“详情”，支付页点“支付”");
    }

    private void requestCapture(Mode mode) {
        if (!running || projection == null) {
            publishStatus("截屏服务未启动");
            return;
        }
        if (!captureInProgress.compareAndSet(false, true)) {
            publishStatus("正在识别上一组截图，请稍候");
            return;
        }
        currentMode = mode;
        burstCapture = null;
        pendingFrames.set(0);
        lastFrameAt = 0L;
        hideOverlay();
        publishStatus(mode == Mode.DETAIL ? "正在识别详情页，请保持页面静止" : "正在识别支付页，请保持页面静止");
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
            analyze(bitmap, currentMode);
        } catch (Exception e) {
            ocrBusy.set(false);
            publishStatus("截屏处理失败: " + safeMessage(e));
            finishCaptureBurst();
        } finally {
            if (image != null) image.close();
        }
    }

    private void analyze(Bitmap fullBitmap, Mode mode) {
        Bitmap focusCrop = mode == Mode.PAYMENT ? createPaymentCrop(fullBitmap) : null;
        recognizer.process(InputImage.fromBitmap(fullBitmap, 0))
                .addOnSuccessListener(ocrExecutor, fullText -> {
                    List<String> lines = linesFromOcr(fullText, fullBitmap);
                    if (focusCrop == null) {
                        finishFrame(fullBitmap, null, lines, mode);
                        return;
                    }
                    recognizer.process(InputImage.fromBitmap(focusCrop, 0))
                            .addOnSuccessListener(ocrExecutor, cropText -> lines.addAll(plainLinesFromOcr(cropText)))
                            .addOnFailureListener(ocrExecutor, ignored -> { })
                            .addOnCompleteListener(ocrExecutor, task -> finishFrame(fullBitmap, focusCrop, lines, mode));
                })
                .addOnFailureListener(ocrExecutor, error -> {
                    recycle(fullBitmap);
                    recycle(focusCrop);
                    ocrBusy.set(false);
                    publishStatus("OCR失败: " + safeMessage(error));
                    if (pendingFrames.get() <= 0) finishCaptureBurst();
                });
    }

    private void finishFrame(Bitmap fullBitmap, Bitmap focusCrop, List<String> lines, Mode mode) {
        try {
            FuelCapture parsed = FuelStationParser.parse(dedupe(lines), System.currentTimeMillis());
            if (mode == Mode.DETAIL) FuelCaptureRules.prepareDetail(parsed);
            else FuelCaptureRules.preparePayment(parsed);
            burstCapture = burstCapture == null ? parsed : mergePreservingExplicitGrade(burstCapture, parsed);
        } catch (Exception e) {
            publishStatus("字段解析失败: " + safeMessage(e));
        } finally {
            recycle(fullBitmap);
            recycle(focusCrop);
            ocrBusy.set(false);
        }
        if (pendingFrames.get() <= 0) finishCaptureBurst();
    }

    private void finishCaptureBurst() {
        if (!captureInProgress.compareAndSet(true, false)) return;
        pendingFrames.set(0);
        captureHandler.removeCallbacks(captureTimeout);
        FuelCapture captured = burstCapture;
        Mode mode = currentMode;
        burstCapture = null;
        if (captured == null) {
            publishStatus("截图成功，但未识别到文字");
        } else if (mode == Mode.DETAIL) {
            commitDetail(captured);
        } else {
            commitPayment(captured);
        }
        showOverlay();
    }

    private void commitDetail(FuelCapture detail) {
        FuelCaptureRules.prepareDetail(detail);
        if (!notBlank(detail.stationName)) {
            publishStatus("详情页未识别到油站名称，请调整页面后重试");
            return;
        }
        if (detail.displayPrice == null) {
            publishStatus(detail.stationName + "：详情页未识别到外显价");
            return;
        }

        String stationKey = resolveStationKey(detail.stationName, true);
        List<FuelCapture> candidates = stationCandidates.computeIfAbsent(stationKey, ignored -> new ArrayList<>());
        int index = findCandidateIndex(candidates, detail.displayPrice);
        if (index < 0 && candidates.size() >= 2) {
            publishStatus(detail.stationName + "：已存在两档价格，请先完成当前油站或重启采集");
            return;
        }
        FuelCapture merged;
        if (index >= 0) {
            merged = mergePreservingExplicitGrade(candidates.get(index), detail);
            candidates.set(index, merged);
        } else {
            merged = detail;
            candidates.add(merged);
        }
        currentStationKey = stationKey;
        currentDisplayPrice = merged.displayPrice;

        int inferred = DisplayPriceGradeResolver.resolve(candidates);
        int saved = saveReadyCandidates(stationKey, candidates);
        String grade = gradeText(merged);
        String stationPrice = merged.stationPrice == null ? "油站价待补" : String.format(Locale.CHINA, "油站价%.2f", merged.stationPrice);
        String message = "详情已缓存：" + merged.stationName + " " + grade
                + " 外显价" + formatPrice(merged.displayPrice) + " " + stationPrice;
        if (inferred > 0) message += "；已按低价92#/高价95#配对";
        if (saved > 0) message += "；已补全并保存" + saved + "条";
        else if (!hasResolvedGrade(merged)) message += "；待同站另一档价格判定油号";
        publishStatus(message);
    }

    private void commitPayment(FuelCapture payment) {
        FuelCaptureRules.preparePayment(payment);
        String stationKey = resolveStationKey(payment.stationName, false);
        if (!notBlank(stationKey)) stationKey = currentStationKey;
        if (!notBlank(stationKey)) {
            publishStatus("支付页未匹配到油站，请先在详情页点击“详情”");
            return;
        }
        List<FuelCapture> candidates = stationCandidates.computeIfAbsent(stationKey, ignored -> new ArrayList<>());
        Double displayPrice = payment.displayPrice != null ? payment.displayPrice : currentDisplayPrice;
        int index = findCandidateIndex(candidates, displayPrice);
        if (index < 0 && currentDisplayPrice != null) index = findCandidateIndex(candidates, currentDisplayPrice);
        if (index < 0) {
            publishStatus("支付页未匹配到已缓存外显价，请先在对应详情页点击“详情”");
            return;
        }

        FuelCapture base = candidates.get(index);
        if (!notBlank(payment.stationName)) payment.stationName = base.stationName;
        if (payment.displayPrice == null) payment.displayPrice = base.displayPrice;
        payment.amountYuan = 200;
        payment.paymentPage = true;
        FuelCapture merged = mergePreservingExplicitGrade(base, payment);
        merged.paymentPage = true;
        merged.amountYuan = 200;
        Double derivedFee = FuelCaptureRules.deriveServiceFee(200, merged.discountAmount, merged.payableAmount);
        if (derivedFee != null) merged.serviceFee = derivedFee;
        candidates.set(index, merged);
        currentStationKey = stationKey;
        currentDisplayPrice = merged.displayPrice;

        int inferred = DisplayPriceGradeResolver.resolve(candidates);
        int saved = saveReadyCandidates(stationKey, candidates);
        StringBuilder message = new StringBuilder("支付已合并：")
                .append(merged.stationName).append(' ').append(gradeText(merged));
        if (merged.discountAmount != null) message.append(" 优惠").append(formatPrice(merged.discountAmount));
        if (merged.payableAmount != null) message.append(" 实付").append(formatPrice(merged.payableAmount));
        if (merged.serviceFee != null) message.append(" 服务费").append(formatPrice(merged.serviceFee));
        if (notBlank(merged.providerName)) message.append(" CP ").append(merged.providerName);
        if (inferred > 0) message.append("；已按低价92#/高价95#配对");
        if (saved > 0) message.append("；已保存").append(saved).append("条");
        else message.append("；").append(missingText(merged, candidates.size()));
        publishStatus(message.toString());
    }

    private int saveReadyCandidates(String stationKey, List<FuelCapture> candidates) {
        int saved = 0;
        for (FuelCapture capture : candidates) {
            if (!capture.isCompleteForSubmission()) continue;
            if (!FuelCaptureRules.paymentMathIsConsistent(capture)) continue;
            String identity = stationKey + "|" + capture.stableIdentity();
            if (savedCandidateIdentities.contains(identity)) continue;
            try {
                CaptureRecord record = MobileSourcePayloadFactory.createRecord(this, capture);
                long id = EnergyDatabase.get(this).insert(record);
                if (id <= 0) continue;
                savedCandidateIdentities.add(identity);
                saved++;
                SyncScheduler.enqueue(this);
                sendBroadcast(new Intent(MainActivity.ACTION_DATA_CHANGED).setPackage(getPackageName()));
                String toast = capture.stationName + " " + capture.gradeCode + "# 已记录";
                ContextCompat.getMainExecutor(this).execute(() -> Toast.makeText(this, toast, Toast.LENGTH_LONG).show());
            } catch (Exception e) {
                publishStatus("记录失败: " + safeMessage(e));
            }
        }
        return saved;
    }

    private String resolveStationKey(String stationName, boolean create) {
        String normalized = FuelCaptureRules.normalizeStationName(stationName);
        if (normalized.isEmpty()) return create ? normalized : null;
        if (stationCandidates.containsKey(normalized)) return normalized;
        for (String existing : stationCandidates.keySet()) {
            if (existing.contains(normalized) || normalized.contains(existing)) return existing;
        }
        return create ? normalized : normalized;
    }

    private static int findCandidateIndex(List<FuelCapture> candidates, Double displayPrice) {
        if (displayPrice == null) return -1;
        int best = -1;
        double bestGap = Double.MAX_VALUE;
        for (int i = 0; i < candidates.size(); i++) {
            FuelCapture candidate = candidates.get(i);
            if (candidate.displayPrice == null) continue;
            double gap = Math.abs(candidate.displayPrice - displayPrice);
            if (gap <= PRICE_MATCH_TOLERANCE && gap < bestGap) {
                best = i;
                bestGap = gap;
            }
        }
        return best;
    }

    private static FuelCapture mergePreservingExplicitGrade(FuelCapture older, FuelCapture newer) {
        if (older == null) return newer == null ? null : newer.copy();
        if (newer == null) return older.copy();
        FuelCapture merged = older.merge(newer);
        if (newer.gradeExplicit && hasResolvedGrade(newer)) {
            merged.gradeCode = newer.gradeCode;
            merged.gradeLabel = newer.gradeLabel;
            merged.gradeExplicit = true;
        } else if (older.gradeExplicit && hasResolvedGrade(older)) {
            merged.gradeCode = older.gradeCode;
            merged.gradeLabel = older.gradeLabel;
            merged.gradeExplicit = true;
        }
        return merged;
    }

    private static String missingText(FuelCapture capture, int stationPriceCount) {
        List<String> missing = new ArrayList<>();
        if (!notBlank(capture.stationName)) missing.add("站名");
        if (!hasResolvedGrade(capture)) {
            missing.add(stationPriceCount < 2 ? "同站第二档外显价" : "油号冲突");
        }
        if (capture.stationPrice == null) missing.add("详情页油站价");
        if (capture.displayPrice == null) missing.add("外显价");
        if (capture.discountAmount == null) missing.add("加200省金额");
        if (capture.payableAmount == null) missing.add("最终实付");
        if (capture.serviceFee == null) missing.add("服务费计算");
        if (!notBlank(capture.providerName)) missing.add("CP名");
        if (!notBlank(capture.providerEvidenceText)) missing.add("CP证据");
        return missing.isEmpty() ? "字段完整，等待保存" : "待补 " + String.join("/", missing);
    }

    private static String gradeText(FuelCapture capture) {
        if (hasResolvedGrade(capture)) return capture.gradeCode + "#" + (capture.gradeExplicit ? "" : "(价格推断)");
        return "油号待配对";
    }

    private static boolean hasResolvedGrade(FuelCapture capture) {
        return capture != null && ("92".equals(capture.gradeCode) || "95".equals(capture.gradeCode));
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
        background.setColor(Color.argb(232, 28, 31, 38));
        background.setCornerRadius(dp(14));
        root.setBackground(background);

        overlayStatus = new TextView(this);
        overlayStatus.setTextColor(Color.WHITE);
        overlayStatus.setTextSize(12f);
        overlayStatus.setMaxLines(6);
        overlayStatus.setMaxWidth(dp(330));
        overlayStatus.setPadding(dp(4), 0, dp(4), dp(5));
        root.addView(overlayStatus, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
        ));

        LinearLayout actions = new LinearLayout(this);
        actions.setOrientation(LinearLayout.HORIZONTAL);
        actions.setGravity(Gravity.CENTER_VERTICAL);

        Button detail = new Button(this);
        detail.setText("详情");
        detail.setTextSize(13f);
        detail.setOnClickListener(v -> requestCapture(Mode.DETAIL));
        actions.addView(detail, new LinearLayout.LayoutParams(dp(88), dp(48)));

        Button payment = new Button(this);
        payment.setText("支付");
        payment.setTextSize(13f);
        payment.setOnClickListener(v -> requestCapture(Mode.PAYMENT));
        LinearLayout.LayoutParams paymentParams = new LinearLayout.LayoutParams(dp(88), dp(48));
        paymentParams.leftMargin = dp(5);
        actions.addView(payment, paymentParams);

        Button stop = new Button(this);
        stop.setText("停止");
        stop.setTextSize(13f);
        stop.setOnClickListener(v -> stopCapture("两阶段悬浮截屏已停止"));
        LinearLayout.LayoutParams stopParams = new LinearLayout.LayoutParams(dp(72), dp(48));
        stopParams.leftMargin = dp(5);
        actions.addView(stop, stopParams);
        root.addView(actions);

        overlayParams = new WindowManager.LayoutParams(
                WindowManager.LayoutParams.WRAP_CONTENT,
                WindowManager.LayoutParams.WRAP_CONTENT,
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
                PixelFormat.TRANSLUCENT
        );
        overlayParams.gravity = Gravity.TOP | Gravity.END;
        overlayParams.x = dp(10);
        overlayParams.y = dp(190);

        overlayStatus.setOnTouchListener(new View.OnTouchListener() {
            private int startX;
            private int startY;
            private float downX;
            private float downY;

            @Override
            public boolean onTouch(View v, MotionEvent event) {
                switch (event.getActionMasked()) {
                    case MotionEvent.ACTION_DOWN:
                        startX = overlayParams.x;
                        startY = overlayParams.y;
                        downX = event.getRawX();
                        downY = event.getRawY();
                        return true;
                    case MotionEvent.ACTION_MOVE:
                        int dx = Math.round(event.getRawX() - downX);
                        int dy = Math.round(event.getRawY() - downY);
                        overlayParams.x = Math.max(0, startX - dx);
                        overlayParams.y = Math.max(0, startY + dy);
                        if (overlayAdded) overlayWindowManager.updateViewLayout(root, overlayParams);
                        return true;
                    case MotionEvent.ACTION_UP:
                    case MotionEvent.ACTION_CANCEL:
                        return true;
                    default:
                        return false;
                }
            }
        });
        overlayView = root;
    }

    private void updateOverlayStatus(String status) {
        if (overlayStatus == null) return;
        overlayStatus.setText(status == null || status.trim().isEmpty() ? "等待详情页或支付页截屏" : status);
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

    private static Bitmap createPaymentCrop(Bitmap source) {
        if (source == null || source.getWidth() < 2 || source.getHeight() < 2) return null;
        int top = Math.max(0, (int) (source.getHeight() * 0.56f));
        int bottom = Math.min(source.getHeight(), (int) (source.getHeight() * 0.998f));
        int height = bottom - top;
        if (height < 2) return null;
        Bitmap crop = Bitmap.createBitmap(source, 0, top, source.getWidth(), height);
        float scale = Math.min(2.5f, 2700f / Math.max(1f, crop.getWidth()));
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
                        gradeCandidates.add(new VisualCandidate(grade, blueScore(bitmap, box)));
                    }
                }
            }
        }
        VisualCandidate selectedGrade = selectedCandidate(gradeCandidates, 6, 3);
        if (selectedGrade != null) out.add("__SELECTED__ " + selectedGrade.value + "#");
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

    private static int blueScore(Bitmap bitmap, Rect source) {
        int left = Math.max(0, source.left - Math.max(16, source.width() / 3));
        int right = Math.min(bitmap.getWidth(), source.right + Math.max(16, source.width() / 3));
        int top = Math.max(0, source.top - 4);
        int bottom = Math.min(bitmap.getHeight(), source.bottom + Math.max(30, source.height()));
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
        if (source != null) {
            for (String value : source) {
                if (value != null && !value.trim().isEmpty()) values.add(value.trim());
            }
        }
        return new ArrayList<>(values);
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
        PendingIntent stop = PendingIntent.getService(
                this,
                1,
                stopIntent(this),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_launcher_foreground)
                .setContentTitle("油价两阶段截屏")
                .setContentText(text)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
                .setContentIntent(openApp)
                .addAction(0, "停止", stop)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .build();
    }

    private void createNotificationChannel() {
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "两阶段截屏采集",
                NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription("高德详情页与支付页手动截屏OCR");
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        manager.createNotificationChannel(channel);
    }

    private void stopCapture(String reason) {
        if (!stopping.compareAndSet(false, true)) return;
        running = false;
        captureInProgress.set(false);
        pendingFrames.set(0);
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

    private static String formatPrice(Double value) {
        return value == null ? "--" : String.format(Locale.CHINA, "%.2f", value);
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
