package com.datafordidi.mobilecollector;

import android.content.SharedPreferences;
import android.os.Bundle;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.annotation.Config;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.robolectric.Shadows.shadowOf;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 30)
public class MainActivityUpdateCheckRobolectricTest {
    private static final String UPDATE_PREFS = "standalone_ocr_updates";
    private static final String LAST_CHECK = "lastCheckedAt";

    @Test
    public void checksOnceAfterColdStartAndDoesNotCheckAgainOnRecreation() {
        shadowOf(RuntimeEnvironment.getApplication()).grantPermissions(
                "com.datafordidi.ocruploader.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION"
        );
        SharedPreferences preferences = RuntimeEnvironment.getApplication()
                .getSharedPreferences(UPDATE_PREFS, android.content.Context.MODE_PRIVATE);
        long futureMarker = System.currentTimeMillis() + 60_000L;
        preferences.edit().putLong(LAST_CHECK, futureMarker).commit();

        ActivityController<MainActivity> first = Robolectric.buildActivity(MainActivity.class)
                .create()
                .start()
                .resume()
                .visible();
        long coldStartCheck = preferences.getLong(LAST_CHECK, 0L);
        assertTrue(coldStartCheck > 0L);
        assertTrue(coldStartCheck < futureMarker);

        Bundle recreation = new Bundle();
        first.saveInstanceState(recreation).pause().stop().destroy();
        preferences.edit().putLong(LAST_CHECK, 1L).commit();

        ActivityController<MainActivity> second = Robolectric.buildActivity(MainActivity.class)
                .create(recreation)
                .start()
                .resume()
                .visible();
        assertEquals(1L, preferences.getLong(LAST_CHECK, 0L));
        second.pause().stop().destroy();
    }
}
