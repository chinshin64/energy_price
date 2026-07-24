package com.datafordidi.mobilecollector;

import org.junit.Test;
import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Arrays;
import java.util.ArrayList;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

public class GenericStationParserTest {
    @Test
    public void keepsNameOnlyStationAndMarksUnobservedFields() throws Exception {
        List<DidiLocalStationParser.StationRecord> stations = GenericStationParser.extract(
                Arrays.asList(row("国家电网未来科技城充电站", 0.28f)),
                "generic-charging-test",
                "screen-ocr-auto-scroll"
        );

        assertEquals(1, stations.size());
        DidiLocalStationParser.StationRecord station = stations.get(0);
        assertEquals("国家电网未来科技城充电站", station.stationName);
        assertNull(station.address);
        assertFalse(station.portsObserved);
        assertFalse(station.priceObserved);
    }

    @Test
    public void extractsOptionalAddressPriceAndIdleBusyTotals() throws Exception {
        List<DidiLocalStationParser.StationRecord> stations = GenericStationParser.extract(
                Arrays.asList(
                        row("特来电软件园能源站", 0.28f),
                        row("西安市雁塔区云水一路88号停车场", 0.33f),
                        row("快充 空闲3 忙5 ¥0.86/度", 0.38f)
                ),
                "generic-charging-test",
                "screen-ocr-auto-scroll"
        );

        assertEquals(1, stations.size());
        DidiLocalStationParser.StationRecord station = stations.get(0);
        assertEquals(3, station.fastIdlePorts);
        assertEquals(8, station.fastTotalPorts);
        assertEquals(0.86d, station.priceFast, 0.0001d);
        assertTrue(station.portsObserved);
        assertTrue(station.priceObserved);
    }

    @Test
    public void rejectsImpossibleIdleGreaterThanTotal() {
        List<DidiLocalStationParser.StationRecord> stations = GenericStationParser.extract(
                Arrays.asList(
                        row("国家电网测试充电站", 0.28f),
                        row("快充 空闲9/4", 0.33f)
                ),
                "generic-charging-test",
                "screen-ocr-auto-scroll"
        );

        assertEquals(1, stations.size());
        assertFalse(stations.get(0).portsObserved);
    }

    @Test
    public void rejectsConfirmedManualModeUiFalsePositives() {
        for (String falsePositive : Arrays.asList(
                "览模式查看基础电站列表。",
                "电站搜素",
                "目的地/电站名/功能"
        )) {
            List<DidiLocalStationParser.StationRecord> stations = GenericStationParser.extract(
                    Arrays.asList(row(falsePositive, 0.28f)),
                    "generic-charging-test",
                    "screen-ocr-auto-scroll"
            );
            assertEquals(falsePositive, 0, stations.size());
        }
    }

    @Test
    public void nameOnlyStillRequiresAndAcceptsStrongStationShape() {
        assertEquals(
                1,
                GenericStationParser.extract(
                        Arrays.asList(row("国家电网未来科技城充电站", 0.28f)),
                        "generic-charging-test",
                        "screen-ocr-auto-scroll"
                ).size()
        );
        assertEquals(
                0,
                GenericStationParser.extract(
                        Arrays.asList(row("A充电站", 0.28f)),
                        "generic-charging-test",
                        "screen-ocr-auto-scroll"
                ).size()
        );
        assertEquals(
                1,
                GenericStationParser.extract(
                        Arrays.asList(row("西安充电站", 0.28f)),
                        "generic-charging-test",
                        "screen-ocr-auto-scroll"
                ).size()
        );
    }

    @Test
    public void rejectsDropdownStationControls() {
        for (String marker : Arrays.asList("▼", "▽", "▾", "⌄", "∨")) {
            String value = "充电站" + marker;
            assertFalse(GenericStationParser.passesUiNoiseGate(value));
            assertEquals(value, 0, GenericStationParser.extract(
                    Arrays.asList(row(value, 0.28f)),
                    "generic-charging-test",
                    "screen-ocr-auto-scroll"
            ).size());
        }
        assertEquals(
                0,
                GenericStationParser.extract(
                        Arrays.asList(row("未来科技城电站", 0.28f)),
                        "generic-charging-test",
                        "screen-ocr-auto-scroll"
                ).size()
        );
    }

