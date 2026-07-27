package com.datafordidi.mobilecollector;

import android.content.Context;

import com.datafordidi.ocruploader.BuildConfig;

import org.json.JSONArray;
import org.json.JSONObject;

import java.time.Duration;
import java.util.concurrent.TimeUnit;

import okhttp3.HttpUrl;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

final class StationSyncClient {
    private static final MediaType JSON = MediaType.get("application/json; charset=utf-8");
    private final OkHttpClient client = new OkHttpClient.Builder()
            .connectTimeout(12, TimeUnit.SECONDS)
            .readTimeout(20, TimeUnit.SECONDS)
            .writeTimeout(20, TimeUnit.SECONDS)
            .callTimeout(Duration.ofSeconds(30))
            .retryOnConnectionFailure(true)
            .build();

    UploadResult upload(Context context, JSONObject batch) throws Exception {
        FuelQuoteIdentityPolicy.repairBatch(batch);
        ObservationEnvelope.requireValidBatch(batch);
        StationSensitiveDataPolicy.requireSafeBatch(batch);
        String token = AppSettings.getUploadToken(context);
        if (token.isEmpty()) throw UploadFailure.manualReview("未配置回传");
        HttpUrl baseUrl = validateBaseUrl(AppSettings.getUploadUrl(context));
        int schemaVersion = batch.optInt("schemaVersion", 1);
        boolean observationBatch = schemaVersion == 2
                || schemaVersion == StationObservationV3.SCHEMA_VERSION;
        boolean fuelObservationBatch = observationBatch && "fuel".equals(batch.optString("stationType"));
        JSONArray records = observationBatch
                ? AddressFreePayload.copyArray(batch.optJSONArray("observations"))
                : addressFreeStations(batch);
        if (records == null || records.length() == 0) throw new IllegalArgumentException("没有可回传的场站");
        boolean fuelQuoteV1 = FuelQuoteFeatureGate.FEATURE.equals(batch.optString("feature"));
        if (schemaVersion == StationObservationV3.SCHEMA_VERSION) requireV3Capability(
                baseUrl, batch.optString("platform"), fuelObservationBatch, fuelQuoteV1, records
        );
        else if (fuelObservationBatch) requireFuelCapability(
                baseUrl, batch.optString("platform"), fuelQuoteV1, records
        );

        String deviceId = DeviceIdentity.get(context);
        JSONObject payload = buildPayload(context, batch, records, fuelObservationBatch);
        StationSensitiveDataPolicy.requireSafePayload(payload);

        String sessionId = batch.optString("sessionId");
        int pageIndex = batch.optInt("pageIndex");
        String screenHash = batch.optString("screenHash");
        HttpUrl target = baseUrl.newBuilder()
                .addPathSegments("api/mobile-sync/stations")
                .build();
        Request request = new Request.Builder()
                .url(target)
                .header("Authorization", "Bearer " + token)
                .header("X-Mobile-Agent", LocalStationStore.SOURCE_AGENT)
                .header("Idempotency-Key", idempotencyKey(deviceId, sessionId, pageIndex, screenHash))
                .header("User-Agent", "DataForDidi-OcrUploader/" + BuildConfig.VERSION_NAME + " Android")
                .post(RequestBody.create(payload.toString(), JSON))
                .build();

        try (Response response = client.newCall(request).execute()) {
            String responseText = response.body() == null ? "" : response.body().string();
            return parseAcknowledgement(
                    response.code(),
                    responseText,
                    batch.optJSONObject("manualBackfill") != null,
                    records.length(),
                    fuelQuoteV1,
                    countFuelQuotes(records),
                    fuelObservationBatch
            );
        }
    }

    static JSONObject buildPayload(
            Context context,
            JSONObject batch,
            JSONArray records,
            boolean fuelObservationBatch
    ) throws Exception {
        JSONObject payload = new JSONObject()
                .put("clientVersion", "android-ocr-" + BuildConfig.VERSION_NAME)
                .put("sourceAgent", LocalStationStore.SOURCE_AGENT)
                .put("sourceStage", "screen-ocr-user-driven")
                .put("platform", required(batch, "platform"))
                .put("city", required(batch, "city"))
                .put("deviceId", DeviceIdentity.get(context))
                .put("deviceSessionId", AppSettings.getDeviceSessionId(context))
                .put("appPackage", context.getPackageName())
                .put("sessionId", required(batch, "sessionId"))
                .put("pageIndex", batch.optInt("pageIndex"))
                .put("capturedAt", required(batch, "capturedAt"));
        addBatchRecords(payload, batch, records);
        return payload;
    }

    boolean isFuelQuoteFeatureEnabled(Context context, String platform) {
        if (!AppSettings.isUploadConfigured(context)) return false;
        try {
            HttpUrl baseUrl = validateBaseUrl(AppSettings.getUploadUrl(context));
            String body = health(baseUrl);
            return supportsFuelV2(body) && FuelQuoteFeatureGate.enabled(body, platform);
        } catch (Exception ignored) {
            return false;
        }
    }

