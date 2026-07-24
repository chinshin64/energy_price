package com.datafordidi.mocklocation;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.AppOpsManager;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Insets;
import android.graphics.PointF;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Process;
import android.provider.Settings;
import android.text.InputType;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.inputmethod.EditorInfo;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import org.maplibre.android.MapLibre;
import org.maplibre.android.annotations.Marker;
import org.maplibre.android.annotations.MarkerOptions;
import org.maplibre.android.camera.CameraUpdateFactory;
import org.maplibre.android.geometry.LatLng;
import org.maplibre.android.maps.MapLibreMap;
import org.maplibre.android.maps.OnMapReadyCallback;
import org.maplibre.android.maps.Style;

public final class MainActivity extends Activity implements OnMapReadyCallback {
    private static final int REQUEST_LOCATION_PERMISSION = 1101;
    private static final int REQUEST_NOTIFICATION_PERMISSION = 1102;
    private static final float MARKER_TOUCH_RADIUS_DP = 42.0f;
    private static final float LOCATION_ACCURACY_METERS = 15.0f;

    private LocationStateStore stateStore;
    private MockLocationEngine locationEngine;
    private AccessibleMapView mapView;
    private MapLibreMap map;
    private Marker marker;
    private EditText latitudeInput;
    private EditText longitudeInput;
    private TextView permissionStatus;
    private TextView runtimeStatus;
    private TextView runtimeCoordinate;
    private Button applyButton;
    private GeoCoordinate selectedCoordinate;
    private boolean draggingMarker;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        stateStore = new LocationStateStore(this);
        locationEngine = new MockLocationEngine(this);
        selectedCoordinate = stateStore.selectedCoordinate();

