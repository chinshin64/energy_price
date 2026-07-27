# Android OCR Uploader 架构优化设计

> 阶段：plan → build（本文档）→ review → execute → verify
> 目标工程：`mobile/android-ocr-uploader`
> 目标版本：v1.3.9+（由 v1.3.8 演进）

---

## 1. 现状诊断

### 1.1 工程定位

`mobile/android-ocr-uploader` 是“信息自动识别”独立 Android 应用，通过 `MediaProjection` + 本机 ML Kit OCR 采集充电/燃油场站数据，回传到后端 mobile-source 服务。

已具备能力：

- 充电/燃油双类型识别与互斥 envelope（v1.3.8）
- 手动/无障碍自动下滑双路径
- 本地 LocalStore / outbox 持久化与 WorkManager 续传
- 人工回填、save/delete journal、严格 ACK
- 无地址数据边界、隐私合规（无定位/存储/悬浮窗等敏感权限）

### 1.2 当前改动暴露的问题

工作区 5 个文件未提交，改动的出发点是修复“高德加油页面站名抓错、仍显示待补地址/枪状态”。但改动本身引入了新的结构性问题：

| 文件 | 问题 |
|------|------|
| `FuelStationParser.java` | 用全局 `amapMode` 特化高德优惠模式，导致普通价格被跳过；`GRADE_DISCOUNT` 把“优惠金额”误当价格证据；站名过滤规则散落在多个 `contains` 判断里，难以维护；地址直接硬编码 `null`。
| `StationObservationV3.java` | 燃油侧 `quality` 被硬编码为 `valid`，`missingFields` 永远为空，失去质量门意义；与 `StationDisplayFormatter.incomplete()` 的定义不一致。
| `StationDisplayFormatter.java` | 燃油 `incomplete()` 只判断 `hasPrice`，但 `missingSummary()` 仍提示“枪状态”；`hasAddress()` 对燃油恒返回 true，逻辑与实际数据矛盾。
| `ResultDashboardView.java` | 统计项从 5 项改 4 项但卡片区仍保留地址/枪文本；多选/全选交互已写但 `Listener.onDeleteSelected` 的消费端未在当前 diff 里确认。
| `OcrCaptureService.java` | 新增 `logOcrRows()` 把整屏 OCR 文本打印到 logcat，违反“不输出 OCR 原文/配置”原则；日志量可能触发性能与隐私问题。

### 1.3 根因归纳

1. **parser 责任边界模糊**：`FuelStationParser` 同时承担“团油 / 高德 / generic-fuel”三种页面形态的解析，用布尔开关和临时 map 硬编码分支。
2. **数据模型与展示层耦合**：`StationObservationV3` 的 `quality` 被展示层的“待补充”文案反向绑架，而不是由领域规则决定。
3. **UI 与领域状态不同源**：`ResultDashboardView` 和 `StationDisplayFormatter` 各自判断燃油/充电的完整度，规则重复且不统一。
4. **诊断日志缺乏分级**：要么完全不记，要么把整屏 OCR 文本输出，没有“受控、脱敏、可审计”的中间层。
5. **地址字段处理不一致**：燃油侧有时 `null`、有时空字符串、有时 `JSONObject.NULL`，`AddressFreePayload` 兜底但入口已经混乱。

---

## 2. 优化目标

### 2.1 核心目标

1. **解析器按平台/页面形态拆分**：团油、高德加油、generic-fuel 各自有独立策略，但共享价格/油号/卡片几何等基础组件。
2. **统一完整度/质量模型**：由 `StationObservationV3` 和 `StationDisplayFormatter` 共同消费同一份 `CompletenessPolicy`，避免规则分散。
3. **UI 只读、领域驱动**：`ResultDashboardView` 只显示 `StationResultPresenter.ViewState` 已计算好的字段，不再自行判断 hasPrice/hasPorts。
4. **日志分级与脱敏**：引入 `OcrDiagnostics` 只记录计数、枚举原因和最多 8 条短证据，不输出整屏 OCR 文本。
5. **地址字段彻底无化**：燃油侧从解析到序列化到 UI 均不生成 address 键；充电侧保持可选但严格脱敏。

### 2.2 非目标

- 不改后端 mobile-source 的 HTTP/数据库契约（除非 v1.3.9 后续版本明确需要）。
- 不新增敏感权限（定位、存储、悬浮窗、VPN 等）。
- 不改动充电侧核心解析路径（Didi/Amap/Generic charging）。
- 不在 UI 暴露回传地址、Token、平台配置、OCR 次数等工程字段。

---

## 3. 架构优化方案

### 3.1 包/类职责重构

