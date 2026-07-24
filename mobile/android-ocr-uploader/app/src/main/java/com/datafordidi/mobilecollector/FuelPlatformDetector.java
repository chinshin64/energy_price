package com.datafordidi.mobilecollector;

import java.util.List;
import java.util.Locale;

final class FuelPlatformDetector {
    private static final String TUANYOU_PACKAGE = "com.czb.chezhubang";
    private static final String AMAP_PACKAGE = "com.autonavi.minimap";

    private FuelPlatformDetector() {
    }

    static String detect(List<OcrRow> rows, String packageName) {
        String packageValue = compact(packageName).toLowerCase(Locale.ROOT);
        String text = join(rows);
        int evidence = fuelEvidence(text);
        if (evidence >= 2 && chargingEvidence(text) >= 2) return "";
        boolean tuanyouPackage = TUANYOU_PACKAGE.equals(packageValue);
        boolean amapPackage = AMAP_PACKAGE.equals(packageValue);
        boolean tuanyouBrand = text.contains("团油") || text.contains("车主邦");
        boolean amapBrand = text.contains("高德地图") || text.contains("高德加油")
                || text.contains("高德优惠加油");
        boolean fuelPage = evidence >= 2 || (tuanyouBrand && evidence >= 1);
        if (tuanyouPackage && fuelPage) return "tuanyou";
        if ((amapPackage && evidence >= 2) || (amapBrand && evidence >= 2)) return "amap-fuel";
        if (evidence >= 3) {
            String seed = packageValue.isEmpty() ? "unknown" : packageValue;
            return "generic-fuel-" + DeviceIdentity.sha256(seed).substring(0, 12);
        }
        return "";
    }

    static int fuelEvidence(String text) {
        String value = compact(text);
        int signals = 0;
        if (value.matches(".*(?:^|[^0-9])(?:90|92|95|98|101|0|-10)[#＃].*")) signals++;
        if (value.contains("元/L") || value.contains("元/升") || value.contains("¥/L") || value.contains("￥/L")) {
            signals++;
        }
        if (value.contains("油站价") || value.contains("国标价") || value.contains("挂牌价")) signals++;
        if (value.contains("团油价") || value.contains("高德价") || value.contains("外显价")
                || value.contains("折后价") || value.contains("优惠价")) signals++;
        if (value.contains("柴油") || value.contains("汽油")) signals++;
        return signals;
    }

    static int chargingEvidence(String text) {
        String value = compact(text);
        int signals = 0;
        if (value.contains("充电站") || value.contains("充电桩")
                || value.contains("充电中心") || value.contains("超充站")) {
            signals++;
        }
        if (value.contains("快充") || value.contains("慢充") || value.contains("超充")) signals++;
        if (value.contains("枪空闲") || value.contains("空闲枪")
                || value.contains("可用枪") || value.contains("总枪")) {
            signals++;
        }
        if (value.contains("元/度") || value.contains("元／度") || value.contains("度电")) signals++;
        return signals;
    }

    static boolean isConflict(List<OcrRow> rows) {
        String text = join(rows);
        return fuelEvidence(text) >= 2 && chargingEvidence(text) >= 2;
    }

    private static String join(List<OcrRow> rows) {
        StringBuilder output = new StringBuilder();
        if (rows != null) for (OcrRow row : rows) output.append(row.text).append(' ');
        return output.toString();
    }

    private static String compact(String value) {
        return value == null ? "" : value.replaceAll("\\s+", "").trim();
    }
}
