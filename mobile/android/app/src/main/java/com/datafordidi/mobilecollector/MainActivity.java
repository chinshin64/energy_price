package com.datafordidi.mobilecollector;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.ActivityManager;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.media.projection.MediaProjectionManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.text.Editable;
import android.text.InputType;
import android.text.TextWatcher;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

import java.util.List;
import java.util.Locale;

public class MainActivity extends Activity {
    private static final int REQUEST_CAPTURE = 2001;
    private static final int REQUEST_NOTIFICATION = 2002;

    private EditText serverUrlInput;
    private EditText tokenInput;
    private EditText edgeEnrollmentInput;
    private EditText cityInput;
    private EditText minIntervalInput;
    private EditText maxIntervalInput;
    private EditText maxPagesInput;
    private TextView statusText;
    private TextView syncStatusText;
    private TextView permissionStatusText;
    private TextView collectionStatusText;
    private TextView localResultSummary;
    private LinearLayout localResultContainer;
    private Button commandModeButton;
    private Button collectionModeButton;
    private Button primaryCollectButton;
    private Button detailEnrichToggleButton;
    private Button rawOcrUploadToggleButton;
    private Button accessibilityPermissionButton;
    private Button floatingPermissionButton;
    private int localResultVisibleLimit = 50;
    private boolean loadingSettings = false;
    private boolean hasUnsavedChanges = false;
    private boolean useScreenshotOcrMode = true;
    private boolean detailEnrichmentEnabled = true;
    private boolean rawOcrUploadEnabled = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (Build.VERSION.SDK_INT >= 33) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQUEST_NOTIFICATION);
        }
        setContentView(buildContentView());
        loadSettingsIntoForm();
        registerSettingsWatchers();
        refreshStatus();
        refreshLocalResults();
    }

    @Override
    protected void onResume() {
        super.onResume();
        refreshStatus();
        refreshLocalResults();
    }

    private View buildContentView() {
        ScrollView scrollView = new ScrollView(this);
        scrollView.setBackgroundColor(Color.rgb(247, 242, 235));

        LinearLayout root = vertical();
        root.setPadding(dp(18), dp(22), dp(18), dp(26));
        scrollView.addView(root);

        LinearLayout hero = card();
        hero.setBackground(makeGradient(Color.WHITE, Color.rgb(255, 246, 238), dp(28), Color.TRANSPARENT));
        TextView title = text("数据学习采集端", 28, Color.rgb(22, 31, 54), true);
        TextView subtitle = text("手机只执行服务端指令，并把识别结果同步到服务端", 14, Color.rgb(104, 115, 138), false);
        statusText = text("", 13, Color.rgb(104, 115, 138), false);
        statusText.setPadding(0, dp(12), 0, 0);
        hero.addView(title);
        hero.addView(subtitle);
        hero.addView(statusText);
        root.addView(hero);

        LinearLayout stateCard = card();
        stateCard.addView(sectionTitle("运行状态"));
        syncStatusText = statusBlock(stateCard, "同步通道");
        permissionStatusText = statusBlock(stateCard, "权限状态");
        collectionStatusText = statusBlock(stateCard, "采集状态");
        Button refreshButton = secondaryButton("刷新状态");
        refreshButton.setOnClickListener(v -> refreshStatus());
        stateCard.addView(refreshButton);
        root.addView(stateCard);

        LinearLayout configCard = card();
        configCard.addView(sectionTitle("同步配置"));
        serverUrlInput = addInput(configCard, "同步地址", "http://server-host:3000", false);
        tokenInput = addInput(configCard, "同步凭证", "请输入同步凭证", true);
        edgeEnrollmentInput = addInput(configCard, "协同登记凭证", "留空时沿用同步凭证", true);
        cityInput = addInput(configCard, "当前城市", "上海", false);
        addIntervalInputs(configCard);

        detailEnrichToggleButton = secondaryButton("");
        detailEnrichToggleButton.setOnClickListener(v -> {
            detailEnrichmentEnabled = !detailEnrichmentEnabled;
            hasUnsavedChanges = true;
            refreshStatus();
        });
        configCard.addView(detailEnrichToggleButton);

        rawOcrUploadToggleButton = secondaryButton("");
        rawOcrUploadToggleButton.setOnClickListener(v -> {
            rawOcrUploadEnabled = !rawOcrUploadEnabled;
            hasUnsavedChanges = true;
            refreshStatus();
        });
        configCard.addView(rawOcrUploadToggleButton);
        configCard.addView(text(
                "默认只向 47 上传已解析的场站字段；原始 OCR 仅在连接兼容诊断服务时手动开启。",
                12,
                Color.rgb(104, 115, 138),
                false
        ));

        Button confirmSettingsButton = primaryButton("保存配置");
        confirmSettingsButton.setOnClickListener(v -> confirmSettings());
        configCard.addView(confirmSettingsButton);
        root.addView(configCard);

        LinearLayout commandCard = card();
        commandCard.addView(sectionTitle("服务端指令"));
        commandCard.addView(text("启动后，手机会轮询服务端任务；再次点击同一按钮即可停止。", 13, Color.rgb(104, 115, 138), false));
        commandModeButton = primaryButton("");
        commandModeButton.setOnClickListener(v -> toggleNetworkCommandMode());
        commandCard.addView(commandModeButton);
        root.addView(commandCard);

        LinearLayout collectCard = card();
        collectCard.addView(sectionTitle("本机采集"));
        collectCard.addView(text("优先使用服务端指令模式。本机采集用于现场手动兜底。", 13, Color.rgb(104, 115, 138), false));
        collectionModeButton = secondaryButton("");
        collectionModeButton.setOnClickListener(v -> {
            useScreenshotOcrMode = !useScreenshotOcrMode;
            refreshStatus();
        });
        primaryCollectButton = primaryButton("");
        primaryCollectButton.setOnClickListener(v -> toggleCollection());
        collectCard.addView(collectionModeButton);
        collectCard.addView(primaryCollectButton);
        root.addView(collectCard);

        LinearLayout resultCard = card();
        resultCard.addView(sectionTitle("当前已获取数据"));
        localResultSummary = text("尚未识别到场站", 13, Color.rgb(104, 115, 138), false);
        resultCard.addView(localResultSummary);
        localResultContainer = vertical();
        resultCard.addView(localResultContainer);
        Button clearResultButton = secondaryButton("清空本地结果");
        clearResultButton.setOnClickListener(v -> {
            LocalStationStore.clear(this);
            localResultVisibleLimit = 50;
            refreshLocalResults();
        });
        resultCard.addView(clearResultButton);
        root.addView(resultCard);

        LinearLayout permissionCard = card();
        permissionCard.addView(sectionTitle("权限管理"));
        accessibilityPermissionButton = secondaryButton("");
        accessibilityPermissionButton.setOnClickListener(v -> startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)));
        floatingPermissionButton = secondaryButton("");
        floatingPermissionButton.setOnClickListener(v -> startActivity(FloatingStopOverlay.buildOverlayPermissionIntent(this)));
        Button appSettingsButton = secondaryButton("应用设置");
        appSettingsButton.setOnClickListener(v -> {
            Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
            intent.setData(Uri.parse("package:" + getPackageName()));
            startActivity(intent);
        });
        permissionCard.addView(accessibilityPermissionButton);
        permissionCard.addView(floatingPermissionButton);
        permissionCard.addView(appSettingsButton);
        root.addView(permissionCard);

        return scrollView;
    }

    private void addIntervalInputs(LinearLayout root) {
        minIntervalInput = addInput(root, "最短间隔(ms)", "2500", false);
        maxIntervalInput = addInput(root, "最长间隔(ms)", "6500", false);
        maxPagesInput = addInput(root, "本次最多下滑次数", "100，0 表示不限制", false);
    }

    private TextView statusBlock(LinearLayout root, String label) {
        TextView view = text("", 14, Color.rgb(22, 31, 54), true);
        view.setPadding(dp(14), dp(12), dp(14), dp(12));
        view.setBackground(makeSolid(Color.rgb(248, 250, 252), dp(18), Color.rgb(232, 235, 242)));
        LinearLayout.LayoutParams params = blockParams();
        params.setMargins(0, dp(10), 0, 0);
        view.setLayoutParams(params);
        view.setText(label);
        root.addView(view);
        return view;
    }

    private EditText addInput(LinearLayout root, String label, String hint, boolean password) {
        LinearLayout group = vertical();
        group.setPadding(0, dp(12), 0, 0);
        TextView labelView = text(label, 13, Color.rgb(104, 115, 138), true);
        EditText input = new EditText(this);
        input.setSingleLine(true);
        input.setHint(hint);
        input.setTextSize(15);
        input.setPadding(dp(14), 0, dp(14), 0);
        input.setMinHeight(dp(50));
        input.setBackground(makeSolid(Color.rgb(248, 250, 252), dp(16), Color.rgb(224, 228, 236)));
        if (password) {
            input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        }
        group.addView(labelView);
        group.addView(input);
        root.addView(group);
        return input;
    }

    private void loadSettingsIntoForm() {
        loadingSettings = true;
        CollectorSettings.migrateSecrets(this);
        serverUrlInput.setText(CollectorSettings.getServerUrl(this));
        tokenInput.setText("");
        tokenInput.setHint(CollectorSettings.hasToken(this) ? "已安全保存，留空保持不变" : "请输入同步凭证");
        edgeEnrollmentInput.setText("");
        edgeEnrollmentInput.setHint(CollectorSettings.hasEdgeEnrollmentToken(this)
                ? "已安全保存，留空保持不变" : "留空时沿用同步凭证");
        cityInput.setText(CollectorSettings.getCity(this));
        minIntervalInput.setText(String.valueOf(CollectorSettings.getMinIntervalMillis(this)));
        maxIntervalInput.setText(String.valueOf(CollectorSettings.getMaxIntervalMillis(this)));
        maxPagesInput.setText(String.valueOf(CollectorSettings.getMaxPages(this)));
        detailEnrichmentEnabled = CollectorSettings.isDetailEnrichmentEnabled(this);
        rawOcrUploadEnabled = CollectorSettings.isRawOcrUploadEnabled(this);
        loadingSettings = false;
        hasUnsavedChanges = false;
    }

    private void saveSettingsFromForm() {
        String rawServerUrl = serverUrlInput.getText().toString().trim();
        if (looksLikeSshEndpoint(rawServerUrl)) {
            Toast.makeText(this, "同步地址应填写 HTTP 地址，不是 SSH 地址", Toast.LENGTH_LONG).show();
            throw new IllegalArgumentException("sync server url cannot be ssh endpoint");
        }

        CollectorSettings.save(
                this,
                rawServerUrl,
                tokenInput.getText().toString(),
                CollectorSettings.getPlatform(this),
                cityInput.getText().toString(),
                parseInt(minIntervalInput.getText().toString(), 2500),
                parseInt(maxIntervalInput.getText().toString(), 6500),
                parseInt(maxPagesInput.getText().toString(), 100),
                detailEnrichmentEnabled,
                CollectorSettings.isAiSupervisorEnabled(this),
                CollectorSettings.isTestEvidenceEnabled(this),
                rawOcrUploadEnabled
        );
        CollectorSettings.saveEdgeEnrollmentToken(this, edgeEnrollmentInput.getText().toString());
    }

    private void confirmSettings() {
        try {
            saveSettingsFromForm();
            loadSettingsIntoForm();
            Toast.makeText(this, "配置已保存", Toast.LENGTH_SHORT).show();
            refreshStatus();
        } catch (RuntimeException error) {
            Toast.makeText(this, error.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    private void toggleNetworkCommandMode() {
        if (isServiceRunning(NetworkCommandService.class)) {
            stopService(new Intent(this, NetworkCommandService.class));
            Toast.makeText(this, "网络指令模式已停止", Toast.LENGTH_SHORT).show();
            refreshStatus();
            return;
        }

        if (!ensureSettingsConfirmed()) {
            return;
        }
        if (!AutoScrollAccessibilityService.isReady()) {
            Toast.makeText(this, "请先开启辅助功能授权", Toast.LENGTH_LONG).show();
            startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS));
            return;
        }
        startNetworkCommandService();
        Toast.makeText(this, "网络指令模式已启动", Toast.LENGTH_SHORT).show();
        refreshStatus();
    }

    private void startNetworkCommandService() {
        Intent service = new Intent(this, NetworkCommandService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(service);
        } else {
            startService(service);
        }
    }

    private void toggleCollection() {
        if (isServiceRunning(AccessibilityTextCollectService.class) || isServiceRunning(CaptureOcrService.class)) {
            stopService(new Intent(this, CaptureOcrService.class));
            stopService(new Intent(this, AccessibilityTextCollectService.class));
            Toast.makeText(this, "采集已停止", Toast.LENGTH_SHORT).show();
            refreshStatus();
            return;
        }

        if (useScreenshotOcrMode) {
            startScreenshotCollection();
        } else {
            startTextOnlyCollection();
        }
    }

    private void startScreenshotCollection() {
        if (!ensureSettingsConfirmed()) {
            return;
        }
        if (!AutoScrollAccessibilityService.isReady()) {
            Toast.makeText(this, "辅助功能未开启，无法自动下滑", Toast.LENGTH_LONG).show();
        }
        if (!FloatingStopOverlay.canDrawOverlays(this)) {
            Toast.makeText(this, "未开启悬浮窗权限，采集中无法直接停止", Toast.LENGTH_LONG).show();
        }
        MediaProjectionManager manager = (MediaProjectionManager) getSystemService(MEDIA_PROJECTION_SERVICE);
        startActivityForResult(manager.createScreenCaptureIntent(), REQUEST_CAPTURE);
    }

    private void startTextOnlyCollection() {
        if (!ensureSettingsConfirmed()) {
            return;
        }
        if (!AutoScrollAccessibilityService.isReady()) {
            Toast.makeText(this, "请先开启辅助功能授权", Toast.LENGTH_LONG).show();
            startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS));
            return;
        }
        if (!FloatingStopOverlay.canDrawOverlays(this)) {
            Toast.makeText(this, "请先开启悬浮窗权限，否则无法在微信上直接停止", Toast.LENGTH_LONG).show();
            startActivity(FloatingStopOverlay.buildOverlayPermissionIntent(this));
            return;
        }

        Intent service = new Intent(this, AccessibilityTextCollectService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(service);
        } else {
            startService(service);
        }
        Toast.makeText(this, "已启动兼容采集", Toast.LENGTH_LONG).show();
        moveTaskToBack(true);
        refreshStatus();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQUEST_CAPTURE) {
            return;
        }
        if (resultCode != RESULT_OK || data == null) {
            Toast.makeText(this, "未获得截屏授权", Toast.LENGTH_SHORT).show();
            return;
        }

        Intent service = new Intent(this, CaptureOcrService.class)
                .putExtra(CaptureOcrService.EXTRA_RESULT_CODE, resultCode)
                .putExtra(CaptureOcrService.EXTRA_RESULT_DATA, data);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(service);
        } else {
            startService(service);
        }
        moveTaskToBack(true);
        refreshStatus();
    }

    @SuppressLint("SetTextI18n")
    private void refreshStatus() {
        boolean commandRunning = isServiceRunning(NetworkCommandService.class);
        boolean localRunning = isServiceRunning(AccessibilityTextCollectService.class) || isServiceRunning(CaptureOcrService.class);
        boolean accessibilityReady = AutoScrollAccessibilityService.isReady();
        boolean overlayReady = FloatingStopOverlay.canDrawOverlays(this);

        statusText.setText((hasUnsavedChanges ? "配置未保存" : "配置已保存")
                + " · " + CollectorSettings.getServerUrl(this));

        syncStatusText.setText("同步通道\n" + CollectorSettings.getServerUrl(this));
        permissionStatusText.setText("权限状态\n辅助功能 " + (accessibilityReady ? "已开启" : "未开启")
                + " · 悬浮窗 " + (overlayReady ? "已开启" : "未开启"));
        collectionStatusText.setText("采集状态\n服务端指令 " + (commandRunning ? "运行中" : "未启动")
                + " · 本机采集 " + (localRunning ? "运行中" : "未启动")
                + " · 城市 " + valueOrDefault(CollectorSettings.getCity(this), "未设置"));

        if (commandModeButton != null) {
            commandModeButton.setText(commandRunning ? "停止网络指令模式" : "启动网络指令模式");
            applyButtonStyle(commandModeButton, commandRunning ? Color.rgb(217, 74, 69) : Color.rgb(255, 106, 26), Color.WHITE);
        }
        if (collectionModeButton != null) {
            collectionModeButton.setText("采集方式：" + (useScreenshotOcrMode ? "截图 OCR" : "兼容文本"));
        }
        if (primaryCollectButton != null) {
            primaryCollectButton.setText(localRunning ? "停止当前采集" : "开始本机采集");
            applyButtonStyle(primaryCollectButton, localRunning ? Color.rgb(217, 74, 69) : Color.rgb(255, 106, 26), Color.WHITE);
        }
        if (detailEnrichToggleButton != null) {
            detailEnrichToggleButton.setText("缺失信息补全：" + (detailEnrichmentEnabled ? "已开启" : "已关闭"));
        }
        if (rawOcrUploadToggleButton != null) {
            rawOcrUploadToggleButton.setText("原始 OCR 诊断上传：" + (rawOcrUploadEnabled ? "已开启" : "已关闭"));
        }
        if (accessibilityPermissionButton != null) {
            accessibilityPermissionButton.setText(accessibilityReady ? "辅助功能已开启" : "去开启辅助功能");
        }
        if (floatingPermissionButton != null) {
            floatingPermissionButton.setText(overlayReady ? "悬浮窗已开启" : "去开启悬浮窗");
        }
    }

    @SuppressLint("SetTextI18n")
    private void refreshLocalResults() {
        if (localResultContainer == null || localResultSummary == null) return;
        List<JSONObject> rows = LocalStationStore.list(this);
        localResultSummary.setText(rows.isEmpty()
                ? "尚未识别到场站"
                : "本机保留最近 " + LocalStationStore.MAX_RESULTS + " 条 · 当前 " + rows.size() + " 条");
        localResultContainer.removeAllViews();
        int visible = Math.min(rows.size(), localResultVisibleLimit);
        for (int index = 0; index < visible; index++) {
            JSONObject row = rows.get(index);
            TextView item = text(formatLocalResult(row), 13, Color.rgb(22, 31, 54), false);
            item.setPadding(dp(14), dp(12), dp(14), dp(12));
            item.setBackground(makeSolid(Color.rgb(248, 250, 252), dp(16), Color.rgb(232, 235, 242)));
            LinearLayout.LayoutParams params = blockParams();
            params.setMargins(0, dp(10), 0, 0);
            item.setLayoutParams(params);
            localResultContainer.addView(item);
        }
        if (visible < rows.size()) {
            int remaining = rows.size() - visible;
            Button showMoreButton = secondaryButton("显示更多（剩余 " + remaining + " 条）");
            showMoreButton.setOnClickListener(v -> {
                localResultVisibleLimit += 50;
                refreshLocalResults();
            });
            localResultContainer.addView(showMoreButton);
        }
    }

    private String formatLocalResult(JSONObject row) {
        int idle = row.optInt("availablePorts", 0);
        int total = row.optInt("totalPorts", 0);
        int busy = Math.max(0, total - idle);
        String address = row.optString("address", "").trim();
        String state = row.optString("syncState", "pending");
        String stateLabel = "synced".equals(state) ? "47 已落库" : ("failed".equals(state) ? "同步失败" : "待同步");
        return row.optString("stationName", "未命名场站")
                + "\n" + (address.isEmpty() ? "地址待详情页补全" : address)
                + "\n枪：闲 " + idle + " / 忙 " + busy + " / 总 " + total
                + "\n价格：" + formatPrices(row)
                + "\n" + row.optString("sourceAgent", LocalStationStore.SOURCE_AGENT) + " · " + stateLabel;
    }

    private String formatPrices(JSONObject row) {
        StringBuilder prices = new StringBuilder();
        appendPrice(prices, "快", row, "priceFast");
        appendPrice(prices, "慢", row, "priceSlow");
        appendPrice(prices, "超", row, "priceSuper");
        return prices.length() == 0 ? "待补全" : prices.toString();
    }

    private void appendPrice(StringBuilder output, String label, JSONObject row, String key) {
        if (!row.has(key) || row.isNull(key)) return;
        double value = row.optDouble(key, Double.NaN);
        if (!Double.isFinite(value)) return;
        if (output.length() > 0) output.append(" / ");
        output.append(label).append(" ¥").append(String.format(Locale.ROOT, "%.4f", value).replaceAll("0+$", "").replaceAll("\\.$", ""));
    }

    private int parseInt(String text, int fallback) {
        try {
            return Integer.parseInt(text.trim());
        } catch (Exception ignored) {
            return fallback;
        }
    }

    private void registerSettingsWatchers() {
        TextWatcher watcher = new TextWatcher() {
            @Override
            public void beforeTextChanged(CharSequence s, int start, int count, int after) {
            }

            @Override
            public void onTextChanged(CharSequence s, int start, int before, int count) {
                markSettingsDirty();
            }

            @Override
            public void afterTextChanged(Editable s) {
            }
        };
        serverUrlInput.addTextChangedListener(watcher);
        tokenInput.addTextChangedListener(watcher);
        edgeEnrollmentInput.addTextChangedListener(watcher);
        cityInput.addTextChangedListener(watcher);
        minIntervalInput.addTextChangedListener(watcher);
        maxIntervalInput.addTextChangedListener(watcher);
        maxPagesInput.addTextChangedListener(watcher);
    }

    private void markSettingsDirty() {
        if (loadingSettings) {
            return;
        }
        hasUnsavedChanges = true;
        refreshStatus();
    }

    private boolean ensureSettingsConfirmed() {
        if (hasUnsavedChanges) {
            Toast.makeText(this, "有未保存修改，请先保存配置", Toast.LENGTH_LONG).show();
            return false;
        }
        if (looksLikeSshEndpoint(serverUrlInput.getText().toString())) {
            Toast.makeText(this, "同步地址应填写 HTTP 地址", Toast.LENGTH_LONG).show();
            return false;
        }
        return true;
    }

    private boolean looksLikeSshEndpoint(String rawValue) {
        String value = rawValue == null ? "" : rawValue.trim().toLowerCase(Locale.ROOT);
        return value.startsWith("ssh://")
                || value.matches("^(https?://)?[^/]+:22(/.*)?$")
                || value.matches("^[^@\\s]+@[^/\\s]+(:22)?$");
    }

    private boolean isServiceRunning(Class<?> serviceClass) {
        ActivityManager manager = (ActivityManager) getSystemService(ACTIVITY_SERVICE);
        if (manager == null) {
            return false;
        }
        for (ActivityManager.RunningServiceInfo service : manager.getRunningServices(Integer.MAX_VALUE)) {
            if (serviceClass.getName().equals(service.service.getClassName())) {
                return true;
            }
        }
        return false;
    }

    private LinearLayout card() {
        LinearLayout view = vertical();
        view.setPadding(dp(18), dp(18), dp(18), dp(18));
        view.setBackground(makeSolid(Color.WHITE, dp(24), Color.TRANSPARENT));
        LinearLayout.LayoutParams params = blockParams();
        params.setMargins(0, 0, 0, dp(14));
        view.setLayoutParams(params);
        view.setElevation(dp(2));
        return view;
    }

    private TextView sectionTitle(String value) {
        TextView view = text(value, 18, Color.rgb(22, 31, 54), true);
        view.setPadding(0, 0, 0, dp(8));
        return view;
    }

    private TextView text(String value, int sp, int color, boolean bold) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(sp);
        view.setTextColor(color);
        view.setLineSpacing(dp(2), 1.0f);
        if (bold) {
            view.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        }
        return view;
    }

    private Button primaryButton(String text) {
        Button button = new Button(this);
        button.setText(text);
        button.setAllCaps(false);
        button.setTextSize(16);
        button.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        button.setMinHeight(dp(52));
        button.setTextColor(Color.WHITE);
        applyButtonStyle(button, Color.rgb(255, 106, 26), Color.WHITE);
        LinearLayout.LayoutParams params = blockParams();
        params.setMargins(0, dp(12), 0, 0);
        button.setLayoutParams(params);
        return button;
    }

    private Button secondaryButton(String text) {
        Button button = new Button(this);
        button.setText(text);
        button.setAllCaps(false);
        button.setTextSize(15);
        button.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        button.setMinHeight(dp(50));
        applyButtonStyle(button, Color.rgb(248, 250, 252), Color.rgb(22, 31, 54));
        LinearLayout.LayoutParams params = blockParams();
        params.setMargins(0, dp(10), 0, 0);
        button.setLayoutParams(params);
        return button;
    }

    private void applyButtonStyle(Button button, int background, int textColor) {
        button.setTextColor(textColor);
        button.setBackground(makeSolid(background, dp(18), Color.TRANSPARENT));
    }

    private GradientDrawable makeSolid(int color, int radius, int strokeColor) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(color);
        drawable.setCornerRadius(radius);
        if (strokeColor != Color.TRANSPARENT) {
            drawable.setStroke(dp(1), strokeColor);
        }
        return drawable;
    }

    private GradientDrawable makeGradient(int start, int end, int radius, int strokeColor) {
        GradientDrawable drawable = new GradientDrawable(GradientDrawable.Orientation.TL_BR, new int[]{start, end});
        drawable.setCornerRadius(radius);
        if (strokeColor != Color.TRANSPARENT) {
            drawable.setStroke(dp(1), strokeColor);
        }
        return drawable;
    }

    private LinearLayout vertical() {
        LinearLayout view = new LinearLayout(this);
        view.setOrientation(LinearLayout.VERTICAL);
        return view;
    }

    private LinearLayout horizontal() {
        LinearLayout view = new LinearLayout(this);
        view.setOrientation(LinearLayout.HORIZONTAL);
        view.setGravity(Gravity.CENTER_VERTICAL);
        view.setBaselineAligned(false);
        return view;
    }

    private LinearLayout.LayoutParams blockParams() {
        return new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
        );
    }

    private LinearLayout.LayoutParams weightParams() {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                0,
                LinearLayout.LayoutParams.WRAP_CONTENT,
                1f
        );
        params.setMargins(0, 0, dp(8), 0);
        return params;
    }

    private String valueOrDefault(String value, String fallback) {
        return value == null || value.trim().isEmpty() ? fallback : value.trim();
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
