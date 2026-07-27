package com.datafordidi.mobilecollector;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class GuidedFuelCaptureStateTest {

    @Test
    public void defaultsTo92ThenAdvancesTo95AndDone() {
        GuidedFuelCaptureState state = new GuidedFuelCaptureState();

        assertEquals("92", state.expectedGrade());
        assertTrue(state.markCaptured("92", "浙江石油塘河供能加油站"));
        assertEquals("95", state.expectedGrade());
        assertTrue(state.markCaptured("95", "浙江石油塘河供能加油站"));
        assertTrue(state.done());
    }

    @Test
    public void eitherGradeCanBeSkippedWithoutCreatingAStationBinding() {
        GuidedFuelCaptureState state = new GuidedFuelCaptureState();

        assertTrue(state.skip("92"));
        assertEquals("95", state.expectedGrade());
        assertTrue(state.markCaptured("95", "只有95号的油站"));
        assertTrue(state.done());

        state.reset();
        assertTrue(state.markCaptured("92", "只有92号的油站"));
        assertTrue(state.skip("95"));
        assertTrue(state.done());
    }

    @Test
    public void blocksWrongStageAndCrossStationCapture() {
        GuidedFuelCaptureState state = new GuidedFuelCaptureState();

        assertFalse(state.markCaptured("95", "甲加油站"));
        assertTrue(state.markCaptured("92", "甲加油站"));
        assertFalse(state.markCaptured("95", "乙加油站"));
        assertEquals("95", state.expectedGrade());
        assertFalse(state.done());
    }

    @Test
    public void canonicalizesSmallOcrDifferenceAndKeepsFirstIdentity() {
        GuidedFuelCaptureState state = new GuidedFuelCaptureState();
        FuelStationRecord grade92 = station(
                "浙江石油塘河供能加油站",
                "context-92"
        );
        FuelStationRecord grade95 = station(
                "在浙江石油石马供能加油站附近搜",
                "context-95"
        );

        assertTrue(state.markCaptured("92", grade92));
        assertTrue(state.canonicalize(grade95));
        assertEquals("浙江石油塘河供能加油站", grade95.stationName);
        assertEquals("context-92", grade95.captureContextId);
        assertEquals("在浙江石油石马供能加油站附近搜", grade95.observedStationName);
        assertEquals("guided-session-ocr-fuzzy", grade95.stationNameMatchMethod);
        assertTrue(state.markCaptured("95", grade95));
    }

    @Test
    public void rejectsDigitConflictAndLargeNameDifference() {
        GuidedFuelCaptureState state = new GuidedFuelCaptureState();

        assertTrue(state.markCaptured("92", "中石化城东第1加油站"));
        assertFalse(state.acceptsStation("中石化城东第2加油站"));
        assertFalse(state.acceptsStation("中国石油西湖大道中心加油站"));
    }

    private static FuelStationRecord station(String name, String context) {
        FuelStationRecord station = new FuelStationRecord();
        station.stationName = name;
        station.captureContextId = context;
        return station;
    }
}
