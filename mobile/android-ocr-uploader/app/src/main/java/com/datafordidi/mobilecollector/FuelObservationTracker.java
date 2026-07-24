package com.datafordidi.mobilecollector;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

final class FuelObservationTracker {
    private final Map<String, String> fingerprints = new LinkedHashMap<>();

    List<FuelStationRecord> previewChanged(
            String sessionId,
            String platform,
            String city,
            List<FuelStationRecord> stations
    ) {
        List<FuelStationRecord> output = new ArrayList<>();
        if (stations == null) return output;
        for (FuelStationRecord station : stations) {
            if (station == null || station.stationName == null || station.stationName.trim().isEmpty()) continue;
            String identity = identity(sessionId, platform, city, station);
            String fingerprint = fingerprint(station);
            if (!fingerprint.equals(fingerprints.get(identity))) output.add(station);
        }
        return output;
    }

    void commit(
            String sessionId,
            String platform,
            String city,
            List<FuelStationRecord> stations
    ) {
        if (stations == null) return;
        for (FuelStationRecord station : stations) {
            if (station == null || station.stationName == null || station.stationName.trim().isEmpty()) continue;
            fingerprints.put(identity(sessionId, platform, city, station), fingerprint(station));
        }
    }

    static String fingerprint(FuelStationRecord station) {
        StringBuilder value = new StringBuilder();
        value.append(station.providerName).append('|');
        for (FuelOffer offer : station.fuelOffers) {
            if (offer == null) continue;
            value.append(offer.gradeCode).append('|')
                    .append(offer.displayPrice).append('|')
                    .append(offer.stationPrice).append('|')
                    .append(offer.nationalPrice).append('|')
                    .append(offer.listPrice).append('|')
                    .append(offer.discountPrice).append('|')
                    .append(offer.unclassifiedPrice).append(';');
        }
        value.append("quotes:");
        for (FuelQuote quote : station.fuelQuotes) {
            if (quote != null) value.append(quote.businessDedupKey()).append(';');
        }
        return DeviceIdentity.sha256(value.toString());
    }

    private static String identity(
            String sessionId,
            String platform,
            String city,
            FuelStationRecord station
    ) {
        String session = sessionId == null ? "" : sessionId.replaceAll("\\s+", "").trim();
        if (session.isEmpty()) throw new IllegalArgumentException("sessionId is required");
        return session + "|" + LocalStationStore.buildFuelKey(
                platform, city, station.stationName, station.captureContextId
        );
    }
}
