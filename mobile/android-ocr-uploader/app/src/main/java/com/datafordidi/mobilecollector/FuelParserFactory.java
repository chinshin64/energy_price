package com.datafordidi.mobilecollector;

import java.util.Locale;

/**
 * 燃油解析器工厂。
 */
final class FuelParserFactory {

    private FuelParserFactory() {
    }

    static FuelCardParser create(String platform) {
        String normalized = normalize(platform);
        if ("tuanyou".equals(normalized)) return new TuanyouFuelParser();
        if ("amap-fuel".equals(normalized)) return new AmapFuelParser();
        return new GenericFuelParser();
    }

    private static String normalize(String platform) {
        if (platform == null) return "";
        String value = platform.replaceAll("[-_]", "").toLowerCase(Locale.ROOT);
        if (value.contains("tuanyou")) return "tuanyou";
        if (value.contains("amap") && value.contains("fuel")) return "amap-fuel";
        if (value.contains("amap")) return "amap-fuel";
        return platform.toLowerCase(Locale.ROOT);
    }
}
