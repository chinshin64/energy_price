package com.datafordidi.mobilecollector;

final class CaptureContextPolicy {
    private CaptureContextPolicy() {
    }

    static String parserPackage(boolean accessibilityMode, String currentPackage) {
        if (!accessibilityMode) return "";
        return currentPackage == null ? "" : currentPackage.trim();
    }

    static boolean canLockRealPackage(boolean accessibilityMode, String currentPackage) {
        return accessibilityMode && currentPackage != null && !currentPackage.trim().isEmpty();
    }
}
