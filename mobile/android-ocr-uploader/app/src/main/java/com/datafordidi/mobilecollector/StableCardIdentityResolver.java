package com.datafordidi.mobilecollector;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

final class StableCardIdentityResolver {
    private final Map<String, List<Slot>> slotsByBase = new LinkedHashMap<>();

    void resolveScreen(
            String sessionId,
            String pageSignal,
            String platform,
            String city,
            List<DidiLocalStationParser.StationRecord> stations
    ) {
        if (stations == null) return;
        String sessionScope = requiredScope(sessionId, "sessionId");
        String pageScope = sessionScope + "|" + requiredScope(pageSignal, "pageSignal");
        Set<String> used = new HashSet<>();
        for (DidiLocalStationParser.StationRecord station : stations) {
            if (station == null || compact(station.stationName).isEmpty()) continue;
            String base = sessionScope + "|"
                    + LocalStationStore.buildKey(platform, city, station.stationName);
            List<Slot> slots = slotsByBase.computeIfAbsent(base, ignored -> new ArrayList<>());
            Slot match = bestUnused(slots, station, pageScope, used);
            if (match == null) {
                match = new Slot(base, uniqueContext(slots, station), station, pageScope);
                slots.add(match);
            } else {
                match.update(station, pageScope);
            }
            station.captureContextId = match.contextId;
            used.add(base + "|" + match.contextId);
        }
    }

    private Slot bestUnused(
            List<Slot> slots,
            DidiLocalStationParser.StationRecord station,
            String pageScope,
            Set<String> used
    ) {
        String assignedContext = compact(station.captureContextId);
        if (!assignedContext.isEmpty()) {
            for (Slot slot : slots) {
                if (!used.contains(slot.baseUseKey) && assignedContext.equals(slot.contextId)) {
                    return slot;
                }
            }
        }
        Slot best = null;
        double bestScore = 0d;
        String incoming = compact(station.transientIdentityText);
        for (Slot slot : slots) {
            if (used.contains(slot.baseUseKey)) continue;
            double score = identitySimilarity(incoming, slot.identityText);
            if (score > bestScore) {
                best = slot;
                bestScore = score;
            }
        }
        if (best != null && bestScore >= 0.90d) return best;

        if (!incoming.isEmpty()) return null;

        String cardKey = compact(station.transientCardKey);
        Slot cardMatch = uniquePageMatch(slots, used, pageScope, cardKey, true);
        if (cardMatch != null || !cardKey.isEmpty()) return cardMatch;

        String staticSignature = compact(station.transientStaticSignature);
        return uniquePageMatch(slots, used, pageScope, staticSignature, false);
    }

    private String uniqueContext(
            List<Slot> slots,
            DidiLocalStationParser.StationRecord station
    ) {
        String identity = compact(station.transientIdentityText);
        String seed = identity.isEmpty() ? compact(station.transientStaticSignature) : identity;
        if (seed.isEmpty()) seed = "unknown-card";
        String root = "card-" + DeviceIdentity.sha256(seed).substring(0, 12);
        String candidate = root;
        int suffix = 2;
        while (containsContext(slots, candidate)) candidate = root + "-" + suffix++;
        return candidate;
    }

    private Slot uniquePageMatch(
            List<Slot> slots,
            Set<String> used,
            String pageScope,
            String expected,
            boolean cardKey
    ) {
        if (expected.isEmpty()) return null;
        Slot match = null;
        for (Slot slot : slots) {
            if (used.contains(slot.baseUseKey) || !pageScope.equals(slot.pageScope)) continue;
            String actual = cardKey ? slot.cardKey : slot.staticSignature;
            if (!expected.equals(actual)) continue;
            if (match != null) return null;
            match = slot;
        }
        return match;
    }

    private boolean containsContext(List<Slot> slots, String context) {
        for (Slot slot : slots) if (slot.contextId.equals(context)) return true;
        return false;
    }

    static double identitySimilarity(String leftValue, String rightValue) {
        String left = compact(leftValue);
        String right = compact(rightValue);
        if (left.isEmpty() || right.isEmpty()) return 0d;
        if (left.equals(right)) return 1d;
        String leftDigits = left.replaceAll("\\D", "");
        String rightDigits = right.replaceAll("\\D", "");
        if (!leftDigits.isEmpty() && !rightDigits.isEmpty() && !leftDigits.equals(rightDigits)) return 0d;
        int distance = editDistance(left, right);
        int length = Math.max(left.length(), right.length());
        return Math.max(0d, 1d - (double) distance / Math.max(1, length));
    }

    private static int editDistance(String left, String right) {
        int[] previous = new int[right.length() + 1];
        for (int index = 0; index <= right.length(); index++) previous[index] = index;
        for (int leftIndex = 1; leftIndex <= left.length(); leftIndex++) {
            int[] current = new int[right.length() + 1];
            current[0] = leftIndex;
            for (int rightIndex = 1; rightIndex <= right.length(); rightIndex++) {
                int cost = left.charAt(leftIndex - 1) == right.charAt(rightIndex - 1) ? 0 : 1;
                current[rightIndex] = Math.min(
                        Math.min(current[rightIndex - 1] + 1, previous[rightIndex] + 1),
                        previous[rightIndex - 1] + cost
                );
            }
            previous = current;
        }
        return previous[right.length()];
    }

    private static String compact(String value) {
        return value == null ? "" : value.replaceAll("\\s+", "").trim();
    }

    private static String requiredScope(String value, String label) {
        String scoped = compact(value);
        if (scoped.isEmpty()) throw new IllegalArgumentException(label + " is required");
        return scoped;
    }

    private static final class Slot {
        final String contextId;
        final String baseUseKey;
        String identityText = "";
        String staticSignature = "";
        String cardKey = "";
        String pageScope = "";

        Slot(
                String base,
                String contextId,
                DidiLocalStationParser.StationRecord station,
                String pageScope
        ) {
            this.contextId = contextId;
            this.baseUseKey = base + "|" + contextId;
            update(station, pageScope);
        }

        void update(DidiLocalStationParser.StationRecord station, String pageScope) {
            String incoming = compact(station.transientIdentityText);
            if (incoming.length() > identityText.length()) identityText = incoming;
            String signature = compact(station.transientStaticSignature);
            if (!signature.isEmpty()) staticSignature = signature;
            String incomingCardKey = compact(station.transientCardKey);
            if (!incomingCardKey.isEmpty()) cardKey = incomingCardKey;
            this.pageScope = pageScope;
        }
    }
}
