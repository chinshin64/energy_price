package com.datafordidi.mobilecollector;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

final class PortSignalParser {
    private static final Pattern RATIO = Pattern.compile("(超|快|慢).{0,6}(?:闲|空闲|空|可用|固闲|国闲|间)\\s*\\d+\\s*/\\s*\\d+");

    private PortSignalParser() {
    }

    static int candidateCount(String input) {
        Matcher matcher = RATIO.matcher(compact(input));
        int count = 0;
        while (matcher.find()) count++;
        return count;
    }

    static boolean hasTypedRatio(String input) {
        return RATIO.matcher(compact(input)).find();
    }

    static String normalizeStrict(String input) {
        String value = compact(input);
        if (!hasTypedRatio(value)) return value;
        return value.replace("固闲", "闲").replace("国闲", "闲")
                .replaceAll("(超|快|慢)(?:充|充电|桩|枪)?间(?=\\d+\\s*/)", "$1闲");
    }

    private static String compact(String value) {
        return value == null ? "" : value.replaceAll("\\s+", "").trim();
    }
}