    @Test
    public void cleanupTargetsOnlyConfirmedFalsePositiveNames() {
        assertTrue(FalsePositiveCleanup.shouldRemove("览模式 查看基础电站列表。"));
        assertTrue(FalsePositiveCleanup.shouldRemove("电站搜素"));
        assertTrue(FalsePositiveCleanup.shouldRemove("目的地/电站名/功能"));
        assertTrue(FalsePositiveCleanup.shouldRemove("充电站▼"));
        assertFalse(FalsePositiveCleanup.shouldRemove("国家电网未来科技城充电站"));
    }

    @Test
    public void acceptsGenericMobilePriceFormats() {
        for (String value : Arrays.asList(
                "¥1.23", "￥1.23", "1.23元", "1.23元起", "￥1.23元起",
                "1.23元/度", "1.23元/千瓦时", "1.23元/kWh"
        )) {
            List<DidiLocalStationParser.StationRecord> stations = GenericStationParser.extract(
                    Arrays.asList(row("国家电网高新软件园充电站", 0.28f), row(value, 0.34f)),
                    "generic-charging-test",
                    "screen-ocr-auto-scroll"
            );
            assertEquals(value, 1.23d, stations.get(0).priceFast, 0.0001d);
        }
    }

    @Test
    public void joinsSplitPriceAndSerializesBoundedEvidence() throws Exception {
        List<DidiLocalStationParser.StationRecord> stations = GenericStationParser.extract(
                Arrays.asList(
                        row("国家电网高新软件园充电站", 0.28f),
                        new OcrRow("￥", 1f, 0.05f, 0.34f, 0.05f, 0.03f),
                        new OcrRow("0.96", 1f, 0.11f, 0.35f, 0.10f, 0.03f),
                        new OcrRow("元/度", 1f, 0.22f, 0.36f, 0.12f, 0.03f)
                ),
                "generic-charging-test",
                "screen-ocr-auto-scroll"
        );
        DidiLocalStationParser.StationRecord station = stations.get(0);
        assertEquals(0.96d, station.priceFast, 0.0001d);
        JSONObject raw = station.toJson().getJSONObject("raw");
        JSONArray evidence = raw.getJSONArray("priceEvidence");
        assertEquals(1, evidence.length());
        assertTrue(evidence.getJSONObject(0).getString("text").length() <= 32);
        assertTrue(evidence.getJSONObject(0).has("boundingBox"));
    }

    @Test
    public void priceEvidenceDropsItemsAfterEight() throws Exception {
        DidiLocalStationParser.StationRecord station = new DidiLocalStationParser.StationRecord();
        station.stationName = "国家电网高新软件园充电站";
        EnergyPriceParser.Match match = EnergyPriceParser.first("￥0.86元");
        for (int index = 0; index < 12; index++) {
            PriceEvidence.add(station, match, new OcrRow(
                    "￥0.86元", 1f, 0.05f, 0.10f + index * 0.01f, 0.20f, 0.03f
            ));
        }
        assertEquals(8, station.toJson().getJSONObject("raw").getJSONArray("priceEvidence").length());
    }

    @Test
    public void priceEvidenceNeverSerializesSensitiveNeighborText() throws Exception {
        DidiLocalStationParser.StationRecord station = GenericStationParser.extract(
                Arrays.asList(
                        row("国家电网高新软件园充电站", 0.28f),
                        row("token=private-value endpoint=https://private.example ￥0.86元", 0.34f)
                ),
                "generic-charging-test",
                "screen-ocr-auto-scroll"
        ).get(0);
        String serialized = station.toJson().getJSONObject("raw").getJSONArray("priceEvidence").toString();
        assertFalse(serialized.contains("private-value"));
        assertFalse(serialized.contains("private.example"));
        assertEquals("￥0.86元", new JSONArray(serialized).getJSONObject(0).getString("text"));
    }

    @Test
    public void rejectsNonEnergyFeesButKeepsDisplayedTotal() {
        for (String value : Arrays.asList(
                "停车费1.00元", "优惠价0.50元", "黑钻¥1.4600/度", "2元/小时",
                "103元/人", "服务费0.35元", "订单金额0.88元", "应付金额0.88元", "实付金额0.88元"
        )) {
            DidiLocalStationParser.StationRecord station = GenericStationParser.extract(
                    Arrays.asList(row("国家电网高新软件园充电站", 0.28f), row(value, 0.34f)),
                    "generic-charging-test",
                    "screen-ocr-auto-scroll"
            ).get(0);
            assertNull(value, station.priceFast);
        }
        DidiLocalStationParser.StationRecord total = GenericStationParser.extract(
                Arrays.asList(row("国家电网高新软件园充电站", 0.28f), row("含服务费总价0.86元", 0.34f)),
                "generic-charging-test",
                "screen-ocr-auto-scroll"
        ).get(0);
        assertEquals(0.86d, total.priceFast, 0.0001d);
    }

