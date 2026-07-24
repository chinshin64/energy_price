package com.datafordidi.mobilecollector;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import android.location.Location;
import java.util.List;
import java.util.Set;

public class NetworkCommandService extends Service {
    private static final String TAG = "DataForDidiCommand";
    private static final String CHANNEL_ID = "collector_command";
    private static final long DEFAULT_POLL_INTERVAL_MS = 2000L;
    private static final long EDGE_HEARTBEAT_INTERVAL_MS = 15000L;
    private static final long EDGE_REGISTRATION_RETRY_MS = 30000L;
    private static final long MAX_WAIT_COMMAND_MS = 30000L;
    private static final long MAX_LANDMARK_RUNTIME_MS = 2L * 60L * 60L * 1000L;
    private static final Set<String> ALLOWED_LAUNCH_PACKAGES = Set.of(
            "com.tencent.mm",
            "com.autonavi.minimap",
            "com.datafordidi.mobilecollector"
    );
    private static volatile boolean runningState = false;

    private final SyncClient syncClient = new SyncClient();
    private HandlerThread workerThread;
    private Handler worker;
    private boolean stopped = false;
    private boolean executing = false;
    private boolean registered = false;
    private boolean edgeRegistered = false;
    private long lastEdgeHeartbeatAt = 0L;
    private long lastEdgeRegistrationAttemptAt = 0L;

    private final Runnable pollRunnable = this::pollOnce;

