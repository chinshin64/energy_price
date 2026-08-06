package com.datafordidi.mobilecollector;

import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.annotation.Config;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.robolectric.Shadows.shadowOf;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 30)
public class MainActivityFilterStateRobolectricTest {
    @Test
    public void restoresTypeNameAndSecondPrecisionTimeFromActivityState() {
        shadowOf(RuntimeEnvironment.getApplication()).grantPermissions(
                "com.datafordidi.ocruploader.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION"
        );
        Bundle state = new Bundle();
        state.putString("resultFilter", StationResultPresenter.Filter.FUEL.name());
        state.putString("nameQuery", "城西");
        state.putLong("startTime", 1_785_100_001_000L);
        state.putLong("endTime", 1_785_100_061_000L);

        ActivityController<MainActivity> first = Robolectric.buildActivity(MainActivity.class)
                .create(state)
                .start()
                .resume()
                .visible();
        Bundle recreatedState = new Bundle();
        first.saveInstanceState(recreatedState).pause().stop().destroy();

        ActivityController<MainActivity> controller = Robolectric.buildActivity(MainActivity.class)
                .create(recreatedState)
                .start()
                .resume()
                .visible();
        View root = controller.get().getWindow().getDecorView();
        EditText search = findEditTextByHint(root, "⌕  搜索场站/油站名称");
        assertNotNull(search);
        assertEquals("城西", search.getText().toString());
        assertNotNull(findButtonByText(root, "加油"));
        assertTrue(findByDescriptionPrefix(root, "设置开始日期时间，当前") instanceof Button);
        assertTrue(findByDescriptionPrefix(root, "设置结束日期时间，当前") instanceof Button);

        Button multi = findButtonByText(root, "多选");
        assertNotNull(multi);
        multi.performClick();
        assertNotNull(findButtonByText(root, "取消"));
        search.setText("新条件");
        assertNotNull(findButtonByText(root, "多选"));

        Button reset = findButtonByText(root, "↻ 重置");
        assertNotNull(reset);
        reset.performClick();
        assertEquals("", search.getText().toString());
        assertNotNull(findButtonByText(root, "加油"));
        controller.pause().stop().destroy();
    }

    private static EditText findEditTextByHint(View root, String hint) {
        if (root instanceof EditText) {
            CharSequence current = ((EditText) root).getHint();
            if (current != null && hint.contentEquals(current)) return (EditText) root;
        }
        if (!(root instanceof ViewGroup)) return null;
        ViewGroup group = (ViewGroup) root;
        for (int index = 0; index < group.getChildCount(); index++) {
            EditText found = findEditTextByHint(group.getChildAt(index), hint);
            if (found != null) return found;
        }
        return null;
    }

    private static Button findButtonByText(View root, String text) {
        if (root instanceof Button && text.contentEquals(((Button) root).getText())) {
            return (Button) root;
        }
        if (!(root instanceof ViewGroup)) return null;
        ViewGroup group = (ViewGroup) root;
        for (int index = 0; index < group.getChildCount(); index++) {
            Button found = findButtonByText(group.getChildAt(index), text);
            if (found != null) return found;
        }
        return null;
    }

    private static View findByDescriptionPrefix(View root, String prefix) {
        CharSequence description = root.getContentDescription();
        if (description != null && description.toString().startsWith(prefix)) return root;
        if (!(root instanceof ViewGroup)) return null;
        ViewGroup group = (ViewGroup) root;
        for (int index = 0; index < group.getChildCount(); index++) {
            View found = findByDescriptionPrefix(group.getChildAt(index), prefix);
            if (found != null) return found;
        }
        return null;
    }
}
