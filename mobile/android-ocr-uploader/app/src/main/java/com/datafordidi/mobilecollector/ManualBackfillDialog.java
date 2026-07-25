package com.datafordidi.mobilecollector;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.text.Editable;
import android.text.InputType;
import android.text.TextWatcher;
import android.view.View;
import android.widget.EditText;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONObject;

import java.util.LinkedHashMap;
import java.util.Map;

final class ManualBackfillDialog {
    interface Listener {
        void onSaved(ManualBackfillRepository.SaveResult result);

        void onDiscarded();

        /** 用户在编辑回填对话框点「删除该记录」时回调，默认不做（兼容现有实现）。 */
        default void onDeleted(ManualBackfillDraftStore.State state) {
        }
    }

    private final Activity activity;
    private final ManualBackfillDraftStore.State state;
    private final Listener listener;
    private final Map<String, EditText> fields = new LinkedHashMap<>();
    private TextView formError;
    private AlertDialog dialog;
    private boolean binding;
    private LinearLayout fuelGradeContainer;

    private ManualBackfillDialog(
            Activity activity,
            ManualBackfillDraftStore.State state,
            Listener listener
    ) {
        this.activity = activity;
        this.state = state;
        this.listener = listener;
    }

    static ManualBackfillDialog show(
            Activity activity,
            ManualBackfillDraftStore.State state,
            Listener listener
    ) {
        ManualBackfillDialog controller = new ManualBackfillDialog(activity, state, listener);
        controller.show();
        return controller;
    }

    String stableIdentity() {
        return state.stableIdentity;
    }

    boolean isShowing() {
        return dialog != null && dialog.isShowing();
    }

    private void show() {
        state.open = true;
        ManualBackfillDraftStore.save(activity, state);
        dialog = new AlertDialog.Builder(activity)
                .setTitle("编辑回填")
                .setView(buildForm())
                .setNegativeButton("取消", (value, which) -> discard())
                .setNeutralButton("删除该记录", null)
                .setPositiveButton("保存并回传", null)
                .create();
        dialog.setOnShowListener(value -> {
            dialog.getButton(AlertDialog.BUTTON_POSITIVE)
                    .setOnClickListener(view -> save());
            dialog.getButton(AlertDialog.BUTTON_NEUTRAL)
                    .setOnClickListener(view -> confirmDelete());
        });
        dialog.show();
    }

    private View buildForm() {
        ScrollView scroll = new ScrollView(activity);
        LinearLayout form = new LinearLayout(activity);
        form.setOrientation(LinearLayout.VERTICAL);
        int horizontal = dp(22);
        form.setPadding(horizontal, dp(10), horizontal, dp(4));

        JSONObject row = state.originalRow;
        TextView station = label(activity, row.optString("stationName", "未命名场站"), 17);
        station.setContentDescription("场站名称，只读：" + station.getText());
        form.addView(station);
        TextView captured = label(activity, CaptureTime.display(row, null).label(), 13);
        captured.setPadding(0, dp(4), 0, dp(10));
        form.addView(captured);
        form.addView(textInput("场站地址", ManualBackfillDraft.ADDRESS, state.draft.address));

        if (StationDisplayFormatter.isFuel(row)) {
            buildFuelFields(form);
        } else {
            addField(form, "主价格（元/度）", ManualBackfillDraft.PRICE, state.draft.price, true);
            addPair(form, "快充", ManualBackfillDraft.FAST_IDLE, state.draft.fastIdle,
                    ManualBackfillDraft.FAST_TOTAL, state.draft.fastTotal);
            addPair(form, "慢充", ManualBackfillDraft.SLOW_IDLE, state.draft.slowIdle,
                    ManualBackfillDraft.SLOW_TOTAL, state.draft.slowTotal);
            addPair(form, "超充", ManualBackfillDraft.SUPER_IDLE, state.draft.superIdle,
                    ManualBackfillDraft.SUPER_TOTAL, state.draft.superTotal);
        }

        formError = label(activity, "", 13);
        formError.setTextColor(0xffb3261e);
        formError.setPadding(0, dp(8), 0, 0);
        form.addView(formError);
        TextView confirmation = label(activity, "保存后进入待回传；服务端确认入库后自动清除本机记录。", 12);
        confirmation.setPadding(0, dp(8), 0, dp(6));
        form.addView(confirmation);
        scroll.addView(form);
        return scroll;
    }

