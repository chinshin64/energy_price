package com.chinshin.energyprice.capture;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONObject;

public final class CaptureSessionState {
    private static final String PREFS = "capture_session_state";
    private static final long MAX_AGE_MS = 20 * 60 * 1000L;
    private final SharedPreferences prefs;
    private String currentStation;
    private String lastGrade;

    public CaptureSessionState(Context context) {
        prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        currentStation = prefs.getString("current_station", null);
        lastGrade = prefs.getString("last_grade", null);
    }

    public synchronized FuelCapture merge(FuelCapture partial) {
        if (partial == null) return null;
        if (notBlank(partial.stationName) && notBlank(currentStation) && !partial.stationName.equals(currentStation)) {
            clearAll();
        }
        if (notBlank(partial.stationName)) {
            currentStation = partial.stationName;
            prefs.edit().putString("current_station", currentStation).apply();
        } else if (notBlank(currentStation)) {
            partial.stationName = currentStation;
        }

        String grade;
        if (partial.paymentPage && !partial.gradeExplicit && notBlank(lastGrade)) grade = lastGrade;
        else grade = notBlank(partial.gradeCode) ? partial.gradeCode : lastGrade;
        if (!notBlank(grade)) return partial;
        partial.gradeCode = grade;
        partial.gradeLabel = grade + "号汽油";
        lastGrade = grade;
        prefs.edit().putString("last_grade", grade).apply();

        FuelCapture previous = read(grade);
        FuelCapture merged = previous == null ? partial.copy() : previous.merge(partial);
        if (!notBlank(merged.stationName)) merged.stationName = currentStation;
        write(grade, merged);
        return merged;
    }

    public synchronized boolean shouldSave(FuelCapture capture, long now) {
        String identity = capture.stableIdentity();
        String previous = prefs.getString("last_saved_identity", null);
        long previousAt = prefs.getLong("last_saved_at", 0L);
        return previous == null || !previous.equals(identity) || now - previousAt > 90_000L;
    }

    public synchronized void markSaved(FuelCapture capture, long now) {
        prefs.edit()
                .putString("last_saved_identity", capture.stableIdentity())
                .putLong("last_saved_at", now)
                .remove("capture_" + capture.gradeCode)
                .apply();
    }

    private FuelCapture read(String grade) {
        String raw = prefs.getString("capture_" + grade, null);
        if (raw == null) return null;
        try {
            JSONObject o = new JSONObject(raw);
            long capturedAt = o.optLong("capturedAtEpochMs", 0L);
            if (capturedAt <= 0 || System.currentTimeMillis() - capturedAt > MAX_AGE_MS) {
                prefs.edit().remove("capture_" + grade).apply();
                return null;
            }
            FuelCapture c = new FuelCapture();
            c.stationName = optString(o, "stationName");
            c.gradeCode = optString(o, "gradeCode");
            c.gradeLabel = optString(o, "gradeLabel");
            c.gradeExplicit = o.optBoolean("gradeExplicit", false);
            c.amountYuan = o.has("amountYuan") ? o.getInt("amountYuan") : null;
            c.stationPrice = optDouble(o, "stationPrice");
            c.displayPrice = optDouble(o, "displayPrice");
            c.listPrice = optDouble(o, "listPrice");
            c.discountAmount = optDouble(o, "discountAmount");
            c.discountPerLiter = optDouble(o, "discountPerLiter");
            c.serviceFee = optDouble(o, "serviceFee");
            c.payableAmount = optDouble(o, "payableAmount");
            c.providerName = optString(o, "providerName");
            c.providerEvidenceText = optString(o, "providerEvidenceText");
            c.rawText = optString(o, "rawText");
            c.screenHash = optString(o, "screenHash");
            c.paymentPage = o.optBoolean("paymentPage", false);
            c.capturedAtEpochMs = capturedAt;
            return c;
        } catch (Exception e) {
            prefs.edit().remove("capture_" + grade).apply();
            return null;
        }
    }

    private void write(String grade, FuelCapture c) {
        try {
            JSONObject o = new JSONObject();
            put(o, "stationName", c.stationName);
            put(o, "gradeCode", c.gradeCode);
            put(o, "gradeLabel", c.gradeLabel);
            o.put("gradeExplicit", c.gradeExplicit);
            put(o, "amountYuan", c.amountYuan);
            put(o, "stationPrice", c.stationPrice);
            put(o, "displayPrice", c.displayPrice);
            put(o, "listPrice", c.listPrice);
            put(o, "discountAmount", c.discountAmount);
            put(o, "discountPerLiter", c.discountPerLiter);
            put(o, "serviceFee", c.serviceFee);
            put(o, "payableAmount", c.payableAmount);
            put(o, "providerName", c.providerName);
            put(o, "providerEvidenceText", c.providerEvidenceText);
            put(o, "rawText", c.rawText);
            put(o, "screenHash", c.screenHash);
            o.put("paymentPage", c.paymentPage);
            o.put("capturedAtEpochMs", c.capturedAtEpochMs);
            prefs.edit().putString("capture_" + grade, o.toString()).apply();
        } catch (Exception ignored) {
        }
    }

    private void clearAll() {
        currentStation = null;
        lastGrade = null;
        prefs.edit().remove("current_station").remove("last_grade")
                .remove("capture_92").remove("capture_95").apply();
    }

    private static void put(JSONObject o, String key, Object value) throws Exception {
        if (value != null) o.put(key, value);
    }

    private static String optString(JSONObject o, String key) {
        String value = o.optString(key, null);
        return value == null || value.isEmpty() ? null : value;
    }

    private static Double optDouble(JSONObject o, String key) {
        return o.has(key) && !o.isNull(key) ? o.optDouble(key) : null;
    }

    private static boolean notBlank(String value) {
        return value != null && !value.trim().isEmpty();
    }
}