    public static boolean isRunningState() {
        return runningState;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
        // Initialize LocationMockHelper with ApplicationContext so it works
        // from background threads where getSystemService may return null.
        LocationMockHelper.getInstance().init(getApplicationContext());

        workerThread = new HandlerThread("network-command-worker");
        workerThread.start();
        worker = new Handler(workerThread.getLooper());
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        startForeground(11, buildNotification("等待服务端指令"));
        stopped = false;
        runningState = true;
        if (worker != null) {
            worker.removeCallbacks(pollRunnable);
            worker.post(pollRunnable);
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        stopped = true;
        runningState = false;
        if (worker != null) {
            worker.removeCallbacks(pollRunnable);
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

    private void pollOnce() {
        if (stopped || executing) {
            scheduleNextPoll();
            return;
        }
        executing = true;
        try {
            ensureRegistered();
            JSONObject command = null;
            if (edgeRegistered) {
                try {
                    if (System.currentTimeMillis() - lastEdgeHeartbeatAt >= EDGE_HEARTBEAT_INTERVAL_MS) {
                        syncClient.heartbeatEdgeNode(this, getCollectorDeviceId());
                        lastEdgeHeartbeatAt = System.currentTimeMillis();
                    }
                    command = syncClient.pollEdgeTask(this, getCollectorDeviceId());
                } catch (Exception edgeError) {
                    Log.w(TAG, "edge task channel failed: " + edgeError.getMessage());
                    if (String.valueOf(edgeError.getMessage()).contains("HTTP 401")) {
                        CollectorSettings.clearEdgeSessionToken(this);
                        edgeRegistered = false;
                        registered = false;
                    }
                }
            }
            if (command == null) {
                command = syncClient.pollCommand(this, getCollectorDeviceId());
            }
            if (command != null) {
                executeAndReport(command);
            }
        } catch (Exception error) {
            Log.w(TAG, "poll command failed: " + error.getMessage());
        } finally {
            executing = false;
            scheduleNextPoll();
        }
    }

    private void ensureRegistered() throws Exception {
        long now = System.currentTimeMillis();
        boolean edgeRetryDue = !edgeRegistered
                && now - lastEdgeRegistrationAttemptAt >= EDGE_REGISTRATION_RETRY_MS;
        if (registered
                && !CollectorSettings.getDeviceSessionId(this).trim().isEmpty()
                && (edgeRegistered || !edgeRetryDue)) {
            return;
        }
        if (CollectorSettings.getEdgeSessionToken(this).trim().isEmpty()) {
            lastEdgeRegistrationAttemptAt = now;
            try {
                syncClient.registerEdgeNode(this, getCollectorDeviceId());
                edgeRegistered = true;
                lastEdgeHeartbeatAt = 0L;
            } catch (Exception edgeError) {
                edgeRegistered = false;
                Log.w(TAG, "edge registration unavailable, keeping legacy channel: " + edgeError.getMessage());
            }
        } else {
            edgeRegistered = true;
        }
        if (!registered || CollectorSettings.getDeviceSessionId(this).trim().isEmpty()) {
            syncClient.registerDevice(this, getCollectorDeviceId());
            registered = true;
        }
        Log.i(TAG, "device session established");
    }

    private void scheduleNextPoll() {
        if (stopped || worker == null) {
            return;
        }
        worker.postDelayed(pollRunnable, DEFAULT_POLL_INTERVAL_MS);
    }

    private void executeAndReport(JSONObject command) {
        String commandId = command.optString("id", "");
        String type = command.optString("type", "");
        boolean edgeTransport = command.optBoolean("_edgeTransport", false);
        JSONObject payload = command.optJSONObject("payload");
        if (payload == null) {
            payload = new JSONObject();
        }

        boolean success = false;
        JSONObject result = new JSONObject();
        String errorMessage = null;
        try {
            result = executeCommand(type, payload);
            String failReason = result.optString("failReason", "").trim();
            success = failReason.isEmpty();
            if (!success) {
                errorMessage = failReason;
            }
        } catch (Exception error) {
            errorMessage = error.getMessage();
            Log.e(TAG, "command failed: " + type, error);
            try {
                result.put("type", type);
                result.put("deviceStatus", buildStatusJson());
            } catch (Exception ignored) {
                // Keep the original execution error as the command result.
            }
        }

        try {
            if (edgeTransport) {
                syncClient.uploadEdgeTaskResult(this, getCollectorDeviceId(), commandId, success, result, errorMessage);
            } else {
                syncClient.uploadCommandResult(this, commandId, success, result, errorMessage);
            }
        } catch (Exception uploadError) {
            Log.e(TAG, "command result upload failed: " + commandId, uploadError);
        }
    }

    private JSONObject executeCommand(String type, JSONObject payload) throws Exception {
        if ("status".equals(type)) {
            return buildStatusJson();
        }
        if ("save_settings".equals(type)) {
            applySettings(payload);
            return buildResult("settings saved");
        }
        if ("open_app".equals(type)) {
            String packageName = payload.optString("packageName", "com.tencent.mm");
            return requireSuccess("open_app", launchPackage(packageName));
        }
        if ("tap".equals(type)) {
            boolean ok = AutoScrollAccessibilityService.requestTap(
                    (float) payload.optDouble("x", payload.optDouble("xRatio", 0.5)),
                    (float) payload.optDouble("y", payload.optDouble("yRatio", 0.5))
            );
            return requireSuccess("tap", ok);
        }
        if ("back".equals(type)) {
            return requireSuccess("back", AutoScrollAccessibilityService.requestBack());
        }
        if ("scroll".equals(type)) {
            return requireSuccess("scroll", AutoScrollAccessibilityService.requestScrollForward());
        }
        if ("click_text".equals(type)) {
            boolean ok = AutoScrollAccessibilityService.requestClickText(
                    payload.optString("text", ""),
                    payload.optBoolean("contains", true)
            );
            return requireSuccess("click_text", ok);
        }
        if ("set_text".equals(type)) {
            boolean ok = AutoScrollAccessibilityService.requestSetFocusedText(payload.optString("text", ""));
            return requireSuccess("set_text", ok);
        }
        if ("ime_replace_text".equals(type)) {
            boolean ok = AdbTextInputService.replaceText(payload.optString("text", ""));
            return requireSuccess("ime_replace_text", ok);
        }
        if ("wait".equals(type)) {
            sleep(Math.max(0, Math.min(MAX_WAIT_COMMAND_MS, payload.optLong("ms", 1000))));
            return buildResult("waited");
        }
        if ("start_text_collection".equals(type)) {
            applySettings(payload);
            startTextCollection();
            return buildResult("text collection started");
        }
        if ("stop_collection".equals(type)) {
            stopCollection();
            return buildResult("collection stopped");
        }
        if ("clear_mock_location".equals(type)) {
            LocationMockHelper.getInstance().stopMockLocation();
            JSONObject result = buildResult("mock_location_cleared");
            result.put("started", LocationMockHelper.getInstance().isRunning());
            return result;
        }
        if ("collect_visible_text".equals(type)) {
            return collectVisibleText(payload.optInt("limit", 120));
        }
        if ("collect_landmark".equals(type)) {
            return executeCollectLandmark(payload);
        }
        if ("set_mock_location".equals(type)) {
            return executeSetMockLocation(payload);
        }
        throw new IllegalArgumentException("unsupported command type: " + type);
    }

    /**
     * 单独执行模拟定位，高德采集等场景需要在采集前预先设置 GPS。
     */
    private JSONObject executeSetMockLocation(JSONObject payload) throws Exception {
        String keyword = payload.optString("keyword", payload.optString("city", ""));
        double lat = payload.optDouble("lat", 0.0);
        double lng = payload.optDouble("lng", 0.0);
        float accuracy = (float) Math.max(1.0, Math.min(1000.0, payload.optDouble("accuracy", 5.0)));
        if (keyword.isEmpty() && !LocationMockHelper.isValidCoordinate(lat, lng)) {
            throw new IllegalArgumentException("set_mock_location requires valid lat/lng or keyword");
        }
        LocationMockHelper.getInstance().startMockLocation(this, keyword, lat, lng, accuracy);
        if (!LocationMockHelper.getInstance().isRunning()) {
            String reason = LocationMockHelper.getInstance().lastError();
            throw new IllegalStateException(
                    "模拟定位未生效：" + (reason != null ? reason : "未知原因，请检查开发者选项中的模拟位置应用设置"));
        }
        JSONObject result = buildResult("mock_location_started");
        result.put("keyword", keyword);
        result.put("lat", lat);
        result.put("lng", lng);
        result.put("accuracy", accuracy);
        result.put("coordinateSystem", payload.optString("coordinateSystem", "WGS84"));
        result.put("inputCoordinateSystem", payload.optString("inputCoordinateSystem", ""));
        result.put("started", LocationMockHelper.getInstance().isRunning());
        return result;
    }

    private JSONObject executeCollectLandmark(JSONObject payload) throws Exception {
        applySettings(payload);
        String city = payload.optString("city", CollectorSettings.getCity(this));
        String keyword = payload.optString("keyword", city);
        double payloadLat = payload.optDouble("lat", 0.0);
        double payloadLng = payload.optDouble("lng", 0.0);
        int pagesPerLandmark = Math.min(
                500,
                Math.max(1, payload.optInt("pagesPerLandmark", CollectorSettings.getMaxPages(this)))
        );
        long requestedRuntimeMs = pagesPerLandmark * (long) CollectorSettings.getMaxIntervalMillis(this) + 90000L;
        long deadlineMs = System.currentTimeMillis()
                + Math.min(MAX_LANDMARK_RUNTIME_MS, Math.max(300000L, requestedRuntimeMs));

        JSONArray steps = new JSONArray();
        steps.put("save_settings");

        // 1. Mock GPS to landmark coordinates so target app auto-detects nearby stations.
        // 优先使用服务端传来的 lat/lng，不再依赖本地硬编码坐标表
        LocationMockHelper.getInstance().startMockLocation(this, keyword, payloadLat, payloadLng);
        steps.put("mock_location_started=" + LocationMockHelper.getInstance().isRunning());
        if (!LocationMockHelper.getInstance().isRunning()) {
            String reason = LocationMockHelper.getInstance().lastError();
            return completeLandmarkResult(
                    city,
                    keyword,
                    pagesPerLandmark,
                    steps,
                    "mock_location_failed"
                            + (reason != null ? "：" + reason : "：未知原因，请检查开发者选项中的模拟位置应用设置"),
                    false
            );
        }

        // 1.5 Wake up fused location provider. Register a listener on gps+network
        // and keep it alive until fused has had time to merge our mock data.
        android.location.LocationListener fusionWake = null;
        try {
            android.location.LocationManager lm2 = (android.location.LocationManager) getSystemService(Context.LOCATION_SERVICE);
            fusionWake = new android.location.LocationListener() {
                public void onLocationChanged(Location loc) {}
                public void onProviderDisabled(String p) {}
                public void onProviderEnabled(String p) {}
            };
            if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED) {
                lm2.requestLocationUpdates("gps", 6000, 0, fusionWake);
                lm2.requestLocationUpdates("network", 6000, 0, fusionWake);
                steps.put("fusion_listeners_registered");
            } else {
                fusionWake = null;
                steps.put("fusion_wake_skipped=location_permission_missing");
            }
        } catch (Exception e) {
            steps.put("fusion_wake_failed=" + e.getMessage());
        }
        // Save ref for cleanup below.
        final android.location.LocationListener fusionWakeFinal = fusionWake;

        // 2. Open the target app based on platform.
        String platform = payload.optString("platform", CollectorSettings.getPlatform(this));
        if ("amap-charging".equals(platform)) {
            boolean opened = launchPackage("com.autonavi.minimap");
            steps.put("open_amap=" + opened);
            if (!opened) {
                steps.put("amap_launch_failed=true");
                return completeLandmarkResult(city, keyword, pagesPerLandmark, steps, "amap_launch_failed", true);
            }
            sleep(2500);
            // 搜索充电站
            boolean searched = searchChargingStations(steps);
            steps.put("search_charging=" + searched);
        } else {
            // 滴滴: bring WeChat / mini-program to foreground
            boolean miniProgramReady = openDidiMiniProgram(steps);
            steps.put("mini_program_ready=" + miniProgramReady);

            boolean citySelected = selectSearchCity(city, steps);
            steps.put("city_selected=" + citySelected);

            boolean landmarkSelected = searchNearbyLandmark(keyword, steps);
            steps.put("landmark_selected=" + landmarkSelected);
        }

        // 3. Wait for the target app to pick up the new location.
        sleep(3000);

        // 4. Start OCR scroll collection.
        startTextCollection();
        steps.put("start_text_collection");
        sleep(1500);

        while (!stopped && AccessibilityTextCollectService.isRunningState() && System.currentTimeMillis() < deadlineMs) {
            sleep(2000);
        }

        boolean timedOut = AccessibilityTextCollectService.isRunningState();
        if (timedOut) {
            stopCollection();
        }

        // Restore real GPS.
        if (fusionWakeFinal != null) {
            try {
                android.location.LocationManager lm2 = (android.location.LocationManager) getSystemService(Context.LOCATION_SERVICE);
                lm2.removeUpdates(fusionWakeFinal);
                steps.put("fusion_listeners_removed");
            } catch (Exception e) {
                steps.put("fusion_remove_failed=" + e.getMessage());
            }
        }
        LocationMockHelper.getInstance().stopMockLocation();
        steps.put("mock_location_stopped=true");

        return completeLandmarkResult(city, keyword, pagesPerLandmark, steps, null, timedOut);
    }

    private JSONObject completeLandmarkResult(String city, String keyword, int pagesPerLandmark, JSONArray steps, String failReason, boolean timedOut) throws Exception {
        // Restore real GPS.
        LocationMockHelper.getInstance().stopMockLocation();
        steps.put("mock_location_stopped=true");

        JSONObject result = new JSONObject()
                .put("type", "collect_landmark")
                .put("city", city)
                .put("keyword", keyword)
                .put("pagesPerLandmark", pagesPerLandmark)
                .put("timedOut", timedOut)
                .put("steps", steps)
                .put("deviceStatus", buildStatusJson());
        if (failReason != null) {
            result.put("failReason", failReason);
        }
        return result;
    }

    private boolean openDidiMiniProgram(JSONArray steps) {
        if (isInMiniProgram()) {
            steps.put("mini_program_already_open=true");
            return true;
        }

        boolean opened = launchPackage("com.tencent.mm");
        steps.put("open_wechat=" + opened);
        if (!opened) {
            Log.w(TAG, "openDidiMiniProgram: failed to launch WeChat, continuing anyway");
            return false;
        }
        sleep(2500);
        if (isInMiniProgram()) {
            steps.put("mini_program_after_wechat=true");
            return true;
        }

        // Best-effort: WeChat is in foreground, GPS is already set to the landmark.
        // The user may already be in the mini-program; don't fail the flow.
        steps.put("mini_program_not_detected_but_continuing=true");
        return isInMiniProgram();
    }

    /** 高德充电站采集：点搜索框 → 点"充电站"快捷标签 → 进列表页 */
    private boolean searchChargingStations(JSONArray steps) {
        sleep(2000);

        // 第0步：关闭可能出现的升级弹窗/温馨提示
        for (int i = 0; i < 3; i++) {
            // 点"暂不升级"区域 (中心偏下)
            AutoScrollAccessibilityService.requestTap(0.50f, 0.57f);
            sleep(500);
            // 点底部取消区域
            AutoScrollAccessibilityService.requestTap(0.50f, 0.80f);
            sleep(500);
        }

        // 第1步：点击首页搜索框
        boolean searchOpened = AutoScrollAccessibilityService.requestClickText("搜索", true);
        if (!searchOpened) {
            AutoScrollAccessibilityService.requestTap(0.50f, 0.048f);  // 搜索框区域
        }
        steps.put("search_box_clicked=" + searchOpened);
        sleep(2000);

        // 第2步：点击充电站快捷标签（高德搜索页自动显示历史/推荐标签）
        // 之前 OCR 看到 "充电站约637个地点" 在 y≈299 即 0.122
        // "附近的充电站约171个地点" 在 y≈557 即 0.226
        // "快充充电桩约1200个地点" 在 y≈663 即 0.270
        AutoScrollAccessibilityService.requestTap(0.50f, 0.122f);
        steps.put("charging_tag_tap1=true");
        sleep(3000);

        List<OcrRow> rows = AutoScrollAccessibilityService.collectVisibleTextRows();
        String text = "";
        if (rows != null) for (OcrRow r : rows) text += r.text;
        boolean inCharging = text.contains("充电") && (text.contains("空闲") || text.contains("快充") || text.contains("慢充") || text.contains("电站"));

        if (!inCharging) {
            AutoScrollAccessibilityService.requestTap(0.50f, 0.226f);
            steps.put("charging_tag_tap2=true");
            sleep(3000);
            rows = AutoScrollAccessibilityService.collectVisibleTextRows();
            text = "";
            if (rows != null) for (OcrRow r : rows) text += r.text;
            inCharging = text.contains("充电") && (text.contains("空闲") || text.contains("快充") || text.contains("慢充") || text.contains("电站"));
        }

        if (!inCharging) {
            AutoScrollAccessibilityService.requestTap(0.50f, 0.270f);
            steps.put("charging_tag_tap3=true");
            sleep(3000);
            rows = AutoScrollAccessibilityService.collectVisibleTextRows();
            text = "";
            if (rows != null) for (OcrRow r : rows) text += r.text;
            inCharging = text.contains("充电") && (text.contains("空闲") || text.contains("快充") || text.contains("慢充") || text.contains("电站"));
        }

        steps.put("paste_charging_station=bypass_tags");
        steps.put("charging_page_detected=" + inCharging);
        steps.put("charging_search_done=true");
        return true;
    }

    private boolean selectSearchCity(String city, JSONArray steps) {
        // GPS is already set by executeCollectLandmark before calling this.
        // Just wait for the location to propagate.
        sleep(2500);
        steps.put("select_city_gps_only=true");
        return true;
    }

    private boolean searchNearbyLandmark(String keyword, JSONArray steps) {
        // GPS is already set to the landmark coordinates.
        // No UI interaction needed — nearby stations appear automatically.
        steps.put("search_nearby_gps_only=true");
        return true;
    }

    private boolean pasteFocusedText(String text) {
        return AdbTextInputService.pasteText(text)
                || AutoScrollAccessibilityService.requestPasteFocusedText(text)
                || AutoScrollAccessibilityService.requestSetFocusedText(text)
                || AdbTextInputService.replaceText(text);
    }

    private boolean isInMiniProgram() {
        String packageName = AutoScrollAccessibilityService.getCurrentPackageName();
        String className = AutoScrollAccessibilityService.getCurrentClassName();
        return packageName != null
                && packageName.contains("com.tencent.mm")
                && className != null
                && className.contains("AppBrandUI");
    }

    private JSONObject collectVisibleText(int limit) throws Exception {
        List<OcrRow> rows = AutoScrollAccessibilityService.collectVisibleTextRows();
        JSONArray array = new JSONArray();
        int safeLimit = Math.min(500, Math.max(1, limit));
        for (int i = 0; i < rows.size() && i < safeLimit; i++) {
            array.put(rows.get(i).toJson());
        }
        return new JSONObject()
                .put("rowCount", rows.size())
                .put("rows", array)
                .put("deviceStatus", buildStatusJson());
    }

    private void applySettings(JSONObject payload) {
        if (payload == null) {
            return;
        }
        int minInterval = payload.optInt("minIntervalMs", payload.optInt("minIntervalMillis", CollectorSettings.getMinIntervalMillis(this)));
        int maxInterval = payload.optInt("maxIntervalMs", payload.optInt("maxIntervalMillis", CollectorSettings.getMaxIntervalMillis(this)));
        int maxPages = payload.optInt("pagesPerLandmark", payload.optInt("maxPages", CollectorSettings.getMaxPages(this)));
        boolean detail = payload.has("detailEnrichmentEnabled")
                ? payload.optBoolean("detailEnrichmentEnabled")
                : CollectorSettings.isDetailEnrichmentEnabled(this);
        CollectorSettings.save(
                this,
                CollectorSettings.getServerUrl(this),
                null,
                payload.optString("platform", CollectorSettings.getPlatform(this)),
                payload.optString("city", CollectorSettings.getCity(this)),
                minInterval,
                maxInterval,
                maxPages,
                detail,
                CollectorSettings.isAiSupervisorEnabled(this),
                CollectorSettings.isTestEvidenceEnabled(this),
                payload.has("rawOcrUploadEnabled")
                        ? payload.optBoolean("rawOcrUploadEnabled")
                        : CollectorSettings.isRawOcrUploadEnabled(this)
        );
        if (payload.has("parentNodeId")) {
            CollectorSettings.saveEdgeParentNodeId(this, payload.optString("parentNodeId", ""));
        }
    }

    private void startTextCollection() {
        Intent service = new Intent(this, AccessibilityTextCollectService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(service);
        } else {
            startService(service);
        }
    }

    private void stopCollection() {
        sendBroadcast(new Intent(CollectorControlActions.ACTION_STOP).setPackage(getPackageName()));
        stopService(new Intent(this, CaptureOcrService.class));
        stopService(new Intent(this, AccessibilityTextCollectService.class));
        LocationMockHelper.getInstance().stopMockLocation();
    }

    private boolean launchPackage(String packageName) {
        if (!ALLOWED_LAUNCH_PACKAGES.contains(String.valueOf(packageName))) {
            Log.w(TAG, "launch package rejected: not allowlisted");
            return false;
        }
        try {
            Intent intent = makeLaunchIntent(packageName);
            if (intent == null) {
                return false;
            }
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            startActivity(intent);
            return true;
        } catch (Exception error) {
            Log.w(TAG, "launch package failed: " + packageName + " " + error.getMessage());
            // fallback: try explicit class name directly
            try {
                Intent fallback = makeLaunchIntentDirect(packageName);
                if (fallback != null) {
                    fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
                    startActivity(fallback);
                    return true;
                }
            } catch (Exception ignored) {}
            return false;
        }
    }

    private Intent makeLaunchIntent(String packageName) {
        // MIUI/Android 12 sometimes fails to start via getLaunchIntentForPackage,
        // so use explicit class names for known targets.
        if ("com.autonavi.minimap".equals(packageName)) {
            return makeLaunchIntentDirect(packageName);
        }
        if ("com.tencent.mm".equals(packageName)) {
            return makeLaunchIntentDirect(packageName);
        }
        PackageManager manager = getPackageManager();
        Intent intent = manager.getLaunchIntentForPackage(packageName);
        if (intent == null) {
            return makeLaunchIntentDirect(packageName);
        }
        return intent;
    }

    private Intent makeLaunchIntentDirect(String packageName) {
        Intent intent = new Intent(Intent.ACTION_MAIN);
        intent.addCategory(Intent.CATEGORY_LAUNCHER);
        if ("com.tencent.mm".equals(packageName)) {
            intent.setClassName("com.tencent.mm", "com.tencent.mm.ui.LauncherUI");
            return intent;
        }
        if ("com.autonavi.minimap".equals(packageName)) {
            intent.setClassName("com.autonavi.minimap", "com.autonavi.map.activity.SplashActivity");
            return intent;
        }
        intent.setPackage(packageName);
        return intent;
    }

    private JSONObject buildResult(String message) throws Exception {
        return new JSONObject()
                .put("message", message)
                .put("deviceStatus", buildStatusJson());
    }

    private JSONObject requireSuccess(String action, boolean success) throws Exception {
        if (!success) {
            throw new IllegalStateException(action + " failed");
        }
        return buildResult(action + "=true");
    }

    private JSONObject buildStatusJson() throws Exception {
        List<OcrRow> rows = AutoScrollAccessibilityService.collectVisibleTextRows();
        return new JSONObject()
                .put("deviceId", getCollectorDeviceId())
                .put("edgeRegistered", edgeRegistered)
                .put("edgeParentNodeId", CollectorSettings.getEdgeParentNodeId(this))
                .put("deviceProfile", EdgeDeviceProfile.build(this))
                .put("serverUrl", CollectorSettings.getServerUrl(this))
                .put("city", CollectorSettings.getCity(this))
                .put("commandServiceRunning", runningState)
                .put("textCollectionRunning", AccessibilityTextCollectService.isRunningState())
                .put("accessibilityReady", AutoScrollAccessibilityService.isReady())
                .put("currentPackageName", AutoScrollAccessibilityService.getCurrentPackageName())
                .put("currentClassName", AutoScrollAccessibilityService.getCurrentClassName())
                .put("visibleTextRowCount", rows.size());
    }

    private String getCollectorDeviceId() {
        return DeviceIdentity.get(this);
    }

    private void sleep(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
        }
    }

    private Notification buildNotification(String text) {
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);
        return builder
                .setContentTitle("网络指令采集")
                .setContentText(text)
                .setSmallIcon(android.R.drawable.ic_menu_upload)
                .setOngoing(true)
                .build();
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "DataForDidi Command Collector",
                NotificationManager.IMPORTANCE_LOW
        );
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.createNotificationChannel(channel);
    }
}