    boolean canPromoteDeferredFuelBatch(Context context, JSONObject batch) {
        if (!AppSettings.isUploadConfigured(context) || batch == null) return false;
        try {
            ObservationEnvelope.requireValidBatch(batch);
            StationSensitiveDataPolicy.requireSafeBatch(batch);
            if (!"fuel".equals(batch.optString("stationType"))
                    || !FuelQuoteFeatureGate.FEATURE.equals(batch.optString("feature"))) {
                return false;
            }
            JSONArray observations = batch.optJSONArray("observations");
            HttpUrl baseUrl = validateBaseUrl(AppSettings.getUploadUrl(context));
            String body = health(baseUrl);
            return supportsSchemaV3(body)
                    && FuelQuoteFeatureGate.enabled(body, batch.optString("platform"))
                    && FuelQuoteFeatureGate.supportsBatch(
                            body,
                            batch.optString("platform"),
                            observations
                    );
        } catch (Exception ignored) {
            return false;
        }
    }

    private void requireFuelCapability(
            HttpUrl baseUrl,
            String platform,
            boolean fuelQuoteV1,
            JSONArray observations
    ) throws Exception {
        String body = health(baseUrl);
        if (!supportsFuelV2(body)) throw UploadFailure.manualReview("服务暂不支持加油数据");
        if (fuelQuoteV1) {
            if (!FuelQuoteFeatureGate.enabled(body, platform)) {
                throw UploadFailure.retryable("服务暂未开启燃油报价能力");
            }
            if (!FuelQuoteFeatureGate.supportsBatch(body, platform, observations)) {
                throw UploadFailure.retryable("燃油报价批次暂不受服务支持");
            }
        }
    }

    private void requireV3Capability(
            HttpUrl baseUrl,
            String platform,
            boolean fuel,
            boolean fuelQuoteV1,
            JSONArray observations
    ) throws Exception {
        String body = health(baseUrl);
        if (!supportsSchemaV3(body)) throw UploadFailure.manualReview("服务暂不支持场站协议 v3");
        if (fuel && fuelQuoteV1) {
            if (!FuelQuoteFeatureGate.enabled(body, platform)
                    || !FuelQuoteFeatureGate.supportsBatch(body, platform, observations)) {
                throw UploadFailure.retryable("燃油报价能力暂不可用");
            }
        }
    }

    private String health(HttpUrl baseUrl) throws Exception {
        Request request = new Request.Builder()
                .url(baseUrl.newBuilder().addPathSegment("health").build())
                .header("User-Agent", "DataForDidi-OcrUploader/" + BuildConfig.VERSION_NAME + " Android")
                .get()
                .build();
        try (Response response = client.newCall(request).execute()) {
            if (!response.isSuccessful()) throw UploadFailure.forHttpStatus(response.code());
            return response.body() == null ? "" : response.body().string();
        }
    }

    static boolean supportsFuelV2(String responseText) {
        try {
            JSONObject root = new JSONObject(responseText == null ? "" : responseText);
            JSONObject data = root.optJSONObject("data");
            if (!root.optBoolean("success", false) || data == null) return false;
            JSONObject capabilities = data.optJSONObject("capabilities");
            if (capabilities == null || capabilities.optInt("schemaVersion") != 2) return false;
            JSONArray stationTypes = capabilities.optJSONArray("stationTypes");
            if (stationTypes == null) return false;
            for (int index = 0; index < stationTypes.length(); index++) {
                if ("fuel".equals(stationTypes.optString(index))) return true;
            }
            return false;
        } catch (Exception ignored) {
            return false;
        }
    }

    static boolean supportsSchemaV3(String responseText) {
        try {
            JSONObject root = new JSONObject(responseText == null ? "" : responseText);
            JSONObject data = root.optJSONObject("data");
            JSONObject capabilities = data == null ? null : data.optJSONObject("capabilities");
            if (!root.optBoolean("success", false) || capabilities == null) return false;
            if (capabilities.optInt("schemaVersion", -1) >= StationObservationV3.SCHEMA_VERSION
                    || capabilities.optInt("latestSchemaVersion", -1)
                    >= StationObservationV3.SCHEMA_VERSION) return true;
            JSONArray supported = capabilities.optJSONArray("supportedSchemaVersions");
            if (supported == null) return false;
            for (int index = 0; index < supported.length(); index++) {
                if (supported.optInt(index, -1) == StationObservationV3.SCHEMA_VERSION) return true;
            }
            return false;
        } catch (Exception ignored) {
            return false;
        }
    }

    static UploadResult parseAcknowledgement(
            int statusCode,
            String responseText,
            boolean manualBackfill,
            int stationCount
    ) throws Exception {
        return parseAcknowledgement(
                statusCode,
                responseText,
                manualBackfill,
                stationCount,
                false,
                0,
                false
        );
    }

    static UploadResult parseAcknowledgement(
            int statusCode,
            String responseText,
            boolean manualBackfill,
            int stationCount,
            boolean fuelQuoteV1,
            int quoteCount
    ) throws Exception {
        return parseAcknowledgement(
                statusCode,
                responseText,
                manualBackfill,
                stationCount,
                fuelQuoteV1,
                quoteCount,
                fuelQuoteV1
        );
    }

