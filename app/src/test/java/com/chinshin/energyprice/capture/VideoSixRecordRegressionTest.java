package com.chinshin.energyprice.capture;

import org.junit.Test;

import java.util.HashSet;
import java.util.List;
import java.util.Set;

import static org.junit.Assert.*;

/** Regression baseline transcribed from Screenrecorder-2026-07-25-23-53-03-188.mp4. */
public class VideoSixRecordRegressionTest {
    @Test
    public void videoBaselineProducesExactlySixCompleteFuelRecords() {
        List<FuelCapture> captures = List.of(
                capture("浙江石油塘河供能加油站", "92", 7.39, 7.19, 5.41, 0.87, 195.46, "团油"),
                capture("浙江石油塘河供能加油站", "95", 7.86, 7.66, 5.09, 0.81, 195.72, "团油"),
                capture("双龙加油站", "92", 7.39, 7.01, 10.28, 1.64, 191.36, "易加油"),
                capture("双龙加油站", "95", 7.86, 7.46, 10.17, 1.63, 191.46, "易加油"),
                capture("中化道达尔杭州留祥路加油站", "92", 7.39, 6.80, 16.00, 2.56, 186.56, "滴加油"),
                capture("中化道达尔杭州留祥路加油站", "95", 7.86, 7.24, 16.00, 2.56, 186.56, "滴加油")
        );

        Set<String> identities = new HashSet<>();
        for (FuelCapture capture : captures) {
            assertTrue(capture.stableIdentity(), capture.isCompleteForSubmission());
            identities.add(capture.stableIdentity());
        }
        assertEquals(6, identities.size());
        assertEquals("滴滴加油", captures.get(4).providerName);
        assertEquals("滴滴加油", captures.get(5).providerName);
    }

    private static FuelCapture capture(
            String station,
            String grade,
            double stationPrice,
            double displayPrice,
            double discount,
            double serviceFee,
            double payable,
            String providerOcr
    ) {
        FuelCapture detail = FuelStationParser.parse(List.of(
                station + "刚刚浏览",
                "92#",
                "95#",
                "__SELECTED__ " + grade + "#",
                String.format(java.util.Locale.US, "%.2f", displayPrice),
                String.format(java.util.Locale.US, "200元约省#%.2f", discount),
                String.format(java.util.Locale.US, "油站价#%.2f/L", stationPrice)
        ), 100L);

        FuelCapture payment = FuelStationParser.parse(List.of(
                "#200",
                String.format(java.util.Locale.US, "立碱优惠 -#%.2f", discount),
                String.format(java.util.Locale.US, "服务费 +#%.2f", serviceFee),
                String.format(java.util.Locale.US, "实付金额 #%.2f", payable),
                "本次由服务商" + providerOcr + "提供O"
        ), 200L);

        FuelCapture merged = detail.merge(payment);
        assertEquals(station, merged.stationName);
        assertEquals(grade, merged.gradeCode);
        assertEquals(200, merged.amountYuan.intValue());
        assertEquals(stationPrice, merged.stationPrice, 0.001);
        assertEquals(displayPrice, merged.displayPrice, 0.001);
        assertEquals(discount, merged.discountAmount, 0.001);
        assertEquals(serviceFee, merged.serviceFee, 0.001);
        assertEquals(payable, merged.payableAmount, 0.001);
        return merged;
    }
}
