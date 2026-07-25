package com.chinshin.energyprice.ui;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.Uri;
import android.os.Bundle;
import android.provider.Settings;
import android.view.View;
import android.widget.Toast;

import androidx.appcompat.app.AppCompatActivity;
import androidx.core.content.FileProvider;
import androidx.recyclerview.widget.LinearLayoutManager;

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
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final BroadcastReceiver dataReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            refresh();
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        binding = ActivityMainBinding.inflate(getLayoutInflater());
        setContentView(binding.getRoot());

        SecureConfigStore.importProvisioningIfPresent(this);
        SyncScheduler.ensurePeriodic(this);

        adapter = new RecordAdapter(this::renderSelection);
        binding.recordsList.setLayoutManager(new LinearLayoutManager(this));
        binding.recordsList.setAdapter(adapter);

        binding.accessibilityButton.setOnClickListener(v -> startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)));
        binding.exportButton.setOnClickListener(v -> exportCsv());
        binding.selectAllButton.setOnClickListener(v -> adapter.selectAll());
        binding.cancelSelectionButton.setOnClickListener(v -> adapter.exitSelectionMode());
        binding.deleteButton.setOnClickListener(v -> deleteSelected());

        IntentFilter filter = new IntentFilter(ACTION_DATA_CHANGED);
        if (android.os.Build.VERSION.SDK_INT >= 33) registerReceiver(dataReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        else registerReceiver(dataReceiver, filter);
        refresh();
    }

    @Override
    protected void onDestroy() {
        unregisterReceiver(dataReceiver);
        executor.shutdownNow();
        super.onDestroy();
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