建议新增/调整以下类（均在 `com.datafordidi.mobilecollector` 包）：

```
parser/
  FuelCardParser.java          // 抽象：从 OCR rows 解析出一个 FuelStationRecord（卡片范围已知）
  FuelRowClassifier.java       // 将 OCR row 分类为：油号、价格、枪数、站名、噪声
  FuelPriceInterpreter.java    // 解释价格语义：挂牌/优惠/油站价/国标价/未分类
  FuelTitleExtractor.java      // 提取场站标题，含平台特化过滤
  TuanyouFuelParser.java       // 团油原生 App 解析策略
  AmapFuelParser.java          // 高德加油解析策略（列表 + 详情）
  GenericFuelParser.java       // 通用燃油解析策略
  FuelParserFactory.java       // 按 platform/hint 选择策略

policy/
  StationCompletenessPolicy.java  // 充电/燃油完整度统一判定
  FuelQualityPolicy.java          // 燃油 record quality 判定
  OcrDiagnosticsPolicy.java       // 诊断日志分级规则

diagnostics/
  OcrDiagnostics.java          // 不可变诊断快照
  OcrDiagnosticsBuilder.java   // 构建器，限制数量与敏感内容
```

原有 `FuelStationParser` 拆分为策略入口 + 若干特化 parser，而不是一个 600 行的全能类。

### 3.2 解析器拆分

#### 3.2.1 原有 `FuelStationParser.extract()` 的拆分

```java
// FuelParserFactory
static FuelParseResult parse(List<OcrRow> rows, String platform, String sourceStage) {
    String normalized = FuelPlatformDetector.normalize(platform);
    FuelCardParser parser;
    if ("tuanyou".equals(normalized)) parser = new TuanyouFuelParser();
    else if ("amap-fuel".equals(normalized)) parser = new AmapFuelParser();
    else parser = new GenericFuelParser();
    return parser.parse(rows, platform, sourceStage);
}
```

每个 `FuelCardParser` 实现：

1. 用 `FuelTitleExtractor` 找卡片标题。
2. 用 `FuelRowClassifier` 对卡片内 rows 分类。
3. 用 `FuelPriceInterpreter` 解释价格语义。
4. 组装 `FuelStationRecord`。

#### 3.2.2 高德加油特化处理

- **列表页**：标题为站名，卡片内有多油号价格行（如 `92# ¥7.52/升`），按 `gradeCode` 分 offer。
- **详情页**：顶部站名，下方是油号列表，常见结构：
  - `92# 汽油` + `油站价 ¥8.00/L` + `优惠 ¥0.59/L`
  - 或 `92# 优惠 ¥0.59/L` + 全页共用 `油站价 ¥8.00/L`
- 处理规则：
  - 优先识别“油号 + 价格标签 + 金额”三要素同行的 offer。
  - 若只识别到“油号 + 优惠金额”，则在本卡片内寻找最近的“油站价/国标价”作为基准价；找不到则该油号不产 offer（不能把优惠金额当实付价）。
  - 禁止用整页全局 `stationPrice` 回填到所有油号：必须是同卡片或同油号邻域内的价格证据。

#### 3.2.3 团油特化处理

- 列表页：标题为站名，价格行常见 `¥7.52 92#` 或 `92# ¥7.52`。
- 详情页：区分“团油价 / 油站价 / 国标价”，按标签入对应 role。
- 优惠/满减/券等通过 `blocked()` 统一屏蔽，不进入价格。

### 3.3 统一完整度与质量模型

新增 `StationCompletenessPolicy`：

```java
final class StationCompletenessPolicy {
    enum Level { COMPLETE, INCOMPLETE, INVALID }

    static Level evaluate(JSONObject row) {
        boolean fuel = StationDisplayFormatter.isFuel(row);
        boolean hasName = !row.optString("stationName", "").trim().isEmpty();
        if (!hasName) return Level.INVALID;
        if (fuel) {
            return StationDisplayFormatter.hasPrice(row) ? Level.COMPLETE : Level.INCOMPLETE;
        }
        boolean hasPrice = StationDisplayFormatter.hasPrice(row);
        boolean hasPorts = StationDisplayFormatter.hasPorts(row);
        boolean hasAddress = StationDisplayFormatter.hasAddress(row);
        if (hasPrice && hasPorts && hasAddress) return Level.COMPLETE;
        if (hasPrice || hasPorts) return Level.INCOMPLETE;
        return Level.INCOMPLETE; // 仅有名称也保留，但标记 incomplete
    }

    static List<String> missingFields(JSONObject row) {
        // 由 evaluate 反向推导，供 quality.missingFields 使用
    }
}
```

