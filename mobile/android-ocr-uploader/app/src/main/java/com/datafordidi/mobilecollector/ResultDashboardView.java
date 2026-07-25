package com.datafordidi.mobilecollector;

import android.content.Context;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.recyclerview.widget.LinearLayoutManager;
import androidx.recyclerview.widget.RecyclerView;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

final class ResultDashboardView extends LinearLayout {
    interface Listener {
        void onPrimaryAction();

        void onClearCompleted();

        void onFilterSelected(StationResultPresenter.Filter filter);

        void onEditBackfill(JSONObject row);

        /** 用户在多选模式下点「删除选中」时回调，传入所选记录的稳定身份集合。 */
        void onDeleteSelected(java.util.Set<String> stableIdentities);
    }

    private final Palette palette;
    private final TextView statusView;
    private final TextView[] statisticValues = new TextView[5];
    private final Button[] filterButtons = new Button[3];
    private final Button primaryButton;
    private final Button clearButton;
    private final Button multiSelectButton;
    private final StationAdapter adapter;
    private final TextView emptyView;
    private Listener listener;
    private boolean selectionMode = false;
    private final java.util.Set<String> selectedKeys = new java.util.LinkedHashSet<>();
    private CaptureUiState captureUiState = CaptureUiState.STOPPED;

    ResultDashboardView(Context context) {
        super(context);
        palette = Palette.from(context);
        setOrientation(VERTICAL);
        setPadding(dp(16), dp(12), dp(16), dp(10));
        setBackgroundColor(palette.background);

        LinearLayout titleRow = new LinearLayout(context);
        titleRow.setGravity(Gravity.CENTER_VERTICAL);
        TextView title = text("信息自动识别", 20, true, palette.textPrimary);
        title.setMaxLines(1);
        titleRow.addView(title, new LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f));
        statusView = text("已停止", 14, true, palette.primary);
        statusView.setGravity(Gravity.CENTER);
        statusView.setPadding(dp(12), dp(7), dp(12), dp(7));
        statusView.setBackground(roundRect(palette.statusBackground, 18, 0, Color.TRANSPARENT));
        statusView.setContentDescription("识别状态：已停止");
        titleRow.addView(statusView);
        addView(titleRow);

        LinearLayout statistics = new LinearLayout(context);
        statistics.setOrientation(HORIZONTAL);
        statistics.setPadding(0, dp(10), 0, dp(8));
        String[] labels = {"有效场站", "有价", "有枪", "待补充", "待回传"};
        for (int index = 0; index < labels.length; index++) {
            LinearLayout cell = new LinearLayout(context);
            cell.setOrientation(VERTICAL);
            cell.setGravity(Gravity.CENTER);
            cell.setPadding(dp(2), dp(8), dp(2), dp(8));
            cell.setBackground(roundRect(palette.card, 10, 1, palette.border));
            statisticValues[index] = text("0", 19, true, palette.textPrimary);
            TextView label = text(labels[index], 11, false, palette.textSecondary);
            cell.addView(statisticValues[index]);
            cell.addView(label);
            cell.setContentDescription(labels[index] + " 0");
            statistics.addView(cell, weightedCell(index));
        }
        addView(statistics);

        LinearLayout filters = new LinearLayout(context);
        filters.setOrientation(HORIZONTAL);
        filters.setPadding(0, 0, 0, dp(8));
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
        addView(filters);

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
        primaryButton = compactButton("开始识别");
        primaryButton.setTextColor(Color.WHITE);
        primaryButton.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        primaryButton.setBackground(roundRect(palette.primary, 12, 0, Color.TRANSPARENT));
        primaryButton.setContentDescription("开始识别");
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

        clearButton = compactButton("清理已回传");
        clearButton.setTextColor(palette.textSecondary);
        clearButton.setBackground(roundRect(palette.card, 12, 1, palette.border));
        clearButton.setContentDescription("清理已回传结果，保留待回传数据");
        clearButton.setOnClickListener(view -> {
            if (listener != null) listener.onClearCompleted();
        });
        LayoutParams clearParams = new LayoutParams(LayoutParams.WRAP_CONTENT, dp(52));
        clearParams.leftMargin = dp(10);
        actions.addView(clearButton, clearParams);

