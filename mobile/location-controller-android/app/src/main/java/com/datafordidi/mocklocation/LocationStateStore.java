package com.datafordidi.mocklocation;

import android.content.Context;
import android.content.SharedPreferences;

public final class LocationStateStore {
    private static final String PREFERENCES = "location_controller";
    private static final String KEY_LATITUDE = "latitude";
    private static final String KEY_LONGITUDE = "longitude";
    private static final String KEY_ACTIVE = "active";
    private static final String KEY_HEARTBEAT_AT = "heartbeat_at";
    private static final long ACTIVE_HEARTBEAT_MAX_AGE_MS = 5000L;
    private static final double DEFAULT_LATITUDE = 31.230400d;
    private static final double DEFAULT_LONGITUDE = 121.473700d;

    private final SharedPreferences preferences;

    public LocationStateStore(Context context) {
        preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
    }

    public GeoCoordinate selectedCoordinate() {
        double lat = Double.longBitsToDouble(preferences.getLong(
                KEY_LATITUDE,
                Double.doubleToRawLongBits(DEFAULT_LATITUDE)
        ));
        double lng = Double.longBitsToDouble(preferences.getLong(
                KEY_LONGITUDE,
                Double.doubleToRawLongBits(DEFAULT_LONGITUDE)
        ));
        return new GeoCoordinate(lat, lng);
    }

    public void saveSelection(GeoCoordinate coordinate) {
        preferences.edit()
                .putLong(KEY_LATITUDE, Double.doubleToRawLongBits(coordinate.latitude()))
                .putLong(KEY_LONGITUDE, Double.doubleToRawLongBits(coordinate.longitude()))
                .apply();
    }

    public boolean isActive() {
        long heartbeatAt = preferences.getLong(KEY_HEARTBEAT_AT, 0L);
        long heartbeatAge = Math.max(0L, System.currentTimeMillis() - heartbeatAt);
        return preferences.getBoolean(KEY_ACTIVE, false)
                && heartbeatAt > 0L
                && heartbeatAge <= ACTIVE_HEARTBEAT_MAX_AGE_MS;
    }

    public void setActive(boolean active) {
        SharedPreferences.Editor editor = preferences.edit().putBoolean(KEY_ACTIVE, active);
        if (active) {
            editor.putLong(KEY_HEARTBEAT_AT, System.currentTimeMillis());
        } else {
            editor.remove(KEY_HEARTBEAT_AT);
        }
        editor.apply();
    }

    public void markHeartbeat() {
        preferences.edit()
                .putBoolean(KEY_ACTIVE, true)
                .putLong(KEY_HEARTBEAT_AT, System.currentTimeMillis())
                .apply();
    }
}
