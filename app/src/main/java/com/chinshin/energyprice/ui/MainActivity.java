package com.chinshin.energyprice.ui;

import android.Manifest;
import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.media.projection.MediaProjectionManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.view.View;
import android.widget.Toast;

import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import androidx.recyclerview.widget.LinearLayoutManager;

import com.chinshin.energyprice.capture.FloatingCaptureService;
import com.chinshin.energyprice.data.CaptureRecord;
import com.chinshin.energyprice.data.EnergyDatabase;
import com.chinshin.energyprice.databinding.ActivityMainBinding;
import com.chinshin.energyprice.security.SecureConfigStore;
import com.chinshin.energyprice.worker.SyncScheduler;

import java.io.File;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class MainActivity extends AppCompatActivity {
    public static final String ACTION_DATA_CHANGED = "com.chinshin.energyprice.DATA_CHANGED";

    private ActivityMainBinding binding;
    private RecordAdapter adapter;
    private ActivityResultLauncher<Intent> projectionLauncher;
    private ActivityResultLauncher<Intent> overlayPermissionLauncher;
    private ActivityResultLauncher<String> notificationPermissionLauncher;
    private boolean waitingForOverlayPermission;
    private final ExecutorService executor = Executors.newSingleThreadExecutor();

    private final BroadcastReceiver appReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (intent == null) return;
            if (FloatingCaptureService.ACTION_STATUS_CHANGED.equals(intent.getAction())) {
                renderCaptureState(intent.getStringExtra(FloatingCaptureService.EXTRA_STATUS));
            } else if (ACTION_DATA_CHANGED.equals(intent.getAction())) {
                refresh();
            }
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        binding = ActivityMainBinding.inflate(getLayoutInflater());
        setContentView(binding.getRoot());

        SecureConfigStore.importProvisioningIfPresent(this);
        SyncScheduler.ensurePeriodic(this);

        projectionLauncher = registerForActivityResult(
                new ActivityResultContracts.StartActivityForResult(),
                result -> {
                    Intent data = result.getData();
                    if (result.getResultCode() != Activity.RESULT_OK || data == null) {
                        renderCaptureState("未获得系统截屏授权");
                        return;
                    }
                    ContextCompat.startForegroundService(
                            this,
                            FloatingCaptureService.startIntent(this, result.getResultCode(), data)
                    );
                    renderCaptureState("正在启动悬浮截屏");
                }
        );

        overlayPermissionLauncher = registerForActivityResult(
                new ActivityResultContracts.StartActivityForResult(),
                result -> continueAfterOverlayPermission()
        );

        notificationPermissionLauncher = registerForActivityResult(
                new ActivityResultContracts.RequestPermission(),
                granted -> launchProjectionConsent()
        );

        adapter = new RecordAdapter(this::renderSelection);
        binding.recordsList.setLayoutManager(new LinearLayoutManager(this));
        binding.recordsList.setAdapter(adapter);

        binding.captureButton.setOnClickListener(v -> toggleCapture());
        binding.exportButton.setOnClickListener(v -> exportCsv());
        binding.selectAllButton.setOnClickListener(v -> adapter.selectAll());
        binding.cancelSelectionButton.setOnClickListener(v -> adapter.exitSelectionMode());
        binding.deleteButton.setOnClickListener(v -> deleteSelected());

        IntentFilter filter = new IntentFilter();
        filter.addAction(ACTION_DATA_CHANGED);
        filter.addAction(FloatingCaptureService.ACTION_STATUS_CHANGED);
        if (Build.VERSION.SDK_INT >= 33) {
            registerReceiver(appReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(appReceiver, filter);
        }
        refresh();
        renderCaptureState(FloatingCaptureService.lastStatus());
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (waitingForOverlayPermission && Settings.canDrawOverlays(this)) {
            continueAfterOverlayPermission();
        } else {
            renderCaptureState(FloatingCaptureService.lastStatus());
        }
    }

    @Override
    protected void onDestroy() {
        unregisterReceiver(appReceiver);
        executor.shutdownNow();
        super.onDestroy();
    }

    private void toggleCapture() {
        if (FloatingCaptureService.isRunning()) {
            startService(FloatingCaptureService.stopIntent(this));
            renderCaptureState("正在停止悬浮截屏");
            return;
        }
        if (!Settings.canDrawOverlays(this)) {
            waitingForOverlayPermission = true;
            renderCaptureState("请允许油价采集显示悬浮窗");
            Intent intent = new Intent(
                    Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    Uri.parse("package:" + getPackageName())
            );
            overlayPermissionLauncher.launch(intent);
            return;
        }
        requestNotificationThenProjection();
    }

    private void continueAfterOverlayPermission() {
        if (!waitingForOverlayPermission) return;
        waitingForOverlayPermission = false;
        if (!Settings.canDrawOverlays(this)) {
            renderCaptureState("未获得悬浮窗权限，无法显示截屏按钮");
            return;
        }
        requestNotificationThenProjection();
    }

    private void requestNotificationThenProjection() {
        if (Build.VERSION.SDK_INT >= 33
                && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
            notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS);
            return;
        }
        launchProjectionConsent();
    }

    private void launchProjectionConsent() {
        MediaProjectionManager manager = (MediaProjectionManager) getSystemService(MEDIA_PROJECTION_SERVICE);
        projectionLauncher.launch(manager.createScreenCaptureIntent());
    }

    private void renderCaptureState(String status) {
        if (binding == null) return;
        boolean running = FloatingCaptureService.isRunning();
        binding.captureButton.setText(running ? "停止悬浮截屏" : "启动悬浮截屏");
        String visibleStatus = status == null || status.trim().isEmpty()
                ? (running ? "悬浮截屏已启动" : "尚未启动悬浮截屏")
                : status;
        binding.captureStatus.setText(visibleStatus);
    }

    private void refresh() {
        executor.execute(() -> {
            EnergyDatabase db = EnergyDatabase.get(this);
            List<CaptureRecord> records = db.listAll();
            EnergyDatabase.Stats stats = db.stats();
            runOnUiThread(() -> {
                adapter.submit(records);
                binding.totalStat.setText("总记录\n" + stats.total());
                binding.validStat.setText("有效\n" + stats.valid());
                binding.grade92Stat.setText("92#\n" + stats.grade92());
                binding.grade95Stat.setText("95#\n" + stats.grade95());
                boolean empty = records.isEmpty();
                binding.emptyView.setVisibility(empty ? View.VISIBLE : View.GONE);
                binding.recordsList.setVisibility(empty ? View.GONE : View.VISIBLE);
            });
        });
    }

    private void renderSelection(int count) {
        boolean active = adapter != null && adapter.isSelectionMode();
        binding.selectionBar.setVisibility(active ? View.VISIBLE : View.GONE);
        binding.selectionCount.setText("已选 " + count + " 条");
    }

    private void deleteSelected() {
        List<Long> ids = adapter.selectedIds();
        if (ids.isEmpty()) return;
        executor.execute(() -> {
            EnergyDatabase.get(this).deleteIds(ids);
            runOnUiThread(() -> {
                adapter.exitSelectionMode();
                refresh();
            });
        });
    }

    private void exportCsv() {
        executor.execute(() -> {
            try {
                List<CaptureRecord> records = EnergyDatabase.get(this).listAll();
                File file = CsvExporter.export(this, records);
                Uri uri = FileProvider.getUriForFile(this, getPackageName() + ".files", file);
                Intent share = new Intent(Intent.ACTION_SEND)
                        .setType("text/csv")
                        .putExtra(Intent.EXTRA_STREAM, uri)
                        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                runOnUiThread(() -> startActivity(Intent.createChooser(share, "导出采集记录")));
            } catch (Exception e) {
                runOnUiThread(() -> Toast.makeText(this, "导出失败", Toast.LENGTH_SHORT).show());
            }
        });
    }
}
