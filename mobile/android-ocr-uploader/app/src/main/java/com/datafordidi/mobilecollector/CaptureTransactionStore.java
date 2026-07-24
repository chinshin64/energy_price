package com.datafordidi.mobilecollector;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;

final class CaptureTransactionStore {
    static final String PREFS = "standalone_ocr_capture_transactions";
    private static final String KEY_TRANSACTIONS = "transactions";
    private static final int MAX_TRANSACTIONS = 32;
    private static final Object LOCK = new Object();

    private CaptureTransactionStore() {
    }

    static void put(Context context, String transactionId, JSONObject transaction) {
        String id = compact(transactionId);
        if (id.isEmpty()) throw new IllegalArgumentException("采集事务缺少标识");
        synchronized (LOCK) {
            JSONObject values = read(context);
            if (!values.has(id) && values.length() >= MAX_TRANSACTIONS) {
                throw new IllegalStateException("待恢复采集事务已达上限");
            }
            try {
                values.put(id, AddressFreePayload.copyObject(transaction));
            } catch (Exception error) {
                throw new IllegalStateException("无法保存采集事务", error);
            }
            persist(context, values);
        }
    }

    static void remove(Context context, String transactionId) {
        String id = compact(transactionId);
        if (id.isEmpty()) return;
        synchronized (LOCK) {
            JSONObject values = read(context);
            if (!values.has(id)) return;
            values.remove(id);
            persist(context, values);
        }
    }

    static void removeByBatchId(Context context, String batchId) {
        String expected = compact(batchId);
        if (expected.isEmpty()) return;
        synchronized (LOCK) {
            JSONObject values = read(context);
            boolean changed = false;
            Iterator<String> keys = values.keys();
            List<String> removals = new ArrayList<>();
            while (keys.hasNext()) {
                String key = keys.next();
                JSONObject value = values.optJSONObject(key);
                JSONObject batch = value == null ? null : value.optJSONObject("batch");
                if (batch != null && expected.equals(batch.optString("batchId"))) removals.add(key);
            }
            for (String key : removals) {
                values.remove(key);
                changed = true;
            }
            if (changed) persist(context, values);
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
        String serialized = prefs(context).getString(KEY_TRANSACTIONS, "{}");
        try {
            return new JSONObject(serialized == null ? "{}" : serialized);
        } catch (Exception error) {
            throw new IllegalStateException("采集事务日志损坏", error);
        }
    }

    private static void persist(Context context, JSONObject value) {
        if (!prefs(context).edit().putString(KEY_TRANSACTIONS, value.toString()).commit()) {
            throw new IllegalStateException("无法保存采集事务");
        }
    }

    private static String compact(String value) {
        return value == null ? "" : value.trim();
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
