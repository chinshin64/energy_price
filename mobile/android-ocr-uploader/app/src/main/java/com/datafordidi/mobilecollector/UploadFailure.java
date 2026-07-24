package com.datafordidi.mobilecollector;

import java.io.IOException;

/**
 * Classifies upload failures without coupling the durable outbox to OkHttp.
 */
final class UploadFailure extends IllegalStateException {
    enum Disposition {
        RETRYABLE,
        MANUAL_REVIEW
    }

    private final Disposition disposition;

    private UploadFailure(String message, Disposition disposition) {
        super(message);
        this.disposition = disposition;
    }

    static UploadFailure retryable(String message) {
        return new UploadFailure(message, Disposition.RETRYABLE);
    }

    static UploadFailure manualReview(String message) {
        return new UploadFailure(message, Disposition.MANUAL_REVIEW);
    }

    static UploadFailure forHttpStatus(int statusCode) {
        if (statusCode == 408 || statusCode == 429 || statusCode >= 500 && statusCode <= 599) {
            return retryable("HTTP " + statusCode);
        }
        return manualReview("HTTP " + statusCode);
    }

    static Disposition disposition(Throwable error) {
        Throwable current = error;
        while (current != null) {
            if (current instanceof UploadFailure) {
                return ((UploadFailure) current).disposition;
            }
            if (current instanceof IOException) return Disposition.RETRYABLE;
            if (current instanceof IllegalArgumentException || current instanceof SecurityException) {
                return Disposition.MANUAL_REVIEW;
            }
            current = current.getCause();
        }
        // Unknown runtime failures remain recoverable until explicitly classified.
        return Disposition.RETRYABLE;
    }

    static boolean isRetryable(Throwable error) {
        return disposition(error) == Disposition.RETRYABLE;
    }
}
