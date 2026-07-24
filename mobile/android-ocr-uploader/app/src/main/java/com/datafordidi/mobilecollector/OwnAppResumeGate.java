package com.datafordidi.mobilecollector;

final class OwnAppResumeGate {
    private static final int REQUIRED_STABLE_SAMPLES = 2;
    private String candidateHash = "";
    private int stableSamples;

    void onAppVisible() {
        candidateHash = "";
        stableSamples = 0;
    }

    boolean onBackgroundSample(String currentHash) {
        String value = currentHash == null ? "" : currentHash;
        if (!candidateHash.isEmpty() && ScreenStabilityPolicy.sameStructure(value, candidateHash)) {
            stableSamples++;
        } else {
            candidateHash = value;
            stableSamples = 1;
        }
        return stableSamples >= REQUIRED_STABLE_SAMPLES;
    }

    int stableSamplesForTest() {
        return stableSamples;
    }
}
