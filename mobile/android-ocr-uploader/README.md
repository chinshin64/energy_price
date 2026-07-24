# 信息自动识别

独立包：`com.datafordidi.ocruploader`

## 构建配置

受管接入服务的私有 CA 公钥证书必须放在：

```text
app/src/main/res/raw/forty_seven_private_ca.pem
```

构建会验证证书可解析、当前有效且 `CA:TRUE`。应用同时信任系统 CA 和该应用内私有 CA，仍执行标准 hostname 校验；私有 CA 不加入设备系统信任。

回传 URL 与 token 不提供 BuildConfig 或源码默认值，不写入普通用户界面。完整 HTTPS 根地址和 token 仅在安装后通过受保护 receiver 或一次性私有文件预置；token 使用 Android Keystore 加密保存。

地址或 token 缺失时只保存本地结果，未回传批次保留在 outbox。明文 HTTP 始终禁用。

测试设备安装后从环境变量预置 token。脚本通过 ADB 标准输入写入应用私有目录，不回显 token；应用导入后使用 Android Keystore 加密保存：

```bash
OCR_UPLOAD_URL="$OCR_UPLOAD_URL" \
OCR_UPLOAD_TOKEN="$OCR_UPLOAD_TOKEN" \
scripts/provision-device.sh
```

正式应用还提供受 `android.permission.DUMP` 保护的 provisioning receiver，仅 shell/system 可调用。普通应用不能调用，UI 不显示配置值。

已预置 token 的设备可仅更新 URL；receiver 保留现有 Keystore 密文，并以 `REPLACE` 重建唯一上传 Work 以清除旧 endpoint 造成的长退避：

```bash
adb shell am broadcast \
  -a com.datafordidi.ocruploader.PROVISION \
  --es url "$OCR_UPLOAD_URL"
```

普通保存和入队仍使用 `KEEP`，不会反复重置退避。

## 构建

```bash
cd /Users/didi/.openclaw/workspace/data_test/mobile/android-ocr-uploader
./gradlew testDebugUnitTest lintDebug lintRelease assembleDebug assembleRelease
```

APK：

```text
app/build/outputs/apk/debug/information-auto-recognition-v2.0.0-debug.apk
app/build/outputs/apk/release/information-auto-recognition-v2.0.0-release.apk
```

## 安装

```bash
adb install -r app/build/outputs/apk/debug/information-auto-recognition-v2.0.0-debug.apk
```

与旧包并存：

```text
com.datafordidi.ocruploader
com.datafordidi.mobilecollector
```

点击“开始”并授权录屏后，应用等待投影和采屏资源初始化成功，再自动退到后台并恢复前一个页面；初始化失败或超时会留在当前页面。本应用结果页可见时不取帧、不解析、不保存、不滚动，退到后台且目标页连续稳定后才恢复。

无障碍未开启时，用户手动下滑页面后继续识别且不宣称真实目标包；用户自行开启“信息自动识别”无障碍服务后，才使用真实当前包安全门并自动下滑。通用价格支持人民币符号、元、元起和每度/千瓦时/kWh 格式，只保存最多 8 条限长价格证据，不保存整屏 OCR 原文。通知分别显示 OCR 与回传状态及非敏感计数，并提供停止和返回查看。应用不会启动或封装第三方程序，也不会使用 ADB 绕过系统授权。

燃油页面使用用户驱动 OCR：高德燃油固定识别为 `amap-fuel`，团油识别为 `tuanyou`。油号、油枪、金额和优惠说明均由用户手动切换，应用只在稳定页面读取外显价、油站价、国标价、服务商及预计报价。燃油流程不执行自动滚动、点击、输入或返回；支付、订单、收银台、密码和验证页面会直接暂停且不生成业务记录。燃油报价只有在服务端明确开启 `fuel-quote-v1`、允许当前平台并声明 `captureMode=user-driven-ocr` 时才进入 outbox。

## 回传失败处理

- 普通充电/加油采集先同步保存完整事务日志，再依次幂等补齐本地结果与 outbox；App、OCR 服务和上传任务启动时自动恢复未完成事务。
- 严格 ACK 后按批次清理事务日志。即使 ACK 后进程退出或同一屏再次触发，也不会复活已确认批次或把 `synced`、`failed`、`manual-review` 状态回退为 `pending`。
- outbox 已满或事务日志写入失败时不新增本地快照，不产生“已保存但无法回传”的假成功。
- HTTP `408`、`429`、`5xx` 和网络异常保留在自动重试队列，使用 WorkManager 指数退避。
- HTTP `409` 及其他 `4xx`、无效严格 ACK、本地契约或敏感信息错误保留在 outbox，并标记“需人工处理”，不会无限自动重试。
- ACK 必须包含 `data.sourceAgent=android-ocr-agent`；缺失或不匹配不会删除端内数据。
- 场站名称和地址在写入 outbox 前及发送前分别检查敏感内容；正常道路数字、门牌号、场站编号、油号和价格仍完整保留。

## 生产序列化契约 fixture

以下入口直接复用 App 生产 `StationObservationV3`、`ObservationEnvelope`、`StationSyncClient.buildPayload` 和正式幂等键实现，不使用独立手写 JSON：

```bash
scripts/generate-production-v3-contract-fixture.sh /tmp/android-production-v3.json
```

输出不包含 token 或真实用户/设备数据，包装器的 `serializer` 固定为 `android-production-java`，可直接交给后端 strict v3 contract 测试。

## 2026-07-24 实施与验证记录

- 来源固定为 `android-ocr-agent`；识别成功后先原子写入本地结果与持久 outbox，再立即触发自动回传。未完成受管配置时只保留本地记录和待回传任务。
- 普通 charging/fuel 新快照已增加可重放事务日志，覆盖 journal、本地结果和 outbox 三个退出点；恢复保持 localKey/batchId 幂等，ACK 后清理且不复活。
- 兼容测试以预置 45 条历史结果为基线，新事务只追加一条新记录，不扫描、迁移、改写或删除旧记录。
- 固定后端地址、端口和构建期 URL 已从生产源码、资源与最终 APK dex 移除；UI 不展示地址、token 或平台输入。
- 场站卡片继续展示名称、地址、价格及闲/忙/总枪数。旧记录只有 `0/0/0`、但没有 `raw.observed.ports=true` 或质量证据时显示“枪状态待补全”；OCR 明确观测到零值时仍显示 `0/0/0`，不删除用户历史数据。
- 当前 Debug 单元测试 `187/187` 通过，其中事务实现测试 `8/8`、独立 QA 恢复测试 `6/6`；`lintDebug` 为 `0 issue`，`assembleDebug` 通过。
- Debug APK：`app/build/outputs/apk/debug/information-auto-recognition-v2.0.0-debug.apk`，SHA-256：`3416024bc26ef9db62a1e27186f03e5de7849f0105eb959cd45587b93afe7544`。
- 本轮未安装、未执行真实采集/支付、未外联或远端部署，也未启用 `fuel-quote-v1`。
