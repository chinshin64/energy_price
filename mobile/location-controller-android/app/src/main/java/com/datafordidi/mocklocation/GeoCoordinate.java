package com.datafordidi.mocklocation;

import java.util.Locale;

public final class GeoCoordinate {
    private final double latitude;
    private final double longitude;

    public GeoCoordinate(double latitude, double longitude) {
        if (!CoordinateValidator.isValid(latitude, longitude)) {
            throw new IllegalArgumentException("coordinate out of range");
        }
        this.latitude = latitude;
        this.longitude = longitude;
    }

    public double latitude() {
        return latitude;
    }

    public double longitude() {
        return longitude;
    }

    public String latitudeText() {
        return String.format(Locale.US, "%.6f", latitude);
    }

    public String longitudeText() {
        return String.format(Locale.US, "%.6f", longitude);
    }
}
