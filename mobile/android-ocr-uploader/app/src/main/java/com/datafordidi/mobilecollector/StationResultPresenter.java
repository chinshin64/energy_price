package com.datafordidi.mobilecollector;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

final class StationResultPresenter {
    enum Filter {
        ALL,
        CHARGING,
        FUEL,
        COMPLETE,
        INCOMPLETE
    }

    private StationResultPresenter() {
    }

    static ViewState present(List<JSONObject> snapshots, Filter filter) {
        Filter selected = filter == null ? Filter.ALL : filter;
        List<JSONObject> latest = latestByStableIdentity(snapshots);
        int withPrice = 0;
        int withGuns = 0;
        int incomplete = 0;
        int pending = 0;
        int fuelOfferCount = 0;
        int fuelQuoteCount = 0;
        int fuelStationsWithOffers = 0;
        int fuelStationsWithQuotes = 0;
        List<JSONObject> visible = new ArrayList<>();
        for (JSONObject row : latest) {
            boolean fuel = StationDisplayFormatter.isFuel(row);
            boolean price = StationDisplayFormatter.hasPrice(row);
            boolean guns = StationDisplayFormatter.hasPorts(row);
            boolean needsMore = StationDisplayFormatter.incomplete(row);
            boolean included = selected == Filter.ALL
                    || (selected == Filter.CHARGING && !fuel)
                    || (selected == Filter.FUEL && fuel)
                    || (selected == Filter.COMPLETE && !needsMore)
                    || (selected == Filter.INCOMPLETE && needsMore);
            if (included) {
                visible.add(row);
                if (price) withPrice++;
                if (guns) withGuns++;
                fuelOfferCount += StationDisplayFormatter.fuelOfferCount(row);
                fuelQuoteCount += StationDisplayFormatter.fuelQuoteCount(row);
                if (fuel && StationDisplayFormatter.fuelOfferCount(row) > 0) fuelStationsWithOffers++;
                if (fuel && StationDisplayFormatter.fuelQuoteCount(row) > 0) fuelStationsWithQuotes++;
                if (needsMore) incomplete++;
                if (isPending(row)) pending++;
            }
        }
        return new ViewState(
                visible.size(),
                withPrice,
                withGuns,
                fuelOfferCount,
                fuelQuoteCount,
                fuelStationsWithOffers,
                fuelStationsWithQuotes,
                incomplete,
                pending,
                visible,
                selected
        );
    }

    static List<JSONObject> latestByStableIdentity(List<JSONObject> snapshots) {
        Map<String, IndexedRow> latest = new LinkedHashMap<>();
        if (snapshots != null) {
            for (int index = 0; index < snapshots.size(); index++) {
                JSONObject row = snapshots.get(index);
                if (row == null || compact(StationRecordFilter.stationName(row)).isEmpty()) continue;
                String key = stableIdentity(row, index);
                IndexedRow candidate = new IndexedRow(row, index);
                IndexedRow current = latest.get(key);
                if (current == null) {
                    latest.put(key, candidate);
                } else if (candidate.isNewerThan(current)) {
                    JSONObject value = candidate.manualBackfill == current.manualBackfill
                            ? mergeFuelRows(candidate.value, current.value)
                            : candidate.value;
                    latest.put(key, new IndexedRow(value, candidate.index));
                } else if (candidate.manualBackfill == current.manualBackfill) {
                    latest.put(
                            key,
                            new IndexedRow(
                                    mergeFuelRows(current.value, candidate.value),
                                    current.index
                            )
                    );
                }
            }
        }
        List<IndexedRow> ordered = new ArrayList<>(latest.values());
        ordered.sort(Comparator
                .comparing((IndexedRow value) -> value.capturedAt, Comparator.reverseOrder())
                .thenComparingInt(value -> value.index));
        List<JSONObject> output = new ArrayList<>();
        for (IndexedRow row : ordered) output.add(row.value);
        return output;
    }

    private static JSONObject mergeFuelRows(JSONObject primary, JSONObject supplement) {
        JSONObject output = AddressFreePayload.copyObject(primary);
        if (!"fuel".equals(output.optString("stationType"))
                || supplement == null
                || !"fuel".equals(supplement.optString("stationType"))) {
            return output;
        }
        JSONObject fuel = output.optJSONObject("fuelObservation");
        JSONObject otherFuel = supplement.optJSONObject("fuelObservation");
        if (fuel == null || otherFuel == null) return output;
        try {
            fuel.put(
                    "fuelOffers",
                    mergeGradeArrays(
                            fuel.optJSONArray("fuelOffers"),
                            otherFuel.optJSONArray("fuelOffers")
                    )
            );
            fuel.put(
                    "fuelQuotes",
                    mergeGradeArrays(
                            fuel.optJSONArray("fuelQuotes"),
                            otherFuel.optJSONArray("fuelQuotes")
                    )
            );
            if (fuel.optString("providerName").trim().isEmpty()
                    && !otherFuel.optString("providerName").trim().isEmpty()) {
                fuel.put("providerName", otherFuel.optString("providerName"));
                if (otherFuel.has("providerEvidence")) {
                    fuel.put("providerEvidence", otherFuel.opt("providerEvidence"));
                }
            }
        } catch (Exception ignored) {
            return AddressFreePayload.copyObject(primary);
        }
        return output;
    }

