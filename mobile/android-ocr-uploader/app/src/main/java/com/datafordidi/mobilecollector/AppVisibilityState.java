package com.datafordidi.mobilecollector;

final class AppVisibilityState {
    interface CheckedRunnable {
        void run() throws Exception;
    }

    private static final Object LOCK = new Object();
    private static int startedActivities;

    private AppVisibilityState() {
    }

    static void onActivityStarted() {
        synchronized (LOCK) {
            startedActivities++;
        }
    }

    static void onActivityStopped() {
        synchronized (LOCK) {
            startedActivities = Math.max(0, startedActivities - 1);
        }
    }

    static boolean isAppVisible() {
        synchronized (LOCK) {
            return startedActivities > 0;
        }
    }

    static boolean runWhileHidden(CheckedRunnable runnable) throws Exception {
        synchronized (LOCK) {
            if (startedActivities > 0) return false;
            runnable.run();
            return true;
        }
    }

    static void resetForTest() {
        synchronized (LOCK) {
            startedActivities = 0;
        }
    }
}