    static UploadResult parseAcknowledgement(
            int statusCode,
            String responseText,
            boolean manualBackfill,
            int stationCount,
            boolean fuelQuoteV1,
            int quoteCount,
            boolean fuelV2
    ) throws Exception {
        if (statusCode < 200 || statusCode >= 300) {
            throw UploadFailure.forHttpStatus(statusCode, serverErrorCode(responseText));
        }
        JSONObject acknowledgement;
        try {
            acknowledgement = new JSONObject(responseText == null ? "" : responseText);
        } catch (Exception error) {
            throw UploadFailure.manualReview("服务返回无效确认");
        }
        JSONObject data = acknowledgement.optJSONObject("data");
        if (!acknowledgement.optBoolean("success", false)
                || data == null
                || !data.optBoolean("persisted", false)
                || !"47-mysql".equals(data.optString("sourceNode"))
                || !LocalStationStore.SOURCE_AGENT.equals(data.optString("sourceAgent"))) {
            throw UploadFailure.manualReview("服务未确认落库来源");
        }
        long first = data.optLong("firstSourceRecordId", -1L);
        long last = data.optLong("lastSourceRecordId", -1L);
        if (stationCount <= 0
                || data.optInt("acceptedCount", -1) != stationCount
                || data.optString("ingestId", "").trim().isEmpty()
                || first <= 0L
                || last < first
                || manualBackfill && (stationCount != 1 || first != last)) {
            throw UploadFailure.manualReview("服务未确认场站事务落库");
        }
        if (fuelV2 && fuelQuoteV1 && data.optInt("acceptedQuoteCount", -1) != quoteCount) {
            throw UploadFailure.manualReview("服务未确认燃油报价落库");
        }
        return new UploadResult(
                fuelQuoteV1
                        ? "已回传 " + stationCount + " 个场站、" + quoteCount + " 条报价"
                        : "已回传 " + stationCount + " 条",
                manualBackfill,
                data.optBoolean("duplicate", false),
                data.optString("ingestId", "")
        );
    }

    static HttpUrl validateBaseUrl(String value) {
        return UploadEndpointPolicy.requireHttpsBaseUrl(value);
    }

    static String idempotencyKey(String deviceId, String sessionId, int pageIndex, String screenHash) {
        String seed = LocalStationStore.SOURCE_AGENT
                + ":" + compact(deviceId)
                + ":" + compact(sessionId)
                + ":" + pageIndex
                + ":" + compact(screenHash);
        return DeviceIdentity.sha256(seed);
    }

    static JSONArray addressFreeStations(JSONObject batch) {
        return AddressFreePayload.copyArray(batch == null ? null : batch.optJSONArray("stations"));
    }

    static void addBatchRecords(JSONObject payload, JSONObject batch, JSONArray records) throws Exception {
        if (batch != null && (batch.optInt("schemaVersion") == 2
                || batch.optInt("schemaVersion") == StationObservationV3.SCHEMA_VERSION)) {
            payload.put("schemaVersion", batch.optInt("schemaVersion"))
                    .put("stationType", batch.optString("stationType"))
                    .put("observations", records);
            if (FuelQuoteFeatureGate.FEATURE.equals(batch.optString("feature"))) {
                payload.put("feature", FuelQuoteFeatureGate.FEATURE);
            }
            return;
        }
        payload.put("stations", records);
    }

    static int countFuelQuotes(JSONArray observations) {
        int count = 0;
        if (observations == null) return count;
        for (int index = 0; index < observations.length(); index++) {
            JSONObject observation = observations.optJSONObject(index);
            JSONObject fuel = observation == null ? null : observation.optJSONObject("fuelObservation");
            JSONArray quotes = fuel == null ? null : fuel.optJSONArray("fuelQuotes");
            if (quotes != null) count += quotes.length();
        }
        return count;
    }

    static String serverErrorCode(String responseText) {
        try {
            JSONObject root = new JSONObject(responseText == null ? "" : responseText);
            JSONObject error = root.optJSONObject("error");
            String code = error == null ? "" : error.optString("code", "");
            if (code.trim().isEmpty()) code = root.optString("code", "");
            code = code == null ? "" : code.trim();
            return code.matches("[A-Za-z0-9][A-Za-z0-9._-]{0,63}") ? code : "";
        } catch (Exception ignored) {
            return "";
        }
    }

    private static String required(JSONObject value, String key) {
        String output = value.optString(key, "").trim();
        if (output.isEmpty()) throw new IllegalArgumentException("缺少批次字段");
        return output;
    }

    private static String compact(String value) {
        return value == null ? "" : value.replaceAll("[\\r\\n]+", " ").trim();
    }

    static final class UploadResult {
        final String message;
        final boolean manualBackfill;
        final boolean duplicate;
        final String ingestId;

        UploadResult(String message, boolean manualBackfill, boolean duplicate, String ingestId) {
            this.message = message;
            this.manualBackfill = manualBackfill;
            this.duplicate = duplicate;
            this.ingestId = ingestId;
        }
    }
}
