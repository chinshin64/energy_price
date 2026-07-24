package com.datafordidi.mobilecollector;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONObject;

import java.util.Iterator;
import java.util.UUID;

final class ManualBackfillDraftStore {
    private static final String PREFS = "standalone_ocr_backfill_drafts";
    private static final String KEY_DRAFTS = "drafts";
    private static final Object LOCK = new Object();

    private ManualBackfillDraftStore() {
    }

    static State getOrCreate(Context context, JSONObject sourceRow) {
        String identity = StationIdentity.fromRow(sourceRow, 0);
        synchronized (LOCK) {
            JSONObject drafts = read(context);
            State existing = State.fromJson(drafts.optJSONObject(key(identity)));
            if (existing != null && identity.equals(existing.stableIdentity)) return existing;
            State created = new State();
            created.stableIdentity = identity;
            created.originalLocalKey = sourceRow.optString("localKey");
            created.originalRow = AddressFreePayload.copyObject(sourceRow);
            created.editId = UUID.randomUUID().toString();
            created.revision = 0;
            created.lastSavedFingerprint = "";
            created.draft = ManualBackfillDraft.fromRow(sourceRow);
            created.fuelDraft = FuelBackfillDraft.fromRow(sourceRow);
            created.open = true;
            persistState(context, drafts, created);
            return created;
        }
    }

    static State find(Context context, String stableIdentity) {
        synchronized (LOCK) {
            return State.fromJson(read(context).optJSONObject(key(stableIdentity)));
        }
    }

    static State findOpen(Context context) {
        synchronized (LOCK) {
            JSONObject drafts = read(context);
            Iterator<String> keys = drafts.keys();
            while (keys.hasNext()) {
                State state = State.fromJson(drafts.optJSONObject(keys.next()));
                if (state != null && state.open) return state;
            }
            return null;
        }
    }

    static void save(Context context, State state) {
        if (state == null || state.stableIdentity.isEmpty()) return;
        synchronized (LOCK) {
            persistState(context, read(context), state);
        }
    }

    static void close(Context context, String stableIdentity, boolean discard) {
        synchronized (LOCK) {
            JSONObject drafts = read(context);
            String key = key(stableIdentity);
            if (discard) {
                drafts.remove(key);
            } else {
                State state = State.fromJson(drafts.optJSONObject(key));
                if (state != null) {
                    state.open = false;
                    put(drafts, key, state.toJson());
                }
            }
            persist(context, drafts);
        }
    }

    static void remove(Context context, String stableIdentity) {
        synchronized (LOCK) {
            JSONObject drafts = read(context);
            drafts.remove(key(stableIdentity));
            persist(context, drafts);
        }
    }

    private static void persistState(Context context, JSONObject drafts, State state) {
        put(drafts, key(state.stableIdentity), state.toJson());
        persist(context, drafts);
    }

    private static JSONObject read(Context context) {
        try {
            return new JSONObject(prefs(context).getString(KEY_DRAFTS, "{}"));
        } catch (Exception error) {
            return new JSONObject();
        }
    }

    private static void persist(Context context, JSONObject drafts) {
        if (!prefs(context).edit().putString(KEY_DRAFTS, drafts.toString()).commit()) {
            throw new IllegalStateException("无法保存回填草稿");
        }
    }

    private static String key(String stableIdentity) {
        return DeviceIdentity.sha256(String.valueOf(stableIdentity));
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static final class State {
        String stableIdentity = "";
        String originalLocalKey = "";
        JSONObject originalRow = new JSONObject();
        String editId = "";
        int revision;
        String lastSavedFingerprint = "";
        ManualBackfillDraft draft = new ManualBackfillDraft();
        FuelBackfillDraft fuelDraft = new FuelBackfillDraft();
        boolean open;

        JSONObject toJson() {
            JSONObject value = new JSONObject();
            put(value, "stableIdentity", stableIdentity);
            put(value, "originalLocalKey", originalLocalKey);
            put(value, "originalRow", AddressFreePayload.copyObject(originalRow));
            put(value, "editId", editId);
            put(value, "revision", revision);
            put(value, "lastSavedFingerprint", lastSavedFingerprint);
            put(value, "draft", draft.toJson());
            put(value, "fuelDraft", fuelDraft.toJson());
            put(value, "open", open);
            return value;
        }

        static State fromJson(JSONObject value) {
            if (value == null) return null;
            State state = new State();
            state.stableIdentity = value.optString("stableIdentity");
            state.originalLocalKey = value.optString("originalLocalKey");
            state.originalRow = AddressFreePayload.copyObject(value.optJSONObject("originalRow"));
            state.editId = value.optString("editId");
            state.revision = Math.max(0, value.optInt("revision"));
            state.lastSavedFingerprint = value.optString("lastSavedFingerprint");
            state.draft = ManualBackfillDraft.fromJson(value.optJSONObject("draft"));
            state.fuelDraft = FuelBackfillDraft.fromJson(value.optJSONObject("fuelDraft"));
            state.open = value.optBoolean("open", false);
            if (state.stableIdentity.isEmpty() || state.editId.isEmpty()) return null;
            return state;
        }
    }

    private static void put(JSONObject target, String key, Object value) {
        try {
            target.put(key, value);
        } catch (Exception error) {
            throw new IllegalStateException("无法序列化回填草稿", error);
        }
    }
}
