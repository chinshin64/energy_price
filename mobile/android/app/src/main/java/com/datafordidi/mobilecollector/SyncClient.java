package com.datafordidi.mobilecollector;

import android.content.Context;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.List;
import java.util.concurrent.TimeUnit;

import okhttp3.MediaType;
import okhttp3.HttpUrl;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

public class SyncClient {
    private static final String TAG = "DataForDidiSync";
    private static final MediaType JSON = MediaType.parse("application/json; charset=utf-8");
    private final OkHttpClient client = new OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(20, TimeUnit.SECONDS)
            .writeTimeout(20, TimeUnit.SECONDS)
            .build();

    public String uploadOcrRows(
            Context context,
            String sessionId,
            int pageIndex,
            int scrollIndex,
            String screenshotHash,
            List<OcrRow> rows
    ) throws Exception {
        return uploadOcrRows(
                context,
                sessionId,
                pageIndex,
                scrollIndex,
                screenshotHash,
                rows,
                "phone-auto-scroll",
                null
        );
    }

    public String uploadOcrRows(
            Context context,
            String sessionId,
            int pageIndex,
            int scrollIndex,
            String screenshotHash,
            List<OcrRow> rows,
            String sourceStage
    ) throws Exception {
        return uploadOcrRows(context, sessionId, pageIndex, scrollIndex, screenshotHash, rows, sourceStage, null);
    }

    public String uploadOcrRows(
            Context context,
            String sessionId,
            int pageIndex,
            int scrollIndex,
            String screenshotHash,
            List<OcrRow> rows,
            String sourceStage,
            String screenshotBase64
    ) throws Exception {
        if (!CollectorSettings.isRawOcrUploadEnabled(context)) {
            return "{\"success\":true,\"skipped\":true,\"reason\":\"raw OCR diagnostic upload disabled\"}";
        }
        JSONArray rowArray = new JSONArray();
        for (OcrRow row : rows) {
            if (!row.text.isEmpty()) {
                rowArray.put(row.toJson());
            }
        }

        String deviceId = collectorDeviceId(context);
        String effectiveStage = sourceStage == null ? "phone-auto-scroll" : sourceStage;
        JSONObject body = new JSONObject()
                .put("clientVersion", "android-" + BuildConfig.VERSION_NAME)
                .put("sourceAgent", LocalStationStore.SOURCE_AGENT)
                .put("platform", resolvePlatform(context))
                .put("city", CollectorSettings.getCity(context))
                .put("deviceId", deviceId)
                .put("deviceSessionId", CollectorSettings.getDeviceSessionId(context))
                .put("appPackage", currentPackageName())
                .put("currentPackageName", currentPackageName())
                .put("currentClassName", AutoScrollAccessibilityService.getCurrentClassName())
                .put("sessionId", sessionId)
                .put("pageIndex", pageIndex)
                .put("scrollIndex", scrollIndex)
                .put("sourceStage", effectiveStage)
                .put("screenshotHash", screenshotHash)
                .put("capturedAt", java.time.Instant.now().toString())
                .put("ocrRows", rowArray);

        if (screenshotBase64 != null && !screenshotBase64.isEmpty()) {
            body.put("screenshotBase64", screenshotBase64);
        }

        String url = CollectorSettings.getServerUrl(context) + "/api/mobile-sync/ocr";
        String token = CollectorSettings.getToken(context);
        Log.i(TAG, "upload ocr rows=" + rowArray.length()
                + " page=" + pageIndex
                + " stage=" + (sourceStage == null ? "phone-auto-scroll" : sourceStage)
                + " url=" + url);
        Request.Builder requestBuilder = new Request.Builder()
                .url(url)
                .header("X-Mobile-Agent", LocalStationStore.SOURCE_AGENT)
                .header("Idempotency-Key", buildIdempotencyKey(deviceId, sessionId, pageIndex, effectiveStage))
                .post(RequestBody.create(body.toString(), JSON));
        if (token != null && !token.trim().isEmpty()) {
            requestBuilder.header("Authorization", "Bearer " + token.trim());
        }

        try (Response response = client.newCall(requestBuilder.build()).execute()) {
            String text = response.body() == null ? "" : response.body().string();
            if (!response.isSuccessful()) {
                throw new IllegalStateException("sync failed: HTTP " + response.code() + " " + text);
            }
            Log.i(TAG, "upload ocr ok http=" + response.code());
            return text;
        }
    }