`StationObservationV3.fuel()` 不再硬编码 `quality=valid`，而是调用 `FuelQualityPolicy`：

```java
static JSONObject fuel(FuelStationRecord station) {
    JSONObject common = common("fuel", station.stationName, null, null, null, null, station.capturedAt);
    JSONObject quality = FuelQualityPolicy.evaluate(station);
    put(common, "quality", quality);
    // ...
}
```

燃油 `quality` 规则：

- `INVALID`：站名为空或被敏感策略拒绝。
- `INCOMPLETE`：有站名但无有效 price/offer。
- `VALID`：有站名且至少一个 offer 含有效价格。

### 3.4 UI 与领域状态对齐

#### 3.4.1 `StationResultPresenter.ViewState` 扩展

```java
final class StationResultPresenter {
    static class ViewState {
        int validStations;
        int withPrice;
        int withGuns;
        int incomplete;
        int pending;
        int failed;
        int fuelStationsWithOffers;
        int fuelStationsWithQuotes;
        List<JSONObject> rows;
        Filter filter;
    }
}
```

`ResultDashboardView` 只消费 `ViewState`，不再自行判断：

- 统计 4 项还是 5 项由 `ViewState` 预计算。
- 卡片渲染统一使用 `StationDisplayFormatter`。

#### 3.4.2 `StationDisplayFormatter` 调整

- `incomplete(row)`：调用 `StationCompletenessPolicy.evaluate(row)`。
- `missingSummary(row)`：
  - 燃油：只提示“待补油价”。
  - 充电：提示“待补地址/枪状态/价格”。
- `address(row)`：燃油直接返回空字符串，不再显示“地址待补全”。
- `hasAddress(row)`：燃油直接返回 true（因为地址不是采集项，不算缺失）。

### 3.5 诊断日志分级

移除 `OcrCaptureService.logOcrRows()` 的整屏文本输出，改为：

```java
private void emitOcrDiagnostics(
        List<OcrRow> rows,
        ScreenContextResolver.ParsedScreen parsed,
        String sourceStage
) {
    OcrDiagnostics diagnostics = new OcrDiagnostics.Builder()
        .rowCount(rows.size())
        .platform(parsed.platform)
        .stationType(parsed.stationType)
        .stationCount(parsed.size())
        .rejectionReasons(parsed.rejectionReasons)
        .priceEvidence(parsed.priceEvidence)
        .build();
    Log.i(TAG, diagnostics.toShortLog());
}
```

`OcrDiagnostics` 约束：

- 不保存整屏 OCR 文本。
- 不保存截图路径、endpoint、token、密文。
- 最多 8 条价格/枪数短证据，每条含 kind + bbox + 短文本片段。
- 拒绝原因使用固定枚举。

### 3.6 地址字段彻底无化

燃油侧保证：

1. `FuelStationRecord.address` 初始为 `null`。
2. `FuelStationParser` 策略不调用 `address()` 方法。
3. `StationObservationV3.fuel()` 传 `null` 给 `common()`。
4. `common()` 对 fuel 生成 `address: null` 或干脆不生成 `address` 键（按后端契约选择）。
5. `StationDisplayFormatter.address(row)` 对 fuel 返回 `""`。
6. `AddressFreePayload` 保留作为第二道兜底。

建议：既然后端 mobile-source 地址已是 `optionalText`，Android 端对 fuel 直接不生成 `address` 键更干净。

---

## 4. 关键接口设计

### 4.1 `FuelCardParser`

```java
interface FuelCardParser {
    FuelParseResult parse(List<OcrRow> rows, String platform, String sourceStage);
}

final class FuelParseResult {
    final List<FuelStationRecord> stations;
    final List<String> rejectionReasons;
    final List<PriceEvidence> priceEvidence;
}
```

### 4.2 `FuelRowClassifier.Result`

```java
final class RowClassification {
    final List<GradeRow> grades;       // 油号行
    final List<PriceRow> prices;       // 候选价格行
    final List<LabelRow> labels;       // 油站价/国标价/优惠价等标签行
    final List<OcrRow> noise;          // 已屏蔽的噪声行
    final List<OcrRow> titles;         // 站名候选
}
```

### 4.3 `FuelPriceInterpreter`

```java
final class InterpretedPrice {
    final BigDecimal value;
    final PriceRole role;       // LIST / DISCOUNT / STATION / NATIONAL / DISPLAY / UNCLASSIFIED
    final OcrRow evidence;
    final String gradeCode;     // 若价格行已含油号
}
```

---

## 5. 数据流优化

