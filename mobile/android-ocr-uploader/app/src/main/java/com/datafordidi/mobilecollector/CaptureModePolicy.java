package com.datafordidi.mobilecollector;

final class CaptureModePolicy {
    enum NextStep {
        REQUEST_AUTO_SCROLL,
        WAIT_FOR_PAGE_CHANGE,
        WAIT_FOR_PAGE_STABLE
    }

    private CaptureModePolicy() {
    }

    static NextStep afterRecognition(boolean accessibilityEnabled) {
        return accessibilityEnabled ? NextStep.REQUEST_AUTO_SCROLL : NextStep.WAIT_FOR_PAGE_CHANGE;
    }

    static NextStep afterAutoScroll(boolean scrollSucceeded) {
        return scrollSucceeded ? NextStep.WAIT_FOR_PAGE_STABLE : NextStep.WAIT_FOR_PAGE_CHANGE;
    }
}
