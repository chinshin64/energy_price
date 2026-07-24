# Android 定位控制 App

该工程生成可独立安装的 Android 测试定位控制 App。用户可在地图上点击或拖动标点，也可直接输入经纬度；应用后由前台服务持续更新 Android 的 `gps`、`network` 和 `fused` 测试 provider。

## 构建与安装

```bash
scripts/android-real-phone-mock-provider.sh build
scripts/android-real-phone-mock-provider.sh install
scripts/android-real-phone-mock-provider.sh open
```

商业环境可在构建时切换到自有的 HTTPS MapLibre 样式服务：

```bash
cd mobile/location-controller-android
./gradlew -PMAP_STYLE_URL=https://maps.example.test/styles/location :app:assembleRelease
```

首次安装后，需要在手机开发者选项的“选择模拟位置信息应用”中选择“定位控制”。脚本安装流程只用于已授权的测试设备；普通使用时直接在 App 内操作。

真机上只允许“定位控制”持有模拟位置权限。不要再用
`automation/android_mock_location.py`、`com.android.shell` 或采集 App 写入真机 provider；
Android 同一时间只有一个模拟位置应用，切换所有者会导致定位控制 App 立即失效。

## 调试命令

```bash
scripts/android-real-phone-mock-provider.sh set-location 西安
scripts/android-real-phone-mock-provider.sh set-location 34.3416 108.9398
scripts/android-real-phone-mock-provider.sh verify 34.3416 108.9398
scripts/android-real-phone-mock-provider.sh stop
```

地图使用 MapLibre Native 和 OpenFreeMap。公开底图适合开发与轻量测试；正式商业部署应配置自有或有 SLA 的兼容地图服务。

系统 provider 写入成功不代表微信或具体小程序一定采用该位置。目标应用的页面结果必须单独验证。
滴滴充电会结合页面缓存、微信定位结果以及网络/基站环境判断附近城市；
系统坐标成功后仍显示原城市时，不能把列表页结果当作定位控制 App 失败。
