package com.datafordidi.mobilecollector;

import org.junit.Test;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * 基于 docx 截图样本的高德加油页面解析回归测试。
 */
public class AmapFuelDocxSampleTest {

    @Test
    public void shuanglongDetailPageWithThreePricesAndQuote() {
        List<OcrRow> rows = new ArrayList<>();
        rows.add(row("杭州双龙加油站", 0.10f, 0.08f));
        rows.add(row("24小时营业", 0.10f, 0.14f));
        rows.add(row("加200省7.05", 0.45f, 0.14f));
        rows.add(row("6.85", 0.10f, 0.20f));
        rows.add(row("享油站价直降0.30/L", 0.10f, 0.25f));
        rows.add(row("外显价", 0.10f, 0.31f));
        rows.add(row("油站价: ¥7.15/L", 0.35f, 0.31f));
        rows.add(row("国标价: ¥7.15/L", 0.65f, 0.31f));
        rows.add(row("选择油枪/油号", 0.10f, 0.38f));
        rows.add(row("92#", 0.45f, 0.38f));
        rows.add(row("4号", 0.20f, 0.44f));
        rows.add(row("6号", 0.40f, 0.44f));
        rows.add(row("¥200", 0.15f, 0.52f));
        rows.add(row("¥300", 0.40f, 0.52f));
        rows.add(row("¥400", 0.65f, 0.52f));
        rows.add(row("省7.05", 0.15f, 0.58f));
        rows.add(row("省10.58", 0.40f, 0.58f));
        rows.add(row("省14.10", 0.65f, 0.58f));
        rows.add(row("合计优惠", 0.10f, 0.70f));
        rows.add(row("-8.39", 0.45f, 0.70f));

        List<FuelStationRecord> stations = FuelStationParser.extract(rows, "amap-fuel", "screen-ocr-user-driven");
        for (FuelStationRecord s : stations) {
            System.out.println("SL name=" + s.stationName + " offers=" + s.fuelOffers.size() + " quotes=" + s.fuelQuotes.size());
            for (FuelOffer o : s.fuelOffers) {
                System.out.println("  grade=" + o.gradeCode + " display=" + o.displayPrice + " station=" + o.stationPrice);
            }
        }
        assertEquals(1, stations.size());
        FuelStationRecord station = stations.get(0);
        assertEquals("杭州双龙加油站", station.stationName);
        assertEquals(1, station.fuelOffers.size());

        FuelOffer offer = station.offerForGrade("92");
        assertNotNull(offer);
        assertEquals(0, offer.displayPrice.compareTo(new BigDecimal("6.85")));
        assertEquals(0, offer.stationPrice.compareTo(new BigDecimal("7.15")));
        assertEquals(0, offer.nationalPrice.compareTo(new BigDecimal("7.15")));
        assertEquals(0.30d, offer.discountPrice, 0.001d);

        // 详情页有“加200省7.05”，应生成 quote。
        assertEquals(1, station.fuelQuotes.size());
        FuelQuote quote = station.fuelQuotes.get(0);
        assertEquals(new BigDecimal("200.00"), quote.selectedAmount);
        assertEquals(new BigDecimal("7.05"), quote.grossDiscount);
    }

    @Test
    public void shuanglongPaymentPageWithServiceFee() {
        List<OcrRow> rows = new ArrayList<>();
        rows.add(row("待支付明细", 0.10f, 0.08f));
        rows.add(row("油号/枪号", 0.10f, 0.16f));
        rows.add(row("油站单价", 0.60f, 0.16f));
        rows.add(row("92#/1号枪", 0.10f, 0.22f));
        rows.add(row("¥7.15/L", 0.60f, 0.22f));
        rows.add(row("加油升数", 0.10f, 0.30f));
        rows.add(row("加油金额", 0.60f, 0.30f));
        rows.add(row("27.97L", 0.10f, 0.36f));
        rows.add(row("¥200.00", 0.60f, 0.36f));
        rows.add(row("服务费", 0.10f, 0.46f));
        rows.add(row("¥7.05", 0.60f, 0.46f));
        rows.add(row("¥192.95", 0.60f, 0.54f));
        rows.add(row("油站开票 当场索取", 0.10f, 0.70f));
        rows.add(row("高德CP", 0.10f, 0.78f));
        rows.add(row("立即支付", 0.60f, 0.78f));

        List<FuelStationRecord> stations = FuelStationParser.extract(rows, "amap-fuel", "screen-ocr-user-driven");
        // 支付明细页通常没有站名，但有 quote 时兜底可能无法识别站名。
        assertTrue(stations.isEmpty() || stations.get(0).fuelQuotes.isEmpty());
    }