    @Test
    public void keepsPricesInsideNearestCardColumn() {
        List<DidiLocalStationParser.StationRecord> stations = GenericStationParser.extract(
                Arrays.asList(
                        new OcrRow("国家电网左侧充电站", 1f, 0.04f, 0.28f, 0.42f, 0.035f),
                        new OcrRow("星星充电右侧充电站", 1f, 0.54f, 0.28f, 0.42f, 0.035f),
                        new OcrRow("￥0.92元/度", 1f, 0.54f, 0.34f, 0.24f, 0.035f)
                ),
                "generic-charging-test",
                "screen-ocr-auto-scroll"
        );
        assertEquals(2, stations.size());
        assertNull(stations.get(0).priceFast);
        assertEquals(0.92d, stations.get(1).priceFast, 0.0001d);
    }

    @Test
    public void parsesRealTeldMlKitRowsCardByCard() throws Exception {
        List<DidiLocalStationParser.StationRecord> stations = GenericStationParser.extract(
                Arrays.asList(
                        exact("特来电高新一路充电站", .05f, .26504f, .70f, .025f),
                        exact("1.0849度黑的¥09329", .05648f, .38943f, .36296f, .01870f),
                        exact("(快闲22/25 慢闲6/15m", .56389f, .38984f, .37685f, .01626f),
                        exact("特来电软件园充电站", .05f, .45407f, .70f, .025f),
                        exact("1.1029,", .09444f, .55650f, .11389f, .02317f),
                        exact("|慢闲12/12 三", .73426f, .55976f, .20648f, .01463f),
                        exact("特来电科技路充电站", .05f, .64024f, .70f, .025f),
                        exact("10529度", .05648f, .74146f, .17963f, .02561f),
                        exact("快闲9/10 三", .75093f, .74512f, .18981f, .01707f),
                        exact("特来电下一页充电站", .05f, .82642f, .70f, .025f)
                ),
                "generic-charging-teld",
                "screen-ocr-auto-scroll"
        );

        assertEquals(4, stations.size());
        DidiLocalStationParser.StationRecord first = stations.get(0);
        assertEquals(1.0849d, first.priceFast, 0.00001d);
        assertFalse(Double.valueOf(0.9329d).equals(first.priceFast));
        assertEquals(22, first.fastIdlePorts);
        assertEquals(25, first.fastTotalPorts);
        assertEquals(6, first.slowIdlePorts);
        assertEquals(15, first.slowTotalPorts);

        DidiLocalStationParser.StationRecord second = stations.get(1);
        assertEquals(1.1029d, second.priceFast, 0.00001d);
        assertEquals(12, second.slowIdlePorts);
        assertEquals(12, second.slowTotalPorts);

        DidiLocalStationParser.StationRecord third = stations.get(2);
        assertEquals(1.0529d, third.priceFast, 0.00001d);
        assertEquals(9, third.fastIdlePorts);
        assertEquals(10, third.fastTotalPorts);

        first.screenRowCount = 10;
        first.captureMode = "manual-scroll";
        first.packageCategory = "manual-unavailable";
        JSONObject payload = first.toJson();
        assertEquals("闲 28 / 忙 12 / 总 40", StationDisplayFormatter.ports(payload));
        assertEquals("快 1.0849", StationDisplayFormatter.prices(payload));
        assertTrue(StationDisplayFormatter.incomplete(payload));
        JSONObject diagnostics = payload.getJSONObject("raw").getJSONObject("diagnostics");
        assertEquals(10, diagnostics.getInt("screenRowCount"));
        assertEquals("dynamic-observed", diagnostics.getString("quality"));
        assertEquals("manual-scroll", diagnostics.getString("mode"));
    }