    public String uploadStations(
            Context context,
            String sessionId,
            int pageIndex,
            List<DidiLocalStationParser.StationRecord> stations,
            String sourceStage
    ) throws Exception {
        String deviceId = collectorDeviceId(context);
        String platform = resolvePlatform(context);
        String city = CollectorSettings.getCity(context);
        String effectiveStage = sourceStage == null ? "phone-auto-scroll" : sourceStage;
        JSONArray stationArray = new JSONArray();
        for (DidiLocalStationParser.StationRecord station : stations) {
            if (station.stationName != null && !station.stationName.trim().isEmpty()) {
                stationArray.put(station.toJson());
            }
        }
        if (stationArray.length() == 0) {
            return "{\"success\":true,\"message\":\"no local stations\"}";
        }

        JSONObject body = new JSONObject()
                .put("clientVersion", "android-" + BuildConfig.VERSION_NAME)
                .put("sourceAgent", LocalStationStore.SOURCE_AGENT)
                .put("platform", platform)
                .put("city", city)
                .put("deviceId", deviceId)
                .put("deviceSessionId", CollectorSettings.getDeviceSessionId(context))
                .put("appPackage", currentPackageName())
                .put("currentPackageName", currentPackageName())
                .put("currentClassName", AutoScrollAccessibilityService.getCurrentClassName())
                .put("sessionId", sessionId)
                .put("pageIndex", pageIndex)
                .put("sourceStage", effectiveStage)
                .put("capturedAt", java.time.Instant.now().toString())
                .put("stations", stationArray);

        String url = CollectorSettings.getServerUrl(context) + "/api/mobile-sync/stations";
        String token = CollectorSettings.getToken(context);
        Log.i(TAG, "upload stations count=" + stationArray.length()
                + " page=" + pageIndex
                + " stage=" + (sourceStage == null ? "phone-auto-scroll" : sourceStage)
                + " url=" + url);
        Request.Builder requestBuilder = new Request.Builder()
                .url(url)
                .header("X-Mobile-Agent", LocalStationStore.SOURCE_AGENT)
                .header("Idempotency-Key", buildIdempotencyKey(deviceId, sessionId, pageIndex, effectiveStage))
                .post(RequestBody.create(body.toString(), JSON));
        if (token != null && !token.trim().isEmpty()) {
            requestBuilder.header("Authorization", "Bearer " + token.trim());
        }

        try (Response response = client.newCall(requestBuilder.build()).execute()) {
            String text = response.body() == null ? "" : response.body().string();
            if (!response.isSuccessful()) {
                throw new IllegalStateException("station sync failed: HTTP " + response.code() + " " + text);
            }
            JSONObject acknowledgement = new JSONObject(text);
            JSONObject acknowledgementData = acknowledgement.optJSONObject("data");
            if (!acknowledgement.optBoolean("success", false)
                    || acknowledgementData == null
                    || !acknowledgementData.optBoolean("persisted", false)
                    || !"47-mysql".equals(acknowledgementData.optString("sourceNode"))) {
                throw new IllegalStateException("station sync was not committed by 47 MySQL");
            }
            Log.i(TAG, "upload stations ok http=" + response.code());
            return text;
        }
    }

    static String buildIdempotencyKey(String deviceId, String sessionId, int pageIndex, String sourceStage) {
        return LocalStationStore.SOURCE_AGENT + ":" + deviceId + ":"
                + sessionId + ":" + pageIndex + ":" + sourceStage;
    }

