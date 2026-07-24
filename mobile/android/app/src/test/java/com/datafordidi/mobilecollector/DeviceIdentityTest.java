package com.datafordidi.mobilecollector;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;

import org.junit.Test;

public class DeviceIdentityTest {
    @Test
    public void hashesDeviceMaterialDeterministically() {
        String first = DeviceIdentity.hash("device-a");
        assertEquals(64, first.length());
        assertEquals(first, DeviceIdentity.hash("device-a"));
        assertNotEquals(first, DeviceIdentity.hash("device-b"));
    }
}
