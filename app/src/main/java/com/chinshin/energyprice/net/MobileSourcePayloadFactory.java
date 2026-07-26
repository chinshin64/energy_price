package com.chinshin.energyprice.net;

import android.content.Context;

import com.chinshin.energyprice.BuildConfig;
import com.chinshin.energyprice.capture.FuelCapture;
import com.chinshin.energyprice.capture.FuelStationParser;
import com.chinshin.energyprice.data.CaptureRecord;
import com.chinshin.energyprice.data.DeviceIdentity;

import org.json.JSONArray;
import org.json.JSONObject;

import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.UUID;

public final class MobileSourcePayloadFactory {
    private MobileSourcePayloadFactory() {}

    public static CaptureRecord createRecord(Context context, FuelCapture capture) throws Exception {
        if (!capture.isCompleteForSubmission()) {
            throw new IllegalArgumentException("capture is incomplete");
        }

        String deviceId = DeviceIdentity.deviceId(context);
        String sessionId = "energy-price-session-" + UUID.randomUUID();
        int pageIndex = DeviceIdentity.nextPageIndex(context);
        String capturedAt = isoTime(capture.capturedAtEpochMs);
        String stationId = "amap:" + normalizeStationKey(capture.stationName);
        String screenHash = capture.screenHash == null
                ? FuelStationParser.sha256(capture.rawText == null ? capture.stableIdentity() : capture.rawText)
                : capture.screenHash;
        String idempotencyMaterial = BuildConfig.SOURCE_AGENT + ":" + deviceId + ":" + sessionId + ":" + pageIndex + ":" + screenHash;
        String idempotencyKey = FuelStationParser.sha256(idempotencyMaterial);
        String gradeSource = capture.gradeExplicit ? "ocr-explicit" : "display-price-ranking";

        JSONObject quality = new JSONObject()
                .put("status", "valid")
                .put("needsReview", false)
                .put("missingFields", new JSONArray());

        JSONObject stationObservation = new JSONObject()
                .put("stationId", stationId)
                .put("sourceStationKey", stationId)
                .put("stationName", capture.stationName)
                .put("capturedAt", capturedAt)
                .put("quality", quality);

        JSONObject rawOffer = new JSONObject()
                .put("amountYuan", 200)
                .put("discountAmount", capture.discountAmount)
                .put("serviceFee", capture.serviceFee)
                .put("gradeSource", gradeSource)
                .put("screenHash", screenHash);
        if (capture.discountPerLiter != null) rawOffer.put("discountPerLiter", capture.discountPerLiter);
        if (capture.payableAmount != null) rawOffer.put("payableAmount", capture.payableAmount);

        JSONObject offer = new JSONObject()
                .put("fuelType", "gasoline")
                .put("gradeCode", capture.gradeCode)
                .put("gradeLabel", capture.gradeLabel)
                .put("stationPrice", capture.resolvedStationPrice())
                .put("displayPrice", capture.resolvedDisplayPrice())
                .put("listPrice", capture.resolvedListPrice())
                .put("raw", rawOffer);

        JSONObject fuelRaw = new JSONObject()
                .put("amountYuan", 200)
                .put("discountAmount", capture.discountAmount)
                .put("serviceFee", capture.serviceFee)
                .put("gradeSource", gradeSource)
                .put("screenHash", screenHash);
        if (capture.payableAmount != null) fuelRaw.put("payableAmount", capture.payableAmount);
        if (capture.rawText != null) fuelRaw.put("ocrText", limit(capture.rawText, 12000));

        JSONObject fuelObservation = new JSONObject()
                .put("stationId", stationId)
                .put("sourceStationKey", stationId)
                .put("stationName", capture.stationName)
                .put("capturedAt", capturedAt)
                .put("providerName", capture.providerName)
                .put("providerEvidence", new JSONObject()
                        .put("source", "amap-payment-page")
                        .put("text", capture.providerEvidenceText))
                .put("fuelOffers", new JSONArray().put(offer))
                .put("fuelQuotes", new JSONArray())
                .put("raw", fuelRaw);

        JSONObject observation = new JSONObject()
                .put("schemaVersion", 3)
                .put("stationType", "fuel")
                .put("stationObservation", stationObservation)
                .put("fuelObservation", fuelObservation);

        JSONObject payload = new JSONObject()
                .put("clientVersion", "energy-price-ocr-" + BuildConfig.VERSION_NAME)
                .put("sourceAgent", BuildConfig.SOURCE_AGENT)
                .put("sourceStage", BuildConfig.SOURCE_STAGE)
                .put("platform", BuildConfig.PLATFORM)
                .put("deviceId", deviceId)
                .put("deviceSessionId", "energy-price-device-" + deviceId)
                .put("appPackage", BuildConfig.APPLICATION_ID)
                .put("sessionId", sessionId)
                .put("pageIndex", pageIndex)
                .put("capturedAt", capturedAt)
                .put("schemaVersion", 3)
                .put("stationType", "fuel")
                .put("feature", "fuel-quote-v1")
                .put("observations", new JSONArray().put(observation));

        CaptureRecord record = new CaptureRecord();
        record.stationName = capture.stationName;
        record.gradeCode = capture.gradeCode;
        record.amountYuan = 200;
        record.stationPrice = capture.resolvedStationPrice();
        record.displayPrice = capture.resolvedDisplayPrice();
        record.listPrice = capture.resolvedListPrice();
        record.discountAmount = capture.discountAmount;
        record.serviceFee = capture.serviceFee;
        record.payableAmount = capture.payableAmount;
        record.providerName = capture.providerName;
        record.capturedAt = capture.capturedAtEpochMs;
        record.stableIdentity = capture.stableIdentity();
        record.idempotencyKey = idempotencyKey;
        record.payloadJson = payload.toString();
        return record;
    }

    static String isoTime(long epochMs) {
        return OffsetDateTime.ofInstant(Instant.ofEpochMilli(epochMs), ZoneId.systemDefault())
                .format(DateTimeFormatter.ISO_OFFSET_DATE_TIME);
    }

    private static String normalizeStationKey(String stationName) {
        return stationName.trim().replaceAll("\\s+", " ");
    }

    private static String limit(String value, int max) {
        return value.length() <= max ? value : value.substring(0, max);
    }
}
