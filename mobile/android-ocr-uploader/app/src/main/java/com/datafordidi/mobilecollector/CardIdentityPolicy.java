package com.datafordidi.mobilecollector;

final class CardIdentityPolicy {
    private CardIdentityPolicy() {
    }

    static String transientCardKey(OcrRow title, String temporaryAddress) {
        int xBucket = title == null ? -1 : Math.round(title.x * 20f);
        int yBucket = title == null ? -1 : Math.round(title.y * 40f);
        String addressHash = compact(temporaryAddress).isEmpty()
                ? "-"
                : DeviceIdentity.sha256(compact(temporaryAddress)).substring(0, 12);
        return xBucket + ":" + yBucket + ":" + addressHash;
    }

    static void attachTransientIdentity(
            DidiLocalStationParser.StationRecord station,
            OcrRow title,
            String temporaryAddress
    ) {
        if (station == null) return;
        station.address = StationObservationV3.sanitizeAddress(temporaryAddress);
        station.transientCardKey = transientCardKey(title, temporaryAddress);
        station.transientIdentityText = normalizeTemporaryIdentity(temporaryAddress);
        int column = title == null ? -1 : Math.round((title.x + title.width / 2f) * 4f);
        station.transientStaticSignature = compact(station.localParser) + ":column-" + column;
    }

    static String normalizeTemporaryIdentity(String value) {
        return compact(value)
                .replaceAll("[·•．,，。;；:：'\"`|丨]", "")
                .replaceAll("\\d+(?:\\.\\d+)?(?:米|m|km|公里)$", "")
                .toLowerCase(java.util.Locale.ROOT)
                .replaceAll("[il]", "1")
                .replace('〇', '0');
    }

    private static String compact(String value) {
        return value == null ? "" : value.replaceAll("\\s+", "").trim();
    }
}
