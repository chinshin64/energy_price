package com.datafordidi.mobilecollector;

import org.junit.Test;

import java.util.Arrays;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

public class AmapStationParserTest {

    @Test
    public void extractsAnonymousGridCardsWithoutCrossColumnPricePollution() {
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

    private static OcrRow row(String text, float x, float y, float width) {
        return new OcrRow(text, 1f, x, y, width, 0.035f);
    }
}
