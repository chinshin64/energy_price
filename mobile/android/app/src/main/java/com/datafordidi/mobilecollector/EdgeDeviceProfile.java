package com.datafordidi.mobilecollector;

import android.app.ActivityManager;
import android.content.Context;
import android.os.Build;
import android.util.DisplayMetrics;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.Locale;
import java.util.TimeZone;

final class EdgeDeviceProfile {
    private EdgeDeviceProfile() {
    }

    static JSONObject build(Context context) throws JSONException {
        ActivityManager.MemoryInfo memoryInfo = new ActivityManager.MemoryInfo();
        ActivityManager manager = (ActivityManager) context.getSystemService(Context.ACTIVITY_SERVICE);
        if (manager != null) {
            manager.getMemoryInfo(memoryInfo);
        }
        DisplayMetrics display = context.getResources().getDisplayMetrics();
        String architecture = Build.SUPPORTED_ABIS.length > 0 ? Build.SUPPORTED_ABIS[0] : Build.CPU_ABI;
        return new JSONObject()
                .put("manufacturer", bounded(Build.MANUFACTURER))
                .put("model", bounded(Build.MODEL))
                .put("osName", "android")
                .put("osVersion", bounded(Build.VERSION.RELEASE))
                .put("osBuild", "sdk-" + Build.VERSION.SDK_INT)
                .put("architecture", bounded(architecture))
                .put("cpuCount", Runtime.getRuntime().availableProcessors())
                .put("memoryMb", Math.max(0L, memoryInfo.totalMem / 1024L / 1024L))
                .put("installationIdHash", DeviceIdentity.get(context))
                .put("appVersion", "android-" + BuildConfig.VERSION_NAME)
                .put("wechatInstalled", packageInstalled(context, "com.tencent.mm"))
                .put("wechatRunning", "com.tencent.mm".equals(AutoScrollAccessibilityService.getCurrentPackageName()))
                .put("screenWidth", display.widthPixels)
                .put("screenHeight", display.heightPixels)
                .put("locale", bounded(Locale.getDefault().toLanguageTag()))
                .put("timezone", bounded(TimeZone.getDefault().getID()));
    }

    static String fingerprintHash(Context context) {
        String material = DeviceIdentity.get(context)
                + ":" + Build.MANUFACTURER
                + ":" + Build.MODEL
                + ":" + Build.VERSION.SDK_INT
                + ":" + (Build.SUPPORTED_ABIS.length > 0 ? Build.SUPPORTED_ABIS[0] : Build.CPU_ABI);
        return DeviceIdentity.hash(material);
    }

    static JSONArray capabilities() {
        return new JSONArray()
                .put("system.status")
                .put("android.wechat.collect")
                .put("android.wechat.accessibility")
                .put("android.mock-location");
    }

    private static boolean packageInstalled(Context context, String packageName) {
        try {
            context.getPackageManager().getApplicationInfo(packageName, 0);
            return true;
        } catch (Exception ignored) {
            return false;
        }
    }

    private static String bounded(String value) {
        String normalized = value == null ? "" : value.trim();
        return normalized.length() <= 160 ? normalized : normalized.substring(0, 160);
    }
}
