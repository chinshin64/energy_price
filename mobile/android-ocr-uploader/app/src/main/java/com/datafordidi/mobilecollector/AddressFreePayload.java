package com.datafordidi.mobilecollector;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Iterator;
import java.util.Locale;
import java.util.Set;
import java.util.HashSet;
import java.util.Arrays;

/**
 * Historical name retained for on-device binary/source compatibility.
 *
 * <p>Schema v3 intentionally preserves the business address. This copier now removes only
 * credential, account, payment and raw-screen fields that must never enter local result views or
 * upload payloads.</p>
 */
final class AddressFreePayload {
    private static final Set<String> SENSITIVE_KEYS = new HashSet<>(Arrays.asList(
            "authorization", "cookie", "setcookie", "token", "accesstoken", "refreshtoken",
            "password", "passwd", "secret", "phone", "mobile", "idcard", "identitycard",
            "bankcard", "cardnumber", "verificationcode", "smscode", "captcha",
            "orderid", "paymentid", "payid", "account", "username",
            "screenshot", "screenimage", "rawocrtext", "fullocrtext", "rawocrrows"
    ));

    private AddressFreePayload() {
    }

    static JSONObject copyObject(JSONObject source) {
        JSONObject output = new JSONObject();
        if (source == null) return output;
        Iterator<String> keys = source.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            if (isSensitiveKey(key)) continue;
            try {
                output.put(key, copyValue(source.opt(key)));
            } catch (Exception ignored) {
                // Existing malformed optional values are omitted from the sanitized view.
            }
        }
        return output;
    }

    static JSONArray copyArray(JSONArray source) {
        JSONArray output = new JSONArray();
        if (source == null) return output;
        for (int index = 0; index < source.length(); index++) output.put(copyValue(source.opt(index)));
        return output;
    }

    static boolean containsAddressKey(Object value) {
        if (value instanceof JSONObject) {
            JSONObject object = (JSONObject) value;
            Iterator<String> keys = object.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                if (isAddressKey(key) || containsAddressKey(object.opt(key))) return true;
            }
        } else if (value instanceof JSONArray) {
            JSONArray array = (JSONArray) value;
            for (int index = 0; index < array.length(); index++) {
                if (containsAddressKey(array.opt(index))) return true;
            }
        }
        return false;
    }

    static boolean containsSensitiveKey(Object value) {
        if (value instanceof JSONObject) {
            JSONObject object = (JSONObject) value;
            Iterator<String> keys = object.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                if (isSensitiveKey(key) || containsSensitiveKey(object.opt(key))) return true;
            }
        } else if (value instanceof JSONArray) {
            JSONArray array = (JSONArray) value;
            for (int index = 0; index < array.length(); index++) {
                if (containsSensitiveKey(array.opt(index))) return true;
            }
        }
        return false;
    }

    private static Object copyValue(Object value) {
        if (value instanceof JSONObject) return copyObject((JSONObject) value);
        if (value instanceof JSONArray) return copyArray((JSONArray) value);
        return value == null ? JSONObject.NULL : value;
    }

    private static boolean isAddressKey(String key) {
        return "address".equalsIgnoreCase(key) || "addr".equalsIgnoreCase(key);
    }

    private static boolean isSensitiveKey(String key) {
        String normalized = key == null
                ? ""
                : key.replaceAll("[^A-Za-z0-9]", "").toLowerCase(Locale.ROOT);
        return SENSITIVE_KEYS.contains(normalized);
    }
}
