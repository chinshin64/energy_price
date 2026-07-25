package com.chinshin.energyprice.ui;

import com.chinshin.energyprice.data.CaptureRecord;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

public final class StationDisplayFormatter {
    private static final SimpleDateFormat TIME = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.CHINA);

    private StationDisplayFormatter() {}

    public static String priceLine(CaptureRecord r) {
        return String.format(Locale.CHINA, "加 200 元  油站价 ¥%.2f/L  优惠价 ¥%.2f/L",
                r.stationPrice, r.displayPrice);
    }

    public static String discountLine(CaptureRecord r) {
        String payable = r.payableAmount == null ? "" : String.format(Locale.CHINA, "  实付 ¥%.2f", r.payableAmount);
        return String.format(Locale.CHINA, "优惠 ¥%.2f  服务费 ¥%.2f%s",
                r.discountAmount, r.serviceFee, payable);
    }

    public static String providerLine(CaptureRecord r) {
        return "CP：" + r.providerName;
    }

    public static String timeLine(CaptureRecord r) {
        return TIME.format(new Date(r.capturedAt));
    }
}
