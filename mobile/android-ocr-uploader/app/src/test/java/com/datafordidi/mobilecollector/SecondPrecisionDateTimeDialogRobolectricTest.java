package com.datafordidi.mobilecollector;

import android.app.Activity;
import android.app.AlertDialog;
import android.view.View;
import android.view.ViewGroup;
import android.widget.NumberPicker;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowAlertDialog;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 30)
public class SecondPrecisionDateTimeDialogRobolectricTest {
    @Test
    public void exposesSecondsAndReturnsTheSelectedSecond() {
        Activity activity = Robolectric.buildActivity(Activity.class).setup().get();
        long initial = java.time.Instant.parse("2026-07-27T08:09:37Z").toEpochMilli();
        SecondPrecisionDateTimeDialog.show(activity, "选择时间", initial, value -> {
        });
        AlertDialog dialog = ShadowAlertDialog.getLatestAlertDialog();
        NumberPicker seconds = (NumberPicker) findByDescription(dialog.getWindow().getDecorView(), "秒");
        assertNotNull(seconds);
        assertEquals(37, seconds.getValue());
        assertEquals(
                37,
                java.time.Instant.ofEpochMilli(SecondPrecisionDateTimeDialog.toEpochMillis(
                                2026,
                                7,
                                27,
                                16,
                                9,
                                37,
                                java.time.ZoneId.of("Asia/Shanghai")
                        ))
                        .atZone(java.time.ZoneId.systemDefault())
                        .getSecond()
        );
    }

    private static View findByDescription(View root, String description) {
        CharSequence current = root.getContentDescription();
        if (current != null && description.contentEquals(current)) return root;
        if (!(root instanceof ViewGroup)) return null;
        ViewGroup group = (ViewGroup) root;
        for (int index = 0; index < group.getChildCount(); index++) {
            View found = findByDescription(group.getChildAt(index), description);
            if (found != null) return found;
        }
        return null;
    }
}
