package com.datafordidi.mobilecollector;

import org.json.JSONObject;
import org.junit.Test;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class StationRecordFilterTest {
    private static final long TEN = 1_786_000_000_000L;
    private static final long TWENTY = 1_786_000_010_000L;
    private static final long THIRTY = 1_786_000_020_000L;

    @Test
    public void nameSearchUsesContainsRootLocaleAndWhitespaceNormalization() throws Exception {
        JSONObject chinese = row(" 中海联  石油城西加油站 ", TEN, "fuel");
        JSONObject english = row("West Lake ENERGY 01", TWENTY, "charging");

        assertEquals(1, new StationRecordFilter("海联 石油", null, null)
                .apply(Arrays.asList(chinese, english)).size());
        assertEquals(1, new StationRecordFilter("lake energy", null, null)
                .apply(Arrays.asList(chinese, english)).size());
        assertEquals(" 中海联  石油城西加油站 ", chinese.getString("stationName"));
    }

    @Test
    public void nameFallsBackToCommonThenFuelObservation() throws Exception {
        JSONObject common = new JSONObject()
                .put("stationType", "charging")
                .put("capturedAt", iso(TEN))
                .put("stationObservation", new JSONObject().put("stationName", "嵌套充电场站"));
        JSONObject fuel = new JSONObject()
                .put("stationType", "fuel")
                .put("capturedAt", iso(TWENTY))
                .put("fuelObservation", new JSONObject().put("stationName", "嵌套加油站"));

        assertEquals(1, new StationRecordFilter("充电场", null, null)
                .apply(Arrays.asList(common, fuel)).size());
        assertEquals(1, new StationRecordFilter("加油", null, null)
                .apply(Arrays.asList(common, fuel)).size());
    }

    @Test
    public void timeConditionsAreInclusiveAndCanBeSetIndependently() throws Exception {
        List<JSONObject> rows = Arrays.asList(
                row("十秒", TEN, "charging"),
                row("二十秒", TWENTY, "charging"),
                row("三十秒", THIRTY, "charging")
        );

        assertEquals(2, new StationRecordFilter("", TWENTY, null).apply(rows).size());
        assertEquals(2, new StationRecordFilter("", null, TWENTY).apply(rows).size());
        List<JSONObject> boundary = new StationRecordFilter("", TWENTY, TWENTY).apply(rows);
        assertEquals(1, boundary.size());
        assertEquals("二十秒", boundary.get(0).getString("stationName"));
    }

    @Test
    public void invalidCapturedAtIsKeptWithoutTimeConditionAndExcludedWithOne() throws Exception {
        JSONObject legacy = new JSONObject()
                .put("stationName", "历史场站")
                .put("stationType", "charging")
                .put("capturedAt", "not-a-time");

        assertEquals(1, StationRecordFilter.EMPTY.apply(Collections.singletonList(legacy)).size());
        assertTrue(new StationRecordFilter("", TEN, null)
                .apply(Collections.singletonList(legacy)).isEmpty());
    }

    @Test
    public void typeNameAndTimeComposeWithAndSemantics() throws Exception {
        JSONObject target = row("中海联石油城西加油站", TWENTY, "fuel");
        JSONObject wrongType = row("中海联充电场站", TWENTY, "charging");
        JSONObject wrongName = row("其他加油站", TWENTY, "fuel");
        JSONObject wrongTime = row("中海联过期加油站", TEN, "fuel");
        List<JSONObject> matched = new StationRecordFilter("中海联", TWENTY, THIRTY)
                .apply(Arrays.asList(target, wrongType, wrongName, wrongTime));

        StationResultPresenter.ViewState state = StationResultPresenter.present(
                matched,
                StationResultPresenter.Filter.FUEL
        );
        assertEquals(1, state.rows.size());
        assertEquals("中海联石油城西加油站", state.rows.get(0).getString("stationName"));
    }

    @Test
    public void validatesRangeAndReportsActiveState() {
        assertTrue(StationRecordFilter.isValidRange(TEN, TEN));
        assertFalse(StationRecordFilter.isValidRange(TWENTY, TEN));
        assertFalse(StationRecordFilter.EMPTY.isActive());
        assertTrue(new StationRecordFilter("站", null, null).isActive());
        assertTrue(new StationRecordFilter("", TEN, null).isActive());
    }

    @Test(expected = IllegalArgumentException.class)
    public void constructorRejectsEndBeforeStart() {
        new StationRecordFilter("", TWENTY, TEN);
    }

    private static JSONObject row(String name, long capturedAt, String type) throws Exception {
        return new JSONObject()
                .put("stationName", name)
                .put("stationType", type)
                .put("platform", "fuel".equals(type) ? "amap-fuel" : "didi-charging")
                .put("city", "杭州")
                .put("localKey", name + "|" + capturedAt)
                .put("capturedAt", iso(capturedAt));
    }

    private static String iso(long epochMillis) {
        return java.time.Instant.ofEpochMilli(epochMillis).toString();
    }
}
