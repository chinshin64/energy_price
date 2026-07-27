package com.datafordidi.mobilecollector;

import android.app.AlertDialog;
import android.content.Context;
import android.view.Gravity;
import android.widget.DatePicker;
import android.widget.LinearLayout;
import android.widget.NumberPicker;
import android.widget.TextView;

import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.ZonedDateTime;

/**
 * 同时选择日期、时、分、秒的轻量弹窗，不引入额外 UI 依赖。
 */
final class SecondPrecisionDateTimeDialog {
    interface Listener {
        void onSelected(long epochMillis);
    }

    private SecondPrecisionDateTimeDialog() {
    }

    static void show(Context context, String title, Long initialEpochMillis, Listener listener) {
        ZoneId zone = ZoneId.systemDefault();
        ZonedDateTime initial = Instant.ofEpochMilli(
                initialEpochMillis == null ? System.currentTimeMillis() : initialEpochMillis
        ).atZone(zone);

        LinearLayout content = new LinearLayout(context);
        content.setOrientation(LinearLayout.VERTICAL);
        int horizontal = dp(context, 18);
        content.setPadding(horizontal, 0, horizontal, dp(context, 8));

        DatePicker date = new DatePicker(context);
        date.init(initial.getYear(), initial.getMonthValue() - 1, initial.getDayOfMonth(), null);
        date.setContentDescription(title + "日期");
        content.addView(date, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
        ));

        LinearLayout timeRow = new LinearLayout(context);
        timeRow.setGravity(Gravity.CENTER);
        NumberPicker hour = picker(context, 0, 23, initial.getHour(), "时");
        NumberPicker minute = picker(context, 0, 59, initial.getMinute(), "分");
        NumberPicker second = picker(context, 0, 59, initial.getSecond(), "秒");
        addTimePart(timeRow, hour, "时");
        addTimePart(timeRow, minute, "分");
        addTimePart(timeRow, second, "秒");
        content.addView(timeRow, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
        ));

        AlertDialog dialog = new AlertDialog.Builder(context)
                .setTitle(title)
                .setView(content)
                .setNegativeButton("取消", null)
                .setPositiveButton("确定", null)
                .create();
        dialog.setOnShowListener(ignored -> dialog.getButton(AlertDialog.BUTTON_POSITIVE)
                .setOnClickListener(view -> {
                    long selected = toEpochMillis(
                            date.getYear(),
                            date.getMonth() + 1,
                            date.getDayOfMonth(),
                            hour.getValue(),
                            minute.getValue(),
                            second.getValue(),
                            zone
                    );
                    if (listener != null) listener.onSelected(selected);
                    dialog.dismiss();
                }));
        dialog.show();
    }

    static long toEpochMillis(
            int year,
            int month,
            int day,
            int hour,
            int minute,
            int second,
            ZoneId zone
    ) {
        return LocalDateTime.of(year, month, day, hour, minute, second)
                .atZone(zone == null ? ZoneId.systemDefault() : zone)
                .toInstant()
                .toEpochMilli();
    }

    private static NumberPicker picker(
            Context context,
            int minimum,
            int maximum,
            int value,
            String label
    ) {
        NumberPicker picker = new NumberPicker(context);
        picker.setMinValue(minimum);
        picker.setMaxValue(maximum);
        picker.setValue(value);
        picker.setWrapSelectorWheel(true);
        picker.setFormatter(number -> String.format(java.util.Locale.ROOT, "%02d", number));
        picker.setContentDescription(label);
        return picker;
    }

    private static void addTimePart(LinearLayout row, NumberPicker picker, String label) {
        row.addView(picker, new LinearLayout.LayoutParams(0, dp(row.getContext(), 96), 1f));
        TextView suffix = new TextView(row.getContext());
        suffix.setText(label);
        suffix.setGravity(Gravity.CENTER);
        row.addView(suffix, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                dp(row.getContext(), 96)
        ));
    }

    private static int dp(Context context, int value) {
        return Math.round(value * context.getResources().getDisplayMetrics().density);
    }
}