```
MediaProjection 截图
    ↓
ML Kit OCR → List<OcrRow>
    ↓
OcrCaptureService
    - AppVisibilityState 检查
    - ScreenContextResolver 路由到 fuel / charging
    - 若为 fuel：FuelParserFactory 选择 Tuanyou / Amap / Generic
    ↓
FuelCardParser
    - FuelTitleExtractor 分卡片
    - FuelRowClassifier 分类 rows
    - FuelPriceInterpreter 解释价格
    ↓
FuelStationRecord（address = null）
    ↓
FuelObservationTracker / StationObservationTracker
    - 预览变化
    - StationSafetyPartition 安全检查
    ↓
CaptureTransactionCoordinator
    - LocalStore + outbox 原子持久化
    - journal 保证跨 SharedPreferences 一致性
    ↓
StationSyncClient / WorkManager
    - 上传、严格 ACK、失败重试
```

---

## 6. 测试策略

### 6.1 新增测试

| 测试 | 覆盖 |
|------|------|
| `AmapFuelParserTest` | 高德列表/详情、优惠金额不覆盖主价、油站价同卡绑定、多油号、负例 |
| `TuanyouFuelParserTest` | 团油列表/详情、标签识别、会员价排除 |
| `GenericFuelParserTest` | 通用加油站页面、无地址、价格范围 |
| `FuelQualityPolicyTest` | 有站名无价格 → incomplete；有站名有价格 → valid；站名为空 → invalid |
| `StationCompletenessPolicyTest` | 充电/燃油完整度统一判定 |
| `OcrDiagnosticsTest` | 不输出整屏文本、证据数量上限、敏感键过滤 |
| `ResultDashboardViewTest` | 只消费 ViewState、统计项正确、多选/全选回调 |

### 6.2 回归测试

- 充电 parser 全量回归（Didi / Amap / Generic charging）。
- LocalStore / outbox roundtrip。
- 无地址 `AddressFreePayload` 净化。
- WorkManager 续传与严格 ACK。
- 手动/自动下滑状态机。

### 6.3 构建与审计

- `clean testDebugUnitTest testReleaseUnitTest lintDebug lintRelease assembleDebug assembleRelease`
- OCR 质量审计：西安/武汉 distinct names、suspicious rows、mismatch rows。
- 静态扫描：私网 IPv4、Bearer 字面量、probe 符号、敏感权限。

---

## 7. 风险与回滚

### 7.1 风险

| 风险 | 缓解 |
|------|------|
| parser 拆分后旧团油 fixture 失效 | 拆分前把现有 FuelStationParserTest fixture 迁移到 TuanyouFuelParserTest |
| `quality` 从 valid 改为 incomplete 可能影响 UI 筛选 | `StationResultPresenter` 统一计算，UI 不自行判断 |
| 移除 `logOcrRows` 后现场调试困难 | 用 `OcrDiagnostics` 保留计数和短证据，必要时通过 ADB 抓 log |
| 地址字段移除影响旧数据读取 | `fromLocalRow` 保持兼容，只对新数据不生成 address 键 |

### 7.2 回滚

- 代码回滚：`git checkout -- mobile/android-ocr-uploader/...` 恢复到 v1.3.8 基线。
- 数据回滚：LocalStore/outbox 不做破坏性迁移，覆盖安装不影响旧数据。
- APK 回滚：重新安装 v1.3.8 Debug APK。

---

## 8. 实施顺序

建议按以下顺序执行，每步通过测试后再进入下一步：

1. **搭建 policy 层**：新增 `StationCompletenessPolicy`、`FuelQualityPolicy`。
2. **重构 `StationDisplayFormatter` 与 `StationObservationV3`**：统一完整度/质量。
3. **搭建 diagnostics 层**：替换 `logOcrRows()`。
4. **拆分 parser**：先团油、再高徳、最后 generic，保持 `FuelStationParser` 作为兼容门面。
5. **调整 UI**：`ResultDashboardView` 消费 ViewState，确认多选消费端。
6. **全量回归测试与 lint/build/audit**。

---

## 9. 验收标准

- [ ] `FuelStationParser` 代码行数下降 30% 以上，拆分为 3+ 独立策略。
- [ ] 燃油侧 `address` 键在 `StationRecord.toJson()`、LocalStore、outbox、HTTP 中不存在。
- [ ] `OcrCaptureService` 不再把整屏 OCR 文本输出到 logcat。
- [ ] `StationCompletenessPolicy` 统一充电/燃油完整度判定。
- [ ] 高德加油详情页能正确识别站名、油号、油站价/优惠价，不再误把“优惠金额”当实付价。
- [ ] 团油解析能力不回归。
- [ ] Debug/Release 单元测试 ≥ 原 103 个，全部通过。
- [ ] lint 0 error；assemble 成功；OCR audit suspicious/mismatch 为 0。

