package com.chinshin.energyprice.capture;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

/**
 * Resolves missing grades for the same station when exactly two price bands are present:
 * lower display price -> 92#, higher display price -> 95#.
 * Explicitly OCR-selected grades always win.
 */
public final class DisplayPriceGradeResolver {
    private static final double MIN_PRICE_GAP = 0.05d;

    private DisplayPriceGradeResolver() {}

    public static int resolve(List<FuelCapture> captures) {
        if (captures == null) return 0;
        List<FuelCapture> usable = new ArrayList<>();
        for (FuelCapture capture : captures) {
            if (capture != null && capture.displayPrice != null) usable.add(capture);
        }
        if (usable.size() != 2) return 0;

        usable.sort(Comparator.comparingDouble(c -> c.displayPrice));
        FuelCapture lower = usable.get(0);
        FuelCapture higher = usable.get(1);
        if (Math.abs(higher.displayPrice - lower.displayPrice) < MIN_PRICE_GAP) return 0;

        // Reject contradictory explicit OCR results rather than overriding them.
        if (lower.gradeExplicit && !"92".equals(lower.gradeCode)) return 0;
        if (higher.gradeExplicit && !"95".equals(higher.gradeCode)) return 0;

        int changed = 0;
        if (!lower.gradeExplicit && !"92".equals(lower.gradeCode)) {
            lower.gradeCode = "92";
            lower.gradeLabel = "92号汽油";
            changed++;
        }
        if (!higher.gradeExplicit && !"95".equals(higher.gradeCode)) {
            higher.gradeCode = "95";
            higher.gradeLabel = "95号汽油";
            changed++;
        }
        return changed;
    }
}
