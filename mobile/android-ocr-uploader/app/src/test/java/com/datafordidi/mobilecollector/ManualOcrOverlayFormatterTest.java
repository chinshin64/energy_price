package com.datafordidi.mobilecollector;

import org.junit.Test;

import java.math.BigDecimal;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

public class ManualOcrOverlayFormatterTest {

    @Test
    public void platformLabelMapsEverySelectableChannel() {
        assertEquals("高德加油", ManualOcrOverlayFormatter.platformLabel("amap-fuel"));
        assertEquals("团油", ManualOcrOverlayFormatter.platformLabel("tuanyou"));
        assertEquals("滴滴充电", ManualOcrOverlayFormatter.platformLabel("didi-charging"));
        assertEquals("高德充电", ManualOcrOverlayFormatter.platformLabel("amap-charging"));
        assertEquals("特来电", ManualOcrOverlayFormatter.platformLabel("teld-charging"));
        assertEquals("云快充", ManualOcrOverlayFormatter.platformLabel("ykc-charging"));
        assertEquals("新电途", ManualOcrOverlayFormatter.platformLabel("xdt-charging"));
        assertEquals("自动识别", ManualOcrOverlayFormatter.platformLabel("unknown"));
    }

    @Test
    public void statusBodyDoesNotRepeatTheOverlayTitle() {
        assertEquals("准备识别", ManualOcrOverlayFormatter.statusBody(null));
        assertEquals("已缓存\n等待支付页",
                ManualOcrOverlayFormatter.statusBody("OCR · 已缓存\n等待支付页"));
        assertEquals("未识别到场站字段",
                ManualOcrOverlayFormatter.statusBody("OCR\n未识别到场站字段"));
        assertEquals("92# 已识别", ManualOcrOverlayFormatter.statusBody("92# 已识别"));
    }

    @Test
    public void pendingPaymentFieldsAreVisibleWithoutCreatingAFormalGrade() {
        AmapFuelSessionReconciler.PendingPreview preview =
                new AmapFuelSessionReconciler.PendingPreview(
                        "浙江石油塘河供能加油站",
                        new BigDecimal("7.19"),
                        new BigDecimal("5.41"),
                        new BigDecimal("0.87"),
                        new BigDecimal("195.46"),
                        "团油"
                );

        String status = ManualOcrOverlayFormatter.pending(preview);

        assertTrue(status.contains("已缓存"));
        assertTrue(status.contains("外显7.19"));
        assertTrue(status.contains("优5.41"));
        assertTrue(status.contains("费0.87"));
        assertTrue(status.contains("实付195.46"));
        assertTrue(status.contains("待第二档"));
    }

    @Test
    public void guidedMissingReportsOnlyMissingFields() {
        AmapFuelSessionReconciler.PendingPreview preview =
                new AmapFuelSessionReconciler.PendingPreview(
                        "浙江石油塘河供能加油站",
                        new BigDecimal("7.66"),
                        new BigDecimal("5.09"),
                        new BigDecimal("0.81"),
                        new BigDecimal("195.72"),
                        null
                );

        assertEquals("缺：CP", ManualOcrOverlayFormatter.guidedMissing(preview));
    }
}