---

*文档版本：v1.0（plan 阶段）*
*待 review 后进入 build/execute 阶段。*

---

## 10. v2.2.1：arm64 精简包与高德服务费双路径

### 10.1 版本范围

- 应用版本升级为 `2.2.1`，`versionCode=34`。
- Debug APK 仅打包 `arm64-v8a`，继续使用随包发布的 ML Kit 中文 OCR 模型。
- 不切换到依赖 Google Play Services 首次下载的 OCR 模型，保证国内 Android
  设备、离线页面和侧载场景可用。
- 本次不启用 R8、不重构 OCR 主链路、不改服务端协议，避免在体积优化中引入无关行为变化。

### 10.2 ABI 边界

`defaultConfig.ndk.abiFilters` 只声明 `arm64-v8a`。验收时必须同时满足：

1. APK 可通过 ADB 侧载到 ABI 列表包含 `arm64-v8a` 的 Android 设备；
2. APK 中 `lib/` 下只存在 `lib/arm64-v8a/`；
3. x86、x86_64、armeabi-v7a 原生 OCR 库不进入产物；
4. 不承诺安装在仅支持 32 位 ABI 的老设备上，保留旧 universal 包作为兼容回退。

### 10.3 服务费双路径

高德燃油支付页使用以下优先级：

1. **直接路径**：页面出现独立“服务费”标签与金额时，直接提取
   `serviceFee=directServiceFee`。
2. **差额路径**：页面没有独立服务费明细，但同时存在：
   - 顶部 `加200省¥X` → `selectedAmount=200.00`、`grossDiscount=X`；
   - 底部 `比油站价优惠¥Y` → `netDiscount=Y`；
   - 则计算 `serviceFee=grossDiscount-netDiscount`。
3. **实付反推路径**：若没有净优惠但存在实付金额，计算
   `serviceFee=payableAmount-(selectedAmount-grossDiscount)`。

当直接服务费与差额路径同时存在时：

- 两者误差不超过 `0.05` 元，保留直接识别结果；
- 两者冲突超过 `0.05` 元，使用由总优惠与净优惠计算的结果，并继续通过统一金额公式
  复核；最终金额链仍不闭合时标记 `needsReview`；
- `serviceFee` 必须大于等于零且不得超过 `grossDiscount`。

金额一致性公式：

```text
netDiscount = grossDiscount - serviceFee
payableAmount = selectedAmount - grossDiscount + serviceFee
payableAmount = selectedAmount - netDiscount
```

66.jpg 的期望值为：

```text
selectedAmount = 200.00
grossDiscount = 19.85
netDiscount = 16.67
serviceFee = 19.85 - 16.67 = 3.18
payableAmount = 183.33
```

### 10.4 OCR 行拆分与抗污染边界

- `加200` 与 `省¥19.85` 被 ML Kit 拆成同基线相邻行时，先由
  `OcrRowGeometry.withSameLineMerges()` 生成合并候选，再执行金额正则。
- `¥183.33` 与 `含服务费` 同行或被拆成相邻行时，允许该页脚作为实付金额候选；
  “服务费”独立标签、服务费说明和普通文案仍不得作为实付金额来源。
- `¥3.5` 神券、`12元×2张`、`3元` 洗车券、`¥1/份` 保障、`500万` 保障文案
  都不参与总优惠、净优惠、服务费或实付金额计算。
- “比油站价优惠”只产生 `netDiscount`，不得被通用“优惠”标签重复解释为总优惠。
- 没有独立“服务费”标签不是拒绝 quote 的条件；只要金额链路可闭合即可生成 quote。

### 10.5 测试计划

1. 保留现有独立“服务费”标签测试，确保直接路径不回归。
2. 新增 66.jpg 同行 OCR 回归，断言：
   `200.00 / 19.85 / 16.67 / 3.18 / 183.33`。
3. 新增 66.jpg 颜色/字号导致的拆行 OCR 回归，包含神券与保障金额噪声，并断言相同结果。
4. 运行 `FuelQuoteParserTest`。
5. 运行完整 `testDebugUnitTest`。
6. 运行 `assembleDebug`，核对 APK 体积、SHA-256 和 `lib/` ABI 清单。

### 10.6 设计自检

- **产品形态检查**：用户仍只需点击 OCR；页面是否显示独立服务费不再影响记录生成。
- **准确性检查**：服务费必须通过至少一条确定性金额路径得到，并由统一公式复核；
  小额券和保障文案没有合法标签链路，不能污染字段。
