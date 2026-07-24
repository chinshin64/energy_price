package com.datafordidi.mocklocation;

public final class MapStyleFactory {
    private MapStyleFactory() {
    }

    public static String defaultStyleUrl() {
        return BuildConfig.MAP_STYLE_URL;
    }

    // Dependency-free diagnostic style for installations that provide an
    // OpenStreetMap-compatible raster endpoint.
    public static String osmRasterStyle() {
        return "{"
                + "\"version\":8,"
                + "\"name\":\"OpenStreetMap\","
                + "\"sources\":{\"osm\":{"
                + "\"type\":\"raster\","
                + "\"tiles\":[\"https://tile.openstreetmap.org/{z}/{x}/{y}.png\"],"
                + "\"tileSize\":256,"
                + "\"maxzoom\":19,"
                + "\"attribution\":\"© OpenStreetMap contributors\""
                + "}},"
                + "\"layers\":[{"
                + "\"id\":\"osm-raster\","
                + "\"type\":\"raster\","
                + "\"source\":\"osm\","
                + "\"minzoom\":0,"
                + "\"maxzoom\":19"
                + "}]"
                + "}";
    }
}
