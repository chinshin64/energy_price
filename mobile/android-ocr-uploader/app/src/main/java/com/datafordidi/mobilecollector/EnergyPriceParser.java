package com.datafordidi.mobilecollector;

import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

final class EnergyPriceParser {
    private static final String NUMBER = "(\\d+(?:\\.\\d{1,4})?)";
    private static final String ENERGY_UNIT = "(?:度|千瓦时|kWh)";
    private static final Pattern PRICE = Pattern.compile(
            "[¥￥]\\s*" + NUMBER + "\\s*(?:元)?\\s*(?:起)?\\s*(?:/\\s*" + ENERGY_UNIT + ")?"
                    + "|(?<![\\d.])" + NUMBER + "\\s*元\\s*(?:起)?\\s*(?:/\\s*" + ENERGY_UNIT + ")?"
                    + "|(?<![\\d.])" + NUMBER + "\\s*/\\s*" + ENERGY_UNIT
                    + "|(?<![\\d.])" + NUMBER + "\\s*(?:元)?\\s*[,，]?\\s*/?\\s*" + ENERGY_UNIT,
            Pattern.CASE_INSENSITIVE
    );
    private static final Pattern RAW_CANDIDATE = Pattern.compile(
            "[¥￥YyVv]?\\s*\\d+(?:\\.\\d{1,4})?\\s*(?:元|度|千瓦时|kWh)?",
            Pattern.CASE_INSENSITIVE
    );

    private EnergyPriceParser() {
    }

    static Match first(String input) {
        String text = compact(input);
        Matcher matcher = PRICE.matcher(text);
        Match best = null;
        int bestScore = Integer.MIN_VALUE;
        while (matcher.find()) {
            String number = firstNonNull(matcher.group(1), matcher.group(2), matcher.group(3), matcher.group(4));
            double value = decimal(number);
            if (value < 0.2d || value > 3.5d) continue;
            String before = text.substring(Math.max(0, matcher.start() - 20), matcher.start());
            String after = text.substring(matcher.end(), Math.min(text.length(), matcher.end() + 20));
            String context = before + matcher.group() + after;
            boolean displayTotal = containsDisplayTotal(before, context);
            if (excluded(context, before, displayTotal)) continue;
            int score = score(before, displayTotal);
            if (score <= bestScore) continue;
            String type = before.contains("超") || after.contains("超") ? "super"
                    : before.contains("慢") || after.contains("慢") ? "slow"
                    : displayTotal ? "total" : "fast";
            best = new Match(value, snippet(matcher.group()), format(matcher.group()), type);
            bestScore = score;
        }
        return best;
    }

    static int rawCandidateCount(String input) {
        String text = compact(input);
        Matcher matcher = RAW_CANDIDATE.matcher(text);
        int count = 0;
        while (matcher.find()) {
            String value = matcher.group();
            if (value.matches(".*(?:[¥￥YyVv]|\\.|元|度|千瓦时|(?i:kWh)).*")) count++;
        }
        return count;
    }

    private static boolean excluded(String context, String before, boolean displayTotal) {
        String value = compact(context);
        String prefix = compact(before);
        if (prefix.matches(".*(黑钻|黑的|会员|优惠价|折后价|券后价|折扣价)[：:]?$")
                || prefix.matches(".*(黑钻|黑的|会员|优惠).{0,4}$")) return true;
        if (value.contains("停车费") || value.contains("停车收费")) return true;
        if (value.contains("订单金额") || value.contains("订单总额")
                || value.contains("应付金额") || value.contains("实付金额")) return true;
        if (value.contains("/小时") || value.contains("元每小时") || value.contains("元/时")
                || value.contains("元/人") || value.contains("元每人") || value.contains("分钟")) return true;
        return value.contains("服务费") && !displayTotal;
    }

    private static boolean containsDisplayTotal(String before, String context) {
        return before.matches(".*(含服务费|总价|合计)[：:]?$")
                || context.contains("含服务费") || context.contains("总价") || context.contains("合计");
    }

    private static int score(String before, boolean displayTotal) {
        if (before.matches(".*(总价|合计)[：:]?$")) return 100;
        if (before.matches(".*含服务费[：:]?$")) return 90;
        return displayTotal ? 60 : 70;
    }

    private static String format(String raw) {
        String value = compact(raw).toLowerCase(Locale.ROOT);
        boolean currency = value.startsWith("¥") || value.startsWith("￥");
        boolean starting = value.contains("元起") || value.endsWith("起");
        boolean perEnergy = value.contains("度") || value.contains("千瓦时") || value.contains("kwh");
        if (currency && starting) return "currency-yuan-start";
        if (perEnergy) return "per-energy";
        if (currency) return "currency";
        if (starting) return "yuan-start";
        return "yuan";
    }

    private static String snippet(String raw) {
        String value = compact(raw);
        return value.length() <= 32 ? value : value.substring(0, 32);
    }

    private static String compact(String value) {
        return value == null ? "" : value.replace('／', '/').replaceAll("\\s+", "").trim();
    }

    private static String firstNonNull(String... values) {
        for (String value : values) if (value != null) return value;
        return "";
    }

    private static double decimal(String value) {
        try {
            return Double.parseDouble(value);
        } catch (Exception ignored) {
            return -1d;
        }
    }

    static final class Match {
        final double value;
        final String snippet;
        final String format;
        final String type;

        Match(double value, String snippet, String format, String type) {
            this.value = value;
            this.snippet = snippet;
            this.format = format;
            this.type = type;
        }
    }
}
