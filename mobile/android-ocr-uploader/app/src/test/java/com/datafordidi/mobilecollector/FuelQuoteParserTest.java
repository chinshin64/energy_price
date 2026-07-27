package com.datafordidi.mobilecollector;

import static org.junit.Assert.assertNull;

import org.junit.Test;

import java.math.BigDecimal;
import java.util.Arrays;
import java.util.ArrayList;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

/**
 * 燃油报价页解析测试。
 */
public class FuelQuoteParserTest {

    private static final String CAPTURED_AT = "2026-07-26T08:00:00+08:00";

    @Test
    public void amapQuotePageWithLijianAndServiceFee() {
        List<OcrRow> rows = new ArrayList<>();
        rows.add(row("中化道达尔杭州留祥路加油站", 0.10f, 0.20f));
        rows.add(row("92#汽油", 0.10f, 0.30f));
        rows.add(row("加油金额", 0.10f, 0.45f));
        rows.add(row("200", 0.40f, 0.45f));
        rows.add(row("立减优惠", 0.10f, 0.52f));
        rows.add(row("-20.65", 0.40f, 0.52f));
        rows.add(row("服务费", 0.10f, 0.59f));
        rows.add(row("3.30", 0.40f, 0.59f));
        rows.add(row("预计实付", 0.10f, 0.66f));
        rows.add(row("182.65", 0.40f, 0.66f));

        List<FuelQuote> quotes = FuelQuoteParser.extract(rows, CAPTURED_AT, null);
        assertEquals(1, quotes.size());
        FuelQuote quote = quotes.get(0);
        assertEquals("92", quote.gradeCode);
        assertEquals(new BigDecimal("200.00"), quote.selectedAmount);
        assertEquals(new BigDecimal("20.65"), quote.grossDiscount);
        assertEquals(new BigDecimal("3.30"), quote.serviceFee);
        assertEquals(new BigDecimal("182.65"), quote.payableAmount);
        assertEquals("inline", quote.quoteEntry);
    }

    @Test
    public void amapQuoteFallbackWhenStationParserReturnsEmpty() {
        List<OcrRow> rows = new ArrayList<>();
        rows.add(row("中化道达尔杭州留祥路加油站", 0.10f, 0.12f));
        rows.add(row("95#汽油", 0.10f, 0.30f));
        rows.add(row("加油金额", 0.10f, 0.45f));
        rows.add(row("200", 0.40f, 0.45f));
        rows.add(row("优惠", 0.10f, 0.52f));
        rows.add(row("15.00", 0.40f, 0.52f));
        rows.add(row("服务费", 0.10f, 0.59f));
        rows.add(row("2.50", 0.40f, 0.59f));

        List<FuelStationRecord> stations = FuelStationParser.extract(rows, "amap-fuel", "screen-ocr-user-driven");
        assertEquals(1, stations.size());
        FuelStationRecord station = stations.get(0);
        assertEquals("中化道达尔杭州留祥路加油站", station.stationName);
        assertEquals(1, station.fuelQuotes.size());
        FuelQuote quote = station.fuelQuotes.get(0);
        assertEquals("95", quote.gradeCode);
        assertEquals(new BigDecimal("200.00"), quote.selectedAmount);
        assertEquals(new BigDecimal("15.00"), quote.grossDiscount);
        assertEquals(new BigDecimal("2.50"), quote.serviceFee);
    }

    @Test
    public void amapQuotePopupEntryRecognized() {
        List<OcrRow> rows = new ArrayList<>();
        rows.add(row("优惠说明", 0.10f, 0.20f));
        rows.add(row("关闭", 0.80f, 0.20f));
        rows.add(row("98#汽油", 0.10f, 0.35f));
        rows.add(row("加油金额", 0.10f, 0.43f));
        rows.add(row("200", 0.40f, 0.43f));
        rows.add(row("优惠金额", 0.10f, 0.50f));
        rows.add(row("8.00", 0.40f, 0.50f));
        rows.add(row("服务费", 0.10f, 0.57f));
        rows.add(row("1.50", 0.40f, 0.57f));
        rows.add(row("预计实付", 0.10f, 0.64f));
        rows.add(row("192.50", 0.40f, 0.64f));

        List<FuelQuote> quotes = FuelQuoteParser.extract(rows, CAPTURED_AT, null);
        assertEquals(1, quotes.size());
        assertEquals("explanation_popup", quotes.get(0).quoteEntry);
    }