- **兼容性检查**：仅缩减 native ABI，不删除中文模型或业务代码；arm64 Android 行为与
  v2.2.0 保持一致，32 位设备明确使用旧兼容包。

*文档版本：v1.1（追加 v2.2.1 build 设计）*

---

## 11. v2.2.2：实机遮挡场景 fail-closed

### 11.1 实机失败记录

2026-07-27 09:42:23 在 Xiaomi 上通过 MediaProjection + ML Kit 回放 66.jpg，
本地生成的 95# 记录为：

```text
displayPrice=7.08
grossDiscount=19.85
serviceFee=19.85
netDiscount=0.00
payableAmount=200.00
```

正确结果应为：

```text
grossDiscount=19.85
netDiscount=16.67
serviceFee=3.18
payableAmount=183.33
```

诊断摘要只有 `rows=35`，原始 OCR rows 未持久化。Gallery 回放底部工具栏可能遮挡
`¥183.33 / 比油站价优惠¥16.67`，因此解析器必须在底部证据完全缺失时 fail-closed，
不能从页面其他 `200` 文案制造完整支付报价。

### 11.2 根因

`standalonePayable()` 在已知 `selectedAmount=200` 时仍保留与本金相同的候选值。
当 ML Kit 把顶部 `加200` 单独识别为一行、底部实付区域未进入截图时：

1. `加200` 被 `firstMoney()` 解释为 200；
2. `standalonePayable()` 没有找到其他金额，回退返回 200；
3. `serviceFee=payable-(selected-gross)=200-(200-19.85)=19.85`；
4. `netDiscount=gross-service=0`；
5. 该错误金额链数学上自洽，被引导采集误判为完整并上传。

这是证据不足时的 fail-open，不是服务费公式本身错误。

### 11.3 最小修复

1. 已知 `selectedAmount` 时，`standalonePayable()` 永远不得回退到与本金相同的候选。
2. `加200/充200/满200/减200` 等包含操作或促销语义的行不得作为独立实付金额。
3. 只有 `payableAmount < selectedAmount` 时，才允许通过
   `payable-(selected-gross)` 反推正服务费。
4. `grossDiscount>0`、`payableAmount==selectedAmount`，且没有明确服务费、净优惠或
   明确实付标签时，不得形成引导采集的完整 quote。
5. 完整 footer 可见时仍保留：
   `serviceFee=grossDiscount-netDiscount=19.85-16.67=3.18`。
6. 独立“服务费 + 金额”的原路径保持不变。

### 11.4 受控实机 OCR 证据

正式日志继续禁止输出整屏 OCR。Debug 包新增仅本机测试可用的私有证据机制：

- 默认关闭；
- 只有应用私有目录存在 `files/ocr-test-evidence.enable` marker 时启用；
- 每次仅覆盖写入 `files/ocr-test-evidence-latest.json`；
- 内容只含捕获时间、sourceStage、文本行与归一化坐标；
- 不含 endpoint、token、provisioning、上传结果或应用设置；
- 不上传、不写 logcat，关闭时不创建证据文件；
- 通过 `adb shell run-as com.datafordidi.ocruploader` 创建 marker 和读取文件。

该机制用于下一轮从真实 ML Kit 输出建立 fixture，不能成为正式数据链路。

### 11.5 回归测试

1. 用本次实机失败形态建立 35 行 fixture：footer 被遮挡、存在多个促销 200 和小额券；
   断言不会生成 `serviceFee=19.85 / payableAmount=200` 的完整记录。
2. 用完整 footer 的拆行 fixture 断言：
   `gross=19.85 / net=16.67 / service=3.18 / payable=183.33`。
3. 保留明确“服务费”路径回归。
4. 测试 Debug 证据默认关闭、marker 开启后只写私有单文件，且内容不包含敏感配置键。
5. 运行定向测试、完整 `testDebugUnitTest`、`lintDebug`、`assembleDebug`。
6. APK 保持 `arm64-v8a` only，版本升级为 `2.2.2`、`versionCode=35`。

### 11.6 记录纠正边界

09:42:23 错误记录已经上传到 167。本轮只修客户端，不擅自删除或更新服务端数据。
后续可按 `capturedAt + stationName + gradeCode` 精确定位，由业务确认后执行：

- 软标记该快照无效；或
- 删除错误 quote 后，用新版本重采的正确快照替代。

*文档版本：v1.2（追加 v2.2.2 实机失败修复）*

---

## 12. v2.3：安全应用更新通道

### 12.1 产品边界

