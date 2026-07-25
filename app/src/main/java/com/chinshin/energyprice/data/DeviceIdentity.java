package com.chinshin.energyprice.data;

import android.content.Context;
import android.content.SharedPreferences;

import java.util.UUID;

public final class DeviceIdentity {
    private static final String PREFS = "device_identity";
    private static final String KEY_DEVICE_ID = "device_id";
    private static final String KEY_PAGE_INDEX = "page_index";

    private DeviceIdentity() {}

    public static synchronized String deviceId(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String value = prefs.getString(KEY_DEVICE_ID, null);
        if (value == null) {
            value = UUID.randomUUID().toString();
            prefs.edit().putString(KEY_DEVICE_ID, value).apply();
        }
        return value;
    }

    public static synchronized int nextPageIndex(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        int next = prefs.getInt(KEY_PAGE_INDEX, -1) + 1;
        prefs.edit().putInt(KEY_PAGE_INDEX, next).apply();
        return next;
    }
}
