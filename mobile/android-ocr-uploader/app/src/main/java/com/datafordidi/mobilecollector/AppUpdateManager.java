package com.datafordidi.mobilecollector;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;

import androidx.core.content.FileProvider;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.security.MessageDigest;
import java.util.Arrays;

import okhttp3.HttpUrl;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;

final class AppUpdateManager {
    private static final String PREFS = "standalone_ocr_updates";
    private static final String LAST_CHECK = "lastCheckedAt";
    private static final OkHttpClient HTTP = new OkHttpClient.Builder()
            .followRedirects(false)
            .followSslRedirects(false)
            .build();

    private AppUpdateManager() {
    }

    static void check(Activity activity, boolean manual) {
        check(activity, manual, false);
    }

    static void checkOnColdStart(Activity activity) {
        check(activity, false, true);
    }

    private static void check(Activity activity, boolean manual, boolean coldStart) {
        long now = System.currentTimeMillis();
        long last = activity.getSharedPreferences(PREFS, Activity.MODE_PRIVATE)
                .getLong(LAST_CHECK, 0L);
        if (!manual && !coldStart && !AppUpdatePolicy.due(now, last)) return;
        activity.getSharedPreferences(PREFS, Activity.MODE_PRIVATE)
                .edit()
                .putLong(LAST_CHECK, now)
                .apply();
        new Thread(() -> performCheck(activity, manual), "app-update-check").start();
    }

    private static void performCheck(Activity activity, boolean manual) {
        try {
            String base = AppSettings.getUpdateBaseUrl(activity);
            if (base.isEmpty()) {
                if (manual) postMessage(activity, "尚未配置更新服务");
                return;
            }
            PackageInfo installed = installed(activity);
            long currentVersion = versionCode(installed);
            HttpUrl latest = HttpUrl.get(base + "latest").newBuilder()
                    .addQueryParameter("packageName", activity.getPackageName())
                    .addQueryParameter("versionCode", String.valueOf(currentVersion))
                    .addQueryParameter("abi", "arm64-v8a")
                    .build();
            Request request = new Request.Builder().url(latest).get().build();
            try (Response response = HTTP.newCall(request).execute()) {
                if (!response.isSuccessful() || response.body() == null) {
                    throw new IllegalStateException("update_check_failed");
                }
                AppUpdatePolicy.Manifest manifest = AppUpdatePolicy.parse(
                        new JSONObject(response.body().string()),
                        activity.getPackageName(),
                        currentVersion
                );
                if (!AppUpdatePolicy.isNewer(manifest, currentVersion)) {
                    if (manual) postMessage(activity, "已是最新版本");
                    return;
                }
                activity.runOnUiThread(() -> new AlertDialog.Builder(activity)
                        .setTitle("发现新版本 " + manifest.versionName)
                        .setMessage("是否下载并交由系统安装？")
                        .setNegativeButton("取消", null)
                        .setPositiveButton(
                                "下载",
                                (dialog, which) -> download(activity, base, manifest)
                        )
                        .show());
            }
        } catch (Exception ignored) {
            if (manual) postMessage(activity, "检查更新失败");
        }
    }

