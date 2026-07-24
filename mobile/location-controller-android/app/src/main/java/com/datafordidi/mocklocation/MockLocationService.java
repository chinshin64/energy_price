package com.datafordidi.mocklocation;

import android.annotation.SuppressLint;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;

@SuppressLint("LogNotTimber")
public final class MockLocationService extends Service {
    public static final String ACTION_START = "com.datafordidi.mocklocation.action.START";
    public static final String ACTION_STOP = "com.datafordidi.mocklocation.action.STOP";
    public static final String EXTRA_LATITUDE = "latitude";
    public static final String EXTRA_LONGITUDE = "longitude";
    private static final String TAG = "LocationController";
    private static final String CHANNEL_ID = "mock-location";
    private static final int NOTIFICATION_ID = 4101;
    private static final long UPDATE_INTERVAL_MS = 1000L;
    private static final float DEFAULT_ACCURACY_METERS = 15.0f;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private MockLocationEngine engine;
    private LocationStateStore stateStore;
    private GeoCoordinate activeCoordinate;

    private final Runnable locationWriter = new Runnable() {
        @Override
        public void run() {
            if (activeCoordinate == null) {
                return;
            }
            try {
                engine.apply(activeCoordinate, DEFAULT_ACCURACY_METERS);
                stateStore.markHeartbeat();
                handler.postDelayed(this, UPDATE_INTERVAL_MS);
            } catch (RuntimeException error) {
                Log.e(TAG, "mock location update failed", error);
                stopMockLocation();
            }
        }
    };

    public static Intent startIntent(Context context, GeoCoordinate coordinate) {
        return new Intent(context, MockLocationService.class)
                .setAction(ACTION_START)
                .putExtra(EXTRA_LATITUDE, coordinate.latitude())
                .putExtra(EXTRA_LONGITUDE, coordinate.longitude());
    }

    public static Intent stopIntent(Context context) {
        return new Intent(context, MockLocationService.class).setAction(ACTION_STOP);
    }

    @Override
    public void onCreate() {
        super.onCreate();
        engine = new MockLocationEngine(this);
        stateStore = new LocationStateStore(this);
        createNotificationChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? "" : intent.getAction();
        if (ACTION_STOP.equals(action)) {
            stopMockLocation();
            return START_NOT_STICKY;
        }
        if (!ACTION_START.equals(action) || intent == null) {
            stopSelf();
            return START_NOT_STICKY;
        }

        try {
            activeCoordinate = new GeoCoordinate(
                    intent.getDoubleExtra(EXTRA_LATITUDE, Double.NaN),
                    intent.getDoubleExtra(EXTRA_LONGITUDE, Double.NaN)
            );
            startForeground(NOTIFICATION_ID, buildNotification(activeCoordinate));
            engine.apply(activeCoordinate, DEFAULT_ACCURACY_METERS);
            stateStore.saveSelection(activeCoordinate);
            stateStore.markHeartbeat();
            handler.removeCallbacks(locationWriter);
            handler.postDelayed(locationWriter, UPDATE_INTERVAL_MS);
        } catch (RuntimeException error) {
            Log.e(TAG, "unable to start mock location", error);
            stopMockLocation();
        }
        return START_REDELIVER_INTENT;
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacks(locationWriter);
        if (activeCoordinate != null) {
            engine.stop();
        }
        stateStore.setActive(false);
        activeCoordinate = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void stopMockLocation() {
        handler.removeCallbacks(locationWriter);
        activeCoordinate = null;
        engine.stop();
        stateStore.setActive(false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE);
        } else {
            stopForeground(true);
        }
        stopSelf();
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                getString(R.string.location_notification_channel),
                NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription(getString(R.string.location_notification_channel));
        getSystemService(NotificationManager.class).createNotificationChannel(channel);
    }

    private Notification buildNotification(GeoCoordinate coordinate) {
        Intent openIntent = new Intent(this, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent openPendingIntent = PendingIntent.getActivity(
                this,
                0,
                openIntent,
                pendingIntentFlags()
        );
        PendingIntent stopPendingIntent = PendingIntent.getService(
                this,
                1,
                stopIntent(this),
                pendingIntentFlags()
        );

        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);
        return builder
                .setSmallIcon(android.R.drawable.ic_menu_mylocation)
                .setContentTitle(getString(R.string.location_notification_title))
                .setContentText(coordinate.latitudeText() + ", " + coordinate.longitudeText())
                .setContentIntent(openPendingIntent)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setCategory(Notification.CATEGORY_SERVICE)
                .addAction(
                        new Notification.Action.Builder(
                                android.R.drawable.ic_media_pause,
                                getString(R.string.notification_stop),
                                stopPendingIntent
                        ).build()
                )
                .build();
    }

    private static int pendingIntentFlags() {
        return PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
    }
}
