package com.datafordidi.mobilecollector;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Builds the exact production observation shape before any local/outbox persistence.
 */
final class StationSafetyPartition {
    private StationSafetyPartition() {
    }

    static Result<DidiLocalStationParser.StationRecord> charging(
            List<DidiLocalStationParser.StationRecord> candidates,
            String city
    ) {
        List<DidiLocalStationParser.StationRecord> safe = new ArrayList<>();
        int rejected = 0;
        if (candidates != null) for (DidiLocalStationParser.StationRecord station : candidates) {
            if (station == null) {
                rejected++;
                continue;
            }
            try {
                JSONObject observation = ObservationEnvelope.charging(station, city);
                StationSensitiveDataPolicy.requireSafeUserDerived(observation);
                safe.add(station);
            } catch (RuntimeException ignored) {
                rejected++;
            }
        }
        return new Result<>(safe, rejected, false);
    }

    static Result<FuelStationRecord> fuel(
            List<FuelStationRecord> candidates,
            String city
    ) {
        List<FuelStationRecord> preliminary = new ArrayList<>();
        int rejected = 0;
        if (candidates != null) for (FuelStationRecord station : candidates) {
            if (station == null) {
                rejected++;
                continue;
            }
            try {
                JSONObject observation = station.observationJson(
                        city,
                        FuelQuoteFeatureGate.requiresFeature(station)
                );
                StationSensitiveDataPolicy.requireSafeUserDerived(observation);
                preliminary.add(station);
            } catch (RuntimeException ignored) {
                rejected++;
            }
        }

        boolean quoteFeatureRequired = requiresQuoteFeature(preliminary);
        List<FuelStationRecord> safe = new ArrayList<>();
        for (FuelStationRecord station : preliminary) {
            try {
                JSONObject observation = station.observationJson(city, quoteFeatureRequired);
                StationSensitiveDataPolicy.requireSafeUserDerived(observation);
                safe.add(station);
            } catch (RuntimeException ignored) {
                rejected++;
            }
        }
        return new Result<>(safe, rejected, requiresQuoteFeature(safe));
    }

    private static boolean requiresQuoteFeature(List<FuelStationRecord> stations) {
        if (stations != null) for (FuelStationRecord station : stations) {
            if (FuelQuoteFeatureGate.requiresFeature(station)) return true;
        }
        return false;
    }

    static final class Result<T> {
        final List<T> safe;
        final int rejectedCount;
        final boolean quoteFeatureRequired;

        Result(List<T> safe, int rejectedCount, boolean quoteFeatureRequired) {
            this.safe = Collections.unmodifiableList(new ArrayList<>(safe));
            this.rejectedCount = Math.max(0, rejectedCount);
            this.quoteFeatureRequired = quoteFeatureRequired;
        }

        boolean allRejected() {
            return safe.isEmpty() && rejectedCount > 0;
        }
    }
}
