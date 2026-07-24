package com.datafordidi.mobilecollector;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.Set;

final class OutboxStore {
    private static final String PREFS = "standalone_ocr_outbox";
    private static final String KEY_BATCHES = "batches";
    private static final String FAILURE_DISPOSITION = "failureDisposition";
    private static final String RETRYABLE = "retryable";
    private static final String MANUAL_REVIEW = "manual-review";
    private static final String DELIVERY_STATE = "deliveryState";
    private static final String DEFERRED_FEATURE = "deferred-feature";
    private static final String DEFERRED_REASON = "deferredReason";
    private static final int MAX_BATCHES = 500;
    private static final Object LOCK = new Object();

    private OutboxStore() {
    }

    static boolean hasCapacity(Context context) {
        synchronized (LOCK) {
            return read(context).size() < MAX_BATCHES;
        }
    }

    static void requireCapacity(Context context, String batchId) {
        synchronized (LOCK) {
            List<JSONObject> batches = read(context);
            for (JSONObject batch : batches) {
                if (String.valueOf(batchId).equals(batch.optString("batchId"))) return;
            }
            if (batches.size() >= MAX_BATCHES) throw new IllegalStateException("回传队列已满");
        }
    }

    static JSONObject prepareChargingBatch(
            String sessionId,
            int pageIndex,
            String screenHash,
            String platform,
            String city,
            List<JSONObject> snapshots
    ) {
        return prepareBatch(
                "charging",
                sessionId,
                pageIndex,
                screenHash,
                platform,
                city,
                snapshots,
                false
        );
    }

    static JSONObject prepareFuelBatch(
            String sessionId,
            int pageIndex,
            String screenHash,
            String platform,
            String city,
            List<JSONObject> snapshots
    ) {
        return prepareBatch(
                "fuel",
                sessionId,
                pageIndex,
                screenHash,
                platform,
                city,
                snapshots,
                false
        );
    }

    private static JSONObject prepareBatch(
            String stationType,
            String sessionId,
            int pageIndex,
            String screenHash,
            String platform,
            String city,
            List<JSONObject> snapshots,
            boolean quoteFeatureEnabled
    ) {
        JSONArray observations = new JSONArray();
        JSONArray localKeys = new JSONArray();
        String capturedAt = "";
        boolean requiresQuoteFeature = false;
        if (snapshots != null) for (JSONObject snapshot : snapshots) {
            if (snapshot == null || !stationType.equals(snapshot.optString("stationType", "charging"))) continue;
            JSONObject observation = StationObservationV3.fromLocalRow(snapshot);
            ObservationEnvelope.requireValid(observation);
            observations.put(observation);
            localKeys.put(snapshot.optString("localKey"));
            if (capturedAt.isEmpty()) capturedAt = CaptureTime.requireUtc(snapshot.optString("capturedAt"));
            requiresQuoteFeature |= FuelQuoteFeatureGate.requiresFeature(observation);
        }
        if (observations.length() == 0 || observations.length() != localKeys.length()) {
            throw new IllegalArgumentException("没有可保存的场站事务");
        }
        JSONObject batch = new JSONObject();
        try {
            batch.put("schemaVersion", StationObservationV3.SCHEMA_VERSION)
                    .put("stationType", stationType)
                    .put("batchId", batchId(sessionId, pageIndex, screenHash))
                    .put("sessionId", sessionId)
                    .put("pageIndex", pageIndex)
                    .put("screenHash", screenHash)
                    .put("platform", platform)
                    .put("city", city)
                    .put("capturedAt", capturedAt)
                    .put("attempts", 0)
                    .put("localKeys", localKeys)
                    .put("observations", observations);
            if (requiresQuoteFeature) batch.put("feature", FuelQuoteFeatureGate.FEATURE);
            if (requiresQuoteFeature && !quoteFeatureEnabled) markDeferred(batch);
        } catch (Exception error) {
            throw new IllegalStateException("无法准备回传事务", error);
        }
        ObservationEnvelope.requireValidBatch(batch);
        StationSensitiveDataPolicy.requireSafeBatch(batch);
        return AddressFreePayload.copyObject(batch);
    }

