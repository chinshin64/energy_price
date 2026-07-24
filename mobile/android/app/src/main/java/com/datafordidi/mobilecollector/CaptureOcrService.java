package com.datafordidi.mobilecollector;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.Bitmap;
import android.graphics.PixelFormat;
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
import android.util.DisplayMetrics;
import android.util.Log;
import android.view.WindowManager;

import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.Text;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.chinese.ChineseTextRecognizerOptions;

import java.nio.ByteBuffer;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

public class CaptureOcrService extends Service {
    public static final String EXTRA_RESULT_CODE = "resultCode";
    public static final String EXTRA_RESULT_DATA = "resultData";

    private static final String TAG = "DataForDidiCollector";
    private static final String CHANNEL_ID = "collector";
    private static final long DETAIL_CAPTURE_DELAY_MS = 1200L;
    private static final long DETAIL_RETRY_DELAY_MS = 900L;
    private static final long DETAIL_BACK_DELAY_MS = 800L;
    private static final int MAX_DETAIL_CANDIDATES_PER_PAGE = 4;
    private static volatile boolean runningState = false;

    private HandlerThread workerThread;
    private Handler worker;
    private MediaProjection mediaProjection;
    private VirtualDisplay virtualDisplay;
    private ImageReader imageReader;
    private TextRecognizer recognizer;
    private final SyncClient syncClient = new SyncClient();
    private final AiSupervisor aiSupervisor = new AiSupervisor();
    private FloatingStopOverlay floatingStopOverlay;
    private TestRunRecorder recorder;
    private String sessionId;
    private int pageIndex = 0;
    private boolean running = false;
    private boolean paused = false;
    private boolean detailPending = false;
    private int detailSourcePageIndex = -1;
    private int detailCaptureAttempt = 0;
    private final List<OcrRow> pendingDetailCandidates = new ArrayList<>();
    private final Set<String> visitedDetailKeys = new HashSet<>();
    private final Runnable captureRunnable = this::captureOnce;
    private final BroadcastReceiver controlReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (intent == null || intent.getAction() == null) {
                return;
            }
            handleControlAction(intent.getAction());
        }
    };

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
        workerThread = new HandlerThread("mobile-ocr-worker");
        workerThread.start();
        worker = new Handler(workerThread.getLooper());
        recognizer = TextRecognition.getClient(new ChineseTextRecognizerOptions.Builder().build());
        sessionId = "android-" + System.currentTimeMillis();
        recorder = new TestRunRecorder(this, sessionId);
        registerControlReceiver();
    }

    public static boolean isRunningState() {
        return runningState;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        startForeground(7, buildNotification("采集中"));
        showFloatingStopOverlay();
        if (intent == null) {
            runningState = false;
            stopSelf();
            return START_NOT_STICKY;
        }

        int resultCode = intent.getIntExtra(EXTRA_RESULT_CODE, 0);
        Intent resultData = intent.getParcelableExtra(EXTRA_RESULT_DATA);
        MediaProjectionManager manager = (MediaProjectionManager) getSystemService(MEDIA_PROJECTION_SERVICE);
        mediaProjection = manager.getMediaProjection(resultCode, resultData);
        mediaProjection.registerCallback(new MediaProjection.Callback() {
            @Override
            public void onStop() {
                stopCapture();
            }
        }, worker);

        setupVirtualDisplay();
        running = true;
        runningState = true;
        paused = false;
        Log.i(TAG, "capture service started session=" + sessionId
                + " city=" + CollectorSettings.getCity(this)
                + " maxPages=" + CollectorSettings.getMaxPages(this)
                + " interval=" + CollectorSettings.getMinIntervalMillis(this)
                + "-" + CollectorSettings.getMaxIntervalMillis(this)
                + " server=" + CollectorSettings.getServerUrl(this));
        worker.postDelayed(captureRunnable, 1800);
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        hideFloatingStopOverlay();
        stopCapture();
        unregisterControlReceiver();
        if (recognizer != null) {
            recognizer.close();
        }
        if (workerThread != null) {
            workerThread.quitSafely();
        }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void setupVirtualDisplay() {
        DisplayMetrics metrics = new DisplayMetrics();
        WindowManager windowManager = (WindowManager) getSystemService(WINDOW_SERVICE);
        windowManager.getDefaultDisplay().getRealMetrics(metrics);

        imageReader = ImageReader.newInstance(
                metrics.widthPixels,
                metrics.heightPixels,
                PixelFormat.RGBA_8888,
                2
        );

        virtualDisplay = mediaProjection.createVirtualDisplay(
                "data-for-didi-mobile-ocr",
                metrics.widthPixels,
                metrics.heightPixels,
                metrics.densityDpi,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                imageReader.getSurface(),
                null,
                worker
        );
    }

    private void captureOnce() {
        if (!running) {
            return;
        }
        if (paused) {
            return;
        }

        int maxPages = CollectorSettings.getMaxPages(this);
        if (maxPages > 0 && pageIndex >= maxPages) {
            Log.i(TAG, "max pages reached page=" + pageIndex + " maxPages=" + maxPages);
            stopSelf();
            return;
        }

        Image image = null;
        Bitmap bitmap = null;
        try {
            image = imageReader.acquireLatestImage();
            if (image == null) {
                Log.i(TAG, "capture image unavailable; scheduling retry page=" + pageIndex);
                scheduleNext();
                return;
            }
            bitmap = bitmapFromImage(image);
            String hash = hashBitmap(bitmap);
            InputImage inputImage = InputImage.fromBitmap(bitmap, 0);
            Bitmap finalBitmap = bitmap;
            recognizer.process(inputImage)
                    .addOnSuccessListener(text -> {
                        List<OcrRow> rows = buildRows(text, finalBitmap.getWidth(), finalBitmap.getHeight());
                        Log.i(TAG, "ocr success page=" + pageIndex + " rows=" + rows.size() + " hash=" + hash);
                        worker.post(() -> {
                            try {
                                handleOcrRows(rows, hash, finalBitmap);
                            } finally {
                                finalBitmap.recycle();
                            }
                        });
                    })
                    .addOnFailureListener(error -> {
                        Log.e(TAG, "OCR failed", error);
                        finalBitmap.recycle();
                        scheduleNext();
                    });
        } catch (Exception error) {
            Log.e(TAG, "capture failed", error);
            scheduleNext();
        } finally {
            if (image != null) {
                image.close();
            }
        }
    }

    private void handleOcrRows(List<OcrRow> rows, String hash, Bitmap bitmap) {
        if (!running || paused) {
            Log.i(TAG, "skip ocr rows running=" + running + " paused=" + paused);
            return;
        }
        if (detailPending) {
            Log.i(TAG, "handle detail ocr rows=" + safeRowCount(rows) + " page=" + pageIndex);
            handleDetailOcrSuccess(rows, hash, bitmap);
            return;
        }
        if (dismissGeoPermissionPrompt(rows)) {
            Log.i(TAG, "geo permission prompt dismissed page=" + pageIndex);
            scheduleNext();
            return;
        }
        if (dismissBlockingOpenPrompt(rows)) {
            Log.i(TAG, "blocking open prompt dismissed page=" + pageIndex);
            scheduleNext();
            return;
        }

        List<DidiLocalStationParser.StationRecord> localStations = extractLocalStations(rows, "phone-auto-scroll");
        Log.i(TAG, "handle list ocr page=" + pageIndex
                + " rows=" + safeRowCount(rows)
                + " localStations=" + localStations.size()
                + " shouldBackOut=" + shouldBackOut(rows));
        AiSupervisor.Decision decision = evaluateSupervisor(rows, "phone-auto-scroll", hash, localStations.size(), bitmap);
        if (applySupervisorDecision(decision, false)) {
            return;
        }
        if (decision != null && decision.pageType == AiSupervisor.PageType.DETAIL) {
            List<DidiLocalStationParser.StationRecord> detailStations = extractLocalStations(rows, "phone-detail");
            try {
                String result = syncClient.uploadOcrRows(
                        this,
                        sessionId,
                        pageIndex,
                        pageIndex,
                        hash + "-detail-direct",
                        rows,
                        "phone-detail"
                );
                Log.i(TAG, "direct detail sync success: " + result);
            } catch (Exception error) {
                Log.e(TAG, "direct detail sync failed", error);
            }
            uploadLocalStations(detailStations, "phone-detail");
            AutoScrollAccessibilityService.requestBack();
            pageIndex += 1;
            if (CollectorSettings.getMaxPages(this) > 0 && pageIndex >= CollectorSettings.getMaxPages(this)) {
                stopSelf();
            } else {
                scheduleNext();
            }
            return;
        }

        if (shouldBackOut(rows)) {
            Log.i(TAG, "page guard requested back page=" + pageIndex);
            AutoScrollAccessibilityService.requestBack();
        } else {
            try {
                String result = syncClient.uploadOcrRows(
                        this,
                        sessionId,
                        pageIndex,
                        pageIndex,
                        hash,
                        rows,
                        "phone-auto-scroll"
                );
                Log.i(TAG, "sync success: " + result);
            } catch (Exception error) {
                Log.e(TAG, "sync failed", error);
            }
            uploadLocalStations(localStations, "phone-auto-scroll");

            if (CollectorSettings.isDetailEnrichmentEnabled(this)) {
                pendingDetailCandidates.clear();
                pendingDetailCandidates.addAll(findDetailCandidates(rows));
            }
            if (tapNextDetailCandidate()) {
                worker.postDelayed(captureRunnable, DETAIL_CAPTURE_DELAY_MS);
                return;
            }

            AutoScrollAccessibilityService.requestScrollForward();
            pageIndex += 1;
        }
        scheduleNext();
    }

    private void handleDetailOcrSuccess(List<OcrRow> rows, String hash, Bitmap bitmap) {
        if (dismissGeoPermissionPrompt(rows)) {
            worker.postDelayed(captureRunnable, DETAIL_RETRY_DELAY_MS);
            return;
        }
        if (dismissBlockingOpenPrompt(rows)) {
            worker.postDelayed(captureRunnable, DETAIL_RETRY_DELAY_MS);
            return;
        }
        List<DidiLocalStationParser.StationRecord> localStations = extractLocalStations(rows, "phone-detail");
        AiSupervisor.Decision decision = evaluateSupervisor(rows, "phone-detail", hash, localStations.size(), bitmap);
        if (applySupervisorDecision(decision, true)) {
            return;
        }

        if (PageGuard.shouldBackOut(rows)) {
            Log.w(TAG, "detail candidate opened a blocking page; backing out");
            finishDetailCapture(true);
            return;
        }

        if (!DetailPageGuard.isDetailReady(rows)) {
            detailCaptureAttempt += 1;
            if (detailCaptureAttempt < DetailPageGuard.MAX_DETAIL_CAPTURE_ATTEMPTS) {
                Log.i(TAG, "detail page not ready, retry " + detailCaptureAttempt);
                worker.postDelayed(captureRunnable, DETAIL_RETRY_DELAY_MS);
                return;
            }

            boolean stillListPage = DetailPageGuard.looksLikeListPage(rows);
            Log.w(TAG, "detail page not ready after retries; stillListPage=" + stillListPage);
            finishDetailCapture(!stillListPage);
            return;
        }

        try {
            String result = syncClient.uploadOcrRows(
                    this,
                    sessionId,
                    detailSourcePageIndex >= 0 ? detailSourcePageIndex : pageIndex,
                    pageIndex,
                    hash + "-detail",
                    rows,
                    "phone-detail"
            );
            Log.i(TAG, "detail sync success: " + result);
        } catch (Exception error) {
            Log.e(TAG, "detail sync failed", error);
        }
        uploadLocalStations(localStations, "phone-detail");

        finishDetailCapture(true);
    }

    private List<DidiLocalStationParser.StationRecord> extractLocalStations(List<OcrRow> rows, String sourceStage) {
        try {
            String pkgName = AutoScrollAccessibilityService.getCurrentPackageName();
            if ("com.autonavi.minimap".equals(pkgName)) {
                return AmapStationParser.extract(rows, sourceStage);
            }
            return DidiLocalStationParser.extract(rows, sourceStage);
        } catch (Exception error) {
            Log.e(TAG, "local station parse failed", error);
            return new ArrayList<>();
        }
    }

    private void uploadLocalStations(List<DidiLocalStationParser.StationRecord> stations, String sourceStage) {
        int sourcePageIndex = detailSourcePageIndex >= 0 ? detailSourcePageIndex : pageIndex;
        List<String> localKeys = LocalStationStore.upsertPage(this, sessionId, sourcePageIndex, stations);
        try {
            if (stations == null || stations.isEmpty()) {
                Log.i(TAG, "skip local station sync: empty stage=" + sourceStage + " page=" + pageIndex);
                return;
            }
            String result = syncClient.uploadStations(
                    this,
                    sessionId,
                    sourcePageIndex,
                    stations,
                    sourceStage
            );
            LocalStationStore.markSync(this, localKeys, true, "47 MySQL 已落库，等待主产品增量同步");
            Log.i(TAG, "local station sync success: " + result);
        } catch (Exception error) {
            LocalStationStore.markSync(this, localKeys, false, error.getMessage());
            Log.e(TAG, "local station sync failed", error);
        }
    }

    private AiSupervisor.Decision evaluateSupervisor(
            List<OcrRow> rows,
            String sourceStage,
            String hash,
            int localStationCount,
            Bitmap bitmap
    ) {
        AiSupervisor.Decision decision = aiSupervisor.analyze(
                this,
                sessionId,
                pageIndex,
                sourceStage,
                hash,
                rows,
                localStationCount,
                detailPending
        );
        if (recorder != null) {
            recorder.recordFrame(pageIndex, sourceStage, hash, rows, decision, bitmap);
        }
        try {
            AiSupervisor.Decision serverDecision = syncClient.uploadSupervisorEvent(this, sessionId, pageIndex, sourceStage, decision, rows);
            if (serverDecision != null) {
                decision = serverDecision;
            }
            Log.i(TAG, "supervisor sync success: " + decision.action + " / " + decision.reason);
        } catch (Exception error) {
            Log.w(TAG, "supervisor sync failed: " + error.getMessage());
        }
        Log.i(TAG, "supervisor decision: " + decision.pageType + " -> " + decision.action + " / " + decision.reason);
        return decision;
    }

    private boolean applySupervisorDecision(AiSupervisor.Decision decision, boolean fromDetail) {
        if (decision == null || decision.action == null || decision.action == AiSupervisor.Action.NONE) {
            return false;
        }
        if (decision.action == AiSupervisor.Action.WAIT) {
            scheduleNext();
            return true;
        }
        if (decision.action == AiSupervisor.Action.STOP) {
            stopSelf();
            return true;
        }
        if (decision.action == AiSupervisor.Action.BACK) {
            if (fromDetail) {
                finishDetailCapture(true);
            } else {
                AutoScrollAccessibilityService.requestBack();
                scheduleNext();
            }
            return true;
        }
        if (decision.action == AiSupervisor.Action.SCROLL) {
            if (fromDetail) {
                finishDetailCapture(false);
            } else {
                AutoScrollAccessibilityService.requestScrollForward();
                pageIndex += 1;
                scheduleNext();
            }
            return true;
        }
        return false;
    }

    private void finishDetailCapture(boolean backBeforeContinue) {
        detailPending = false;
        detailSourcePageIndex = -1;
        detailCaptureAttempt = 0;
        if (backBeforeContinue) {
            AutoScrollAccessibilityService.requestBack();
        }
        worker.postDelayed(() -> {
            if (!running || paused) {
                return;
            }
            if (tapNextDetailCandidate()) {
                worker.postDelayed(captureRunnable, DETAIL_CAPTURE_DELAY_MS);
                return;
            }
            AutoScrollAccessibilityService.requestScrollForward();
            pageIndex += 1;
            scheduleNext();
        }, backBeforeContinue ? DETAIL_BACK_DELAY_MS : 150L);
    }

    private List<OcrRow> buildRows(Text text, int width, int height) {
        List<OcrRow> rows = new ArrayList<>();
        for (Text.TextBlock block : text.getTextBlocks()) {
            for (Text.Line line : block.getLines()) {
                android.graphics.Rect box = line.getBoundingBox();
                if (box == null) {
                    continue;
                }
                rows.add(new OcrRow(
                        line.getText(),
                        1f,
                        box.left / (float) width,
                        box.top / (float) height,
                        Math.max(0, box.width()) / (float) width,
                        Math.max(0, box.height()) / (float) height
                ));
            }
        }
        return rows;
    }

    private boolean shouldBackOut(List<OcrRow> rows) {
        return PageGuard.shouldBackOut(rows);
    }

    private List<OcrRow> findDetailCandidates(List<OcrRow> rows) {
        List<OcrRow> candidates = new ArrayList<>();
        if (!AutoScrollAccessibilityService.isReady()) {
            return candidates;
        }
        for (OcrRow row : rows) {
            String text = row.text.replaceAll("\\s+", "");
            if (!isStationTitleCandidate(row, text, rows)) {
                continue;
            }
            if (!isSafeDetailTapArea(row)) {
                continue;
            }
            String detailKey = normalizeDetailKey(text);
            if (detailKey.isEmpty() || visitedDetailKeys.contains(detailKey)) {
                continue;
            }
            visitedDetailKeys.add(detailKey);
            candidates.add(row);
            if (candidates.size() >= MAX_DETAIL_CANDIDATES_PER_PAGE) {
                break;
            }
        }
        return candidates;
    }

    private boolean dismissGeoPermissionPrompt(List<OcrRow> rows) {
        if (rows == null || rows.isEmpty()) {
            return false;
        }
        StringBuilder text = new StringBuilder();
        for (OcrRow row : rows) {
            text.append(row.text.replaceAll("\\s+", ""));
        }
        String compact = text.toString();
        boolean didiGeoPrompt = compact.contains("需要获取你的地理位置") || compact.contains("获取你的地理位置");
        boolean wechatGeoPrompt = compact.contains("申请获取你的位置权限")
                || compact.contains("位置权限")
                || (compact.contains("拒绝") && compact.contains("允许"));
        if (!didiGeoPrompt && !wechatGeoPrompt) {
            return false;
        }
        if (wechatGeoPrompt && compact.contains("拒绝")) {
            if (!AutoScrollAccessibilityService.requestClickText("拒绝", false)) {
                AutoScrollAccessibilityService.requestTap(0.30f, 0.58f);
            }
            return true;
        }
        if (!compact.contains("否") && !compact.contains("取消")) {
            return false;
        }
        if (!AutoScrollAccessibilityService.requestClickText("否", false)) {
            AutoScrollAccessibilityService.requestTap(0.30f, 0.61f);
        }
        return true;
    }

    private boolean dismissBlockingOpenPrompt(List<OcrRow> rows) {
        if (rows == null || rows.isEmpty()) {
            return false;
        }
        StringBuilder text = new StringBuilder();
        for (OcrRow row : rows) {
            text.append(row.text.replaceAll("\\s+", ""));
        }
        String compact = text.toString();
        boolean openPrompt = (compact.contains("即将打开") || compact.contains("将打开"))
                && (compact.contains("取消") || compact.contains("允许") || compact.contains("小程序"));
        if (!openPrompt) {
            return false;
        }
        if (!AutoScrollAccessibilityService.requestClickText("取消", false)) {
            AutoScrollAccessibilityService.requestTap(0.30f, 0.55f);
        }
        return true;
    }

    private boolean tapNextDetailCandidate() {
        while (!pendingDetailCandidates.isEmpty()) {
            OcrRow candidate = pendingDetailCandidates.remove(0);
            if (AutoScrollAccessibilityService.requestTap(tapX(candidate), tapY(candidate))) {
                detailPending = true;
                detailSourcePageIndex = pageIndex;
                detailCaptureAttempt = 0;
                return true;
            }
        }
        return false;
    }

    private boolean isStationTitleCandidate(OcrRow row, String text, List<OcrRow> rows) {
        if (text == null || text.length() < 4) {
            return false;
        }
        if (row.y < 0.20f || row.x > 0.72f) {
            return false;
        }
        boolean hasChargingWord = text.contains("充电") || text.contains("超充") || text.contains("快充") || text.contains("电站");
        boolean looksLikeStationName = text.length() >= 5
                && text.length() <= 42
                && text.matches(".*[\\u4e00-\\u9fa5].*")
                && row.width > 0.35f;
        if (!hasChargingWord && (!looksLikeStationName || !hasNearbyStationSignals(row, rows))) {
            return false;
        }
        return !text.matches("^[¥￥]?\\d.*")
                && !text.contains("登录")
                && !text.contains("首页")
                && !text.contains("我的")
                && !text.contains("超时")
                && !text.contains("停车")
                && !text.contains("优惠")
                && !text.contains("余额")
                && !text.contains("订单")
                && !text.contains("会员")
                && !text.contains("须知")
                && !text.contains("费用")
                && !text.contains("福利")
                && !text.contains("活动")
                && !text.contains("奖励")
                && !text.contains("补充车辆")
                && !text.contains("免费充电")
                && !text.contains("开始充电")
                && !text.contains("搜索附近")
                && !text.contains("搜索")
                && !text.contains("附近")
                && !text.contains("地图")
                && !text.contains("筛选")
                && !text.contains("广告")
                && !text.contains("跳过")
                && !text.contains("近期最大")
                && !text.contains("分钟前有人充过")
                && !text.contains("服务费")
                && !text.contains("场站优惠")
                && !text.contains("停车减免")
                && !text.contains("闲");
    }

    private boolean hasNearbyStationSignals(OcrRow row, List<OcrRow> rows) {
        if (rows == null) {
            return false;
        }
        StringBuilder band = new StringBuilder();
        for (OcrRow item : rows) {
            if (item == row) {
                continue;
            }
            if (item.y > row.y && item.y < row.y + 0.16f) {
                band.append(item.text.replaceAll("\\s+", "")).append(' ');
            }
        }
        String text = band.toString();
        return text.matches(".*[¥￥]?\\d+(\\.\\d+)?\\s*/\\s*度.*")
                || text.matches(".*(超|快|慢)?闲\\d+\\s*/\\s*\\d+.*");
    }

    private boolean isTruncated(String text) {
        return text.contains("..") || text.contains("…");
    }

    private String normalizeDetailKey(String text) {
        return String.valueOf(text == null ? "" : text)
                .replaceAll("\\s+", "")
                .replaceAll("[\\.。…]+$", "")
                .trim();
    }

    private boolean isSafeDetailTapArea(OcrRow row) {
        float centerY = row.y + row.height / 2f;
        return centerY >= 0.24f && centerY <= 0.74f;
    }

    private float tapX(OcrRow row) {
        return Math.max(0.18f, Math.min(0.82f, row.x + row.width / 2f));
    }

    private float tapY(OcrRow row) {
        return Math.max(0.12f, Math.min(0.88f, row.y + row.height / 2f));
    }

    private Bitmap bitmapFromImage(Image image) {
        Image.Plane[] planes = image.getPlanes();
        ByteBuffer buffer = planes[0].getBuffer();
        int pixelStride = planes[0].getPixelStride();
        int rowStride = planes[0].getRowStride();
        int width = image.getWidth();
        int height = image.getHeight();
        int rowPadding = rowStride - pixelStride * width;
        Bitmap padded = Bitmap.createBitmap(width + rowPadding / pixelStride, height, Bitmap.Config.ARGB_8888);
        padded.copyPixelsFromBuffer(buffer);
        Bitmap cropped = Bitmap.createBitmap(padded, 0, 0, width, height);
        padded.recycle();
        return cropped;
    }

    private String hashBitmap(Bitmap bitmap) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            digest.update((byte) bitmap.getWidth());
            digest.update((byte) bitmap.getHeight());
            ByteBuffer buffer = ByteBuffer.allocate(bitmap.getByteCount());
            bitmap.copyPixelsToBuffer(buffer);
            byte[] bytes = digest.digest(buffer.array());
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < Math.min(8, bytes.length); i++) {
                sb.append(String.format("%02x", bytes[i]));
            }
            return sb.toString();
        } catch (Exception error) {
            return "screen-" + System.currentTimeMillis();
        }
    }

    private void scheduleNext() {
        if (!running || paused) {
            return;
        }
        int delay = CollectorSettings.getRandomIntervalMillis(this);
        Log.i(TAG, "schedule next capture delayMs=" + delay + " nextPage=" + pageIndex);
        worker.postDelayed(captureRunnable, delay);
    }

    private int safeRowCount(List<OcrRow> rows) {
        return rows == null ? 0 : rows.size();
    }

    private void stopCapture() {
        running = false;
        runningState = false;
        paused = false;
        detailPending = false;
        detailSourcePageIndex = -1;
        detailCaptureAttempt = 0;
        pendingDetailCandidates.clear();
        if (worker != null) {
            worker.removeCallbacks(captureRunnable);
        }
        if (virtualDisplay != null) {
            virtualDisplay.release();
            virtualDisplay = null;
        }
        if (imageReader != null) {
            imageReader.close();
            imageReader = null;
        }
        if (mediaProjection != null) {
            MediaProjection projection = mediaProjection;
            mediaProjection = null;
            projection.stop();
        }
    }

    private Notification buildNotification(String text) {
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);
        return builder
                .setContentTitle("手机场站采集")
                .setContentText(text)
                .setSmallIcon(android.R.drawable.ic_menu_camera)
                .setOngoing(true)
                .build();
    }

    private void showFloatingStopOverlay() {
        floatingStopOverlay = new FloatingStopOverlay(this);
        floatingStopOverlay.show("采集中");
    }

    private void hideFloatingStopOverlay() {
        if (floatingStopOverlay != null) {
            floatingStopOverlay.hide();
            floatingStopOverlay = null;
        }
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "DataForDidi Collector",
                NotificationManager.IMPORTANCE_LOW
        );
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.createNotificationChannel(channel);
    }

    private void handleControlAction(String action) {
        if (CollectorControlActions.ACTION_STOP.equals(action)) {
            stopSelf();
            return;
        }
        if (worker == null) {
            return;
        }
        worker.post(() -> {
            if (!running) {
                return;
            }
            if (CollectorControlActions.ACTION_PAUSE.equals(action)) {
                paused = true;
                worker.removeCallbacks(captureRunnable);
                return;
            }
            if (CollectorControlActions.ACTION_RESUME.equals(action)) {
                if (paused) {
                    paused = false;
                    worker.removeCallbacks(captureRunnable);
                    worker.post(captureRunnable);
                }
                return;
            }
            if (CollectorControlActions.ACTION_RESTART.equals(action)) {
                pageIndex = 0;
                sessionId = "android-" + System.currentTimeMillis();
                recorder = new TestRunRecorder(this, sessionId);
                paused = false;
                detailPending = false;
                detailSourcePageIndex = -1;
                detailCaptureAttempt = 0;
                pendingDetailCandidates.clear();
                visitedDetailKeys.clear();
                worker.removeCallbacks(captureRunnable);
                worker.postDelayed(captureRunnable, 300);
            }
        });
    }

    private void registerControlReceiver() {
        IntentFilter filter = new IntentFilter();
        filter.addAction(CollectorControlActions.ACTION_PAUSE);
        filter.addAction(CollectorControlActions.ACTION_RESUME);
        filter.addAction(CollectorControlActions.ACTION_RESTART);
        filter.addAction(CollectorControlActions.ACTION_STOP);
        registerReceiver(
                controlReceiver,
                filter,
                CollectorControlActions.INTERNAL_PERMISSION,
                worker,
                Context.RECEIVER_NOT_EXPORTED
        );
    }

    private void unregisterControlReceiver() {
        try {
            unregisterReceiver(controlReceiver);
        } catch (Exception ignored) {
            // Service may be destroyed after receiver registration failed or was already removed.
        }
    }
}
