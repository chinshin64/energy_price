package com.datafordidi.mobilecollector;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

final class ManualBackfillRepository {
    private static final Object LOCK = new Object();

    private ManualBackfillRepository() {
    }

    static SaveResult save(Context context, ManualBackfillDraftStore.State state) {
        if (state == null) throw new IllegalArgumentException("回填草稿不存在");
        synchronized (LOCK) {
            if (StationDisplayFormatter.isFuel(state.originalRow)) {
                return saveFuel(context, state);
            }
            String backfilledAt = CaptureTime.nowUtc();
            ManualBackfillDraft.Validation validation = state.draft.validateAndBuild(
                    state.originalRow,
                    backfilledAt
            );
            if (!validation.valid()) return SaveResult.failure(validation);

            int revision = validation.fingerprint.equals(state.lastSavedFingerprint)
                    ? Math.max(1, state.revision)
                    : Math.max(1, state.revision + 1);
            String localKey = StationIdentity.manualLocalKey(state.stableIdentity, state.editId, revision);
            JSONObject row = put(AddressFreePayload.copyObject(validation.row), "localKey", localKey);
            copyContext(state.originalRow, row);

            String capturedAt = compatibleCapturedAt(row);
            if (capturedAt.isEmpty()) {
                validation.errors.put("form", "历史记录缺少可用的截取时间，暂时无法回传");
                return SaveResult.failure(validation);
            }
            String batchId = manualBatchId(
                    state.originalLocalKey,
                    state.editId,
                    revision,
                    validation.fingerprint
            );
            JSONObject metadata = object(
                    "stableIdentity", state.stableIdentity,
                    "originalLocalKey", state.originalLocalKey,
                    "editId", state.editId,
                    "revision", revision,
                    "contentFingerprint", validation.fingerprint
            );
            JSONObject observation = StationObservationV3.fromLocalRow(row);
            ObservationEnvelope.requireValid(observation);
            JSONObject batch = object(
                    "schemaVersion", StationObservationV3.SCHEMA_VERSION,
                    "stationType", "charging",
                    "batchId", batchId,
                    "sessionId", "manual-backfill-" + state.editId,
                    "pageIndex", Math.max(0, state.originalRow.optInt("pageIndex")),
                    "screenHash", validation.fingerprint,
                    "platform", row.optString("platform"),
                    "city", row.optString("city"),
                    "capturedAt", capturedAt,
                    "attempts", 0,
                    "localKeys", new JSONArray().put(localKey),
                    "observations", new JSONArray().put(observation),
                    "manualBackfill", metadata
            );

            JSONObject operation = object(
                    "type", "save",
                    "stableIdentity", state.stableIdentity,
                    "row", row,
                    "batch", batch
            );
            String operationId = "save-" + batchId;
            BackfillTransactionStore.put(context, operationId, operation);
            applySave(context, operation);
            BackfillTransactionStore.remove(context, operationId);

            state.revision = revision;
            state.lastSavedFingerprint = validation.fingerprint;
            state.originalRow = row;
            state.open = false;
            ManualBackfillDraftStore.save(context, state);
            BackfillRetryScheduler.schedule(context);
            return SaveResult.success(batchId, row, revision);
        }
    }

