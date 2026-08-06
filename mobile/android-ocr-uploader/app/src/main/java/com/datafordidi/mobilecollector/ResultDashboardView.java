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

import org.json.JSONObject;

import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;

/**
 * Dashboard UI based on the supplied four-screen canvas:
 * capture home, floating capture, record query, and settings.
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
        void onDeleteSelected(java.util.Set<String> stableIdentities);
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

    private final TextView statusView;
    private final TextView todayValue;
    private final TextView completenessValue;
    private final TextView latestValue;
    private final Button homePrimaryButton;
    private final LinearLayout recentCard;
    private final TextView recentName;
    private final TextView recentTime;
    private final TextView recentSummary;
    private JSONObject recentRow;

    private final TextView[] statisticValues = new TextView[4];
    private final TextView[] statisticLabels = new TextView[4];
    private final Button[] filterButtons = new Button[3];
    private final EditText nameSearch;
    private final Button startTimeButton;
    private final Button endTimeButton;
    private final TextView matchCountView;
    private final Button recordActionButton;
    private final Button multiSelectButton;
    private final Button selectAllButton;
    private final StationAdapter adapter;
    private final TextView emptyView;
    private final Switch autoUpdateSwitch;

    private Listener listener;
    private boolean selectionMode;
    private boolean settingFilterState;
    private CaptureUiState captureUiState = CaptureUiState.STOPPED;
    private final java.util.Set<String> selectedKeys = new java.util.LinkedHashSet<>();

    ResultDashboardView(Context context) {
        super(context);
        palette = Palette.from(context);
        setOrientation(VERTICAL);
        setBackgroundColor(palette.background);

        contentFrame = new FrameLayout(context);
        addView(contentFrame, new LayoutParams(LayoutParams.MATCH_PARENT, 0, 1f));

        capturePanel = new LinearLayout(context);
        capturePanel.setOrientation(VERTICAL);
        capturePanel.setPadding(dp(18), dp(18), dp(18), dp(14));

        ScrollView captureScroll = new ScrollView(context);
        captureScroll.setFillViewport(true);
        LinearLayout captureBody = new LinearLayout(context);
        captureBody.setOrientation(VERTICAL);
        captureScroll.addView(captureBody, new ScrollView.LayoutParams(
                LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT));

        LinearLayout captureHeader = new LinearLayout(context);
        captureHeader.setGravity(Gravity.CENTER_VERTICAL);
        LinearLayout captureTitles = new LinearLayout(context);
        captureTitles.setOrientation(VERTICAL);
        TextView captureTitle = text("信息自动识别", 25, true, palette.textPrimary);
        TextView captureSubtitle = text("场站与油站信息采集", 14, false, palette.textSecondary);
        captureSubtitle.setPadding(0, dp(4), 0, 0);
        captureTitles.addView(captureTitle);
        captureTitles.addView(captureSubtitle);
        captureHeader.addView(captureTitles, new LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f));

        statusView = text("已停止", 12, true, palette.primary);
        statusView.setGravity(Gravity.CENTER);
        statusView.setPadding(dp(12), dp(7), dp(12), dp(7));
        statusView.setBackground(roundRect(palette.statusBackground, 18, 0, Color.TRANSPARENT));
        captureHeader.addView(statusView, new LayoutParams(LayoutParams.WRAP_CONTENT, dp(38)));
        captureBody.addView(captureHeader);

        LinearLayout metrics = new LinearLayout(context);
        metrics.setOrientation(HORIZONTAL);
        LayoutParams metricsParams = new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT);
        metricsParams.topMargin = dp(18);
        captureBody.addView(metrics, metricsParams);
        todayValue = addMetric(metrics, "▣", "今日识别", "0", 0);
        completenessValue = addMetric(metrics, "✓", "字段完整率", "0%", 1);
        latestValue = addMetric(metrics, "◷", "最近识别", "--:--", 2);

        homePrimaryButton = button("▣  开始识别", 17, true);
        homePrimaryButton.setTextColor(Color.WHITE);
        homePrimaryButton.setBackground(roundRect(palette.primary, 13, 0, Color.TRANSPARENT));
        homePrimaryButton.setOnClickListener(view -> {
            if (listener != null) listener.onPrimaryAction();
        });
        LayoutParams homePrimaryParams = new LayoutParams(LayoutParams.MATCH_PARENT, dp(58));
        homePrimaryParams.topMargin = dp(20);
        captureBody.addView(homePrimaryButton, homePrimaryParams);

        LinearLayout recentHeader = new LinearLayout(context);
        recentHeader.setGravity(Gravity.CENTER_VERTICAL);
        TextView recentTitle = text("最近采集", 17, true, palette.textPrimary);
        recentHeader.addView(recentTitle, new LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f));
        Button viewAll = textButton("查看全部");
        viewAll.setOnClickListener(view -> switchTab(TAB_RECORDS));
        recentHeader.addView(viewAll, new LayoutParams(LayoutParams.WRAP_CONTENT, dp(44)));
        LayoutParams recentHeaderParams = new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT);
        recentHeaderParams.topMargin = dp(20);
        captureBody.addView(recentHeader, recentHeaderParams);

        recentCard = new LinearLayout(context);
        recentCard.setOrientation(VERTICAL);
        recentCard.setPadding(dp(15), dp(14), dp(15), dp(14));
        recentCard.setBackground(roundRect(palette.card, 16, 1, palette.border));
        recentCard.setOnClickListener(view -> {
            if (listener != null && recentRow != null) {
                listener.onEditBackfill(AddressFreePayload.copyObject(recentRow));
            }
        });
        LinearLayout recentTop = new LinearLayout(context);
        recentTop.setGravity(Gravity.TOP);
        recentName = text("暂无识别记录", 16, true, palette.textPrimary);
        recentName.setMaxLines(2);
        recentName.setEllipsize(TextUtils.TruncateAt.END);
        recentTop.addView(recentName, new LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f));
        recentTime = text("", 12, false, palette.textSecondary);
        recentTop.addView(recentTime);
        recentCard.addView(recentTop);
        recentSummary = text("完成识别后，最近一条结果会显示在这里", 13, false, palette.textSecondary);
        recentSummary.setLineSpacing(dp(3), 1f);
        LayoutParams recentSummaryParams = new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT);
        recentSummaryParams.topMargin = dp(12);
        recentCard.addView(recentSummary, recentSummaryParams);
        LayoutParams recentCardParams = new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT);
        recentCardParams.topMargin = dp(8);
        captureBody.addView(recentCard, recentCardParams);

        TextView captureHint = text(
                "在目标页面点击悬浮识别按钮。高德加油支持 92#/95# 引导采集和支付页字段合并。",
                12, false, palette.textSecondary);
        captureHint.setLineSpacing(dp(2), 1f);
        LayoutParams hintParams = new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT);
        hintParams.topMargin = dp(14);
        captureBody.addView(captureHint, hintParams);

        capturePanel.addView(captureScroll, new LayoutParams(
                LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT));
        contentFrame.addView(capturePanel, frameParams());

        recordsPanel = new LinearLayout(context);
        recordsPanel.setOrientation(VERTICAL);
        recordsPanel.setPadding(dp(14), dp(15), dp(14), dp(8));

        TextView recordsTitle = text("识别记录", 23, true, palette.textPrimary);
        recordsPanel.addView(recordsTitle);

        LinearLayout filterCard = new LinearLayout(context);
        filterCard.setOrientation(VERTICAL);
        filterCard.setPadding(dp(11), dp(10), dp(11), dp(9));
        filterCard.setBackground(roundRect(palette.card, 15, 1, palette.border));
        LayoutParams filterCardParams = new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT);
        filterCardParams.topMargin = dp(12);
        recordsPanel.addView(filterCard, filterCardParams);

        nameSearch = new EditText(context);
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
        filterCard.addView(nameSearch, new LayoutParams(LayoutParams.MATCH_PARENT, dp(46)));

        LinearLayout timeRow = new LinearLayout(context);
        timeRow.setGravity(Gravity.CENTER_VERTICAL);
        startTimeButton = timeButton("开始时间", "设置开始日期时间");
        startTimeButton.setOnClickListener(view -> {
            if (listener != null) listener.onStartTimeRequested();
        });
        endTimeButton = timeButton("结束时间", "设置结束日期时间");
        endTimeButton.setOnClickListener(view -> {
            if (listener != null) listener.onEndTimeRequested();
        });
        timeRow.addView(startTimeButton, new LayoutParams(0, dp(48), 1f));
        TextView range = text("~", 15, false, palette.textSecondary);
        range.setGravity(Gravity.CENTER);
        timeRow.addView(range, new LayoutParams(dp(28), dp(48)));
        timeRow.addView(endTimeButton, new LayoutParams(0, dp(48), 1f));
        LayoutParams timeParams = new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT);
        timeParams.topMargin = dp(7);
        filterCard.addView(timeRow, timeParams);

        LinearLayout filterRow = new LinearLayout(context);
        filterRow.setGravity(Gravity.CENTER_VERTICAL);
        String[] filterLabels = {"全部", "充电", "加油"};
        StationResultPresenter.Filter[] filterValues = {
                StationResultPresenter.Filter.ALL,
                StationResultPresenter.Filter.CHARGING,
                StationResultPresenter.Filter.FUEL
        };
        for (int index = 0; index < filterLabels.length; index++) {
            final StationResultPresenter.Filter value = filterValues[index];
            Button filter = button(filterLabels[index], 13, true);
            filter.setOnClickListener(view -> {
                if (listener != null) listener.onFilterSelected(value);
            });
            filterButtons[index] = filter;
            LayoutParams p = new LayoutParams(0, dp(42), 1f);
            if (index > 0) p.leftMargin = dp(7);
            filterRow.addView(filter, p);
        }
        Button reset = textButton("↻ 重置");
        reset.setOnClickListener(view -> {
            if (listener != null) listener.onResetRecordFilters();
        });
        LayoutParams resetParams = new LayoutParams(LayoutParams.WRAP_CONTENT, dp(42));
        resetParams.leftMargin = dp(8);
        filterRow.addView(reset, resetParams);
        LayoutParams filterRowParams = new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT);
        filterRowParams.topMargin = dp(7);
        filterCard.addView(filterRow, filterRowParams);

        matchCountView = text("找到 0 条", 12, false, palette.textSecondary);
        LayoutParams matchParams = new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT);
        matchParams.topMargin = dp(5);
        filterCard.addView(matchCountView, matchParams);

        LinearLayout compactStats = new LinearLayout(context);
        compactStats.setOrientation(HORIZONTAL);
        String[] labels = {"有效场站", "有价", "有枪/报价", "待补充"};
        for (int index = 0; index < labels.length; index++) {
            LinearLayout cell = new LinearLayout(context);
            cell.setOrientation(VERTICAL);
            cell.setGravity(Gravity.CENTER);
            cell.setPadding(dp(2), dp(5), dp(2), dp(5));
            cell.setBackground(roundRect(palette.card, 12, 1, palette.border));
            statisticValues[index] = text("0", 16, true, palette.textPrimary);
            statisticLabels[index] = text(labels[index], 9, false, palette.textSecondary);
            cell.addView(statisticValues[index]);
            cell.addView(statisticLabels[index]);
            LayoutParams cellParams = new LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f);
            if (index > 0) cellParams.leftMargin = dp(5);
            compactStats.addView(cell, cellParams);
        }
        LayoutParams compactStatsParams = new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT);
        compactStatsParams.topMargin = dp(8);
        recordsPanel.addView(compactStats, compactStatsParams);

        FrameLayout resultFrame = new FrameLayout(context);
        RecyclerView results = new RecyclerView(context);
        results.setLayoutManager(new LinearLayoutManager(context));
        results.setClipToPadding(false);
        results.setPadding(0, dp(8), 0, dp(8));
        adapter = new StationAdapter();
        results.setAdapter(adapter);
        resultFrame.addView(results, new FrameLayout.LayoutParams(
                LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT));
        emptyView = text("暂无识别结果\n点击“采集”开始识别", 15, false, palette.textSecondary);
        emptyView.setGravity(Gravity.CENTER);
        resultFrame.addView(emptyView, new FrameLayout.LayoutParams(
                LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT));
        recordsPanel.addView(resultFrame, new LayoutParams(LayoutParams.MATCH_PARENT, 0, 1f));

        LinearLayout recordActions = new LinearLayout(context);
        recordActions.setGravity(Gravity.CENTER_VERTICAL);
        recordActionButton = button("开始识别", 15, true);
        recordActionButton.setTextColor(Color.WHITE);
        recordActionButton.setBackground(roundRect(palette.primary, 12, 0, Color.TRANSPARENT));
        recordActionButton.setOnClickListener(view -> {
            if (selectionMode) {
                if (listener != null && !selectedKeys.isEmpty()) {
                    listener.onDeleteSelected(new java.util.LinkedHashSet<>(selectedKeys));
                }
            } else if (listener != null) {
                listener.onPrimaryAction();
            }
        });
        recordActions.addView(recordActionButton, new LayoutParams(0, dp(50), 1f));
        multiSelectButton = outlineButton("多选", palette.textSecondary, palette.border);
        multiSelectButton.setOnClickListener(view -> toggleSelectionMode());
        LayoutParams multiParams = new LayoutParams(LayoutParams.WRAP_CONTENT, dp(50));
        multiParams.leftMargin = dp(8);
        recordActions.addView(multiSelectButton, multiParams);
        selectAllButton = outlineButton("全选", palette.textSecondary, palette.border);
        selectAllButton.setVisibility(GONE);
        selectAllButton.setOnClickListener(view -> toggleSelectAll());
        LayoutParams allParams = new LayoutParams(LayoutParams.WRAP_CONTENT, dp(50));
        allParams.leftMargin = dp(8);
        recordActions.addView(selectAllButton, allParams);
        recordsPanel.addView(recordActions);
        contentFrame.addView(recordsPanel, frameParams());

        settingsPanel = new LinearLayout(context);
        settingsPanel.setOrientation(VERTICAL);
        settingsPanel.setPadding(dp(16), dp(16), dp(16), dp(16));
        ScrollView settingsScroll = new ScrollView(context);
        LinearLayout settingsBody = new LinearLayout(context);
        settingsBody.setOrientation(VERTICAL);
        settingsScroll.addView(settingsBody);

        TextView settingsTitle = text("设置", 23, true, palette.textPrimary);
        settingsBody.addView(settingsTitle);

        LinearLayout versionCard = card();
        TextView versionLabel = text("应用与更新", 17, true, palette.textPrimary);
        versionCard.addView(versionLabel);
        LinearLayout versionRow = settingRow("当前版本", BuildConfig.VERSION_NAME);
        LayoutParams versionRowParams = new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT);
        versionRowParams.topMargin = dp(8);
        versionCard.addView(versionRow, versionRowParams);
        Button update = settingAction("检查更新", "›");
        update.setOnClickListener(view -> {
            if (listener != null) listener.onCheckUpdate();
        });
        versionCard.addView(update, new LayoutParams(LayoutParams.MATCH_PARENT, dp(52)));
        LinearLayout autoRow = new LinearLayout(context);
        autoRow.setGravity(Gravity.CENTER_VERTICAL);
        TextView autoLabel = text("启动时检测更新", 14, false, palette.textPrimary);
        autoRow.addView(autoLabel, new LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f));
        autoUpdateSwitch = new Switch(context);
        autoUpdateSwitch.setChecked(isAutoUpdateEnabled(context));
        autoUpdateSwitch.setOnCheckedChangeListener((buttonView, checked) ->
                context.getSharedPreferences(UI_PREFS, Context.MODE_PRIVATE)
                        .edit().putBoolean(PREF_AUTO_UPDATE, checked).apply());
        autoRow.addView(autoUpdateSwitch);
        versionCard.addView(autoRow, new LayoutParams(LayoutParams.MATCH_PARENT, dp(52)));
        LayoutParams versionCardParams = new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT);
        versionCardParams.topMargin = dp(14);
        settingsBody.addView(versionCard, versionCardParams);

        LinearLayout captureSettings = card();
        captureSettings.addView(text("识别设置", 17, true, palette.textPrimary));
        captureSettings.addView(settingInfo("识别方式", "悬浮窗手动截屏"));
        captureSettings.addView(settingInfo("加油采集", "92#/95# 引导识别"));
        captureSettings.addView(settingInfo("记录操作", "点击记录可查看与回填"));
        LayoutParams captureSettingsParams = new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT);
        captureSettingsParams.topMargin = dp(12);
        settingsBody.addView(captureSettings, captureSettingsParams);

        Button clear = outlineButton("删除全部本地记录", palette.danger, palette.danger);
        clear.setOnClickListener(view -> {
            if (listener != null) listener.onClearCompleted();
        });
        LayoutParams clearParams = new LayoutParams(LayoutParams.MATCH_PARENT, dp(52));
        clearParams.topMargin = dp(14);
        settingsBody.addView(clear, clearParams);

        settingsPanel.addView(settingsScroll, new LayoutParams(
                LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT));
        contentFrame.addView(settingsPanel, frameParams());

        LinearLayout navigation = new LinearLayout(context);
        navigation.setGravity(Gravity.CENTER);
        navigation.setPadding(dp(8), dp(4), dp(8), dp(5));
        navigation.setBackground(roundRect(palette.card, 0, 1, palette.border));
        String[] navLabels = {"▣\n采集", "▤\n记录", "⚙\n设置"};
        for (int index = 0; index < navLabels.length; index++) {
            final int tab = index;
            Button nav = button(navLabels[index], 12, true);
            nav.setGravity(Gravity.CENTER);
            nav.setMinHeight(0);
            nav.setPadding(0, 0, 0, 0);
            nav.setOnClickListener(view -> switchTab(tab));
            navigationButtons[index] = nav;
            navigation.addView(nav, new LayoutParams(0, dp(58), 1f));
        }
        addView(navigation, new LayoutParams(LayoutParams.MATCH_PARENT, dp(66)));

        selectFilter(StationResultPresenter.Filter.ALL);
        switchTab(TAB_CAPTURE);
    }

    static boolean isAutoUpdateEnabled(Context context) {
        SharedPreferences preferences = context.getSharedPreferences(UI_PREFS, Context.MODE_PRIVATE);
        return preferences.getBoolean(PREF_AUTO_UPDATE, true);
    }

    void setListener(Listener listener) {
        this.listener = listener;
    }

    void exitSelectionMode() {
        if (!selectionMode) return;
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
        statusView.setContentDescription("识别状态：" + captureUiState.label);
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
        if (!TextUtils.equals(nameSearch.getText(), value.nameQuery)) {
            nameSearch.setText(value.nameQuery);
            nameSearch.setSelection(nameSearch.length());
        }
        settingFilterState = false;
        setTimeButton(startTimeButton, "开始时间", "开始", value.startEpochMillis, "设置开始日期时间");
        setTimeButton(endTimeButton, "结束时间", "结束", value.endEpochMillis, "设置结束日期时间");
    }

    void render(StationResultPresenter.ViewState state, boolean hasLocalRecords, boolean hasActiveFilters) {
        if (state == null) return;
        boolean fuelOnly = state.filter == StationResultPresenter.Filter.FUEL;
        boolean allTypes = state.filter == StationResultPresenter.Filter.ALL;
        int[] values = {
                state.validStations,
                fuelOnly ? state.fuelStationsWithOffers : state.withPrice,
                fuelOnly ? state.fuelStationsWithQuotes
                        : state.withGuns + (allTypes ? state.fuelStationsWithQuotes : 0),
                state.incomplete
        };
        String[] labels = {
                "有效场站",
                fuelOnly ? "有油号" : "有价",
                fuelOnly ? "有报价" : allTypes ? "有枪/报价" : "有枪",
                "待补充"
        };
        for (int index = 0; index < values.length; index++) {
            statisticValues[index].setText(String.valueOf(values[index]));
            statisticLabels[index].setText(labels[index]);
        }

        int complete = Math.max(0, state.validStations - state.incomplete);
        int percentage = state.validStations == 0 ? 0
                : Math.round(complete * 100f / state.validStations);
        todayValue.setText(String.valueOf(countToday(state.rows)));
        completenessValue.setText(percentage + "%");
        latestValue.setText(latestTime(state.rows));
        updateRecent(state.rows);

        selectFilter(state.filter);
        adapter.submit(state.rows);
        matchCountView.setText("找到 " + state.rows.size() + " 条");
        if (state.rows.isEmpty()) {
            boolean filteredEmpty = hasLocalRecords && hasActiveFilters;
            String message = filteredEmpty ? "没有符合筛选条件的记录" : "暂无识别结果\n点击“采集”开始识别";
            emptyView.setText(message);
            emptyView.setVisibility(VISIBLE);
        } else {
            emptyView.setVisibility(GONE);
        }
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
            button.setBackgroundColor(Color.TRANSPARENT);
            button.setAlpha(active ? 1f : 0.76f);
        }
    }

    private TextView addMetric(LinearLayout parent, String icon, String label, String value, int index) {
        LinearLayout cell = new LinearLayout(getContext());
        cell.setOrientation(VERTICAL);
        cell.setGravity(Gravity.CENTER);
        cell.setPadding(dp(7), dp(12), dp(7), dp(12));
        cell.setBackground(roundRect(palette.card, 14, 1, palette.border));
        TextView iconView = text(icon, 17, true, index == 1 ? palette.success : palette.primary);
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

    private void updateRecent(List<JSONObject> rows) {
        recentRow = rows == null || rows.isEmpty() ? null : rows.get(0);
        if (recentRow == null) {
            recentName.setText("暂无识别记录");
            recentTime.setText("");
            recentSummary.setText("完成识别后，最近一条结果会显示在这里");
            recentCard.setAlpha(0.75f);
            return;
        }
        recentCard.setAlpha(1f);
        String name = StationRecordFilter.stationName(recentRow);
        recentName.setText(name.isEmpty() ? "未命名场站" : name);
        recentTime.setText(StationDisplayFormatter.capturedAt(recentRow));
        String type = StationDisplayFormatter.isFuel(recentRow) ? "加油" : "充电";
        recentSummary.setText(type + " · " + StationDisplayFormatter.details(recentRow)
                + "\n" + StationDisplayFormatter.missingSummary(recentRow));
    }

    private int countToday(List<JSONObject> rows) {
        if (rows == null) return 0;
        LocalDate today = LocalDate.now();
        int count = 0;
        for (JSONObject row : rows) {
            Instant instant = rowInstant(row);
            if (instant != null && instant.atZone(ZoneId.systemDefault()).toLocalDate().equals(today)) count++;
        }
        return count;
    }

    private String latestTime(List<JSONObject> rows) {
        if (rows == null || rows.isEmpty()) return "--:--";
        Instant instant = rowInstant(rows.get(0));
        if (instant == null) return "--:--";
        return HOME_TIME.withZone(ZoneId.systemDefault()).format(instant);
    }

    private static Instant rowInstant(JSONObject row) {
        if (row == null) return null;
        String value = row.optString("capturedAt", "").trim();
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
            recordActionButton.setBackground(roundRect(palette.danger, 12, 0, Color.TRANSPARENT));
            recordActionButton.setEnabled(!selectedKeys.isEmpty());
            recordActionButton.setAlpha(selectedKeys.isEmpty() ? 0.55f : 1f);
        } else {
            multiSelectButton.setText("多选");
            selectAllButton.setVisibility(GONE);
            recordActionButton.setText(captureUiState.primaryLabel);
            recordActionButton.setBackground(roundRect(palette.primary, 12, 0, Color.TRANSPARENT));
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
        button.setContentDescription(description);
        return button;
    }

    private void setTimeButton(Button button, String emptyLabel, String selectedLabel,
                               Long epochMillis, String description) {
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

    private LinearLayout card() {
        LinearLayout card = new LinearLayout(getContext());
        card.setOrientation(VERTICAL);
        card.setPadding(dp(15), dp(14), dp(15), dp(14));
        card.setBackground(roundRect(palette.card, 16, 1, palette.border));
        return card;
    }

    private LinearLayout settingRow(String label, String value) {
        LinearLayout row = new LinearLayout(getContext());
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.addView(text(label, 14, false, palette.textPrimary),
                new LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f));
        row.addView(text(value, 14, false, palette.textSecondary));
        return row;
    }

    private LinearLayout settingInfo(String label, String value) {
        LinearLayout row = settingRow(label, value);
        LayoutParams p = new LayoutParams(LayoutParams.MATCH_PARENT, dp(50));
        row.setLayoutParams(p);
        return row;
    }

    private Button settingAction(String label, String suffix) {
        Button button = button(label + "                                      " + suffix, 14, false);
        button.setGravity(Gravity.CENTER_VERTICAL | Gravity.START);
        button.setTextColor(palette.textPrimary);
        button.setBackgroundColor(Color.TRANSPARENT);
        return button;
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

    private TextView text(String label, int sp, boolean bold, int color) {
        TextView view = new TextView(getContext());
        view.setText(label);
        view.setTextSize(sp);
        view.setTextColor(color);
        if (bold) view.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        return view;
    }

    private GradientDrawable roundRect(int color, int radiusDp, int strokeDp, int strokeColor) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(color);
        drawable.setCornerRadius(dp(radiusDp));
        if (strokeDp > 0) drawable.setStroke(dp(strokeDp), strokeColor);
        return drawable;
    }

    private FrameLayout.LayoutParams frameParams() {
        return new FrameLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT);
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private final class StationAdapter extends RecyclerView.Adapter<StationHolder> {
        private final List<JSONObject> rows = new ArrayList<>();

        void submit(List<JSONObject> values) {
            int previous = rows.size();
            rows.clear();
            if (previous > 0) notifyItemRangeRemoved(0, previous);
            if (values != null) rows.addAll(values);
            if (!rows.isEmpty()) notifyItemRangeInserted(0, rows.size());
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

        @Override public StationHolder onCreateViewHolder(ViewGroup parent, int viewType) {
            return new StationHolder(new StationCardView(parent.getContext()));
        }

        @Override public void onBindViewHolder(StationHolder holder, int position) {
            holder.card.bind(rows.get(position), position);
        }

        @Override public int getItemCount() {
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
        private final TextView details;
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
            typeBadge = text("", 12, true, Color.WHITE);
            typeBadge.setGravity(Gravity.CENTER);
            typeBadge.setPadding(dp(9), dp(4), dp(9), dp(4));
            badgeRow.addView(typeBadge);
            selectMark = text("○", 18, true, palette.textSecondary);
            selectMark.setGravity(Gravity.END | Gravity.CENTER_VERTICAL);
            selectMark.setVisibility(GONE);
            badgeRow.addView(selectMark, new LayoutParams(0, dp(30), 1f));
            LayoutParams badgeParams = new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT);
            badgeParams.topMargin = dp(9);
            addView(badgeRow, badgeParams);

            details = text("", 13, false, palette.textPrimary);
            details.setLineSpacing(dp(4), 1f);
            details.setPadding(dp(11), dp(10), dp(11), dp(10));
            details.setBackground(roundRect(palette.inputBackground, 11, 0, Color.TRANSPARENT));
            LayoutParams detailParams = new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT);
            detailParams.topMargin = dp(8);
            addView(details, detailParams);

            completeness = text("", 12, true, palette.success);
            LayoutParams completeParams = new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT);
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
            String stationName = StationRecordFilter.stationName(row);
            name.setText(stationName.isEmpty() ? "未命名场站" : stationName);
            time.setText(StationDisplayFormatter.capturedAt(row));
            boolean fuel = StationDisplayFormatter.isFuel(row);
            typeBadge.setText(fuel ? "加油" : "充电");
            typeBadge.setBackground(roundRect(fuel ? palette.primary : palette.success,
                    12, 0, Color.TRANSPARENT));
            details.setText(StationDisplayFormatter.details(row));
            completeness.setText(StationDisplayFormatter.missingSummary(row));
            completeness.setTextColor(StationDisplayFormatter.incomplete(row)
                    ? palette.warning : palette.success);
            boolean selected = !boundIdentity.isEmpty() && selectedKeys.contains(boundIdentity);
            selectMark.setVisibility(selectionMode ? VISIBLE : GONE);
            selectMark.setText(selected ? "✓" : "○");
            selectMark.setTextColor(selected ? palette.primary : palette.textSecondary);
            setBackground(roundRect(selected ? palette.statusBackground : palette.card,
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
        final int statusBackground;
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
            statusBackground = Color.parseColor(dark ? "#203B61" : "#EAF2FF");
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
