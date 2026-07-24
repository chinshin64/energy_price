package com.datafordidi.mobilecollector;

import org.junit.Test;

import java.util.Arrays;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

public class AmapStationParserTest {

    @Test
    public void extractsAnonymousGridCardsWithoutCrossColumnPricePollution() throws Exception {
        List<OcrRow> rows = Arrays.asList(
                row("比亚迪闪充汽车充电站(西安城市运动公园)", 0.04f, 0.40f, 0.43f),
                row("充电站", 0.04f, 0.45f, 0.18f),
                row("快充桩", 0.04f, 0.49f, 0.18f),
                row("¥", 0.04f, 0.53f, 0.04f),
                row("0.85", 0.09f, 0.53f, 0.10f),
                row("/度", 0.20f, 0.53f, 0.08f),
                row("西安城市运动公园东门 578米", 0.04f, 0.58f, 0.42f),

                row("庭院江南菜北京烤鸭", 0.54f, 0.40f, 0.40f),
                row("¥103/人", 0.54f, 0.49f, 0.20f),

                row("星星充电汽车充电站(未央区银池广场充电站)", 0.54f, 0.67f, 0.42f),
                row("充电站", 0.54f, 0.72f, 0.18f),
                row("¥0.64/度", 0.54f, 0.77f, 0.22f)
        );

        List<DidiLocalStationParser.StationRecord> stations = AmapStationParser.extract(
                rows,
                "phone-auto-scroll"
        );

        assertEquals(2, stations.size());
        assertEquals("amap-charging", stations.get(0).platform);
        assertEquals("amap-android", stations.get(0).localParser);
        assertEquals(0.85d, stations.get(0).priceFast, 0.0001d);
        assertEquals("西安城市运动公园东门", stations.get(0).address);
        assertEquals("西安城市运动公园东门", stations.get(0).toJson().getString("address"));
        assertEquals(0.64d, stations.get(1).priceFast, 0.0001d);
        assertNull(stations.get(1).address);
    }

    @Test
    public void rejectsCommerceCardWithoutChargingCategorySignal() {
        List<OcrRow> rows = Arrays.asList(
                row("过期自动退随时退", 0.04f, 0.25f, 0.27f),
                row("惠¥1.11 ¥8.88 1.3折", 0.04f, 0.28f, 0.32f),
                row("西安北站宠物市场 3.9公里", 0.04f, 0.31f, 0.43f)
        );

        assertEquals(0, AmapStationParser.extract(rows, "phone-auto-scroll").size());
    }

    @Test
    public void acceptsYuanStartingPriceAndRejectsPerPersonOrServiceFee() {
        List<DidiLocalStationParser.StationRecord> priced = AmapStationParser.extract(Arrays.asList(
                row("星星充电汽车充电站(西安高新站)", 0.04f, 0.30f, 0.43f),
                row("￥1.03元起", 0.04f, 0.36f, 0.22f)
        ), "phone-auto-scroll");
        assertEquals(1.03d, priced.get(0).priceFast, 0.0001d);

        List<DidiLocalStationParser.StationRecord> rejected = AmapStationParser.extract(Arrays.asList(
                row("星星充电汽车充电站(西安高新站)", 0.04f, 0.30f, 0.43f),
                row("快空2/4", 0.04f, 0.35f, 0.18f),
                row("服务费0.35元 ¥103元/人", 0.04f, 0.40f, 0.35f)
        ), "phone-auto-scroll");
        assertNull(rejected.get(0).priceFast);
    }

    @Test
    public void sameNameDifferentAmapCardsAreNotMergedByMissingAddress() {
        List<DidiLocalStationParser.StationRecord> stations = AmapStationParser.extract(Arrays.asList(
                row("星星充电汽车充电站(西安同名站)", .04f, .25f, .70f),
                row("西安市雁塔区甲路1号", .04f, .28f, .60f),
                row("快空2/4 ¥0.82/度", .04f, .32f, .42f),
                row("星星充电汽车充电站(西安同名站)", .04f, .52f, .70f),
                row("西安市雁塔区乙路2号", .04f, .55f, .60f),
                row("快空5/8 ¥0.96/度", .04f, .59f, .42f)
        ), "phone-auto-scroll");
        assertEquals(2, stations.size());
        new StationObservationTracker().previewChanged(
                "test-session", "page-1", "amap-charging", "西安", stations
        );
        assertEquals(4, stations.get(0).fastTotalPorts);
        assertEquals(8, stations.get(1).fastTotalPorts);
        org.junit.Assert.assertNotEquals(stations.get(0).captureContextId, stations.get(1).captureContextId);
    }

    private static OcrRow row(String text, float x, float y, float width) {
        return new OcrRow(text, 1f, x, y, width, 0.035f);
    }
}