    @Test
    public void shunxing92PageWithQuote() {
        List<OcrRow> rows = new ArrayList<>();
        rows.add(row("顺兴石油加油站", 0.10f, 0.08f));
        rows.add(row("6.28", 0.10f, 0.18f));
        rows.add(row("加200省22.29", 0.10f, 0.24f));
        rows.add(row("国标价7.23/L", 0.55f, 0.24f));
        rows.add(row("92号外显价", 0.10f, 0.30f));
        rows.add(row("选择油枪/油号", 0.10f, 0.38f));
        rows.add(row("92#", 0.35f, 0.38f));
        rows.add(row("0#柴油", 0.55f, 0.38f));
        rows.add(row("3号", 0.25f, 0.46f));
        rows.add(row("2号", 0.45f, 0.46f));
        rows.add(row("¥100", 0.15f, 0.54f));
        rows.add(row("¥200", 0.40f, 0.54f));
        rows.add(row("¥300", 0.65f, 0.54f));
        rows.add(row("立减11.15", 0.15f, 0.60f));
        rows.add(row("立减22.29", 0.40f, 0.60f));
        rows.add(row("立减33.44", 0.65f, 0.60f));
        rows.add(row("立减优惠", 0.10f, 0.68f));
        rows.add(row("-22.29", 0.45f, 0.68f));
        rows.add(row("服务费", 0.10f, 0.75f));
        rows.add(row("+3.57", 0.45f, 0.75f));

        List<FuelStationRecord> stations = FuelStationParser.extract(rows, "amap-fuel", "screen-ocr-user-driven");
        System.out.println("SX95 stations=" + stations.size());
        for (FuelStationRecord s : stations) {
            System.out.println("  name=" + s.stationName + " offers=" + s.fuelOffers.size() + " quotes=" + s.fuelQuotes.size());
        }
        assertEquals(1, stations.size());
        FuelStationRecord station = stations.get(0);
        assertEquals("顺兴石油加油站", station.stationName);

        FuelOffer offer = station.offerForGrade("92");
        assertNotNull(offer);
        assertEquals(0, offer.displayPrice.compareTo(new BigDecimal("6.28")));
        assertEquals(0, offer.nationalPrice.compareTo(new BigDecimal("7.23")));

        assertEquals(1, station.fuelQuotes.size());
        FuelQuote quote = station.fuelQuotes.get(0);
        assertEquals(new BigDecimal("200.00"), quote.selectedAmount);
        assertEquals(new BigDecimal("22.29"), quote.grossDiscount);
        assertEquals(new BigDecimal("3.57"), quote.serviceFee);
    }

    @Test
    public void shunxing95PageWithQuote() {
        List<OcrRow> rows = new ArrayList<>();
        rows.add(row("选择油枪/油号 请与加油员确认枪号", 0.10f, 0.08f));
        rows.add(row("95#", 0.10f, 0.16f));
        rows.add(row("8号", 0.10f, 0.22f));
        rows.add(row("95号200元的优惠&服务费", 0.10f, 0.30f));
        rows.add(row("¥100", 0.15f, 0.38f));
        rows.add(row("¥200", 0.40f, 0.38f));
        rows.add(row("¥300", 0.65f, 0.38f));
        rows.add(row("立减10.32", 0.15f, 0.44f));
        rows.add(row("立减20.65", 0.40f, 0.44f));
        rows.add(row("立减30.97", 0.65f, 0.44f));
        rows.add(row("优惠券", 0.10f, 0.52f));
        rows.add(row("暂无可用优惠券", 0.55f, 0.52f));
        rows.add(row("立减优惠", 0.10f, 0.60f));
        rows.add(row("-20.65", 0.55f, 0.60f));
        rows.add(row("服务费", 0.10f, 0.68f));
        rows.add(row("+3.30", 0.55f, 0.68f));

        List<FuelQuote> quotes = FuelQuoteParser.extract(rows, "2026-07-26T12:00:00+08:00", null);
        assertEquals(0, quotes.size()); // 金额选择页无应付金额/加油金额标签，不再从按钮推断金额
    }

    @Test
    public void discountPopupExplanationRecognized() {
        List<OcrRow> rows = new ArrayList<>();
        rows.add(row("优惠说明", 0.10f, 0.08f));
        rows.add(row("92#", 0.10f, 0.12f));
        rows.add(row("应付金额", 0.10f, 0.18f));
        rows.add(row("¥200.00", 0.55f, 0.18f));
        rows.add(row("立减优惠", 0.10f, 0.26f));
        rows.add(row("-22.29", 0.55f, 0.26f));
        rows.add(row("服务费", 0.10f, 0.34f));
        rows.add(row("+3.57", 0.55f, 0.34f));
        rows.add(row("预计实付", 0.10f, 0.42f));
        rows.add(row("¥181.28", 0.55f, 0.42f));
        rows.add(row("现高德加油第三方服务商有能链、小桔和易加油等", 0.10f, 0.55f));
        rows.add(row("知道了", 0.45f, 0.78f));

        List<FuelQuote> quotes = FuelQuoteParser.extract(rows, "2026-07-26T12:00:00+08:00", null);
        assertEquals(1, quotes.size());
        assertEquals("explanation_popup", quotes.get(0).quoteEntry);
    }

    private static OcrRow row(String text, float x, float y) {
        return new OcrRow(text, 0.95f, x, y, 0.30f, 0.04f);
    }
}
