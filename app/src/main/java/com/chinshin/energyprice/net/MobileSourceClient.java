package com.chinshin.energyprice.net;

import com.chinshin.energyprice.BuildConfig;
import com.chinshin.energyprice.data.CaptureRecord;
import com.chinshin.energyprice.security.SecureConfigStore;

import org.json.JSONObject;

import java.io.IOException;
import java.util.concurrent.TimeUnit;

import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

public final class MobileSourceClient {
    private static final MediaType JSON = MediaType.get("application/json; charset=utf-8");
    private final OkHttpClient http = new OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .build();

    public UploadResult upload(SecureConfigStore.Config config, CaptureRecord record) throws IOException {
        Request request = new Request.Builder()
                .url(config.rootUrl() + "/api/mobile-sync/stations")
                .header("Authorization", "Bearer " + config.token())
                .header("X-Mobile-Agent", BuildConfig.SOURCE_AGENT)
                .header("Idempotency-Key", record.idempotencyKey)
                .header("User-Agent", userAgent())
                .post(RequestBody.create(record.payloadJson, JSON))
                .build();
        try (Response response = http.newCall(request).execute()) {
            String body = response.body() == null ? "" : response.body().string();
            if (response.isSuccessful()) {
                boolean duplicate = false;
                try {
                    JSONObject root = new JSONObject(body);
                    JSONObject data = root.optJSONObject("data");
                    duplicate = data != null && data.optBoolean("duplicate", false);
                } catch (Exception ignored) {
                }
                return new UploadResult(true, duplicate, response.code(), body);
            }
            return new UploadResult(false, false, response.code(), body);
        }
    }

    public boolean health(SecureConfigStore.Config config) throws IOException {
        Request request = new Request.Builder()
                .url(config.rootUrl() + "/health")
                .header("User-Agent", userAgent())
                .get()
                .build();
        try (Response response = http.newCall(request).execute()) {
            return response.isSuccessful();
        }
    }

    private static String userAgent() {
        return "EnergyPrice/" + BuildConfig.VERSION_NAME + " Android";
    }

    public static final class UploadResult {
        private final boolean success;
        private final boolean duplicate;
        private final int statusCode;
        private final String responseBody;
        public UploadResult(boolean success, boolean duplicate, int statusCode, String responseBody) {
            this.success = success;
            this.duplicate = duplicate;
            this.statusCode = statusCode;
            this.responseBody = responseBody;
        }
        public boolean success() { return success; }
        public boolean duplicate() { return duplicate; }
        public int statusCode() { return statusCode; }
        public String responseBody() { return responseBody; }
    }
}
