package com.datafordidi.mobilecollector;

import java.util.Arrays;
import java.util.List;

/**
 * Removes map-search shell text and performs tightly bounded brand correction.
 */
final class FuelStationNameNormalizer {
    private static final List<String> KNOWN_SHORT_BRANDS = Arrays.asList(
            "壳牌",
            "中石油",
            "中石化",
            "中国石油",
            "中国石化",
            "浙江石油",
            "中海油",
            "中化道达尔"
    );

    private FuelStationNameNormalizer() {
    }

    static String normalize(String value) {
        String output = value == null ? "" : value.replaceAll("\\s+", " ").trim();
        output = output.replaceFirst("^[^\\u4e00-\\u9fa5A-Za-z0-9（(]+", "").trim();
        output = output.replaceFirst("[.。·•…]+$", "").trim();
        output = stripSearchShell(output);
        output = output.replaceFirst("^[|｜丨\\\\/·•\\-—_]+", "").trim();
        output = output.replaceFirst("[|｜丨\\\\/·•\\-—_.。…]+$", "").trim();
        output = closeSearchShellParenthesis(output);
        output = normalizeShortBrand(output);
        output = output.replaceFirst("供加油站$", "供能加油站");
        return output;
    }

    static boolean hasSearchShellNoise(String value) {
        String output = value == null ? "" : value.replaceAll("\\s+", "").trim();
        int nearby = output.lastIndexOf("附近");
        if (nearby < 1) return false;
        String stationPart = output.substring(0, nearby);
        String suffix = output.substring(nearby + "附近".length())
                .replaceAll("[^\\u4e00-\\u9fa5A-Za-z]", "");
        return looksLikeStationCore(stationPart)
                && (stationPart.startsWith("在") || suffix.length() <= 6);
    }

    private static String stripSearchShell(String value) {
        String output = value == null ? "" : value.trim();
        int nearby = output.lastIndexOf("附近");
        if (nearby < 1) return output;
        String stationPart = output.substring(0, nearby).trim();
        String suffix = output.substring(nearby + "附近".length())
                .replaceAll("[^\\u4e00-\\u9fa5A-Za-z]", "");
        if (!looksLikeStationCore(stationPart) || suffix.length() > 6) return output;
        boolean contextualPrefix = stationPart.startsWith("在");
        boolean searchAction = suffix.isEmpty()
                || suffix.matches(".*[搜索素查找].*");
        if (!contextualPrefix && !searchAction) return output;
        return contextualPrefix ? stationPart.substring(1).trim() : stationPart;
    }

    private static boolean looksLikeStationCore(String value) {
        String output = value == null ? "" : value.trim();
        return output.contains("加油站")
                || output.contains("油站")
                || output.contains("石油")
                || output.contains("石化");
    }

    private static String closeSearchShellParenthesis(String value) {
        String output = value == null ? "" : value.trim();
        int asciiOpen = count(output, '(');
        int asciiClose = count(output, ')');
        int chineseOpen = count(output, '（');
        int chineseClose = count(output, '）');
        if (asciiOpen == asciiClose + 1) return output + ")";
        if (chineseOpen == chineseClose + 1) return output + "）";
        return output;
    }

    private static String normalizeShortBrand(String value) {
        String output = value == null ? "" : value.trim();
        int stationIndex = output.indexOf("加油站");
        if (stationIndex < 0) stationIndex = output.indexOf("油站");
        if (stationIndex < 2) return output;
        String observed = output.substring(0, stationIndex);
        String match = "";
        int matches = 0;
        for (String brand : KNOWN_SHORT_BRANDS) {
            if (observed.length() != brand.length()) continue;
            int distance = editDistance(observed, brand);
            if (distance == 0) return output;
            if (distance == 1) {
                match = brand;
                matches++;
            }
        }
        return matches == 1 ? match + output.substring(stationIndex) : output;
    }

    private static int editDistance(String left, String right) {
        int[] previous = new int[right.length() + 1];
        for (int index = 0; index <= right.length(); index++) previous[index] = index;
        for (int leftIndex = 1; leftIndex <= left.length(); leftIndex++) {
            int[] current = new int[right.length() + 1];
            current[0] = leftIndex;
            for (int rightIndex = 1; rightIndex <= right.length(); rightIndex++) {
                int replace = previous[rightIndex - 1]
                        + (left.charAt(leftIndex - 1) == right.charAt(rightIndex - 1) ? 0 : 1);
                current[rightIndex] = Math.min(
                        Math.min(previous[rightIndex] + 1, current[rightIndex - 1] + 1),
                        replace
                );
            }
            previous = current;
        }
        return previous[right.length()];
    }

    private static int count(String value, char expected) {
        int count = 0;
        for (int index = 0; index < value.length(); index++) {
            if (value.charAt(index) == expected) count++;
        }
        return count;
    }
}
