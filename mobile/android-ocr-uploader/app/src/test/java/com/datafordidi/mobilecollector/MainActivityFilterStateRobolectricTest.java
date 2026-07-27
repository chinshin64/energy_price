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

import static org.robolectric.Shadows.shadowOf;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

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
        EditText search = (EditText) findByDescription(root, "场站或油站名称模糊搜索");
        assertNotNull(search);
        assertEquals("城西", search.getText().toString());
        assertTrue(((Button) findByDescription(root, "筛选：加油")).isSelected());
        assertTrue(findByDescriptionPrefix(root, "设置开始日期时间，当前") instanceof Button);
        assertTrue(findByDescriptionPrefix(root, "设置结束日期时间，当前") instanceof Button);

        ((Button) findByDescription(root, "进入多选模式删除记录")).performClick();
        search.setText("新条件");
        assertNotNull(findByDescription(root, "进入多选模式删除记录"));

        ((Button) findByDescription(root, "重置名称和时间筛选")).performClick();
        assertEquals("", search.getText().toString());
        assertTrue(((Button) findByDescription(root, "筛选：加油")).isSelected());
        controller.pause().stop().destroy();
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
