package com.datafordidi.mocklocation;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class CoordinateValidatorTest {
    @Test
    public void parsesValidCoordinates() {
        GeoCoordinate coordinate = CoordinateValidator.parse(" 34.341600 ", "108.939800");

        assertEquals(34.341600d, coordinate.latitude(), 0.000001d);
        assertEquals(108.939800d, coordinate.longitude(), 0.000001d);
        assertEquals("34.341600", coordinate.latitudeText());
        assertEquals("108.939800", coordinate.longitudeText());
    }

    @Test
    public void rejectsInvalidOrNonFiniteCoordinates() {
        assertThrows(IllegalArgumentException.class, () -> CoordinateValidator.parse("91", "120"));
        assertThrows(IllegalArgumentException.class, () -> CoordinateValidator.parse("30", "181"));
        assertThrows(IllegalArgumentException.class, () -> CoordinateValidator.parse("NaN", "120"));
        assertThrows(IllegalArgumentException.class, () -> CoordinateValidator.parse("", "120"));
    }

    @Test
    public void acceptsBoundaryCoordinatesOnly() {
        assertTrue(CoordinateValidator.isValid(-90.0d, -180.0d));
        assertTrue(CoordinateValidator.isValid(90.0d, 180.0d));
        assertFalse(CoordinateValidator.isValid(-90.000001d, 0.0d));
        assertFalse(CoordinateValidator.isValid(0.0d, 180.000001d));
    }

    @Test
    public void mapStyleUsesHttpsTilesAndVisibleAttributionMetadata() {
        String style = MapStyleFactory.osmRasterStyle();

        assertEquals("https://tiles.openfreemap.org/styles/liberty", MapStyleFactory.defaultStyleUrl());
        assertTrue(style.contains("https://tile.openstreetmap.org/{z}/{x}/{y}.png"));
        assertTrue(style.contains("OpenStreetMap contributors"));
        assertFalse(style.contains("http://tile.openstreetmap.org"));
    }
}