- UI 只显示“检查更新”、版本号、下载/安装确认和简短错误，不展示服务器地址、Token、
  APK 路径或证书摘要。
- 更新根地址只从 `AppSettings.getUploadUrl()` 的已校验 HTTPS 根地址派生，固定追加
  `/api/mobile-update/`；不新增可输入地址。
- 启动检查按本机时间限频（默认 24 小时），手动检查不受限频影响。
- Android 只下载到应用私有 `files/updates/`，通过 FileProvider 交给系统安装器；
  应用不能静默安装。

### 12.2 信任与校验顺序

1. HTTPS only，禁止重定向到非 HTTPS。
2. manifest 只接受受控字段：`versionName/versionCode/packageName/sha256/size/apkPath`。
3. APK 流式下载并限制最大体积，下载完成校验 size 与 SHA-256。
4. 用 `PackageManager.getPackageArchiveInfo(...GET_SIGNING_CERTIFICATES)` 校验包名。
5. `versionCode` 必须严格大于当前安装版本，且必须与 manifest 一致。
6. APK 签名证书集合必须与当前应用完全一致。
7. 全部通过后才生成 FileProvider URI 和 `ACTION_VIEW` 系统安装确认。
8. 任一失败删除临时 APK；日志只记录固定错误码，不拼接 URL、Token 或服务器响应。

### 12.3 版本与构建

- 默认 `2.3.0/code36`、arm64-only。
- Gradle 属性 `-PappVersionName=2.3.1 -PappVersionCode=37` 可生成更新验收包；
  属性必须满足版本名非空、版本码为正整数。
- 文件名继续包含实际版本，避免 manifest 与产物混淆。

### 12.4 服务端结构

独立 Node 标准库服务监听 `127.0.0.1:50082`：

```text
mobile-update/
  server.js
  test/server.test.js
  deploy/mobile-update.service
  deploy/mobile-update.nginx.conf
  releases/current.json
  releases/apk/
```

- `GET /api/mobile-update/latest` 返回 JSON manifest，`Cache-Control: no-store`。
- `GET /api/mobile-update/apk/<受控文件名>` 返回 APK，支持 Content-Length、
  ETag、nosniff 和私有缓存策略。
- manifest 发布使用同目录临时文件 + rename 原子切换。
- 路径必须经过 basename/扩展名/realpath 边界校验，拒绝 `%2e%2e`、斜杠和符号链接逃逸。
- systemd 以低权限专用用户运行；Nginx 只反代固定路径，不包含密钥或 Token。

### 12.5 三轮自检

1. **产品自检**：用户只看到版本和操作结果，更新地址继续作为后端配置，不增加工程字段 UI。
2. **安全自检**：HTTPS、摘要、包名、递增版本、同签名五层校验均在安装 Intent 前完成；
   下载位于私有目录，服务端拒绝路径穿越，错误日志不含敏感值。
3. **部署自检**：Node 仅回环监听，Nginx 承担公网 TLS；manifest 原子发布；
   systemd/Nginx 模板无 Token、证书私钥和实际域名密钥。

### 12.6 测试计划

- Android：URL 派生、限频、manifest 契约、SHA/版本/包名/签名校验策略单测；
  `testDebugUnitTest lintDebug assembleDebug`。
- Node：latest、APK headers、404/405、路径穿越、损坏 manifest、原子发布测试。
- 构建默认 2.3.0/code36，并验证属性覆盖构建 2.3.1/code37。

*文档版本：v1.3（追加 v2.3 安全更新通道）*

---

## 13. v2.3.1：mobile-source 只读更新代理与燃油完整视图

### 13.1 背景与边界

当前公网 Tunnel 直接指向 mobile-source `50081`，独立更新服务只监听回环地址
`127.0.0.1:50082`。因此更新请求到达 mobile-source 后会落入 404，而不会经过原计划中的
Nginx `50080`。本轮不改变 Tunnel、不部署服务，采用以下最小兼容方案：

1. mobile-source 仅代理两个只读路径：
   - `GET /api/mobile-update/latest`
   - `GET /api/mobile-update/apk/<安全文件名>`
2. 上游只允许 HTTP 回环地址，默认 `127.0.0.1:50082`；禁止非回环主机、用户信息、
   query、fragment 和非根路径，避免形成 SSRF/开放代理。
3. 请求侧只保留原始 query，不转发 `Authorization`、`X-Mobile-Token`、
   `X-Source-Sync-Token`、Cookie 或任意其他客户端 Header。
4. APK 响应流式传输；响应 Header 只透传 Content-Type、Content-Length、ETag、
   Cache-Control、Last-Modified、Content-Disposition。
