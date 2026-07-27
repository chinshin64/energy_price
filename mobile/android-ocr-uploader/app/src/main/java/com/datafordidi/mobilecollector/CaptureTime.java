package com.datafordidi.mobilecollector;

import org.json.JSONObject;

import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeFormatterBuilder;
import java.time.format.DateTimeParseException;
import java.time.temporal.ChronoUnit;

final class CaptureTime {
    private static final DateTimeFormatter DISPLAY = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss");
    private static final DateTimeFormatter UTC_MILLIS = new DateTimeFormatterBuilder()
            .appendInstant(3)
            .toFormatter();

    private CaptureTime() {
    }

    static String nowUtc() {
        return formatUtcMillis(Instant.now());
    }

    static String requireUtc(String value) {
        String text = value == null ? "" : value.trim();
        if (text.isEmpty()) throw new IllegalArgumentException("缺少截取时间");
        try {
            return formatUtcMillis(Instant.parse(text));
        } catch (DateTimeParseException error) {
            throw new IllegalArgumentException("截取时间无效", error);
        }
    }

    private static String formatUtcMillis(Instant instant) {
        return UTC_MILLIS.format(instant.truncatedTo(ChronoUnit.MILLIS));
    }

    static DisplayValue display(JSONObject row, ZoneId zoneId) {
        Instant captured = parse(value(row, "capturedAt"));
        if (captured != null) return new DisplayValue(format(captured, zoneId), false);
        Instant collected = parse(value(row, "collectedAt"));
        if (collected != null) return new DisplayValue(format(collected, zoneId), true);
        Instant snapshot = parse(value(row, "snapshotAt"));
        if (snapshot != null) return new DisplayValue(format(snapshot, zoneId), true);
        return new DisplayValue("未知", true);
    }

    static Long capturedAtEpochMillis(JSONObject row) {
        Instant captured = parse(value(row, "capturedAt"));
        return captured == null ? null : captured.toEpochMilli();
    }

    private static Object value(JSONObject row, String key) {
        return row == null ? null : row.opt(key);
    }

    private static Instant parse(Object value) {
        if (value instanceof Number) {
            long epoch = ((Number) value).longValue();
            if (epoch > 0 && epoch < 10_000_000_000L) epoch *= 1000L;
            try {
                return epoch > 0 ? Instant.ofEpochMilli(epoch) : null;
            } catch (RuntimeException ignored) {
                return null;
            }
        }
        String text = value == null || value == JSONObject.NULL ? "" : String.valueOf(value).trim();
        if (text.isEmpty()) return null;
        try {
            return Instant.parse(text);
        } catch (DateTimeParseException ignored) {
            return null;
        }
    }

    private static String format(Instant instant, ZoneId zoneId) {
        return DISPLAY.withZone(zoneId == null ? ZoneId.systemDefault() : zoneId).format(instant);
    }

    static final class DisplayValue {
        final String text;
        final boolean legacy;

        DisplayValue(String text, boolean legacy) {
            this.text = text;
            this.legacy = legacy;
        }

        String label() {
            return "截取时间：" + text + (legacy ? "（历史）" : "");
        }
    }
}