    private static void download(
            Activity activity,
            String base,
            AppUpdatePolicy.Manifest manifest
    ) {
        new Thread(() -> {
            File directory = new File(activity.getFilesDir(), "updates");
            File temporary = new File(directory, "update.tmp");
            File verified = new File(directory, "update-" + manifest.versionCode + ".apk");
            try {
                if (!directory.isDirectory() && !directory.mkdirs()) {
                    throw new IllegalStateException("update_storage_failed");
                }
                Request request = new Request.Builder().url(base + manifest.apkPath).get().build();
                MessageDigest digest = MessageDigest.getInstance("SHA-256");
                long count = 0;
                try (Response response = HTTP.newCall(request).execute()) {
                    if (!response.isSuccessful() || response.body() == null) {
                        throw new IllegalStateException("update_download_failed");
                    }
                    try (InputStream input = response.body().byteStream();
                         FileOutputStream output = new FileOutputStream(temporary, false)) {
                        byte[] buffer = new byte[8192];
                        int read;
                        while ((read = input.read(buffer)) >= 0) {
                            count += read;
                            if (count > AppUpdatePolicy.MAX_APK_BYTES) {
                                throw new IllegalStateException("update_too_large");
                            }
                            digest.update(buffer, 0, read);
                            output.write(buffer, 0, read);
                        }
                        output.getFD().sync();
                    }
                }
                if (count != manifest.size || !hex(digest.digest()).equals(manifest.sha256)) {
                    throw new IllegalStateException("update_digest_failed");
                }
                verifyArchive(activity, temporary, manifest);
                if (verified.exists() && !verified.delete()) {
                    throw new IllegalStateException("update_storage_failed");
                }
                if (!temporary.renameTo(verified)) {
                    throw new IllegalStateException("update_storage_failed");
                }
                install(activity, verified);
            } catch (Exception ignored) {
                temporary.delete();
                postMessage(activity, "更新包校验失败");
            }
        }, "app-update-download").start();
    }

    private static void verifyArchive(
            Activity activity,
            File apk,
            AppUpdatePolicy.Manifest manifest
    ) throws Exception {
        PackageManager manager = activity.getPackageManager();
        PackageInfo archive = manager.getPackageArchiveInfo(apk.getAbsolutePath(), signingFlags());
        PackageInfo installed = installed(activity);
        if (archive == null || !activity.getPackageName().equals(archive.packageName)
                || versionCode(archive) != manifest.versionCode
                || versionCode(archive) <= versionCode(installed)
                || !Arrays.deepEquals(certificates(installed), certificates(archive))) {
            throw new IllegalStateException("update_apk_identity_failed");
        }
    }

    private static byte[][] certificates(PackageInfo info) throws Exception {
        android.content.pm.Signature[] signatures;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            signatures = info.signingInfo.getApkContentsSigners();
        } else {
            signatures = info.signatures;
        }
        byte[][] output = new byte[signatures.length][];
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        for (int index = 0; index < signatures.length; index++) {
            output[index] = digest.digest(signatures[index].toByteArray());
        }
        Arrays.sort(output, AppUpdateManager::compareBytes);
        return output;
    }

    private static PackageInfo installed(Activity activity) throws Exception {
        return activity.getPackageManager().getPackageInfo(
                activity.getPackageName(),
                signingFlags()
        );
    }

    private static int signingFlags() {
        return Build.VERSION.SDK_INT >= 28
                ? PackageManager.GET_SIGNING_CERTIFICATES
                : PackageManager.GET_SIGNATURES;
    }

    private static int compareBytes(byte[] left, byte[] right) {
        int length = Math.min(left.length, right.length);
        for (int index = 0; index < length; index++) {
            int compared = Integer.compare(left[index] & 0xff, right[index] & 0xff);
            if (compared != 0) return compared;
        }
        return Integer.compare(left.length, right.length);
    }

    private static long versionCode(PackageInfo info) {
        return Build.VERSION.SDK_INT >= 28 ? info.getLongVersionCode() : info.versionCode;
    }

    private static void install(Activity activity, File apk) {
        activity.runOnUiThread(() -> {
            Uri uri = FileProvider.getUriForFile(
                    activity,
                    activity.getPackageName() + ".updates",
                    apk
            );
            Intent intent = new Intent(Intent.ACTION_VIEW)
                    .setDataAndType(uri, "application/vnd.android.package-archive")
                    .addFlags(
                            Intent.FLAG_GRANT_READ_URI_PERMISSION
                                    | Intent.FLAG_ACTIVITY_NEW_TASK
                    );
            activity.startActivity(intent);
        });
    }

    private static void postMessage(Activity activity, String message) {
        activity.runOnUiThread(() -> new AlertDialog.Builder(activity)
                .setMessage(message)
                .setPositiveButton("知道了", null)
                .show());
    }

    private static String hex(byte[] bytes) {
        StringBuilder output = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) {
            output.append(String.format(java.util.Locale.ROOT, "%02x", value));
        }
        return output.toString();
    }
}
