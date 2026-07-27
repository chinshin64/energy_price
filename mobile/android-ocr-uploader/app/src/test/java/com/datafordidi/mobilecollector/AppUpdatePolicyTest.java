package com.datafordidi.mobilecollector;

import org.json.JSONObject;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

public class AppUpdatePolicyTest {
    @Test
    public void startupCheckIsRateLimited() {
        long now = 1_000_000_000L;
        assertTrue(AppUpdatePolicy.due(now, 0));
        assertFalse(AppUpdatePolicy.due(now, now - 1_000L));
        assertTrue(AppUpdatePolicy.due(now, now - AppUpdatePolicy.STARTUP_INTERVAL_MS));
        assertTrue(AppUpdatePolicy.due(now, now + 1_000L));
    }

    @Test
    public void manifestRequiresPackageDigestPathSizeAndNewerVersion() throws Exception {
        JSONObject value = manifest();
        AppUpdatePolicy.Manifest parsed =
                AppUpdatePolicy.parse(value, "com.datafordidi.ocruploader", 36);
        assertEquals(37, parsed.versionCode);
        assertEquals("apk/information-auto-recognition-v2.3.1.apk", parsed.apkPath);

        value.put("versionCode", 36);
        JSONObject currentVersion = value;
        AppUpdatePolicy.Manifest installed =
                AppUpdatePolicy.parse(currentVersion, "com.datafordidi.ocruploader", 36);
        assertFalse(AppUpdatePolicy.isNewer(installed, 36));
        assertTrue(AppUpdatePolicy.isNewer(parsed, 36));
        value = manifest();
        value.put("apkPath", "apk/../secret.apk");
        JSONObject traversal = value;
        assertThrows(IllegalArgumentException.class,
                () -> AppUpdatePolicy.parse(traversal, "com.datafordidi.ocruploader", 36));
    }

    private static JSONObject manifest() throws Exception {
        return new JSONObject()
                .put("packageName", "com.datafordidi.ocruploader")
                .put("versionName", "2.3.1")
                .put("versionCode", 37)
                .put("sha256", "a".repeat(64))
                .put("size", 18_000_000)
                .put("apkPath", "apk/information-auto-recognition-v2.3.1.apk");
    }
}