    @Test
    public void amapQuoteFromSaveOnAmountButton() {
        List<OcrRow> rows = new ArrayList<>();
        rows.add(row("中化道达尔杭州留祥路加油站", 0.10f, 0.10f));
        rows.add(row("95#", 0.10f, 0.15f));
        rows.add(row("¥7.24 /L 加200省¥16.00", 0.10f, 0.18f));
        rows.add(row("立减优惠", 0.10f, 0.46f));
        rows.add(row("-¥16.00", 0.40f, 0.46f));
        rows.add(row("服务费", 0.10f, 0.53f));
        rows.add(row("+¥2.56", 0.40f, 0.53f));
        rows.add(row("预计实付", 0.10f, 0.60f));
        rows.add(row("¥186.56", 0.40f, 0.60f));

        List<FuelQuote> quotes = FuelQuoteParser.extract(rows, CAPTURED_AT, null);
        assertEquals(1, quotes.size());
        FuelQuote quote = quotes.get(0);
        // 不再从金额按钮推断 200，selectedAmount 从加200省/预计实付/应付金额推导。
        assertEquals(new BigDecimal("200.00"), quote.selectedAmount);
        assertEquals(new BigDecimal("16.00"), quote.grossDiscount);
        assertEquals(new BigDecimal("2.56"), quote.serviceFee);
        assertEquals(new BigDecimal("186.56"), quote.payableAmount);
    }

    @Test
    public void amapPaymentPageDerivesServiceFeeWithoutServiceFeeLabel() {
        List<OcrRow> rows = new ArrayList<>();
        rows.add(row("浙江石油塘河供能加油站", 0.04f, 0.10f));
        rows.add(row("¥7.66/L 加200省¥5.09", 0.04f, 0.16f));
        rows.add(row("比油站价优惠¥4.28", 0.04f, 0.76f));
        rows.add(row("本次油服务商团油提供", 0.18f, 0.83f));
        rows.add(row("¥195.72", 0.04f, 0.94f));

        List<FuelQuote> quotes = FuelQuoteParser.extract(rows, CAPTURED_AT, null);
        assertEquals(1, quotes.size());
        FuelQuote quote = quotes.get(0);
        assertTrue(quote.gradeInferred);
        assertEquals(new BigDecimal("200.00"), quote.selectedAmount);
        assertEquals(new BigDecimal("5.09"), quote.grossDiscount);
        assertEquals(new BigDecimal("0.81"), quote.serviceFee);
        assertEquals(new BigDecimal("4.28"), quote.netDiscount);
        assertEquals(new BigDecimal("195.72"), quote.payableAmount);
        assertTrue(quote.needsReview);
    }

    @Test
    public void amap66PaymentPageDerivesServiceFeeFromGrossAndNetDiscount() {
        List<OcrRow> rows = Arrays.asList(
                row("中海联石油城西加油站", .05f, .11f),
                row("¥7.08/L加200省¥19.85", .05f, .15f),
                row("购超值神券包", .05f, .24f),
                row("¥3.5", .78f, .24f),
                row("12元×2张", .16f, .34f),
                row("满200减12", .12f, .39f),
                row("3元", .62f, .34f),
                row("满30减3", .58f, .39f),
                row("500万油品保障7天", .45f, .66f),
                row("¥1/份", .20f, .72f),
                row("本次由服务商中能兴和提供", .22f, .86f),
                row("¥183.33含服务费", .05f, .94f),
                row("比油站价优惠¥16.67", .05f, .97f)
        );

        assert66Quote(FuelQuoteParser.extract(rows, CAPTURED_AT, null));
    }

    @Test
    public void amap66SplitOcrRowsStillDeriveServiceFeeAndPayable() {
        List<OcrRow> rows = Arrays.asList(
                row("中海联石油城西加油站", .05f, .11f),
                row("¥7.08/L", .05f, .15f),
                row("加200", .24f, .15f),
                row("省¥19.85", .38f, .15f),
                row("购超值神券包", .05f, .24f),
                row("¥3.5", .78f, .24f),
                row("12元", .16f, .34f),
                row("×2张", .30f, .34f),
                row("3元", .62f, .34f),
                row("500万油品保障7天", .45f, .66f),
                row("¥1/份", .20f, .72f),
                row("本次由服务商", .22f, .86f),
                row("中能兴和提供", .48f, .86f),
                row("¥183.33", .05f, .94f),
                row("含服务费", .24f, .94f),
                row("比油站价优惠", .05f, .97f),
                row("¥16.67", .34f, .97f)
        );

        assert66Quote(FuelQuoteParser.extract(rows, CAPTURED_AT, null));
    }

