package com.datafordidi.mobilecollector;

import android.content.Context;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Arrays;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

@RunWith(RobolectricTestRunner.class)
public class OcrTestEvidenceStoreRobolectricTest {
    private Context context;
    private File marker;
    private File output;

    @Before
    public void setUp() {
        context = RuntimeEnvironment.getApplication();
        marker = new File(context.getFilesDir(), OcrTestEvidenceStore.ENABLE_FILE);
        output = new File(context.getFilesDir(), OcrTestEvidenceStore.LATEST_FILE);
        marker.delete();
        output.delete();
    }

    @After
    public void tearDown() {
        marker.delete();
        output.delete();
    }

    @Test
    public void evidenceIsDisabledByDefault() {
        OcrTestEvidenceStore.capture(
                context,
                Arrays.asList(row("¥7.08/L")),
                "screen-ocr-manual-float",
                "2026-07-27T01:42:23.749Z"
        );

        assertFalse(output.exists());
    }

    @Test
    public void markerWritesOnePrivateSanitizedFixture() throws Exception {
        assertTrue(marker.createNewFile());
        OcrTestEvidenceStore.capture(
                context,
                Arrays.asList(
                        row("¥7.08/L 加200省¥19.85"),
                        row("https://private.example Bearer secret"),
                        row("0123456789abcdef0123456789abcdef")
                ),
                "screen-ocr-manual-float",
                "2026-07-27T01:42:23.749Z"
        );

        assertTrue(output.isFile());
        String serialized = new String(
                Files.readAllBytes(output.toPath()),
                StandardCharsets.UTF_8
        );
        assertTrue(serialized.contains("7.08"));
        assertTrue(serialized.contains("19.85"));
        assertTrue(serialized.contains("[url]"));
        assertTrue(serialized.contains("[identifier]"));
        assertFalse(serialized.contains("private.example"));
        assertFalse(serialized.contains("Bearer secret"));
        assertFalse(serialized.contains("endpoint"));
        assertFalse(serialized.contains("token"));
    }

    private static OcrRow row(String text) {
        return new OcrRow(text, .98f, .05f, .10f, .70f, .04f);
    }
}
