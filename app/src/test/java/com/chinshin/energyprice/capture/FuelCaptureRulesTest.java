package com.chinshin.energyprice.capture;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class FuelCaptureRulesTest {
    @Test
    public void derivesServiceFeeFromGrossDiscountAndPayable() {
        FuelCapture capture = new FuelCapture();
        capture.rawText = "浙江石油塘河供能加油站\n¥7.66/L 加200省¥5.09\n本次油服务商团油提供\n¥195.72 含服务费";
        capture.discountAmount = null;
        capture.payableAmount = null;

        FuelCaptureRules.preparePayment(capture);

        assertEquals(200, capture.amountYuan.intValue());
        assertEquals(7.66, capture.displayPrice, 0.001);
        assertEquals(5.09, capture.discountAmount, 0.001);
        assertEquals(195.72, capture.payableAmount, 0.001);
        assertEquals(0.81, capture.serviceFee, 0.001);
        assertTrue(FuelCaptureRules.paymentMathIsConsistent(capture));
    }

    @Test
    public void parsesNetDiscountForCrossCheck() {
        assertEquals(4.28, FuelCaptureRules.parseNetDiscount("比油站价优惠¥4.28"), 0.001);
    }

    @Test
    public void detailGradeRowsAreNotTreatedAsSelectedGrade() {
        FuelCapture capture = new FuelCapture();
        capture.rawText = "92#优惠¥0.20/L\n95#优惠¥0.20/L";
        capture.gradeCode = "92";
        capture.gradeLabel = "92号汽油";
        capture.gradeExplicit = true;

        FuelCaptureRules.prepareDetail(capture);

        assertNull(capture.gradeCode);
        assertFalse(capture.gradeExplicit);
    }

    @Test
    public void visualSelectedMarkerRemainsAuthoritative() {
        FuelCapture capture = new FuelCapture();
        capture.rawText = "92#优惠¥0.20/L\n95#优惠¥0.20/L\n__SELECTED__ 95#";

        FuelCaptureRules.prepareDetail(capture);

        assertEquals("95", capture.gradeCode);
        assertTrue(capture.gradeExplicit);
    }
}