    private static SaveResult saveFuel(Context context, ManualBackfillDraftStore.State state) {
        FuelPayloadPolicy.requireNoChargingFields(state.originalRow);
        String capturedAt = compatibleCapturedAt(state.originalRow);
        if (capturedAt.isEmpty()) {
            return SaveResult.failure(ManualBackfillDraft.Validation.failure(
                    java.util.Collections.singletonMap("form", "历史记录缺少可用的截取时间，暂时无法回传")
            ));
        }
        FuelBackfillDraft.Validation fuelValidation = state.fuelDraft.validate(capturedAt);
        if (!fuelValidation.valid()) {
            return SaveResult.failure(ManualBackfillDraft.Validation.failure(fuelValidation.errors));
        }
        String backfilledAt = CaptureTime.nowUtc();
        JSONObject row = AddressFreePayload.copyObject(state.originalRow);
        String safeAddress = StationObservationV3.sanitizeAddress(state.draft.address);
        if (!state.draft.address.trim().isEmpty() && safeAddress == null) {
            return SaveResult.failure(ManualBackfillDraft.Validation.failure(
                    java.util.Collections.singletonMap(ManualBackfillDraft.ADDRESS, "请输入有效场站地址")
            ));
        }
        put(row, "address", safeAddress == null ? JSONObject.NULL : safeAddress);
        JSONObject fuel = AddressFreePayload.copyObject(row.optJSONObject("fuelObservation"));
        put(fuel, "fuelOffers", preserveFuelOfferExtensions(
                fuel.optJSONArray("fuelOffers"),
                fuelValidation.offers
        ));
        JSONObject raw = AddressFreePayload.copyObject(fuel.optJSONObject("raw"));
        put(raw, "manualBackfill", true);
        put(raw, "backfilledAt", backfilledAt);
        put(fuel, "raw", raw);
        put(row, "fuelObservation", fuel);
        put(row, "raw", object("manualBackfill", true, "backfilledAt", backfilledAt));
        put(row, "backfilledAt", backfilledAt);
        put(row, "syncState", "pending");
        put(row, "syncMessage", "回填完成·待回传");
        put(row, "schemaVersion", StationObservationV3.SCHEMA_VERSION);
        put(row, "stationType", "fuel");
        put(row, "sourceAgent", LocalStationStore.SOURCE_AGENT);
        put(row, "stationObservation", StationObservationV3.fromLocalRow(row)
                .optJSONObject("stationObservation"));
        String fingerprint = DeviceIdentity.sha256(
                row.optString("platform") + "|" + row.optString("city") + "|"
                        + row.optString("stationName") + "|" + row.optString("address")
                        + "|" + fuelValidation.offers
                        + "|" + capturedAt
        );
        int revision = fingerprint.equals(state.lastSavedFingerprint)
                ? Math.max(1, state.revision)
                : Math.max(1, state.revision + 1);
        String localKey = StationIdentity.manualLocalKey(state.stableIdentity, state.editId, revision);
        put(row, "localKey", localKey);
        copyContext(state.originalRow, row);
        String batchId = manualBatchId(
                state.originalLocalKey, state.editId, revision, fingerprint
        );
        JSONObject metadata = object(
                "stableIdentity", state.stableIdentity,
                "originalLocalKey", state.originalLocalKey,
                "editId", state.editId,
                "revision", revision,
                "contentFingerprint", fingerprint
        );
        JSONObject observation = StationObservationV3.fromLocalRow(row);
        boolean fuelQuoteFeature = FuelQuoteFeatureGate.requiresFeature(observation);
        ObservationEnvelope.requireValid(observation);
        JSONObject batch = object(
                "schemaVersion", StationObservationV3.SCHEMA_VERSION,
                "stationType", "fuel",
                "batchId", batchId,
                "sessionId", "manual-backfill-" + state.editId,
                "pageIndex", Math.max(0, state.originalRow.optInt("pageIndex")),
                "screenHash", fingerprint,
                "platform", row.optString("platform"),
                "city", row.optString("city"),
                "capturedAt", capturedAt,
                "attempts", 0,
                "localKeys", new JSONArray().put(localKey),
                "observations", new JSONArray().put(observation),
                "manualBackfill", metadata
        );
        if (fuelQuoteFeature) put(batch, "feature", FuelQuoteFeatureGate.FEATURE);
        ObservationEnvelope.requireValidBatch(batch);
        JSONObject operation = object(
                "type", "save",
                "stableIdentity", state.stableIdentity,
                "row", row,
                "batch", batch
        );
        String operationId = "save-" + batchId;
        BackfillTransactionStore.put(context, operationId, operation);
        applySave(context, operation);
        BackfillTransactionStore.remove(context, operationId);

        state.revision = revision;
        state.lastSavedFingerprint = fingerprint;
        state.originalRow = row;
        state.open = false;
        ManualBackfillDraftStore.save(context, state);
        BackfillRetryScheduler.schedule(context);
        return SaveResult.success(batchId, row, revision);
    }

    static void acknowledge(Context context, JSONObject batch, String message) {
        JSONObject metadata = batch == null ? null : batch.optJSONObject("manualBackfill");
        if (metadata == null) {
            LocalStationStore.markSync(context, OutboxStore.localKeys(batch), "synced", message);
            String batchId = batch == null ? "" : batch.optString("batchId");
            OutboxStore.removeBatch(context, batchId);
            CaptureTransactionStore.removeByBatchId(context, batchId);
            return;
        }
        synchronized (LOCK) {
            String identity = metadata.optString("stableIdentity");
            String batchId = batch.optString("batchId");
            String editId = metadata.optString("editId");
            int revision = metadata.optInt("revision");
            if (!OutboxStore.isCurrentManualBatch(context, identity, batchId, editId, revision)) {
                OutboxStore.removeBatch(context, batchId);
                return;
            }
            JSONObject operation = object(
                    "type", "delete",
                    "stableIdentity", identity,
                    "batchId", batchId,
                    "editId", editId,
                    "revision", revision
            );
            String operationId = "delete-" + batchId;
            BackfillTransactionStore.put(context, operationId, operation);
            applyDelete(context, operation);
            BackfillTransactionStore.remove(context, operationId);
        }
    }

    static void reconcile(Context context) {
        synchronized (LOCK) {
            for (BackfillTransactionStore.Entry entry : BackfillTransactionStore.entries(context)) {
                String type = entry.value.optString("type");
                if ("save".equals(type)) applySave(context, entry.value);
                else if ("delete".equals(type)) applyDelete(context, entry.value);
                else continue;
                BackfillTransactionStore.remove(context, entry.id);
            }
        }
    }

    static String manualBatchId(String originalLocalKey, String editId, int revision, String fingerprint) {
        return DeviceIdentity.sha256(String.valueOf(originalLocalKey) + "|" + editId + "|"
                + Math.max(1, revision) + "|" + fingerprint);
    }

