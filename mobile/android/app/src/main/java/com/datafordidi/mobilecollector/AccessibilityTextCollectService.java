package com.datafordidi.mobilecollector;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.util.Log;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

public class AccessibilityTextCollectService extends Service {
    private static final String TAG = "DataForDidiTextCollect";
    private static final String CHANNEL_ID = "collector_text";
    private static final long DETAIL_COLLECT_DELAY_MS = 1000L;
    private static final long DETAIL_RETRY_DELAY_MS = 800L;
    private static final long DETAIL_BACK_DELAY_MS = 800L;
    private static volatile boolean runningState = false;

    private HandlerThread workerThread;
    private Handler worker;
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
    private int detailCollectAttempt = 0;
    private final List<OcrRow> pendingDetailCandidates = new ArrayList<>();
    private final Set<String> visitedDetailKeys = new HashSet<>();
    private final Runnable collectRunnable = this::collectOnce;
    private final BroadcastReceiver controlReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (intent == null || intent.getAction() == null) {
                return;
            }
            handleControlAction(intent.getAction());
        }
    };

    public static boolean isRunningState() {
        return runningState;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
        workerThread = new HandlerThread("accessibility-text-worker");
        workerThread.start();
        worker = new Handler(workerThread.getLooper());
        sessionId = "android-a11y-" + System.currentTimeMillis();
        recorder = new TestRunRecorder(this, sessionId);
        registerControlReceiver();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        startForeground(8, buildNotification("采集中"));
        showFloatingStopOverlay();
        running = true;
        runningState = true;
        paused = false;
        worker.postDelayed(collectRunnable, 500);
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        hideFloatingStopOverlay();
        running = false;
        runningState = false;
        paused = false;
        detailPending = false;
        detailSourcePageIndex = -1;
        detailCollectAttempt = 0;
        pendingDetailCandidates.clear();
        visitedDetailKeys.clear();
        unregisterControlReceiver();
        if (worker != null) {
            worker.removeCallbacks(collectRunnable);
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

    private void collectOnce() {
        if (!running) {
            return;
        }
        if (paused) {
            return;
        }

        int maxPages = CollectorSettings.getMaxPages(this);
        if (maxPages > 0 && pageIndex >= maxPages) {
            stopSelf();
            return;
        }

        List<OcrRow> rows = AutoScrollAccessibilityService.collectVisibleTextRows();
        if (rows.isEmpty()) {
            Log.w(TAG, "no visible text rows; accessibility may be disabled or target page hides text nodes");
            scheduleNext();
            return;
        }

        if (detailPending) {
            handleDetailRows(rows);
            return;
        }

        if (dismissGeoPermissionPrompt(rows) || dismissBlockingOpenPrompt(rows)) {
            scheduleNext();
            return;
        }

        List<DidiLocalStationParser.StationRecord> localStations = extractLocalStations(rows, "phone-auto-scroll");
        AiSupervisor.Decision decision = evaluateSupervisor(rows, "phone-auto-scroll", "a11y-" + pageIndex, localStations.size());
        if (applySupervisorDecision(decision, false)) {
            return;
        }

        if (PageGuard.shouldBackOut(rows)) {
            AutoScrollAccessibilityService.requestBack();
        } else {
            uploadOcrWithScreenshot(rows, "phone-auto-scroll", "a11y-" + pageIndex);
            uploadLocalStations(localStations, "phone-auto-scroll");

            if (CollectorSettings.isDetailEnrichmentEnabled(this)) {
                pendingDetailCandidates.clear();
                pendingDetailCandidates.addAll(findDetailCandidates(rows));
            }
            if (tapNextDetailCandidate()) {
                worker.postDelayed(collectRunnable, DETAIL_COLLECT_DELAY_MS);
                return;
            }

            AutoScrollAccessibilityService.requestScrollForward();
            pageIndex += 1;
        }

        scheduleNext();
    }

    private void handleDetailRows(List<OcrRow> rows) {
        if (dismissGeoPermissionPrompt(rows) || dismissBlockingOpenPrompt(rows)) {
            worker.postDelayed(collectRunnable, DETAIL_RETRY_DELAY_MS);
            return;
        }

        List<DidiLocalStationParser.StationRecord> localStations = extractLocalStations(rows, "phone-detail");
        AiSupervisor.Decision decision = evaluateSupervisor(rows, "phone-detail", "a11y-detail-" + pageIndex, localStations.size());
        if (applySupervisorDecision(decision, true)) {
            return;
        }

        if (PageGuard.shouldBackOut(rows)) {
            Log.w(TAG, "detail candidate opened a blocking page; backing out");
            finishDetailCollect(true);
            return;
        }

        if (!DetailPageGuard.isDetailReady(rows)) {
            detailCollectAttempt += 1;
            if (detailCollectAttempt < DetailPageGuard.MAX_DETAIL_CAPTURE_ATTEMPTS) {
                Log.i(TAG, "detail page not ready, retry " + detailCollectAttempt);
                worker.postDelayed(collectRunnable, DETAIL_RETRY_DELAY_MS);
                return;
            }

            boolean stillListPage = DetailPageGuard.looksLikeListPage(rows);
            Log.w(TAG, "detail page not ready after retries; stillListPage=" + stillListPage);
            finishDetailCollect(!stillListPage);
            return;
        }

        uploadOcrWithScreenshot(rows, "phone-detail", "a11y-detail-" + pageIndex);
        uploadLocalStations(localStations, "phone-detail");

        finishDetailCollect(true);
    }

    private List<DidiLocalStationParser.StationRecord> extractLocalStations(List<OcrRow> rows, String sourceStage) {
        try {
            String packageName = AutoScrollAccessibilityService.getCurrentPackageName();
            if ("com.autonavi.minimap".equals(packageName)) {
                return AmapStationParser.extract(rows, sourceStage);
            }
            return DidiLocalStationParser.extract(rows, sourceStage);
        } catch (Exception error) {
            Log.e(TAG, "local station parse failed", error);
            return new ArrayList<>();
        }
    }

    private void uploadLocalStations(List<DidiLocalStationParser.StationRecord> stations, String sourceStage) {
        try {
            if (stations == null || stations.isEmpty()) {
                return;
            }
            String result = syncClient.uploadStations(
                    this,
                    sessionId,
                    detailSourcePageIndex >= 0 ? detailSourcePageIndex : pageIndex,
                    stations,
                    sourceStage
            );
            Log.i(TAG, "local station sync success: " + result);
        } catch (Exception error) {
            Log.e(TAG, "local station sync failed", error);
        }
    }

    private AiSupervisor.Decision evaluateSupervisor(
            List<OcrRow> rows,
            String sourceStage,
            String hash,
            int localStationCount
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
            recorder.recordFrame(pageIndex, sourceStage, hash, rows, decision, null);
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
                finishDetailCollect(true);
            } else {
                AutoScrollAccessibilityService.requestBack();
                scheduleNext();
            }
            return true;
        }
        if (decision.action == AiSupervisor.Action.SCROLL) {
            if (fromDetail) {
                finishDetailCollect(false);
            } else {
                AutoScrollAccessibilityService.requestScrollForward();
                pageIndex += 1;
                scheduleNext();
            }
            return true;
        }
        return false;
    }

    private void finishDetailCollect(boolean backBeforeContinue) {
        detailPending = false;
        detailSourcePageIndex = -1;
        detailCollectAttempt = 0;
        if (backBeforeContinue) {
            AutoScrollAccessibilityService.requestBack();
        }
        worker.postDelayed(() -> {
            if (!running || paused) {
                return;
            }
            if (tapNextDetailCandidate()) {
                worker.postDelayed(collectRunnable, DETAIL_COLLECT_DELAY_MS);
                return;
            }
            AutoScrollAccessibilityService.requestScrollForward();
            pageIndex += 1;
            scheduleNext();
        }, backBeforeContinue ? DETAIL_BACK_DELAY_MS : 150L);
    }

    private void scheduleNext() {
        if (!running || paused) {
            return;
        }
        worker.postDelayed(collectRunnable, CollectorSettings.getRandomIntervalMillis(this));
    }

    private Notification buildNotification(String text) {
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);
        return builder
                .setContentTitle("手机场站采集")
                .setContentText(text)
                .setSmallIcon(android.R.drawable.ic_menu_view)
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
                "DataForDidi Text Collector",
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
                worker.removeCallbacks(collectRunnable);
                return;
            }
            if (CollectorControlActions.ACTION_RESUME.equals(action)) {
                if (paused) {
                    paused = false;
                    worker.removeCallbacks(collectRunnable);
                    worker.post(collectRunnable);
                }
                return;
            }
            if (CollectorControlActions.ACTION_RESTART.equals(action)) {
                pageIndex = 0;
                sessionId = "android-a11y-" + System.currentTimeMillis();
                recorder = new TestRunRecorder(this, sessionId);
                paused = false;
                detailPending = false;
                detailSourcePageIndex = -1;
                detailCollectAttempt = 0;
                pendingDetailCandidates.clear();
                visitedDetailKeys.clear();
                worker.removeCallbacks(collectRunnable);
                worker.postDelayed(collectRunnable, 300);
            }
        });
    }

    private List<OcrRow> findDetailCandidates(List<OcrRow> rows) {
        List<OcrRow> candidates = new ArrayList<>();
        for (OcrRow row : rows) {
            String text = row.text.replaceAll("\\s+", "");
            if (!isStationTitleCandidate(row, text)) {
                continue;
            }
            if (!isSafeDetailTapArea(row)) {
                continue;
            }
            String detailKey = normalizeDetailKey(text);
            if (detailKey.isEmpty() || visitedDetailKeys.contains(detailKey)) {
                continue;
            }
            if (!isTruncated(text) && !isIncompleteListBand(row, rows)) {
                continue;
            }
            visitedDetailKeys.add(detailKey);
            candidates.add(row);
            if (candidates.size() >= 4) {
                break;
            }
        }
        return candidates;
    }

    private boolean tapNextDetailCandidate() {
        while (!pendingDetailCandidates.isEmpty()) {
            OcrRow candidate = pendingDetailCandidates.remove(0);
            if (AutoScrollAccessibilityService.requestTap(tapX(candidate), tapY(candidate))) {
                detailPending = true;
                detailSourcePageIndex = pageIndex;
                detailCollectAttempt = 0;
                return true;
            }
        }
        return false;
    }

    private boolean isStationTitleCandidate(OcrRow row, String text) {
        if (text == null || text.length() < 4) {
            return false;
        }
        if (row.y < 0.20f || row.x > 0.72f) {
            return false;
        }
        boolean hasChargingWord = text.contains("充电") || text.contains("超充") || text.contains("快充");
        boolean looksLikeStationName = text.length() >= 5
                && text.length() <= 42
                && text.matches(".*[\\u4e00-\\u9fa5].*")
                && row.width > 0.35f;
        if (!hasChargingWord && !looksLikeStationName) {
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

    private boolean isTruncated(String text) {
        return text.contains("...") || text.contains("…");
    }

    private boolean isIncompleteListBand(OcrRow row, List<OcrRow> rows) {
        String band = buildBandText(row, rows);
        boolean hasPrice = band.matches(".*[¥￥]?\\d+(\\.\\d+)?\\s*/\\s*(度|千瓦时|kWh|KWH).*");
        boolean hasPorts = band.matches(".*(超|快|慢)?\\s*(闲|空闲)\\s*\\d+\\s*/\\s*\\d+.*");
        boolean hasAddress = band.matches(".*(省|市|区|县|镇|路|街|道|号|栋|楼|大厦|广场|园区|停车场|地下).*")
                && !band.contains("停车减免")
                && !band.contains("超时占用费");
        return !hasPrice || !hasPorts || !hasAddress;
    }

    private String buildBandText(OcrRow row, List<OcrRow> rows) {
        StringBuilder band = new StringBuilder(row.text.replaceAll("\\s+", ""));
        if (rows != null) {
            for (OcrRow item : rows) {
                if (item == row) {
                    continue;
                }
                if (item.y > row.y && item.y < row.y + 0.18f) {
                    band.append(' ').append(item.text.replaceAll("\\s+", ""));
                }
            }
        }
        return band.toString();
    }

    private String normalizeDetailKey(String text) {
        return String.valueOf(text == null ? "" : text)
                .replaceAll("\\s+", "")
                .replaceAll("[\\.。…]+$", "")
                .trim();
    }

    private boolean dismissGeoPermissionPrompt(List<OcrRow> rows) {
        String compact = compactRows(rows);
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
        String compact = compactRows(rows);
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

    private String compactRows(List<OcrRow> rows) {
        StringBuilder text = new StringBuilder();
        if (rows != null) {
            for (OcrRow row : rows) {
                text.append(row.text.replaceAll("\\s+", ""));
            }
        }
        return text.toString();
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

    private void uploadOcrWithScreenshot(List<OcrRow> rows, String sourceStage, String a11yHash) {
        String screenshotBase64 = null;
        // 仅 amap 平台截图补充价格/枪数（Canvas 自绘 View 无 accessibility 节点）
        boolean isAmap = "amap-charging".equals(CollectorSettings.getPlatform(this));
        if (isAmap && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            screenshotBase64 = AutoScrollAccessibilityService.takeScreenshotBase64(70);
        }
        try {
            String result = syncClient.uploadOcrRows(
                    this,
                    sessionId,
                    detailSourcePageIndex >= 0 ? detailSourcePageIndex : pageIndex,
                    pageIndex,
                    a11yHash,
                    rows,
                    sourceStage,
                    screenshotBase64
            );
            Log.i(TAG, "sync success: " + result);
        } catch (Exception error) {
            Log.e(TAG, "sync failed", error);
        }
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
            // Service may already have unregistered during shutdown.
        }
    }
}
