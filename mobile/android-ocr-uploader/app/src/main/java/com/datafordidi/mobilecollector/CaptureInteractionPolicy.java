package com.datafordidi.mobilecollector;

final class CaptureInteractionPolicy {
    enum Action {
        SCROLL_FORWARD,
        CLICK,
        SET_TEXT,
        GLOBAL_GESTURE
    }

    private CaptureInteractionPolicy() {
    }

    static boolean isAllowed(String stationType, Action action) {
        return "charging".equals(stationType) && action == Action.SCROLL_FORWARD;
    }

    static String manualSwitchHint(String stationType) {
        return "fuel".equals(stationType)
                ? "请手动切换燃油页面，应用仅识别不点击"
                : "请手动切换页面";
    }
}
