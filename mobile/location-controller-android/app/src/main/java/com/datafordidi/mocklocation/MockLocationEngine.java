package com.datafordidi.mocklocation;

import android.annotation.SuppressLint;
import android.annotation.TargetApi;
import android.content.Context;
import android.location.Criteria;
import android.location.Location;
import android.location.LocationManager;
import android.location.provider.ProviderProperties;
import android.os.Build;
import android.os.SystemClock;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

public final class MockLocationEngine {
    private static final String[] PROVIDERS = new String[]{
            LocationManager.GPS_PROVIDER,
            LocationManager.NETWORK_PROVIDER,
            "fused"
    };

    private final LocationManager locationManager;
    private final Set<String> preparedProviders = new HashSet<>();

    public MockLocationEngine(Context context) {
        locationManager = (LocationManager) context.getSystemService(Context.LOCATION_SERVICE);
    }

    public List<String> apply(GeoCoordinate coordinate, float accuracyMeters) {
        List<String> appliedProviders = new ArrayList<>();
        List<String> errors = new ArrayList<>();
        for (String provider : PROVIDERS) {
            try {
                applyToProvider(provider, coordinate, accuracyMeters);
                appliedProviders.add(provider);
            } catch (RuntimeException error) {
                errors.add(provider + ": " + error.getMessage());
            }
        }
        if (appliedProviders.isEmpty()) {
            throw new SecurityException(errors.isEmpty()
                    ? "no test location provider was available"
                    : String.join("; ", errors));
        }
        return appliedProviders;
    }

    public void stop() {
        for (String provider : PROVIDERS) {
            try {
                locationManager.setTestProviderEnabled(provider, false);
            } catch (RuntimeException ignored) {
                // The provider may already be restored or owned by the system.
            }
            try {
                locationManager.removeTestProvider(provider);
            } catch (RuntimeException ignored) {
                // Removing an absent provider is safe during recovery.
            }
        }
        preparedProviders.clear();
    }

    private void ensureTestProvider(String provider) {
        if (preparedProviders.contains(provider)) {
            return;
        }
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                addModernTestProvider(provider);
            } else {
                addLegacyTestProvider(provider);
            }
        } catch (IllegalArgumentException alreadyExists) {
            // Repeated updates use the existing test provider.
        }
        preparedProviders.add(provider);
    }

    @TargetApi(Build.VERSION_CODES.S)
    private void addModernTestProvider(String provider) {
        ProviderProperties properties = new ProviderProperties.Builder()
                .setHasAltitudeSupport(true)
                .setHasSpeedSupport(true)
                .setHasBearingSupport(true)
                .setPowerUsage(ProviderProperties.POWER_USAGE_LOW)
                .setAccuracy(ProviderProperties.ACCURACY_FINE)
                .build();
        locationManager.addTestProvider(provider, properties);
    }

    @SuppressLint("WrongConstant")
    @SuppressWarnings("deprecation")
    private void addLegacyTestProvider(String provider) {
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
    }

    private void applyToProvider(String provider, GeoCoordinate coordinate, float accuracyMeters) {
        ensureTestProvider(provider);
        try {
            writeProviderLocation(provider, coordinate, accuracyMeters);
        } catch (IllegalArgumentException staleProvider) {
            preparedProviders.remove(provider);
            ensureTestProvider(provider);
            writeProviderLocation(provider, coordinate, accuracyMeters);
        }
    }

    private void writeProviderLocation(String provider, GeoCoordinate coordinate, float accuracyMeters) {
        locationManager.setTestProviderEnabled(provider, true);
        locationManager.setTestProviderLocation(
                provider,
                buildLocation(provider, coordinate, accuracyMeters)
        );
    }

    private static Location buildLocation(
            String provider,
            GeoCoordinate coordinate,
            float accuracyMeters
    ) {
        Location location = new Location(provider);
        location.setLatitude(coordinate.latitude());
        location.setLongitude(coordinate.longitude());
        location.setAccuracy(Math.max(1.0f, accuracyMeters));
        location.setAltitude(0.0d);
        location.setBearing(0.0f);
        location.setSpeed(0.0f);
        location.setTime(System.currentTimeMillis());
        location.setElapsedRealtimeNanos(SystemClock.elapsedRealtimeNanos());
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            location.setVerticalAccuracyMeters(Math.max(1.0f, accuracyMeters));
            location.setSpeedAccuracyMetersPerSecond(0.1f);
            location.setBearingAccuracyDegrees(0.1f);
        }
        return location;
    }
}
