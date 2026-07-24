package com.datafordidi.mobilecollector;

import android.content.Context;
import android.content.SharedPreferences;

import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
public class AppSettingsPrivateCaRobolectricTest {
    private Context context;
    private SharedPreferences preferences;

    @Before
    public void setUp() {
        context = RuntimeEnvironment.getApplication();
        preferences = context.getSharedPreferences("standalone_ocr_settings", Context.MODE_PRIVATE);
        preferences.edit().clear().commit();
    }

    @Test
    public void buildDefaultsContainNoEndpointOrToken() {
        assertEquals("", AppSettings.getUploadUrl(context));
        assertEquals("", AppSettings.getUploadToken(context));
    }

    @Test
    public void legacyCleartextUrlIsNotSilentlyMigrated() {
        preferences.edit()
                .putString("uploadUrl", "http://managed-ingest.example:5443")
                .putString("uploadTokenCiphertext", "encrypted-token-placeholder")
                .putBoolean("allowCleartext", true)
                .commit();

        assertEquals("http://managed-ingest.example:5443", AppSettings.getUploadUrl(context));
        assertEquals(
                "encrypted-token-placeholder",
                preferences.getString("uploadTokenCiphertext", "")
        );
        assertFalse(preferences.getString("uploadUrl", "").startsWith("https://"));
    }

    @Test
    public void managedEndpointIsNotSilentlyRewritten() {
        preferences.edit().putString("uploadUrl", "https://managed-ingest.example:5443").commit();
        assertEquals("https://managed-ingest.example:5443", AppSettings.getUploadUrl(context));
        assertEquals(
                "https://managed-ingest.example:5443",
                preferences.getString("uploadUrl", "")
        );
    }

    @Test
    public void receiverStyleUrlUpdatePreservesStoredEncryptedToken() {
        preferences.edit()
                .putString("uploadTokenCiphertext", "encrypted-token-placeholder")
                .commit();
        AppSettings.provision(context, "https://managed-ingest.example:5443", "");

        assertEquals(
                "https://managed-ingest.example:5443",
                preferences.getString("uploadUrl", "")
        );
        assertEquals(
                "encrypted-token-placeholder",
                preferences.getString("uploadTokenCiphertext", "")
        );
    }
}
