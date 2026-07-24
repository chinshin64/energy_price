package com.datafordidi.mobilecollector;

import org.json.JSONObject;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

public class StationSyncAcknowledgementTest {
    @Test
    public void acceptsStrictSingleRecordAndDurableDuplicateAcknowledgements() throws Exception {
        StationSyncClient.UploadResult first = StationSyncClient.parseAcknowledgement(
                201,
                response(false, 1, "ingest-1", 91, 91),
                true,
                1
        );
        assertFalse(first.duplicate);
        StationSyncClient.UploadResult duplicate = StationSyncClient.parseAcknowledgement(
                200,
                response(true, 1, "ingest-1", 91, 91),
                true,
                1
        );
        assertTrue(duplicate.duplicate);
    }

    @Test
    public void acknowledgementIgnoresBackendStorageMetadata() throws Exception {
        JSONObject payload = new JSONObject(response(false, 1, "ingest-storage-switch", 92, 92));
        payload.getJSONObject("data").put("storageDatabase", "energy_price");

        StationSyncClient.UploadResult result = StationSyncClient.parseAcknowledgement(
                201,
                payload.toString(),
                false,
                1
        );

        assertFalse(result.duplicate);
        assertEquals("ingest-storage-switch", result.ingestId);
    }

    @Test
    public void rejectsIncompleteOrAmbiguousManualAcknowledgement() throws Exception {
        assertRejected(response(false, 0, "ingest-1", 91, 91));
        assertRejected(response(false, 1, "", 91, 91));
        assertRejected(response(false, 1, "ingest-1", 91, 92));
        assertRejected(new JSONObject().put("success", true).put("data", new JSONObject()
                .put("persisted", true).put("sourceNode", "not-47").put("acceptedCount", 1)
                .put("sourceAgent", LocalStationStore.SOURCE_AGENT)
                .put("ingestId", "ingest-1").put("firstSourceRecordId", 91)
                .put("lastSourceRecordId", 91)).toString());
    }

    @Test
    public void rejectsMissingOrMismatchedSourceAgent() throws Exception {
        JSONObject missing = new JSONObject(response(false, 1, "ingest-agent", 95, 95));
        missing.getJSONObject("data").remove("sourceAgent");
        assertRejected(missing.toString());

        JSONObject mismatched = new JSONObject(response(false, 1, "ingest-agent", 95, 95));
        mismatched.getJSONObject("data").put("sourceAgent", "ios-ocr-agent");
        assertRejected(mismatched.toString());
    }

    private static void assertRejected(String response) {
        try {
            StationSyncClient.parseAcknowledgement(200, response, true, 1);
            fail("acknowledgement should be rejected");
        } catch (Exception expected) {
            assertTrue(expected.getMessage().contains("服务"));
        }
    }

    private static String response(boolean duplicate, int count, String ingestId, long first, long last)
            throws Exception {
        return new JSONObject().put("success", true).put("data", new JSONObject()
                .put("persisted", true)
                .put("sourceNode", "47-mysql")
                .put("sourceAgent", LocalStationStore.SOURCE_AGENT)
                .put("acceptedCount", count)
                .put("ingestId", ingestId)
                .put("firstSourceRecordId", first)
                .put("lastSourceRecordId", last)
                .put("duplicate", duplicate)).toString();
    }
}
