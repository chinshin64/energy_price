package com.datafordidi.mobilecollector;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.text.Editable;
import android.text.TextUtils;
import android.text.TextWatcher;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputMethodManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Switch;
import android.widget.TextView;

import androidx.recyclerview.widget.LinearLayoutManager;
import androidx.recyclerview.widget.RecyclerView;

import com.datafordidi.ocruploader.BuildConfig;

import org.json.JSONArray;
import org.json.JSONObject;

import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * Canvas-style application shell. The floating recognition window intentionally
 * remains owned by ManualOcrService and is not changed by this view.
 */
final class ResultDashboardView extends LinearLayout {
    interface Listener {
        void onPrimaryAction();
        void onClearCompleted();
        void onCheckUpdate();
        void onFilterSelected(StationResultPresenter.Filter filter);
        void onNameQueryChanged(String query);
        void onStartTimeRequested();
        void onEndTimeRequested();
        void onResetRecordFilters();
        void onEditBackfill(JSONObject row);
        void onDeleteSelected(Set<String> stableIdentities);
    }

    private static final int TAB_CAPTURE = 0;
    private static final int TAB_RECORDS = 1;
    private static final int TAB_SETTINGS = 2;
    private static final String UI_PREFS = "information_dashboard_ui";
    private static final String PREF_AUTO_UPDATE = "auto_update_on_start";
    private static final DateTimeFormatter FILTER_TIME =
            DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss");
    private static final DateTimeFormatter HOME_TIME =
            DateTimeFormatter.ofPattern("HH:mm");

    private final Palette palette;
    private final FrameLayout contentFrame;
    private final LinearLayout capturePanel;
    private final LinearLayout recordsPanel;
    private final LinearLayout settingsPanel;
    private final Button[] navigationButtons = new Button[3];

    private TextView statusView;
    private TextView todayValue;
    private TextView completenessValue;
    private TextView latestValue;
    private Button homePrimaryButton;
    private LinearLayout recentCard;
    private TextView recentName;
    private TextView recentTime;
    private LinearLayout recentBody;
    private JSONObject recentRow;

    private final Button[] filterButtons = new Button[3];
    private EditText nameSearch;
    private Button startTimeButton;
    private Button endTimeButton;
    private TextView matchCountView;
    private Button recordActionButton;
    private Button multiSelectButton;
    private Button selectAllButton;
    private StationAdapter adapter;
    private TextView emptyView;
    private Switch autoUpdateSwitch;

    private Listener listener;
    private boolean selectionMode;
    private boolean settingFilterState;
    private CaptureUiState captureUiState = CaptureUiState.STOPPED;
    private final Set<String> selectedKeys = new LinkedHashSet<>();

    ResultDashboardView(Context context) {
        super(context);
        palette = Palette.from(context);
        setOrientation(VERTICAL);
        setBackgroundColor(palette.background);

        contentFrame = new FrameLayout(context);
        addView(contentFrame, new LayoutParams(LayoutParams.MATCH_PARENT, 0, 1f));

        capturePanel = buildCapturePanel();
        recordsPanel = buildRecordsPanel();
        settingsPanel = buildSettingsPanel();
        contentFrame.addView(capturePanel, frameParams());
        contentFrame.addView(recordsPanel, frameParams());
        contentFrame.addView(settingsPanel, frameParams());

        LinearLayout navigation = new LinearLayout(context);
        navigation.setGravity(Gravity.CENTER);
        navigation.setPadding(dp(10), dp(4), dp(10), dp(5));
        navigation.setBackground(roundRect(palette.card, 0, 1, palette.border));
        String[] icons = {"▣", "▤", "⚙"};
        String[] labels = {"采集", "记录", "设置"};
        for (int index = 0; index < labels.length; index++) {
            final int tab = index;
            Button button = button(icons[index] + "\n" + labels[index], 12, true);
            button.setGravity(Gravity.CENTER);
            button.setPadding(0, 0, 0, 0);
            button.setBackgroundColor(Color.TRANSPARENT);
            button.setOnClickListener(view -> switchTab(tab));
            navigationButtons[index] = button;
            navigation.addView(button, new LayoutParams(0, dp(58), 1f));
        }
        addView(navigation, new LayoutParams(LayoutParams.MATCH_PARENT, dp(66)));

        selectFilter(StationResultPresenter.Filter.ALL);
        switchTab(TAB_CAPTURE);
    }

    private LinearLayout buildCapturePanel() {
        LinearLayout panel = new LinearLayout(getContext());
        panel.setOrientation(VERTICAL);
        panel.setPadding(dp(18), dp(18), dp(18), dp(14));

        ScrollView scroll = new ScrollView(getContext());
        scroll.setFillViewport(true);
        LinearLayout body = new LinearLayout(getContext());
        body.setOrientation(VERTICAL);
        scroll.addView(body, new ScrollView.LayoutParams(
                LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT));

        LinearLayout header = new LinearLayout(getContext());
        header.setGravity(Gravity.CENTER_VERTICAL);
        LinearLayout titles = new LinearLayout(getContext());
        titles.setOrientation(VERTICAL);
        titles.addView(text("信息自动识别", 25, true, palette.textPrimary));
        TextView subtitle = text("高德加油信息采集", 14, false, palette.textSecondary);
        subtitle.setPadding(0, dp(4), 0, 0);
        titles.addView(subtitle);
        header.addView(titles, new LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f));

        statusView = text("已停止", 12, true, palette.primary);
        statusView.setGravity(Gravity.CENTER);
        statusView.setPadding(dp(12), dp(7), dp(12), dp(7));
        statusView.setBackground(roundRect(palette.primarySoft, 18, 0, Color.TRANSPARENT));
        header.addView(statusView, new LayoutParams(LayoutParams.WRAP_CONTENT, dp(38)));
        body.addView(header);