    static void upsertPreparedBatch(Context context, JSONObject preparedBatch) {
        JSONObject batch = AddressFreePayload.copyObject(preparedBatch);
        ObservationEnvelope.requireValidBatch(batch);
        StationSensitiveDataPolicy.requireSafeBatch(batch);
        String batchId = batch.optString("batchId").trim();
        if (batchId.isEmpty()) throw new IllegalArgumentException("回传事务缺少批次标识");
        synchronized (LOCK) {
            List<JSONObject> batches = read(context);
            for (JSONObject existing : batches) {
                if (batchId.equals(existing.optString("batchId"))) return;
            }
            if (batches.size() >= MAX_BATCHES) throw new IllegalStateException("回传队列已满");
            batches.add(batch);
            persist(context, batches);
        }
    }

    static JSONObject enqueue(
            Context context,
            String sessionId,
            int pageIndex,
            String screenHash,
            String platform,
            String city,
            List<String> localKeys,
            List<DidiLocalStationParser.StationRecord> stations
    ) throws Exception {
        JSONArray observations = new JSONArray();
        for (DidiLocalStationParser.StationRecord station : stations) {
            if (station != null && station.stationName != null && !station.stationName.trim().isEmpty()) {
                observations.put(ObservationEnvelope.charging(station, city));
            }
        }
        if (observations.length() == 0) throw new IllegalArgumentException("没有可保存的场站");
        String capturedAt = captureTime(stations);
        JSONObject batch = new JSONObject()
                .put("schemaVersion", StationObservationV3.SCHEMA_VERSION)
                .put("stationType", "charging")
                .put("batchId", batchId(sessionId, pageIndex, screenHash))
                .put("sessionId", sessionId)
                .put("pageIndex", pageIndex)
                .put("screenHash", screenHash)
                .put("platform", platform)
                .put("city", city)
                .put("capturedAt", capturedAt)
                .put("attempts", 0)
                .put("localKeys", new JSONArray(localKeys))
                .put("observations", observations);
        ObservationEnvelope.requireValidBatch(batch);
        StationSensitiveDataPolicy.requireSafeBatch(batch);
        synchronized (LOCK) {
            List<JSONObject> batches = read(context);
            boolean existing = remove(batches, batch.optString("batchId"));
            if (!existing && batches.size() >= MAX_BATCHES) {
                throw new IllegalStateException("回传队列已满");
            }
            batches.add(batch);
            persist(context, batches);
        }
        BackfillRetryScheduler.schedule(context);
        return batch;
    }

    static JSONObject enqueueFuel(
            Context context,
            String sessionId,
            int pageIndex,
            String screenHash,
            String platform,
            String city,
            List<String> localKeys,
            List<FuelStationRecord> stations
    ) throws Exception {
        return enqueueFuel(
                context,
                sessionId,
                pageIndex,
                screenHash,
                platform,
                city,
                localKeys,
                stations,
                false
        );
    }

    static JSONObject enqueueFuel(
            Context context,
            String sessionId,
            int pageIndex,
            String screenHash,
            String platform,
            String city,
            List<String> localKeys,
            List<FuelStationRecord> stations,
            boolean quoteFeatureEnabled
    ) throws Exception {
        JSONArray observations = new JSONArray();
        String capturedAt = "";
        boolean requiresQuoteFeature = false;
        for (FuelStationRecord station : stations) {
            if (station == null || station.stationName == null || station.stationName.trim().isEmpty()) continue;
            requiresQuoteFeature |= FuelQuoteFeatureGate.requiresFeature(station);
        }
        for (FuelStationRecord station : stations) {
            if (station == null || station.stationName == null || station.stationName.trim().isEmpty()) continue;
            observations.put(station.observationJson(city, requiresQuoteFeature));
            if (capturedAt.isEmpty()) capturedAt = CaptureTime.requireUtc(station.capturedAt);
        }
        if (observations.length() == 0) throw new IllegalArgumentException("没有可保存的燃油场站");
        JSONObject batch = new JSONObject()
                .put("schemaVersion", StationObservationV3.SCHEMA_VERSION)
                .put("stationType", "fuel")
                .put("batchId", batchId(sessionId, pageIndex, screenHash))
                .put("sessionId", sessionId)
                .put("pageIndex", pageIndex)
                .put("screenHash", screenHash)
                .put("platform", platform)
                .put("city", city)
                .put("capturedAt", capturedAt)
                .put("attempts", 0)
                .put("localKeys", new JSONArray(localKeys))
                .put("observations", observations);
        if (requiresQuoteFeature) batch.put("feature", FuelQuoteFeatureGate.FEATURE);
        if (requiresQuoteFeature && !quoteFeatureEnabled) markDeferred(batch);
        ObservationEnvelope.requireValidBatch(batch);
        StationSensitiveDataPolicy.requireSafeBatch(batch);
        synchronized (LOCK) {
            List<JSONObject> batches = read(context);
            boolean existing = remove(batches, batch.optString("batchId"));
            if (!existing && batches.size() >= MAX_BATCHES) throw new IllegalStateException("回传队列已满");
            batches.add(batch);
            persist(context, batches);
        }
        BackfillRetryScheduler.schedule(context);
        return batch;
    }

