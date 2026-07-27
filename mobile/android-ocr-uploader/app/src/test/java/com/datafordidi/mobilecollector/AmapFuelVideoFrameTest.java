package com.datafordidi.mobilecollector;

import org.junit.Test;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;

/**
 * 基于 ~/Downloads/apk.mp4 视频 OCR 帧的回归测试。
 */
public class AmapFuelVideoFrameTest {

    private static final String CAPTURED_AT = "2026-07-26T13:31:00+08:00";

    private static OcrRow row(String text, float x, float y) {
        return new OcrRow(text, 0.99f, x, y, 0.20f, 0.03f);
    }

    /**
     * 浙江石油塘河供能加油站：金额选择页（¥200 档被选中）。
     * 外显价 7.19，油站价/国标价 7.39，92# 选 ¥200，立减 5.41，服务费 0.87。
     */
    @Test
    public void zhejiangPetrolAmountSelectionPage200() {
        List<OcrRow> rows = new ArrayList<>();
        rows.add(row("浙江石油塘河供能加油站", 0.10f, 0.08f));
        rows.add(row("¥7.19 /L", 0.10f, 0.15f));
        rows.add(row("加200省¥5.41", 0.25f, 0.15f));
        rows.add(row("油站价¥7.39/L", 0.65f, 0.15f));
        rows.add(row("国标价¥7.39/L", 0.65f, 0.19f));
        rows.add(row("选择油枪/油号 请与加油员确认枪号", 0.10f, 0.25f));
        rows.add(row("92#", 0.10f, 0.30f));
        rows.add(row("95#", 0.25f, 0.30f));
        rows.add(row("0#柴油", 0.40f, 0.30f));
        rows.add(row("¥100", 0.10f, 0.50f));
        rows.add(row("¥200", 0.40f, 0.50f));
        rows.add(row("¥300", 0.70f, 0.50f));
        rows.add(row("立减¥2.71", 0.10f, 0.55f));
        rows.add(row("立减5.41", 0.40f, 0.55f));
        rows.add(row("立减8.12", 0.70f, 0.55f));
        rows.add(row("立减优惠", 0.10f, 0.65f));
        rows.add(row("-¥5.41", 0.55f, 0.65f));
        rows.add(row("服务费", 0.10f, 0.72f));
        rows.add(row("+¥0.87", 0.55f, 0.72f));
        rows.add(row("立即支付", 0.75f, 0.90f));

        List<FuelQuote> quotes = FuelQuoteParser.extract(rows, CAPTURED_AT, null);
        assertEquals(1, quotes.size());
        FuelQuote quote = quotes.get(0);
        assertEquals("92", quote.gradeCode);
        assertEquals(new BigDecimal("200.00"), quote.selectedAmount);
        assertEquals(new BigDecimal("5.41"), quote.grossDiscount);
        assertEquals(new BigDecimal("0.87"), quote.serviceFee);
        assertEquals("inline", quote.quoteEntry);
    }

    /**
     * 浙江石油塘河供能加油站：确认/支付详情页（frame_012）。
     * 实际支付金额 195.46，应付金额 200.00，立减 5.41，服务费 0.87，92#。
     */
    @Test
    public void zhejiangPetrolPaymentConfirmationPage() {
        List<OcrRow> rows = new ArrayList<>();
        rows.add(row("浙江石油塘河供能加油站", 0.10f, 0.05f));
        rows.add(row("92#", 0.10f, 0.12f));
        rows.add(row("¥195.46", 0.10f, 0.18f));
        rows.add(row("未支付", 0.10f, 0.23f));
        rows.add(row("应付金额", 0.10f, 0.32f));
        rows.add(row("¥200.00", 0.70f, 0.32f));
        rows.add(row("立减优惠", 0.10f, 0.40f));
        rows.add(row("¥5.41", 0.70f, 0.40f));
        rows.add(row("服务费", 0.10f, 0.48f));
        rows.add(row("¥0.87", 0.70f, 0.48f));
        rows.add(row("实际支付金额=应付金额-优惠金额+服务费+其他", 0.10f, 0.58f));
        rows.add(row("第三方服务商有能链、小桔和易加油等", 0.10f, 0.75f));

        List<FuelStationRecord> stations = FuelStationParser.extract(rows, "amap-fuel", "screen-ocr-user-driven");
        assertEquals(1, stations.size());
        FuelStationRecord station = stations.get(0);
        assertEquals(1, station.fuelQuotes.size());
        FuelQuote quote = station.fuelQuotes.get(0);
        assertEquals(new BigDecimal("200.00"), quote.selectedAmount);
        assertEquals(new BigDecimal("195.46"), quote.payableAmount);
        assertEquals(new BigDecimal("0.87"), quote.serviceFee);
        // 确认页没有显式油号，应标记为需要复核或从上下文缺失；这里允许为空或至少金额对。
        assertNotNull(quote.selectedAmount);
    }

