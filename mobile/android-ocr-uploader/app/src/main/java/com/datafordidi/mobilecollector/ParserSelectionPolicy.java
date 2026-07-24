package com.datafordidi.mobilecollector;

import java.util.List;
import java.util.Locale;

final class ParserSelectionPolicy {
    private ParserSelectionPolicy() {
    }

    static boolean preferSpecialized(
            String platform,
            String packageName,
            String pageText,
            List<DidiLocalStationParser.StationRecord> specialized,
            List<DidiLocalStationParser.StationRecord> generic
    ) {
        if (specialized == null || specialized.isEmpty()) return false;
        String pkg = compact(packageName).toLowerCase(Locale.ROOT);
        String text = compact(pageText);
        boolean brandEvidence = "amap-charging".equals(platform)
                ? pkg.equals("com.autonavi.minimap") || text.contains("高德地图") || text.contains("高德红包")
                : "didi-charging".equals(platform)
                && (pkg.equals("com.sdu.didi.psnger") || pkg.equals("com.didapinche.booking")
                || text.contains("滴滴充电") || text.contains("小桔充电"));
        if (!brandEvidence) return false;
        return score(specialized) >= Math.max(1, score(generic) / 2);
    }

    private static int score(List<DidiLocalStationParser.StationRecord> stations) {
        int score = 0;
        if (stations == null) return score;
        for (DidiLocalStationParser.StationRecord station : stations) {
            score += 2;
            if (station.priceObserved) score += 2;
            if (station.portsObserved) score += 2;
        }
        return score;
    }

    private static String compact(String value) {
        return value == null ? "" : value.replaceAll("\\s+", "").trim();
    }
}