    static List<JSONObject> pending(Context context) {
        synchronized (LOCK) {
            return addressFreeView(read(context));
        }
    }

    static List<JSONObject> retryablePending(Context context) {
        List<JSONObject> output = new ArrayList<>();
        synchronized (LOCK) {
            for (JSONObject batch : read(context)) {
                if (MANUAL_REVIEW.equals(batch.optString(FAILURE_DISPOSITION))
                        || isDeferred(batch)) continue;
                output.add(AddressFreePayload.copyObject(batch));
            }
        }
        return output;
    }

    static boolean hasRetryablePending(Context context) {
        synchronized (LOCK) {
            for (JSONObject batch : read(context)) {
                if (!MANUAL_REVIEW.equals(batch.optString(FAILURE_DISPOSITION))
                        && !isDeferred(batch)) return true;
            }
            return false;
        }
    }

    static boolean hasUploadWork(Context context) {
        synchronized (LOCK) {
            for (JSONObject batch : read(context)) {
                if (!MANUAL_REVIEW.equals(batch.optString(FAILURE_DISPOSITION))) return true;
            }
            return false;
        }
    }

    static List<JSONObject> deferredFuel(Context context) {
        List<JSONObject> output = new ArrayList<>();
        synchronized (LOCK) {
            for (JSONObject batch : read(context)) {
                if (isDeferred(batch)) output.add(AddressFreePayload.copyObject(batch));
            }
        }
        return output;
    }

    static boolean promoteDeferred(Context context, String batchId) {
        synchronized (LOCK) {
            List<JSONObject> batches = read(context);
            boolean changed = false;
            for (JSONObject batch : batches) {
                if (!String.valueOf(batchId).equals(batch.optString("batchId"))
                        || !isDeferred(batch)) continue;
                batch.remove(DELIVERY_STATE);
                batch.remove(DEFERRED_REASON);
                batch.remove(FAILURE_DISPOSITION);
                batch.remove("lastError");
                changed = true;
                break;
            }
            if (changed) persist(context, batches);
            return changed;
        }
    }

    static boolean isDeferred(JSONObject batch) {
        return batch != null && DEFERRED_FEATURE.equals(batch.optString(DELIVERY_STATE));
    }

    static List<JSONObject> addressFreeView(List<JSONObject> batches) {
        List<JSONObject> output = new ArrayList<>();
        if (batches != null) for (JSONObject batch : batches) {
            ObservationEnvelope.requireValidBatch(batch);
            output.add(AddressFreePayload.copyObject(batch));
        }
        return output;
    }

    static int pendingStationCount(Context context) {
        int count = 0;
        synchronized (LOCK) {
            for (JSONObject batch : read(context)) {
                JSONArray stations = batch.optJSONArray("stations");
                if (stations != null) count += stations.length();
                JSONArray observations = batch.optJSONArray("observations");
                if (observations != null) count += observations.length();
            }
        }
        return count;
    }

    static int markFailed(Context context, String batchId, String message) {
        return markFailed(context, batchId, message, UploadFailure.Disposition.RETRYABLE);
    }

