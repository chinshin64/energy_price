package com.chinshin.energyprice.capture;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

import java.util.Arrays;

public final class DisplayPriceGradeResolverTest {
    @Test
    public void lowerDisplayPriceIs92AndHigherIs95() {
        FuelCapture lower = new FuelCapture();
        lower.stationName = "浙江石油塘河供能加油站";
        lower.displayPrice = 7.19;

        FuelCapture higher = new FuelCapture();
        higher.stationName = "浙江石油塘河供能加油站";
        higher.displayPrice = 7.66;

        assertEquals(2, DisplayPriceGradeResolver.resolve(Arrays.asList(higher, lower)));
        assertEquals("92", lower.gradeCode);
        assertEquals("95", higher.gradeCode);
    }

    @Test
    public void explicitGradesAreNotOverwritten() {
        FuelCapture lower = new FuelCapture();
        lower.displayPrice = 7.19;
        lower.gradeCode = "92";
        lower.gradeLabel = "92号汽油";
        lower.gradeExplicit = true;

        FuelCapture higher = new FuelCapture();
        higher.displayPrice = 7.66;
        higher.gradeCode = "95";
        higher.gradeLabel = "95号汽油";
        higher.gradeExplicit = true;

        assertEquals(0, DisplayPriceGradeResolver.resolve(Arrays.asList(lower, higher)));
        assertEquals("92", lower.gradeCode);
        assertEquals("95", higher.gradeCode);
    }

    @Test
    public void equalPricesAreNotInferred() {
        FuelCapture first = new FuelCapture();
        first.displayPrice = 7.66;
        FuelCapture second = new FuelCapture();
        second.displayPrice = 7.67;

        assertEquals(0, DisplayPriceGradeResolver.resolve(Arrays.asList(first, second)));
    }
}
