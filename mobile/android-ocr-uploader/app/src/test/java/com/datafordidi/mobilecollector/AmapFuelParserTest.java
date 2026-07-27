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
 * 高德燃油页面解析回归测试，基于真实录屏 OCR 文本。
 */
public class AmapFuelParserTest {

    @Test
    public void shuanglongDetailPageWithPerLiterDiscount() {
        List<OcrRow> rows = new ArrayList<>();
        rows.add(row("双龙加油站", 0.10f, 0.10f));
        rows.add(row("92# 优惠¥0.38/L", 0.10f, 0.28f));
        rows.add(row("7.08", 0.10f, 0.33f));
        rows.add(row("油站价¥7.39/L", 0.55f, 0.30f));
        rows.add(row("国标价¥7.39/L", 0.55f, 0.36f));
        rows.add(row("加200约省10.18", 0.10f, 0.42f));
        rows.add(row("95# 优惠¥0.4/L", 0.10f, 0.52f));
        rows.add(row("7.46", 0.10f, 0.57f));
        rows.add(row("油站价¥7.86/L", 0.55f, 0.54f));
        rows.add(row("国标价¥7.86/L", 0.55f, 0.60f));

        List<FuelStationRecord> stations = FuelStationParser.extract(rows, "amap-fuel", "screen-ocr-user-driven");
        assertEquals(1, stations.size());
        FuelStationRecord station = stations.get(0);
        assertEquals("双龙加油站", station.stationName);
        assertEquals(2, station.fuelOffers.size());

        FuelOffer offer92 = station.offerForGrade("92");
        assertNotNull(offer92);
        assertEquals(0, offer92.displayPrice.compareTo(new BigDecimal("7.08")));
        assertEquals(0, offer92.stationPrice.compareTo(new BigDecimal("7.39")));
        assertEquals(0, offer92.nationalPrice.compareTo(new BigDecimal("7.39")));
        assertEquals(0.38d, offer92.discountPrice, 0.001d);

        FuelOffer offer95 = station.offerForGrade("95");
        assertNotNull(offer95);
        assertEquals(new BigDecimal("7.46"), offer95.displayPrice);
        assertEquals(new BigDecimal("7.86"), offer95.stationPrice);
        assertEquals(0.4d, offer95.discountPrice, 0.001d);
    }

    @Test
    public void zhonghuaDaoDetailPageWithGunNumbersIgnored() {
        List<OcrRow> rows = new ArrayList<>();
        rows.add(row("中化道达尔杭州留祥路加油站", 0.10f, 0.10f));
        rows.add(row("¥6.80 /L 加200省¥15.96", 0.10f, 0.20f));
        rows.add(row("选择油枪/油号 请与加油员确认枪号", 0.10f, 0.26f));
        rows.add(row("92#", 0.10f, 0.32f));
        rows.add(row("95#", 0.30f, 0.32f));
        rows.add(row("9号", 0.10f, 0.38f));
        rows.add(row("10号", 0.25f, 0.38f));
        rows.add(row("11号", 0.40f, 0.38f));
        rows.add(row("12号", 0.55f, 0.38f));
        rows.add(row("¥100", 0.10f, 0.48f));
        rows.add(row("¥200", 0.30f, 0.48f));
        rows.add(row("¥300", 0.50f, 0.48f));

        List<FuelStationRecord> stations = FuelStationParser.extract(rows, "amap-fuel", "screen-ocr-user-driven");
        assertEquals(1, stations.size());
        FuelStationRecord station = stations.get(0);
        assertEquals("中化道达尔杭州留祥路加油站", station.stationName);
        assertEquals(1, station.fuelOffers.size());

        FuelOffer offer92 = station.offerForGrade("92");
        assertNotNull(offer92);
        assertEquals(0, offer92.displayPrice.compareTo(new BigDecimal("6.80")));
    }

    @Test
    public void zhejiangPetrolInlineSaveLineDoesNotPolluteDisplayPrice() {
        List<OcrRow> rows = new ArrayList<>();
        rows.add(row("浙江石油塘河供能加油站", 0.10f, 0.10f));
        rows.add(row("¥7.19 /L 加200省¥5.41", 0.10f, 0.22f));
        rows.add(row("92#", 0.10f, 0.28f));
        rows.add(row("服务费", 0.10f, 0.36f));
        rows.add(row("+¥0.87", 0.40f, 0.36f));
        rows.add(row("低至1.3折", 0.10f, 0.44f));
        rows.add(row("0 购超值神券包", 0.10f, 0.51f));
        rows.add(row("¥3.5", 0.45f, 0.51f));

        List<FuelStationRecord> stations = FuelStationParser.extract(rows, "amap-fuel", "screen-ocr-user-driven");
        assertEquals(1, stations.size());
        FuelOffer offer = stations.get(0).offerForGrade("92");
        assertNotNull(offer);
        assertEquals(0, offer.displayPrice.compareTo(new BigDecimal("7.19")));
        assertNull(offer.stationPrice);
    }

    @Test
    public void structurallyNormalizesNewSearchShellVariantsBeforeBindingGrades() {
        List<OcrRow> rows = new ArrayList<>();
        rows.add(row("く在売牌加油站(浙江银湖站附近搜素", 0.10f, 0.10f));
        rows.add(row("92# 外显价 7.10元/L", 0.10f, 0.22f));
        rows.add(row("95# 外显价 7.55元/L", 0.10f, 0.29f));

        List<FuelStationRecord> stations = FuelStationParser.extract(
                rows,
                "amap-fuel",
                "screen-ocr-user-driven"
        );

        assertEquals(1, stations.size());
        assertEquals("壳牌加油站(浙江银湖站)", stations.get(0).stationName);
        assertEquals(2, stations.get(0).fuelOffers.size());
    }

    @Test
    public void retainsUncleanableNameAndPricesWithDiagnosticInsteadOfDroppingStation() {
        List<OcrRow> rows = new ArrayList<>();
        String noisyName = "在未知加油站附近这是一段很长提示";
        rows.add(row(noisyName, 0.10f, 0.10f));
        rows.add(row("92# 外显价 7.10元/L", 0.10f, 0.22f));

        FuelStationParser.ParseOutcome outcome = FuelStationParser.extractDetailed(
                rows,
                "amap-fuel",
                "screen-ocr-user-driven"
        );

        assertEquals(1, outcome.stations.size());
        assertEquals(noisyName, outcome.stations.get(0).stationName);
        assertNotNull(outcome.stations.get(0).offerForGrade("92"));
        assertTrue(outcome.rejectionReasons.contains("station-name-search-shell-residual-retained"));
        assertEquals("parser-residual-retained", outcome.stations.get(0).stationNameMatchMethod);
    }

    private static OcrRow row(String text, float x, float y) {
        return new OcrRow(text, 0.95f, x, y, 0.30f, 0.04f);
    }
}
