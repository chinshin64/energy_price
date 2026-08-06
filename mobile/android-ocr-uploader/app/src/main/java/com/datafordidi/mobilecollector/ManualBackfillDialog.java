package com.datafordidi.mobilecollector;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.text.Editable;
import android.text.InputType;
import android.text.TextWatcher;
import android.view.Gravity;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONObject;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Canvas-style record detail editor. It keeps the existing draft/save/delete
 * semantics while presenting the record as a dedicated details screen.
 */
final class ManualBackfillDialog {
    interface Listener {
        void onSaved(ManualBackfillRepository.SaveResult result);
        void onDiscarded();
        default void onDeleted(ManualBackfillDraftStore.State state) {}
    }

    private final Activity activity;
    private final ManualBackfillDraftStore.State state;
    private final Listener listener;
    private final Palette palette;
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
        this.palette = Palette.from(activity);
    }

    static ManualBackfillDialog show(
            Activity activity,
            ManualBackfillDraftStore.State state,
            Listener listener
    ) {
        ManualBackfillDialog controller =
                new ManualBackfillDialog(activity, state, listener);
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
                .setView(buildScreen())
                .create();
        dialog.setOnCancelListener(value -> discard());
        dialog.setOnShowListener(value -> {
            Window window = dialog.getWindow();
            if (window != null) {
                window.setBackgroundDrawable(roundRect(palette.background, 22, 0, Color.TRANSPARENT));
                window.setLayout(
                        WindowManager.LayoutParams.MATCH_PARENT,
                        WindowManager.LayoutParams.MATCH_PARENT
                );
            }
        });
        dialog.show();
        Window window = dialog.getWindow();
        if (window != null) {
            window.setLayout(
                    WindowManager.LayoutParams.MATCH_PARENT,
                    WindowManager.LayoutParams.MATCH_PARENT
            );
        }
    }

    private View buildScreen() {
        LinearLayout root = new LinearLayout(activity);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(16), dp(14), dp(16), dp(14));
        root.setBackgroundColor(palette.background);

        LinearLayout header = new LinearLayout(activity);
        header.setGravity(Gravity.CENTER_VERTICAL);
        Button back = button("‹", 25, false);
        back.setTextColor(palette.textPrimary);
        back.setBackgroundColor(Color.TRANSPARENT);
        back.setOnClickListener(view -> {
            if (dialog != null) dialog.dismiss();
            discard();
        });
        header.addView(back, new LinearLayout.LayoutParams(dp(42), dp(46)));
        TextView title = text("记录详情", 22, true, palette.textPrimary);
        header.addView(title, new LinearLayout.LayoutParams(
                0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        TextView captured = text(
                CaptureTime.display(state.originalRow, null).label(),
                11, false, palette.textSecondary);
        captured.setGravity(Gravity.END);
        header.addView(captured);
        root.addView(header);

        ScrollView scroll = new ScrollView(activity);
        scroll.setFillViewport(true);
        LinearLayout form = new LinearLayout(activity);
        form.setOrientation(LinearLayout.VERTICAL);
        form.setPadding(0, dp(8), 0, dp(8));
        scroll.addView(form, new ScrollView.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT));

        JSONObject row = state.originalRow;
        LinearLayout stationCard = card();
        TextView station = text(
                row.optString("stationName", "未命名场站"),
                18, true, palette.textPrimary);
        station.setContentDescription("场站名称，只读：" + station.getText());
        stationCard.addView(station);
        TextView meta = text(
                StationDisplayFormatter.isFuel(row) ? "加油记录" : "充电记录",
                12, true,
                StationDisplayFormatter.isFuel(row) ? palette.primary : palette.success);
        meta.setPadding(0, dp(6), 0, 0);
        stationCard.addView(meta);
        LinearLayout.LayoutParams stationParams = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT);
        form.addView(stationCard, stationParams);

        if (!StationDisplayFormatter.isFuel(row)) {
            LinearLayout addressCard = card();
            addressCard.addView(sectionTitle("基础信息"));
            EditText address = textInput("场站地址", ManualBackfillDraft.ADDRESS, state.draft.address);
            LinearLayout.LayoutParams addressParams = inputParams();
            addressParams.topMargin = dp(8);
            addressCard.addView(address, addressParams);
            LinearLayout.LayoutParams cardParams = cardParams();
            form.addView(addressCard, cardParams);
        }

        if (StationDisplayFormatter.isFuel(row)) {
            buildFuelFields(form);
        } else {
            buildChargingFields(form);
        }

        formError = text("", 13, true, palette.danger);
        formError.setPadding(dp(4), dp(8), dp(4), 0);
        form.addView(formError);

        TextView confirmation = text(
                "保存后进入待回传；服务端确认入库后按现有策略处理本机记录。",
                12, false, palette.textSecondary);
        confirmation.setGravity(Gravity.CENTER);
        confirmation.setPadding(dp(6), dp(8), dp(6), dp(8));
        form.addView(confirmation);

        root.addView(scroll, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f));

        LinearLayout actions = new LinearLayout(activity);
        actions.setGravity(Gravity.CENTER_VERTICAL);
        Button save = button("保存修改", 15, true);
        save.setTextColor(Color.WHITE);
        save.setBackground(roundRect(palette.primary, 12, 0, Color.TRANSPARENT));
        save.setOnClickListener(view -> save());
        actions.addView(save, new LinearLayout.LayoutParams(
                0, dp(52), 1f));

        Button delete = button("删除记录", 15, true);
        delete.setTextColor(palette.danger);
        delete.setBackground(roundRect(palette.card, 12, 1, palette.danger));
        delete.setOnClickListener(view -> confirmDelete());
        LinearLayout.LayoutParams deleteParams = new LinearLayout.LayoutParams(
                0, dp(52), 1f);
        deleteParams.leftMargin = dp(10);
        actions.addView(delete, deleteParams);
        root.addView(actions);

        return root;
    }

    private void buildFuelFields(LinearLayout form) {
        JSONObject row = state.originalRow;

        LinearLayout summaryCard = card();
        summaryCard.addView(sectionTitle("识别摘要"));
        TextView summary = text(
                StationDisplayFormatter.fuelDetails(row),
                13, false, palette.textPrimary);
        summary.setLineSpacing(dp(4), 1f);
        summary.setPadding(0, dp(9), 0, 0);
        summaryCard.addView(summary);
        TextView status = text(
                StationDisplayFormatter.missingSummary(row),
                12, true,
                StationDisplayFormatter.incomplete(row) ? palette.warning : palette.success);
        status.setPadding(0, dp(8), 0, 0);
        summaryCard.addView(status);
        form.addView(summaryCard, cardParams());

        if (state.fuelDraft.grades.isEmpty()) state.fuelDraft.addGrade("");
        fuelGradeContainer = new LinearLayout(activity);
        fuelGradeContainer.setOrientation(LinearLayout.VERTICAL);
        form.addView(fuelGradeContainer);
        renderFuelGrades();

        Button add = button("＋ 添加油号", 14, true);
        add.setTextColor(palette.primary);
        add.setBackground(roundRect(palette.card, 12, 1, palette.primary));
        add.setOnClickListener(view -> {
            state.fuelDraft.addGrade("");
            state.open = true;
            ManualBackfillDraftStore.save(activity, state);
            renderFuelGrades();
        });
        LinearLayout.LayoutParams addParams = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, dp(48));
        addParams.topMargin = dp(10);
        form.addView(add, addParams);
    }

    private void renderFuelGrades() {
        fuelGradeContainer.removeAllViews();
        fields.entrySet().removeIf(entry -> entry.getKey().startsWith("grades["));
        for (int index = 0; index < state.fuelDraft.grades.size(); index++) {
            final int gradeIndex = index;
            FuelBackfillDraft.GradeDraft grade = state.fuelDraft.grades.get(index);

            LinearLayout card = card();
            LinearLayout header = new LinearLayout(activity);
            header.setGravity(Gravity.CENTER_VERTICAL);
            String title = grade.gradeLabel == null || grade.gradeLabel.trim().isEmpty()
                    ? "油号 " + (index + 1)
                    : grade.gradeLabel + " 汽油";
            TextView badge = text(title, 14, true, palette.primary);
            badge.setPadding(dp(9), dp(5), dp(9), dp(5));
            badge.setBackground(roundRect(palette.primarySoft, 9, 0, Color.TRANSPARENT));
            header.addView(badge);
            TextView cached = text("可编辑", 11, true, palette.success);
            cached.setGravity(Gravity.END);
            header.addView(cached, new LinearLayout.LayoutParams(
                    0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
            card.addView(header);

            EditText gradeInput = fuelInput(
                    "油号，如 92#", gradeIndex, "grade", grade.gradeLabel, false);
            LinearLayout.LayoutParams gradeParams = inputParams();
            gradeParams.topMargin = dp(10);
            card.addView(gradeInput, gradeParams);

            LinearLayout priceRow = new LinearLayout(activity);
            priceRow.setOrientation(LinearLayout.HORIZONTAL);
            EditText displayPrice = fuelInput(
                    "外显/优惠价", gradeIndex, "discountPrice",
                    grade.discountPrice, true);
            EditText stationPrice = fuelInput(
                    "油站/挂牌价", gradeIndex, "listPrice",
                    grade.listPrice, true);
            priceRow.addView(displayPrice, new LinearLayout.LayoutParams(
                    0, dp(50), 1f));
            LinearLayout.LayoutParams stationPriceParams =
                    new LinearLayout.LayoutParams(0, dp(50), 1f);
            stationPriceParams.leftMargin = dp(8);
            priceRow.addView(stationPrice, stationPriceParams);
            LinearLayout.LayoutParams priceRowParams = new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT);
            priceRowParams.topMargin = dp(8);
            card.addView(priceRow, priceRowParams);

            EditText other = fuelInput(
                    "其他油价（元/升）", gradeIndex, "unclassifiedPrice",
                    grade.unclassifiedPrice, true);
            LinearLayout.LayoutParams otherParams = inputParams();
            otherParams.topMargin = dp(8);
            card.addView(other, otherParams);

            Button remove = button("删除该油号", 13, true);
            remove.setTextColor(palette.danger);
            remove.setBackground(roundRect(palette.card, 10, 1, palette.danger));
            remove.setOnClickListener(view -> {
                if (state.fuelDraft.grades.size() <= 1) {
                    formError.setText("至少保留一个油号");
                    return;
                }
                state.fuelDraft.removeGrade(gradeIndex);
                ManualBackfillDraftStore.save(activity, state);
                renderFuelGrades();
            });
            LinearLayout.LayoutParams removeParams = new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT, dp(44));
            removeParams.topMargin = dp(9);
            card.addView(remove, removeParams);

            fuelGradeContainer.addView(card, cardParams());
        }
    }

    private void buildChargingFields(LinearLayout form) {
        LinearLayout priceCard = card();
        priceCard.addView(sectionTitle("价格信息"));
        EditText price = input(
                "主价格（元/度）", ManualBackfillDraft.PRICE, state.draft.price, true);
        LinearLayout.LayoutParams priceParams = inputParams();
        priceParams.topMargin = dp(8);
        priceCard.addView(price, priceParams);
        form.addView(priceCard, cardParams());

        addChargingTypeCard(
                form, "快充",
                ManualBackfillDraft.FAST_IDLE, state.draft.fastIdle,
                ManualBackfillDraft.FAST_TOTAL, state.draft.fastTotal);
        addChargingTypeCard(
                form, "慢充",
                ManualBackfillDraft.SLOW_IDLE, state.draft.slowIdle,
                ManualBackfillDraft.SLOW_TOTAL, state.draft.slowTotal);
        addChargingTypeCard(
                form, "超充",
                ManualBackfillDraft.SUPER_IDLE, state.draft.superIdle,
                ManualBackfillDraft.SUPER_TOTAL, state.draft.superTotal);
    }

    private void addChargingTypeCard(
            LinearLayout form,
            String title,
            String idleKey,
            String idleValue,
            String totalKey,
            String totalValue
    ) {
        LinearLayout card = card();
        card.addView(sectionTitle(title));
        LinearLayout row = new LinearLayout(activity);
        row.setOrientation(LinearLayout.HORIZONTAL);
        EditText idle = input("闲置", idleKey, idleValue, false);
        EditText total = input("总数", totalKey, totalValue, false);
        row.addView(idle, new LinearLayout.LayoutParams(0, dp(50), 1f));
        LinearLayout.LayoutParams totalParams =
                new LinearLayout.LayoutParams(0, dp(50), 1f);
        totalParams.leftMargin = dp(8);
        row.addView(total, totalParams);
        LinearLayout.LayoutParams rowParams = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT);
        rowParams.topMargin = dp(8);
        card.addView(row, rowParams);
        form.addView(card, cardParams());
    }

    private EditText fuelInput(
            String hint,
            int gradeIndex,
            String property,
            String value,
            boolean decimal
    ) {
        EditText edit = styledInput(hint, value);
        edit.setInputType(decimal
                ? InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_FLAG_DECIMAL
                : InputType.TYPE_CLASS_TEXT);
        String key = "grades[" + gradeIndex + "]." + property;
        edit.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence text, int start, int count, int after) {}
            @Override public void onTextChanged(CharSequence text, int start, int before, int count) {
                if (binding || gradeIndex >= state.fuelDraft.grades.size()) return;
                String changed = text == null ? "" : text.toString();
                FuelBackfillDraft.GradeDraft grade =
                        state.fuelDraft.grades.get(gradeIndex);
                if ("grade".equals(property)) {
                    grade.gradeLabel = changed;
                    grade.gradeCode = changed
                            .replace("#", "")
                            .replace("＃", "")
                            .trim();
                } else if ("discountPrice".equals(property)) {
                    grade.discountPrice = changed;
                } else if ("listPrice".equals(property)) {
                    grade.listPrice = changed;
                } else if ("unclassifiedPrice".equals(property)) {
                    grade.unclassifiedPrice = changed;
                }
                persistDraft();
                edit.setError(null);
                if (formError != null) formError.setText("");
            }
            @Override public void afterTextChanged(Editable text) {}
        });
        fields.put(key, edit);
        return edit;
    }

    private EditText input(String hint, String key, String value, boolean decimal) {
        EditText edit = styledInput(hint, value);
        edit.setInputType(InputType.TYPE_CLASS_NUMBER
                | (decimal ? InputType.TYPE_NUMBER_FLAG_DECIMAL : 0));
        edit.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence text, int start, int count, int after) {}
            @Override public void onTextChanged(CharSequence text, int start, int before, int count) {
                if (binding) return;
                assign(key, text == null ? "" : text.toString());
                persistDraft();
                edit.setError(null);
                if (formError != null) formError.setText("");
            }
            @Override public void afterTextChanged(Editable text) {}
        });
        fields.put(key, edit);
        return edit;
    }

    private EditText textInput(String hint, String key, String value) {
        EditText edit = styledInput(hint, value);
        edit.setSingleLine(false);
        edit.setMaxLines(3);
        edit.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE);
        edit.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence text, int start, int count, int after) {}
            @Override public void onTextChanged(CharSequence text, int start, int before, int count) {
                if (binding) return;
                assign(key, text == null ? "" : text.toString());
                persistDraft();
                edit.setError(null);
                if (formError != null) formError.setText("");
            }
            @Override public void afterTextChanged(Editable text) {}
        });
        fields.put(key, edit);
        return edit;
    }

    private EditText styledInput(String hint, String value) {
        EditText edit = new EditText(activity);
        edit.setHint(hint);
        edit.setText(value == null ? "" : value);
        edit.setSingleLine(true);
        edit.setTextSize(13);
        edit.setTextColor(palette.textPrimary);
        edit.setHintTextColor(palette.textSecondary);
        edit.setPadding(dp(12), 0, dp(12), 0);
        edit.setBackground(roundRect(palette.inputBackground, 10, 1, palette.border));
        edit.setContentDescription(hint);
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

    private void persistDraft() {
        state.open = true;
        ManualBackfillDraftStore.save(activity, state);
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
        if (dialog != null) dialog.dismiss();
        listener.onSaved(result);
    }

    private void clearErrors() {
        if (formError != null) formError.setText("");
        for (EditText field : fields.values()) field.setError(null);
    }

    private void discard() {
        ManualBackfillDraftStore.close(activity, state.stableIdentity, true);
        listener.onDiscarded();
    }

    private void confirmDelete() {
        new AlertDialog.Builder(activity)
                .setTitle("删除记录")
                .setMessage("删除后该本地记录无法恢复，已回传的服务端数据不受影响。")
                .setNegativeButton("取消", null)
                .setPositiveButton("确认删除", (d, w) -> {
                    ManualBackfillDraftStore.close(
                            activity, state.stableIdentity, true);
                    if (dialog != null) dialog.dismiss();
                    listener.onDeleted(state);
                })
                .show();
    }

    private LinearLayout card() {
        LinearLayout card = new LinearLayout(activity);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(14), dp(13), dp(14), dp(13));
        card.setBackground(roundRect(palette.card, 15, 1, palette.border));
        card.setElevation(dp(1));
        return card;
    }

    private TextView sectionTitle(String value) {
        return text(value, 15, true, palette.textPrimary);
    }

    private LinearLayout.LayoutParams cardParams() {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT);
        params.topMargin = dp(10);
        return params;
    }

    private LinearLayout.LayoutParams inputParams() {
        return new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, dp(50));
    }

    private Button button(String label, int sp, boolean bold) {
        Button button = new Button(activity);
        button.setText(label);
        button.setTextSize(sp);
        button.setAllCaps(false);
        button.setMinWidth(0);
        button.setMinHeight(0);
        button.setPadding(dp(12), 0, dp(12), 0);
        if (bold) button.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        return button;
    }

    private TextView text(String value, int sp, boolean bold, int color) {
        TextView view = new TextView(activity);
        view.setText(value);
        view.setTextSize(sp);
        view.setTextColor(color);
        if (bold) view.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        return view;
    }

    private GradientDrawable roundRect(
            int color,
            int radiusDp,
            int strokeDp,
            int strokeColor
    ) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(color);
        drawable.setCornerRadius(dp(radiusDp));
        if (strokeDp > 0) drawable.setStroke(dp(strokeDp), strokeColor);
        return drawable;
    }

    private int dp(int value) {
        return Math.round(value * activity.getResources().getDisplayMetrics().density);
    }

    private static final class Palette {
        final int background;
        final int card;
        final int inputBackground;
        final int border;
        final int textPrimary;
        final int textSecondary;
        final int primary;
        final int primarySoft;
        final int warning;
        final int success;
        final int danger;

        Palette(boolean dark) {
            background = Color.parseColor(dark ? "#0E1520" : "#F3F7FD");
            card = Color.parseColor(dark ? "#182231" : "#FFFFFF");
            inputBackground = Color.parseColor(dark ? "#111B28" : "#F7F9FC");
            border = Color.parseColor(dark ? "#304156" : "#E1E8F2");
            textPrimary = Color.parseColor(dark ? "#F3F7FC" : "#101828");
            textSecondary = Color.parseColor(dark ? "#B9C6D8" : "#667085");
            primary = Color.parseColor(dark ? "#69A7FF" : "#1265F6");
            primarySoft = Color.parseColor(dark ? "#203B61" : "#EAF2FF");
            warning = Color.parseColor(dark ? "#FFD27A" : "#B26A00");
            success = Color.parseColor(dark ? "#5ED6A7" : "#11B88A");
            danger = Color.parseColor(dark ? "#FF7E86" : "#F04438");
        }

        static Palette from(Context context) {
            int mode = context.getResources().getConfiguration().uiMode
                    & Configuration.UI_MODE_NIGHT_MASK;
            return new Palette(mode == Configuration.UI_MODE_NIGHT_YES);
        }
    }
}
