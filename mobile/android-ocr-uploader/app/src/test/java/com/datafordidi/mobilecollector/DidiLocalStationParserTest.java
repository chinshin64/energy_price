package com.datafordidi.mobilecollector;

import org.junit.Test;

import java.util.Arrays;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

public class DidiLocalStationParserTest {

    @Test
    public void extractsNameAddressIdleBusyTotalAndPrices() throws Exception {
        List<OcrRow> rows = Arrays.asList(
                row("小桔充电西安软件新城充电站", 0.05f, 0.30f, 0.62f),
                row("陕西省西安市雁塔区云水一路88号停车场", 0.05f, 0.35f, 0.80f),
                row("快充 闲3/8 ¥0.85/度", 0.05f, 0.40f, 0.52f),
                row("慢充 闲1/2 ¥0.62/度", 0.05f, 0.45f, 0.52f),
                row("超充 闲2/4 ¥1.20/度", 0.05f, 0.50f, 0.52f)
        );

        List<DidiLocalStationParser.StationRecord> stations = DidiLocalStationParser.extract(
                rows,
                "phone-auto-scroll"
        );

        assertEquals(1, stations.size());
        DidiLocalStationParser.StationRecord station = stations.get(0);
        assertEquals("小桔充电西安软件新城充电站", station.stationName);
        assertEquals("陕西省西安市雁塔区云水一路88号停车场", station.address);
        assertEquals(station.address, station.toJson().getString("address"));
        org.junit.Assert.assertTrue(station.toJson().getJSONObject("raw")
                .getJSONObject("observed").getBoolean("address"));
        assertEquals(3, station.fastIdlePorts);
        assertEquals(8, station.fastTotalPorts);
        assertEquals(1, station.slowIdlePorts);
        assertEquals(2, station.slowTotalPorts);
        assertEquals(2, station.superIdlePorts);
        assertEquals(4, station.superTotalPorts);
        int availablePorts = station.fastIdlePorts + station.slowIdlePorts + station.superIdlePorts;
        int totalPorts = station.fastTotalPorts + station.slowTotalPorts + station.superTotalPorts;
        assertEquals(6, availablePorts);
        assertEquals(14, totalPorts);
        assertEquals(8, totalPorts - availablePorts);
        assertEquals(0.85d, station.priceFast, 0.0001d);
        assertEquals(0.62d, station.priceSlow, 0.0001d);
        assertEquals(1.20d, station.priceSuper, 0.0001d);
        assertEquals("android-ocr-agent", LocalStationStore.SOURCE_AGENT);
    }

    @Test
    public void acceptsSplitCurrencyAmountAndUnitButRejectsStandaloneServiceFee() {
        List<DidiLocalStationParser.StationRecord> split = DidiLocalStationParser.extract(Arrays.asList(
                row("小桔充电西安高新充电站", 0.05f, 0.30f, 0.62f),
                row("¥", 0.05f, 0.35f, 0.05f),
                row("0.88", 0.11f, 0.35f, 0.10f),
                row("元/度", 0.22f, 0.35f, 0.12f)
        ), "phone-auto-scroll");
        assertEquals(0.88d, split.get(0).priceFast, 0.0001d);

        List<DidiLocalStationParser.StationRecord> feeOnly = DidiLocalStationParser.extract(Arrays.asList(
                row("小桔充电西安高新充电站", 0.05f, 0.30f, 0.62f),
                row("快充 闲2/4", 0.05f, 0.35f, 0.30f),
                row("服务费0.35元", 0.05f, 0.40f, 0.30f)
        ), "phone-auto-scroll");
        assertNull(feeOnly.get(0).priceFast);
    }

    @Test
    public void gridPricesStayInTheirDidiCardColumn() {
        List<DidiLocalStationParser.StationRecord> stations = DidiLocalStationParser.extract(Arrays.asList(
                row("小桔充电西安左侧充电站", 0.04f, 0.30f, 0.42f),
                row("小桔充电西安右侧充电站", 0.54f, 0.30f, 0.42f),
                row("快充 闲2/4 ￥0.82元", 0.04f, 0.36f, 0.35f),
                row("快充 闲1/6 ￥1.08元", 0.54f, 0.36f, 0.35f)
        ), "phone-auto-scroll");

        assertEquals(2, stations.size());
        assertEquals(0.82d, stations.get(0).priceFast, 0.0001d);
        assertEquals(1.08d, stations.get(1).priceFast, 0.0001d);
        assertEquals(4, stations.get(0).fastTotalPorts);
        assertEquals(6, stations.get(1).fastTotalPorts);
    }

    @Test
    public void localIdentityNormalizesNamesButSeparatesCities() {
        String xianList = LocalStationStore.buildKey("didi-charging", "西安", "小桔 充电软件新城站");
        String xianDetail = LocalStationStore.buildKey("didi-charging", "西安", "小桔充电软件新城站");
        String wuhan = LocalStationStore.buildKey("didi-charging", "武汉", "小桔充电软件新城站");

        assertEquals(xianList, xianDetail);
        org.junit.Assert.assertNotEquals(xianDetail, wuhan);
        assertEquals(1000, LocalStationStore.MAX_RESULTS);
    }

    @Test
    public void sameNameDifferentDidiCardsAreNotMergedByMissingAddress() {
        List<DidiLocalStationParser.StationRecord> stations = DidiLocalStationParser.extract(Arrays.asList(
                row("小桔充电西安同名充电站", .05f, .25f, .70f),
                row("西安市雁塔区甲路1号", .05f, .28f, .60f),
                row("快充 闲2/4 ¥0.82/度", .05f, .32f, .45f),
                row("小桔充电西安同名充电站", .05f, .52f, .70f),
                row("西安市雁塔区乙路2号", .05f, .55f, .60f),
                row("快充 闲5/8 ¥0.96/度", .05f, .59f, .45f)
        ), "phone-auto-scroll");
        assertEquals(2, stations.size());
        new StationObservationTracker().previewChanged(
                "test-session", "page-1", "didi-charging", "西安", stations
        );
        assertEquals(4, stations.get(0).fastTotalPorts);
        assertEquals(8, stations.get(1).fastTotalPorts);
        org.junit.Assert.assertNotEquals(stations.get(0).captureContextId, stations.get(1).captureContextId);
    }

    private static OcrRow row(String text, float x, float y, float width) {
        return new OcrRow(text, 1f, x, y, width, 0.035f);
    }
}
