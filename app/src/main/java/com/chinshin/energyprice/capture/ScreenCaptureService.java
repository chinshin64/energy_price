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
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.view.WindowManager;
import android.view.WindowMetrics;
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
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Screen-only collector. It uses MediaProjection and does not require AccessibilityService.
 * The user grants Android's screen-capture consent once for each running capture session.
 */
public final class ScreenCaptureService extends Service {
    public static final String ACTION_START = "com.chinshin.energyprice.START_SCREEN_CAPTURE";
    public static final String ACTION_STOP = "com.chinshin.energyprice.STOP_SCREEN_CAPTURE";
    public static final String ACTION_STATUS_CHANGED = "com.chinshin.energyprice.CAPTURE_STATUS_CHANGED";
    public static final String EXTRA_RESULT_CODE = "result_code";
    public static final String EXTRA_RESULT_DATA = "result_data";
    public static final String EXTRA_STATUS = "status";

    private static final String CHANNEL_ID = "screen_capture";
    private static final int NOTIFICATION_ID = 1001;
    private static final long FRAME_GAP_MS = 1100L;

    private static volatile boolean running;
    private static volatile String lastStatus = "未开始截屏采集";

    private final ExecutorService ocrExecutor = Executors.newSingleThreadExecutor();
    private final AtomicBoolean ocrBusy = new AtomicBoolean(false);

    private HandlerThread captureThread;
    private Handler captureHandler;
    private TextRecognizer recognizer;
    private CaptureSessionState state;
    private MediaProjection projection;
    private VirtualDisplay virtualDisplay;
    private ImageReader imageReader;
    private long lastFrameAt;
    private String lastOcrHash;
    private String lastPublishedStatus;

    public static boolean isRunning() {
        return running;
    }

    public static String lastStatus() {
        return lastStatus;
    }

    public static Intent startIntent(Context context, int resultCode, Intent resultData) {
        return new Intent(context, ScreenCaptureService.class)
                .setAction(ACTION_START)
                .putExtra(EXTRA_RESULT_CODE, resultCode)
                .putExtra(EXTRA_RESULT_DATA, resultData);
    }

    public static Intent stopIntent(Context context) {
        return new Intent(context, ScreenCaptureService.class).setAction(ACTION_STOP);
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
        captureThread = new HandlerThread("energy-price-screen-capture");
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
        if (ACTION_STOP.equals(intent.getAction())) {
            stopCapture("截屏采集已停止");
            return START_NOT_STICKY;
        }
        if (!ACTION_START.equals(intent.getAction())) return START_NOT_STICKY;

        startForeground(NOTIFICATION_ID, buildNotification("正在启动截屏采集"));
        int resultCode = intent.getIntExtra(EXTRA_RESULT_CODE, Activity.RESULT_CANCELED);
        Intent resultData = intent.getParcelableExtra(EXTRA_RESULT_DATA);
        if (resultCode != Activity.RESULT_OK || resultData == null) {
            stopCapture("未获得截屏授权");
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
        releaseProjection();
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

        imageReader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 3);
        imageReader.setOnImageAvailableListener(this::onImageAvailable, captureHandler);
        virtualDisplay = projection.createVirtualDisplay(
                "EnergyPriceScreenCapture",
                width,
                height,
                densityDpi,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                imageReader.getSurface(),
                null,
                captureHandler
        );
        running = true;
        publishStatus("截屏采集中，请切换到高德并操作 92#/95#、200 元及支付页");
    }

    private void onImageAvailable(ImageReader reader) {
        Image image = null;
        try {
            image = reader.acquireLatestImage();
            if (image == null) return;
            long now = System.currentTimeMillis();
            if (now - lastFrameAt < FRAME_GAP_MS || !ocrBusy.compareAndSet(false, true)) return;
            lastFrameAt = now;
            Bitmap bitmap = imageToBitmap(image);
            if (bitmap == null) {
                ocrBusy.set(false);
                return;
            }
            analyze(bitmap);
        } catch (Exception e) {
            ocrBusy.set(false);
            publishStatus("截屏处理失败: " + safeMessage(e));
        } finally {
            if (image != null) image.close();
        }
    }

    private void analyze(Bitmap bitmap) {
        recognizer.process(InputImage.fromBitmap(bitmap, 0))
                .addOnSuccessListener(ocrExecutor, text -> {
                    List<String> lines = linesFromOcr(text, bitmap);
                    String hash = FuelStationParser.sha256(String.join("\n", lines));
                    if (!hash.equals(lastOcrHash)) {
                        lastOcrHash = hash;
                        processLines(lines);
                    }
                })
                .addOnFailureListener(ocrExecutor, error -> publishStatus("OCR 失败: " + safeMessage(error)))
                .addOnCompleteListener(ocrExecutor, task -> {
                    bitmap.recycle();
                    ocrBusy.set(false);
                });
    }