        LinearLayout metrics = new LinearLayout(getContext());
        metrics.setOrientation(HORIZONTAL);
        LayoutParams metricRowParams = new LayoutParams(
                LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT);
        metricRowParams.topMargin = dp(20);
        body.addView(metrics, metricRowParams);
        todayValue = addMetric(metrics, "◆", "今日识别", "0", palette.primary, 0);
        completenessValue = addMetric(metrics, "✓", "字段完整率", "0%", palette.success, 1);
        latestValue = addMetric(metrics, "◷", "最近识别", "--:--", palette.primary, 2);

        homePrimaryButton = button("▣  开始识别", 17, true);
        homePrimaryButton.setTextColor(Color.WHITE);
        homePrimaryButton.setBackground(roundRect(palette.primary, 13, 0, Color.TRANSPARENT));
        homePrimaryButton.setOnClickListener(view -> {
            if (listener != null) listener.onPrimaryAction();
        });
        LayoutParams primaryParams = new LayoutParams(LayoutParams.MATCH_PARENT, dp(58));
        primaryParams.topMargin = dp(20);
        body.addView(homePrimaryButton, primaryParams);

        LinearLayout recentHeader = new LinearLayout(getContext());
        recentHeader.setGravity(Gravity.CENTER_VERTICAL);
        recentHeader.addView(text("最近采集", 17, true, palette.textPrimary),
                new LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f));
        TextView clock = text("◷", 18, false, palette.textSecondary);
        clock.setGravity(Gravity.CENTER);
        recentHeader.addView(clock, new LayoutParams(dp(36), dp(42)));
        LayoutParams recentHeaderParams = new LayoutParams(
                LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT);
        recentHeaderParams.topMargin = dp(18);
        body.addView(recentHeader, recentHeaderParams);

        recentCard = new LinearLayout(getContext());
        recentCard.setOrientation(VERTICAL);
        recentCard.setPadding(dp(15), dp(14), dp(15), dp(14));
        recentCard.setBackground(roundRect(palette.card, 16, 1, palette.border));
        recentCard.setElevation(dp(1));
        recentCard.setOnClickListener(view -> {
            if (listener != null && recentRow != null) {
                listener.onEditBackfill(AddressFreePayload.copyObject(recentRow));
            }
        });

        LinearLayout recentTop = new LinearLayout(getContext());
        recentTop.setGravity(Gravity.TOP);
        recentName = text("暂无识别记录", 16, true, palette.textPrimary);
        recentName.setMaxLines(2);
        recentName.setEllipsize(TextUtils.TruncateAt.END);
        recentTop.addView(recentName, new LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f));
        recentTime = text("", 11, false, palette.textSecondary);
        recentTop.addView(recentTime);
        recentCard.addView(recentTop);

        recentBody = new LinearLayout(getContext());
        recentBody.setOrientation(VERTICAL);
        LayoutParams recentBodyParams = new LayoutParams(
                LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT);
        recentBodyParams.topMargin = dp(10);
        recentCard.addView(recentBody, recentBodyParams);
        showRecentPlaceholder();

        LayoutParams recentCardParams = new LayoutParams(
                LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT);
        recentCardParams.topMargin = dp(6);
        body.addView(recentCard, recentCardParams);

        TextView hint = text(
                "启动后切换到高德，在目标页面使用现有悬浮窗完成详情页与支付页识别。",
                12, false, palette.textSecondary);
        hint.setLineSpacing(dp(2), 1f);
        LayoutParams hintParams = new LayoutParams(
                LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT);
        hintParams.topMargin = dp(13);
        body.addView(hint, hintParams);

        panel.addView(scroll, new LayoutParams(
                LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT));
        return panel;
    }

    private LinearLayout buildRecordsPanel() {
        LinearLayout panel = new LinearLayout(getContext());
        panel.setOrientation(VERTICAL);
        panel.setPadding(dp(14), dp(15), dp(14), dp(8));

        panel.addView(text("记录查询", 23, true, palette.textPrimary));

        LinearLayout filters = new LinearLayout(getContext());
        filters.setOrientation(VERTICAL);
        filters.setPadding(dp(11), dp(10), dp(11), dp(9));
        filters.setBackground(roundRect(palette.card, 15, 1, palette.border));
        LayoutParams filtersParams = new LayoutParams(
                LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT);
        filtersParams.topMargin = dp(12);
        panel.addView(filters, filtersParams);

        nameSearch = new EditText(getContext());
        nameSearch.setSingleLine(true);
        nameSearch.setTextSize(14);
        nameSearch.setTextColor(palette.textPrimary);
        nameSearch.setHintTextColor(palette.textSecondary);
        nameSearch.setHint("⌕  搜索场站/油站名称");
        nameSearch.setImeOptions(EditorInfo.IME_ACTION_SEARCH);
        nameSearch.setPadding(dp(12), 0, dp(12), 0);
        nameSearch.setBackground(roundRect(palette.inputBackground, 11, 1, palette.border));
        nameSearch.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence value, int start, int count, int after) {}
            @Override public void onTextChanged(CharSequence value, int start, int before, int count) {
                if (!settingFilterState && listener != null) {
                    listener.onNameQueryChanged(value == null ? "" : value.toString());
                }
            }
            @Override public void afterTextChanged(Editable value) {}
        });
        nameSearch.setOnEditorActionListener((view, actionId, event) -> {
            if (actionId != EditorInfo.IME_ACTION_SEARCH) return false;
            finishSearchInput();
            if (listener != null) listener.onNameQueryChanged(nameSearch.getText().toString());
            return true;
        });
        filters.addView(nameSearch, new LayoutParams(LayoutParams.MATCH_PARENT, dp(46)));

        LinearLayout timeRow = new LinearLayout(getContext());
        timeRow.setGravity(Gravity.CENTER_VERTICAL);
        startTimeButton = timeButton("开始日期", "设置开始日期时间");
        startTimeButton.setOnClickListener(view -> {
            if (listener != null) listener.onStartTimeRequested();
        });
        endTimeButton = timeButton("结束日期", "设置结束日期时间");
        endTimeButton.setOnClickListener(view -> {
            if (listener != null) listener.onEndTimeRequested();
        });
        timeRow.addView(startTimeButton, new LayoutParams(0, dp(48), 1f));
        TextView separator = text("~", 15, false, palette.textSecondary);
        separator.setGravity(Gravity.CENTER);
        timeRow.addView(separator, new LayoutParams(dp(28), dp(48)));
        timeRow.addView(endTimeButton, new LayoutParams(0, dp(48), 1f));
        LayoutParams timeParams = new LayoutParams(
                LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT);
        timeParams.topMargin = dp(7);
        filters.addView(timeRow, timeParams);

        LinearLayout chipRow = new LinearLayout(getContext());
        chipRow.setGravity(Gravity.CENTER_VERTICAL);
        String[] labels = {"全部", "充电", "加油"};
        StationResultPresenter.Filter[] values = {
                StationResultPresenter.Filter.ALL,
                StationResultPresenter.Filter.CHARGING,
                StationResultPresenter.Filter.FUEL
        };
        for (int index = 0; index < labels.length; index++) {
            final StationResultPresenter.Filter value = values[index];
            Button chip = button(labels[index], 13, true);
            chip.setOnClickListener(view -> {
                if (listener != null) listener.onFilterSelected(value);
            });
            filterButtons[index] = chip;
            LayoutParams params = new LayoutParams(0, dp(40), 1f);
            if (index > 0) params.leftMargin = dp(7);
            chipRow.addView(chip, params);
        }
        Button reset = textButton("↻ 重置");
        reset.setOnClickListener(view -> {
            if (listener != null) listener.onResetRecordFilters();
        });
        LayoutParams resetParams = new LayoutParams(LayoutParams.WRAP_CONTENT, dp(40));
        resetParams.leftMargin = dp(7);
        chipRow.addView(reset, resetParams);
        LayoutParams chipParams = new LayoutParams(
                LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT);
        chipParams.topMargin = dp(8);
        filters.addView(chipRow, chipParams);

        matchCountView = text("找到 0 条", 12, false, palette.textSecondary);
        LayoutParams countParams = new LayoutParams(
                LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT);
        countParams.topMargin = dp(7);
        filters.addView(matchCountView, countParams);

        FrameLayout resultsFrame = new FrameLayout(getContext());
        RecyclerView results = new RecyclerView(getContext());
        results.setLayoutManager(new LinearLayoutManager(getContext()));
        results.setClipToPadding(false);
        results.setPadding(0, dp(9), 0, dp(9));
        adapter = new StationAdapter();
        results.setAdapter(adapter);
        resultsFrame.addView(results, new FrameLayout.LayoutParams(
                LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT));

        emptyView = text("暂无识别结果\n点击“采集”开始识别", 15, false, palette.textSecondary);
        emptyView.setGravity(Gravity.CENTER);
        resultsFrame.addView(emptyView, new FrameLayout.LayoutParams(
                LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT));
        panel.addView(resultsFrame, new LayoutParams(LayoutParams.MATCH_PARENT, 0, 1f));

        LinearLayout actions = new LinearLayout(getContext());
        actions.setGravity(Gravity.CENTER_VERTICAL);
        recordActionButton = button("开始识别", 15, true);
        recordActionButton.setTextColor(Color.WHITE);
        recordActionButton.setBackground(roundRect(palette.primary, 12, 0, Color.TRANSPARENT));
        recordActionButton.setOnClickListener(view -> {
            if (selectionMode) {
                if (listener != null && !selectedKeys.isEmpty()) {
                    listener.onDeleteSelected(new LinkedHashSet<>(selectedKeys));
                }
            } else if (listener != null) {
                listener.onPrimaryAction();
            }
        });
        actions.addView(recordActionButton, new LayoutParams(0, dp(50), 1f));

        multiSelectButton = outlineButton("多选", palette.textSecondary, palette.border);
        multiSelectButton.setOnClickListener(view -> toggleSelectionMode());
        LayoutParams multiParams = new LayoutParams(LayoutParams.WRAP_CONTENT, dp(50));
        multiParams.leftMargin = dp(8);
        actions.addView(multiSelectButton, multiParams);

        selectAllButton = outlineButton("全选", palette.textSecondary, palette.border);
        selectAllButton.setVisibility(GONE);
        selectAllButton.setOnClickListener(view -> toggleSelectAll());
        LayoutParams allParams = new LayoutParams(LayoutParams.WRAP_CONTENT, dp(50));
        allParams.leftMargin = dp(8);
        actions.addView(selectAllButton, allParams);
        panel.addView(actions);

        return panel;
    }

    private LinearLayout buildSettingsPanel() {
        LinearLayout panel = new LinearLayout(getContext());
        panel.setOrientation(VERTICAL);
        panel.setPadding(dp(16), dp(16), dp(16), dp(16));

        ScrollView scroll = new ScrollView(getContext());
        LinearLayout body = new LinearLayout(getContext());
        body.setOrientation(VERTICAL);
        scroll.addView(body);

        body.addView(text("设置", 23, true, palette.textPrimary));

        TextView generalLabel = sectionLabel("通用");
        LayoutParams generalLabelParams = new LayoutParams(
                LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT);
        generalLabelParams.topMargin = dp(16);
        body.addView(generalLabel, generalLabelParams);

        LinearLayout generalCard = card();
        Button update = settingAction("检查更新", "›");
        update.setOnClickListener(view -> {
            if (listener != null) listener.onCheckUpdate();
        });
        generalCard.addView(update, new LayoutParams(LayoutParams.MATCH_PARENT, dp(52)));
        generalCard.addView(divider());
        generalCard.addView(settingRow("当前版本", BuildConfig.VERSION_NAME),
                new LayoutParams(LayoutParams.MATCH_PARENT, dp(52)));
        generalCard.addView(divider());

        LinearLayout autoRow = new LinearLayout(getContext());
        autoRow.setGravity(Gravity.CENTER_VERTICAL);
        autoRow.setPadding(dp(2), 0, dp(2), 0);
        autoRow.addView(text("启动时检测更新", 14, false, palette.textPrimary),
                new LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f));
        autoUpdateSwitch = new Switch(getContext());
        autoUpdateSwitch.setChecked(isAutoUpdateEnabled(getContext()));
        autoUpdateSwitch.setOnCheckedChangeListener((buttonView, checked) ->
                getContext().getSharedPreferences(UI_PREFS, Context.MODE_PRIVATE)
                        .edit().putBoolean(PREF_AUTO_UPDATE, checked).apply());
        autoRow.addView(autoUpdateSwitch);
        generalCard.addView(autoRow, new LayoutParams(LayoutParams.MATCH_PARENT, dp(52)));
        body.addView(generalCard);

        TextView dataLabel = sectionLabel("数据");
        LayoutParams dataLabelParams = new LayoutParams(
                LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT);
        dataLabelParams.topMargin = dp(16);
        body.addView(dataLabel, dataLabelParams);

        LinearLayout dataCard = card();
        Button upload = settingAction("上传配置", "›");
        upload.setOnClickListener(view -> {
            statusView.setText("上传配置已由 provisioning 管理");
            switchTab(TAB_CAPTURE);
        });
        dataCard.addView(upload, new LayoutParams(LayoutParams.MATCH_PARENT, dp(52)));
        dataCard.addView(divider());
        Button clear = settingAction("清除已完成记录", "›");
        clear.setOnClickListener(view -> {
            if (listener != null) listener.onClearCompleted();
        });
        dataCard.addView(clear, new LayoutParams(LayoutParams.MATCH_PARENT, dp(52)));
        body.addView(dataCard);

        TextView aboutLabel = sectionLabel("关于");
        LayoutParams aboutLabelParams = new LayoutParams(
                LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT);
        aboutLabelParams.topMargin = dp(16);
        body.addView(aboutLabel, aboutLabelParams);

        LinearLayout aboutCard = card();
        aboutCard.addView(settingInfo("识别说明", "详情页 + 支付页合并采集"),
                new LayoutParams(LayoutParams.MATCH_PARENT, dp(56)));
        aboutCard.addView(divider());
        aboutCard.addView(settingInfo("关于信息自动识别", "Android 11+"),
                new LayoutParams(LayoutParams.MATCH_PARENT, dp(56)));
        body.addView(aboutCard);

        TextView footer = text(
                "悬浮识别页保持当前版本设计；本次仅更新采集、记录、详情与设置界面。",
                12, false, palette.textSecondary);
        footer.setGravity(Gravity.CENTER);
        LayoutParams footerParams = new LayoutParams(
                LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT);
        footerParams.topMargin = dp(18);
        body.addView(footer, footerParams);

        panel.addView(scroll, new LayoutParams(
                LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT));
        return panel;
    }

    static boolean isAutoUpdateEnabled(Context context) {
        SharedPreferences preferences =
                context.getSharedPreferences(UI_PREFS, Context.MODE_PRIVATE);
        return preferences.getBoolean(PREF_AUTO_UPDATE, true);
    }

    void setListener(Listener listener) {
        this.listener = listener;
    }

    void exitSelectionMode() {
        if (!selectionMode && selectedKeys.isEmpty()) return;
        selectionMode = false;
        selectedKeys.clear();
        updateActionButtons();
        adapter.notifyVisibleRowsChanged();
    }

    boolean isSelectionMode() {
        return selectionMode;
    }

    void setCaptureState(CaptureUiState state) {
        captureUiState = state == null ? CaptureUiState.STOPPED : state;
        statusView.setText(captureUiState.label);
        statusView.setTextColor(captureUiState.stopAction ? palette.success : palette.primary);
        statusView.setBackground(roundRect(
                captureUiState.stopAction ? palette.successSoft : palette.primarySoft,
                18, 0, Color.TRANSPARENT));

        String label = captureUiState.primaryLabel;
        homePrimaryButton.setText((captureUiState.stopAction ? "■  " : "▣  ") + label);
        homePrimaryButton.setEnabled(captureUiState.primaryEnabled);
        homePrimaryButton.setAlpha(captureUiState.primaryEnabled ? 1f : 0.55f);
        if (!selectionMode) {
            recordActionButton.setText(label);
            recordActionButton.setEnabled(captureUiState.primaryEnabled);
            recordActionButton.setAlpha(captureUiState.primaryEnabled ? 1f : 0.55f);
        }
    }

    void setRecordFilter(StationRecordFilter filter) {
        StationRecordFilter value = filter == null ? StationRecordFilter.EMPTY : filter;
        settingFilterState = true;
        if (!value.nameQuery.equals(nameSearch.getText().toString())) {
            nameSearch.setText(value.nameQuery);
            nameSearch.setSelection(nameSearch.length());
        }
        settingFilterState = false;
        setTimeButton(startTimeButton, "开始日期", "开始",
                value.startEpochMillis, "设置开始日期时间");
        setTimeButton(endTimeButton, "结束日期", "结束",
                value.endEpochMillis, "设置结束日期时间");
    }

    void render(
            StationResultPresenter.ViewState state,
            boolean hasLocalRecords,
            boolean hasActiveFilters
    ) {
        if (state == null) return;
        int complete = Math.max(0, state.validStations - state.incomplete);
        int percentage = state.validStations == 0
                ? 0 : Math.round(complete * 100f / state.validStations);
        todayValue.setText(String.valueOf(countToday(state.rows)));
        completenessValue.setText(percentage + "%");
        latestValue.setText(latestTime(state.rows));
        updateRecent(state.rows);

        selectFilter(state.filter);
        adapter.submit(state.rows);
        matchCountView.setText("找到 " + state.rows.size() + " 条");
        if (state.rows.isEmpty()) {
            String message = hasLocalRecords && hasActiveFilters
                    ? "没有符合筛选条件的记录"
                    : "暂无识别结果\n点击“采集”开始识别";
            emptyView.setText(message);
            emptyView.setVisibility(VISIBLE);
        } else {
            emptyView.setVisibility(GONE);
        }
    }

    private void updateRecent(List<JSONObject> rows) {
        recentRow = rows == null || rows.isEmpty() ? null : rows.get(0);
        recentBody.removeAllViews();
        if (recentRow == null) {
            recentName.setText("暂无识别记录");
            recentTime.setText("");
            showRecentPlaceholder();
            recentCard.setAlpha(0.76f);
            return;
        }
        recentCard.setAlpha(1f);
        String station = StationRecordFilter.stationName(recentRow);
        recentName.setText(station.isEmpty() ? "未命名场站" : station);
        recentTime.setText(StationDisplayFormatter.capturedAt(recentRow));
        if (StationDisplayFormatter.isFuel(recentRow)) {
            addFuelRows(recentBody, recentRow, true);
        } else {
            addChargingSummary(recentBody, recentRow);
        }
    }

    private void showRecentPlaceholder() {
        recentBody.removeAllViews();
        TextView placeholder = text(
                "完成识别后，最近一条结果会显示在这里",
                13, false, palette.textSecondary);
        recentBody.addView(placeholder);
    }

    private void addFuelRows(LinearLayout container, JSONObject row, boolean compact) {
        JSONObject fuel = row == null ? null : row.optJSONObject("fuelObservation");
        JSONArray offers = fuel == null ? null : fuel.optJSONArray("fuelOffers");
        JSONArray quotes = fuel == null ? null : fuel.optJSONArray("fuelQuotes");
        int count = offers == null ? 0 : offers.length();
        if (count == 0) {
            container.addView(text("油价信息待补充", 13, false, palette.warning));
            return;
        }
        for (int index = 0; index < count; index++) {
            JSONObject offer = offers.optJSONObject(index);
            if (offer == null) continue;
            JSONObject quote = findQuote(quotes, offer);
            LinearLayout line = new LinearLayout(getContext());
            line.setOrientation(VERTICAL);
            line.setPadding(dp(10), dp(9), dp(10), dp(9));
            line.setBackground(roundRect(palette.inputBackground, 11, 0, Color.TRANSPARENT));
            if (index > 0) {
                LayoutParams lineParams = new LayoutParams(
                        LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT);
                lineParams.topMargin = dp(7);
                container.addView(line, lineParams);
            } else {
                container.addView(line);
            }

            LinearLayout top = new LinearLayout(getContext());
            top.setGravity(Gravity.CENTER_VERTICAL);
            TextView grade = badge(gradeLabel(offer), palette.primarySoft, palette.primary);
            top.addView(grade);
            String provider = fuel == null ? "" : cleanText(fuel.optString("providerName"));
            TextView providerView = text(
                    provider.isEmpty() ? "CP 待补" : "CP  " + provider,
                    11, false, palette.textSecondary);
            providerView.setGravity(Gravity.END);
            top.addView(providerView, new LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f));
            line.addView(top);

            LinearLayout values = new LinearLayout(getContext());
            values.setOrientation(HORIZONTAL);
            LayoutParams valuesParams = new LayoutParams(
                    LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT);
            valuesParams.topMargin = dp(8);
            line.addView(values, valuesParams);

            addValueColumn(values, "外显价", moneyPerLiter(number(offer, "displayPrice")), 0);
            if (!compact) {
                addValueColumn(values, "油站价", moneyPerLiter(number(offer, "stationPrice")), 1);
            }
            addValueColumn(values, "优惠", money(number(quote, "grossDiscount")), compact ? 1 : 2);
            addValueColumn(values, "服务费", money(number(quote, "serviceFee")), compact ? 2 : 3);
            addValueColumn(values, "实付", money(number(quote, "payableAmount")), compact ? 3 : 4);
        }
    }

    private void addChargingSummary(LinearLayout container, JSONObject row) {
        String[] labels = {"快充", "慢充", "超充"};
        String[] priceKeys = {"priceFast", "priceSlow", "priceSuper"};
        String[] idleKeys = {"fastIdlePorts", "slowIdlePorts", "superIdlePorts"};
        String[] totalKeys = {"fastTotalPorts", "slowTotalPorts", "superTotalPorts"};
        LinearLayout values = new LinearLayout(getContext());
        values.setOrientation(HORIZONTAL);
        container.addView(values);
        for (int index = 0; index < labels.length; index++) {
            String value = number(row, priceKeys[index]) > 0d
                    ? moneyPerKwh(number(row, priceKeys[index]))
                    : "—";
            String ports = row.optInt(idleKeys[index], 0)
                    + " / " + row.optInt(totalKeys[index], 0);
            addValueColumn(values, labels[index], value + "\n闲/总 " + ports, index);
        }
    }

    private void addValueColumn(
            LinearLayout parent,
            String label,
            String value,
            int index
    ) {
        LinearLayout cell = new LinearLayout(getContext());
        cell.setOrientation(VERTICAL);
        TextView labelView = text(label, 10, false, palette.textSecondary);
        TextView valueView = text(value, 12, true, palette.textPrimary);
        valueView.setPadding(0, dp(3), 0, 0);
        cell.addView(labelView);
        cell.addView(valueView);
        LayoutParams params = new LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f);
        if (index > 0) params.leftMargin = dp(5);
        parent.addView(cell, params);
    }

    private static JSONObject findQuote(JSONArray quotes, JSONObject offer) {
        if (quotes == null || offer == null) return null;
        String grade = cleanText(offer.optString("gradeCode"));
        for (int index = 0; index < quotes.length(); index++) {
            JSONObject quote = quotes.optJSONObject(index);
            if (quote == null) continue;
            if (grade.equals(cleanText(quote.optString("gradeCode")))) return quote;
        }
        return quotes.optJSONObject(0);
    }

    private void switchTab(int tab) {
        capturePanel.setVisibility(tab == TAB_CAPTURE ? VISIBLE : GONE);
        recordsPanel.setVisibility(tab == TAB_RECORDS ? VISIBLE : GONE);
        settingsPanel.setVisibility(tab == TAB_SETTINGS ? VISIBLE : GONE);
        if (tab != TAB_RECORDS) exitSelectionMode();
        for (int index = 0; index < navigationButtons.length; index++) {
            boolean active = index == tab;
            Button button = navigationButtons[index];
            button.setTextColor(active ? palette.primary : palette.textSecondary);
            button.setAlpha(active ? 1f : 0.76f);
        }
    }

    private TextView addMetric(
            LinearLayout parent,
            String icon,
            String label,
            String value,
            int accent,
            int index
    ) {
        LinearLayout cell = new LinearLayout(getContext());
        cell.setOrientation(VERTICAL);
        cell.setGravity(Gravity.CENTER);
        cell.setPadding(dp(7), dp(12), dp(7), dp(12));
        cell.setBackground(roundRect(palette.card, 14, 1, palette.border));
        TextView iconView = text(icon, 17, true, accent);
        TextView labelView = text(label, 11, false, palette.textSecondary);
        labelView.setPadding(0, dp(5), 0, 0);
        TextView valueView = text(value, 22, true, palette.textPrimary);
        valueView.setPadding(0, dp(5), 0, 0);
        cell.addView(iconView);
        cell.addView(labelView);
        cell.addView(valueView);
        LayoutParams params = new LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f);
        if (index > 0) params.leftMargin = dp(7);
        parent.addView(cell, params);
        return valueView;
    }

    private void toggleSelectionMode() {
        selectionMode = !selectionMode;
        if (!selectionMode) selectedKeys.clear();
        updateActionButtons();
        adapter.notifyVisibleRowsChanged();
    }

    private void toggleSelection(String stableIdentity) {
        if (stableIdentity == null || stableIdentity.isEmpty()) return;
        if (!selectedKeys.add(stableIdentity)) selectedKeys.remove(stableIdentity);
        updateActionButtons();
        adapter.notifyVisibleRowsChanged();
    }

    private void toggleSelectAll() {
        List<String> all = adapter.allIdentities();
        if (all.isEmpty()) return;
        if (selectedKeys.containsAll(all)) selectedKeys.removeAll(all);
        else selectedKeys.addAll(all);
        updateActionButtons();
        adapter.notifyVisibleRowsChanged();
    }

    private void updateActionButtons() {
        if (selectionMode) {
            List<String> all = adapter.allIdentities();
            boolean allSelected = !all.isEmpty() && selectedKeys.containsAll(all);
            multiSelectButton.setText("取消");
            selectAllButton.setText(allSelected ? "取消全选" : "全选");
            selectAllButton.setVisibility(VISIBLE);
            recordActionButton.setText(selectedKeys.isEmpty()
                    ? "删除选中" : "删除选中(" + selectedKeys.size() + ")");
            recordActionButton.setBackground(roundRect(
                    palette.danger, 12, 0, Color.TRANSPARENT));
            recordActionButton.setEnabled(!selectedKeys.isEmpty());
            recordActionButton.setAlpha(selectedKeys.isEmpty() ? 0.55f : 1f);
        } else {
            multiSelectButton.setText("多选");
            selectAllButton.setVisibility(GONE);
            recordActionButton.setText(captureUiState.primaryLabel);
            recordActionButton.setBackground(roundRect(
                    palette.primary, 12, 0, Color.TRANSPARENT));
            recordActionButton.setEnabled(captureUiState.primaryEnabled);
            recordActionButton.setAlpha(captureUiState.primaryEnabled ? 1f : 0.55f);
        }
    }

    private void selectFilter(StationResultPresenter.Filter filter) {
        for (int index = 0; index < filterButtons.length; index++) {
            boolean selected = (index == 0 && filter == StationResultPresenter.Filter.ALL)
                    || (index == 1 && filter == StationResultPresenter.Filter.CHARGING)
                    || (index == 2 && filter == StationResultPresenter.Filter.FUEL);
            filterButtons[index].setTextColor(selected ? Color.WHITE : palette.textSecondary);
            filterButtons[index].setBackground(roundRect(
                    selected ? palette.primary : palette.inputBackground,
                    18, selected ? 0 : 1, palette.border));
        }
    }

    private int countToday(List<JSONObject> rows) {
        if (rows == null) return 0;
        LocalDate today = LocalDate.now();
        int count = 0;
        for (JSONObject row : rows) {
            Instant instant = rowInstant(row);
            if (instant != null
                    && instant.atZone(ZoneId.systemDefault()).toLocalDate().equals(today)) {
                count++;
            }
        }
        return count;
    }

    private String latestTime(List<JSONObject> rows) {
        if (rows == null || rows.isEmpty()) return "--:--";
        Instant instant = rowInstant(rows.get(0));
        return instant == null
                ? "--:--" : HOME_TIME.withZone(ZoneId.systemDefault()).format(instant);
    }

    private static Instant rowInstant(JSONObject row) {
        if (row == null) return null;
        String value = cleanText(row.optString("capturedAt"));
        if (value.isEmpty()) return null;
        try {
            return Instant.parse(value);
        } catch (Exception ignored) {
            try {
                return OffsetDateTime.parse(value).toInstant();
            } catch (Exception ignoredAgain) {
                return null;
            }
        }
    }

    private void finishSearchInput() {
        InputMethodManager input = (InputMethodManager) getContext().getSystemService(
                Context.INPUT_METHOD_SERVICE);
        if (input != null) input.hideSoftInputFromWindow(nameSearch.getWindowToken(), 0);
        nameSearch.clearFocus();
    }

    private Button timeButton(String label, String description) {
        Button button = button(label, 11, false);
        button.setMaxLines(2);
        button.setGravity(Gravity.CENTER);
        button.setTextColor(palette.textSecondary);
        button.setBackground(roundRect(palette.inputBackground, 10, 1, palette.border));
        button.setContentDescription(description + "，未设置");
        return button;
    }

    private void setTimeButton(
            Button button,
            String emptyLabel,
            String selectedLabel,
            Long epochMillis,
            String description
    ) {
        if (epochMillis == null) {
            button.setText(emptyLabel);
            button.setContentDescription(description + "，未设置");
            return;
        }
        String formatted = FILTER_TIME.withZone(ZoneId.systemDefault())
                .format(Instant.ofEpochMilli(epochMillis));
        button.setText(selectedLabel + "\n" + formatted);
        button.setContentDescription(description + "，当前 " + formatted);
    }

    private TextView sectionLabel(String value) {
        TextView label = text(value, 12, false, palette.textSecondary);
        label.setPadding(dp(3), 0, 0, dp(7));
        return label;
    }

    private LinearLayout card() {
        LinearLayout card = new LinearLayout(getContext());
        card.setOrientation(VERTICAL);
        card.setPadding(dp(14), dp(2), dp(14), dp(2));
        card.setBackground(roundRect(palette.card, 15, 1, palette.border));
        return card;
    }

    private View divider() {
        View divider = new View(getContext());
        divider.setBackgroundColor(palette.border);
        divider.setLayoutParams(new LayoutParams(LayoutParams.MATCH_PARENT, dp(1)));
        return divider;
    }

    private LinearLayout settingRow(String label, String value) {
        LinearLayout row = new LinearLayout(getContext());
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(dp(2), 0, dp(2), 0);
        row.addView(text(label, 14, false, palette.textPrimary),
                new LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f));
        row.addView(text(value, 13, false, palette.textSecondary));
        return row;
    }

    private LinearLayout settingInfo(String label, String value) {
        LinearLayout row = new LinearLayout(getContext());
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(dp(2), 0, dp(2), 0);
        LinearLayout labels = new LinearLayout(getContext());
        labels.setOrientation(VERTICAL);
        labels.addView(text(label, 14, false, palette.textPrimary));
        TextView detail = text(value, 11, false, palette.textSecondary);
        detail.setPadding(0, dp(3), 0, 0);
        labels.addView(detail);
        row.addView(labels, new LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f));
        row.addView(text("›", 20, false, palette.textSecondary));
        return row;
    }

    private Button settingAction(String label, String suffix) {
        Button button = button(label + "                                      " + suffix, 14, false);
        button.setGravity(Gravity.CENTER_VERTICAL | Gravity.START);
        button.setTextColor(palette.textPrimary);
        button.setBackgroundColor(Color.TRANSPARENT);
        return button;
    }

    private TextView badge(String value, int background, int color) {
        TextView badge = text(value, 11, true, color);
        badge.setGravity(Gravity.CENTER);
        badge.setPadding(dp(8), dp(4), dp(8), dp(4));
        badge.setBackground(roundRect(background, 8, 0, Color.TRANSPARENT));
        return badge;
    }

    private Button textButton(String label) {
        Button button = button(label, 12, true);
        button.setTextColor(palette.primary);
        button.setBackgroundColor(Color.TRANSPARENT);
        return button;
    }

    private Button outlineButton(String label, int textColor, int borderColor) {
        Button button = button(label, 13, true);
        button.setTextColor(textColor);
        button.setBackground(roundRect(palette.card, 11, 1, borderColor));
        return button;
    }

    private Button button(String label, int sp, boolean bold) {
        Button button = new Button(getContext());
        button.setText(label);
        button.setTextSize(sp);
        button.setAllCaps(false);
        button.setMinHeight(0);
        button.setMinWidth(0);
        button.setPadding(dp(12), 0, dp(12), 0);
        if (bold) button.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        return button;
    }

    private TextView text(String value, int sp, boolean bold, int color) {
        TextView view = new TextView(getContext());
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

    private FrameLayout.LayoutParams frameParams() {
        return new FrameLayout.LayoutParams(
                LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT);
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private static String gradeLabel(JSONObject offer) {
        if (offer == null) return "油号待补";
        String label = cleanText(offer.optString("gradeLabel"));
        if (!label.isEmpty()) return label;
        String code = cleanText(offer.optString("gradeCode"));
        return code.isEmpty() ? "油号待补" : code + (code.endsWith("#") ? "" : "#");
    }

    private static String cleanText(String value) {
        if (value == null) return "";
        String text = value.trim();
        return "null".equalsIgnoreCase(text) || "undefined".equalsIgnoreCase(text)
                ? "" : text;
    }

    private static double number(JSONObject value, String key) {
        if (value == null || value.isNull(key)) return 0d;
        Object raw = value.opt(key);
        try {
            return raw instanceof Number
                    ? ((Number) raw).doubleValue()
                    : new BigDecimal(String.valueOf(raw)).doubleValue();
        } catch (Exception ignored) {
            return 0d;
        }
    }

    private static String money(double value) {
        return value > 0d ? "¥" + decimal(value) : "—";
    }

    private static String moneyPerLiter(double value) {
        return value > 0d ? "¥" + decimal(value) + "/L" : "—";
    }

    private static String moneyPerKwh(double value) {
        return value > 0d ? "¥" + decimal(value) + "/度" : "—";
    }

    private static String decimal(double value) {
        return String.format(Locale.CHINA, "%.2f", value)
                .replaceAll("0+$", "").replaceAll("\\.$", "");
    }

    private final class StationAdapter
            extends RecyclerView.Adapter<StationHolder> {
        private final List<JSONObject> rows = new ArrayList<>();

        void submit(List<JSONObject> values) {
            rows.clear();
            if (values != null) rows.addAll(values);
            notifyDataSetChanged();
        }

        List<String> allIdentities() {
            List<String> output = new ArrayList<>();
            for (int index = 0; index < rows.size(); index++) {
                String id = StationIdentity.fromRow(rows.get(index), index);
                if (id != null && !id.isEmpty()) output.add(id);
            }
            return output;
        }

        void notifyVisibleRowsChanged() {
            if (!rows.isEmpty()) notifyItemRangeChanged(0, rows.size());
        }

        @Override
        public StationHolder onCreateViewHolder(ViewGroup parent, int viewType) {
            return new StationHolder(new StationCardView(parent.getContext()));
        }

        @Override
        public void onBindViewHolder(StationHolder holder, int position) {
            holder.card.bind(rows.get(position), position);
        }

        @Override
        public int getItemCount() {
            return rows.size();
        }
    }

    private static final class StationHolder extends RecyclerView.ViewHolder {
        final StationCardView card;

        StationHolder(StationCardView card) {
            super(card);
            this.card = card;
        }
    }

    private final class StationCardView extends LinearLayout {
        private final TextView name;
        private final TextView time;
        private final TextView typeBadge;
        private final LinearLayout body;
        private final TextView completeness;
        private final TextView selectMark;
        private JSONObject boundRow;
        private String boundIdentity = "";

        StationCardView(Context context) {
            super(context);
            setOrientation(VERTICAL);
            setPadding(dp(14), dp(13), dp(14), dp(13));
            setBackground(roundRect(palette.card, 15, 1, palette.border));
            setElevation(dp(1));

            LinearLayout header = new LinearLayout(context);
            header.setGravity(Gravity.TOP);
            name = text("", 16, true, palette.textPrimary);
            name.setMaxLines(2);
            name.setEllipsize(TextUtils.TruncateAt.END);
            header.addView(name, new LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f));
            time = text("", 11, false, palette.textSecondary);
            time.setGravity(Gravity.END);
            header.addView(time);
            addView(header);

            LinearLayout badgeRow = new LinearLayout(context);
            badgeRow.setGravity(Gravity.CENTER_VERTICAL);
            typeBadge = badge("", palette.primarySoft, palette.primary);
            badgeRow.addView(typeBadge);
            selectMark = text("○", 18, true, palette.textSecondary);
            selectMark.setGravity(Gravity.END | Gravity.CENTER_VERTICAL);
            selectMark.setVisibility(GONE);
            badgeRow.addView(selectMark, new LayoutParams(0, dp(30), 1f));
            LayoutParams badgeParams = new LayoutParams(
                    LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT);
            badgeParams.topMargin = dp(8);
            addView(badgeRow, badgeParams);

            body = new LinearLayout(context);
            body.setOrientation(VERTICAL);
            LayoutParams bodyParams = new LayoutParams(
                    LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT);
            bodyParams.topMargin = dp(8);
            addView(body, bodyParams);

            completeness = text("", 12, true, palette.success);
            LayoutParams completeParams = new LayoutParams(
                    LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT);
            completeParams.topMargin = dp(8);
            addView(completeness, completeParams);

            setOnClickListener(view -> {
                if (selectionMode) toggleSelection(boundIdentity);
                else if (listener != null && boundRow != null) {
                    listener.onEditBackfill(AddressFreePayload.copyObject(boundRow));
                }
            });

            RecyclerView.LayoutParams params = new RecyclerView.LayoutParams(
                    LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT);
            params.bottomMargin = dp(9);
            setLayoutParams(params);
        }

        void bind(JSONObject row, int position) {
            boundRow = row;
            boundIdentity = row == null ? "" : StationIdentity.fromRow(row, position);
            String station = StationRecordFilter.stationName(row);
            name.setText(station.isEmpty() ? "未命名场站" : station);
            time.setText(StationDisplayFormatter.capturedAt(row));

            boolean fuel = StationDisplayFormatter.isFuel(row);
            typeBadge.setText(fuel ? "加油" : "充电");
            typeBadge.setTextColor(fuel ? palette.primary : palette.success);
            typeBadge.setBackground(roundRect(
                    fuel ? palette.primarySoft : palette.successSoft,
                    8, 0, Color.TRANSPARENT));

            body.removeAllViews();
            if (fuel) addFuelRows(body, row, false);
            else addChargingSummary(body, row);

            completeness.setText(StationDisplayFormatter.missingSummary(row));
            completeness.setTextColor(
                    StationDisplayFormatter.incomplete(row) ? palette.warning : palette.success);

            boolean selected = !boundIdentity.isEmpty() && selectedKeys.contains(boundIdentity);
            selectMark.setVisibility(selectionMode ? VISIBLE : GONE);
            selectMark.setText(selected ? "✓" : "○");
            selectMark.setTextColor(selected ? palette.primary : palette.textSecondary);
            setBackground(roundRect(
                    selected ? palette.primarySoft : palette.card,
                    15, 1, selected ? palette.primary : palette.border));
        }
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
        final int successSoft;
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
            successSoft = Color.parseColor(dark ? "#153B32" : "#E8FBF5");
            danger = Color.parseColor(dark ? "#FF7E86" : "#F04438");
        }

        static Palette from(Context context) {
            int mode = context.getResources().getConfiguration().uiMode
                    & Configuration.UI_MODE_NIGHT_MASK;
            return new Palette(mode == Configuration.UI_MODE_NIGHT_YES);
        }
    }
}