    static int markFailed(
            Context context,
            String batchId,
            String message,
            UploadFailure.Disposition disposition
    ) {
        int attempts = 1;
        synchronized (LOCK) {
            List<JSONObject> batches = read(context);
            for (JSONObject batch : batches) {
                if (!batchId.equals(batch.optString("batchId"))) continue;
                batch.remove("lastError");
                try {
                    attempts = batch.optInt("attempts") + 1;
                    batch.put("attempts", attempts)
                            .put("lastError", compact(message))
                            .put(
                                    FAILURE_DISPOSITION,
                                    disposition == UploadFailure.Disposition.MANUAL_REVIEW
                                            ? MANUAL_REVIEW
                                            : RETRYABLE
                            );
                } catch (Exception ignored) {
                    // Values are bounded strings and integers.
                }
            }
            persist(context, batches);
        }
        return attempts;
    }

    static boolean requiresManualReview(JSONObject batch) {
        return batch != null && MANUAL_REVIEW.equals(batch.optString(FAILURE_DISPOSITION));
    }

    static void markSynced(Context context, String batchId) {
        synchronized (LOCK) {
            List<JSONObject> batches = read(context);
            remove(batches, batchId);
            persist(context, batches);
        }
    }

    static void upsertBackfillBatch(Context context, String stableIdentity, JSONObject batch) {
        if (batch == null || batch.optString("batchId").trim().isEmpty()) {
            throw new IllegalArgumentException("回填批次不完整");
        }
        ObservationEnvelope.requireValidBatch(batch);
        StationSensitiveDataPolicy.requireSafeBatch(batch);
        if (FuelQuoteFeatureGate.FEATURE.equals(batch.optString("feature"))) markDeferred(batch);
        synchronized (LOCK) {
            List<JSONObject> batches = read(context);
            stripStableIdentity(batches, stableIdentity, "");
            remove(batches, batch.optString("batchId"));
            if (batches.size() >= MAX_BATCHES) throw new IllegalStateException("回传队列已满");
            batches.add(0, AddressFreePayload.copyObject(batch));
            persist(context, batches);
        }
    }

    static JSONObject findBatch(Context context, String batchId) {
        synchronized (LOCK) {
            for (JSONObject batch : read(context)) {
                if (String.valueOf(batchId).equals(batch.optString("batchId"))) {
                    ObservationEnvelope.requireValidBatch(batch);
                    return AddressFreePayload.copyObject(batch);
                }
            }
            return null;
        }
    }

    static List<JSONObject> pendingManual(Context context) {
        List<JSONObject> output = new ArrayList<>();
        synchronized (LOCK) {
            for (JSONObject batch : read(context)) {
                if (batch.optJSONObject("manualBackfill") != null) {
                    ObservationEnvelope.requireValidBatch(batch);
                    output.add(AddressFreePayload.copyObject(batch));
                }
            }
        }
        return output;
    }

    static void removeBatch(Context context, String batchId) {
        if (batchId == null || batchId.trim().isEmpty()) return;
        synchronized (LOCK) {
            List<JSONObject> batches = read(context);
            if (remove(batches, batchId)) persist(context, batches);
        }
    }

    static boolean isCurrentManualBatch(
            Context context,
            String stableIdentity,
            String batchId,
            String editId,
            int revision
    ) {
        synchronized (LOCK) {
            return isCurrentManualBatch(read(context), stableIdentity, batchId, editId, revision);
        }
    }

    static boolean isCurrentManualBatch(
            List<JSONObject> batches,
            String stableIdentity,
            String batchId,
            String editId,
            int revision
    ) {
        if (batches == null) return false;
        for (JSONObject batch : batches) {
            if (!String.valueOf(batchId).equals(batch.optString("batchId"))) continue;
            JSONObject metadata = batch.optJSONObject("manualBackfill");
            return metadata != null
                    && String.valueOf(stableIdentity).equals(metadata.optString("stableIdentity"))
                    && String.valueOf(editId).equals(metadata.optString("editId"))
                    && revision == metadata.optInt("revision");
        }
        return false;
    }

    static void removeStableIdentity(Context context, String stableIdentity, String acknowledgedBatchId) {
        synchronized (LOCK) {
            List<JSONObject> batches = read(context);
            boolean changed = stripStableIdentity(batches, stableIdentity, acknowledgedBatchId);
            if (changed) persist(context, batches);
        }
    }

