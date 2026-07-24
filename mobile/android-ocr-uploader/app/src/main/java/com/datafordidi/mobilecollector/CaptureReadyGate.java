package com.datafordidi.mobilecollector;

final class CaptureReadyGate {
    enum Outcome {
        IGNORE,
        READY,
        FAILED
    }

    private String pendingNonce = "";

    void begin(String nonce) {
        pendingNonce = compact(nonce);
    }

    Outcome ready(String nonce) {
        return complete(nonce, Outcome.READY);
    }

    Outcome failure(String nonce) {
        return complete(nonce, Outcome.FAILED);
    }

    Outcome timeout(String nonce) {
        return complete(nonce, Outcome.FAILED);
    }

    void cancel() {
        pendingNonce = "";
    }

    boolean hasPending() {
        return !pendingNonce.isEmpty();
    }

    String pendingNonce() {
        return pendingNonce;
    }

    private Outcome complete(String nonce, Outcome outcome) {
        String value = compact(nonce);
        if (pendingNonce.isEmpty() || !pendingNonce.equals(value)) return Outcome.IGNORE;
        pendingNonce = "";
        return outcome;
    }

    private static String compact(String value) {
        return value == null ? "" : value.trim();
    }
}