    private void buildFuelFields(LinearLayout form) {
        if (state.fuelDraft.grades.isEmpty()) state.fuelDraft.addGrade("");
        fuelGradeContainer = new LinearLayout(activity);
        fuelGradeContainer.setOrientation(LinearLayout.VERTICAL);
        form.addView(fuelGradeContainer);
        renderFuelGrades();
        Button add = new Button(activity);
        add.setText("添加油号");
        add.setAllCaps(false);
        add.setContentDescription("添加油号");
        add.setOnClickListener(view -> {
            state.fuelDraft.addGrade("");
            state.open = true;
            ManualBackfillDraftStore.save(activity, state);
            renderFuelGrades();
        });
        form.addView(add);
    }

    private void renderFuelGrades() {
        fuelGradeContainer.removeAllViews();
        fields.entrySet().removeIf(entry -> entry.getKey().startsWith("grades["));
        for (int index = 0; index < state.fuelDraft.grades.size(); index++) {
            final int gradeIndex = index;
            FuelBackfillDraft.GradeDraft grade = state.fuelDraft.grades.get(index);
            LinearLayout card = new LinearLayout(activity);
            card.setOrientation(LinearLayout.VERTICAL);
            card.setPadding(0, dp(6), 0, dp(8));
            card.addView(fuelInput("油号，如 92#", gradeIndex, "grade", grade.gradeLabel, false));
            card.addView(fuelInput(
                    "优惠价（元/升）", gradeIndex, "discountPrice", grade.discountPrice, true
            ));
            card.addView(fuelInput(
                    "挂牌价（元/升）", gradeIndex, "listPrice", grade.listPrice, true
            ));
            card.addView(fuelInput(
                    "其他油价（元/升）", gradeIndex, "unclassifiedPrice", grade.unclassifiedPrice, true
            ));
            Button remove = new Button(activity);
            remove.setText("删除该油号");
            remove.setAllCaps(false);
            remove.setContentDescription("删除第" + (index + 1) + "个油号");
            remove.setOnClickListener(view -> {
                if (state.fuelDraft.grades.size() <= 1) {
                    formError.setText("至少保留一个油号");
                    return;
                }
                state.fuelDraft.removeGrade(gradeIndex);
                ManualBackfillDraftStore.save(activity, state);
                renderFuelGrades();
            });
            card.addView(remove);
            fuelGradeContainer.addView(card);
        }
    }

    private EditText fuelInput(
            String hint,
            int gradeIndex,
            String property,
            String value,
            boolean decimal
    ) {
        EditText edit = new EditText(activity);
        edit.setHint(hint);
        edit.setText(value);
        edit.setSingleLine(true);
        edit.setInputType(decimal
                ? InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_FLAG_DECIMAL
                : InputType.TYPE_CLASS_TEXT);
        String key = "grades[" + gradeIndex + "]." + property;
        edit.setContentDescription(hint);
        edit.addTextChangedListener(new TextWatcher() {
            @Override
            public void beforeTextChanged(CharSequence text, int start, int count, int after) {
            }

            @Override
            public void onTextChanged(CharSequence text, int start, int before, int count) {
                if (binding || gradeIndex >= state.fuelDraft.grades.size()) return;
                String changed = text == null ? "" : text.toString();
                FuelBackfillDraft.GradeDraft grade = state.fuelDraft.grades.get(gradeIndex);
                if ("grade".equals(property)) {
                    grade.gradeLabel = changed;
                    grade.gradeCode = changed.replace("#", "").replace("＃", "").trim();
                } else if ("discountPrice".equals(property)) grade.discountPrice = changed;
                else if ("listPrice".equals(property)) grade.listPrice = changed;
                else if ("unclassifiedPrice".equals(property)) grade.unclassifiedPrice = changed;
                state.open = true;
                ManualBackfillDraftStore.save(activity, state);
                edit.setError(null);
                formError.setText("");
            }

            @Override
            public void afterTextChanged(Editable text) {
            }
        });
        fields.put(key, edit);
        return edit;
    }

