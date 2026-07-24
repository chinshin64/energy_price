package com.datafordidi.mobilecollector;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import java.util.Arrays;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class StationResultPresenterTest {
    @Test
    public void statisticsAndFiltersUsePriceOrGunMissingRule() throws Exception {
        JSONObject complete = row("完整充电站", "ctx-a", "session-a", 1, "2026-07-22T10:00:00Z")
                .put("priceFast", 1.2d).put("fastIdlePorts", 2).put("fastTotalPorts", 4)
                .put("syncState", "synced");
        JSONObject missingPrice = row("缺价格充电站", "ctx-b", "session-a", 1, "2026-07-22T10:01:00Z")
                .put("fastIdlePorts", 1).put("fastTotalPorts", 3).put("syncState", "pending");
        JSONObject missingGuns = row("缺枪数充电站", "ctx-c", "session-a", 1, "2026-07-22T10:02:00Z")
                .put("priceSlow", 0.88d).put("syncState", "failed");

        StationResultPresenter.ViewState all = StationResultPresenter.present(
                Arrays.asList(complete, missingPrice, missingGuns), StationResultPresenter.Filter.ALL
        );
        assertEquals(3, all.validStations);
        assertEquals(2, all.withPrice);
        assertEquals(2, all.withGuns);
        assertEquals(2, all.incomplete);
        assertEquals(2, all.pending);
        assertEquals(3, all.rows.size());
        assertEquals(1, StationResultPresenter.present(
                Arrays.asList(complete, missingPrice, missingGuns), StationResultPresenter.Filter.COMPLETE
        ).rows.size());
        assertEquals(2, StationResultPresenter.present(
                Arrays.asList(complete, missingPrice, missingGuns), StationResultPresenter.Filter.INCOMPLETE
        ).rows.size());
    }

    @Test
    public void latestSnapshotWinsWhileSameNameContextsStaySeparate() throws Exception {
        JSONObject oldA = row("同名充电站", "ctx-a", "session-old", 1, "2026-07-22T09:00:00Z")
                .put("priceFast", 0.8d);
        JSONObject latestA = row("同名充电站", "ctx-a", "session-new", 3, "2026-07-22T11:00:00Z")
                .put("priceFast", 1.1d);
        JSONObject contextB = row("同名充电站", "ctx-b", "session-new", 3, "2026-07-22T10:30:00Z")
                .put("priceFast", 1.3d);

        List<JSONObject> latest = StationResultPresenter.latestByStableIdentity(
                Arrays.asList(oldA, contextB, latestA)
        );
        assertEquals(2, latest.size());
        assertEquals(1.1d, latest.get(0).getDouble("priceFast"), 0.0001d);
        assertEquals(1.3d, latest.get(1).getDouble("priceFast"), 0.0001d);
    }

    @Test
    public void cardFormatterShowsAddressAndNeverUsesFailureDetail() throws Exception {
        JSONObject row = row("很长很长的测试充电站名称", "ctx-a", "session-a", 1, "2026-07-22T10:00:00Z")
                .put("priceFast", 1.5000d)
                .put("fastIdlePorts", 19).put("fastTotalPorts", 23)
                .put("slowIdlePorts", 0).put("slowTotalPorts", 5)
                .put("syncState", "failed")
                .put("syncMessage", "内部失败详情不得展示")
                .put("address", "长沙市岳麓区测试路1号");
        JSONObject safe = AddressFreePayload.copyObject(row);

        assertEquals("¥1.5/度", StationDisplayFormatter.mainPrice(safe));
        assertTrue(StationDisplayFormatter.portSummary(safe).contains("闲 19 / 忙 9 / 总 28"));
        assertTrue(StationDisplayFormatter.portSummary(safe).contains("快：闲 19 / 总 23"));
        assertEquals("待重试", StationDisplayFormatter.syncStatus(safe));
        assertEquals("长沙市岳麓区测试路1号", StationDisplayFormatter.address(safe));
        assertFalse(StationDisplayFormatter.syncStatus(safe).contains("内部失败详情"));
        assertTrue(StationDisplayFormatter.incomplete(new JSONObject().put("priceFast", 1.0d)));
    }

    @Test
    public void zeroPortsRequireExplicitOcrObservationEvidence() throws Exception {
        JSONObject legacyUnknown = row(
                "旧记录枪数未知充电站", "ctx-zero-legacy", "session-a", 1, "2026-07-22T10:00:00Z"
        ).put("availablePorts", 0)
                .put("busyPorts", 0)
                .put("totalPorts", 0);

        assertFalse(StationDisplayFormatter.hasPorts(legacyUnknown));
        assertEquals("枪状态待补全", StationDisplayFormatter.portSummary(legacyUnknown));
        assertTrue(StationDisplayFormatter.incomplete(legacyUnknown));

        JSONObject observedZero = new JSONObject(legacyUnknown.toString())
                .put("raw", new JSONObject().put(
                        "observed",
                        new JSONObject().put("ports", true).put("busy", true)
                ));

        assertTrue(StationDisplayFormatter.hasPorts(observedZero));
        assertTrue(StationDisplayFormatter.portSummary(observedZero).contains("闲 0 / 忙 0 / 总 0"));
    }

    @Test
    public void manualRevisionWinsOverNewOcrUntilDurableAckRemovesIt() throws Exception {
        JSONObject ocr = row("需回填充电站", "ctx-a", "session-new", 2, "2026-07-22T12:00:00Z")
                .put("priceFast", 1.2d);
        String identity = StationIdentity.fromRow(ocr, 0);
        JSONObject manual = row("需回填充电站", "ctx-a", "session-old", 1, "2026-07-22T10:00:00Z")
                .put("localKey", StationIdentity.manualLocalKey(identity, "edit-a", 2))
                .put("priceFast", 1.1d)
                .put("fastIdlePorts", 2).put("fastTotalPorts", 4)
                .put("backfilledAt", "2026-07-22T11:00:00Z")
                .put("syncState", "failed")
                .put("raw", new JSONObject().put("manualBackfill", true));

        List<JSONObject> latest = StationResultPresenter.latestByStableIdentity(Arrays.asList(ocr, manual));
        assertEquals(1, latest.size());
        assertEquals(1.1d, latest.get(0).getDouble("priceFast"), 0.0001d);
        assertEquals("回填完成·待回传", StationDisplayFormatter.syncStatus(latest.get(0)));
        assertTrue(StationDisplayFormatter.canEditBackfill(latest.get(0)));
        assertEquals("编辑回填：需回填充电站", StationDisplayFormatter.editDescription(latest.get(0)));
        assertFalse(StationDisplayFormatter.canEditBackfill(
                row("普通完整场站", "ctx-b", "session-new", 2, "2026-07-22T12:00:00Z")
                        .put("priceFast", 1.2d).put("fastTotalPorts", 4)
        ));
    }

    @Test
    public void filtersFuelWithoutRenderingChargingGunSemantics() throws Exception {
        JSONObject charging = row(
                "普通充电站", "ctx-charge", "session-a", 1, "2026-07-23T03:00:00Z"
        ).put("priceFast", 1.0d).put("fastTotalPorts", 2);
        JSONObject fuel = new JSONObject()
                .put("schemaVersion", 2)
                .put("stationType", "fuel")
                .put("platform", "tuanyou")
                .put("city", "杭州")
                .put("stationName", "测试加油站")
                .put("capturedAt", "2026-07-23T03:01:00Z")
                .put("fuelObservation", new JSONObject()
                        .put("fuelOffers", new JSONArray().put(new JSONObject()
                                .put("gradeLabel", "95#")
                                .put("discountPrice", 7.5)
                                .put("listPrice", 7.9))));
        StationResultPresenter.ViewState fuelOnly = StationResultPresenter.present(
                Arrays.asList(charging, fuel), StationResultPresenter.Filter.FUEL
        );
        assertEquals(1, fuelOnly.rows.size());
        assertEquals(1, fuelOnly.fuelOfferCount);
        assertEquals(0, fuelOnly.withGuns);
        assertTrue(StationDisplayFormatter.fuelOfferSummary(fuel).contains("元/升"));
        assertFalse(StationDisplayFormatter.fuelOfferSummary(fuel).contains("枪"));
        assertFalse(StationDisplayFormatter.fuelOfferSummary(fuel).contains("元/度"));
    }

    @Test
    public void fuelQuoteCardShowsProviderThreePricesAndExpectedPaymentWithoutChargingSemantics()
            throws Exception {
        JSONObject row = FuelQuoteTest.stationWithQuote().localRow("西安");
        row.put("syncState", "pending");
        StationResultPresenter.ViewState fuelOnly = StationResultPresenter.present(
                Arrays.asList(row),
                StationResultPresenter.Filter.FUEL
        );
        assertEquals(1, fuelOnly.fuelStationsWithOffers);
        assertEquals(1, fuelOnly.fuelStationsWithQuotes);
        assertEquals(1, fuelOnly.fuelQuoteCount);
        String details = StationDisplayFormatter.fuelDetails(row);
        assertTrue(details.contains("服务商：测试服务商"));
        assertTrue(details.contains("外显 6.63 元/升"));
        assertTrue(details.contains("油站 7.86 元/升"));
        assertTrue(details.contains("国标 8.12 元/升"));
        assertFalse(details.contains("优惠价 6.63 元/升"));
        assertFalse(details.contains("挂牌价 7.86 元/升"));
        assertTrue(details.contains("优惠 ¥20.65"));
        assertTrue(details.contains("服务费 ¥3.30"));
        assertTrue(details.contains("预计实付 ¥182.65"));
        assertFalse(details.contains("元/度"));
        assertFalse(details.contains("枪：闲"));
    }

    private static JSONObject row(
            String name,
            String context,
            String session,
            int page,
            String capturedAt
    ) throws Exception {
        String base = LocalStationStore.buildKey("generic-charging-test", "长沙", name, context);
        return new JSONObject()
                .put("platform", "generic-charging-test")
                .put("city", "长沙")
                .put("stationName", name)
                .put("address", "长沙市测试路" + page + "号")
                .put("sessionId", session)
                .put("pageIndex", page)
                .put("capturedAt", capturedAt)
                .put("localKey", base + "|" + session + "|" + page);
    }
}