    private void processLines(List<String> source) {
        if (source == null || source.isEmpty() || state == null) {
            publishStatus("已截屏，当前画面未识别到文字");
            return;
        }
        List<String> lines = dedupe(source);
        FuelCapture partial = FuelStationParser.parse(lines, System.currentTimeMillis());
        FuelCapture merged = state.merge(partial);
        if (merged == null) {
            publishStatus("已识别文字，等待油站页面");
            return;
        }
        publishStatus(statusFor(merged));
        if (!merged.isCompleteForSubmission()) return;
        long now = System.currentTimeMillis();
        if (!state.shouldSave(merged, now)) return;
        try {
            CaptureRecord record = MobileSourcePayloadFactory.createRecord(this, merged);
            long id = EnergyDatabase.get(this).insert(record);
            if (id > 0) {
                state.markSaved(merged, now);
                SyncScheduler.enqueue(this);
                sendBroadcast(new Intent(MainActivity.ACTION_DATA_CHANGED).setPackage(getPackageName()));
                publishStatus(merged.stationName + " " + merged.gradeCode + "# 已记录");
                ContextCompat.getMainExecutor(this).execute(() -> Toast.makeText(
                        this,
                        merged.stationName + " " + merged.gradeCode + "# 已记录",
                        Toast.LENGTH_SHORT
                ).show());
            }
        } catch (Exception e) {
            publishStatus("记录失败: " + safeMessage(e));
        }
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
                    if (token.matches("(?:¥|￥)?200(?:\\.00)?(?:元)?")) {
                        amountCandidates.add(new VisualCandidate("200", blueScore(bitmap, box, false)));
                    }
                }
            }
        }

        VisualCandidate selectedGrade = bestCandidate(gradeCandidates);
        if (selectedGrade != null && selectedGrade.score >= 3) {
            out.add("__SELECTED__ " + selectedGrade.value + "#");
        }
        VisualCandidate selectedAmount = bestCandidate(amountCandidates);
        if (selectedAmount != null && selectedAmount.score >= 3) {
            out.add("__SELECTED__ ¥200");
        }
        return out;
    }

    private static VisualCandidate bestCandidate(List<VisualCandidate> candidates) {
        VisualCandidate best = null;
        for (VisualCandidate candidate : candidates) {
            if (best == null || candidate.score > best.score) best = candidate;
        }
        return best;
    }

    private static int blueScore(Bitmap bitmap, Rect source, boolean grade) {
        int xPad = grade ? Math.max(18, source.width() / 2) : Math.max(70, source.width());
        int topPad = grade ? 4 : Math.max(12, source.height() / 2);
        int bottomPad = grade ? Math.max(24, source.height()) : Math.max(20, source.height());
        int left = Math.max(0, source.left - xPad);
        int right = Math.min(bitmap.getWidth(), source.right + xPad);
        int top = Math.max(0, source.top - topPad);
        int bottom = Math.min(bitmap.getHeight(), source.bottom + bottomPad);
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
        if (capture.resolvedStationPrice() != null) found.add(String.format(Locale.CHINA, "油站价 %.2f", capture.resolvedStationPrice()));
        if (capture.resolvedDisplayPrice() != null) found.add(String.format(Locale.CHINA, "外显价 %.2f", capture.resolvedDisplayPrice()));
        if (capture.discountAmount != null) found.add(String.format(Locale.CHINA, "优惠 %.2f", capture.discountAmount));
        if (capture.serviceFee != null) found.add(String.format(Locale.CHINA, "服务费 %.2f", capture.serviceFee));
        if (notBlank(capture.providerName)) found.add("CP " + capture.providerName);
        if (found.isEmpty()) return "已截屏，等待高德加油页面";

        List<String> missing = new ArrayList<>();
        if (!notBlank(capture.stationName)) missing.add("站名");
        if (!("92".equals(capture.gradeCode) || "95".equals(capture.gradeCode))) missing.add("油号");
        if (capture.amountYuan == null || capture.amountYuan != 200) missing.add("200元");
        if (capture.resolvedDisplayPrice() == null) missing.add("外显价");
        if (capture.discountAmount == null) missing.add("优惠金额");
        if (capture.serviceFee == null) missing.add("服务费");
        if (!notBlank(capture.providerName)) missing.add("CP");
        String suffix = missing.isEmpty() ? "" : "；待补 " + String.join("/", missing);
        return String.join(" · ", found) + suffix;
    }

    private void publishStatus(String status) {
        if (status == null || status.trim().isEmpty()) return;
        lastStatus = status;
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
                .setContentTitle("油价截屏采集")
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
                "截屏采集",
                NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription("高德加油页面截屏 OCR 采集状态");
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        manager.createNotificationChannel(channel);
    }

    private void stopCapture(String reason) {
        running = false;
        lastStatus = reason;
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

    private static boolean notBlank(String value) {
        return value != null && !value.trim().isEmpty();
    }

    private static String safeMessage(Throwable error) {
        if (error == null || error.getMessage() == null || error.getMessage().trim().isEmpty()) {
            return "未知错误";
        }
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
