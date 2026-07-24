package com.datafordidi.mocklocation;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

public final class ExternalLocationReceiver extends BroadcastReceiver {
    public static final String ACTION_SET = "com.datafordidi.mocklocation.SET_LOCATION";
    public static final String ACTION_STOP = "com.datafordidi.mocklocation.STOP_LOCATION";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) {
            return;
        }
        if (ACTION_STOP.equals(intent.getAction())) {
            context.startService(MockLocationService.stopIntent(context));
            setResultCode(0);
            setResultData("stopped");
            return;
        }
        if (!ACTION_SET.equals(intent.getAction())) {
            return;
        }

        try {
            GeoCoordinate coordinate = new GeoCoordinate(
                    readDouble(intent, "lat"),
                    readDouble(intent, "lng")
            );
            Intent serviceIntent = MockLocationService.startIntent(context, coordinate);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(serviceIntent);
            } else {
                context.startService(serviceIntent);
            }
            setResultCode(0);
            setResultData("accepted");
        } catch (RuntimeException error) {
            setResultCode(2);
            setResultData(error.getMessage());
        }
    }

    private static double readDouble(Intent intent, String key) {
        if (intent.getExtras() == null || !intent.getExtras().containsKey(key)) {
            return Double.NaN;
        }
        Object value = intent.getExtras().get(key);
        if (value instanceof Number) {
            return ((Number) value).doubleValue();
        }
        return Double.parseDouble(String.valueOf(value));
    }
}