    static List<String> localKeys(JSONObject batch) {
        List<String> output = new ArrayList<>();
        JSONArray values = batch == null ? null : batch.optJSONArray("localKeys");
        if (values == null) return output;
        for (int index = 0; index < values.length(); index++) {
            String value = values.optString(index, "").trim();
            if (!value.isEmpty()) output.add(value);
        }
        return output;
    }

    static int removeStationNames(Context context, Set<String> rejectedNames) {
        if (rejectedNames == null || rejectedNames.isEmpty()) return 0;
        synchronized (LOCK) {
            List<JSONObject> batches = read(context);
            int removed = 0;
            for (int batchIndex = batches.size() - 1; batchIndex >= 0; batchIndex--) {
                JSONObject batch = batches.get(batchIndex);
                JSONArray stations = batch.optJSONArray("stations");
                JSONArray keys = batch.optJSONArray("localKeys");
                if (stations == null) continue;
                JSONArray keptStations = new JSONArray();
                JSONArray keptKeys = new JSONArray();
                for (int stationIndex = 0; stationIndex < stations.length(); stationIndex++) {
                    JSONObject station = stations.optJSONObject(stationIndex);
                    String name = station == null ? "" : FalsePositiveCleanup.normalize(
                            station.optString("stationName")
                    );
                    if (rejectedNames.contains(name)) {
                        removed++;
                        continue;
                    }
                    if (station != null) keptStations.put(station);
                    if (keys != null && stationIndex < keys.length()) keptKeys.put(keys.opt(stationIndex));
                }
                if (keptStations.length() == 0) {
                    batches.remove(batchIndex);
                } else if (keptStations.length() != stations.length()) {
                    try {
                        batch.put("stations", keptStations).put("localKeys", keptKeys);
                    } catch (Exception error) {
                        throw new IllegalStateException("无法清理误识别回传项", error);
                    }
                }
            }
            if (removed > 0) persist(context, batches);
            return removed;
        }
    }

    static int removeCollectorFeedback(Context context, Set<String> removedLocalKeys) {
        synchronized (LOCK) {
            List<JSONObject> batches = read(context);
            int removed = 0;
            for (int batchIndex = batches.size() - 1; batchIndex >= 0; batchIndex--) {
                JSONObject batch = batches.get(batchIndex);
                JSONArray stations = batch.optJSONArray("stations");
                JSONArray keys = batch.optJSONArray("localKeys");
                if (stations == null) continue;
                JSONArray keptStations = new JSONArray();
                JSONArray keptKeys = new JSONArray();
                for (int stationIndex = 0; stationIndex < stations.length(); stationIndex++) {
                    JSONObject station = stations.optJSONObject(stationIndex);
                    String key = keys == null ? "" : keys.optString(stationIndex, "").trim();
                    boolean remove = !key.isEmpty() && removedLocalKeys != null && removedLocalKeys.contains(key);
                    if (!remove) {
                        remove = CollectorFeedbackCleanup.shouldRemove(station, batch.optString("capturedAt"));
                    }
                    if (remove) {
                        removed++;
                        continue;
                    }
                    if (station != null) keptStations.put(station);
                    if (keys != null && stationIndex < keys.length()) keptKeys.put(keys.opt(stationIndex));
                }
                if (keptStations.length() == 0) {
                    batches.remove(batchIndex);
                } else if (keptStations.length() != stations.length()) {
                    try {
                        batch.put("stations", keptStations).put("localKeys", keptKeys);
                    } catch (Exception error) {
                        throw new IllegalStateException("无法清理结果页递归项", error);
                    }
                }
            }
            if (removed > 0) persist(context, batches);
            return removed;
        }
    }

    static String batchId(String sessionId, int pageIndex, String screenHash) {
        return DeviceIdentity.sha256(String.valueOf(sessionId) + ":" + pageIndex + ":" + String.valueOf(screenHash));
    }

    static long retryDelayMillis(int attempts) {
        int exponent = Math.max(0, Math.min(6, attempts - 1));
        return Math.min(300_000L, 5_000L * (1L << exponent));
    }

    private static void markDeferred(JSONObject batch) {
        try {
            batch.put(DELIVERY_STATE, DEFERRED_FEATURE)
                    .put(DEFERRED_REASON, FuelQuoteFeatureGate.FEATURE);
        } catch (Exception error) {
            throw new IllegalStateException("无法保存燃油报价待办", error);
        }
    }

