package com.datafordidi.mobilecollector;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class BackfillAckRetentionTest {
    @Test
    public void staleAckCannotDeleteNewRevision() throws Exception {
        String identity = "didi-charging|西安|场站A|ctx-a";
        JSONObject current = manualBatch(identity, "batch-r2", "edit-a", 2);
        List<JSONObject> outbox = new ArrayList<>(Arrays.asList(current));

        assertFalse(OutboxStore.isCurrentManualBatch(outbox, identity, "batch-r1", "edit-a", 1));
        assertFalse(OutboxStore.remove(outbox, "batch-r1"));
        assertEquals(1, outbox.size());
        assertEquals("batch-r2", outbox.get(0).getString("batchId"));
        assertTrue(OutboxStore.isCurrentManualBatch(outbox, identity, "batch-r2", "edit-a", 2));
    }

    @Test
    public void currentStrictAckDeletesOnlyStableIdentityAcrossLocalAndOutbox() throws Exception {
        String identityA = "didi-charging|西安|场站A|ctx-a";
        String identityB = "didi-charging|西安|场站B|ctx-b";
        JSONObject ocrA = row(identityA + "|session-1|1", "session-1", 1, "场站A");
        JSONObject manualA = row(StationIdentity.manualLocalKey(identityA, "edit-a", 2), "session-1", 1, "场站A");
        JSONObject ocrB = row(identityB + "|session-1|1", "session-1", 1, "场站B");
        List<JSONObject> local = new ArrayList<>(Arrays.asList(ocrA, manualA, ocrB));

        JSONObject mixedOcr = new JSONObject()
                .put("batchId", "ocr-batch")
                .put("sessionId", "session-1")
                .put("pageIndex", 1)
                .put("stations", new JSONArray().put(new JSONObject().put("stationName", "场站A"))
                        .put(new JSONObject().put("stationName", "场站B")))
                .put("localKeys", new JSONArray().put(identityA + "|session-1|1")
                        .put(identityB + "|session-1|1"));
        JSONObject current = manualBatch(identityA, "batch-r2", "edit-a", 2);
        List<JSONObject> outbox = new ArrayList<>(Arrays.asList(mixedOcr, current));

        assertEquals(2, LocalStationStore.removeStableIdentity(local, identityA));
        assertTrue(OutboxStore.stripStableIdentity(outbox, identityA, "batch-r2"));
        assertEquals(1, local.size());
        assertEquals("场站B", local.get(0).getString("stationName"));
        assertEquals(1, outbox.size());
        assertEquals(1, outbox.get(0).getJSONArray("stations").length());
        assertEquals("场站B", outbox.get(0).getJSONArray("stations").getJSONObject(0).getString("stationName"));
    }

    @Test
    public void recordedLegacyIdentityDoesNotDependOnListPosition() throws Exception {
        JSONObject legacy = new JSONObject()
                .put("platform", "didi-charging")
                .put("city", "西安")
                .put("stationName", "历史场站")
                .put("collectedAt", "2026-07-20T08:00:00Z");
        assertEquals(StationIdentity.fromRow(legacy, 0), StationIdentity.fromRow(legacy, 99));
    }

    private static JSONObject manualBatch(String identity, String batchId, String editId, int revision)
            throws Exception {
        return new JSONObject()
                .put("batchId", batchId)
                .put("manualBackfill", new JSONObject()
                        .put("stableIdentity", identity)
                        .put("editId", editId)
                        .put("revision", revision))
                .put("stations", new JSONArray().put(new JSONObject().put("stationName", "场站A")))
                .put("localKeys", new JSONArray().put(StationIdentity.manualLocalKey(identity, editId, revision)));
    }

    private static JSONObject row(String key, String session, int page, String name) throws Exception {
        return new JSONObject()
                .put("localKey", key)
                .put("sessionId", session)
                .put("pageIndex", page)
                .put("stationName", name);
    }
}
