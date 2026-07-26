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
import android.view.View;
import android.widget.Toast;

import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import androidx.recyclerview.widget.LinearLayoutManager;

import com.chinshin.energyprice.capture.ScreenCaptureService;
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
    private ActivityResultLauncher<String> notificationPermissionLauncher;
    private final ExecutorService executor = Executors.newSingleThreadExecutor();

    private final BroadcastReceiver appReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (intent == null) return;
            if (ScreenCaptureService.ACTION_STATUS_CHANGED.equals(intent.getAction())) {
                String status = intent.getStringExtra(ScreenCaptureService.EXTRA_STATUS);
                renderCaptureState(status);
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
                            ScreenCaptureService.startIntent(this, result.getResultCode(), data)
                    );
                    renderCaptureState("正在启动截屏采集");
                }
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
        filter.addAction(ScreenCaptureService.ACTION_STATUS_CHANGED);
        if (Build.VERSION.SDK_INT >= 33) {
            registerReceiver(appReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(appReceiver, filter);
        }
        refresh();
        renderCaptureState(ScreenCaptureService.lastStatus());
    }

    @Override
    protected void onResume() {
        super.onResume();
        renderCaptureState(ScreenCaptureService.lastStatus());
    }

    @Override
    protected void onDestroy() {
        unregisterReceiver(appReceiver);
        executor.shutdownNow();
        super.onDestroy();
    }

    private void toggleCapture() {
        if (ScreenCaptureService.isRunning()) {
            startService(ScreenCaptureService.stopIntent(this));
            renderCaptureState("正在停止截屏采集");
            return;
        }
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
        boolean running = ScreenCaptureService.isRunning();
        binding.captureButton.setText(running ? "停止截屏采集" : "开始截屏采集");
        String visibleStatus = status == null || status.trim().isEmpty()
                ? (running ? "截屏采集中" : "尚未开始采集")
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
