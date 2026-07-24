package com.datafordidi.mobilecollector;

final class ManualReviewPolicy {
    static final long MAX_REVIEW_DELAY_MS = 3_000L;
    private static final int REQUIRED_STABLE_SAMPLES = 2;

    private ManualReviewPolicy() {
    }

    static boolean shouldReview(
            boolean rawFrameChanged,
            int stableSamples,
            long elapsedMillis
    ) {
        return rawFrameChanged
                && (stableSamples >= REQUIRED_STABLE_SAMPLES
                || elapsedMillis >= MAX_REVIEW_DELAY_MS);
    }
}
