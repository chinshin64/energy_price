package com.datafordidi.mobilecollector;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.os.Bundle;
import android.graphics.Path;
import android.graphics.Rect;
import android.util.Log;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

import java.util.ArrayList;
import java.util.List;
import java.lang.ref.WeakReference;

public class AutoScrollAccessibilityService extends AccessibilityService {
    private static final String TAG = "DataForDidiA11y";
    private static WeakReference<AutoScrollAccessibilityService> currentService = new WeakReference<>(null);
    private static volatile String currentPackageName = "";
    private static volatile String currentClassName = "";

    public static boolean isReady() {
        return currentService.get() != null;
    }

    public static boolean requestScrollForward() {
        AutoScrollAccessibilityService service = currentService.get();
        if (service == null) {
            return false;
        }
        return service.scrollForward();
    }

    public static boolean requestBack() {
        AutoScrollAccessibilityService service = currentService.get();
        if (service == null) {
            return false;
        }
        return service.performGlobalAction(GLOBAL_ACTION_BACK);
    }

    public static boolean requestTap(float xRatio, float yRatio) {
        AutoScrollAccessibilityService service = currentService.get();
        if (service == null) {
            return false;
        }
        return service.tapByRatio(xRatio, yRatio);
    }

    public static boolean requestSetFocusedText(String text) {
        AutoScrollAccessibilityService service = currentService.get();
        if (service == null) {
            return false;
        }
        return service.setFocusedText(text);
    }

    public static boolean requestPasteFocusedText(String text) {
        AutoScrollAccessibilityService service = currentService.get();
        if (service == null) {
            return false;
        }
        return service.pasteFocusedText(text);
    }

    public static boolean requestClickText(String text, boolean contains) {
        AutoScrollAccessibilityService service = currentService.get();
        if (service == null) {
            return false;
        }
        return service.clickText(text, contains);
    }

    /**
     * 查找屏幕上的 EditText 并点击（用于高德搜索框）
     */
    public static boolean requestClickEditText() {
        AutoScrollAccessibilityService service = currentService.get();
        if (service == null) {
            return false;
        }
        return service.clickEditText();
    }

    public static List<OcrRow> collectVisibleTextRows() {
        AutoScrollAccessibilityService service = currentService.get();
        if (service == null) {
            return new ArrayList<>();
        }
        return service.collectTextRows();
    }

    /**
     * 使用 AccessibilityService.takeScreenshot 截图并返回 Base64 JPEG
     * 需要 Android 11+ (API 30+)
     */
    public static String takeScreenshotBase64(int quality) {
        AutoScrollAccessibilityService service = currentService.get();
        if (service == null) {
            return null;
        }
        return ScreenshotHelper.captureAsBase64(service, quality);
    }

    public static String getCurrentPackageName() {
        return currentPackageName;
    }

    public static String getCurrentClassName() {
        return currentClassName;
    }

    @Override
    protected void onServiceConnected() {
        currentService = new WeakReference<>(this);
    }

    @Override
    public void onDestroy() {
        currentService.clear();
        super.onDestroy();
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        if (event != null) {
            CharSequence packageName = event.getPackageName();
            CharSequence className = event.getClassName();
            if (packageName != null) {
                currentPackageName = packageName.toString();
            }
            if (className != null) {
                currentClassName = className.toString();
            }
        }
        // 滚动由采集服务或网络命令服务按节奏触发，这里只保持服务状态和页面上下文。
    }

    @Override
    public void onInterrupt() {
    }

    private boolean scrollForward() {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        // WeChat mini-program pages often report ACTION_SCROLL_FORWARD success
        // without moving the canvas list. Prefer a real gesture and keep the
        // accessibility action only as a fallback.
        if (swipeUp()) {
            return true;
        }
        return root != null && scrollNode(root);
    }

    private boolean scrollNode(AccessibilityNodeInfo node) {
        if (node == null) {
            return false;
        }

        if (node.isScrollable() && node.performAction(AccessibilityNodeInfo.ACTION_SCROLL_FORWARD)) {
            return true;
        }

        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            try {
                if (scrollNode(child)) {
                    return true;
                }
            } finally {
                if (child != null) {
                    child.recycle();
                }
            }
        }

