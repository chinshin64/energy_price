package com.datafordidi.mobilecollector;

import org.junit.Test;

import java.util.Arrays;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class CapturePolicyTest {
    @Test
    public void packageOrPageChangeFailsCommitGate() {
        assertTrue(CaptureSafetyGate.sameContext("com.station", "com.station", "", true));
        assertTrue(CaptureSafetyGate.sameContext("com.station", "com.station", "com.station", true));
        assertFalse(CaptureSafetyGate.sameContext("com.station", "com.other", "", true));
        assertFalse(CaptureSafetyGate.sameContext("com.station", "com.station", "", false));
        assertFalse(CaptureSafetyGate.sameContext("com.station", "com.station", "com.other", true));
    }

    @Test
    public void targetLocksOnlyWithNonSensitiveStationEvidence() {
        assertTrue(CaptureSafetyGate.canLockTarget("com.station", "com.collector", true, false));
        assertFalse(CaptureSafetyGate.canLockTarget("com.station", "com.collector", false, false));
        assertFalse(CaptureSafetyGate.canLockTarget("com.station", "com.collector", true, true));
        assertFalse(CaptureSafetyGate.canLockTarget("com.collector", "com.collector", true, false));
        assertTrue(ScreenContextResolver.isBlockedPage(Arrays.asList(row("请输入支付密码"))));
        assertFalse(ScreenContextResolver.isBlockedPage(Arrays.asList(row("充电站列表"))));
    }

    @Test
    public void manualScopeIsNotARealPackageOrPlatformBasis() {
        assertEquals("", CaptureContextPolicy.parserPackage(false, "manual-screen-scope"));
        assertFalse(CaptureContextPolicy.canLockRealPackage(false, "manual-screen-scope"));
        assertEquals("com.station", CaptureContextPolicy.parserPackage(true, "com.station"));
        assertTrue(CaptureContextPolicy.canLockRealPackage(true, "com.station"));
    }

    @Test
    public void matchingReadyAckIsConsumedExactlyOnce() {
        CaptureReadyGate gate = new CaptureReadyGate();
        gate.begin("current");
        assertEquals(CaptureReadyGate.Outcome.READY, gate.ready("current"));
        assertEquals(CaptureReadyGate.Outcome.IGNORE, gate.ready("current"));
        assertFalse(gate.hasPending());
    }

    @Test
    public void staleReadyAckCannotConsumeCurrentStart() {
        CaptureReadyGate gate = new CaptureReadyGate();
        gate.begin("current");
        assertEquals(CaptureReadyGate.Outcome.IGNORE, gate.ready("old"));
        assertTrue(gate.hasPending());
        assertEquals(CaptureReadyGate.Outcome.READY, gate.ready("current"));
    }

    @Test
    public void matchingTimeoutRejectsLaterReadyAck() {
        CaptureReadyGate gate = new CaptureReadyGate();
        gate.begin("current");
        assertEquals(CaptureReadyGate.Outcome.FAILED, gate.timeout("current"));
        assertEquals(CaptureReadyGate.Outcome.IGNORE, gate.ready("current"));
    }

    @Test
    public void initializationFailureConsumesOnlyMatchingStart() {
        CaptureReadyGate gate = new CaptureReadyGate();
        gate.begin("current");
        assertEquals(CaptureReadyGate.Outcome.IGNORE, gate.failure("old"));
        assertEquals(CaptureReadyGate.Outcome.FAILED, gate.failure("current"));
        assertEquals(CaptureReadyGate.Outcome.IGNORE, gate.ready("current"));
    }

    @Test
    public void readyRequiresEveryCaptureResource() {
        assertTrue(CaptureInitializationPolicy.canSendReady(true, true, true, true, true));
        assertFalse(CaptureInitializationPolicy.canSendReady(false, true, true, true, true));
        assertFalse(CaptureInitializationPolicy.canSendReady(true, false, true, true, true));
        assertFalse(CaptureInitializationPolicy.canSendReady(true, true, false, true, true));
        assertFalse(CaptureInitializationPolicy.canSendReady(true, true, true, false, true));
        assertFalse(CaptureInitializationPolicy.canSendReady(true, true, true, true, false));
    }

    @Test
    public void minorAnimationIsStableButRealPageChangeIsRejected() {
        String baseline = "0000000000000000";
        String smallAnimation = "0000000000000007";
        String pageChange = "ffffffffffffffff";
        assertTrue(ScreenStabilityPolicy.sameStructure(baseline, smallAnimation));
        assertFalse(ScreenStabilityPolicy.meaningfullyChanged(baseline, smallAnimation));
        assertFalse(ScreenStabilityPolicy.sameStructure(baseline, pageChange));
        assertTrue(ScreenStabilityPolicy.meaningfullyChanged(baseline, pageChange));
    }

    @Test
    public void rawSmallScrollGetsBoundedManualReview() {
        assertFalse(ManualReviewPolicy.shouldReview(false, 4, 4_000L));
        assertFalse(ManualReviewPolicy.shouldReview(true, 1, 2_999L));
        assertTrue(ManualReviewPolicy.shouldReview(true, 2, 1_200L));
        assertTrue(ManualReviewPolicy.shouldReview(true, 1, 3_000L));
    }

    @Test
    public void notificationShowsRecognitionAndDeliveryCounts() {
        assertEquals(
                "OCR采集中 F12/O4/P9/R7 · 回传失败 Q2/E1 · 跳过:页面未变化",
                CaptureNotificationState.text(
                        "采集中", "失败", 12, 4, 9, 7, 2, 1, "页面未变化"
                )
        );
    }

    @Test
    public void sessionHasPageAndTimeCaps() {
        assertFalse(CaptureSessionPolicy.limitReached(1_000L, 2_000L, 3));
        assertTrue(CaptureSessionPolicy.limitReached(1_000L, 2_000L, CaptureSessionPolicy.MAX_PAGES));
        assertTrue(CaptureSessionPolicy.limitReached(1_000L, 1_000L + CaptureSessionPolicy.MAX_DURATION_MS, 1));
    }

    @Test
    public void unchangedStationIsNotQueuedButRealFieldChangeIs() {
        StationObservationTracker tracker = new StationObservationTracker();
        DidiLocalStationParser.StationRecord initial = station("测试充电站", 2, 4);
        DidiLocalStationParser.StationRecord repeated = station("测试充电站", 2, 4);
        DidiLocalStationParser.StationRecord changed = station("测试充电站", 1, 4);

        assertEquals(1, tracker.changed(
                "test-session", "page-1", "generic-charging-test", "西安", Arrays.asList(initial)
        ).size());
        assertEquals(0, tracker.changed(
                "test-session", "page-1", "generic-charging-test", "西安", Arrays.asList(repeated)
        ).size());
        assertEquals(1, tracker.changed(
                "test-session", "page-1", "generic-charging-test", "西安", Arrays.asList(changed)
        ).size());
    }

    @Test
    public void lifecyclePauseBeforePersistenceDoesNotConsumeObservation() {
        StationObservationTracker tracker = new StationObservationTracker();
        DidiLocalStationParser.StationRecord station = station("测试充电站", 2, 4);
        assertEquals(1, tracker.previewChanged(
                "test-session", "page-1", "generic-charging-test", "西安", Arrays.asList(station)
        ).size());
        assertEquals(1, tracker.previewChanged(
                "test-session", "page-1", "generic-charging-test", "西安", Arrays.asList(station)
        ).size());
        tracker.commit(
                "test-session", "page-1", "generic-charging-test", "西安", Arrays.asList(station)
        );
        assertEquals(0, tracker.previewChanged(
                "test-session", "page-1", "generic-charging-test", "西安", Arrays.asList(station)
        ).size());
    }

    @Test
    public void ownAppVisibilityResetsBackgroundStabilitySamples() {
        OwnAppResumeGate gate = new OwnAppResumeGate();
        assertFalse(gate.onBackgroundSample("0000000000000001"));
        assertEquals(1, gate.stableSamplesForTest());
        gate.onAppVisible();
        assertEquals(0, gate.stableSamplesForTest());
        assertFalse(gate.onBackgroundSample("0000000000000001"));
        assertTrue(gate.onBackgroundSample("0000000000000003"));
    }

    @Test
    public void retryUsesBoundedExponentialBackoff() {
        assertEquals(5_000L, OutboxStore.retryDelayMillis(1));
        assertEquals(10_000L, OutboxStore.retryDelayMillis(2));
        assertEquals(300_000L, OutboxStore.retryDelayMillis(20));
    }

    @Test
    public void manualModeWaitsForUserScrollAndAutoFailureFallsBackToSamePath() {
        assertEquals(
                CaptureModePolicy.NextStep.WAIT_FOR_PAGE_CHANGE,
                CaptureModePolicy.afterRecognition(false)
        );
        assertEquals(
                CaptureModePolicy.NextStep.REQUEST_AUTO_SCROLL,
                CaptureModePolicy.afterRecognition(true)
        );
        assertEquals(
                CaptureModePolicy.NextStep.WAIT_FOR_PAGE_CHANGE,
                CaptureModePolicy.afterAutoScroll(false)
        );
        assertEquals(
                CaptureModePolicy.NextStep.WAIT_FOR_PAGE_STABLE,
                CaptureModePolicy.afterAutoScroll(true)
        );
    }

    @Test
    public void visibleCollectorBlocksCaptureAndPersistenceCheckpoint() throws Exception {
        AppVisibilityState.resetForTest();
        AppVisibilityState.onActivityStarted();
        final boolean[] ran = {false};
        assertFalse(AppVisibilityState.runWhileHidden(() -> ran[0] = true));
        assertFalse(ran[0]);
        assertTrue(AppVisibilityState.isAppVisible());
        AppVisibilityState.onActivityStopped();
        assertTrue(AppVisibilityState.runWhileHidden(() -> ran[0] = true));
        assertTrue(ran[0]);
        AppVisibilityState.resetForTest();
    }

    @Test
    public void foregroundTransitionCannotRaceHiddenPersistence() throws Exception {
        AppVisibilityState.resetForTest();
        CountDownLatch persistenceEntered = new CountDownLatch(1);
        CountDownLatch releasePersistence = new CountDownLatch(1);
        CountDownLatch foregroundMarked = new CountDownLatch(1);
        Thread persistence = new Thread(() -> {
            try {
                AppVisibilityState.runWhileHidden(() -> {
                    persistenceEntered.countDown();
                    releasePersistence.await(2, TimeUnit.SECONDS);
                });
            } catch (Exception error) {
                throw new RuntimeException(error);
            }
        });
        persistence.start();
        assertTrue(persistenceEntered.await(1, TimeUnit.SECONDS));
        Thread foreground = new Thread(() -> {
            AppVisibilityState.onActivityStarted();
            foregroundMarked.countDown();
        });
        foreground.start();
        assertFalse(foregroundMarked.await(100, TimeUnit.MILLISECONDS));
        releasePersistence.countDown();
        persistence.join(1_000L);
        foreground.join(1_000L);
        assertTrue(foregroundMarked.await(1, TimeUnit.SECONDS));
        assertTrue(AppVisibilityState.isAppVisible());
        AppVisibilityState.resetForTest();
    }

    private static DidiLocalStationParser.StationRecord station(String name, int idle, int total) {
        DidiLocalStationParser.StationRecord station = new DidiLocalStationParser.StationRecord();
        station.stationName = name;
        station.fastIdlePorts = idle;
        station.fastTotalPorts = total;
        station.portsObserved = true;
        station.localParser = "generic";
        station.transientCardKey = "10:20:-";
        station.transientStaticSignature = "generic:column-2";
        return station;
    }

    private static OcrRow row(String text) {
        return new OcrRow(text, 1f, 0.1f, 0.3f, 0.8f, 0.04f);
    }
}
