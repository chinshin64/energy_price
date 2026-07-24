package com.datafordidi.mobilecollector;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

final class GeometryPriceRecovery {
    private static final Pattern LOST_DECIMAL_WITH_UNIT = Pattern.compile(
            "(?<!\\d)(\\d{4,5})[,，]?(?:元)?/?(?:度|千瓦时|kWh)",
            Pattern.CASE_INSENSITIVE
    );
    private static final Pattern FOUR_DECIMAL = Pattern.compile(
            "(?<![\\d.])([0-3]\\.\\d{4})[,，]?(?!\\d)"
    );

    private GeometryPriceRecovery() {
    }

    static EnergyPriceParser.Match recover(String text, OcrRow row, OcrRow title) {
        if (!isListPriceZone(row, title)) return null;
        String value = compact(text);
        String prefix = value.length() > 18 ? value.substring(0, 18) : value;

        Matcher lostDecimal = LOST_DECIMAL_WITH_UNIT.matcher(prefix);
        if (lostDecimal.find()) {
            if (memberOrDiscount(prefix.substring(0, lostDecimal.start()))) return null;
            String digits = lostDecimal.group(1);
            double price = integer(digits) / 10_000d;
            if (valid(price)) {
                return new EnergyPriceParser.Match(
                        price,
                        lostDecimal.group(),
                        "recovered-decimal-unit",
                        "fast"
                );
            }
        }

        Matcher decimal = FOUR_DECIMAL.matcher(prefix);
        if (decimal.find()) {
            if (memberOrDiscount(prefix.substring(0, decimal.start()))) return null;
            double price = decimal(decimal.group(1));
            if (valid(price)) {
                return new EnergyPriceParser.Match(
                        price,
                        decimal.group(),
                        "geometry-four-decimal",
                        "fast"
                );
            }
        }
        return null;
    }

    private static boolean isListPriceZone(OcrRow row, OcrRow title) {
        if (row == null || title == null) return false;
        float vertical = row.y - title.y;
        return row.x < 0.38f && vertical >= 0.07f && vertical <= 0.20f;
    }

    private static boolean memberOrDiscount(String text) {
        return text.contains("黑钻") || text.contains("黑的") || text.contains("会员")
                || text.contains("优惠") || text.contains("折扣") || text.contains("券后");
    }

    private static boolean valid(double value) {
        return value >= 0.2d && value <= 3.5d;
    }

    private static int integer(String value) {
        try {
            return Integer.parseInt(value);
        } catch (Exception ignored) {
            return -1;
        }
    }

    private static double decimal(String value) {
        try {
            return Double.parseDouble(value);
        } catch (Exception ignored) {
            return -1d;
        }
    }

    private static String compact(String value) {
        return value == null ? "" : value.replaceAll("\\s+", "").trim();
    }
}
