package com.datafordidi.mobilecollector;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.PixelFormat;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.SystemClock;
import android.util.DisplayMetrics;
import android.util.Log;
import android.view.WindowManager;

import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.Text;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.chinese.ChineseTextRecognizerOptions;

import org.json.JSONObject;

import java.nio.ByteBuffer;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

public final class OcrCaptureService extends Service {
    static final String ACTION_STOP = "com.datafordidi.ocruploader.STOP";
    static final String ACTION_RESULT_UPDATED = "com.datafordidi.ocruploader.RESULT_UPDATED";
    static final String ACTION_CAPTURE_READY = "com.datafordidi.ocruploader.CAPTURE_READY";
    static final String ACTION_CAPTURE_FAILED = "com.datafordidi.ocruploader.CAPTURE_FAILED";
    static final String EXTRA_STATUS = "status";
    static final String EXTRA_RESULT_CODE = "resultCode";
    static final String EXTRA_RESULT_DATA = "resultData";
    static final String EXTRA_START_NONCE = "startNonce";
    static final String EXTRA_SESSION_ID = "sessionId";

    private static final String TAG = "StandaloneOcr";
    private static final String CHANNEL_ID = "standalone_ocr_capture";
    private static final int NOTIFICATION_ID = 41;
    private static final String MANUAL_CAPTURE_SCOPE = "manual-screen-scope";
    private static final long PAGE_STABLE_SAMPLE_MS = 550L;
    private static final long PAGE_STABLE_TIMEOUT_MS = 8_000L;
    private static final long PAUSED_MONITOR_MS = 1_200L;
    private static final int MAX_NO_NEW_PAGES = 2;
    private static final long FIRST_FRAME_TIMEOUT_MS = 15_000L;
    private static volatile boolean runningState;
    private static volatile String readyStartNonce = "";

    private enum FlowState {
        WAITING_SCREEN,
        RECOGNIZING,
        SCROLLING,
        WAITING_STABLE,
        PAUSED
    }

    private final StationSyncClient syncClient = new StationSyncClient();
    private final ExecutorService uploadExecutor = Executors.newSingleThreadExecutor();
    private final AtomicBoolean uploadRunning = new AtomicBoolean();
    private final StationObservationTracker observationTracker = new StationObservationTracker();
    private final FuelObservationTracker fuelObservationTracker = new FuelObservationTracker();
    private final OwnAppResumeGate ownAppResumeGate = new OwnAppResumeGate();
    private HandlerThread workerThread;
    private Handler worker;
    private TextRecognizer recognizer;
    private MediaProjection mediaProjection;
    private VirtualDisplay virtualDisplay;
    private ImageReader imageReader;
    private String sessionId;
    private String lastRecognizedHash = "";
    private String pausedHash = "";
    private String pausedRawHash = "";
    private String nearChangeCandidateRawHash = "";
    private String stableCandidateHash = "";
    private String lockedTargetPackage = "";
    private long stableDeadline;
    private long pausedAt;
    private long sessionStartedAt;
    private long firstFrameDeadline;
    private int stableSamples;
    private int pageIndex;
    private int noNewPages;
    private int recognizedCount;
    private int frameReceivedCount;
    private int ocrAttemptCount;
    private int parsedStationCount;
    private int nearChangeStableSamples;
    private boolean hasCapturedFrame;
    private boolean forceOcrReview;
    private boolean waitingForOwnAppToHide;
    private boolean stopping;
    private boolean automaticScrollSession;
    private volatile String ocrStatus = "正在启动";
    private volatile String uploadStatus = "等待";
    private volatile String skipReason = "";
    private FlowState state = FlowState.WAITING_SCREEN;

    @Override
    public void onCreate() {
        super.onCreate();
        CaptureTransactionCoordinator.reconcile(this);
        ManualBackfillRepository.reconcile(this);
        BackfillRetryScheduler.schedule(this);
        createNotificationChannel();
        workerThread = new HandlerThread("standalone-ocr-worker");
        workerThread.start();
        worker = new Handler(workerThread.getLooper());
        recognizer = TextRecognition.getClient(new ChineseTextRecognizerOptions.Builder().build());
    }

    static boolean isRunning() {
        return runningState;
    }

