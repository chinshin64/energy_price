package com.datafordidi.mobilecollector;

final class CaptureSessionPolicy {
    static final int MAX_PAGES = 250;
    static final long MAX_DURATION_MS = 30L * 60L * 1000L;

    private CaptureSessionPolicy() {
    }

    static boolean limitReached(long startedAt, long now, int pages) {
        return pages >= MAX_PAGES || now - startedAt >= MAX_DURATION_MS;
    }
}
