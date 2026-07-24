package com.datafordidi.mobilecollector;

final class ScreenStabilityPolicy {
    private static final int CONTEXT_DISTANCE = 12;
    private static final int CHANGE_DISTANCE = 8;

    private ScreenStabilityPolicy() {
    }

    static boolean sameStructure(String first, String second) {
        return distance(first, second) <= CONTEXT_DISTANCE;
    }

    static boolean meaningfullyChanged(String first, String second) {
        return distance(first, second) > CHANGE_DISTANCE;
    }

    static int distance(String first, String second) {
        if (first == null || second == null || first.length() != 16 || second.length() != 16) {
            return Integer.MAX_VALUE;
        }
        try {
            return Long.bitCount(Long.parseUnsignedLong(first, 16) ^ Long.parseUnsignedLong(second, 16));
        } catch (NumberFormatException error) {
            return Integer.MAX_VALUE;
        }
    }
}