    @Test
    public void payableFooterContainingServiceFeeSupportsFormulaFallback() {
        List<OcrRow> rows = Arrays.asList(
                row("中海联石油城西加油站", .05f, .11f),
                row("¥7.08/L加200省¥19.85", .05f, .15f),
                row("¥183.33含服务费", .05f, .94f)
        );

        List<FuelQuote> quotes = FuelQuoteParser.extract(rows, CAPTURED_AT, null);

        assertEquals(1, quotes.size());
        FuelQuote quote = quotes.get(0);
        assertEquals(new BigDecimal("200.00"), quote.selectedAmount);
        assertEquals(new BigDecimal("19.85"), quote.grossDiscount);
        assertEquals(new BigDecimal("3.18"), quote.serviceFee);
        assertEquals(new BigDecimal("16.67"), quote.netDiscount);
        assertEquals(new BigDecimal("183.33"), quote.payableAmount);
    }

    @Test
    public void croppedGalleryFooterDoesNotTurnSelectedAmountIntoPayable() {
        List<OcrRow> rows = croppedGalleryRows();

        List<FuelQuote> quotes = FuelQuoteParser.extract(rows, CAPTURED_AT, null);

        assertEquals(1, quotes.size());
        FuelQuote quote = quotes.get(0);
        assertEquals(new BigDecimal("200.00"), quote.selectedAmount);
        assertEquals(new BigDecimal("19.85"), quote.grossDiscount);
        assertNull(quote.serviceFee);
        assertNull(quote.netDiscount);
        assertNull(quote.payableAmount);
        assertTrue(quote.needsReview);
    }

    @Test
    public void splitColorSegmentsAndCouponPricesStillResolveTheBottomPayableAmount() {
        List<OcrRow> rows = new ArrayList<>();
        rows.add(row("浙江石油塘河供能加油站", 0.04f, 0.10f));
        rows.add(row("¥7.19/L", 0.04f, 0.16f));
        rows.add(row("加200", 0.20f, 0.16f));
        rows.add(row("省¥5.41", 0.32f, 0.16f));
        rows.add(row("立减优惠", 0.04f, 0.26f));
        rows.add(row("-¥5.41", 0.72f, 0.26f));
        rows.add(row("服务费", 0.04f, 0.32f));
        rows.add(row("+¥0.87", 0.72f, 0.32f));
        rows.add(row("¥3.5", 0.78f, 0.40f));
        rows.add(row("¥1/份", 0.20f, 0.72f));
        rows.add(row("¥195.46", 0.04f, 0.94f));

        List<FuelQuote> quotes = FuelQuoteParser.extract(rows, CAPTURED_AT, null);

        assertEquals(1, quotes.size());
        FuelQuote quote = quotes.get(0);
        assertEquals(new BigDecimal("200.00"), quote.selectedAmount);
        assertEquals(new BigDecimal("5.41"), quote.grossDiscount);
        assertEquals(new BigDecimal("0.87"), quote.serviceFee);
        assertEquals(new BigDecimal("195.46"), quote.payableAmount);

        List<FuelStationRecord> stations =
                FuelStationParser.extract(rows, "amap-fuel", "screen-ocr-manual-float");
        assertEquals(1, stations.size());
        assertEquals("浙江石油塘河供能加油站", stations.get(0).stationName);
    }

    @Test
    public void currentAmapOcrNoiseIsCorrectedByAmountConsistency() {
        List<OcrRow> rows = new ArrayList<>();
        rows.add(row("浙江石油塘河供能加油站", 0.05f, 0.11f));
        rows.add(row("¥7.19/L加200省¥5.41", 0.05f, 0.14f));
        rows.add(row("園立减优惠", 0.05f, 0.25f));
        rows.add(row("Y5.41", 0.86f, 0.25f));
        rows.add(row("眼服务费@", 0.04f, 0.28f));
        rows.add(row("+40.87", 0.85f, 0.29f));
        rows.add(row("3.5 O", 0.80f, 0.34f));
        rows.add(row("¥1/份", 0.20f, 0.73f));
        rows.add(row("¥195.46o台服务要", 0.08f, 0.93f));
        rows.add(row("比油站价优惠¥4.54", 0.08f, 0.96f));

        List<FuelQuote> quotes = FuelQuoteParser.extract(rows, CAPTURED_AT, null);

        assertEquals(1, quotes.size());
        FuelQuote quote = quotes.get(0);
        assertEquals(new BigDecimal("200.00"), quote.selectedAmount);
        assertEquals(new BigDecimal("5.41"), quote.grossDiscount);
        assertEquals(new BigDecimal("0.87"), quote.serviceFee);
        assertEquals(new BigDecimal("4.54"), quote.netDiscount);
        assertEquals(new BigDecimal("195.46"), quote.payableAmount);
    }