    private static JSONArray mergeGradeArrays(JSONArray primary, JSONArray supplement) {
        Map<String, JSONObject> values = new LinkedHashMap<>();
        addGrades(values, primary, true);
        addGrades(values, supplement, false);
        JSONArray output = new JSONArray();
        for (JSONObject value : values.values()) {
            output.put(AddressFreePayload.copyObject(value));
        }
        return output;
    }

    private static void addGrades(
            Map<String, JSONObject> target,
            JSONArray source,
            boolean replace
    ) {
        if (source == null) return;
        for (int index = 0; index < source.length(); index++) {
            JSONObject value = source.optJSONObject(index);
            if (value == null) continue;
            String grade = compact(value.optString("gradeCode"));
            if (grade.isEmpty()) grade = compact(value.optString("gradeLabel"));
            if (grade.isEmpty()) grade = "unknown-" + index;
            if (replace || !target.containsKey(grade)) {
                target.put(grade, AddressFreePayload.copyObject(value));
            }
        }
    }

    static String stableIdentity(JSONObject row, int fallbackIndex) {
        return StationIdentity.fromRow(row, fallbackIndex);
    }

    private static boolean isPending(JSONObject row) {
        String state = row == null ? "" : row.optString("syncState");
        return "pending".equals(state)
                || "failed".equals(state)
                || "manual-review".equals(state);
    }

    private static String compact(String value) {
        return value == null ? "" : value.replaceAll("\\s+", "").trim();
    }

    static final class ViewState {
        final int validStations;
        final int withPrice;
        final int withGuns;
        final int fuelOfferCount;
        final int fuelQuoteCount;
        final int fuelStationsWithOffers;
        final int fuelStationsWithQuotes;
        final int incomplete;
        final int pending;
        final List<JSONObject> rows;
        final Filter filter;

        ViewState(
                int validStations,
                int withPrice,
                int withGuns,
                int fuelOfferCount,
                int fuelQuoteCount,
                int fuelStationsWithOffers,
                int fuelStationsWithQuotes,
                int incomplete,
                int pending,
                List<JSONObject> rows,
                Filter filter
        ) {
            this.validStations = validStations;
            this.withPrice = withPrice;
            this.withGuns = withGuns;
            this.fuelOfferCount = fuelOfferCount;
            this.fuelQuoteCount = fuelQuoteCount;
            this.fuelStationsWithOffers = fuelStationsWithOffers;
            this.fuelStationsWithQuotes = fuelStationsWithQuotes;
            this.incomplete = incomplete;
            this.pending = pending;
            this.rows = new ArrayList<>(rows);
            this.filter = filter;
        }
    }

    private static final class IndexedRow {
        final JSONObject value;
        final int index;
        final String capturedAt;
        final String backfilledAt;
        final boolean manualBackfill;
        final int revision;

        IndexedRow(JSONObject value, int index) {
            this.value = value;
            this.index = index;
            this.capturedAt = value.optString("capturedAt");
            this.backfilledAt = value.optString("backfilledAt");
            JSONObject raw = value.optJSONObject("raw");
            this.manualBackfill = raw != null && raw.optBoolean("manualBackfill", false);
            String localKey = value.optString("localKey");
            int marker = localKey.indexOf("|manual-backfill|");
            int parsedRevision = 0;
            if (marker >= 0) {
                String[] parts = localKey.substring(marker + "|manual-backfill|".length()).split("\\|");
                if (parts.length > 1) {
                    try {
                        parsedRevision = Integer.parseInt(parts[1]);
                    } catch (NumberFormatException ignored) {
                        parsedRevision = 0;
                    }
                }
            }
            this.revision = parsedRevision;
        }

        boolean isNewerThan(IndexedRow other) {
            if (manualBackfill != other.manualBackfill) return manualBackfill;
            if (manualBackfill && revision != other.revision) return revision > other.revision;
            if (manualBackfill) {
                int backfillCompared = backfilledAt.compareTo(other.backfilledAt);
                if (backfillCompared != 0) return backfillCompared > 0;
            }
            int compared = capturedAt.compareTo(other.capturedAt);
            return compared > 0 || (compared == 0 && index < other.index);
        }
    }
}
