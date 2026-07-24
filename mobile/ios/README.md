# 信息自动识别 · iOS

本目录基于 Apple 当前正式路线实现 iOS 27+ 当前屏幕 OCR：

- 用户通过 `SCContentSharingPicker` 主动选择整块屏幕；
- `SCStream` 在 `UIBackgroundModes=screen-capture` 下继续提供帧；
- Vision 在设备端识别文字；
- `StationOCRCore` 自动判断滴滴充电、高德充电、高德加油、团油或 `generic-station`；
- 解析名称、地址、nullable 枪闲/忙/总数、充电价格及燃油三价/油号/页面可见枪号；
- 每屏先写 App Sandbox 内受文件保护的原子 repository/outbox，再向 47 回传；
- 只在 47 返回严格持久化 ACK 后显示“47已落库”。
- 普通单价 fuel 使用无 feature 的 schema v3；扩展多价只有在固定 47 `/health`
  明确启用 `fuel-quote-v1` 且允许当前平台后，才从持久 deferred 队列进入 outbox。
- ACK 按“outbox 持久化 ACK → 本地结果原子标记 → 删除 outbox”提交，启动时自动恢复。
- 408、429、5xx 和网络中断退避重试；其他 4xx/无效契约保留本地并停止自动重试。
- 场站名称和地址在本地入库前、payload 编码前进行两次敏感内容拒绝。
- 每屏先做全部队列容量预检，再写持久 collection journal、队列和本地结果；崩溃后按相同幂等键恢复。
- 401/403 与 feature-disabled 服务码记录为可修复终态，只能由用户显式重试；结构和安全错误持续隔离。

## 系统边界

ScreenCaptureKit 必须由用户主动开始，不能静默读取其他 App。它只提供系统允许的屏幕像素，不能读取第三方 App 的 DOM、View 树、数据库、请求流量或账号态，也不能自动滚动其他 App。受保护画面可能为空白，程序不会绕过。

ReplayKit 的 `RPSystemBroadcastPickerView` / `RPBroadcastSampleHandler` 已被 Apple 标记为 deprecated / no longer supported，本工程不包含 Broadcast Upload Extension。

官方依据：

- [ScreenCaptureKit](https://developer.apple.com/documentation/screencapturekit)
- [Capturing screen content on iOS](https://developer.apple.com/documentation/screencapturekit/capturing-screen-content-on-ios)
- [VNRecognizeTextRequest](https://developer.apple.com/documentation/vision/vnrecognizetextrequest)

## 配置

- 回传入口固定为 `https://47.111.139.230:50080`，UI 不提供地址输入。
- 来源固定为 `ios-ocr-agent`。
- payload 使用 API `schemaVersion=3` 并包含 `deviceSessionId`。
- token 只能由受管配置 `com.apple.configuration.managed.MobileIngestToken` 注入，随后保存到 Keychain；UI 不提供 token 输入。
- 平台由 OCR 自动判断；城市优先 OCR 自动识别，无法判断时用户只选择必要城市。
- Info.plist 不包含 ATS HTTP 例外，只声明 `screen-capture` 后台模式，不声明 `audio`。

## 构建

`project.yml` 是工程源，仓库同时提交由 XcodeGen 2.46.0 生成的
`DataForDidiOCR.xcodeproj` 和 shared `DataForDidiOCR` scheme。工程包含：

- `DataForDidiOCR` iOS application target；
- `DataForDidiOCRTests` unit-test target；
- 本地 Swift Package `StationOCRCore`；
- Info.plist、空 entitlements 和 AppIcon asset catalog；
- Automatic signing 入口，不提交个人 Development Team。

完整构建仍需要 Xcode 27、匹配的 iOS 27 SDK、开发者账号/签名和 iOS 27+
iPhone。首次打开后，由开发者在 Signing & Capabilities 中选择自己的 Team，并确认
`com.datafordidi.mobileocr` 对该 Team 可用：

```bash
cd mobile/ios
xcodegen generate
sh Tools/verify_xcode_project.sh
xcodebuild \
  -project DataForDidiOCR.xcodeproj \
  -scheme DataForDidiOCR \
  -destination 'generic/platform=iOS' \
  build
```

当前机器只有 Command Line Tools，Swift 6.1 与已安装的 6.2 SDK/llbuild 不匹配，不能在这里完成 `xcodebuild`、签名、安装或真机后台采集验证。

## 可执行的本地检查

```bash
swiftc -parse \
  Sources/StationOCRCore/*.swift \
  DataForDidiOCRApp/*.swift \
  DataForDidiOCRTests/*.swift \
  Tests/StationOCRCoreTests/*.swift \
  Tools/*.swift

plutil -lint DataForDidiOCRApp/Info.plist
plutil -lint DataForDidiOCRApp/DataForDidiOCR.entitlements
plutil -lint DataForDidiOCR.xcodeproj/project.pbxproj
python3 Tools/verify_static.py
sh Tools/verify_xcode_project.sh
sh Tools/run_smoke.sh
```

`Tools/verify_xcode_project.sh` 会在临时 `ios/` 副本重新运行 XcodeGen，并逐字节
比较 pbxproj、shared scheme 和 Info.plist，随后检查 App target、签名入口、最小权限、
资源阶段和无 alpha 的 1024px AppIcon。

`Tools/run_smoke.sh` 还会通过生产方法 `StationSyncClient.encodedPayload` 重新生成
`Fixtures/` 下的充电、普通 fuel 和扩展 fuel schema v3 JSON，并逐字节比对。

这些检查只证明语法和静态契约，不等同于 Xcode 类型检查、签名或真机通过。