    public AiSupervisor.Decision uploadSupervisorEvent(
            Context context,
            String sessionId,
            int pageIndex,
            String sourceStage,
            AiSupervisor.Decision decision,
            List<OcrRow> rows
    ) throws Exception {
        if (decision == null) {
            return null;
        }

        JSONArray rowArray = new JSONArray();
        if (rows != null) {
            for (OcrRow row : rows) {
                if (row != null && !row.text.isEmpty()) {
                    rowArray.put(row.toJson());
                }
            }
        }

        JSONObject body = decision.toJson()
                .put("clientDecision", decision.toJson())
                .put("clientVersion", "android-" + BuildConfig.VERSION_NAME)
                .put("sourceAgent", LocalStationStore.SOURCE_AGENT)
                .put("platform", resolvePlatform(context))
                .put("city", CollectorSettings.getCity(context))
                .put("deviceId", collectorDeviceId(context))
                .put("deviceSessionId", CollectorSettings.getDeviceSessionId(context))
                .put("appPackage", currentPackageName())
                .put("currentPackageName", currentPackageName())
                .put("currentClassName", AutoScrollAccessibilityService.getCurrentClassName())
                .put("sessionId", sessionId)
                .put("pageIndex", pageIndex)
                .put("sourceStage", sourceStage == null ? "phone-auto-scroll" : sourceStage)
                .put("capturedAt", java.time.Instant.now().toString())
                .put("ocrRows", rowArray);

        String url = CollectorSettings.getServerUrl(context) + "/api/mobile-sync/supervisor";
        String token = CollectorSettings.getToken(context);
        Log.i(TAG, "upload supervisor page=" + pageIndex
                + " stage=" + (sourceStage == null ? "phone-auto-scroll" : sourceStage)
                + " action=" + (decision.action == null ? "NONE" : decision.action.name())
                + " url=" + url);
        Request.Builder requestBuilder = new Request.Builder()
                .url(url)
                .header("X-Mobile-Agent", LocalStationStore.SOURCE_AGENT)
                .post(RequestBody.create(body.toString(), JSON));
        if (token != null && !token.trim().isEmpty()) {
            requestBuilder.header("Authorization", "Bearer " + token.trim());
        }

        try (Response response = client.newCall(requestBuilder.build()).execute()) {
            String text = response.body() == null ? "" : response.body().string();
            if (!response.isSuccessful()) {
                throw new IllegalStateException("supervisor sync failed: HTTP " + response.code() + " " + text);
            }
            Log.i(TAG, "upload supervisor ok http=" + response.code());
            JSONObject responseJson = new JSONObject(text);
            JSONObject data = responseJson.optJSONObject("data");
            JSONObject serverDecision = data == null ? null : data.optJSONObject("decision");
            return AiSupervisor.Decision.fromJson(serverDecision, decision);
        }
    }

    public JSONObject pollCommand(Context context, String deviceId) throws Exception {
        HttpUrl baseUrl = HttpUrl.parse(CollectorSettings.getServerUrl(context) + "/api/mobile-sync/commands/poll");
        if (baseUrl == null) {
            throw new IllegalArgumentException("invalid sync server url");
        }
        HttpUrl url = baseUrl.newBuilder()
                .addQueryParameter("deviceId", deviceId == null ? collectorDeviceId(context) : deviceId)
                .addQueryParameter("deviceSessionId", CollectorSettings.getDeviceSessionId(context))
                .build();

        Request.Builder requestBuilder = new Request.Builder()
                .url(url)
                .get();
        applyAuthHeader(context, requestBuilder);

        try (Response response = client.newCall(requestBuilder.build()).execute()) {
            String text = response.body() == null ? "" : response.body().string();
            if (!response.isSuccessful()) {
                throw new IllegalStateException("command poll failed: HTTP " + response.code() + " " + text);
            }
            JSONObject body = new JSONObject(text);
            return body.optJSONObject("data");
        }
    }

    public JSONObject pollEdgeTask(Context context, String deviceId) throws Exception {
        HttpUrl baseUrl = HttpUrl.parse(CollectorSettings.getServerUrl(context) + "/api/edge/v1/tasks/poll");
        if (baseUrl == null) {
            throw new IllegalArgumentException("invalid edge server url");
        }
        Request.Builder requestBuilder = new Request.Builder().url(baseUrl).get();
        applyEdgeAuthHeader(context, deviceId, requestBuilder);
        try (Response response = client.newCall(requestBuilder.build()).execute()) {
            String text = response.body() == null ? "" : response.body().string();
            if (!response.isSuccessful()) {
                throw new IllegalStateException("edge task poll failed: HTTP " + response.code() + " " + text);
            }
            JSONObject body = new JSONObject(text);
            JSONObject task = body.optJSONObject("data");
            if (task != null) task.put("_edgeTransport", true);
            return task;
        }
    }

