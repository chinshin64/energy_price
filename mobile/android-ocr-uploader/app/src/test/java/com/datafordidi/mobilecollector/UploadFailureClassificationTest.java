package com.datafordidi.mobilecollector;

import org.junit.Test;

import java.io.IOException;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

public class UploadFailureClassificationTest {
    @Test
    public void http408429And5xxAreRetryable() {
        for (int status : new int[]{408, 429, 500, 502, 599}) {
            assertEquals(
                    UploadFailure.Disposition.RETRYABLE,
                    UploadFailure.disposition(UploadFailure.forHttpStatus(status))
            );
        }
    }

    @Test
    public void http409AndOtherClientErrorsRequireManualReview() {
        for (int status : new int[]{400, 401, 403, 404, 409, 422, 499}) {
            assertEquals(
                    UploadFailure.Disposition.MANUAL_REVIEW,
                    UploadFailure.disposition(UploadFailure.forHttpStatus(status))
            );
        }
    }

    @Test
    public void networkIsRetryableButLocalValidationIsPermanent() {
        assertTrue(UploadFailure.isRetryable(new IOException("offline")));
        assertFalse(UploadFailure.isRetryable(new IllegalArgumentException("invalid payload")));
        assertFalse(UploadFailure.isRetryable(new SecurityException("denied")));
        assertTrue(UploadFailure.isRetryable(new IllegalStateException("unknown runtime")));
    }

    @Test
    public void non2xxAndMalformed2xxAckUseExplicitDisposition() {
        assertAckDisposition(408, "{}", UploadFailure.Disposition.RETRYABLE);
        assertAckDisposition(429, "{}", UploadFailure.Disposition.RETRYABLE);
        assertAckDisposition(503, "{}", UploadFailure.Disposition.RETRYABLE);
        assertAckDisposition(409, "{}", UploadFailure.Disposition.MANUAL_REVIEW);
        assertAckDisposition(401, "{}", UploadFailure.Disposition.MANUAL_REVIEW);
        assertAckDisposition(200, "not-json", UploadFailure.Disposition.MANUAL_REVIEW);
    }

    private static void assertAckDisposition(
            int status,
            String response,
            UploadFailure.Disposition expected
    ) {
        try {
            StationSyncClient.parseAcknowledgement(status, response, false, 1);
            fail("acknowledgement must be rejected");
        } catch (Exception error) {
            assertEquals(expected, UploadFailure.disposition(error));
        }
    }
}
