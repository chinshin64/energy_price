package com.datafordidi.mobilecollector;

import org.junit.Test;

import java.util.Arrays;
import java.util.List;

import static org.junit.Assert.assertEquals;

public class DidiLocalStationParserTest {

    @Test
    public void extractsNameAddressIdleBusyTotalAndPricesFromCurrentPage() throws Exception {
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
        assertEquals("android-agent", LocalStationStore.SOURCE_AGENT);
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

    private static OcrRow row(String text, float x, float y, float width) {
        return new OcrRow(text, 1f, x, y, width, 0.035f);
    }
}