    private static String captureTime(List<DidiLocalStationParser.StationRecord> stations) {
        if (stations == null) throw new IllegalArgumentException("没有可保存的场站");
        for (DidiLocalStationParser.StationRecord station : stations) {
            if (station != null && station.stationName != null && !station.stationName.trim().isEmpty()) {
                return CaptureTime.requireUtc(station.capturedAt);
            }
        }
        throw new IllegalArgumentException("没有可保存的场站");
    }

    static boolean stripStableIdentity(
            List<JSONObject> batches,
            String stableIdentity,
            String acknowledgedBatchId
    ) {
        String expected = stableIdentity == null ? "" : stableIdentity.trim();
        boolean changed = false;
        for (int batchIndex = batches.size() - 1; batchIndex >= 0; batchIndex--) {
            JSONObject batch = batches.get(batchIndex);
            if (!String.valueOf(acknowledgedBatchId).isEmpty()
                    && String.valueOf(acknowledgedBatchId).equals(batch.optString("batchId"))) {
                batches.remove(batchIndex);
                changed = true;
                continue;
            }
            JSONObject manual = batch.optJSONObject("manualBackfill");
            if (manual != null && expected.equals(manual.optString("stableIdentity"))) {
                batches.remove(batchIndex);
                changed = true;
                continue;
            }
            JSONArray stations = batch.optJSONArray("stations");
            JSONArray observations = batch.optJSONArray("observations");
            JSONArray keys = batch.optJSONArray("localKeys");
            if ((stations == null && observations == null) || keys == null) continue;
            JSONArray records = stations != null ? stations : observations;
            JSONArray keptStations = new JSONArray();
            JSONArray keptKeys = new JSONArray();
            for (int index = 0; index < records.length(); index++) {
                String key = index < keys.length() ? keys.optString(index) : "";
                String identity = key.isEmpty() ? "" : StationIdentity.fromLocalKey(
                        key,
                        batch.optString("sessionId"),
                        batch.optInt("pageIndex")
                );
                if (!expected.isEmpty() && expected.equals(identity)) {
                    changed = true;
                    continue;
                }
                JSONObject station = records.optJSONObject(index);
                if (station != null) keptStations.put(station);
                if (!key.isEmpty()) keptKeys.put(key);
            }
            if (keptStations.length() == 0 && records.length() > 0) {
                batches.remove(batchIndex);
            } else if (keptStations.length() != records.length()) {
                try {
                    batch.put(stations != null ? "stations" : "observations", keptStations)
                            .put("localKeys", keptKeys);
                } catch (Exception error) {
                    throw new IllegalStateException("无法更新回填待发队列", error);
                }
            }
        }
        return changed;
    }

    private static List<JSONObject> read(Context context) {
        List<JSONObject> output = new ArrayList<>();
        try {
            JSONArray array = new JSONArray(prefs(context).getString(KEY_BATCHES, "[]"));
            for (int index = 0; index < array.length(); index++) {
                JSONObject batch = array.optJSONObject(index);
                if (batch != null) output.add(batch);
            }
        } catch (Exception error) {
            prefs(context).edit().remove(KEY_BATCHES).apply();
        }
        return output;
    }

    private static void persist(Context context, List<JSONObject> batches) {
        JSONArray output = new JSONArray();
        if (batches.size() > MAX_BATCHES) throw new IllegalStateException("回传队列超过上限");
        for (JSONObject batch : batches) output.put(batch);
        if (!prefs(context).edit().putString(KEY_BATCHES, output.toString()).commit()) {
            throw new IllegalStateException("无法保存回传队列");
        }
    }

    static boolean remove(List<JSONObject> batches, String batchId) {
        boolean removed = false;
        for (int index = batches.size() - 1; index >= 0; index--) {
            if (batchId.equals(batches.get(index).optString("batchId"))) {
                batches.remove(index);
                removed = true;
            }
        }
        return removed;
    }

    private static String compact(String value) {
        String output = value == null ? "" : value.replaceAll("[\\r\\n]+", " ").trim();
        return output.length() <= 180 ? output : output.substring(0, 180);
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