5. 连接失败、超时或上游在响应前断开统一返回 `502 update_upstream_unavailable`；
   客户端中断时主动销毁上游请求。
6. POST/PUT/DELETE 等非 GET 方法返回 405；其他路径继续走 mobile-source 原有 404。
7. 现有 `/health`、ingest/source-sync 鉴权和 body parser 的执行顺序与行为不变。

配置支持两种等价注入方式：

```text
createMobileSourceNodeApp({ updateProxyUrl: "http://127.0.0.1:50082" })

MOBILE_UPDATE_PROXY_HOST=127.0.0.1
MOBILE_UPDATE_PROXY_PORT=50082
MOBILE_UPDATE_PROXY_TIMEOUT_MS=15000
```

### 13.2 MySQL 只读完整燃油视图

燃油数据按职责拆分在 batch、snapshot、offer、quote 四层。`station_name` 和
`provider_name` 不重复写入 offer/quote 表，因此直接查看子表时看不到站名是正常的表设计，
不是 Android 丢字段。新增独立 migration component `mobile-ocr-source-fuel-view`，自身
版本从 1 开始，不占用、推进或重写主组件 `mobile-ocr-source` 的版本。迁移前要求主组件
版本不低于 v4，并逐列验证生产 v4 表契约，再创建只读视图
`mobile_ocr_fuel_complete_records`：

- `channel`：`mobile_ocr_ingest_batches.platform`，并保留 `platform` 同义列；
- `station_name`、`cp_name`：来自 `mobile_ocr_station_snapshots`；
- `display_price`：来自 `mobile_ocr_fuel_offers`；
- `discount_amount`、`service_fee`、`payable_amount`：来自
  `mobile_ocr_fuel_quotes`；
- 通过 `source_record_id` 关联快照，通过规范化后的 `grade_code` 将 offer 与 quote
  对齐；
- 不复制、不更新任何业务数据，只保存视图定义。

同一油号存在多个报价时，视图保留多行报价事实；仅有 offer 而暂无 quote 时仍保留该油号，
报价字段为 `NULL`。迁移必须可重复执行，并由生产 `SHOW CREATE TABLE` v4 契约测试验证列
映射与 JOIN；不得要求 v5 split 表或 cursor。

### 13.3 隔离并发验证

并发测试只运行在本机临时端口与内存/假 MySQL pool，不调用 167 ingest：

1. health：验证数百并发 GET 不占用写事务；
2. ingest：先模拟旧配置 pool=10、queueLimit=100 的排队与拒绝边界，再模拟
   pool=10、queueLimit=500 的 300 个唯一批次突发；
3. idempotency：同 key 并发请求只形成一个逻辑批次，其余返回 duplicate；
4. update proxy：并发 manifest/APK GET 验证流式透传、query 保留、Header 隔离与超时 502。

容量结论必须区分“Node HTTP 可接收并发”和“MySQL 可同时执行的写事务”。MySQL 连接数
继续默认 10，避免未经 `max_connections`、IOPS 和事务耗时验证就盲目放大；等待队列通过
`MOBILE_SOURCE_MYSQL_QUEUE_LIMIT` 配置，默认 500，只接受 1～5000 的整数，非法配置回退
到 500。服务端 5xx 保持可重试语义并返回 `Retry-After`，Android outbox 保留批次并由
WorkManager 继续重试。后续仍应加入客户端随机抖动，并以 pool 使用率、排队长度、事务
P95/P99 和 5xx 为扩容依据，不得把一次本机无数据库压测等同于 167 生产容量证明。

生产 v4 不能用本地 v5 `mysql-mobile-source-store.js` 整文件覆盖。容量调整通过独立的
fail-closed patch 工具完成：仅在目标文件仍引用 v4 `mobile_ocr_station_snapshots`、且不含
split/cursor/fuel_snapshots 标识时，精确加入队列环境变量并替换唯一的
`queueLimit: 100`；支持只检查和原子应用，应用前生成权限受限备份，补丁后执行语法检查。

### 13.4 三轮自检

1. **契约自检**：逐字段核对 Android v3 JSON、Node 规范化对象和 MySQL 列，不用字段名相似
   代替实际调用链证据。
2. **安全自检**：代理路由/方法/文件名/上游均为白名单；不转发认证信息；不访问生产 ingest；
   视图只读且不复制业务数据。
3. **产品自检**：APK 更新仍使用原有根地址，用户无需配置新地址；phpMyAdmin 可直接查看完整
   燃油记录；现有采集、上传、health 行为不回归。

*文档版本：v1.6（修正生产 v4 燃油视图契约，并增加 v4 队列精确补丁）*
