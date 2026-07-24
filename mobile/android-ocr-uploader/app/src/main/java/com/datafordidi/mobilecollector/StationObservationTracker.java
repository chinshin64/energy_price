package com.datafordidi.mobilecollector;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

final class StationObservationTracker {
    private final Map<String, String> fingerprints = new LinkedHashMap<>();
    private final StableCardIdentityResolver identityResolver = new StableCardIdentityResolver();

    List<DidiLocalStationParser.StationRecord> changed(
            String sessionId,
            String pageSignal,
            String platform,
            String city,
            List<DidiLocalStationParser.StationRecord> stations
    ) {
        List<DidiLocalStationParser.StationRecord> output = previewChanged(
                sessionId, pageSignal, platform, city, stations
        );
        commit(sessionId, pageSignal, platform, city, output);
        return output;
    }

    List<DidiLocalStationParser.StationRecord> previewChanged(
            String sessionId,
            String pageSignal,
            String platform,
            String city,
            List<DidiLocalStationParser.StationRecord> stations
    ) {
        List<DidiLocalStationParser.StationRecord> output = new ArrayList<>();
        if (stations == null) return output;
        identityResolver.resolveScreen(sessionId, pageSignal, platform, city, stations);
        for (DidiLocalStationParser.StationRecord station : stations) {
            if (station == null || station.stationName == null || station.stationName.trim().isEmpty()) continue;
            String identity = LocalStationStore.buildKey(
                    platform, city, station.stationName, station.captureContextId
            );
            identity = scopedIdentity(sessionId, identity);
            String fingerprint = fingerprint(station);
            if (!fingerprint.equals(fingerprints.get(identity))) output.add(station);
        }
        return output;
    }

    void commit(
            String sessionId,
            String pageSignal,
            String platform,
            String city,
            List<DidiLocalStationParser.StationRecord> stations
    ) {
        if (stations == null) return;
        identityResolver.resolveScreen(sessionId, pageSignal, platform, city, stations);
        for (DidiLocalStationParser.StationRecord station : stations) {
            if (station == null || station.stationName == null || station.stationName.trim().isEmpty()) continue;
            String identity = LocalStationStore.buildKey(
                    platform, city, station.stationName, station.captureContextId
            );
            identity = scopedIdentity(sessionId, identity);
            fingerprints.put(identity, fingerprint(station));
        }
    }

    static String fingerprint(DidiLocalStationParser.StationRecord station) {
        return value(station.priceFast)
                + "|" + value(station.priceSlow)
                + "|" + value(station.priceSuper)
                + "|" + value(station.priceService)
                + "|" + CardIdentityPolicy.normalizeTemporaryIdentity(station.address)
                + "|" + station.fastIdlePorts + "/" + station.fastTotalPorts
                + "|" + station.slowIdlePorts + "/" + station.slowTotalPorts
                + "|" + station.superIdlePorts + "/" + station.superTotalPorts
                + "|" + station.portsObserved
                + "|" + station.priceObserved;
    }

    private static String value(Double value) {
        return value == null ? "-" : String.valueOf(value);
    }

    private static String scopedIdentity(String sessionId, String stationIdentity) {
        String session = sessionId == null ? "" : sessionId.replaceAll("\\s+", "").trim();
        if (session.isEmpty()) throw new IllegalArgumentException("sessionId is required");
        return session + "|" + stationIdentity;
    }

}
