package com.datafordidi.mobilecollector;

import org.json.JSONObject;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;

public class ManualBackfillDraftTest {
    @Test
    public void buildsAddressAwareManualRevisionAndPreservesOcrFields() throws Exception {
        JSONObject source = baseRow()
                .put("priceSlow", 0.82d)
                .put("address", "西安市雁塔区测试路1号")
                .put("raw", new JSONObject().put("fieldSource", new JSONObject().put("priceSlow", "ocr")));
        ManualBackfillDraft draft = ManualBackfillDraft.fromRow(source);
        draft.fastIdle = "2";
        draft.fastTotal = "8";

        ManualBackfillDraft.Validation result = draft.validateAndBuild(
                source,
                "2026-07-23T03:04:05Z"
        );

        assertTrue(result.valid());
        assertEquals(0.82d, result.row.getDouble("priceSlow"), 0.0001d);
        assertEquals(2, result.row.getInt("fastIdlePorts"));
        assertEquals(8, result.row.getInt("fastTotalPorts"));
        assertEquals("西安市雁塔区测试路1号", result.row.getString("address"));
        JSONObject raw = result.row.getJSONObject("raw");
        assertTrue(raw.getBoolean("manualBackfill"));
        assertEquals("2026-07-23T03:04:05.000Z", raw.getString("backfilledAt"));
        assertEquals("ocr", raw.getJSONObject("fieldSource").getString("priceSlow"));
        assertEquals("manual", raw.getJSONObject("fieldSource").getString("fastTotalPorts"));
    }

    @Test
    public void validatesPricePairsAndCompleteness() throws Exception {
        JSONObject source = baseRow();
        ManualBackfillDraft draft = ManualBackfillDraft.fromRow(source);
        draft.price = "3.51";
        draft.fastIdle = "4";
        draft.fastTotal = "3";
        ManualBackfillDraft.Validation invalid = draft.validateAndBuild(source, "2026-07-23T03:04:05Z");
        assertFalse(invalid.valid());
        assertTrue(invalid.errors.containsKey(ManualBackfillDraft.PRICE));
        assertTrue(invalid.errors.containsKey(ManualBackfillDraft.FAST_IDLE));

        draft.price = "1.09";
        draft.fastIdle = "";
        draft.fastTotal = "";
        invalid = draft.validateAndBuild(source, "2026-07-23T03:04:05Z");
        assertFalse(invalid.valid());
        assertEquals("请至少填写一类有效枪数", invalid.errors.get("form"));
    }

    @Test
    public void contentAndBatchIdentityAreDeterministicAcrossRetry() throws Exception {
        JSONObject source = baseRow();
        ManualBackfillDraft draft = ManualBackfillDraft.fromRow(source);
        draft.price = "0.95";
        draft.fastIdle = "1";
        draft.fastTotal = "4";
        ManualBackfillDraft.Validation first = draft.validateAndBuild(source, "2026-07-23T03:04:05Z");
        ManualBackfillDraft.Validation repeated = draft.validateAndBuild(source, "2026-07-23T04:04:05Z");
        assertEquals(first.fingerprint, repeated.fingerprint);
        String firstBatch = ManualBackfillRepository.manualBatchId("local-a", "edit-a", 1, first.fingerprint);
        assertEquals(firstBatch, ManualBackfillRepository.manualBatchId("local-a", "edit-a", 1, repeated.fingerprint));

        draft.fastTotal = "5";
        ManualBackfillDraft.Validation changed = draft.validateAndBuild(source, "2026-07-23T05:04:05Z");
        assertNotEquals(first.fingerprint, changed.fingerprint);
        assertNotEquals(firstBatch, ManualBackfillRepository.manualBatchId("local-a", "edit-a", 2, changed.fingerprint));
    }

    private static JSONObject baseRow() throws Exception {
        return new JSONObject()
                .put("platform", "didi-charging")
                .put("city", "西安")
                .put("stationName", "测试场站")
                .put("localKey", "didi-charging|西安|测试场站|ctx|s1|1")
                .put("sessionId", "s1")
                .put("pageIndex", 1)
                .put("capturedAt", "2026-07-23T02:00:00Z");
    }
}
