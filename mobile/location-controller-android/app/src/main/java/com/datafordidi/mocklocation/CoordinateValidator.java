package com.datafordidi.mocklocation;

public final class CoordinateValidator {
    private CoordinateValidator() {
    }

    public static GeoCoordinate parse(String latitude, String longitude) {
        try {
            double lat = Double.parseDouble(clean(latitude));
            double lng = Double.parseDouble(clean(longitude));
            return new GeoCoordinate(lat, lng);
        } catch (NumberFormatException error) {
            throw new IllegalArgumentException("latitude and longitude must be finite numbers", error);
        }
    }

    public static boolean isValid(double latitude, double longitude) {
        return Double.isFinite(latitude)
                && Double.isFinite(longitude)
                && latitude >= -90.0d
                && latitude <= 90.0d
                && longitude >= -180.0d
                && longitude <= 180.0d;
    }

    private static String clean(String value) {
        String cleaned = value == null ? "" : value.trim();
        if (cleaned.isEmpty()) {
            throw new NumberFormatException("coordinate is empty");
        }
        return cleaned;
    }
}
