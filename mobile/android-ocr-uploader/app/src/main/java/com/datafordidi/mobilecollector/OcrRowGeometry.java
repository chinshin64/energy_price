package com.datafordidi.mobilecollector;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

/**
 * Adds synthetic rows for text fragments that share the same visual baseline.
 *
 * <p>ML Kit may split one visual line when adjacent text uses different colors or font sizes.
 * Original rows are preserved; merged rows are only additional parsing candidates.
 */
final class OcrRowGeometry {
    private static final float MIN_BASELINE_TOLERANCE = 0.012f;
    private static final float MAX_BASELINE_TOLERANCE = 0.030f;

    private OcrRowGeometry() {
    }

    static List<OcrRow> withSameLineMerges(List<OcrRow> source) {
        List<OcrRow> original = new ArrayList<>(source == null ? new ArrayList<>() : source);
        original.sort(Comparator.comparingDouble((OcrRow row) -> row.y).thenComparingDouble(row -> row.x));
        List<List<OcrRow>> groups = new ArrayList<>();
        for (OcrRow row : original) {
            if (row == null || row.text == null || row.text.trim().isEmpty()) continue;
            List<OcrRow> group = groups.isEmpty() ? null : groups.get(groups.size() - 1);
            if (group == null || !sameVisualLine(group.get(0), row)) {
                group = new ArrayList<>();
                groups.add(group);
            }
            group.add(row);
        }

        List<OcrRow> output = new ArrayList<>(original);
        for (List<OcrRow> group : groups) {
            if (group.size() < 2) continue;
            group.sort(Comparator.comparingDouble(row -> row.x));
            StringBuilder text = new StringBuilder();
            float left = 1f;
            float top = 1f;
            float right = 0f;
            float bottom = 0f;
            float confidence = 1f;
            for (OcrRow row : group) {
                text.append(row.text == null ? "" : row.text.trim());
                left = Math.min(left, row.x);
                top = Math.min(top, row.y);
                right = Math.max(right, row.x + row.width);
                bottom = Math.max(bottom, row.y + row.height);
                confidence = Math.min(confidence, row.confidence);
            }
            if (text.length() == 0) continue;
            output.add(new OcrRow(
                    text.toString(),
                    confidence,
                    left,
                    top,
                    Math.max(0f, right - left),
                    Math.max(0f, bottom - top)
            ));
        }
        output.sort(Comparator.comparingDouble((OcrRow row) -> row.y).thenComparingDouble(row -> row.x));
        return output;
    }

    private static boolean sameVisualLine(OcrRow first, OcrRow second) {
        float firstCenter = first.y + first.height / 2f;
        float secondCenter = second.y + second.height / 2f;
        float tolerance = Math.max(
                MIN_BASELINE_TOLERANCE,
                Math.min(MAX_BASELINE_TOLERANCE, Math.max(first.height, second.height) * 0.65f)
        );
        return Math.abs(firstCenter - secondCenter) <= tolerance;
    }
}