    public String uploadCommandResult(
            Context context,
            String commandId,
            boolean success,
            JSONObject result,
            String error
    ) throws Exception {
        JSONObject body = new JSONObject()
                .put("success", success)
                .put("result", result == null ? new JSONObject() : result)
                .put("error", error == null ? JSONObject.NULL : error)
                .put("deviceId", collectorDeviceId(context))
                .put("deviceSessionId", CollectorSettings.getDeviceSessionId(context))
                .put("completedAt", java.time.Instant.now().toString());

        String safeCommandId = commandId == null ? "" : commandId.trim();
        String url = CollectorSettings.getServerUrl(context)
                + "/api/mobile-sync/commands/"
                + safeCommandId
                + "/result";
        Request.Builder requestBuilder = new Request.Builder()
                .url(url)
                .post(RequestBody.create(body.toString(), JSON));
        applyAuthHeader(context, requestBuilder);

        try (Response response = client.newCall(requestBuilder.build()).execute()) {
            String text = response.body() == null ? "" : response.body().string();
            if (!response.isSuccessful()) {
                throw new IllegalStateException("command result failed: HTTP " + response.code() + " " + text);
            }
            return text;
        }
    }

    public String uploadEdgeTaskResult(
            Context context,
            String deviceId,
            String taskId,
            boolean success,
            JSONObject result,
            String error
    ) throws Exception {
        JSONObject body = new JSONObject()
                .put("success", success)
                .put("result", result == null ? new JSONObject() : result)
                .put("error", error == null ? JSONObject.NULL : error)
                .put("completedAt", java.time.Instant.now().toString());
        String url = CollectorSettings.getServerUrl(context)
                + "/api/edge/v1/tasks/" + (taskId == null ? "" : taskId.trim()) + "/result";
        Request.Builder requestBuilder = new Request.Builder()
                .url(url)
                .post(RequestBody.create(body.toString(), JSON));
        applyEdgeAuthHeader(context, deviceId, requestBuilder);
        try (Response response = client.newCall(requestBuilder.build()).execute()) {
            String text = response.body() == null ? "" : response.body().string();
            if (!response.isSuccessful()) {
                throw new IllegalStateException("edge task result failed: HTTP " + response.code() + " " + text);
            }
            return text;
        }
    }

    public JSONObject registerDevice(Context context, String deviceId) throws Exception {
        JSONObject body = new JSONObject()
                .put("clientVersion", "android-" + BuildConfig.VERSION_NAME)
                .put("sourceAgent", LocalStationStore.SOURCE_AGENT)
                .put("appVersion", "android-" + BuildConfig.VERSION_NAME)
                .put("deviceId", deviceId == null ? collectorDeviceId(context) : deviceId)
                .put("deviceSessionId", CollectorSettings.getDeviceSessionId(context))
                .put("manufacturer", android.os.Build.MANUFACTURER)
                .put("model", android.os.Build.MODEL)
                .put("androidVersion", android.os.Build.VERSION.RELEASE)
                .put("serverUrl", CollectorSettings.getServerUrl(context))
                .put("platform", resolvePlatform(context))
                .put("city", CollectorSettings.getCity(context))
                .put("appPackage", currentPackageName())
                .put("commandServiceRunning", true);

        String url = CollectorSettings.getServerUrl(context) + "/api/mobile-sync/devices/register";
        Request.Builder requestBuilder = new Request.Builder()
                .url(url)
                .header("X-Mobile-Agent", LocalStationStore.SOURCE_AGENT)
                .post(RequestBody.create(body.toString(), JSON));
        applyAuthHeader(context, requestBuilder);

        try (Response response = client.newCall(requestBuilder.build()).execute()) {
            String text = response.body() == null ? "" : response.body().string();
            if (!response.isSuccessful()) {
                throw new IllegalStateException("device register failed: HTTP " + response.code() + " " + text);
            }
            JSONObject responseJson = new JSONObject(text);
            JSONObject data = responseJson.optJSONObject("data");
            if (data != null && !data.optString("deviceSessionId", "").isEmpty()) {
                CollectorSettings.saveDeviceSessionId(context, data.optString("deviceSessionId"));
            }
            Log.i(TAG, "device register ok url=" + url);
            return data == null ? new JSONObject() : data;
        }
    }

