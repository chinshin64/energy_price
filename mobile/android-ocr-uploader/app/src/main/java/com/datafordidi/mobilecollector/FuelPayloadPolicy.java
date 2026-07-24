package com.datafordidi.mobilecollector;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Locale;
import java.util.Set;

final class FuelPayloadPolicy {
    private static final Set<String> EXACT_FORBIDDEN = new HashSet<>(Arrays.asList(
            "pricefast", "priceslow", "pricesuper", "priceservice",
            "onlinefast", "onlineslow", "onlinesuper",
            "onlinefastports", "onlineslowports", "onlinesuperports",
            "fastidleports", "fastavailableports", "fasttotalports", "fastbusyports",
            "slowidleports", "slowavailableports", "slowtotalports", "slowbusyports",
            "superidleports", "superavailableports", "supertotalports", "superbusyports"
    ));

    private FuelPayloadPolicy() {
    }

    static void requireNoChargingFields(Object value) {
        if (findForbidden(value)) {
            throw new IllegalArgumentException("燃油记录不能包含充电专属字段");
        }
    }

    static boolean findForbidden(Object value) {
        if (value instanceof JSONObject) {
            JSONObject object = (JSONObject) value;
            Iterator<String> keys = object.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                if (isChargingKey(key) || findForbidden(object.opt(key))) return true;
            }
        } else if (value instanceof JSONArray) {
            JSONArray array = (JSONArray) value;
            for (int index = 0; index < array.length(); index++) {
                if (findForbidden(array.opt(index))) return true;
            }
        }
        return false;
    }

    static boolean containsKey(Object value, String expected) {
        String normalizedExpected = normalize(expected);
        if (value instanceof JSONObject) {
            JSONObject object = (JSONObject) value;
            Iterator<String> keys = object.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                if (normalizedExpected.equals(normalize(key))
                        || containsKey(object.opt(key), expected)) {
                    return true;
                }
            }
        } else if (value instanceof JSONArray) {
            JSONArray array = (JSONArray) value;
            for (int index = 0; index < array.length(); index++) {
                if (containsKey(array.opt(index), expected)) return true;
            }
        }
        return false;
    }

    static boolean isChargingKey(String value) {
        String key = normalize(value);
        return EXACT_FORBIDDEN.contains(key)
                || key.matches("^price(fast|slow|super|service)$")
                || key.matches("^online(fast|slow|super)(ports|guns|gun)?$")
                || key.matches("^(fast|slow|super)(idle|available|total|busy|online)(ports|guns|gun)?$");
    }

    private static String normalize(String value) {
        return value == null
                ? ""
                : value.replaceAll("[^A-Za-z0-9]", "").toLowerCase(Locale.ROOT);
    }
}
