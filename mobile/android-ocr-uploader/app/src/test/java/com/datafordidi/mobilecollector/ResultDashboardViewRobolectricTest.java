package com.datafordidi.mobilecollector;

import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.TextView;

import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

import java.util.Collections;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 30)
public class ResultDashboardViewRobolectricTest {
    @Test
    public void exposesAccessibleSearchTimeResetUpdateAndPrimaryActions() {
        ResultDashboardView view = new ResultDashboardView(RuntimeEnvironment.getApplication());

        assertNotNull(findByDescription(view, "场站或油站名称模糊搜索"));
        assertNotNull(findByDescription(view, "搜索场站或油站名称"));
        assertNotNull(findByDescription(view, "重置名称和时间筛选"));
        assertNotNull(findByDescription(view, "检查应用更新"));
        assertNotNull(findByDescription(view, "启动悬浮识别"));
        assertNotNull(findByDescriptionPrefix(view, "设置开始日期时间"));
        assertNotNull(findByDescriptionPrefix(view, "设置结束日期时间"));
        Button reset = (Button) findByDescription(view, "重置名称和时间筛选");
        assertTrue(reset.getMinHeight() >= dp(44));
    }

    @Test
    public void rendersSecondPrecisionFilterValuesAndDistinctEmptyStates() {
        ResultDashboardView view = new ResultDashboardView(RuntimeEnvironment.getApplication());
        long start = 1_785_100_001_000L;
        long end = start + 59_000L;
        view.setRecordFilter(new StationRecordFilter("中海联", start, end));

        EditText search = (EditText) findByDescription(view, "场站或油站名称模糊搜索");
        assertEquals("中海联", search.getText().toString());
        assertTrue(((Button) findByDescriptionPrefix(view, "设置开始日期时间"))
                .getText().toString().matches("(?s)开始\\n\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}"));

        StationResultPresenter.ViewState empty = StationResultPresenter.present(
                Collections.emptyList(),
                StationResultPresenter.Filter.ALL
        );
        view.render(empty, true, true);
        assertNotNull(findText(view, "没有符合筛选条件的记录"));
        view.render(empty, false, false);
        assertNotNull(findText(view, "暂无识别结果\n点击下方开始识别"));
        view.render(
                StationResultPresenter.present(
                        Collections.emptyList(),
                        StationResultPresenter.Filter.FUEL
                ),
                true,
                true
        );
        assertNotNull(findText(view, "有油号"));
        assertNotNull(findText(view, "有报价"));
    }

    @Test
    public void recordCardDoesNotExposeSourceAgentButKeepsItInTheRecord() throws Exception {
        ResultDashboardView view = new ResultDashboardView(RuntimeEnvironment.getApplication());
        JSONObject row = new JSONObject()
                .put("stationName", "来源不可见测试站")
                .put("stationType", "charging")
                .put("platform", "didi-charging")
                .put("city", "杭州")
                .put("localKey", "source-hidden-test")
                .put("capturedAt", "2026-07-27T08:09:37.000Z")
                .put("sourceAgent", "android-ocr-agent")
                .put("priceFast", 1.2d)
                .put("fastIdlePorts", 1)
                .put("fastTotalPorts", 2);
        view.render(
                StationResultPresenter.present(
                        Collections.singletonList(row),
                        StationResultPresenter.Filter.ALL
                ),
                true,
                false
        );
        int width = View.MeasureSpec.makeMeasureSpec(dp(400), View.MeasureSpec.EXACTLY);
        int height = View.MeasureSpec.makeMeasureSpec(dp(720), View.MeasureSpec.EXACTLY);
        view.measure(width, height);
        view.layout(0, 0, dp(400), dp(720));
        org.robolectric.shadows.ShadowLooper.idleMainLooper();

        assertNotNull(findText(view, "来源不可见测试站"));
        assertNull(findTextPrefix(view, "来源："));
        assertNull(findDescriptionContaining(view, "来源android-ocr-agent"));
        assertEquals("android-ocr-agent", row.getString("sourceAgent"));
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

    private static TextView findText(View root, String value) {
        if (root instanceof TextView && value.contentEquals(((TextView) root).getText())) {
            return (TextView) root;
        }
        if (!(root instanceof ViewGroup)) return null;
        ViewGroup group = (ViewGroup) root;
        for (int index = 0; index < group.getChildCount(); index++) {
            TextView found = findText(group.getChildAt(index), value);
            if (found != null) return found;
        }
        return null;
    }

    private static TextView findTextPrefix(View root, String prefix) {
        if (root instanceof TextView
                && ((TextView) root).getText().toString().startsWith(prefix)) {
            return (TextView) root;
        }
        if (!(root instanceof ViewGroup)) return null;
        ViewGroup group = (ViewGroup) root;
        for (int index = 0; index < group.getChildCount(); index++) {
            TextView found = findTextPrefix(group.getChildAt(index), prefix);
            if (found != null) return found;
        }
        return null;
    }

    private static View findDescriptionContaining(View root, String value) {
        CharSequence description = root.getContentDescription();
        if (description != null && description.toString().contains(value)) return root;
        if (!(root instanceof ViewGroup)) return null;
        ViewGroup group = (ViewGroup) root;
        for (int index = 0; index < group.getChildCount(); index++) {
            View found = findDescriptionContaining(group.getChildAt(index), value);
            if (found != null) return found;
        }
        return null;
    }

    private static int dp(int value) {
        return Math.round(value * RuntimeEnvironment.getApplication()
                .getResources().getDisplayMetrics().density);
    }
}
