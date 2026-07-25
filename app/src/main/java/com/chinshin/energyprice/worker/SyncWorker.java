package com.chinshin.energyprice.worker;

import android.content.Context;

import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import com.chinshin.energyprice.data.CaptureRecord;
import com.chinshin.energyprice.data.EnergyDatabase;
import com.chinshin.energyprice.net.MobileSourceClient;
import com.chinshin.energyprice.security.SecureConfigStore;

import java.util.List;

public final class SyncWorker extends Worker {
    public SyncWorker(@NonNull Context appContext, @NonNull WorkerParameters workerParams) {
        super(appContext, workerParams);
    }

    @NonNull
    @Override
    public Result doWork() {
        SecureConfigStore.importProvisioningIfPresent(getApplicationContext());
        SecureConfigStore.Config config = SecureConfigStore.read(getApplicationContext());
        if (config == null) return Result.retry();

        EnergyDatabase db = EnergyDatabase.get(getApplicationContext());
        List<CaptureRecord> pending = db.listPending(20);
        if (pending.isEmpty()) return Result.success();

        MobileSourceClient client = new MobileSourceClient();
        boolean anyFailure = false;
        for (CaptureRecord record : pending) {
            try {
                MobileSourceClient.UploadResult result = client.upload(config, record);
                if (result.success()) {
                    db.markSynced(record.id);
                } else {
                    anyFailure = true;
                    db.markFailure(record.id, "HTTP " + result.statusCode() + " " + result.responseBody());
                    if (result.statusCode() == 401 || result.statusCode() == 403) break;
                }
            } catch (Exception e) {
                anyFailure = true;
                db.markFailure(record.id, e.getClass().getSimpleName() + ": " + e.getMessage());
                break;
            }
        }
        return anyFailure ? Result.retry() : Result.success();
    }
}