    @Test
    public void amountSelectionPageDoesNotInventPayableFromUnrelatedNumbers() {
        List<OcrRow> rows = Arrays.asList(
                row("浙江石油塘河供能加油站", .05f, .11f),
                row("¥7.66/L加200省¥5.09", .05f, .14f),
                row("95#", .22f, .25f),
                row("¥100", .10f, .50f),
                row("¥200", .40f, .50f),
                row("¥300", .70f, .50f),
                row("服务费 输入金额计算服务费", .05f, .66f),
                row("保障金额689元", .05f, .82f),
                row("¥0.00", .05f, .94f),
                row("立即支付", .70f, .94f)
        );

        List<FuelQuote> quotes = FuelQuoteParser.extract(rows, CAPTURED_AT, null);

        assertEquals(1, quotes.size());
        assertEquals(new BigDecimal("200.00"), quotes.get(0).selectedAmount);
        assertEquals(new BigDecimal("5.09"), quotes.get(0).grossDiscount);
        assertNull(quotes.get(0).payableAmount);
        assertNull(quotes.get(0).serviceFee);
    }

    @Test
    public void paymentFooterFormulaOverridesGiftAndInvoiceNoise() {
        List<OcrRow> rows = Arrays.asList(
                row("浙江石油塘河供能加油站", .05f, .11f),
                row("¥7.66/L加200省¥5.09", .05f, .14f),
                row("500万油品保障7天", .50f, .63f),
                row("¥1/份", .20f, .72f),
                row("服务费1服务商开票联系客服", .05f, .86f),
                row("本次由服务商团油提供", .18f, .90f),
                row("比油站价优惠¥4.28", .05f, .96f)
        );

        List<FuelQuote> quotes = FuelQuoteParser.extract(rows, CAPTURED_AT, null);

        assertEquals(1, quotes.size());
        assertEquals(new BigDecimal("0.81"), quotes.get(0).serviceFee);
        assertEquals(new BigDecimal("195.72"), quotes.get(0).payableAmount);
    }

    private static void assert66Quote(List<FuelQuote> quotes) {
        assertEquals(1, quotes.size());
        FuelQuote quote = quotes.get(0);
        assertEquals(new BigDecimal("200.00"), quote.selectedAmount);
        assertEquals(new BigDecimal("19.85"), quote.grossDiscount);
        assertEquals(new BigDecimal("16.67"), quote.netDiscount);
        assertEquals(new BigDecimal("3.18"), quote.serviceFee);
        assertEquals(new BigDecimal("183.33"), quote.payableAmount);
    }

    private static List<OcrRow> croppedGalleryRows() {
        return Arrays.asList(
                row("95#", .05f, .05f),
                row("中海联石油城西加油站", .05f, .10f),
                row("¥7.08/L", .05f, .15f),
                row("加200", .23f, .15f),
                row("省¥19.85", .36f, .15f),
                row("购超值神券包", .06f, .23f),
                row("低至1.3折", .76f, .22f),
                row("¥3.5", .78f, .25f),
                row("加油", .24f, .29f),
                row("12元", .17f, .34f),
                row("×2张", .30f, .34f),
                row("满200", .17f, .39f),
                row("减12", .30f, .39f),
                row("洗车", .62f, .29f),
                row("3元", .62f, .34f),
                row("满30", .59f, .39f),
                row("减3", .70f, .39f),
                row("为爱车添加保障", .06f, .47f),
                row("油品问题可赔", .06f, .51f),
                row("停车刮蹭保障1天", .12f, .61f),
                row("送200-8加油券", .12f, .66f),
                row("×1张", .33f, .66f),
                row("500万油品保障7天", .52f, .61f),
                row("送200-8加油券", .52f, .66f),
                row("×1张", .73f, .66f),
                row("¥1/份", .20f, .72f),
                row("¥1/份", .61f, .72f),
                row("开票方式", .06f, .78f),
                row("油站开票", .56f, .78f),
                row("当场索取", .75f, .78f),
                row("加油上高德", .28f, .84f),
                row("单单享优惠", .55f, .84f),
                row("本次由服务商", .22f, .88f),
                row("中能光和", .48f, .88f),
                row("提供", .65f, .88f)
        );
    }

    private static OcrRow row(String text, float x, float y) {
        return new OcrRow(text, 0.95f, x, y, 0.30f, 0.04f);
    }
}