    @Test
    public void realTeldSingleColumnSummaryRecoversMainPriceWithoutTakingMemberPrice() {
        List<DidiLocalStationParser.StationRecord> stations = GenericStationParser.extract(
                Arrays.asList(
                        exact("特来电真实样本甲充电站项目", .2491f, .3642f, .5750f, .0163f),
                        exact("充电车辆2小时停车免费", .2898f, .4236f, .6454f, .0130f),
                        exact("15000/度", .0565f, .4663f, .1796f, .0240f),
                        exact("超闲1/1 快闲19/23", .5824f, .4703f, .3583f, .0154f),
                        exact("特来电真实样本乙充电站", .2491f, .5337f, .5037f, .0163f),
                        exact("停车0.5小时，6元/小时，每天最多50元", .2426f, .5886f, .6769f, .0183f),
                        exact("1.7000", .0935f, .6366f, .1111f, .0252f),
                        exact("黑钻 ¥1.4600", .2509f, .6398f, .1630f, .0146f),
                        exact("慢闲0/5", .7694f, .6390f, .1713f, .0159f),
                        exact("特来电真实样本丙充电站", .2389f, .7016f, .3759f, .0195f),
                        exact("1.5100度", .0546f, .8049f, .1731f, .0260f),
                        exact("快闲0/22", .7963f, .8085f, .1324f, .0154f)
                ),
                "generic-charging-teld",
                "screen-ocr-auto-scroll"
        );

        assertEquals(3, stations.size());
        assertEquals(1.5d, stations.get(0).priceFast, 0.00001d);
        assertEquals(1.7d, stations.get(1).priceFast, 0.00001d);
        assertFalse(Double.valueOf(1.46d).equals(stations.get(1).priceFast));
        assertEquals(1.51d, stations.get(2).priceFast, 0.00001d);
        assertEquals(19, stations.get(0).fastIdlePorts);
        assertEquals(23, stations.get(0).fastTotalPorts);
        assertEquals(0, stations.get(1).slowIdlePorts);
        assertEquals(5, stations.get(1).slowTotalPorts);
    }

    @Test
    public void geometryRecoveryRequiresPriceZoneAndEnergyEvidence() {
        OcrRow title = exact("特来电测试充电站", .05f, .28f, .70f, .03f);
        for (OcrRow invalid : Arrays.asList(
                exact("10529度", .60f, .40f, .20f, .03f),
                exact("10529", .05f, .40f, .20f, .03f),
                exact("1.1029,", .05f, .52f, .20f, .03f),
                exact("会员1.1029,", .05f, .40f, .25f, .03f)
        )) {
            DidiLocalStationParser.StationRecord station = GenericStationParser.extract(
                    Arrays.asList(title, invalid),
                    "generic-charging-test",
                    "screen-ocr-auto-scroll"
            ).get(0);
            assertNull(invalid.text, station.priceFast);
        }
    }

    @Test
    public void joinsTypedPortFragmentsButRejectsUntypedRatios() {
        DidiLocalStationParser.StationRecord typed = GenericStationParser.extract(
                Arrays.asList(
                        row("特来电测试充电站", .28f),
                        exact("快", .56f, .36f, .05f, .025f),
                        exact("固闲3/5", .62f, .365f, .20f, .025f)
                ),
                "generic-charging-test",
                "screen-ocr-auto-scroll"
        ).get(0);
        assertEquals(3, typed.fastIdlePorts);
        assertEquals(5, typed.fastTotalPorts);

        DidiLocalStationParser.StationRecord untyped = GenericStationParser.extract(
                Arrays.asList(row("特来电测试充电站", .28f), row("间3/5", .36f)),
                "generic-charging-test",
                "screen-ocr-auto-scroll"
        ).get(0);
        assertFalse(untyped.portsObserved);
    }

    @Test
    public void nameOnlyPayloadIsExplicitlyIncomplete() throws Exception {
        DidiLocalStationParser.StationRecord station = GenericStationParser.extract(
                Arrays.asList(row("国家电网未来科技城充电站", .28f)),
                "generic-charging-test",
                "screen-ocr-auto-scroll"
        ).get(0);
        JSONObject payload = station.toJson();
        assertTrue(StationDisplayFormatter.incomplete(payload));
        assertEquals("incomplete-name-only", payload.getJSONObject("raw")
                .getJSONObject("diagnostics").getString("quality"));
        JSONArray reasons = payload.getJSONObject("raw").getJSONObject("diagnostics")
                .getJSONArray("rejectionReasons");
        assertTrue(reasons.toString().contains("no-price-candidate"));
        assertTrue(reasons.toString().contains("no-port-candidate"));
    }

