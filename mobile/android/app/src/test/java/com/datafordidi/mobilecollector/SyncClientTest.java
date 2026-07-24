package com.datafordidi.mobilecollector;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;

import org.junit.Test;

public class SyncClientTest {
    @Test
    public void stationIdempotencyKeyIsStableAndSeparatesStages() {
        String listKey = SyncClient.buildIdempotencyKey(
                "device-hash",
                "android-123",
                7,
                "phone-auto-scroll"
        );
        assertEquals(
                "android-agent:device-hash:android-123:7:phone-auto-scroll",
                listKey
        );
        assertNotEquals(
                listKey,
                SyncClient.buildIdempotencyKey("device-hash", "android-123", 7, "phone-detail")
        );
    }
}
