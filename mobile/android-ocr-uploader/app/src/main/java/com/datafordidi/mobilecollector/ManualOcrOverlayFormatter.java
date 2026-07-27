package com.datafordidi.mobilecollector;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.List;

/**
 * Formats compact, user-visible OCR state for the floating control.
 */
final class ManualOcrOverlayFormatter {
    private static final int MAX_NAME_LENGTH = 13;

    private ManualOcrOverlayFormatter() {
    }

    static String platformLabel(String platform) {
        if (platform == null) return "自动识别";
        switch (platform.trim()) {
            case "amap-fuel":
                return "高德加油";
            case "tuanyou":
                return "团油";
            case "didi-charging":
                return "滴滴充电";
            case "amap-charging":
                return "高德充电";
            case "teld-charging":
                return "特来电";
            case "ykc-charging":
                return "云快充";
            case "xdt-charging":
                return "新电途";
            default:
                return "自动识别";
        }
    }

    static String statusBody(String status) {
        String value = status == null ? "" : status.trim();
        if (value.isEmpty()) return "准备识别";
        if (value.startsWith("OCR · ")) return value.substring("OCR · ".length()).trim();
        if (value.startsWith("OCR\n")) return value.substring("OCR\n".length()).trim();
        return value;
    }

    static String pending(AmapFuelSessionReconciler.PendingPreview preview) {
        if (preview == null) return "OCR\n未识别到场站字段";
        StringBuilder value = new StringBuilder("OCR · 已缓存\n");
        value.append(shortName(preview.stationName));
        if (preview.providerName != null && !preview.providerName.trim().isEmpty()) {
            value.append(" · ").append(shortName(preview.providerName));
        }
        value.append('\n');
        appendMoney(value, "外显", preview.displayPrice);
        appendMoney(value, " 优", preview.grossDiscount);
        appendMoney(value, " 费", preview.serviceFee);
        value.append('\n');
        appendMoney(value, "实付", preview.payableAmount);
        value.append(" · 待第二档");
        return value.toString();
    }

    static String guidedMissing(AmapFuelSessionReconciler.PendingPreview preview) {
        if (preview == null) {
            return "缺：站名/外显价/优惠/服务费/实付/CP";
        }
        List<String> missing = new ArrayList<>();
        if (preview.stationName == null || preview.stationName.trim().isEmpty()) {
            missing.add("站名");
        }
        if (preview.displayPrice == null) {
            missing.add("外显价");
        }
        if (preview.grossDiscount == null) {
            missing.add("优惠");
        }
        if (preview.serviceFee == null) {
            missing.add("服务费");
        }
        if (preview.payableAmount == null) {
            missing.add("实付");
        }
        if (preview.providerName == null || preview.providerName.trim().isEmpty()) {
            missing.add("CP");
        }
        return missing.isEmpty()
                ? "字段校验未通过"
                : "缺：" + String.join("/", missing);
    }

    static boolean hasPairedAmapGrades(ScreenContextResolver.ParsedScreen parsed) {
        if (parsed == null || !"amap-fuel".equals(parsed.platform)) return false;
        for (FuelStationRecord station : parsed.fuelStations) {
            if (station != null
                    && station.offerForGrade("92") != null
                    && station.offerForGrade("95") != null) {
                return true;
            }
        }
        return false;
    }

    private static void appendMoney(StringBuilder target, String label, BigDecimal amount) {
        if (amount == null) return;
        target.append(label).append(amount.stripTrailingZeros().toPlainString());
    }

    private static String shortName(String value) {
        String text = value == null ? "" : value.trim();
        return text.length() <= MAX_NAME_LENGTH
                ? text
                : text.substring(0, MAX_NAME_LENGTH) + "…";
    }
}
