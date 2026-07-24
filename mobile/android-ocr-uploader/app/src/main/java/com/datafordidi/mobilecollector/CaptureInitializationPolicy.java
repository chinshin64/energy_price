package com.datafordidi.mobilecollector;

final class CaptureInitializationPolicy {
    private CaptureInitializationPolicy() {
    }

    static boolean canSendReady(
            boolean foregroundStarted,
            boolean projectionCreated,
            boolean callbackRegistered,
            boolean imageReaderCreated,
            boolean virtualDisplayCreated
    ) {
        return foregroundStarted
                && projectionCreated
                && callbackRegistered
                && imageReaderCreated
                && virtualDisplayCreated;
    }
}