        multiSelectButton = compactButton("多选");
        multiSelectButton.setTextColor(palette.textSecondary);
        multiSelectButton.setBackground(roundRect(palette.card, 12, 1, palette.border));
        multiSelectButton.setContentDescription("进入多选模式删除记录");
        multiSelectButton.setOnClickListener(view -> toggleSelectionMode());
        LayoutParams multiParams = new LayoutParams(LayoutParams.WRAP_CONTENT, dp(52));
        multiParams.leftMargin = dp(10);
        actions.addView(multiSelectButton, multiParams);
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
        adapter.notifyDataSetChanged();
    }

    void exitSelectionMode() {
        if (!selectionMode) return;
        selectionMode = false;
        selectedKeys.clear();
        updateActionButtons();
        adapter.notifyDataSetChanged();
    }

    boolean isSelectionMode() {
        return selectionMode;
    }

    private void toggleSelection(String stableIdentity) {
        if (stableIdentity == null || stableIdentity.isEmpty()) return;
        if (!selectedKeys.add(stableIdentity)) selectedKeys.remove(stableIdentity);
        updateActionButtons();
        adapter.notifyDataSetChanged();
    }

    private void updateActionButtons() {
        if (selectionMode) {
            multiSelectButton.setText("取消多选");
            primaryButton.setText(selectedKeys.isEmpty() ? "删除选中" : "删除选中(" + selectedKeys.size() + ")");
            primaryButton.setContentDescription("删除选中的 " + selectedKeys.size() + " 条记录");
        } else {
            multiSelectButton.setText("多选");
            CaptureUiState state = captureUiState;
            primaryButton.setText(state == null ? CaptureUiState.STOPPED.primaryLabel : state.primaryLabel);
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

    void render(StationResultPresenter.ViewState state) {
        if (state == null) return;
        boolean fuelOnly = state.filter == StationResultPresenter.Filter.FUEL;
        int[] values = {
                state.validStations,
                fuelOnly ? state.fuelStationsWithOffers : state.withPrice,
                fuelOnly ? state.fuelStationsWithQuotes : state.withGuns,
                state.incomplete,
                state.pending
        };
        String[] labels = {
                "有效场站", fuelOnly ? "有油号" : "有价", fuelOnly ? "有报价" : "有枪", "待补充", "待回传"
        };
        for (int index = 0; index < values.length; index++) {
            statisticValues[index].setText(String.valueOf(values[index]));
            ((View) statisticValues[index].getParent()).setContentDescription(
                    labels[index] + " " + values[index]
            );
        }
        selectFilter(state.filter);
        adapter.submit(state.rows);
        emptyView.setVisibility(state.rows.isEmpty() ? VISIBLE : GONE);
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
        LayoutParams params = new LayoutParams(0, dp(48), 1f);
        if (index > 0) params.leftMargin = dp(8);
        return params;
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

        @Override
        public StationHolder onCreateViewHolder(ViewGroup parent, int viewType) {
            return new StationHolder(new StationCardView(parent.getContext()));
        }

        @Override
        public void onBindViewHolder(StationHolder holder, int position) {
            holder.card.bind(rows.get(position));
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
        private final TextView sync;
        private final TextView capturedAt;
        private final TextView agent;
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

            name = text("", 16, true, palette.textPrimary);
            name.setMaxLines(2);
            name.setEllipsize(TextUtils.TruncateAt.END);
            addView(name);

            selectMark = text("✓", 18, true, Color.WHITE);
            selectMark.setGravity(Gravity.CENTER);
            selectMark.setBackground(roundRect(palette.primary, 12, 0, Color.TRANSPARENT));
            selectMark.setVisibility(GONE);
            LayoutParams selectParams = new LayoutParams(dp(26), dp(26));
            selectParams.topMargin = dp(2);
            selectParams.leftMargin = dp(8);
            addView(selectMark, selectParams);

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
            sync = text("", 12, false, palette.textSecondary);
            sync.setGravity(Gravity.END);
            footer.addView(missing, new LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f));
            footer.addView(sync);
            LayoutParams footerParams = new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT);
            footerParams.topMargin = dp(8);
            addView(footer, footerParams);

            capturedAt = text("", 12, false, palette.textSecondary);
            LayoutParams capturedParams = new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT);
            capturedParams.topMargin = dp(7);
            addView(capturedAt, capturedParams);

            agent = text("", 12, false, palette.textSecondary);
            LayoutParams agentParams = new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT);
            agentParams.topMargin = dp(3);
            addView(agent, agentParams);

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

        void bind(JSONObject row) {
            boundRow = row;
            boundIdentity = row == null ? "" : row.optString("stableIdentity", "");
            String stationName = row == null ? "" : row.optString("stationName", "未命名场站");
            String addressText = StationDisplayFormatter.address(row);
            String priceText = StationDisplayFormatter.mainPrice(row);
            String portsText = StationDisplayFormatter.portSummary(row);
            boolean hasPrice = StationDisplayFormatter.hasPrice(row);
            boolean hasPorts = StationDisplayFormatter.hasPorts(row);
            String missingText = StationDisplayFormatter.missingSummary(row);
            String syncText = StationDisplayFormatter.syncStatus(row);
            String capturedText = StationDisplayFormatter.capturedAt(row);
            boolean editable = StationDisplayFormatter.canEditBackfill(row);

            name.setText(stationName);
            address.setText(addressText);
            address.setTextColor(StationDisplayFormatter.hasAddress(row)
                    ? palette.textSecondary : palette.warning);
            price.setText(priceText);
            price.setTextColor(hasPrice ? palette.price : palette.warning);
            ports.setText(portsText);
            missing.setText(missingText);
            missing.setTextColor(StationDisplayFormatter.incomplete(row) ? palette.warning : palette.success);
            sync.setText(syncText);
            capturedAt.setText(capturedText);
            agent.setText(getResources().getString(
                    com.datafordidi.ocruploader.R.string.source_agent_format,
                    StationDisplayFormatter.sourceAgent(row)
            ));
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
                    + missingText + "，" + syncText + "，" + capturedText
                    + "，来源" + StationDisplayFormatter.sourceAgent(row)
                    + (selectionMode ? (selected ? "，已选中" : "，未选中") : (editable ? "，可编辑回填" : "")));
        }
    }

    private static final class Palette {
        final int background;
        final int card;
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