    /**
     * 双龙加油站：金额选择页（95#，¥200 档）。
     * 外显价 7.46，油站价/国标价 7.86，95# 选 ¥200，立减 10.17，服务费 0.87。
     */
    @Test
    public void shuanglongAmountSelectionPage95And200() {
        List<OcrRow> rows = new ArrayList<>();
        rows.add(row("双龙加油站", 0.10f, 0.08f));
        rows.add(row("¥7.46 /L", 0.10f, 0.15f));
        rows.add(row("加200省¥10.17", 0.25f, 0.15f));
        rows.add(row("油站价¥7.86/L", 0.65f, 0.15f));
        rows.add(row("国标价¥7.86/L", 0.65f, 0.19f));
        rows.add(row("选择油枪/油号 请与加油员确认枪号", 0.10f, 0.25f));
        rows.add(row("95#", 0.25f, 0.30f));
        rows.add(row("¥100", 0.10f, 0.50f));
        rows.add(row("¥200", 0.40f, 0.50f));
        rows.add(row("¥300", 0.70f, 0.50f));
        rows.add(row("立减¥5.08", 0.10f, 0.55f));
        rows.add(row("立减¥10.17", 0.40f, 0.55f));
        rows.add(row("立减¥15.26", 0.70f, 0.55f));
        rows.add(row("立减优惠", 0.10f, 0.65f));
        rows.add(row("-#10.17", 0.55f, 0.65f));
        rows.add(row("服务费", 0.10f, 0.72f));
        rows.add(row("+¥0.87", 0.55f, 0.72f));
        rows.add(row("立即支付", 0.75f, 0.90f));

        List<FuelStationRecord> stations = FuelStationParser.extract(rows, "amap-fuel", "screen-ocr-user-driven");
        assertEquals(1, stations.size());
        FuelStationRecord station = stations.get(0);
        assertEquals(1, station.fuelOffers.size());
        assertEquals(1, station.fuelQuotes.size());
        FuelQuote quote = station.fuelQuotes.get(0);
        assertEquals("95", quote.gradeCode);
        assertEquals(new BigDecimal("200.00"), quote.selectedAmount);
        assertEquals(new BigDecimal("10.17"), quote.grossDiscount);
        assertEquals(new BigDecimal("0.87"), quote.serviceFee);
    }

    /**
     * 与 ~/Downloads/2.jpg 一致的支付确认页：无油号，只有实际支付金额/应付/立减/服务费。
     */
    @Test
    public void paymentConfirmationPageFromImage2() {
        List<OcrRow> rows = new ArrayList<>();
        rows.add(row("¥195.72", 0.10f, 0.08f));
        rows.add(row("实际支付金额", 0.10f, 0.13f));
        rows.add(row("应付金额", 0.10f, 0.22f));
        rows.add(row("¥200.00", 0.70f, 0.22f));
        rows.add(row("立减优惠", 0.10f, 0.30f));
        rows.add(row("¥5.09", 0.70f, 0.30f));
        rows.add(row("服务费", 0.10f, 0.38f));
        rows.add(row("¥0.81", 0.70f, 0.38f));
        rows.add(row("实际支付金额=应付金额-优惠金额+服务费+其他商品费用", 0.10f, 0.48f));
        rows.add(row("现高德加油第三方服务商有能链、小桔和易加油等", 0.10f, 0.65f));

        List<FuelQuote> quotes = FuelQuoteParser.extract(rows, CAPTURED_AT, null);
        assertEquals(1, quotes.size());
        FuelQuote quote = quotes.get(0);
        assertEquals(new BigDecimal("200.00"), quote.selectedAmount);
        assertEquals(new BigDecimal("195.72"), quote.payableAmount);
        assertEquals(new BigDecimal("5.09"), quote.grossDiscount);
        assertEquals(new BigDecimal("0.81"), quote.serviceFee);
    }

    @Test
    public void paymentResultPageFromImage2() {
        List<OcrRow> rows = new ArrayList<>();
        rows.add(row("浙江石油塘河供能加油站", 0.10f, 0.08f));
        rows.add(row("¥7.66/L 加200省¥5.09", 0.10f, 0.15f));
        rows.add(row("加油", 0.10f, 0.22f));
        rows.add(row("满200减12", 0.10f, 0.30f));
        rows.add(row("满30减3", 0.60f, 0.30f));
        rows.add(row("为爱车添加保障", 0.10f, 0.38f));
        rows.add(row("500万油品保障", 0.10f, 0.50f));
        rows.add(row("送200-8加油券x1张", 0.10f, 0.55f));
        rows.add(row("¥1/份", 0.10f, 0.60f));
        rows.add(row("开发票", 0.10f, 0.70f));
        rows.add(row("油费 | 油站开票 当场索取", 0.10f, 0.75f));
        rows.add(row("¥195.72", 0.10f, 0.85f));
        rows.add(row("比油站价优惠¥4.28", 0.10f, 0.90f));

        List<FuelStationRecord> stations = FuelStationParser.extract(rows, "amap-fuel", "screen-ocr-user-driven");
        assertEquals(1, stations.size());
        FuelStationRecord station = stations.get(0);
        assertEquals("浙江石油塘河供能加油站", station.stationName);
        assertEquals(1, station.fuelQuotes.size());
        FuelQuote quote = station.fuelQuotes.get(0);
        assertEquals(new BigDecimal("200.00"), quote.selectedAmount);
        assertEquals(new BigDecimal("5.09"), quote.grossDiscount);
        assertEquals(new BigDecimal("4.28"), quote.netDiscount);
        assertEquals(new BigDecimal("0.81"), quote.serviceFee);
        assertEquals(new BigDecimal("195.72"), quote.payableAmount);
    }
}