    static boolean isReadyFor(String startNonce) {
        String value = startNonce == null ? "" : startNonce.trim();
        return !value.isEmpty() && runningState && value.equals(readyStartNonce);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            announceOcr("已停止");
            stopSelf();
            return START_NOT_STICKY;
        }
        String startNonce = intent == null ? "" : intent.getStringExtra(EXTRA_START_NONCE);
        if (runningState) {
            sendCaptureEvent(ACTION_CAPTURE_FAILED, startNonce);
            return START_NOT_STICKY;
        }
        boolean foregroundStarted = false;
        boolean callbackRegistered = false;
        try {
            startForeground(NOTIFICATION_ID, notification());
            foregroundStarted = true;
            if (intent == null || !intent.hasExtra(EXTRA_RESULT_DATA) || startNonce == null
                    || startNonce.trim().isEmpty()) {
                throw new IllegalArgumentException("missing capture authorization");
            }
            int resultCode = intent.getIntExtra(EXTRA_RESULT_CODE, 0);
            Intent resultData = intent.getParcelableExtra(EXTRA_RESULT_DATA);
            MediaProjectionManager manager = (MediaProjectionManager) getSystemService(MEDIA_PROJECTION_SERVICE);
            if (manager == null) throw new IllegalStateException("projection manager unavailable");
            mediaProjection = manager.getMediaProjection(resultCode, resultData);
            if (mediaProjection == null) throw new IllegalStateException("projection unavailable");
            mediaProjection.registerCallback(new MediaProjection.Callback() {
                @Override
                public void onStop() {
                    if (!stopping) finishSession("录屏已停止");
                }
            }, worker);
            callbackRegistered = true;

            setupDisplay();
            if (!CaptureInitializationPolicy.canSendReady(
                    foregroundStarted,
                    mediaProjection != null,
                    callbackRegistered,
                    imageReader != null,
                    virtualDisplay != null
            )) throw new IllegalStateException("capture resources unavailable");
            sessionId = "android-ocr-" + UUID.randomUUID();
            sessionStartedAt = SystemClock.elapsedRealtime();
            firstFrameDeadline = sessionStartedAt + FIRST_FRAME_TIMEOUT_MS;
            automaticScrollSession = AutoScrollAccessibilityService.isEnabled(this);
            runningState = true;
            state = FlowState.WAITING_SCREEN;
            readyStartNonce = startNonce.trim();
            sendCaptureEvent(ACTION_CAPTURE_READY, startNonce);
            uploadStatus = AppSettings.isUploadConfigured(this) ? "就绪" : "未配置";
            announceOcr("采集中");
            flushOutboxAsync();
            worker.postDelayed(this::captureForOcr, CaptureLaunchPolicy.FIRST_CAPTURE_DELAY_MS);
            worker.postDelayed(() -> {
                if (runningState) finishSession("已达到时长上限");
            }, CaptureSessionPolicy.MAX_DURATION_MS);
            return START_NOT_STICKY;
        } catch (RuntimeException error) {
            Log.e(TAG, "capture initialization failed", error);
            sendCaptureEvent(ACTION_CAPTURE_FAILED, startNonce);
            stopSelf();
            return START_NOT_STICKY;
        }
    }

    @Override
    public void onDestroy() {
        stopping = true;
        runningState = false;
        readyStartNonce = "";
        if (worker != null) worker.removeCallbacksAndMessages(null);
        if (virtualDisplay != null) virtualDisplay.release();
        virtualDisplay = null;
        if (imageReader != null) imageReader.close();
        imageReader = null;
        if (mediaProjection != null) mediaProjection.stop();
        mediaProjection = null;
        if (recognizer != null) recognizer.close();
        recognizer = null;
        uploadExecutor.shutdownNow();
        if (workerThread != null) workerThread.quitSafely();
        stopForeground(STOP_FOREGROUND_REMOVE);
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void setupDisplay() {
        DisplayMetrics metrics = new DisplayMetrics();
        WindowManager manager = (WindowManager) getSystemService(WINDOW_SERVICE);
        manager.getDefaultDisplay().getRealMetrics(metrics);
        imageReader = ImageReader.newInstance(
                metrics.widthPixels,
                metrics.heightPixels,
                PixelFormat.RGBA_8888,
                2
        );
        virtualDisplay = mediaProjection.createVirtualDisplay(
                "standalone-station-ocr",
                metrics.widthPixels,
                metrics.heightPixels,
                metrics.densityDpi,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                imageReader.getSurface(),
                null,
                worker
        );
        if (virtualDisplay == null) throw new IllegalStateException("virtual display unavailable");
    }

    private void captureForOcr() {
        if (!runningState || state == FlowState.RECOGNIZING || imageReader == null || !withinSessionLimits()) return;
        if (AppVisibilityState.isAppVisible()) {
            pauseForOwnApp();
            return;
        }
        String packageAtCapture = captureContextPackage();
        if (!lockedTargetPackage.isEmpty() && !lockedTargetPackage.equals(packageAtCapture)) {
            haltForPackageChange();
            return;
        }
        Bitmap bitmap = acquireBitmap();
        if (bitmap == null) {
            if (!hasCapturedFrame && SystemClock.elapsedRealtime() >= firstFrameDeadline) {
                finishSession("录屏无画面");
                return;
            }
            worker.postDelayed(this::captureForOcr, 500L);
            return;
        }
        String capturedAt = CaptureTime.nowUtc();
        String hash = screenHash(bitmap);
        String rawHash = rawFrameHash(bitmap);
        if (automaticScrollSession && !AutoScrollAccessibilityService.isAllowedTarget(packageAtCapture)) {
            bitmap.recycle();
            pauseAndMonitor(hash, rawHash, "等待场站页面");
            return;
        }
        if (!lastRecognizedHash.isEmpty()
                && !ScreenStabilityPolicy.meaningfullyChanged(hash, lastRecognizedHash)
                && !forceOcrReview) {
            bitmap.recycle();
            pauseAndMonitor(hash, rawHash, "页面未变化");
            return;
        }
        forceOcrReview = false;
        state = FlowState.RECOGNIZING;
        ocrAttemptCount++;
        skipReason = "";
        ocrStatus = "识别中";
        updateNotification();
        InputImage inputImage = InputImage.fromBitmap(bitmap, 0);
        recognizer.process(inputImage)
                .addOnSuccessListener(worker::post, text -> handleRecognition(
                        text,
                        bitmap,
                        hash,
                        rawHash,
                        packageAtCapture,
                        capturedAt
                ))
                .addOnFailureListener(worker::post, error -> {
                    Log.e(TAG, "OCR failed", error);
                    bitmap.recycle();
                    pauseAndMonitor(hash, rawHash, "识别失败");
                });
    }

    private void handleRecognition(
            Text text,
            Bitmap bitmap,
            String screenHash,
            String rawHash,
            String packageAtCapture,
            String capturedAt
    ) {
        try {
            if (AppVisibilityState.isAppVisible()) {
                pauseForOwnApp();
                return;
            }
            List<OcrRow> rows = rows(text, bitmap.getWidth(), bitmap.getHeight());
            if (ScreenContextResolver.isCollectorPage(rows)) {
                pauseAndMonitor(screenHash, rawHash, "等待场站页面");
                return;
            }
            boolean blockedPage = ScreenContextResolver.isBlockedPage(rows);
            if (blockedPage) {
                pauseAndMonitor(screenHash, rawHash, "敏感页面已暂停");
                return;
            }
            if (!contextStillMatches(packageAtCapture, screenHash)) {
                pauseAndMonitor(screenHash, rawHash, "页面已变化");
                return;
            }
            ScreenContextResolver.ParsedScreen parsed = ScreenContextResolver.resolve(
                    rows,
                    CaptureContextPolicy.parserPackage(automaticScrollSession, packageAtCapture),
                    automaticScrollSession ? "screen-ocr-auto-scroll" : "screen-ocr-manual-scroll"
            );
            if ("fuel".equals(parsed.stationType)) {
                for (FuelStationRecord station : parsed.fuelStations) {
                    station.capturedAt = CaptureTime.requireUtc(capturedAt);
                    station.sourceStage = "screen-ocr-user-driven";
                    station.captureMode = FuelQuoteFeatureGate.CAPTURE_MODE;
                    station.packageCategory = automaticScrollSession && packageAtCapture != null
                            && !packageAtCapture.trim().isEmpty() ? "target-app" : "manual-unavailable";
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
            } else {
                for (DidiLocalStationParser.StationRecord station : parsed.stations) {
                    station.capturedAt = CaptureTime.requireUtc(capturedAt);
                    station.captureMode = automaticScrollSession ? "automatic-scroll" : "manual-scroll";
                    station.packageCategory = automaticScrollSession && packageAtCapture != null
                            && !packageAtCapture.trim().isEmpty() ? "target-app" : "manual-unavailable";
                }
            }
            parsedStationCount += parsed.size();
            lastRecognizedHash = screenHash;
            int currentPage = pageIndex++;
            if (parsed.isEmpty()) {
                pauseAndMonitor(screenHash, rawHash, "未识别到场站");
                return;
            }

            if (CaptureContextPolicy.canLockRealPackage(automaticScrollSession, packageAtCapture)
                    && lockedTargetPackage.isEmpty()
                    && CaptureSafetyGate.canLockTarget(
                            packageAtCapture,
                            getPackageName(),
                            !parsed.isEmpty(),
                            blockedPage
                    )) {
                lockedTargetPackage = packageAtCapture;
            }
            if (automaticScrollSession && !lockedTargetPackage.equals(packageAtCapture)) {
                haltForPackageChange();
                return;
            }

            int changedCount;
            int rejectedUnsafeCount;
            if ("fuel".equals(parsed.stationType)) {
                List<FuelStationRecord> changedFuelCandidates = fuelObservationTracker.previewChanged(
                        sessionId, parsed.platform, parsed.city, parsed.fuelStations
                );
                StationSafetyPartition.Result<FuelStationRecord> partition =
                        StationSafetyPartition.fuel(changedFuelCandidates, parsed.city);
                List<FuelStationRecord> changedFuel = partition.safe;
                rejectedUnsafeCount = partition.rejectedCount;
                changedCount = changedFuel.size();
                if (!changedFuel.isEmpty() && !OutboxStore.hasCapacity(this)) {
                    pauseAndMonitor(screenHash, rawHash, "回传队列已满");
                    return;
                }
                if (!changedFuel.isEmpty()) {
                    if (!persistChangedFuel(parsed, changedFuel, currentPage, screenHash)) return;
                    fuelObservationTracker.commit(sessionId, parsed.platform, parsed.city, changedFuel);
                    recognizedCount += changedFuel.size();
                }
            } else {
                List<DidiLocalStationParser.StationRecord> changedStationCandidates =
                        observationTracker.previewChanged(
                        sessionId,
                        screenHash,
                        parsed.platform,
                        parsed.city,
                        parsed.stations
                );
                StationSafetyPartition.Result<DidiLocalStationParser.StationRecord> partition =
                        StationSafetyPartition.charging(changedStationCandidates, parsed.city);
                List<DidiLocalStationParser.StationRecord> changedStations = partition.safe;
                rejectedUnsafeCount = partition.rejectedCount;
                changedCount = changedStations.size();
                if (!changedStations.isEmpty() && !OutboxStore.hasCapacity(this)) {
                    pauseAndMonitor(screenHash, rawHash, "回传队列已满");
                    return;
                }
                if (!changedStations.isEmpty()) {
                    if (!persistChangedStations(parsed, changedStations, currentPage, screenHash)) return;
                    observationTracker.commit(
                            sessionId, screenHash, parsed.platform, parsed.city, changedStations
                    );
                    recognizedCount += changedStations.size();
                }
            }
            noNewPages = changedCount == 0 ? noNewPages + 1 : 0;
            skipReason = rejectedUnsafeCount > 0 ? "已过滤不安全记录" : "";
            if (rejectedUnsafeCount > 0 && changedCount == 0) {
                announceOcr("已过滤不安全记录");
            } else if (rejectedUnsafeCount > 0) {
                announceOcr("安全记录" + changedCount + "条");
            } else {
                announceOcr("识别" + parsed.size() + "条");
            }

            if (noNewPages >= MAX_NO_NEW_PAGES) {
                pauseAndMonitor(screenHash, rawHash, "连续无新增");
                return;
            }
            String expectedContext = automaticScrollSession ? lockedTargetPackage : MANUAL_CAPTURE_SCOPE;
            if (!contextStillMatches(expectedContext, screenHash)) {
                if (automaticScrollSession) haltForPackageChange();
                else pauseAndMonitor(screenHash, rawHash, "页面已变化");
                return;
            }
            if ("fuel".equals(parsed.stationType)) {
                pauseAndMonitor(
                        screenHash,
                        rawHash,
                        CaptureInteractionPolicy.manualSwitchHint(parsed.stationType)
                );
            } else {
                requestSafeScroll(parsed.stationType, screenHash, rawHash);
            }
        } catch (Exception error) {
            Log.e(TAG, "result persistence failed", error);
            pauseAndMonitor(screenHash, rawHash, "结果保存失败");
        } finally {
            bitmap.recycle();
        }
    }

    private boolean persistChangedStations(
            ScreenContextResolver.ParsedScreen parsed,
            List<DidiLocalStationParser.StationRecord> changedStations,
            int currentPage,
            String screenHash
    ) throws Exception {
        final boolean[] uploadConfigured = new boolean[1];
        AtomicReference<CaptureTransactionCoordinator.CommitResult> committed = new AtomicReference<>();
        boolean persisted = AppVisibilityState.runWhileHidden(() -> {
            CaptureTransactionCoordinator.CommitResult result =
                    CaptureTransactionCoordinator.commitCharging(
                    this,
                    sessionId,
                    currentPage,
                    screenHash,
                    parsed.platform,
                    parsed.city,
                    changedStations
            );
            committed.set(result);
            uploadConfigured[0] = AppSettings.isUploadConfigured(this);
            if (!uploadConfigured[0]) {
                LocalStationStore.markSync(this, result.localKeys, "local-only", "未配置回传");
            } else {
                LocalStationStore.markSync(this, result.localKeys, "pending", "等待回传");
            }
        });
        if (!persisted || committed.get() == null) {
            pauseForOwnApp();
            return false;
        }
        if (uploadConfigured[0]) {
            uploadStatus = "等待";
            updateNotification();
            flushOutboxAsync();
        }
        return true;
    }

    private boolean persistChangedFuel(
            ScreenContextResolver.ParsedScreen parsed,
            List<FuelStationRecord> changedStations,
            int currentPage,
            String screenHash
    ) throws Exception {
        boolean requiresQuoteFeature = false;
        for (FuelStationRecord station : changedStations) {
            requiresQuoteFeature |= FuelQuoteFeatureGate.requiresFeature(station);
        }
        final boolean quoteFeatureRequired = requiresQuoteFeature;
        final boolean uploadConfigured = AppSettings.isUploadConfigured(this);
        final String syncMessage;
        if (!uploadConfigured) {
            syncMessage = quoteFeatureRequired
                    ? "未配置回传·已保留报价待办"
                    : "未配置回传";
        } else {
            syncMessage = quoteFeatureRequired ? "等待报价能力" : "等待回传";
        }
        AtomicReference<CaptureTransactionCoordinator.CommitResult> committed = new AtomicReference<>();
        boolean persisted = AppVisibilityState.runWhileHidden(() -> {
            CaptureTransactionCoordinator.CommitResult result =
                    CaptureTransactionCoordinator.commitFuel(
                            this,
                            sessionId,
                            currentPage,
                            screenHash,
                            parsed.platform,
                            parsed.city,
                            changedStations
                    );
            committed.set(result);
            LocalStationStore.markSync(
                    this,
                    result.localKeys,
                    uploadConfigured ? "pending" : "local-only",
                    syncMessage
            );
        });
        if (!persisted || committed.get() == null) {
            pauseForOwnApp();
            return false;
        }
        if (uploadConfigured) {
            uploadStatus = "等待";
            updateNotification();
            flushOutboxAsync();
        }
        return true;
    }

    private void requestSafeScroll(String stationType, String screenHash, String rawHash) {
        if (AppVisibilityState.isAppVisible()) {
            pauseForOwnApp();
            return;
        }
        if (CaptureModePolicy.afterRecognition(automaticScrollSession)
                == CaptureModePolicy.NextStep.WAIT_FOR_PAGE_CHANGE) {
            pauseAndMonitor(screenHash, rawHash, "等待页面变化");
            return;
        }
        if (!CaptureInteractionPolicy.isAllowed(
                stationType,
                CaptureInteractionPolicy.Action.SCROLL_FORWARD
        )) {
            pauseAndMonitor(
                    screenHash,
                    rawHash,
                    CaptureInteractionPolicy.manualSwitchHint(stationType)
            );
            return;
        }
        state = FlowState.SCROLLING;
        AutoScrollAccessibilityService.requestScroll(lockedTargetPackage, (scrolled, reason) ->
                worker.post(() -> onScrollResult(scrolled, reason, screenHash, rawHash))
        );
    }

    private void onScrollResult(boolean scrolled, String reason, String baselineHash, String baselineRawHash) {
        if (!runningState || !withinSessionLimits()) return;
        if (AppVisibilityState.isAppVisible()) {
            pauseForOwnApp();
            return;
        }
        if (!lockedTargetPackage.equals(captureContextPackage())) {
            haltForPackageChange();
            return;
        }
        if (CaptureModePolicy.afterAutoScroll(scrolled)
                == CaptureModePolicy.NextStep.WAIT_FOR_PAGE_CHANGE) {
            pauseAndMonitor(baselineHash, baselineRawHash, reason);
            return;
        }
        state = FlowState.WAITING_STABLE;
        stableCandidateHash = "";
        stableSamples = 0;
        stableDeadline = SystemClock.elapsedRealtime() + PAGE_STABLE_TIMEOUT_MS;
        announceOcr("等待页面稳定");
        worker.postDelayed(() -> samplePageStability(baselineHash), PAGE_STABLE_SAMPLE_MS);
    }

    private void samplePageStability(String baselineHash) {
        if (!runningState || state != FlowState.WAITING_STABLE || !withinSessionLimits()) return;
        if (AppVisibilityState.isAppVisible()) {
            pauseForOwnApp();
            return;
        }
        if (!lockedTargetPackage.equals(captureContextPackage())) {
            haltForPackageChange();
            return;
        }
        Bitmap bitmap = acquireBitmap();
        if (bitmap == null) {
            worker.postDelayed(() -> samplePageStability(baselineHash), PAGE_STABLE_SAMPLE_MS);
            return;
        }
        String currentHash = screenHash(bitmap);
        String currentRawHash = rawFrameHash(bitmap);
        bitmap.recycle();
        long now = SystemClock.elapsedRealtime();
        if (!ScreenStabilityPolicy.meaningfullyChanged(currentHash, baselineHash)) {
            if (now >= stableDeadline) {
                pauseAndMonitor(currentHash, currentRawHash, "已到底");
            } else {
                worker.postDelayed(() -> samplePageStability(baselineHash), PAGE_STABLE_SAMPLE_MS);
            }
            return;
        }

        if (!stableCandidateHash.isEmpty()
                && ScreenStabilityPolicy.sameStructure(currentHash, stableCandidateHash)) stableSamples++;
        else {
            stableCandidateHash = currentHash;
            stableSamples = 1;
        }
        if (stableSamples >= 2 || now >= stableDeadline) {
            state = FlowState.WAITING_SCREEN;
            worker.postDelayed(this::captureForOcr, 120L);
        } else {
            worker.postDelayed(() -> samplePageStability(baselineHash), PAGE_STABLE_SAMPLE_MS);
        }
    }

    private void pauseAndMonitor(String screenHash, String rawHash, String status) {
        if (!runningState) return;
        state = FlowState.PAUSED;
        waitingForOwnAppToHide = false;
        pausedHash = screenHash == null ? "" : screenHash;
        pausedRawHash = rawHash == null ? "" : rawHash;
        pausedAt = SystemClock.elapsedRealtime();
        nearChangeCandidateRawHash = "";
        nearChangeStableSamples = 0;
        skipReason = status == null ? "" : status;
        announceOcr("等待");
        worker.postDelayed(this::monitorPausedPage, PAUSED_MONITOR_MS);
    }

    private void monitorPausedPage() {
        if (!runningState || state != FlowState.PAUSED || !withinSessionLimits()) return;
        if (AppVisibilityState.isAppVisible()) {
            waitingForOwnAppToHide = true;
            ownAppResumeGate.onAppVisible();
            worker.postDelayed(this::monitorPausedPage, PAUSED_MONITOR_MS);
            return;
        }
        String currentPackage = captureContextPackage();
        if (!lockedTargetPackage.isEmpty() && !lockedTargetPackage.equals(currentPackage)) {
            haltForPackageChange();
            return;
        }
        Bitmap bitmap = acquireBitmap();
        if (bitmap == null) {
            worker.postDelayed(this::monitorPausedPage, PAUSED_MONITOR_MS);
            return;
        }
        String currentHash = screenHash(bitmap);
        String currentRawHash = rawFrameHash(bitmap);
        bitmap.recycle();
        if (waitingForOwnAppToHide) {
            if (ownAppResumeGate.onBackgroundSample(currentHash)) {
                waitingForOwnAppToHide = false;
                pausedHash = currentHash;
                pausedRawHash = currentRawHash;
                resumeCapture(true);
            } else {
                worker.postDelayed(this::monitorPausedPage, PAGE_STABLE_SAMPLE_MS);
            }
            return;
        }
        if (ScreenStabilityPolicy.meaningfullyChanged(currentHash, pausedHash)) {
            resumeCapture(false);
            return;
        }
        boolean rawChanged = !currentRawHash.equals(pausedRawHash);
        if (rawChanged && currentRawHash.equals(nearChangeCandidateRawHash)) {
            nearChangeStableSamples++;
        } else if (rawChanged) {
            nearChangeCandidateRawHash = currentRawHash;
            nearChangeStableSamples = 1;
        } else {
            nearChangeCandidateRawHash = "";
            nearChangeStableSamples = 0;
        }
        if (ManualReviewPolicy.shouldReview(
                rawChanged,
                nearChangeStableSamples,
                SystemClock.elapsedRealtime() - pausedAt
        )) {
            resumeCapture(true);
            return;
        }
        worker.postDelayed(this::monitorPausedPage, PAUSED_MONITOR_MS);
    }

    private void resumeCapture(boolean forceReview) {
        noNewPages = 0;
        forceOcrReview = forceReview;
        state = FlowState.WAITING_SCREEN;
        worker.postDelayed(this::captureForOcr, 350L);
    }

    private boolean contextStillMatches(String expectedPackage, String expectedHash) {
        if (AppVisibilityState.isAppVisible()) return false;
        String currentPackage = captureContextPackage();
        if (automaticScrollSession && !CaptureSafetyGate.sameContext(
                    expectedPackage,
                    currentPackage,
                    lockedTargetPackage,
                    true
            )) return false;
        if (!automaticScrollSession && !MANUAL_CAPTURE_SCOPE.equals(expectedPackage)) return false;
        Bitmap current = acquireBitmap();
        // A static projected page may not produce a newer ImageReader frame. Package continuity
        // is sufficient in that case; an actual visual transition normally produces a frame.
        if (current == null) return true;
        try {
            boolean sameStructure = ScreenStabilityPolicy.sameStructure(expectedHash, screenHash(current));
            if (!automaticScrollSession) return sameStructure;
            return CaptureSafetyGate.sameContext(
                        expectedPackage,
                        captureContextPackage(),
                        lockedTargetPackage,
                        sameStructure
                );
        } finally {
            current.recycle();
        }
    }

    private String captureContextPackage() {
        return automaticScrollSession
                ? AutoScrollAccessibilityService.currentPackage()
                : MANUAL_CAPTURE_SCOPE;
    }

    private void haltForPackageChange() {
        if (!runningState) return;
        state = FlowState.PAUSED;
        skipReason = "应用已切换";
        announceOcr("已暂停");
    }

    private void pauseForOwnApp() {
        if (!runningState) return;
        state = FlowState.PAUSED;
        waitingForOwnAppToHide = true;
        ownAppResumeGate.onAppVisible();
        skipReason = "等待场站页面";
        announceOcr("等待");
        worker.postDelayed(this::monitorPausedPage, PAUSED_MONITOR_MS);
    }

    private boolean withinSessionLimits() {
        if (pageIndex >= CaptureSessionPolicy.MAX_PAGES) {
            finishSession("已达到页数上限");
            return false;
        }
        if (CaptureSessionPolicy.limitReached(sessionStartedAt, SystemClock.elapsedRealtime(), pageIndex)) {
            finishSession("已达到时长上限");
            return false;
        }
        return true;
    }

    private void finishSession(String status) {
        announceOcr(status);
        stopSelf();
    }

    private void flushOutboxAsync() {
        if (!AppSettings.isUploadConfigured(this) || !uploadRunning.compareAndSet(false, true)) return;
        if (OutboxStore.hasUploadWork(this)) announceUpload("回传中");
        uploadExecutor.execute(() -> {
            boolean completedSnapshot = true;
            try {
                DeferredFuelUploadPromoter.promote(
                        this,
                        syncClient::canPromoteDeferredFuelBatch
                );
                if (!OutboxStore.deferredFuel(this).isEmpty()
                        && !OutboxStore.hasRetryablePending(this)) {
                    announceUpload("等待能力");
                }
                for (JSONObject batch : OutboxStore.retryablePending(this)) {
                    String batchId = batch.optString("batchId");
                    List<String> keys = OutboxStore.localKeys(batch);
                    try {
                        StationSyncClient.UploadResult acknowledgement = syncClient.upload(this, batch);
                        ManualBackfillRepository.acknowledge(this, batch, acknowledgement.message);
                        announceUpload("成功");
                    } catch (Exception error) {
                        String message = safeMessage(error);
                        UploadFailure.Disposition disposition = UploadFailure.disposition(error);
                        int attempts = OutboxStore.markFailed(this, batchId, message, disposition);
                        boolean retryable = disposition == UploadFailure.Disposition.RETRYABLE;
                        LocalStationStore.markSync(
                                this,
                                keys,
                                retryable ? "failed" : "manual-review",
                                retryable ? message : "需人工处理"
                        );
                        announceUpload(retryable ? "失败" : "需人工处理");
                        if (retryable) completedSnapshot = false;
                        if (retryable && runningState) {
                            worker.postDelayed(this::flushOutboxAsync, OutboxStore.retryDelayMillis(attempts));
                        }
                        if (retryable) break;
                    }
                }
            } finally {
                uploadRunning.set(false);
                if (completedSnapshot && OutboxStore.hasRetryablePending(this) && runningState) {
                    flushOutboxAsync();
                }
            }
        });
    }

    private Bitmap acquireBitmap() {
        Image image = null;
        try {
            image = imageReader == null ? null : imageReader.acquireLatestImage();
            Bitmap bitmap = image == null ? null : bitmapFromImage(image);
            if (bitmap != null) {
                hasCapturedFrame = true;
                frameReceivedCount++;
            }
            return bitmap;
        } catch (Exception error) {
            Log.e(TAG, "screen capture failed", error);
            return null;
        } finally {
            if (image != null) image.close();
        }
    }

    private List<OcrRow> rows(Text text, int width, int height) {
        List<OcrRow> output = new ArrayList<>();
        for (Text.TextBlock block : text.getTextBlocks()) {
            for (Text.Line line : block.getLines()) {
                android.graphics.Rect box = line.getBoundingBox();
                if (box == null) continue;
                output.add(new OcrRow(
                        line.getText(),
                        1f,
                        box.left / (float) width,
                        box.top / (float) height,
                        Math.max(0, box.width()) / (float) width,
                        Math.max(0, box.height()) / (float) height
                ));
            }
        }
        output.sort(Comparator.comparingDouble((OcrRow row) -> row.y).thenComparingDouble(row -> row.x));
        return output;
    }

    private Bitmap bitmapFromImage(Image image) {
        Image.Plane plane = image.getPlanes()[0];
        ByteBuffer buffer = plane.getBuffer();
        int pixelStride = plane.getPixelStride();
        int rowStride = plane.getRowStride();
        int rowPadding = rowStride - pixelStride * image.getWidth();
        int paddedWidth = image.getWidth() + rowPadding / pixelStride;
        Bitmap padded = Bitmap.createBitmap(paddedWidth, image.getHeight(), Bitmap.Config.ARGB_8888);
        padded.copyPixelsFromBuffer(buffer);
        if (paddedWidth == image.getWidth()) return padded;
        Bitmap cropped = Bitmap.createBitmap(padded, 0, 0, image.getWidth(), image.getHeight());
        padded.recycle();
        return cropped;
    }

    private String screenHash(Bitmap bitmap) {
        long fingerprint = 0L;
        int left = bitmap.getWidth() / 20;
        int top = bitmap.getHeight() / 10;
        int usableWidth = Math.max(9, bitmap.getWidth() - left * 2);
        int usableHeight = Math.max(8, bitmap.getHeight() - top * 2);
        for (int row = 0; row < 8; row++) {
            int y = top + Math.min(usableHeight - 1, row * usableHeight / 8);
            int previous = luminance(bitmap.getPixel(left, y));
            for (int column = 1; column <= 8; column++) {
                int x = left + Math.min(usableWidth - 1, column * usableWidth / 9);
                int current = luminance(bitmap.getPixel(x, y));
                fingerprint = (fingerprint << 1) | (previous > current ? 1L : 0L);
                previous = current;
            }
        }
        return String.format("%016x", fingerprint);
    }

    private String rawFrameHash(Bitmap bitmap) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            int stepX = Math.max(1, bitmap.getWidth() / 48);
            int stepY = Math.max(1, bitmap.getHeight() / 80);
            for (int y = 0; y < bitmap.getHeight(); y += stepY) {
                for (int x = 0; x < bitmap.getWidth(); x += stepX) {
                    int pixel = bitmap.getPixel(x, y);
                    digest.update((byte) (pixel >>> 16));
                    digest.update((byte) (pixel >>> 8));
                    digest.update((byte) pixel);
                }
            }
            StringBuilder output = new StringBuilder();
            for (byte value : digest.digest()) output.append(String.format("%02x", value & 0xff));
            return output.substring(0, 16);
        } catch (Exception error) {
            throw new IllegalStateException("无法计算帧摘要", error);
        }
    }

    private int luminance(int pixel) {
        int red = (pixel >>> 16) & 0xff;
        int green = (pixel >>> 8) & 0xff;
        int blue = pixel & 0xff;
        return (red * 299 + green * 587 + blue * 114) / 1000;
    }

    private void announceOcr(String status) {
        ocrStatus = compactStatus(status, "采集中");
        broadcastStatus();
        if (runningState) updateNotification();
    }

    private void announceUpload(String status) {
        uploadStatus = compactStatus(status, "就绪");
        broadcastStatus();
        if (runningState) updateNotification();
    }

    private void broadcastStatus() {
        Intent intent = new Intent(ACTION_RESULT_UPDATED)
                .setPackage(getPackageName())
                .putExtra(EXTRA_STATUS, "OCR " + ocrStatus + " · 回传 " + uploadStatus);
        sendBroadcast(intent);
    }

    private void sendCaptureEvent(String action, String startNonce) {
        String nonce = startNonce == null ? "" : startNonce.trim();
        if (nonce.isEmpty()) return;
        Intent event = new Intent(action)
                .setPackage(getPackageName())
                .putExtra(EXTRA_START_NONCE, nonce);
        if (sessionId != null && !sessionId.isEmpty()) event.putExtra(EXTRA_SESSION_ID, sessionId);
        sendBroadcast(event);
    }

    private void createNotificationChannel() {
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "信息自动识别",
                NotificationManager.IMPORTANCE_LOW
        );
        getSystemService(NotificationManager.class).createNotificationChannel(channel);
    }

    private void updateNotification() {
        getSystemService(NotificationManager.class).notify(NOTIFICATION_ID, notification());
    }

    private Notification notification() {
        Intent openIntent = new Intent(this, MainActivity.class);
        PendingIntent open = PendingIntent.getActivity(
                this,
                1,
                openIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        Intent stopIntent = new Intent(this, OcrCaptureService.class).setAction(ACTION_STOP);
        PendingIntent stop = PendingIntent.getService(
                this,
                2,
                stopIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        PendingIntent returnToApp = PendingIntent.getActivity(
                this,
                3,
                openIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        String text = CaptureNotificationState.text(
                ocrStatus,
                uploadStatus,
                frameReceivedCount,
                ocrAttemptCount,
                parsedStationCount,
                recognizedCount,
                OutboxStore.pendingStationCount(this),
                LocalStationStore.countByState(this, "failed")
                        + LocalStationStore.countByState(this, "manual-review"),
                skipReason
        );
        return new Notification.Builder(this, CHANNEL_ID)
                .setSmallIcon(com.datafordidi.ocruploader.R.drawable.ic_launcher)
                .setContentTitle("信息自动识别")
                .setContentText(text)
                .setContentIntent(open)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .addAction(0, "停止", stop)
                .addAction(0, "返回查看", returnToApp)
                .build();
    }

    private String compactStatus(String value, String fallback) {
        String output = value == null ? "" : value.replaceAll("[\\r\\n]+", " ").trim();
        return output.isEmpty() ? fallback : output;
    }

    private String safeMessage(Throwable error) {
        String message = error == null ? "未知错误" : error.getMessage();
        if (message == null || message.trim().isEmpty()) message = error.getClass().getSimpleName();
        message = message.replaceAll("[\\r\\n]+", " ").trim();
        return message.length() <= 140 ? message : message.substring(0, 140);
    }
}
