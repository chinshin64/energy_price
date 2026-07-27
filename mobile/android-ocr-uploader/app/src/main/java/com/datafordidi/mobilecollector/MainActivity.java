package com.datafordidi.mobilecollector;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.widget.Toast;

import androidx.core.content.ContextCompat;

import org.json.JSONObject;

import java.util.List;
import java.util.UUID;

public final class MainActivity extends Activity {
    private static final int REQUEST_CAPTURE = 7001;
    private static final int REQUEST_NOTIFICATIONS = 7002;
    private static final int REQUEST_OVERLAY = 7003;
    private static final long CAPTURE_READY_TIMEOUT_MS = 15_000L;
    private static final String STATE_START_NONCE = "startNonce";
    private static final String STATE_AWAITING_READY = "awaitingReady";
    private static final String STATE_SELECTED_PLATFORM = "selectedPlatform";
    private static final String STATE_RESULT_FILTER = "resultFilter";
    private static final String STATE_NAME_QUERY = "nameQuery";
    private static final String STATE_START_TIME = "startTime";
    private static final String STATE_END_TIME = "endTime";
    private static final String PREFS = "standalone_ocr_platform";
    private static final String PREF_SELECTED_PLATFORM = "selectedPlatform";

    private ResultDashboardView dashboard;
    private CaptureUiState captureUiState = CaptureUiState.STOPPED;
    private StationResultPresenter.Filter selectedFilter = StationResultPresenter.Filter.ALL;
    private StationRecordFilter recordFilter = StationRecordFilter.EMPTY;
    private boolean receiverRegistered;
    private boolean captureReceiverRegistered;
    private boolean manualReceiverRegistered;
    private boolean awaitingReady;
    private String selectedPlatform = "tuanyou";
    private ManualBackfillDialog backfillDialog;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final CaptureReadyGate captureReadyGate = new CaptureReadyGate();

