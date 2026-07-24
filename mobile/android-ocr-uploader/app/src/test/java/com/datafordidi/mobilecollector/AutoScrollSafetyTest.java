package com.datafordidi.mobilecollector;

import org.junit.Test;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class AutoScrollSafetyTest {
    @Test
    public void blocksSelfSystemSettingsAndLauncherPackages() {
        assertFalse(AutoScrollAccessibilityService.isAllowedTarget("com.datafordidi.ocruploader"));
        assertFalse(AutoScrollAccessibilityService.isAllowedTarget("com.android.settings"));
        assertFalse(AutoScrollAccessibilityService.isAllowedTarget("com.miui.home.launcher"));
        assertFalse(AutoScrollAccessibilityService.isAllowedTarget("com.android.systemui"));
    }

    @Test
    public void allowsThirdPartyStationApps() {
        assertTrue(AutoScrollAccessibilityService.isAllowedTarget("com.autonavi.minimap"));
        assertTrue(AutoScrollAccessibilityService.isAllowedTarget("com.tencent.mm"));
    }

    @Test
    public void fuelCaptureAllowsZeroAutomatedActionsAndNoFlowCanClick() {
        int allowedFuelActions = 0;
        for (CaptureInteractionPolicy.Action action : CaptureInteractionPolicy.Action.values()) {
            boolean allowed = CaptureInteractionPolicy.isAllowed("fuel", action);
            if (allowed) allowedFuelActions++;
            assertFalse(allowed);
        }
        org.junit.Assert.assertEquals(0, allowedFuelActions);
        org.junit.Assert.assertEquals(
                "请手动切换燃油页面，应用仅识别不点击",
                CaptureInteractionPolicy.manualSwitchHint("fuel")
        );
        assertFalse(CaptureInteractionPolicy.isAllowed(
                "charging",
                CaptureInteractionPolicy.Action.CLICK
        ));
        assertFalse(CaptureInteractionPolicy.isAllowed(
                "charging",
                CaptureInteractionPolicy.Action.SET_TEXT
        ));
        assertFalse(CaptureInteractionPolicy.isAllowed(
                "charging",
                CaptureInteractionPolicy.Action.GLOBAL_GESTURE
        ));
        assertTrue(CaptureInteractionPolicy.isAllowed(
                "charging",
                CaptureInteractionPolicy.Action.SCROLL_FORWARD
        ));
    }
}
