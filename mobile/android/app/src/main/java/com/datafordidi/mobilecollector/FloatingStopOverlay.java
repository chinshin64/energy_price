package com.datafordidi.mobilecollector;

import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

public class FloatingStopOverlay {
    private final Service service;
    private final WindowManager windowManager;
    private View overlayView;
    private WindowManager.LayoutParams params;
    private boolean paused = false;

    public FloatingStopOverlay(Service service) {
        this.service = service;
        this.windowManager = (WindowManager) service.getSystemService(Context.WINDOW_SERVICE);
    }

    public static boolean canDrawOverlays(Context context) {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.M || Settings.canDrawOverlays(context);
    }

    public static Intent buildOverlayPermissionIntent(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
            return new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                    .setData(Uri.parse("package:" + context.getPackageName()));
        }
        return new Intent(
                Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                Uri.parse("package:" + context.getPackageName())
        );
    }

    public boolean show(String label) {
        if (!canDrawOverlays(service)) {
            Toast.makeText(service, "未开启悬浮窗权限，无法显示窗口化控制按钮", Toast.LENGTH_LONG).show();
            return false;
        }
        if (overlayView != null) {
            return true;
        }

        LinearLayout panel = new LinearLayout(service);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setPadding(14, 12, 14, 12);

        GradientDrawable background = new GradientDrawable();
        background.setColor(Color.rgb(34, 43, 62));
        background.setCornerRadius(32);
        panel.setBackground(background);
        panel.setElevation(16);

        TextView title = new TextView(service);
        title.setText(label == null || label.trim().isEmpty() ? "采集中" : label.trim());
        title.setTextColor(Color.WHITE);
        title.setTextSize(12);
        title.setGravity(Gravity.CENTER);
        title.setPadding(12, 0, 12, 8);
        title.setOnTouchListener(new DragControlTouchListener());
        panel.addView(title);

        LinearLayout actions = new LinearLayout(service);
        actions.setOrientation(LinearLayout.HORIZONTAL);

        TextView pauseButton = createActionButton("暂停", Color.rgb(245, 138, 30));
        pauseButton.setOnClickListener(v -> {
            paused = !paused;
            pauseButton.setText(paused ? "继续" : "暂停");
            sendControlAction(paused ? CollectorControlActions.ACTION_PAUSE : CollectorControlActions.ACTION_RESUME);
        });
        actions.addView(pauseButton);

        TextView restartButton = createActionButton("重启", Color.rgb(46, 125, 246));
        restartButton.setOnClickListener(v -> {
            paused = false;
            pauseButton.setText("暂停");
            sendControlAction(CollectorControlActions.ACTION_RESTART);
        });
        actions.addView(restartButton);

        TextView stopButton = createActionButton("停止", Color.rgb(230, 72, 24));
        stopButton.setOnClickListener(v -> stopAllCollectors());
        actions.addView(stopButton);

        panel.addView(actions);
        panel.setOnTouchListener(new DragControlTouchListener());

        int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                : WindowManager.LayoutParams.TYPE_PHONE;
        params = new WindowManager.LayoutParams(
                WindowManager.LayoutParams.WRAP_CONTENT,
                WindowManager.LayoutParams.WRAP_CONTENT,
                type,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
                        | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                PixelFormat.TRANSLUCENT
        );
        params.gravity = Gravity.TOP | Gravity.END;
        params.x = 32;
        params.y = 260;

        overlayView = panel;
        windowManager.addView(overlayView, params);
        return true;
    }

    public void hide() {
        if (overlayView == null) {
            return;
        }
        try {
            windowManager.removeView(overlayView);
        } catch (Exception ignored) {
            // The service may already be stopping; removing twice is safe to ignore.
        } finally {
            overlayView = null;
        }
    }

    private void stopAllCollectors() {
        hide();
        sendControlAction(CollectorControlActions.ACTION_STOP);
        service.stopService(new Intent(service, CaptureOcrService.class));
        service.stopService(new Intent(service, AccessibilityTextCollectService.class));
        service.stopService(new Intent(service, NetworkCommandService.class));
        service.stopSelf();
    }

    private TextView createActionButton(String label, int color) {
        TextView button = new TextView(service);
        button.setText(label);
        button.setTextColor(Color.WHITE);
        button.setTextSize(13);
        button.setGravity(Gravity.CENTER);
        button.setPadding(18, 10, 18, 10);

        LinearLayout.LayoutParams layoutParams = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
        );
        layoutParams.setMargins(4, 0, 4, 0);
        button.setLayoutParams(layoutParams);

        GradientDrawable background = new GradientDrawable();
        background.setColor(color);
        background.setCornerRadius(24);
        button.setBackground(background);
        return button;
    }

    private void sendControlAction(String action) {
        Intent intent = new Intent(action);
        intent.setPackage(service.getPackageName());
        service.sendBroadcast(intent);
    }

    private class DragControlTouchListener implements View.OnTouchListener {
        private int startX;
        private int startY;
        private float touchStartX;
        private float touchStartY;

        @Override
        public boolean onTouch(View view, MotionEvent event) {
            switch (event.getAction()) {
                case MotionEvent.ACTION_DOWN:
                    startX = params.x;
                    startY = params.y;
                    touchStartX = event.getRawX();
                    touchStartY = event.getRawY();
                    return true;
                case MotionEvent.ACTION_MOVE:
                    params.x = Math.max(0, startX - Math.round(event.getRawX() - touchStartX));
                    params.y = Math.max(0, startY + Math.round(event.getRawY() - touchStartY));
                    windowManager.updateViewLayout(overlayView, params);
                    return true;
                case MotionEvent.ACTION_UP:
                    view.performClick();
                    return true;
                default:
                    return false;
            }
        }
    }
}
