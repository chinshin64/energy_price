package com.datafordidi.mobilecollector;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class StandaloneIdentityTest {
    @Test
    public void sourceAgentIsDistinctAndAcceptedBy47Contract() {
        assertEquals("android-ocr-agent", LocalStationStore.SOURCE_AGENT);
        assertTrue(LocalStationStore.SOURCE_AGENT.matches("^[a-z0-9][a-z0-9._-]{0,54}-agent$"));
        assertFalse("android-agent".equals(LocalStationStore.SOURCE_AGENT));
    }

    @Test
    public void localIdentitySeparatesCityPlatformAndName() {
        assertEquals(
                "didi-charging|西安|测试充电站",
                LocalStationStore.key("didi-charging", "西 安", "测试 充电站")
        );
        assertFalse(
                LocalStationStore.key("didi-charging", "西安", "测试充电站")
                        .equals(LocalStationStore.key("amap-charging", "西安", "测试充电站"))
        );
    }

    @Test
    public void idempotencyKeyIncludesStandaloneAgentAndScreenIdentity() {
        String first = StationSyncClient.idempotencyKey("device-a", "session-a", 3, "screen-a");
        String repeated = StationSyncClient.idempotencyKey("device-a", "session-a", 3, "screen-a");
        String changed = StationSyncClient.idempotencyKey("device-a", "session-a", 3, "screen-b");
        assertEquals(first, repeated);
        assertEquals(64, first.length());
        assertTrue(first.matches("[0-9a-f]{64}"));
        assertFalse(first.equals(changed));
    }

    @Test
    public void installationHashIsStableAndNonReversibleFormat() {
        String hash = DeviceIdentity.sha256("installation-id:com.datafordidi.ocruploader");
        assertEquals(64, hash.length());
        assertTrue(hash.matches("[0-9a-f]{64}"));
    }
}
