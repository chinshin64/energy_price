# Android OCR 普通采集事务工作流 v2.1

> 日期：2026-07-24  
> 范围：仅 `mobile/android-ocr-uploader` 的普通 charging/fuel OCR 采集  
> 排除：旧 `mobile/android`、手工回填事务改造、外联、安装、远端部署、`fuel-quote-v1` 启用

## 1. P0 问题

当前普通采集先写 `LocalStationStore`，再写 `OutboxStore`。进程在两次
SharedPreferences 持久化之间退出时，本地结果已经可见，但没有可重试的回传批次，
形成永久漏回传窗口。

本次目标是让每个新快照在任何本地结果或 outbox 副作用之前，先持久化完整事务意图。
进程重启后可幂等补齐本地结果与 outbox；严格 ACK 后清理残留事务。现有 45 条数据
原样兼容，不扫描、改写或删除旧结果。

## 2. 事务模型

新增独立 `standalone_ocr_capture_transactions`：

- `transactionId`：使用确定性的 batch ID；
- `batchId`：对应 outbox 唯一批次；
- `snapshots`：已经过敏感内容门禁的完整本地快照；
- `batch`：已经过 observation/batch 契约门禁的完整待回传批次；
- `createdAt`：事务意图生成时间。

持久化顺序：

```text
容量预检
  -> 同步 commit 完整 journal
  -> 幂等补齐本地 snapshots
  -> 幂等补齐 outbox batch
  -> 同步删除 journal
  -> 安排 WorkManager / 当前采集立即 flush
```

本地写入必须早于 outbox：只要上传线程能看到 batch，对应本地 key 就已经存在。
相同 `localKey` 或 `batchId` 的重放不覆盖已有状态，避免把 `synced`、`failed` 或
`manual-review` 回退为 `pending`。

## 3. 恢复与 ACK

App 首页、OCR Service 和上传 Worker/Processor 入口均先执行 journal reconcile：

1. journal 存在、本地与 outbox 均缺失：补本地，再补 outbox；
2. 本地已写、outbox 缺失：保留原本地状态并补 outbox；
3. 本地与 outbox 已写：删除 journal；
4. 本地全部为 `synced` 且 outbox 已不存在：视为 ACK 已提交，只删除 journal，
   不重新创建 batch；
5. ACK 正常完成时，在本地标记 synced、删除 outbox 后按 `batchId` 删除 journal。

journal 解析失败不删除现有本地结果或 outbox；事务自身不写“已同步”状态。

## 4. 容量与失败

- 新 batch 在 journal 写入前执行容量预检，满队列时不写新本地结果。
- journal 重放时再次执行同一预检；容量仍满则保留 journal，不生成假本地成功。
- journal 持久化失败时，本地和 outbox 均不改变。
- 本地写失败时保留 journal，outbox 不写。
- outbox 写失败时保留 journal和已写本地结果；重启后补齐 outbox。
- 事务成功后才调度回传。缺少受管 endpoint/token 时 outbox 仍保留。

## 5. 兼容性

- 不迁移 `standalone_ocr_results` 中已有 45 条记录；
- 不改变现有 localKey、batchId、payload、来源和 ACK 契约；
- 手工回填继续使用已有 `BackfillTransactionStore`；
- 普通燃油扩展批次仍按既有规则保持 deferred，不探测或启用服务能力。

## 6. 验证

Robolectric 故障注入覆盖：

- journal 后退出：重启补齐本地和 outbox；
- 本地后退出：重启只补 outbox且本地不重复；
- outbox 后退出：重启清 journal且两边不重复；
- ACK 后 journal 残留：不复活已确认 batch；
- ACK 后重复提交同一屏：不回退已有 `synced` 状态；
- 容量不足：不新增本地快照，journal 可保留恢复；
- charging 与普通 fuel 均覆盖；
- 预置旧结果保持数量和内容不变。

构建验证：

```bash
./gradlew testDebugUnitTest lintDebug assembleDebug --no-daemon
```

## 7. 编码前自检

1. 产品形态：只修复独立 OCR App 的可靠回传，不增加界面或用户配置。
2. 精确范围：只覆盖普通 charging/fuel 新采集；旧 App、远端和 feature 开关不变。
3. 恢复语义：任何崩溃点都只能得到“journal、待同步本地结果、outbox”的可恢复组合，
   不能产生无 outbox 的假已同步记录，也不能因 ACK 后重放复活批次。

## 8. 实施结果

- `CaptureTransactionStore` 使用同步 SharedPreferences commit 保存最多 32 个完整事务意图；
- `CaptureTransactionCoordinator` 统一 charging/fuel 提交和幂等重放；
- `LocalStationStore` 仅插入缺失 localKey，返回本次新插入键，避免服务层回退旧状态；
- `OutboxStore` 仅插入缺失 batchId，不覆盖既有重试次数、失败或人工复核状态；
- `MainActivity`、`OcrCaptureService`、`StationUploadWorker` 和
  `StationUploadProcessor` 均接入恢复；
- 普通 ACK 在本地标记 `synced`、删除 outbox 后清理同 batch journal；
- 普通 fuel 沿用现有 deferred 判定，未探测或启用 `fuel-quote-v1`。

验证结果：

```text
CaptureTransactionRobolectricTest                  8/8
CaptureTransactionCrashRecoveryQaRobolectricTest  6/6
Debug unit tests                                187/187
lintDebug                                      0 issue
assembleDebug                                  SUCCESS
```

Debug APK：

```text
app/build/outputs/apk/debug/information-auto-recognition-v2.0.0-debug.apk
SHA-256 3416024bc26ef9db62a1e27186f03e5de7849f0105eb959cd45587b93afe7544
```

本轮未清理或迁移历史结果，未修改旧 `mobile/android`，未安装、外联、远端部署或执行真实采集。

## 9. 开发后自检

1. 产品形态复核：用户交互、页面和回传配置不变，只修复后台持久化可靠性。
2. 事务复核：意图先于副作用；每步同步持久化并可幂等重放；ACK 后残留意图不会复活。
3. 范围复核：45 条旧数据保留，普通 fuel 能力开关保持关闭，所有验证均为本地隔离测试。
