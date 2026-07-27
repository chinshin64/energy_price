package com.datafordidi.mobilecollector;

import android.content.Context;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.text.Editable;
import android.text.TextUtils;
import android.text.TextWatcher;
import android.view.Gravity;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputMethodManager;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.recyclerview.widget.LinearLayoutManager;
import androidx.recyclerview.widget.RecyclerView;

import org.json.JSONObject;

import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;

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

        /** 用户在多选模式下点「删除选中」时回调，传入所选记录的稳定身份集合。 */
        void onDeleteSelected(java.util.Set<String> stableIdentities);
    }

    private final Palette palette;
    private final TextView statusView;
    private final TextView[] statisticValues = new TextView[4];
    private final TextView[] statisticLabels = new TextView[4];
    private final Button[] filterButtons = new Button[3];
    private final EditText nameSearch;
    private final Button startTimeButton;
    private final Button endTimeButton;
    private final TextView matchCountView;
    private final Button primaryButton;
    private final Button multiSelectButton;
    private final Button selectAllButton;
    private final StationAdapter adapter;
    private final TextView emptyView;
    private Listener listener;
    private boolean selectionMode = false;
    private final java.util.Set<String> selectedKeys = new java.util.LinkedHashSet<>();
    private CaptureUiState captureUiState = CaptureUiState.STOPPED;
    private boolean settingFilterState;
    private static final DateTimeFormatter FILTER_TIME =
            DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss");

    ResultDashboardView(Context context) {
        super(context);
        palette = Palette.from(context);
        setOrientation(VERTICAL);
        setPadding(dp(16), dp(12), dp(16), dp(10));
        setBackgroundColor(palette.background);

        LinearLayout titleRow = new LinearLayout(context);
        titleRow.setGravity(Gravity.CENTER_VERTICAL);
        TextView title = text("信息自动识别", 19, true, palette.textPrimary);
        title.setMaxLines(1);
        titleRow.addView(title, new LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f));
        statusView = text("已停止", 12, true, palette.primary);
        statusView.setGravity(Gravity.CENTER);
        statusView.setPadding(dp(10), dp(6), dp(10), dp(6));
        statusView.setBackground(roundRect(palette.statusBackground, 16, 0, Color.TRANSPARENT));
        statusView.setContentDescription("识别状态：已停止");
        LayoutParams statusParams = new LayoutParams(LayoutParams.WRAP_CONTENT, dp(36));
        statusParams.rightMargin = dp(6);
        titleRow.addView(statusView, statusParams);
        Button updateButton = compactButton("检查更新");
        updateButton.setContentDescription("检查应用更新");
        updateButton.setOnClickListener(view -> {
            if (listener != null) listener.onCheckUpdate();
        });
        updateButton.setTextSize(12);
        titleRow.addView(updateButton, new LayoutParams(LayoutParams.WRAP_CONTENT, dp(44)));
        addView(titleRow);

        LinearLayout statistics = new LinearLayout(context);
        statistics.setOrientation(HORIZONTAL);
        statistics.setPadding(0, dp(8), 0, dp(8));
        String[] labels = {"有效场站", "有价", "有枪", "待补充"};
        for (int index = 0; index < labels.length; index++) {
            LinearLayout cell = new LinearLayout(context);
            cell.setOrientation(VERTICAL);
            cell.setGravity(Gravity.CENTER);
            cell.setPadding(dp(2), dp(6), dp(2), dp(6));
            cell.setBackground(roundRect(palette.card, 12, 1, palette.border));
            statisticValues[index] = text("0", 17, true, palette.textPrimary);
            statisticLabels[index] = text(labels[index], 10, false, palette.textSecondary);
            cell.addView(statisticValues[index]);
            cell.addView(statisticLabels[index]);
            cell.setContentDescription(labels[index] + " 0");
            statistics.addView(cell, weightedCell(index));
        }
        addView(statistics);

        LinearLayout filterCard = new LinearLayout(context);
        filterCard.setOrientation(VERTICAL);
        filterCard.setPadding(dp(10), dp(8), dp(10), dp(8));
        filterCard.setBackground(roundRect(palette.card, 14, 1, palette.border));

        LinearLayout searchRow = new LinearLayout(context);
        searchRow.setGravity(Gravity.CENTER_VERTICAL);
        nameSearch = new EditText(context);
        nameSearch.setSingleLine(true);
        nameSearch.setTextSize(14);
        nameSearch.setTextColor(palette.textPrimary);
        nameSearch.setHintTextColor(palette.textSecondary);
        nameSearch.setHint("搜索场站/油站名称");
        nameSearch.setContentDescription("场站或油站名称模糊搜索");
        nameSearch.setImeOptions(EditorInfo.IME_ACTION_SEARCH);
        nameSearch.setPadding(dp(10), 0, dp(10), 0);
        nameSearch.setBackground(roundRect(palette.inputBackground, 10, 1, palette.border));
        nameSearch.addTextChangedListener(new TextWatcher() {
            @Override
            public void beforeTextChanged(CharSequence value, int start, int count, int after) {
            }

            @Override
            public void onTextChanged(CharSequence value, int start, int before, int count) {
                if (!settingFilterState && listener != null) {
                    listener.onNameQueryChanged(value == null ? "" : value.toString());
                }
            }

            @Override
            public void afterTextChanged(Editable value) {
            }
        });
        nameSearch.setOnEditorActionListener((view, actionId, event) -> {
            if (actionId != EditorInfo.IME_ACTION_SEARCH) return false;
            finishSearchInput();
            return true;
        });
        searchRow.addView(nameSearch, new LayoutParams(0, dp(44), 1f));

        Button searchButton = compactButton("搜索");
        searchButton.setTextSize(12);
        searchButton.setContentDescription("搜索场站或油站名称");
        searchButton.setOnClickListener(view -> {
            finishSearchInput();
            if (listener != null) listener.onNameQueryChanged(nameSearch.getText().toString());
        });
        LayoutParams searchParams = new LayoutParams(LayoutParams.WRAP_CONTENT, dp(44));
        searchParams.leftMargin = dp(6);
        searchRow.addView(searchButton, searchParams);

        Button resetButton = compactButton("重置");
        resetButton.setTextSize(12);
        resetButton.setContentDescription("重置名称和时间筛选");
        resetButton.setOnClickListener(view -> {
            if (listener != null) listener.onResetRecordFilters();
        });
        LayoutParams resetParams = new LayoutParams(LayoutParams.WRAP_CONTENT, dp(44));
        resetParams.leftMargin = dp(6);
        searchRow.addView(resetButton, resetParams);
        filterCard.addView(searchRow);

        LinearLayout timeRow = new LinearLayout(context);
        timeRow.setGravity(Gravity.CENTER_VERTICAL);
        LayoutParams timeRowParams = new LayoutParams(
                LayoutParams.MATCH_PARENT,
                LayoutParams.WRAP_CONTENT
        );
        timeRowParams.topMargin = dp(6);
        startTimeButton = timeButton("开始时间", "设置开始日期时间");
        startTimeButton.setOnClickListener(view -> {
            if (listener != null) listener.onStartTimeRequested();
        });
        timeRow.addView(startTimeButton, new LayoutParams(0, dp(52), 1f));
        endTimeButton = timeButton("结束时间", "设置结束日期时间");
        endTimeButton.setOnClickListener(view -> {
            if (listener != null) listener.onEndTimeRequested();
        });
        LayoutParams endParams = new LayoutParams(0, dp(52), 1f);
        endParams.leftMargin = dp(6);
        timeRow.addView(endTimeButton, endParams);
        filterCard.addView(timeRow, timeRowParams);

        LinearLayout filters = new LinearLayout(context);
        filters.setOrientation(HORIZONTAL);
        LayoutParams filterRowParams = new LayoutParams(
                LayoutParams.MATCH_PARENT,
                LayoutParams.WRAP_CONTENT
        );
        filterRowParams.topMargin = dp(6);
        String[] filterLabels = {"全部", "充电", "加油"};
        StationResultPresenter.Filter[] filterValues = {
                StationResultPresenter.Filter.ALL,
                StationResultPresenter.Filter.CHARGING,
                StationResultPresenter.Filter.FUEL
        };
        for (int index = 0; index < filterLabels.length; index++) {
            Button filter = compactButton(filterLabels[index]);
            StationResultPresenter.Filter value = filterValues[index];
            filter.setContentDescription("筛选：" + filterLabels[index]);
            filter.setOnClickListener(view -> {
                if (listener != null) listener.onFilterSelected(value);
            });
            filterButtons[index] = filter;
            filters.addView(filter, weightedFilter(index));
        }
        filterCard.addView(filters, filterRowParams);

        matchCountView = text("找到 0 条", 12, false, palette.textSecondary);
        matchCountView.setContentDescription("匹配记录数量 0 条");
        LayoutParams matchParams = new LayoutParams(
                LayoutParams.MATCH_PARENT,
                LayoutParams.WRAP_CONTENT
        );
        matchParams.topMargin = dp(5);
        filterCard.addView(matchCountView, matchParams);
        addView(filterCard);

        FrameLayout resultFrame = new FrameLayout(context);
        RecyclerView results = new RecyclerView(context);
        results.setLayoutManager(new LinearLayoutManager(context));
        results.setClipToPadding(false);
        results.setPadding(0, 0, 0, dp(8));
        results.setContentDescription("场站识别结果");
        adapter = new StationAdapter();
        results.setAdapter(adapter);
        resultFrame.addView(results, new FrameLayout.LayoutParams(
                LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT
        ));
        emptyView = text("暂无识别结果\n点击下方开始识别", 15, false, palette.textSecondary);
        emptyView.setGravity(Gravity.CENTER);
        emptyView.setContentDescription("暂无识别结果，点击下方开始识别");
        resultFrame.addView(emptyView, new FrameLayout.LayoutParams(
                LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT
        ));
        addView(resultFrame, new LayoutParams(LayoutParams.MATCH_PARENT, 0, 1f));

        LinearLayout actions = new LinearLayout(context);
        actions.setGravity(Gravity.CENTER_VERTICAL);
        actions.setPadding(0, dp(8), 0, 0);
        actions.setBackgroundColor(palette.background);
        primaryButton = compactButton("启动悬浮识别");
        primaryButton.setTextColor(Color.WHITE);
        primaryButton.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        primaryButton.setBackground(roundRect(palette.primary, 12, 0, Color.TRANSPARENT));
        primaryButton.setContentDescription("启动悬浮识别");
        primaryButton.setOnClickListener(view -> {
            if (selectionMode) {
                if (listener != null && !selectedKeys.isEmpty()) {
                    listener.onDeleteSelected(new java.util.LinkedHashSet<>(selectedKeys));
                }
                return;
            }
            if (listener != null) listener.onPrimaryAction();
        });
        actions.addView(primaryButton, new LayoutParams(0, dp(52), 1f));

        multiSelectButton = compactButton("多选");
        multiSelectButton.setTextColor(palette.textSecondary);
        multiSelectButton.setBackground(roundRect(palette.card, 12, 1, palette.border));
        multiSelectButton.setContentDescription("进入多选模式删除记录");
        multiSelectButton.setOnClickListener(view -> toggleSelectionMode());
        LayoutParams multiParams = new LayoutParams(LayoutParams.WRAP_CONTENT, dp(52));
        multiParams.leftMargin = dp(10);
        actions.addView(multiSelectButton, multiParams);

        selectAllButton = compactButton("全选");
        selectAllButton.setTextColor(palette.textSecondary);
        selectAllButton.setBackground(roundRect(palette.card, 12, 1, palette.border));
        selectAllButton.setContentDescription("全选当前列表记录");
        selectAllButton.setVisibility(GONE);
        selectAllButton.setOnClickListener(view -> toggleSelectAll());
        LayoutParams selectAllParams = new LayoutParams(LayoutParams.WRAP_CONTENT, dp(52));
        selectAllParams.leftMargin = dp(10);
        actions.addView(selectAllButton, selectAllParams);
        addView(actions);

        selectFilter(StationResultPresenter.Filter.ALL);
    }

    void setListener(Listener listener) {
        this.listener = listener;
    }

    private void toggleSelectionMode() {
        selectionMode = !selectionMode;
        if (!selectionMode) selectedKeys.clear();
        updateActionButtons();
        adapter.notifyVisibleRowsChanged();
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

    private void toggleSelection(String stableIdentity) {
        if (stableIdentity == null || stableIdentity.isEmpty()) return;
        if (!selectedKeys.add(stableIdentity)) selectedKeys.remove(stableIdentity);
        updateActionButtons();
        adapter.notifyVisibleRowsChanged();
    }

    private void toggleSelectAll() {
        java.util.List<String> all = adapter.allIdentities();
        if (all.isEmpty()) return;
        if (selectedKeys.containsAll(all)) {
            selectedKeys.removeAll(all);
        } else {
            selectedKeys.addAll(all);
        }
        updateActionButtons();
        adapter.notifyVisibleRowsChanged();
    }

    private void updateActionButtons() {
        if (selectionMode) {
            java.util.List<String> all = adapter.allIdentities();
            boolean allSelected = !all.isEmpty() && selectedKeys.containsAll(all);
            multiSelectButton.setText("取消多选");
            multiSelectButton.setContentDescription("退出多选模式");
            selectAllButton.setText(allSelected ? "取消全选" : "全选");
            selectAllButton.setContentDescription(allSelected ? "取消全选当前列表" : "全选当前列表记录");
            selectAllButton.setVisibility(VISIBLE);
            primaryButton.setText(selectedKeys.isEmpty() ? "删除选中" : "删除选中(" + selectedKeys.size() + ")");
            primaryButton.setContentDescription("删除选中的 " + selectedKeys.size() + " 条记录");
            primaryButton.setEnabled(!selectedKeys.isEmpty());
            primaryButton.setAlpha(selectedKeys.isEmpty() ? 0.55f : 1f);
        } else {
            multiSelectButton.setText("多选");
            multiSelectButton.setContentDescription("进入多选模式删除记录");
            selectAllButton.setVisibility(GONE);
            CaptureUiState state = captureUiState;
            primaryButton.setText(state == null ? CaptureUiState.STOPPED.primaryLabel : state.primaryLabel);
            primaryButton.setEnabled(state == null ? CaptureUiState.STOPPED.primaryEnabled : state.primaryEnabled);
            primaryButton.setAlpha(primaryButton.isEnabled() ? 1f : 0.55f);
        }
    }

    void setCaptureState(CaptureUiState state) {
        this.captureUiState = state == null ? CaptureUiState.STOPPED : state;
        statusView.setText(captureUiState.label);
        statusView.setContentDescription("识别状态：" + captureUiState.label);
        if (selectionMode) {
            updateActionButtons();
        } else {
            primaryButton.setText(captureUiState.primaryLabel);
            primaryButton.setContentDescription(captureUiState.primaryLabel);
            primaryButton.setEnabled(captureUiState.primaryEnabled);
            primaryButton.setAlpha(captureUiState.primaryEnabled ? 1f : 0.55f);
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
        setTimeButton(
                startTimeButton,
                "开始时间",
                "开始",
                value.startEpochMillis,
                "设置开始日期时间"
        );
        setTimeButton(
                endTimeButton,
                "结束时间",
                "结束",
                value.endEpochMillis,
                "设置结束日期时间"
        );
    }

    void render(
            StationResultPresenter.ViewState state,
            boolean hasLocalRecords,
            boolean hasActiveFilters
    ) {
        if (state == null) return;
        boolean fuelOnly = state.filter == StationResultPresenter.Filter.FUEL;
        boolean allTypes = state.filter == StationResultPresenter.Filter.ALL;
        int[] values = {
                state.validStations,
                fuelOnly ? state.fuelStationsWithOffers : state.withPrice,
                fuelOnly
                        ? state.fuelStationsWithQuotes
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
            ((View) statisticValues[index].getParent()).setContentDescription(
                    labels[index] + " " + values[index]
            );
        }
        selectFilter(state.filter);
        adapter.submit(state.rows);
        matchCountView.setText(getResources().getString(
                com.datafordidi.ocruploader.R.string.filter_match_count,
                state.rows.size()
        ));
        matchCountView.setContentDescription("匹配记录数量 " + state.rows.size() + " 条");
        if (state.rows.isEmpty()) {
            boolean filteredEmpty = hasLocalRecords && hasActiveFilters;
            String message = filteredEmpty
                    ? "没有符合筛选条件的记录"
                    : "暂无识别结果\n点击下方开始识别";
            emptyView.setText(message);
            emptyView.setContentDescription(message.replace("\n", "，"));
            emptyView.setVisibility(VISIBLE);
        } else {
            emptyView.setVisibility(GONE);
        }
    }

    private void selectFilter(StationResultPresenter.Filter filter) {
        for (int index = 0; index < filterButtons.length; index++) {
            Button button = filterButtons[index];
            boolean selected = (index == 0 && filter == StationResultPresenter.Filter.ALL)
                    || (index == 1 && filter == StationResultPresenter.Filter.CHARGING)
                    || (index == 2 && filter == StationResultPresenter.Filter.FUEL);
            button.setSelected(selected);
            button.setTextColor(selected ? Color.WHITE : palette.textSecondary);
            button.setBackground(roundRect(
                    selected ? palette.primary : palette.card,
                    18,
                    selected ? 0 : 1,
                    palette.border
            ));
        }
    }

    private LayoutParams weightedCell(int index) {
        LayoutParams params = new LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f);
        if (index > 0) params.leftMargin = dp(5);
        return params;
    }

    private LayoutParams weightedFilter(int index) {
        LayoutParams params = new LayoutParams(0, dp(44), 1f);
        if (index > 0) params.leftMargin = dp(6);
        return params;
    }

    private Button timeButton(String label, String description) {
        Button button = compactButton(label);
        button.setTextSize(11);
        button.setMaxLines(2);
        button.setGravity(Gravity.CENTER);
        button.setTextColor(palette.textSecondary);
        button.setBackground(roundRect(palette.inputBackground, 10, 1, palette.border));
        button.setContentDescription(description);
        return button;
    }

    private void finishSearchInput() {
        InputMethodManager input = (InputMethodManager) getContext().getSystemService(
                Context.INPUT_METHOD_SERVICE
        );
        if (input != null) input.hideSoftInputFromWindow(nameSearch.getWindowToken(), 0);
        nameSearch.clearFocus();
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
        button.setText(getResources().getString(
                com.datafordidi.ocruploader.R.string.filter_time_value,
                selectedLabel,
                formatted
        ));
        button.setContentDescription(description + "，当前 " + formatted);
    }

    private Button compactButton(String label) {
        Button button = new Button(getContext());
        button.setText(label);
        button.setTextSize(14);
        button.setAllCaps(false);
        button.setMinHeight(dp(48));
        button.setMinWidth(dp(48));
        button.setPadding(dp(12), 0, dp(12), 0);
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

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private final class StationAdapter extends RecyclerView.Adapter<StationHolder> {
        private final List<JSONObject> rows = new ArrayList<>();

        void submit(List<JSONObject> values) {
            int previousSize = rows.size();
            rows.clear();
            if (previousSize > 0) notifyItemRangeRemoved(0, previousSize);
            if (values != null) rows.addAll(values);
            if (!rows.isEmpty()) notifyItemRangeInserted(0, rows.size());
        }

        java.util.List<String> allIdentities() {
            java.util.List<String> out = new java.util.ArrayList<>();
            for (int index = 0; index < rows.size(); index++) {
                String id = StationIdentity.fromRow(rows.get(index), index);
                if (id != null && !id.isEmpty()) out.add(id);
            }
            return out;
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
        private final TextView address;
        private final TextView price;
        private final TextView ports;
        private final TextView missing;
        private final TextView capturedAt;
        private final Button edit;
        private final TextView selectMark;
        private JSONObject boundRow = null;
        private String boundIdentity = "";

        StationCardView(Context context) {
            super(context);
            setOrientation(VERTICAL);
            setPadding(dp(14), dp(12), dp(14), dp(12));
            setBackground(roundRect(palette.card, 14, 1, palette.border));
            setFocusable(true);
            setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_YES);

            LinearLayout header = new LinearLayout(context);
            header.setGravity(Gravity.TOP);
            name = text("", 16, true, palette.textPrimary);
            name.setMaxLines(2);
            name.setEllipsize(TextUtils.TruncateAt.END);
            header.addView(name, new LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f));

            selectMark = text("✓", 18, true, Color.WHITE);
            selectMark.setGravity(Gravity.CENTER);
            selectMark.setBackground(roundRect(palette.primary, 12, 0, Color.TRANSPARENT));
            selectMark.setVisibility(GONE);
            LayoutParams selectParams = new LayoutParams(dp(26), dp(26));
            selectParams.leftMargin = dp(8);
            header.addView(selectMark, selectParams);
            addView(header);

            setOnClickListener(view -> {
                if (selectionMode) {
                    toggleSelection(boundIdentity);
                } else if (listener != null && boundRow != null) {
                    listener.onEditBackfill(AddressFreePayload.copyObject(boundRow));
                }
            });

            address = text("", 13, false, palette.textSecondary);
            address.setMaxLines(3);
            address.setEllipsize(TextUtils.TruncateAt.END);
            LayoutParams addressParams = new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT);
            addressParams.topMargin = dp(5);
            addView(address, addressParams);

            price = text("", 22, true, palette.price);
            LayoutParams priceParams = new LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT);
            priceParams.topMargin = dp(8);
            addView(price, priceParams);

            ports = text("", 13, false, palette.textSecondary);
            ports.setMaxLines(6);
            LayoutParams portsParams = new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT);
            portsParams.topMargin = dp(6);
            addView(ports, portsParams);

            LinearLayout footer = new LinearLayout(context);
            footer.setGravity(Gravity.CENTER_VERTICAL);
            missing = text("", 12, true, palette.warning);
            footer.addView(missing, new LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f));
            LayoutParams footerParams = new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT);
            footerParams.topMargin = dp(8);
            addView(footer, footerParams);

            capturedAt = text("", 12, false, palette.textSecondary);
            LayoutParams capturedParams = new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT);
            capturedParams.topMargin = dp(7);
            addView(capturedAt, capturedParams);

            edit = compactButton("编辑回填");
            edit.setTextColor(palette.primary);
            edit.setBackground(roundRect(palette.card, 10, 1, palette.primary));
            edit.setContentDescription("编辑回填场站缺失信息");
            LayoutParams editParams = new LayoutParams(LayoutParams.MATCH_PARENT, dp(48));
            editParams.topMargin = dp(8);
            addView(edit, editParams);

            RecyclerView.LayoutParams cardParams = new RecyclerView.LayoutParams(
                    LayoutParams.MATCH_PARENT,
                    LayoutParams.WRAP_CONTENT
            );
            cardParams.bottomMargin = dp(8);
            setLayoutParams(cardParams);
        }

        void bind(JSONObject row, int position) {
            boundRow = row;
            boundIdentity = row == null ? "" : StationIdentity.fromRow(row, position);
            String stationName = StationRecordFilter.stationName(row);
            if (stationName.isEmpty()) stationName = "未命名场站";
            String addressText = StationDisplayFormatter.address(row);
            String priceText = StationDisplayFormatter.mainPrice(row);
            String portsText = StationDisplayFormatter.portSummary(row);
            boolean hasPrice = StationDisplayFormatter.hasPrice(row);
            boolean hasPorts = StationDisplayFormatter.hasPorts(row);
            String missingText = StationDisplayFormatter.missingSummary(row);
            String capturedText = StationDisplayFormatter.capturedAt(row);
            boolean editable = StationDisplayFormatter.canEditBackfill(row);

            name.setText(stationName);
            address.setText(addressText);
            address.setVisibility(addressText.isEmpty() ? GONE : VISIBLE);
            address.setTextColor(StationDisplayFormatter.hasAddress(row)
                    ? palette.textSecondary : palette.warning);
            price.setText(priceText);
            price.setVisibility(StationDisplayFormatter.showFeaturedPrice(row) ? VISIBLE : GONE);
            price.setTextColor(hasPrice ? palette.price : palette.warning);
            ports.setText(portsText);
            missing.setText(missingText);
            missing.setTextColor(StationDisplayFormatter.incomplete(row) ? palette.warning : palette.success);
            capturedAt.setText(capturedText);
            boolean selected = !boundIdentity.isEmpty() && selectedKeys.contains(boundIdentity);
            if (selectionMode) {
                edit.setVisibility(GONE);
                selectMark.setVisibility(VISIBLE);
                selectMark.setText(selected ? "✓" : "○");
                selectMark.setTextColor(selected ? Color.WHITE : palette.textSecondary);
                selectMark.setBackground(roundRect(
                        selected ? palette.primary : palette.card, 12,
                        selected ? 0 : 1, palette.border));
                setBackground(roundRect(selected ? palette.statusBackground : palette.card, 14, 1, palette.border));
            } else {
                edit.setVisibility(editable ? VISIBLE : GONE);
                selectMark.setVisibility(GONE);
                setBackground(roundRect(palette.card, 14, 1, palette.border));
            }
            edit.setContentDescription(StationDisplayFormatter.editDescription(row));
            edit.setOnClickListener(view -> {
                if (listener != null) listener.onEditBackfill(AddressFreePayload.copyObject(row));
            });
            setContentDescription(stationName + "，" + addressText + "，" + priceText + "，" + portsText + "，"
                    + missingText + "，" + capturedText
                    + (selectionMode ? (selected ? "，已选中" : "，未选中") : (editable ? "，可编辑回填" : "")));
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
        final int price;
        final int warning;
        final int success;

        Palette(boolean dark) {
            background = Color.parseColor(dark ? "#10151C" : "#F4F7FB");
            card = Color.parseColor(dark ? "#1B2430" : "#FFFFFF");
            inputBackground = Color.parseColor(dark ? "#141C26" : "#F7F9FC");
            border = Color.parseColor(dark ? "#344252" : "#DDE5EF");
            textPrimary = Color.parseColor(dark ? "#F4F7FA" : "#17202A");
            textSecondary = Color.parseColor(dark ? "#C0CAD5" : "#4F5B67");
            primary = Color.parseColor(dark ? "#79B8FF" : "#1565C0");
            statusBackground = Color.parseColor(dark ? "#243A53" : "#E3F0FF");
            price = Color.parseColor(dark ? "#FFB36B" : "#C94F00");
            warning = Color.parseColor(dark ? "#FFD180" : "#9A5B00");
            success = Color.parseColor(dark ? "#77D99B" : "#187A3C");
        }

        static Palette from(Context context) {
            int mode = context.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK;
            return new Palette(mode == Configuration.UI_MODE_NIGHT_YES);
        }
    }
}