        return false;
    }

    private List<OcrRow> collectTextRows() {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        List<OcrRow> rows = new ArrayList<>();
        if (root == null) {
            return rows;
        }

        Rect rootBounds = new Rect();
        root.getBoundsInScreen(rootBounds);
        int width = Math.max(1, rootBounds.width());
        int height = Math.max(1, rootBounds.height());
        collectTextRows(root, rootBounds.left, rootBounds.top, width, height, rows);
        return rows;
    }

    private void collectTextRows(
            AccessibilityNodeInfo node,
            int rootLeft,
            int rootTop,
            int rootWidth,
            int rootHeight,
            List<OcrRow> rows
    ) {
        if (node == null) {
            return;
        }

        CharSequence text = node.getText();
        if (text == null || text.toString().trim().isEmpty()) {
            text = node.getContentDescription();
        }

        if (text != null && !text.toString().trim().isEmpty()) {
            Rect bounds = new Rect();
            node.getBoundsInScreen(bounds);
            if (bounds.width() > 0 && bounds.height() > 0) {
                rows.add(new OcrRow(
                        text.toString(),
                        1f,
                        (bounds.left - rootLeft) / (float) rootWidth,
                        (bounds.top - rootTop) / (float) rootHeight,
                        bounds.width() / (float) rootWidth,
                        bounds.height() / (float) rootHeight
                ));
            }
        }

        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            try {
                collectTextRows(child, rootLeft, rootTop, rootWidth, rootHeight, rows);
            } finally {
                if (child != null) {
                    child.recycle();
                }
            }
        }
    }

    private boolean swipeUp() {
        Rect bounds = new Rect();
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root != null) {
            root.getBoundsInScreen(bounds);
        }

        int width = Math.max(1, bounds.width());
        int height = Math.max(1, bounds.height());
        int startX = bounds.left + width / 2;
        // startY 下移到 0.62f 避免顶部返回手势触发退出小程序
        int startY = bounds.top + Math.round(height * 0.62f);
        int endY = bounds.top + Math.round(height * 0.28f);

        Path path = new Path();
        path.moveTo(startX, startY);
        path.lineTo(startX, endY);
        GestureDescription gesture = new GestureDescription.Builder()
                .addStroke(new GestureDescription.StrokeDescription(path, 0, 560))
                .build();

        return dispatchGesture(gesture, null, null);
    }

    private boolean tapByRatio(float xRatio, float yRatio) {
        Rect bounds = new Rect();
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root != null) {
            root.getBoundsInScreen(bounds);
        }

        int width = Math.max(1, bounds.width());
        int height = Math.max(1, bounds.height());
        float safeX = Math.max(0.05f, Math.min(0.95f, xRatio));
        float safeY = Math.max(0.08f, Math.min(0.92f, yRatio));
        int x = bounds.left + Math.round(width * safeX);
        int y = bounds.top + Math.round(height * safeY);

        Path path = new Path();
        path.moveTo(x, y);
        GestureDescription gesture = new GestureDescription.Builder()
                .addStroke(new GestureDescription.StrokeDescription(path, 0, 80))
                .build();

        return dispatchGesture(gesture, null, null);
    }

    private boolean setFocusedText(String text) {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        AccessibilityNodeInfo target = findFocusedEditable(root);
        if (target == null) {
            target = findFirstEditable(root);
        }
        if (target == null) {
            return false;
        }

        Bundle arguments = new Bundle();
        arguments.putCharSequence(
                AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE,
                text == null ? "" : text
        );
        try {
            return target.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, arguments);
        } finally {
            target.recycle();
        }
    }

    private boolean pasteFocusedText(String text) {
        ClipboardManager clipboard = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
        if (clipboard == null) {
            return false;
        }
        clipboard.setPrimaryClip(ClipData.newPlainText("data_for_didi", text == null ? "" : text));

        AccessibilityNodeInfo root = getRootInActiveWindow();
        AccessibilityNodeInfo target = findFocusedEditable(root);
        if (target == null) {
            target = findFirstEditable(root);
        }
        if (target == null) {
            return false;
        }

        try {
            target.performAction(AccessibilityNodeInfo.ACTION_FOCUS);
            return target.performAction(AccessibilityNodeInfo.ACTION_PASTE);
        } finally {
            target.recycle();
        }
    }

    private AccessibilityNodeInfo findFocusedEditable(AccessibilityNodeInfo root) {
        if (root == null) {
            return null;
        }
        AccessibilityNodeInfo focused = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
        if (isEditable(focused)) {
            return focused;
        }
        if (focused != null) {
            focused.recycle();
        }
        return null;
    }

    private AccessibilityNodeInfo findFirstEditable(AccessibilityNodeInfo node) {
        if (node == null) {
            return null;
        }
        if (isEditable(node)) {
            return AccessibilityNodeInfo.obtain(node);
        }
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            try {
                AccessibilityNodeInfo found = findFirstEditable(child);
                if (found != null) {
                    return found;
                }
            } finally {
                if (child != null) {
                    child.recycle();
                }
            }
        }
        return null;
    }

    private boolean isEditable(AccessibilityNodeInfo node) {
        if (node == null) {
            return false;
        }
        return node.isEditable()
                || "android.widget.EditText".contentEquals(node.getClassName());
    }

    private boolean clickText(String text, boolean contains) {
        if (text == null || text.trim().isEmpty()) {
            return false;
        }
        AccessibilityNodeInfo root = getRootInActiveWindow();
        AccessibilityNodeInfo node = findTextNode(root, text.trim(), contains);
        if (node == null) {
            return false;
        }
        try {
            if (node.isClickable() && node.performAction(AccessibilityNodeInfo.ACTION_CLICK)) {
                return true;
            }
            Rect bounds = new Rect();
            node.getBoundsInScreen(bounds);
            if (bounds.width() <= 0 || bounds.height() <= 0) {
                return false;
            }
            return tapAbsolute(bounds.centerX(), bounds.centerY());
        } finally {
            node.recycle();
        }
    }

    private AccessibilityNodeInfo findTextNode(AccessibilityNodeInfo node, String expected, boolean contains) {
        if (node == null) {
            return null;
        }
        CharSequence text = node.getText();
        if (text == null || text.toString().trim().isEmpty()) {
            text = node.getContentDescription();
        }
        if (text != null) {
            String value = text.toString().replaceAll("\\s+", "");
            String needle = expected.replaceAll("\\s+", "");
            if ((contains && value.contains(needle)) || (!contains && value.equals(needle))) {
                return AccessibilityNodeInfo.obtain(node);
            }
        }
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            try {
                AccessibilityNodeInfo found = findTextNode(child, expected, contains);
                if (found != null) {
                    return found;
                }
            } finally {
                if (child != null) {
                    child.recycle();
                }
            }
        }
        return null;
    }

    /**
     * 查找屏幕上的 EditText 节点并点击
     */
    private boolean clickEditText() {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) return false;
        AccessibilityNodeInfo found = findEditTextNode(root);
        if (found == null) return false;
        try {
            if (found.isClickable() && found.performAction(AccessibilityNodeInfo.ACTION_CLICK)) {
                return true;
            }
            Rect bounds = new Rect();
            found.getBoundsInScreen(bounds);
            if (bounds.width() <= 0 || bounds.height() <= 0) return false;
            return tapAbsolute(bounds.centerX(), bounds.centerY());
        } finally {
            found.recycle();
        }
    }

    private AccessibilityNodeInfo findEditTextNode(AccessibilityNodeInfo node) {
        if (node == null) return null;
        if (node.getClassName() != null && node.getClassName().toString().contains("EditText")) {
            return AccessibilityNodeInfo.obtain(node);
        }
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            try {
                AccessibilityNodeInfo found = findEditTextNode(child);
                if (found != null) return found;
            } finally {
                if (child != null) child.recycle();
            }
        }
        return null;
    }

    private boolean tapAbsolute(int x, int y) {
        Path path = new Path();
        path.moveTo(x, y);
        GestureDescription gesture = new GestureDescription.Builder()
                .addStroke(new GestureDescription.StrokeDescription(path, 0, 80))
                .build();
        return dispatchGesture(gesture, null, null);
    }
}