        MapLibre.getInstance(this);
        setContentView(buildScreen(savedInstanceState));
        configureSystemBars();
        mapView.getMapAsync(this);
        updatePermissionState();
        updateRuntimeState();
    }

    @Override
    public void onMapReady(MapLibreMap readyMap) {
        map = readyMap;
        map.setMinZoomPreference(2.0d);
        map.setMaxZoomPreference(19.0d);
        map.getUiSettings().setCompassEnabled(true);
        map.getUiSettings().setLogoEnabled(false);
        map.getUiSettings().setAttributionEnabled(false);
        map.setStyle(new Style.Builder().fromUri(MapStyleFactory.defaultStyleUrl()), style -> {
            LatLng position = toLatLng(selectedCoordinate);
            marker = map.addMarker(new MarkerOptions().position(position));
            map.moveCamera(CameraUpdateFactory.newLatLngZoom(position, 13.0d));
        });
        map.addOnMapClickListener(point -> {
            updateSelection(new GeoCoordinate(point.getLatitude(), point.getLongitude()), false);
            return true;
        });
        installMarkerDragGesture();
    }

    private View buildScreen(Bundle savedInstanceState) {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(color(R.color.surface));
        applySystemInsets(root);

        root.addView(buildToolbar(), new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                dp(56)
        ));

        FrameLayout mapFrame = new FrameLayout(this);
        mapView = new AccessibleMapView(this);
        mapView.setId(R.id.location_map);
        mapView.onCreate(savedInstanceState);
        mapFrame.addView(mapView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
        ));
        mapFrame.addView(buildAttribution(), attributionLayoutParams());
        root.addView(mapFrame, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                0,
                1.0f
        ));

        root.addView(buildControlPanel(), new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        ));
        return root;
    }

    private View buildToolbar() {
        LinearLayout toolbar = new LinearLayout(this);
        toolbar.setOrientation(LinearLayout.HORIZONTAL);
        toolbar.setGravity(Gravity.CENTER_VERTICAL);
        toolbar.setPadding(dp(16), 0, dp(12), 0);
        toolbar.setBackgroundColor(color(R.color.surface));

        TextView title = textView(getString(R.string.screen_title), 20, R.color.text_primary);
        title.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        toolbar.addView(title, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1.0f));

        permissionStatus = textView("", 12, R.color.text_secondary);
        permissionStatus.setId(R.id.permission_status);
        permissionStatus.setGravity(Gravity.CENTER);
        permissionStatus.setMinHeight(dp(32));
        permissionStatus.setPadding(dp(10), 0, dp(10), 0);
        permissionStatus.setOnClickListener(view -> openDeveloperSettings());
        toolbar.addView(permissionStatus, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                dp(32)
        ));
        return toolbar;
    }

    private View buildAttribution() {
        TextView attribution = textView(getString(R.string.map_attribution), 10, R.color.text_secondary);
        attribution.setPadding(dp(6), dp(3), dp(6), dp(3));
        attribution.setBackground(roundedBackground(Color.argb(230, 255, 255, 255), 4, 0, Color.TRANSPARENT));
        attribution.setOnClickListener(view -> openExternalUrl("https://www.openstreetmap.org/copyright"));
        return attribution;
    }

    private FrameLayout.LayoutParams attributionLayoutParams() {
        FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.BOTTOM | Gravity.END
        );
        params.setMargins(dp(8), dp(8), dp(8), dp(8));
        return params;
    }

    private View buildControlPanel() {
        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setPadding(dp(16), dp(12), dp(16), dp(16));
        panel.setBackgroundColor(color(R.color.surface));

        TextView label = textView(getString(R.string.selected_coordinate), 13, R.color.text_secondary);
        label.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        panel.addView(label);

        LinearLayout coordinateRow = new LinearLayout(this);
        coordinateRow.setOrientation(LinearLayout.HORIZONTAL);
        coordinateRow.setPadding(0, dp(4), 0, 0);
        latitudeInput = coordinateInput(R.string.latitude, selectedCoordinate.latitudeText());
        longitudeInput = coordinateInput(R.string.longitude, selectedCoordinate.longitudeText());
        latitudeInput.setId(R.id.latitude_input);
        longitudeInput.setId(R.id.longitude_input);
        panel.addView(buildCoordinateLabels());
        coordinateRow.addView(latitudeInput, weightedFieldParams(0));
        coordinateRow.addView(longitudeInput, weightedFieldParams(dp(8)));
        panel.addView(coordinateRow);

        LinearLayout statusRow = new LinearLayout(this);
        statusRow.setOrientation(LinearLayout.HORIZONTAL);
        statusRow.setGravity(Gravity.CENTER_VERTICAL);
        statusRow.setPadding(0, dp(10), 0, dp(10));
        runtimeStatus = textView("", 13, R.color.text_secondary);
        runtimeStatus.setId(R.id.runtime_status);
        runtimeStatus.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        runtimeCoordinate = textView("", 12, R.color.text_secondary);
        runtimeCoordinate.setGravity(Gravity.END);
        statusRow.addView(runtimeStatus, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1.0f));
        statusRow.addView(runtimeCoordinate, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        ));
        panel.addView(statusRow);

        applyButton = button(getString(R.string.apply_location), R.color.surface, R.color.brand, true);
        applyButton.setId(R.id.apply_location);
        applyButton.setOnClickListener(view -> applyLocation());
        panel.addView(applyButton, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                dp(48)
        ));

        LinearLayout actionRow = new LinearLayout(this);
        actionRow.setOrientation(LinearLayout.HORIZONTAL);
        actionRow.setPadding(0, dp(8), 0, 0);
        Button stopButton = button(getString(R.string.stop_location), R.color.danger, R.color.surface, false);
        stopButton.setId(R.id.stop_location);
        stopButton.setOnClickListener(view -> stopLocation());
        Button wechatButton = button(getString(R.string.open_wechat), R.color.text_primary, R.color.surface_muted, false);
        wechatButton.setId(R.id.open_wechat);
        wechatButton.setOnClickListener(view -> openWechat());
        actionRow.addView(stopButton, weightedButtonParams(0));
        actionRow.addView(wechatButton, weightedButtonParams(dp(8)));
        panel.addView(actionRow);
        return panel;
    }

    private View buildCoordinateLabels() {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setPadding(0, dp(6), 0, 0);
        TextView latitudeLabel = textView(getString(R.string.latitude), 11, R.color.text_secondary);
        TextView longitudeLabel = textView(getString(R.string.longitude), 11, R.color.text_secondary);
        row.addView(latitudeLabel, weightedLabelParams(0));
        row.addView(longitudeLabel, weightedLabelParams(dp(8)));
        return row;
    }

    private EditText coordinateInput(int hintRes, String value) {
        EditText input = new EditText(this);
        input.setText(value);
        input.setHint(hintRes);
        input.setSingleLine(true);
        input.setTextSize(16);
        input.setTextColor(color(R.color.text_primary));
        input.setHintTextColor(color(R.color.text_secondary));
        input.setSelectAllOnFocus(true);
        input.setPadding(dp(12), 0, dp(12), 0);
        input.setInputType(InputType.TYPE_CLASS_NUMBER
                | InputType.TYPE_NUMBER_FLAG_DECIMAL
                | InputType.TYPE_NUMBER_FLAG_SIGNED);
        input.setImeOptions(EditorInfo.IME_ACTION_DONE);
        input.setBackground(roundedBackground(
                color(R.color.surface_muted),
                8,
                1,
                color(R.color.border)
        ));
        input.setOnEditorActionListener((view, actionId, event) -> {
            if (actionId == EditorInfo.IME_ACTION_DONE) {
                previewInputCoordinate();
                view.clearFocus();
                return true;
            }
            return false;
        });
        return input;
    }

    private void previewInputCoordinate() {
        try {
            updateSelection(parseInputs(), true);
        } catch (IllegalArgumentException error) {
            showCoordinateError();
        }
    }

    private void applyLocation() {
        final GeoCoordinate coordinate;
        try {
            coordinate = parseInputs();
            updateSelection(coordinate, true);
        } catch (IllegalArgumentException error) {
            showCoordinateError();
            return;
        }

        if (!hasMockLocationAppOp()) {
            showMockPermissionDialog();
            return;
        }
        if (!hasFineLocationPermission()) {
            requestPermissions(
                    new String[]{Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION},
                    REQUEST_LOCATION_PERMISSION
            );
            return;
        }

        try {
            locationEngine.apply(coordinate, LOCATION_ACCURACY_METERS);
            stateStore.saveSelection(coordinate);
            stateStore.setActive(true);
            Intent serviceIntent = MockLocationService.startIntent(this, coordinate);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(serviceIntent);
            } else {
                startService(serviceIntent);
            }
            runtimeStatus.setText(R.string.status_active);
            runtimeStatus.setTextColor(color(R.color.success));
            runtimeCoordinate.setText(formatCoordinate(coordinate));
            applyButton.setText(R.string.apply_location);
            requestNotificationPermissionIfNeeded();
        } catch (RuntimeException error) {
            stateStore.setActive(false);
            runtimeStatus.setText(R.string.status_error);
            runtimeStatus.setTextColor(color(R.color.danger));
            runtimeCoordinate.setText(plainError(error));
            updatePermissionState();
        }
    }

    private void stopLocation() {
        try {
            locationEngine.stop();
            stopService(MockLocationService.stopIntent(this));
        } finally {
            stateStore.setActive(false);
            updateRuntimeState();
        }
    }

    private void openWechat() {
        Intent launch = getPackageManager().getLaunchIntentForPackage("com.tencent.mm");
        if (launch == null) {
            Toast.makeText(this, R.string.wechat_not_installed, Toast.LENGTH_SHORT).show();
            return;
        }
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        startActivity(launch);
    }

    private void updateSelection(GeoCoordinate coordinate, boolean moveCamera) {
        selectedCoordinate = coordinate;
        stateStore.saveSelection(coordinate);
        latitudeInput.setText(coordinate.latitudeText());
        longitudeInput.setText(coordinate.longitudeText());
        LatLng position = toLatLng(coordinate);
        if (marker != null) {
            marker.setPosition(position);
        }
        if (moveCamera && map != null) {
            map.animateCamera(CameraUpdateFactory.newLatLngZoom(position, Math.max(13.0d, map.getCameraPosition().zoom)));
        }
    }

    private GeoCoordinate parseInputs() {
        return CoordinateValidator.parse(
                latitudeInput.getText().toString(),
                longitudeInput.getText().toString()
        );
    }

    private void installMarkerDragGesture() {
        mapView.setOnTouchListener((view, event) -> {
            if (map == null || marker == null) {
                return false;
            }
            if (event.getActionMasked() == MotionEvent.ACTION_DOWN) {
                PointF markerPoint = map.getProjection().toScreenLocation(marker.getPosition());
                float deltaX = event.getX() - markerPoint.x;
                float deltaY = event.getY() - markerPoint.y;
                draggingMarker = Math.hypot(deltaX, deltaY) <= dp(MARKER_TOUCH_RADIUS_DP);
                if (draggingMarker) {
                    view.getParent().requestDisallowInterceptTouchEvent(true);
                    return true;
                }
                return false;
            }
            if (!draggingMarker) {
                return false;
            }
            if (event.getActionMasked() == MotionEvent.ACTION_MOVE
                    || event.getActionMasked() == MotionEvent.ACTION_UP) {
                LatLng position = map.getProjection().fromScreenLocation(new PointF(event.getX(), event.getY()));
                updateSelection(new GeoCoordinate(position.getLatitude(), position.getLongitude()), false);
            }
            if (event.getActionMasked() == MotionEvent.ACTION_UP
                    || event.getActionMasked() == MotionEvent.ACTION_CANCEL) {
                if (event.getActionMasked() == MotionEvent.ACTION_UP) {
                    view.performClick();
                }
                draggingMarker = false;
                view.getParent().requestDisallowInterceptTouchEvent(false);
            }
            return true;
        });
    }

    private boolean hasMockLocationAppOp() {
        AppOpsManager appOps = (AppOpsManager) getSystemService(Context.APP_OPS_SERVICE);
        int mode;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            mode = appOps.unsafeCheckOpNoThrow(
                    AppOpsManager.OPSTR_MOCK_LOCATION,
                    Process.myUid(),
                    getPackageName()
            );
        } else {
            mode = appOps.checkOpNoThrow(
                    AppOpsManager.OPSTR_MOCK_LOCATION,
                    Process.myUid(),
                    getPackageName()
            );
        }
        return mode == AppOpsManager.MODE_ALLOWED;
    }

    private boolean hasFineLocationPermission() {
        return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    private void updatePermissionState() {
        boolean ready = hasMockLocationAppOp();
        int statusColor = color(ready ? R.color.success : R.color.danger);
        permissionStatus.setText(ready ? R.string.permission_ready : R.string.permission_required);
        permissionStatus.setTextColor(statusColor);
        permissionStatus.setBackground(roundedBackground(
                Color.argb(
                        18,
                        Color.red(statusColor),
                        Color.green(statusColor),
                        Color.blue(statusColor)
                ),
                8,
                1,
                statusColor
        ));
    }

    private void updateRuntimeState() {
        boolean active = stateStore.isActive() && hasMockLocationAppOp();
        runtimeStatus.setText(active ? R.string.status_active : R.string.status_idle);
        runtimeStatus.setTextColor(color(active ? R.color.success : R.color.text_secondary));
        runtimeCoordinate.setText(active
                ? formatCoordinate(selectedCoordinate)
                : "");
        applyButton.setText(R.string.apply_location);
    }

    private void showMockPermissionDialog() {
        new AlertDialog.Builder(this)
                .setTitle(R.string.permission_required)
                .setMessage(R.string.mock_permission_message)
                .setNegativeButton(android.R.string.cancel, null)
                .setPositiveButton(R.string.open_developer_settings, (dialog, which) -> openDeveloperSettings())
                .show();
    }

    private void openDeveloperSettings() {
        try {
            startActivity(new Intent(Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS));
        } catch (ActivityNotFoundException error) {
            startActivity(new Intent(Settings.ACTION_SETTINGS));
        }
    }

    private void requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQUEST_NOTIFICATION_PERMISSION);
        }
    }

    private void showCoordinateError() {
        runtimeStatus.setText(R.string.invalid_coordinate);
        runtimeStatus.setTextColor(color(R.color.danger));
        runtimeCoordinate.setText("");
    }

    private String plainError(RuntimeException error) {
        String message = error.getMessage();
        if (message == null || message.trim().isEmpty()) {
            return error.getClass().getSimpleName();
        }
        return message.length() > 90 ? message.substring(0, 90) : message;
    }

    private void openExternalUrl(String url) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        } catch (ActivityNotFoundException ignored) {
            // Attribution remains visible even when no browser is installed.
        }
    }

    private void configureSystemBars() {
        Window window = getWindow();
        window.setStatusBarColor(color(R.color.surface));
        window.setNavigationBarColor(color(R.color.surface));
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            WindowInsetsController controller = window.getInsetsController();
            if (controller != null) {
                controller.setSystemBarsAppearance(
                        WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                                | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS,
                        WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                                | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
                );
            }
        } else {
            window.getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);
        }
    }

    private void applySystemInsets(View root) {
        root.setOnApplyWindowInsetsListener((view, windowInsets) -> {
            int top;
            int bottom;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                Insets bars = windowInsets.getInsets(WindowInsets.Type.systemBars());
                top = bars.top;
                bottom = bars.bottom;
            } else {
                top = windowInsets.getSystemWindowInsetTop();
                bottom = windowInsets.getSystemWindowInsetBottom();
            }
            view.setPadding(0, top, 0, bottom);
            return windowInsets;
        });
        root.post(root::requestApplyInsets);
    }

    private TextView textView(String text, int textSizeSp, int colorRes) {
        TextView view = new TextView(this);
        view.setText(text);
        view.setTextSize(textSizeSp);
        view.setTextColor(color(colorRes));
        view.setGravity(Gravity.CENTER_VERTICAL);
        view.setIncludeFontPadding(false);
        return view;
    }

    private Button button(String text, int textColorRes, int backgroundColorRes, boolean bold) {
        Button button = new Button(this);
        button.setText(text);
        button.setTextSize(14);
        button.setTextColor(color(textColorRes));
        button.setAllCaps(false);
        button.setGravity(Gravity.CENTER);
        button.setMinHeight(0);
        button.setMinWidth(0);
        button.setPadding(dp(10), 0, dp(10), 0);
        button.setTypeface(Typeface.DEFAULT, bold ? Typeface.BOLD : Typeface.NORMAL);
        button.setBackgroundTintList(null);
        button.setStateListAnimator(null);
        button.setBackground(roundedBackground(
                color(backgroundColorRes),
                8,
                backgroundColorRes == R.color.surface ? 1 : 0,
                color(R.color.border)
        ));
        return button;
    }

    private LinearLayout.LayoutParams weightedFieldParams(int startMargin) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0, dp(48), 1.0f);
        params.setMarginStart(startMargin);
        return params;
    }

    private LinearLayout.LayoutParams weightedLabelParams(int startMargin) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0, dp(18), 1.0f);
        params.setMarginStart(startMargin);
        return params;
    }

    private LinearLayout.LayoutParams weightedButtonParams(int startMargin) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0, dp(44), 1.0f);
        params.setMarginStart(startMargin);
        return params;
    }

    private GradientDrawable roundedBackground(int fillColor, int radiusDp, int strokeWidthDp, int strokeColor) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(fillColor);
        drawable.setCornerRadius(dp(radiusDp));
        if (strokeWidthDp > 0) {
            drawable.setStroke(dp(strokeWidthDp), strokeColor);
        }
        return drawable;
    }

    private int color(int colorRes) {
        return getColor(colorRes);
    }

    private int dp(float value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private static LatLng toLatLng(GeoCoordinate coordinate) {
        return new LatLng(coordinate.latitude(), coordinate.longitude());
    }

    private String formatCoordinate(GeoCoordinate coordinate) {
        return getString(
                R.string.coordinate_pair,
                coordinate.latitudeText(),
                coordinate.longitudeText()
        );
    }

    @Override
    protected void onStart() {
        super.onStart();
        mapView.onStart();
    }

    @Override
    protected void onResume() {
        super.onResume();
        mapView.onResume();
        updatePermissionState();
        updateRuntimeState();
    }

    @Override
    protected void onPause() {
        mapView.onPause();
        super.onPause();
    }

    @Override
    protected void onStop() {
        mapView.onStop();
        super.onStop();
    }

    @Override
    public void onLowMemory() {
        super.onLowMemory();
        mapView.onLowMemory();
    }

    @Override
    protected void onDestroy() {
        mapView.onDestroy();
        super.onDestroy();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        mapView.onSaveInstanceState(outState);
    }

    @Override
    public void onRequestPermissionsResult(
            int requestCode,
            String[] permissions,
            int[] grantResults
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQUEST_LOCATION_PERMISSION) {
            if (hasFineLocationPermission()) {
                applyLocation();
            } else {
                new AlertDialog.Builder(this)
                        .setMessage(R.string.location_permission_message)
                        .setPositiveButton(android.R.string.ok, null)
                        .show();
            }
        }
    }
}
