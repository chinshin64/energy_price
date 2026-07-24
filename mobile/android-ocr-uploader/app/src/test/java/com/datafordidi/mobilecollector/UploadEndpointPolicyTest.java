package com.datafordidi.mobilecollector;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.fail;

public class UploadEndpointPolicyTest {
    @Test
    public void acceptsManagedHttpsRootWithoutEmbeddingBackendAddress() {
        assertEquals(
                "https://managed-ingest.example:5443/",
                UploadEndpointPolicy.requireHttpsBaseUrl(
                        "https://managed-ingest.example:5443"
                ).toString()
        );
    }

    @Test
    public void rejectsCleartextAndEndpointDecorations() {
        assertRejected("http://managed-ingest.example:5443");
        assertRejected("https://user@managed-ingest.example:5443");
        assertRejected("https://managed-ingest.example:5443/api");
        assertRejected("https://managed-ingest.example:5443?redirect=1");
        assertRejected("https://managed-ingest.example:5443#fragment");
    }

    private static void assertRejected(String value) {
        try {
            UploadEndpointPolicy.requireHttpsBaseUrl(value);
            fail("expected endpoint rejection: " + value);
        } catch (IllegalStateException expected) {
            // Expected.
        }
    }
}
