package com.datafordidi.mobilecollector;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * OCR 诊断快照。
 *
 * <p>只保存计数、枚举原因和限长价格/枪数证据；不保存整屏 OCR 文本、截图路径、endpoint 或 token。
 */
final class OcrDiagnostics {

    private static final int MAX_EVIDENCE = 8;
    private static final int MAX_REASONS = 8;

    final int rowCount;
    final String platform;
    final String stationType;
    final int stationCount;
    final List<String> rejectionReasons;
    final List<JSONObject> priceEvidence;

    private OcrDiagnostics(Builder builder) {
        this.rowCount = builder.rowCount;
        this.platform = builder.platform;
        this.stationType = builder.stationType;
        this.stationCount = builder.stationCount;
        this.rejectionReasons = new ArrayList<>(builder.rejectionReasons);
        this.priceEvidence = new ArrayList<>(builder.priceEvidence);
    }

    String toShortLog() {
        StringBuilder output = new StringBuilder();
        output.append("ocr-diagnostics rows=").append(rowCount)
                .append(" platform=").append(platform == null ? "" : platform)
                .append(" type=").append(stationType == null ? "" : stationType)
                .append(" stations=").append(stationCount);
        if (!rejectionReasons.isEmpty()) {
            output.append(" reasons=");
            for (int index = 0; index < rejectionReasons.size(); index++) {
                if (index > 0) output.append(",");
                output.append(rejectionReasons.get(index));
            }
        }
        output.append(" evidence=").append(priceEvidence.size());
        return output.toString();
    }

    JSONObject toJson() {
        JSONObject output = new JSONObject();
        put(output, "rowCount", rowCount);
        put(output, "platform", platform);
        put(output, "stationType", stationType);
        put(output, "stationCount", stationCount);
        JSONArray reasons = new JSONArray();
        for (String reason : rejectionReasons) reasons.put(reason);
        put(output, "rejectionReasons", reasons);
        JSONArray evidence = new JSONArray();
        for (JSONObject item : priceEvidence) evidence.put(item);
        put(output, "priceEvidence", evidence);
        return output;
    }

    static final class Builder {
        private int rowCount;
        private String platform;
        private String stationType;
        private int stationCount;
        private final List<String> rejectionReasons = new ArrayList<>();
        private final List<JSONObject> priceEvidence = new ArrayList<>();

        Builder rowCount(int value) {
            this.rowCount = value;
            return this;
        }

        Builder platform(String value) {
            this.platform = value;
            return this;
        }

        Builder stationType(String value) {
            this.stationType = value;
            return this;
        }

        Builder stationCount(int value) {
            this.stationCount = value;
            return this;
        }

        Builder addRejectionReason(String reason) {
            if (reason == null || reason.isEmpty()) return this;
            if (rejectionReasons.size() < MAX_REASONS && !rejectionReasons.contains(reason)) {
                rejectionReasons.add(reason);
            }
            return this;
        }

        Builder addPriceEvidence(JSONObject evidence) {
            if (evidence == null) return this;
            if (priceEvidence.size() < MAX_EVIDENCE) {
                JSONObject safe = AddressFreePayload.copyObject(evidence);
                if (!AddressFreePayload.containsSensitiveKey(safe)) {
                    priceEvidence.add(sanitizeEvidence(safe));
                }
            }
            return this;
        }

        OcrDiagnostics build() {
            return new OcrDiagnostics(this);
        }
    }

    private static JSONObject sanitizeEvidence(JSONObject source) {
        JSONObject output = new JSONObject();
        String[] allowed = {"kind", "x", "y", "width", "height", "gradeCode", "priceRole"};
        for (String key : allowed) {
            if (source.has(key)) put(output, key, source.opt(key));
        }
        String text = source.optString("text", "");
        if (!text.isEmpty()) {
            // 只保留与价格/油号相关的短文本片段，过滤地址类长文本。
            String normalized = text.replaceAll("\\s+", "");
            if (normalized.length() > 24) normalized = normalized.substring(0, 24);
            put(output, "text", normalized);
        }
        return output;
    }

    private static void put(JSONObject target, String key, Object value) {
        try {
            target.put(key, value);
        } catch (Exception error) {
            throw new IllegalStateException("无法序列化 OCR 诊断字段", error);
        }
    }
}