    public JSONObject registerEdgeNode(Context context, String deviceId) throws Exception {
        String nodeId = deviceId == null ? collectorDeviceId(context) : deviceId;
        JSONObject body = new JSONObject()
                .put("nodeId", nodeId)
                .put("parentNodeId", CollectorSettings.getEdgeParentNodeId(context))
                .put("nodeType", "worker")
                .put("platform", "android")
                .put("version", "android-" + BuildConfig.VERSION_NAME)
                .put("capabilities", EdgeDeviceProfile.capabilities())
                .put("canDelegate", false)
                .put("fingerprintHash", EdgeDeviceProfile.fingerprintHash(context))
                .put("deviceProfile", EdgeDeviceProfile.build(context))
                .put("commandServiceRunning", true);
        String url = CollectorSettings.getServerUrl(context) + "/api/edge/v1/nodes/register";
        Request.Builder requestBuilder = new Request.Builder()
                .url(url)
                .header("X-Edge-Enrollment-Token", CollectorSettings.getEdgeEnrollmentToken(context))
                .post(RequestBody.create(body.toString(), JSON));
        try (Response response = client.newCall(requestBuilder.build()).execute()) {
            String text = response.body() == null ? "" : response.body().string();
            if (!response.isSuccessful()) {
                throw new IllegalStateException("edge node register failed: HTTP " + response.code() + " " + text);
            }
            JSONObject data = new JSONObject(text).optJSONObject("data");
            if (data == null || data.optString("sessionToken", "").isEmpty()) {
                throw new IllegalStateException("edge node register response missing session token");
            }
            CollectorSettings.saveEdgeSessionToken(context, data.optString("sessionToken"));
            return data.optJSONObject("node");
        }
    }

    public JSONObject heartbeatEdgeNode(Context context, String deviceId) throws Exception {
        JSONObject body = new JSONObject()
                .put("version", "android-" + BuildConfig.VERSION_NAME)
                .put("capabilities", EdgeDeviceProfile.capabilities())
                .put("deviceProfile", EdgeDeviceProfile.build(context))
                .put("commandServiceRunning", true);
        String url = CollectorSettings.getServerUrl(context) + "/api/edge/v1/nodes/heartbeat";
        Request.Builder requestBuilder = new Request.Builder()
                .url(url)
                .post(RequestBody.create(body.toString(), JSON));
        applyEdgeAuthHeader(context, deviceId, requestBuilder);
        try (Response response = client.newCall(requestBuilder.build()).execute()) {
            String text = response.body() == null ? "" : response.body().string();
            if (!response.isSuccessful()) {
                throw new IllegalStateException("edge heartbeat failed: HTTP " + response.code() + " " + text);
            }
            return new JSONObject(text).optJSONObject("data");
        }
    }

    private void applyAuthHeader(Context context, Request.Builder requestBuilder) {
        String token = CollectorSettings.getToken(context);
        if (token != null && !token.trim().isEmpty()) {
            requestBuilder.header("Authorization", "Bearer " + token.trim());
        }
        String deviceSessionId = CollectorSettings.getDeviceSessionId(context);
        if (deviceSessionId != null && !deviceSessionId.trim().isEmpty()) {
            requestBuilder.header("X-Mobile-Device-Session", deviceSessionId.trim());
        }
    }

    private void applyEdgeAuthHeader(Context context, String deviceId, Request.Builder requestBuilder) {
        requestBuilder.header("X-Edge-Node-Id", deviceId == null ? collectorDeviceId(context) : deviceId);
        String token = CollectorSettings.getEdgeSessionToken(context);
        if (token != null && !token.trim().isEmpty()) {
            requestBuilder.header("Authorization", "Bearer " + token.trim());
        }
    }

    private String currentPackageName() {
        String value = AutoScrollAccessibilityService.getCurrentPackageName();
        if (value == null || value.trim().isEmpty()) {
            return "unknown";
        }
        return value.trim();
    }

    private String resolvePlatform(Context context) {
        String pkg = currentPackageName();
        if ("com.autonavi.minimap".equals(pkg)) {
            return "amap-charging";
        }
        if ("com.tencent.mm".equals(pkg)) {
            return "didi-charging";
        }
        return CollectorSettings.getPlatform(context);
    }

    private String collectorDeviceId(Context context) {
        return DeviceIdentity.get(context);
    }
}
