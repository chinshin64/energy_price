package com.datafordidi.mobilecollector;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;

final class BackfillTransactionStore {
    private static final String PREFS = "standalone_ocr_backfill_transactions";
    private static final String KEY_OPERATIONS = "operations";
    private static final Object LOCK = new Object();

    private BackfillTransactionStore() {
    }

    static void put(Context context, String operationId, JSONObject operation) {
        synchronized (LOCK) {
            JSONObject values = read(context);
            try {
                values.put(operationId, AddressFreePayload.copyObject(operation));
            } catch (Exception error) {
                throw new IllegalStateException("无法保存回填事务", error);
            }
            persist(context, values);
        }
    }

    static void remove(Context context, String operationId) {
        synchronized (LOCK) {
            JSONObject values = read(context);
            values.remove(operationId);
            persist(context, values);
        }
    }

    static List<Entry> entries(Context context) {
        synchronized (LOCK) {
            JSONObject values = read(context);
            List<Entry> output = new ArrayList<>();
            Iterator<String> keys = values.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                JSONObject value = values.optJSONObject(key);
                if (value != null) output.add(new Entry(key, AddressFreePayload.copyObject(value)));
            }
            return output;
        }
    }

    private static JSONObject read(Context context) {
        try {
            return new JSONObject(prefs(context).getString(KEY_OPERATIONS, "{}"));
        } catch (Exception error) {
            return new JSONObject();
        }
    }

    private static void persist(Context context, JSONObject value) {
        if (!prefs(context).edit().putString(KEY_OPERATIONS, value.toString()).commit()) {
            throw new IllegalStateException("无法保存回填事务");
        }
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static final class Entry {
        final String id;
        final JSONObject value;

        Entry(String id, JSONObject value) {
            this.id = id;
            this.value = value;
        }
    }
}
