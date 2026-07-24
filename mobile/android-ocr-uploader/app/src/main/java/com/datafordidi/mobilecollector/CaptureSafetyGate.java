package com.datafordidi.mobilecollector;

final class CaptureSafetyGate {
    private CaptureSafetyGate() {
    }

    static boolean sameContext(
            String packageAtCapture,
            String currentPackage,
            String lockedPackage,
            boolean sameScreen
    ) {
        String captured = compact(packageAtCapture);
        String current = compact(currentPackage);
        String locked = compact(lockedPackage);
        if (captured.isEmpty() || !captured.equals(current) || !sameScreen) return false;
        return locked.isEmpty() || locked.equals(captured);
    }

    static boolean canLockTarget(
            String candidatePackage,
            String collectorPackage,
            boolean hasStationEvidence,
            boolean blockedPage
    ) {
        String candidate = compact(candidatePackage);
        String collector = compact(collectorPackage);
        return !candidate.isEmpty()
                && !candidate.equals(collector)
                && hasStationEvidence
                && !blockedPage;
    }

    private static String compact(String value) {
        return value == null ? "" : value.trim();
    }
}
