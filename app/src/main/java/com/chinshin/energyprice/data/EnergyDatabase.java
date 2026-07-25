package com.chinshin.energyprice.data;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;

import java.util.ArrayList;
import java.util.List;

public final class EnergyDatabase extends SQLiteOpenHelper {
    private static final String DB_NAME = "energy_price.db";
    private static final int DB_VERSION = 1;
    private static volatile EnergyDatabase instance;

    public static EnergyDatabase get(Context context) {
        if (instance == null) {
            synchronized (EnergyDatabase.class) {
                if (instance == null) instance = new EnergyDatabase(context.getApplicationContext());
            }
        }
        return instance;
    }

    private EnergyDatabase(Context context) {
        super(context, DB_NAME, null, DB_VERSION);
    }

    @Override
    public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE captures (" +
                "id INTEGER PRIMARY KEY AUTOINCREMENT," +
                "station_name TEXT NOT NULL," +
                "grade_code TEXT NOT NULL," +
                "amount_yuan INTEGER NOT NULL," +
                "station_price REAL NOT NULL," +
                "display_price REAL NOT NULL," +
                "list_price REAL NOT NULL," +
                "discount_amount REAL NOT NULL," +
                "service_fee REAL NOT NULL," +
                "payable_amount REAL," +
                "provider_name TEXT NOT NULL," +
                "captured_at INTEGER NOT NULL," +
                "stable_identity TEXT NOT NULL," +
                "idempotency_key TEXT NOT NULL UNIQUE," +
                "payload_json TEXT NOT NULL," +
                "sync_state INTEGER NOT NULL DEFAULT 0," +
                "attempt_count INTEGER NOT NULL DEFAULT 0," +
                "last_error TEXT" +
                ")");
        db.execSQL("CREATE INDEX idx_captures_pending ON captures(sync_state, captured_at)");
        db.execSQL("CREATE INDEX idx_captures_grade ON captures(grade_code, captured_at)");
    }

    @Override
    public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        db.execSQL("DROP TABLE IF EXISTS captures");
        onCreate(db);
    }

    public synchronized long insert(CaptureRecord record) {
        ContentValues values = new ContentValues();
        values.put("station_name", record.stationName);
        values.put("grade_code", record.gradeCode);
        values.put("amount_yuan", record.amountYuan);
        values.put("station_price", record.stationPrice);
        values.put("display_price", record.displayPrice);
        values.put("list_price", record.listPrice);
        values.put("discount_amount", record.discountAmount);
        values.put("service_fee", record.serviceFee);
        if (record.payableAmount == null) values.putNull("payable_amount"); else values.put("payable_amount", record.payableAmount);
        values.put("provider_name", record.providerName);
        values.put("captured_at", record.capturedAt);
        values.put("stable_identity", record.stableIdentity);
        values.put("idempotency_key", record.idempotencyKey);
        values.put("payload_json", record.payloadJson);
        values.put("sync_state", 0);
        return getWritableDatabase().insertWithOnConflict("captures", null, values, SQLiteDatabase.CONFLICT_IGNORE);
    }

    public synchronized List<CaptureRecord> listAll() {
        return query("SELECT * FROM captures ORDER BY captured_at DESC", null);
    }

    public synchronized List<CaptureRecord> listPending(int limit) {
        return query("SELECT * FROM captures WHERE sync_state=0 ORDER BY captured_at ASC LIMIT " + Math.max(1, Math.min(limit, 100)), null);
    }

    public synchronized void markSynced(long id) {
        ContentValues values = new ContentValues();
        values.put("sync_state", 1);
        values.putNull("last_error");
        getWritableDatabase().update("captures", values, "id=?", new String[]{String.valueOf(id)});
    }

    public synchronized void markFailure(long id, String error) {
        getWritableDatabase().execSQL(
                "UPDATE captures SET attempt_count=attempt_count+1,last_error=? WHERE id=?",
                new Object[]{trimError(error), id});
    }

    public synchronized void deleteIds(List<Long> ids) {
        if (ids == null || ids.isEmpty()) return;
        StringBuilder placeholders = new StringBuilder();
        String[] args = new String[ids.size()];
        for (int i = 0; i < ids.size(); i++) {
            if (i > 0) placeholders.append(',');
            placeholders.append('?');
            args[i] = String.valueOf(ids.get(i));
        }
        getWritableDatabase().delete("captures", "id IN (" + placeholders + ")", args);
    }

    public synchronized Stats stats() {
        try (Cursor cursor = getReadableDatabase().rawQuery(
                "SELECT COUNT(*)," +
                        "SUM(CASE WHEN station_name<>'' AND provider_name<>'' THEN 1 ELSE 0 END)," +
                        "SUM(CASE WHEN grade_code='92' THEN 1 ELSE 0 END)," +
                        "SUM(CASE WHEN grade_code='95' THEN 1 ELSE 0 END) FROM captures", null)) {
            if (!cursor.moveToFirst()) return new Stats(0, 0, 0, 0);
            return new Stats(cursor.getInt(0), cursor.getInt(1), cursor.getInt(2), cursor.getInt(3));
        }
    }

    private List<CaptureRecord> query(String sql, String[] args) {
        List<CaptureRecord> out = new ArrayList<>();
        try (Cursor cursor = getReadableDatabase().rawQuery(sql, args)) {
            while (cursor.moveToNext()) out.add(fromCursor(cursor));
        }
        return out;
    }

    private CaptureRecord fromCursor(Cursor c) {
        CaptureRecord r = new CaptureRecord();
        r.id = c.getLong(c.getColumnIndexOrThrow("id"));
        r.stationName = c.getString(c.getColumnIndexOrThrow("station_name"));
        r.gradeCode = c.getString(c.getColumnIndexOrThrow("grade_code"));
        r.amountYuan = c.getInt(c.getColumnIndexOrThrow("amount_yuan"));
        r.stationPrice = c.getDouble(c.getColumnIndexOrThrow("station_price"));
        r.displayPrice = c.getDouble(c.getColumnIndexOrThrow("display_price"));
        r.listPrice = c.getDouble(c.getColumnIndexOrThrow("list_price"));
        r.discountAmount = c.getDouble(c.getColumnIndexOrThrow("discount_amount"));
        r.serviceFee = c.getDouble(c.getColumnIndexOrThrow("service_fee"));
        int payableIndex = c.getColumnIndexOrThrow("payable_amount");
        r.payableAmount = c.isNull(payableIndex) ? null : c.getDouble(payableIndex);
        r.providerName = c.getString(c.getColumnIndexOrThrow("provider_name"));
        r.capturedAt = c.getLong(c.getColumnIndexOrThrow("captured_at"));
        r.stableIdentity = c.getString(c.getColumnIndexOrThrow("stable_identity"));
        r.idempotencyKey = c.getString(c.getColumnIndexOrThrow("idempotency_key"));
        r.payloadJson = c.getString(c.getColumnIndexOrThrow("payload_json"));
        r.syncState = c.getInt(c.getColumnIndexOrThrow("sync_state"));
        r.attemptCount = c.getInt(c.getColumnIndexOrThrow("attempt_count"));
        r.lastError = c.getString(c.getColumnIndexOrThrow("last_error"));
        return r;
    }

    private static String trimError(String error) {
        if (error == null) return null;
        return error.length() <= 1000 ? error : error.substring(0, 1000);
    }

    public static final class Stats {
        private final int total;
        private final int valid;
        private final int grade92;
        private final int grade95;
        public Stats(int total, int valid, int grade92, int grade95) {
            this.total = total;
            this.valid = valid;
            this.grade92 = grade92;
            this.grade95 = grade95;
        }
        public int total() { return total; }
        public int valid() { return valid; }
        public int grade92() { return grade92; }
        public int grade95() { return grade95; }
    }
}
