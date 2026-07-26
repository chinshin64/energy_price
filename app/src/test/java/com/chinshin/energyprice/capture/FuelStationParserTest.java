package com.chinshin.energyprice.capture;

import org.junit.Test;

import java.util.List;

import static org.junit.Assert.*;

public class FuelStationParserTest {
    @Test
    public void parsesAmap92DetailFromVideoShape() {
        FuelCapture capture = FuelStationParser.parse(List.of(
                "浙江石油塘河供能加油站",
                "本店可享高德优惠加油·加油后立减",
                "__SELECTED__ 92#",
                "7.19",
                "200元省5.41",
                "油站价#7.39/L"
        ), 1L);
        assertEquals("浙江石油塘河供能加油站", capture.stationName);
        assertEquals("92", capture.gradeCode);
        assertEquals(Integer.valueOf(200), capture.amountYuan);
        assertEquals(7.19, capture.displayPrice, 0.001);
        assertEquals(7.39, capture.stationPrice, 0.001);
        assertEquals(5.41, capture.discountAmount, 0.001);
    }

    @Test
    public void parsesPaymentBreakdownAndCleansProviderNoise() {
        FuelCapture capture = FuelStationParser.parse(List.of(
                "浙江石油塘河供能加油站",
                "¥200",
                "立减优惠 -¥5.41",
                "服务费 +¥0.87",
                "实付金额 ¥195.46",
                "本次由服务商团油提供O"
        ), 2L);
        assertTrue(capture.paymentPage);
        assertEquals(5.41, capture.discountAmount, 0.001);
        assertEquals(0.87, capture.serviceFee, 0.001);
        assertEquals(195.46, capture.payableAmount, 0.001);
        assertEquals("团油", capture.providerName);
        assertEquals("本次由服务商团油提供O", capture.providerEvidenceText);
    }

    @Test
    public void parsesGradeDiscountAndFallsBackToOnlyGrade() {
        FuelCapture capture = FuelStationParser.parse(List.of(
                "双龙加油站",
                "95#优惠¥0.59/L",
                "7.01元/L",
                "¥200"
        ), 3L);
        assertEquals("95", capture.gradeCode);
        assertEquals(0.59, capture.discountPerLiter, 0.001);
        assertEquals(7.01, capture.displayPrice, 0.001);
    }

    @Test
    public void rejectsCouponDescriptionAsStationTitle() {
        FuelCapture capture = FuelStationParser.parse(List.of(
                "15天有效|优惠油站可用",
                "中化道达尔杭州留祥路加油站刚刚浏览",
                "__SELECTED__ 95#"
        ), 4L);
        assertEquals("中化道达尔杭州留祥路加油站", capture.stationName);
    }

    @Test
    public void providerIsNotCapturedOutsidePaymentPage() {
        FuelCapture capture = FuelStationParser.parse(List.of(
                "中化道达尔杭州留祥路加油站",
                "普通详情页",
                "滴滴加油"
        ), 5L);
        assertFalse(capture.paymentPage);
        assertNull(capture.providerName);
    }

    @Test
    public void normalizesRepeatedCharacterProviderOcrError() {
        FuelCapture capture = FuelStationParser.parse(List.of(
                "立碱优惠 -#16.00",
                "服务费 +#2.56",
                "本次由服务商滴加油提供"
        ), 6L);
        assertTrue(capture.paymentPage);
        assertEquals(16.00, capture.discountAmount, 0.001);
        assertEquals(2.56, capture.serviceFee, 0.001);
        assertEquals("滴滴加油", capture.providerName);
    }

    @Test
    public void incompleteCaptureNeverSubstitutesDisplayPriceForStationPrice() {
        FuelCapture capture = new FuelCapture();
        capture.stationName = "测试加油站";
        capture.gradeCode = "92";
        capture.amountYuan = 200;
        capture.displayPrice = 7.19;
        capture.discountAmount = 5.41;
        capture.serviceFee = 0.87;
        capture.providerName = "团油";
        capture.providerEvidenceText = "本次由服务商团油提供";
        capture.paymentPage = true;
        assertNull(capture.resolvedStationPrice());
        assertFalse(capture.isCompleteForSubmission());
    }
}
