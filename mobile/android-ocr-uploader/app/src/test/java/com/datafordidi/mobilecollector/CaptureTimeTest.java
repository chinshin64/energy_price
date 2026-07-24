package com.datafordidi.mobilecollector;

import org.json.JSONObject;
import org.junit.Test;

import java.time.ZoneId;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class CaptureTimeTest {
    @Test
    public void utcContractAlwaysUsesExactlyThreeMillisecondDigits() {
        assertEquals("2026-07-23T12:00:00.000Z", CaptureTime.requireUtc("2026-07-23T12:00:00Z"));
        assertEquals("2026-07-23T12:00:00.120Z", CaptureTime.requireUtc("2026-07-23T12:00:00.12Z"));
        assertEquals("2026-07-23T12:00:00.123Z", CaptureTime.requireUtc("2026-07-23T12:00:00.123987Z"));
    }

    @Test
    public void displaysImmutableCapturedAtInRequestedLocalZone() throws Exception {
        CaptureTime.DisplayValue value = CaptureTime.display(
                new JSONObject().put("capturedAt", "2026-07-23T02:00:00Z"),
                ZoneId.of("Asia/Shanghai")
        );
        assertEquals("截取时间：2026-07-23 10:00:00", value.label());
        assertFalse(value.legacy);
    }

    @Test
    public void labelsLegacyFallbackWithoutInventingTime() throws Exception {
        CaptureTime.DisplayValue collected = CaptureTime.display(
                new JSONObject().put("collectedAt", 1784772000L),
                ZoneId.of("UTC")
        );
        assertTrue(collected.legacy);
        assertTrue(collected.label().endsWith("（历史）"));
        assertEquals("截取时间：未知（历史）", CaptureTime.display(new JSONObject(), ZoneId.of("UTC")).label());
    }
}