    @Test
    public void sameNameDifferentCardsRemainSeparateWithoutSerializingAddress() throws Exception {
        List<DidiLocalStationParser.StationRecord> stations = GenericStationParser.extract(
                Arrays.asList(
                        exact("特来电同名测试充电站", .05f, .20f, .70f, .03f),
                        exact("西安市雁塔区甲路1号", .05f, .24f, .60f, .03f),
                        exact("¥0.88/度", .05f, .29f, .25f, .03f),
                        exact("特来电同名测试充电站", .05f, .50f, .70f, .03f),
                        exact("西安市雁塔区乙路2号", .05f, .54f, .60f, .03f),
                        exact("快闲3/5", .55f, .59f, .25f, .03f)
                ),
                "generic-charging-test",
                "screen-ocr-manual-scroll"
        );
        assertEquals(2, stations.size());
        new StationObservationTracker().previewChanged(
                "test-session", "page-1", "generic-charging-test", "西安", stations
        );
        assertEquals(0.88d, stations.get(0).priceFast, 0.0001d);
        assertEquals(3, stations.get(1).fastIdlePorts);
        assertEquals(5, stations.get(1).fastTotalPorts);
        org.junit.Assert.assertNotEquals(stations.get(0).captureContextId, stations.get(1).captureContextId);
        assertTrue(stations.get(0).toJson().has("address"));
        assertTrue(stations.get(1).toJson().has("address"));
    }

    @Test
    public void parkingDescriptionNeverBecomesStationEvenNearPrice() {
        assertEquals(0, GenericStationParser.extract(
                Arrays.asList(row("此电站免费停车", 0.28f), row("￥0.86元", 0.34f)),
                "generic-charging-test",
                "screen-ocr-auto-scroll"
        ).size());
    }

    @Test
    public void recursiveCollectorMigrationIsStrictAndPreservesObservedData() throws Exception {
        JSONObject recursive = feedbackRow(false, false, "6.国家电网高新软件园充电站");
        assertTrue(CollectorFeedbackCleanup.shouldRemove(recursive, "2026-07-22T08:44:00.000Z"));
        assertFalse(CollectorFeedbackCleanup.shouldRemove(
                feedbackRow(true, false, "6.国家电网高新软件园充电站"),
                "2026-07-22T08:44:00.000Z"
        ));
        assertFalse(CollectorFeedbackCleanup.shouldRemove(
                feedbackRow(false, true, "6.国家电网高新软件园充电站"),
                "2026-07-22T08:44:00.000Z"
        ));
        assertFalse(CollectorFeedbackCleanup.shouldRemove(recursive, "2026-07-22T09:44:00.000Z"));
        assertFalse(CollectorFeedbackCleanup.shouldRemove(
                feedbackRow(false, false, "西安市雁塔区科技路1号"),
                "2026-07-22T08:44:00.000Z"
        ));
    }

    @Test
    public void recursiveRemovalPersistsEvenWithoutLocalKey() throws Exception {
        JSONObject rowWithoutKey = feedbackRow(false, false, "6.国家电网高新软件园充电站")
                .put("capturedAt", "2026-07-22T08:44:00.000Z");
        List<JSONObject> rows = new ArrayList<>(Arrays.asList(rowWithoutKey));
        CollectorFeedbackCleanup.RemovalResult removal = CollectorFeedbackCleanup.removeRows(rows);
        assertEquals(1, removal.removedRows);
        assertTrue(removal.removedKeys.isEmpty());
        assertTrue(rows.isEmpty());
    }

    private static JSONObject feedbackRow(boolean price, boolean ports, String address) throws Exception {
        return new JSONObject()
                .put("stationName", "国家电网高新软件园充电站")
                .put("address", address)
                .put("priceFast", price ? 0.86d : JSONObject.NULL)
                .put("fastTotalPorts", ports ? 4 : 0)
                .put("raw", new JSONObject()
                        .put("localParser", "generic-android")
                        .put("observed", new JSONObject()
                                .put("price", price)
                                .put("ports", ports)
                                .put("busy", ports)));
    }

    private static OcrRow row(String text, float y) {
        return new OcrRow(text, 1f, 0.05f, y, 0.8f, 0.035f);
    }

    private static OcrRow exact(String text, float x, float y, float width, float height) {
        return new OcrRow(text, 1f, x, y, width, height);
    }
}
