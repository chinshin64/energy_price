package com.datafordidi.mobilecollector;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.List;

final class PriceEvidence {
    private static final int MAX_ITEMS = 8;

    private PriceEvidence() {
    }

    static void add(
            DidiLocalStationParser.StationRecord station,
            EnergyPriceParser.Match match,
            OcrRow row
    ) {
        if (station == null || match == null || row == null) return;
        if (station.priceEvidence == null) station.priceEvidence = new JSONArray();
        if (station.priceEvidence.length() >= MAX_ITEMS) return;
        try {
            station.priceEvidence.put(new JSONObject()
                    .put("text", match.snippet)
                    .put("format", match.format)
                    .put("type", match.type)
                    .put("boundingBox", new JSONObject()
                            .put("x", bounded(row.x))
                            .put("y", bounded(row.y))
                            .put("width", bounded(row.width))
                            .put("height", bounded(row.height))));
        } catch (Exception ignored) {
            // Price evidence is optional and must never block a structured station result.
        }
    }

    static OcrRow union(List<OcrRow> rows, int start, int end, String text) {
        float left = 1f;
        float top = 1f;
        float right = 0f;
        float bottom = 0f;
        for (int index = start; index < end; index++) {
            OcrRow row = rows.get(index);
            left = Math.min(left, row.x);
            top = Math.min(top, row.y);
            right = Math.max(right, row.x + row.width);
            bottom = Math.max(bottom, row.y + row.height);
        }
        return new OcrRow(text, 1f, left, top, Math.max(0f, right - left), Math.max(0f, bottom - top));
    }

    private static double bounded(float value) {
        return Math.max(0d, Math.min(1d, value));
    }
}
