package com.datafordidi.mobilecollector;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.AccessibilityServiceInfo;
import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityManager;
import android.view.accessibility.AccessibilityNodeInfo;

import java.util.List;

public final class AutoScrollAccessibilityService extends AccessibilityService {
    interface ScrollCallback {
        void onResult(boolean scrolled, String reason);
    }

    private static volatile AutoScrollAccessibilityService instance;
    private static volatile String foregroundPackage = "";
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();
        instance = this;
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        if (event == null || event.getPackageName() == null) return;
        foregroundPackage = event.getPackageName().toString();
    }

    @Override
    public void onInterrupt() {
        // No continuous gesture or input operation needs interruption handling.
    }

    @Override
    public void onDestroy() {
        if (instance == this) instance = null;
        super.onDestroy();
    }

    static boolean isEnabled(Context context) {
        AccessibilityManager manager = (AccessibilityManager) context.getSystemService(Context.ACCESSIBILITY_SERVICE);
        if (manager == null || !manager.isEnabled()) return false;
        List<AccessibilityServiceInfo> enabled = manager.getEnabledAccessibilityServiceList(
                AccessibilityServiceInfo.FEEDBACK_ALL_MASK
        );
        String expected = context.getPackageName() + "/" + AutoScrollAccessibilityService.class.getName();
        for (AccessibilityServiceInfo info : enabled) {
            if (info.getResolveInfo() == null || info.getResolveInfo().serviceInfo == null) continue;
            String actual = info.getResolveInfo().serviceInfo.packageName
                    + "/" + info.getResolveInfo().serviceInfo.name;
            if (expected.equals(actual)) return true;
        }
        return false;
    }

    static String currentPackage() {
        AutoScrollAccessibilityService service = instance;
        if (service == null) return compact(foregroundPackage);
        AccessibilityNodeInfo root = service.getRootInActiveWindow();
        if (root != null && root.getPackageName() != null) {
            foregroundPackage = root.getPackageName().toString();
        }
        return compact(foregroundPackage);
    }

    static void requestScroll(String expectedPackage, ScrollCallback callback) {
        AutoScrollAccessibilityService service = instance;
        if (service == null) {
            callback.onResult(false, "自动下滑未开启");
            return;
        }
        service.mainHandler.post(() -> service.performSafeScroll(expectedPackage, callback));
    }

    private void performSafeScroll(String expectedPackage, ScrollCallback callback) {
        String expected = compact(expectedPackage);
        AccessibilityNodeInfo root = getRootInActiveWindow();
        String actual = root == null || root.getPackageName() == null
                ? compact(foregroundPackage)
                : root.getPackageName().toString();
        foregroundPackage = actual;
        if (root == null || expected.isEmpty() || !expected.equals(actual)) {
            callback.onResult(false, "页面已切换");
            return;
        }
        if (!isAllowedTarget(actual)) {
            callback.onResult(false, "当前页面不可下滑");
            return;
        }
        AccessibilityNodeInfo scrollable = findScrollable(root);
        if (scrollable == null) {
            callback.onResult(false, "页面不可继续下滑");
            return;
        }
        boolean performed = scrollable.performAction(AccessibilityNodeInfo.ACTION_SCROLL_FORWARD);
        callback.onResult(performed, performed ? "正在下滑" : "页面不可继续下滑");
    }

    private AccessibilityNodeInfo findScrollable(AccessibilityNodeInfo node) {
        if (node == null) return null;
        if (node.isScrollable() && node.isVisibleToUser()
                && node.getActionList().contains(AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_FORWARD)) {
            return node;
        }
        for (int index = 0; index < node.getChildCount(); index++) {
            AccessibilityNodeInfo found = findScrollable(node.getChild(index));
            if (found != null) return found;
        }
        return null;
    }

    static boolean isAllowedTarget(String packageName) {
        String value = compact(packageName).toLowerCase(java.util.Locale.ROOT);
        if (value.isEmpty() || value.equals("com.datafordidi.ocruploader")) return false;
        return !value.startsWith("com.android.")
                && !value.startsWith("android")
                && !value.contains("launcher")
                && !value.contains("systemui")
                && !value.contains("permissioncontroller")
                && !value.contains("settings")
                && !value.contains("alipay")
                && !value.contains("unionpay")
                && !value.contains("payment")
                && !value.contains("wallet")
                && !value.contains("passport")
                && !value.contains("account")
                && !value.contains("auth");
    }

    private static String compact(String value) {
        return value == null ? "" : value.trim();
    }
}