    private static void applySave(Context context, JSONObject operation) {
        String identity = operation.optString("stableIdentity");
        JSONObject row = operation.optJSONObject("row");
        JSONObject batch = operation.optJSONObject("batch");
        if (identity.isEmpty() || row == null || batch == null) {
            throw new IllegalStateException("回填事务不完整");
        }
        LocalStationStore.upsertBackfillSnapshot(context, row);
        OutboxStore.upsertBackfillBatch(context, identity, batch);
    }

    private static void applyDelete(Context context, JSONObject operation) {
        String identity = operation.optString("stableIdentity");
        if (identity.isEmpty()) throw new IllegalStateException("回填删除事务不完整");
        LocalStationStore.removeStableIdentity(context, identity);
        OutboxStore.removeStableIdentity(context, identity, operation.optString("batchId"));
        ManualBackfillDraftStore.remove(context, identity);
    }

    private static JSONObject businessStation(JSONObject row) {
        JSONObject station = AddressFreePayload.copyObject(row);
        station.remove("localKey");
        station.remove("syncState");
        station.remove("syncMessage");
        station.remove("sessionId");
        station.remove("pageIndex");
        return station;
    }

    private static JSONObject businessFuelObservation(JSONObject row) {
        JSONObject fuel = AddressFreePayload.copyObject(row.optJSONObject("fuelObservation"));
        fuel.remove("localKey");
        fuel.remove("syncState");
        fuel.remove("syncMessage");
        return fuel;
    }

    private static JSONArray preserveFuelOfferExtensions(JSONArray original, JSONArray validated) {
        JSONArray output = AddressFreePayload.copyArray(validated);
        if (original == null || output == null) return output == null ? new JSONArray() : output;
        for (int index = 0; index < output.length(); index++) {
            JSONObject target = output.optJSONObject(index);
            if (target == null) continue;
            JSONObject source = findFuelOffer(original, target.optString("gradeCode"));
            if (source == null) continue;
            for (String key : new String[]{
                    "displayPrice", "stationPrice", "nationalPrice", "fieldSource", "evidence"
            }) {
                if (!source.has(key) || source.isNull(key)) continue;
                Object value = source.opt(key);
                if (value instanceof JSONObject) {
                    put(target, key, AddressFreePayload.copyObject((JSONObject) value));
                } else if (value instanceof JSONArray) {
                    put(target, key, AddressFreePayload.copyArray((JSONArray) value));
                } else {
                    put(target, key, value);
                }
            }
        }
        return output;
    }

    private static JSONObject findFuelOffer(JSONArray offers, String gradeCode) {
        String expected = String.valueOf(gradeCode).trim();
        for (int index = 0; index < offers.length(); index++) {
            JSONObject offer = offers.optJSONObject(index);
            if (offer != null && expected.equals(offer.optString("gradeCode").trim())) return offer;
        }
        return null;
    }

    private static void copyContext(JSONObject source, JSONObject target) {
        for (String key : new String[]{"sessionId", "pageIndex", "city", "platform", "capturedAt", "collectedAt", "snapshotAt"}) {
            if (source.has(key)) put(target, key, source.opt(key));
        }
    }

    private static JSONObject object(Object... entries) {
        if (entries == null || entries.length % 2 != 0) {
            throw new IllegalArgumentException("JSON 字段必须成对提供");
        }
        JSONObject value = new JSONObject();
        for (int index = 0; index < entries.length; index += 2) {
            put(value, String.valueOf(entries[index]), entries[index + 1]);
        }
        return value;
    }

    private static JSONObject put(JSONObject target, String key, Object value) {
        try {
            target.put(key, value);
            return target;
        } catch (Exception error) {
            throw new IllegalStateException("无法序列化回填数据", error);
        }
    }

    private static String compatibleCapturedAt(JSONObject row) {
        for (String key : new String[]{"capturedAt", "collectedAt", "snapshotAt"}) {
            String value = row.optString(key, "").trim();
            if (value.isEmpty()) continue;
            try {
                return CaptureTime.requireUtc(value);
            } catch (IllegalArgumentException ignored) {
                // Try the next explicitly recorded legacy time.
            }
        }
        return "";
    }

    static final class SaveResult {
        final boolean saved;
        final ManualBackfillDraft.Validation validation;
        final String batchId;
        final JSONObject row;
        final int revision;

        private SaveResult(
                boolean saved,
                ManualBackfillDraft.Validation validation,
                String batchId,
                JSONObject row,
                int revision
        ) {
            this.saved = saved;
            this.validation = validation;
            this.batchId = batchId;
            this.row = row;
            this.revision = revision;
        }

        static SaveResult failure(ManualBackfillDraft.Validation validation) {
            return new SaveResult(false, validation, "", null, 0);
        }

        static SaveResult success(String batchId, JSONObject row, int revision) {
            return new SaveResult(true, null, batchId, row, revision);
        }
    }
}
