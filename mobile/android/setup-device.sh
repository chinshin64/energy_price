#!/bin/bash
# 手机采集环境一键初始化脚本
# 用法: ./setup-device.sh

set -e

PKG="com.datafordidi.mobilecollector"
MOCK_PKG="com.datafordidi.mocklocation"
A11Y_SERVICE="${PKG}/${PKG}.AutoScrollAccessibilityService"
DEVICE="${1:-}"

if [ -n "$DEVICE" ]; then
    ADB="adb -s $DEVICE"
else
    ADB="adb"
fi

echo "🔧 初始化手机采集环境 (设备: $($ADB shell getprop ro.product.model 2>/dev/null || echo 'default'))"

# 1. 无障碍服务
echo "📌 设置无障碍服务..."
$ADB shell settings put secure enabled_accessibility_services "$A11Y_SERVICE"
$ADB shell settings put secure accessibility_enabled 1
echo "  ✅ 无障碍服务已启用"

# 2. 模拟位置权限
echo "📌 设置模拟位置权限..."
if $ADB shell pm path "$MOCK_PKG" >/dev/null 2>&1; then
    $ADB shell appops set "$MOCK_PKG" android:mock_location allow
    $ADB shell appops set "$MOCK_PKG" RUN_ANY_IN_BACKGROUND allow
    $ADB shell settings put secure mock_location "$MOCK_PKG"
    echo "  ✅ 定位控制 App 已设为唯一模拟位置提供者"
else
    echo "  ❌ 未安装定位控制 App: $MOCK_PKG"
    echo "     请先运行 scripts/android-real-phone-mock-provider.sh install"
    exit 1
fi

# 3. 位置权限
echo "📌 授予位置权限..."
$ADB shell pm grant "$PKG" android.permission.ACCESS_FINE_LOCATION
$ADB shell pm grant "$PKG" android.permission.ACCESS_COARSE_LOCATION
$ADB shell appops set "$PKG" FINE_LOCATION allow
$ADB shell appops set "$PKG" COARSE_LOCATION allow
echo "  ✅ 位置权限已授予"

# 4. ADB 反向端口
echo "📌 建立 ADB 端口转发..."
$ADB reverse tcp:50080 tcp:50080
echo "  ✅ localhost:50080 端口转发已建立"

# 5. 启动 App
echo "📌 启动 App..."
$ADB shell am start -n "${PKG}/.MainActivity" 2>/dev/null
echo "  ✅ App 已启动"

echo ""
echo "✅ 全部初始化完成！"
echo ""
echo "⚠️  注意事项："
echo "  - MIUI force-stop 或重装 App 后需重新运行此脚本"
echo "  - 如需在开发者选项中确认，路径："
echo "    设置 → 更多设置 → 无障碍 → AutoScrollAccessibilityService"
echo "    设置 → 更多设置 → 开发者选项 → 选择模拟位置信息应用 → 定位控制"