    private final BroadcastReceiver resultReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (intent == null) return;
            String status = intent.getStringExtra(OcrCaptureService.EXTRA_STATUS);
            if (status != null && !status.trim().isEmpty()) setStatus(status);
            renderResults();
        }
    };

    private final BroadcastReceiver manualResultReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (intent == null) return;
            String status = intent.getStringExtra(ManualOcrService.EXTRA_STATUS);
            if (status != null && !status.trim().isEmpty()) setStatus(status);
            renderResults();
        }
    };

    private final BroadcastReceiver captureReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (intent == null) return;
            String nonce = intent.getStringExtra(OcrCaptureService.EXTRA_START_NONCE);
            if (OcrCaptureService.ACTION_CAPTURE_READY.equals(intent.getAction())) {
                acceptCaptureReady(nonce);
                return;
            }
            if (OcrCaptureService.ACTION_CAPTURE_FAILED.equals(intent.getAction())
                    && captureReadyGate.failure(nonce) == CaptureReadyGate.Outcome.FAILED) {
                awaitingReady = false;
                mainHandler.removeCallbacksAndMessages(null);
                setStatus("启动失败");
            }
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        try {
            AppSettings.importProvisioningFile(this);
        } catch (Exception ignored) {
            // The UI never exposes provisioning details.
        }
        FalsePositiveCleanup.run(this);
        FuelStationNameMigration.run(this);
        CaptureTransactionCoordinator.reconcile(this);
        ManualBackfillRepository.reconcile(this);
        OutboxRecoveryPolicy.recoverAfterUpgrade(this);
        setContentView(buildContent());
        if (savedInstanceState != null) {
            captureReadyGate.begin(savedInstanceState.getString(STATE_START_NONCE, ""));
            awaitingReady = savedInstanceState.getBoolean(STATE_AWAITING_READY, false);
            selectedPlatform = savedInstanceState.getString(STATE_SELECTED_PLATFORM, loadSavedPlatform());
            selectedFilter = restoreResultFilter(savedInstanceState.getString(STATE_RESULT_FILTER));
            recordFilter = new StationRecordFilter(
                    savedInstanceState.getString(STATE_NAME_QUERY, ""),
                    savedInstanceState.containsKey(STATE_START_TIME)
                            ? savedInstanceState.getLong(STATE_START_TIME) : null,
                    savedInstanceState.containsKey(STATE_END_TIME)
                            ? savedInstanceState.getLong(STATE_END_TIME) : null
            );
        } else {
            selectedPlatform = loadSavedPlatform();
        }
        dashboard.setRecordFilter(recordFilter);
        registerCaptureReceiver();
        if (awaitingReady && captureReadyGate.hasPending()) {
            scheduleReadyTimeout(captureReadyGate.pendingNonce());
        }
        renderResults();
        if (savedInstanceState == null) {
            AppUpdateManager.checkOnColdStart(this);
        }
        requestNotificationPermissionIfNeeded();
    }

    @Override
    protected void onStart() {
        super.onStart();
        AppVisibilityState.onActivityStarted();
        registerResultReceiver();
        registerManualResultReceiver();
        schedulePendingUploads(this);
        restoreBackfillDraft();
        if (awaitingReady && OcrCaptureService.isReadyFor(captureReadyGate.pendingNonce())) {
            acceptCaptureReady(captureReadyGate.pendingNonce());
            return;
        }
        if (awaitingReady) {
            setStatus("正在启动");
        } else {
            setStatus(ManualOcrService.isRunning() ? "悬浮识别中" : OcrCaptureService.isRunning() ? "识别中" : "已停止");
        }
        renderResults();
    }

    @Override
    protected void onStop() {
        AppVisibilityState.onActivityStopped();
        if (receiverRegistered) {
            unregisterReceiver(resultReceiver);
            receiverRegistered = false;
        }
        if (manualReceiverRegistered) {
            unregisterReceiver(manualResultReceiver);
            manualReceiverRegistered = false;
        }
        super.onStop();
    }

    @Override
    protected void onDestroy() {
        mainHandler.removeCallbacksAndMessages(null);
        if (captureReceiverRegistered) {
            unregisterReceiver(captureReceiver);
            captureReceiverRegistered = false;
        }
        super.onDestroy();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        outState.putString(STATE_START_NONCE, captureReadyGate.pendingNonce());
        outState.putBoolean(STATE_AWAITING_READY, awaitingReady);
        outState.putString(STATE_SELECTED_PLATFORM, selectedPlatform);
        outState.putString(STATE_RESULT_FILTER, selectedFilter.name());
        outState.putString(STATE_NAME_QUERY, recordFilter.nameQuery);
        if (recordFilter.startEpochMillis != null) {
            outState.putLong(STATE_START_TIME, recordFilter.startEpochMillis);
        }
        if (recordFilter.endEpochMillis != null) {
            outState.putLong(STATE_END_TIME, recordFilter.endEpochMillis);
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQUEST_OVERLAY) {
            if (android.provider.Settings.canDrawOverlays(this)) {
                showPlatformPicker();
            } else {
                setStatus("悬浮窗权限未开启");
            }
            return;
        }
        if (requestCode != REQUEST_CAPTURE) return;
        if (resultCode != RESULT_OK || data == null) {
            captureReadyGate.cancel();
            awaitingReady = false;
            setStatus("待授权");
            return;
        }
        Intent service = new Intent(this, ManualOcrService.class)
                .setAction(ManualOcrService.ACTION_MANUAL_CAPTURE)
                .putExtra(ManualOcrService.EXTRA_RESULT_CODE, resultCode)
                .putExtra(ManualOcrService.EXTRA_RESULT_DATA, data)
                .putExtra(ManualOcrService.EXTRA_PLATFORM, selectedPlatform);
        try {
            startForegroundService(service);
            setStatus("悬浮识别中");
            moveTaskToBack(true);
        } catch (RuntimeException error) {
            setStatus("启动失败");
        }
    }

    private View buildContent() {
        dashboard = new ResultDashboardView(this);
        dashboard.setListener(new ResultDashboardView.Listener() {
            @Override
            public void onPrimaryAction() {
                if (captureUiState.stopAction) stopCapture();
                else startCapture();
            }

            @Override
            public void onClearCompleted() {
                confirmClear();
            }

            @Override
            public void onCheckUpdate() {
                AppUpdateManager.check(MainActivity.this, true);
            }

            @Override
            public void onFilterSelected(StationResultPresenter.Filter filter) {
                selectedFilter = filter;
                dashboard.exitSelectionMode();
                renderResults();
            }

            @Override
            public void onNameQueryChanged(String query) {
                recordFilter = recordFilter.withNameQuery(query);
                dashboard.exitSelectionMode();
                renderResults();
            }

            @Override
            public void onStartTimeRequested() {
                SecondPrecisionDateTimeDialog.show(
                        MainActivity.this,
                        "选择开始时间",
                        recordFilter.startEpochMillis,
                        MainActivity.this::applyStartTime
                );
            }

            @Override
            public void onEndTimeRequested() {
                SecondPrecisionDateTimeDialog.show(
                        MainActivity.this,
                        "选择结束时间",
                        recordFilter.endEpochMillis,
                        MainActivity.this::applyEndTime
                );
            }

            @Override
            public void onResetRecordFilters() {
                recordFilter = StationRecordFilter.EMPTY;
                dashboard.exitSelectionMode();
                dashboard.setRecordFilter(recordFilter);
                renderResults();
            }

            @Override
            public void onEditBackfill(JSONObject row) {
                openBackfill(ManualBackfillDraftStore.getOrCreate(MainActivity.this, row));
            }

            @Override
            public void onDeleteSelected(java.util.Set<String> stableIdentities) {
                confirmDeleteSelected(stableIdentities);
            }
        });
        dashboard.setCaptureState(captureUiState);
        return dashboard;
    }

    private void startCapture() {
        if (ManualOcrService.isRunning()) {
            stopService(new Intent(this, ManualOcrService.class).setAction("com.datafordidi.ocruploader.MANUAL_STOP"));
            setStatus("已停止");
            return;
        }
        if (OcrCaptureService.isRunning()) {
            setStatus("运行中");
            return;
        }
        // 手动模式不再需要旧的 captureReadyGate；如有残留状态直接清理。
        captureReadyGate.cancel();
        awaitingReady = false;
        if (!android.provider.Settings.canDrawOverlays(this)) {
            requestOverlayPermission();
            return;
        }
        showPlatformPicker();
    }

    private void requestOverlayPermission() {
        new AlertDialog.Builder(this)
                .setTitle("需要悬浮窗权限")
                .setMessage("手动 OCR 按钮需要悬浮窗权限才能在其他应用上方显示。")
                .setNegativeButton("取消", null)
                .setPositiveButton("去开启", (dialog, which) -> {
                    Intent intent = new Intent(
                            android.provider.Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                            android.net.Uri.parse("package:" + getPackageName())
                    );
                    try {
                        startActivityForResult(intent, REQUEST_OVERLAY);
                    } catch (RuntimeException ignored) {
                        setStatus("无法打开权限设置");
                    }
                })
                .show();
    }

    private void showPlatformPicker() {
        List<FuelPlatformHint.Option> options = FuelPlatformHint.options();
        String[] labels = new String[options.size()];
        int checked = 0;
        for (int index = 0; index < options.size(); index++) {
            labels[index] = options.get(index).label;
            if (options.get(index).value.equals(selectedPlatform)) checked = index;
        }
        final int[] choice = {checked};
        new AlertDialog.Builder(this)
                .setTitle("选择采集平台")
                .setSingleChoiceItems(labels, checked, (dialog, which) -> choice[0] = which)
                .setNegativeButton("取消", null)
                .setPositiveButton("开始识别", (dialog, which) -> {
                    selectedPlatform = options.get(choice[0]).value;
                    savePlatform(selectedPlatform);
                    requestCapturePermission();
                })
                .show();
    }

    private String loadSavedPlatform() {
        String value = getSharedPreferences(PREFS, MODE_PRIVATE)
                .getString(PREF_SELECTED_PLATFORM, "tuanyou");
        return value == null || value.trim().isEmpty() ? "tuanyou" : value;
    }

    private void savePlatform(String platform) {
        getSharedPreferences(PREFS, MODE_PRIVATE)
                .edit()
                .putString(PREF_SELECTED_PLATFORM, platform)
                .apply();
    }

    private void requestCapturePermission() {
        MediaProjectionManager manager = (MediaProjectionManager) getSystemService(MEDIA_PROJECTION_SERVICE);
        String nonce = UUID.randomUUID().toString();
        captureReadyGate.begin(nonce);
        setStatus("待授权");
        try {
            startActivityForResult(manager.createScreenCaptureIntent(), REQUEST_CAPTURE);
        } catch (RuntimeException error) {
            captureReadyGate.cancel();
            awaitingReady = false;
            setStatus("启动失败");
        }
    }

    private void stopCapture() {
        Intent stop = ManualOcrService.isRunning()
                ? new Intent(this, ManualOcrService.class).setAction(ManualOcrService.ACTION_STOP)
                : new Intent(this, OcrCaptureService.class).setAction(OcrCaptureService.ACTION_STOP);
        startService(stop);
        setStatus("正在停止");
    }

    private void renderResults() {
        if (dashboard == null) return;
        List<JSONObject> rows = LocalStationStore.list(this);
        List<JSONObject> matched = recordFilter.apply(rows);
        dashboard.render(
                StationResultPresenter.present(matched, selectedFilter),
                !rows.isEmpty(),
                recordFilter.isActive() || selectedFilter != StationResultPresenter.Filter.ALL
        );
    }

    private void applyStartTime(long selectedEpochMillis) {
        if (!StationRecordFilter.isValidRange(selectedEpochMillis, recordFilter.endEpochMillis)) {
            showInvalidRange();
            return;
        }
        recordFilter = recordFilter.withStart(selectedEpochMillis);
        applyRecordFilterChange();
    }

    private void applyEndTime(long selectedEpochMillis) {
        if (!StationRecordFilter.isValidRange(recordFilter.startEpochMillis, selectedEpochMillis)) {
            showInvalidRange();
            return;
        }
        recordFilter = recordFilter.withEnd(selectedEpochMillis);
        applyRecordFilterChange();
    }

    private void applyRecordFilterChange() {
        dashboard.exitSelectionMode();
        dashboard.setRecordFilter(recordFilter);
        renderResults();
    }

    private void showInvalidRange() {
        Toast.makeText(this, "结束时间不能早于开始时间", Toast.LENGTH_SHORT).show();
    }

    private static StationResultPresenter.Filter restoreResultFilter(String value) {
        try {
            return StationResultPresenter.Filter.valueOf(value == null ? "" : value);
        } catch (IllegalArgumentException ignored) {
            return StationResultPresenter.Filter.ALL;
        }
    }

    static void schedulePendingUploads(Context context) {
        BackfillUploadRunner.flushManualAsync(context);
    }

    private void restoreBackfillDraft() {
        if (backfillDialog != null && backfillDialog.isShowing()) return;
        ManualBackfillDraftStore.State open = ManualBackfillDraftStore.findOpen(this);
        if (open != null) openBackfill(open);
    }

    private void openBackfill(ManualBackfillDraftStore.State state) {
        if (state == null || isFinishing()) return;
        if (backfillDialog != null && backfillDialog.isShowing()
                && state.stableIdentity.equals(backfillDialog.stableIdentity())) return;
        backfillDialog = ManualBackfillDialog.show(this, state, new ManualBackfillDialog.Listener() {
            @Override
            public void onSaved(ManualBackfillRepository.SaveResult result) {
                backfillDialog = null;
                renderResults();
                BackfillUploadRunner.uploadAsync(MainActivity.this, result.batchId);
            }

            @Override
            public void onDiscarded() {
                backfillDialog = null;
            }

            @Override
            public void onDeleted(ManualBackfillDraftStore.State state) {
                backfillDialog = null;
                if (state != null && state.stableIdentity != null) {
                    LocalStationStore.removeStableIdentity(MainActivity.this, state.stableIdentity);
                }
                renderResults();
                setStatus("已删除该记录");
            }
        });
    }

    private void confirmClear() {
        new AlertDialog.Builder(this)
                .setTitle("清理已回传结果")
                .setMessage("只清理已回传记录，待回传和待重试数据会保留。")
                .setNegativeButton("取消", null)
                .setPositiveButton("确认清理", (dialog, which) -> {
                    LocalStationStore.clearCompleted(this);
                    renderResults();
                })
                .show();
    }

    private void confirmDeleteSelected(java.util.Set<String> stableIdentities) {
        if (stableIdentities == null || stableIdentities.isEmpty()) return;
        new AlertDialog.Builder(this)
                .setTitle("删除选中记录")
                .setMessage("删除后这些本地记录无法恢复，已回传的服务端数据不受影响。共 " + stableIdentities.size() + " 条。")
                .setNegativeButton("取消", null)
                .setPositiveButton("确认删除", (dialog, which) -> {
                    for (String identity : stableIdentities) {
                        LocalStationStore.removeStableIdentity(this, identity);
                    }
                    dashboard.exitSelectionMode();
                    renderResults();
                    setStatus("已删除 " + stableIdentities.size() + " 条记录");
                })
                .show();
    }

    private void registerResultReceiver() {
        if (receiverRegistered) return;
        IntentFilter filter = new IntentFilter(OcrCaptureService.ACTION_RESULT_UPDATED);
        ContextCompat.registerReceiver(this, resultReceiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED);
        receiverRegistered = true;
    }

    private void registerCaptureReceiver() {
        if (captureReceiverRegistered) return;
        IntentFilter filter = new IntentFilter();
        filter.addAction(OcrCaptureService.ACTION_CAPTURE_READY);
        filter.addAction(OcrCaptureService.ACTION_CAPTURE_FAILED);
        ContextCompat.registerReceiver(this, captureReceiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED);
        captureReceiverRegistered = true;
    }

    private void registerManualResultReceiver() {
        if (manualReceiverRegistered) return;
        IntentFilter filter = new IntentFilter(ManualOcrService.ACTION_RESULT_UPDATED);
        ContextCompat.registerReceiver(this, manualResultReceiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED);
        manualReceiverRegistered = true;
    }

    private void scheduleReadyTimeout(String nonce) {
        awaitingReady = true;
        mainHandler.removeCallbacksAndMessages(null);
        mainHandler.postDelayed(() -> {
            if (captureReadyGate.timeout(nonce) != CaptureReadyGate.Outcome.FAILED) return;
            awaitingReady = false;
            try {
                startService(new Intent(this, OcrCaptureService.class).setAction(OcrCaptureService.ACTION_STOP));
            } catch (RuntimeException ignored) {
                // Timeout status remains accurate even if the service already terminated.
            }
            setStatus("启动超时");
        }, CAPTURE_READY_TIMEOUT_MS);
    }

    private void acceptCaptureReady(String nonce) {
        if (captureReadyGate.ready(nonce) != CaptureReadyGate.Outcome.READY) return;
        awaitingReady = false;
        mainHandler.removeCallbacksAndMessages(null);
        setStatus("采集中");
        moveTaskToBack(true);
    }

    private void requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQUEST_NOTIFICATIONS);
        }
    }

    private void setStatus(String value) {
        captureUiState = CaptureUiState.from(
                value,
                OcrCaptureService.isRunning(),
                awaitingReady
        );
        if (dashboard != null) dashboard.setCaptureState(captureUiState);
    }
}