    private void addPair(
            LinearLayout form,
            String title,
            String idleKey,
            String idleValue,
            String totalKey,
            String totalValue
    ) {
        TextView heading = label(activity, title + "枪数", 14);
        heading.setPadding(0, dp(8), 0, 0);
        form.addView(heading);
        LinearLayout row = new LinearLayout(activity);
        row.setOrientation(LinearLayout.HORIZONTAL);
        EditText idle = input("闲置", idleKey, idleValue, false);
        EditText total = input("总数", totalKey, totalValue, false);
        row.addView(idle, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        LinearLayout.LayoutParams totalParams = new LinearLayout.LayoutParams(
                0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f
        );
        totalParams.leftMargin = dp(10);
        row.addView(total, totalParams);
        form.addView(row);
    }

    private void addField(
            LinearLayout form,
            String hint,
            String key,
            String value,
            boolean decimal
    ) {
        form.addView(input(hint, key, value, decimal));
    }

    private EditText input(String hint, String key, String value, boolean decimal) {
        EditText edit = new EditText(activity);
        edit.setHint(hint);
        edit.setText(value);
        edit.setSingleLine(true);
        edit.setInputType(InputType.TYPE_CLASS_NUMBER
                | (decimal ? InputType.TYPE_NUMBER_FLAG_DECIMAL : 0));
        edit.setContentDescription(hint);
        edit.addTextChangedListener(new TextWatcher() {
            @Override
            public void beforeTextChanged(CharSequence text, int start, int count, int after) {
            }

            @Override
            public void onTextChanged(CharSequence text, int start, int before, int count) {
                if (binding) return;
                assign(key, text == null ? "" : text.toString());
                state.open = true;
                ManualBackfillDraftStore.save(activity, state);
                edit.setError(null);
                formError.setText("");
            }

            @Override
            public void afterTextChanged(Editable text) {
            }
        });
        fields.put(key, edit);
        return edit;
    }

    private EditText textInput(String hint, String key, String value) {
        EditText edit = new EditText(activity);
        edit.setHint(hint);
        edit.setText(value);
        edit.setSingleLine(false);
        edit.setMaxLines(3);
        edit.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE);
        edit.setContentDescription(hint);
        edit.addTextChangedListener(new TextWatcher() {
            @Override
            public void beforeTextChanged(CharSequence text, int start, int count, int after) {
            }

            @Override
            public void onTextChanged(CharSequence text, int start, int before, int count) {
                if (binding) return;
                assign(key, text == null ? "" : text.toString());
                state.open = true;
                ManualBackfillDraftStore.save(activity, state);
                edit.setError(null);
                if (formError != null) formError.setText("");
            }

            @Override
            public void afterTextChanged(Editable text) {
            }
        });
        fields.put(key, edit);
        return edit;
    }

    private void assign(String key, String value) {
        if (ManualBackfillDraft.ADDRESS.equals(key)) state.draft.address = value;
        else if (ManualBackfillDraft.PRICE.equals(key)) state.draft.price = value;
        else if (ManualBackfillDraft.FAST_IDLE.equals(key)) state.draft.fastIdle = value;
        else if (ManualBackfillDraft.FAST_TOTAL.equals(key)) state.draft.fastTotal = value;
        else if (ManualBackfillDraft.SLOW_IDLE.equals(key)) state.draft.slowIdle = value;
        else if (ManualBackfillDraft.SLOW_TOTAL.equals(key)) state.draft.slowTotal = value;
        else if (ManualBackfillDraft.SUPER_IDLE.equals(key)) state.draft.superIdle = value;
        else if (ManualBackfillDraft.SUPER_TOTAL.equals(key)) state.draft.superTotal = value;
    }

    private void save() {
        clearErrors();
        ManualBackfillRepository.SaveResult result;
        try {
            result = ManualBackfillRepository.save(activity, state);
        } catch (RuntimeException error) {
            formError.setText("保存失败，请重试");
            return;
        }
        if (!result.saved) {
            for (Map.Entry<String, String> error : result.validation.errors.entrySet()) {
                EditText field = fields.get(error.getKey());
                if (field == null) formError.setText(error.getValue());
                else field.setError(error.getValue());
            }
            return;
        }
        dialog.dismiss();
        listener.onSaved(result);
    }

    private void clearErrors() {
        formError.setText("");
        for (EditText field : fields.values()) field.setError(null);
    }

    private void discard() {
        ManualBackfillDraftStore.close(activity, state.stableIdentity, true);
        listener.onDiscarded();
    }

    private void confirmDelete() {
        new AlertDialog.Builder(activity)
                .setTitle("删除该记录")
                .setMessage("删除后该本地记录无法恢复，已回传的服务端数据不受影响。是否删除？")
                .setNegativeButton("取消", null)
                .setPositiveButton("确认删除", (d, w) -> {
                    ManualBackfillDraftStore.close(activity, state.stableIdentity, true);
                    if (dialog != null) dialog.dismiss();
                    listener.onDeleted(state);
                })
                .show();
    }

    private static TextView label(Context context, String text, int size) {
        TextView view = new TextView(context);
        view.setText(text);
        view.setTextSize(size);
        return view;
    }

    private int dp(int value) {
        return Math.round(value * activity.getResources().getDisplayMetrics().density);
    }
}
