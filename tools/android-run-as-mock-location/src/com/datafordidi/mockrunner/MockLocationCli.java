package com.datafordidi.mockrunner;

import android.content.Context;
import android.location.Criteria;
import android.location.Location;
import android.location.LocationManager;
import android.os.Build;
import android.os.SystemClock;

import java.lang.reflect.Method;

public final class MockLocationCli {
    private static final String PACKAGE_NAME = "com.datafordidi.mobilecollector";
    private static final String[] PROVIDERS = new String[] {
            LocationManager.GPS_PROVIDER,
            LocationManager.NETWORK_PROVIDER,
            "fused"
    };

    private MockLocationCli() {}

    public static void main(String[] args) throws Exception {
        if (args.length < 2) {
            System.err.println("usage: MockLocationCli <lat> <lng> [accuracy] [repeat] [intervalMs]");
            System.exit(2);
            return;
        }

        double lat = Double.parseDouble(args[0]);
        double lng = Double.parseDouble(args[1]);
        float accuracy = args.length >= 3 ? Float.parseFloat(args[2]) : 15.0f;
        int repeat = args.length >= 4 ? Math.max(1, Integer.parseInt(args[3])) : 1;
        long intervalMs = args.length >= 5 ? Math.max(100L, Long.parseLong(args[4])) : 500L;

        Context context = packageContext();
        LocationManager locationManager = (LocationManager) context.getSystemService(Context.LOCATION_SERVICE);
        for (int index = 0; index < repeat; index++) {
            for (String provider : PROVIDERS) {
                setProviderLocation(locationManager, provider, lat, lng, accuracy);
            }
            if (index + 1 < repeat) {
                Thread.sleep(intervalMs);
            }
        }
        System.out.println("{\"success\":true,\"lat\":" + lat + ",\"lng\":" + lng
                + ",\"repeat\":" + repeat + ",\"intervalMs\":" + intervalMs + "}");
    }

    private static Context packageContext() throws Exception {
        Class<?> activityThreadClass = Class.forName("android.app.ActivityThread");
        Method systemMain = activityThreadClass.getDeclaredMethod("systemMain");
        systemMain.setAccessible(true);
        Object activityThread = systemMain.invoke(null);
        Method getSystemContext = activityThreadClass.getDeclaredMethod("getSystemContext");
        getSystemContext.setAccessible(true);
        Context systemContext = (Context) getSystemContext.invoke(activityThread);
        return systemContext.createPackageContext(PACKAGE_NAME, Context.CONTEXT_IGNORE_SECURITY);
    }

    private static void setProviderLocation(
            LocationManager locationManager,
            String provider,
            double lat,
            double lng,
            float accuracy
    ) {
        ensureProvider(locationManager, provider);
        locationManager.setTestProviderEnabled(provider, true);
        locationManager.setTestProviderLocation(provider, buildLocation(provider, lat, lng, accuracy));
    }

    private static void ensureProvider(LocationManager locationManager, String provider) {
        try {
            locationManager.addTestProvider(
                    provider,
                    false,
                    false,
                    false,
                    false,
                    true,
                    true,
                    true,
                    Criteria.POWER_LOW,
                    Criteria.ACCURACY_FINE
            );
        } catch (IllegalArgumentException alreadyExists) {
            // Provider already exists; updating it is enough.
        }
    }

    private static Location buildLocation(String provider, double lat, double lng, float accuracy) {
        Location location = new Location(provider);
        location.setLatitude(lat);
        location.setLongitude(lng);
        location.setAccuracy(accuracy);
        location.setTime(System.currentTimeMillis());
        location.setElapsedRealtimeNanos(SystemClock.elapsedRealtimeNanos());
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            location.setVerticalAccuracyMeters(accuracy);
            location.setSpeedAccuracyMetersPerSecond(0.1f);
            location.setBearingAccuracyDegrees(0.1f);
        }
        return location;
    }
}
