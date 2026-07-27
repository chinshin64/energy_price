package com.datafordidi.mobilecollector;

import java.text.Normalizer;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 同一采集会话内的燃油站名 OCR 容错匹配。
 *
 * <p>只容忍少量增删改字符；数字序列冲突、短名称或差异过大时拒绝归并。
 */
final class FuelStationNameMatcher {
    private static final Pattern DIGITS = Pattern.compile("\\d+");
    private static final Pattern FUEL_SUFFIX = Pattern.compile(
            "(?:加油站|能源站|油站|加油)$"
    );

    private FuelStationNameMatcher() {
    }

    static boolean sameStation(String left, String right) {
        String normalizedLeft = normalize(left);
        String normalizedRight = normalize(right);
        if (normalizedLeft.isEmpty() || normalizedRight.isEmpty()) return false;
        if (normalizedLeft.equals(normalizedRight)) return true;
        if (!digitGroups(normalizedLeft).equals(digitGroups(normalizedRight))) return false;

        String leftCore = core(normalizedLeft);
        String rightCore = core(normalizedRight);
        int maxLength = Math.max(leftCore.length(), rightCore.length());
        int minLength = Math.min(leftCore.length(), rightCore.length());
        if (minLength < 5) return false;

        int allowedDistance = maxLength >= 15 ? 3 : maxLength >= 8 ? 2 : 1;
        if (Math.abs(leftCore.length() - rightCore.length()) > allowedDistance) return false;
        int distance = editDistance(leftCore, rightCore, allowedDistance);
        return distance <= allowedDistance
                && 1d - (double) distance / maxLength >= 0.74d;
    }

    static String normalize(String value) {
        String normalized = Normalizer.normalize(
                value == null ? "" : value,
                Normalizer.Form.NFKC
        );
        String compact = normalized
                .replaceAll("\\s+", "")
                .replaceAll("[（）()【】\\[\\]·•,，.。:：;；'\"“”‘’/\\\\\\-—_]", "")
                .toLowerCase(Locale.ROOT)
                .trim();
        compact = compact.replaceFirst("^在(?=.{5,}(?:加油站|能源站|油站))", "");
        return compact.replaceFirst("(?:附近搜(?:索)?|附近搜索)$", "");
    }

    private static String core(String value) {
        String stripped = FUEL_SUFFIX.matcher(value).replaceFirst("");
        return stripped.length() >= 5 ? stripped : value;
    }

    private static List<String> digitGroups(String value) {
        List<String> groups = new ArrayList<>();
        Matcher matcher = DIGITS.matcher(value);
        while (matcher.find()) groups.add(matcher.group());
        return groups;
    }

    private static int editDistance(String left, String right, int limit) {
        int[] previous = new int[right.length() + 1];
        int[] current = new int[right.length() + 1];
        for (int column = 0; column <= right.length(); column++) previous[column] = column;
        for (int row = 1; row <= left.length(); row++) {
            current[0] = row;
            int rowMinimum = current[0];
            for (int column = 1; column <= right.length(); column++) {
                int substitution = previous[column - 1]
                        + (left.charAt(row - 1) == right.charAt(column - 1) ? 0 : 1);
                current[column] = Math.min(
                        Math.min(previous[column] + 1, current[column - 1] + 1),
                        substitution
                );
                rowMinimum = Math.min(rowMinimum, current[column]);
            }
            if (rowMinimum > limit) return limit + 1;
            int[] swap = previous;
            previous = current;
            current = swap;
        }
        return previous[right.length()];
    }
}
