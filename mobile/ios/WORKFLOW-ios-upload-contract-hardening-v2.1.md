# iOS OCR 回传契约加固工作流 v2.1

> 日期：2026-07-24  
> 范围：仅 `mobile/ios`，不外联、不签名、不做真机操作  
> 受管入口：由 MDM `com.apple.configuration.managed/MobileIngestURL` 下发，源码与 UI 不保存固定地址  
> 固定来源：`ios-ocr-agent`

> 实施状态：源码与离线验证已完成；Xcode 27、签名和 iPhone 真机验证待具备对应环境后执行。

## 1. 目标

修复 iOS OCR 采集端的五个回传契约问题：

1. 普通燃油报价使用 schema v3 基础 `fuelOffers`，不附加 `fuel-quote-v1`；只有确实包含扩展多价、quote 或 provider 数据，并且 47 `/health` 明确返回 feature 已启用且允许当前平台时，才能进入上传 outbox 和发送。
2. 严格 ACK 先持久化到 outbox，再原子写入本地结果状态，最后删除 outbox 项；任一步崩溃后均能在重启时恢复。
3. 408、429、5xx 和明确的网络中断按临时失败退避；其他 4xx、无效 ACK、无效本地契约按永久失败处理，保留本地记录并标记“需人工处理”，不再自动重试。
4. `stationName`、`address` 在采集入库前与 payload 序列化前进行两次独立敏感内容拒绝，覆盖手机号、身份证、银行卡、账号、订单、验证码、支付凭证和密码，同时不因普通道路、门牌号或“支付宝大厦”等正常地址误杀。
5. 通过生产方法 `StationSyncClient.encodedPayload` 生成稳定离线 JSON fixture；smoke 必须重新生成并逐字节比对，供 Node 严格后端契约测试直接读取。

## 2. 产品与状态模型

### 2.1 燃油能力门控

- 单个燃油 offer 只有一个可见价格时，映射为基础字段：
  - 只有外显/团油价：`discountPrice`；
  - 只有油站价或国标价：`listPrice`；
  - 不发送 `displayPrice/stationPrice/nationalPrice`，不带 feature。
- 同一 offer 同时出现两个及以上扩展语义价格时，视为扩展多价，保留原字段并要求 `fuel-quote-v1`。
- 扩展批次先写独立 `deferred-feature-v1.json`，不是上传 outbox。
- App 从受管 HTTPS 根地址的 `/health` 获取能力；只接受 `success=true`、`ok=true`、`sourceNode=47-mysql`、schema v3、`stationObservation=true`、feature `enabled=true`、`captureMode=user-driven-ocr` 且平台在 allowlist 中的响应。
- 能力结果短期原子缓存；关闭或不可达时不 POST 扩展批次，也不形成无限重试。用户主动“重试回传”会刷新能力；能力开放后，以相同幂等键把延迟批次放入 outbox。
- 普通充电和基础 fuel 不依赖该 feature，继续正常入 outbox。

### 2.2 ACK 两阶段恢复

状态顺序：

```text
outbox.ready
  -> POST + strict ACK
  -> outbox.acknowledgement 持久化
  -> station repository 原子标记 synced
  -> 删除 outbox 项
```

启动和每次 flush 前先扫描已有 ACK：

- ACK 已写、结果未写：重放本地 synced 更新；
- 结果已写、outbox 未删：幂等重放后删除；
- ACK 未写：使用相同幂等键重试 POST。

不允许先删除 outbox 再更新本地状态。只有本地结果文件原子写成功后才能完成 outbox 删除。

### 2.3 失败分类

| 类型 | 示例 | 行为 |
| --- | --- | --- |
| 临时 | HTTP 408/429/5xx、超时、断网、DNS/连接失败 | 保留 outbox，指数退避，允许用户立即重试 |
| 永久 | 其他 4xx、混合批次、endpoint/令牌配置错误、严格 ACK 不成立、payload 编码失败 | outbox 标记 terminal，结果标记“需人工处理”，自动 flush 永不再发送 |
| 能力未开放 | 扩展 fuel feature disabled / 平台不允许 | 保留在 deferred，结果标记“等待能力开放”，不进入 POST 重试 |

永久失败不删除本地记录和 payload；用户可以查看错误，但“重试”只作用于临时失败和 deferred 能力刷新。

### 2.4 批次级本地事务

采集结果不能先写 station repository、再逐项尝试写队列。正式顺序为：

1. 在内存中完成本屏全部分组、过滤、幂等键和 outbox/deferred 目标计算；
2. 对两个队列做整体容量预检：已存在的相同幂等键按替换处理，只有新 key 占用容量；
3. 容量不足时整屏拒绝，station repository、outbox、deferred 和 journal 均不改变；
4. 将完整 collection transaction 原子写入 `collection-journal-v1.json`；
5. 幂等写入全部 outbox/deferred 任务；
6. 将全部本地场站一次性原子 upsert；
7. 原子删除 journal，提交完成。

启动时在任何新采集或 flush 之前重放 journal。崩溃点处理：

- journal 已写、队列未写完：按相同幂等键补齐队列；
- 队列已写、本地结果未写：从 journal/batch 重建本地结果；
- 本地结果已写、journal 未删：幂等重放后删除 journal；
- journal 自身写失败：尚未产生任何 station 或队列变更。

该事务由 MainActor 串行执行，容量预检到提交之间不允许其他采集写入，因此预检同时构成当前进程内的容量预留。磁盘写失败保留 journal 并停止本轮 flush，不能仅把 UI 标为 failed。

### 2.5 可修复终态与隔离终态

终态失败持久化 typed reason，而不是只保存一个布尔值：

| 终态 | reason 示例 | 自动重试 | 用户显式重试 |
| --- | --- | --- | --- |
| `repairable` | HTTP 401/403 凭证过期、服务码 `mobile_source_feature_disabled` 的能力竞态 | 否 | 是；401/403 需重新读取非空受管凭证，feature 失败需重新确认 health 能力 |
| `quarantined` | mixed batch、敏感内容、invalid fuel、endpoint 错误、无效 ACK、幂等/契约冲突、其他结构性 4xx | 否 | 否 |

408、429、5xx 和网络错误仍为 transient，不属于 terminal。普通“重试回传”只执行：

- transient：立即到期；
- repairable 401/403：凭证存在时重新激活；
- repairable feature：不依赖具体 HTTP 状态码，按服务码识别；清能力缓存，重新走 deferred/health 门控；
- deferred：刷新 health；
- quarantined：保持隔离，不改变 attempt、nextAttemptAt 或 payload。

旧 JSON 只有 `terminalFailure=true` 而没有 typed reason 时，保守迁移为 `quarantined/legacy-terminal`，不得因升级自动重发。

## 3. 敏感内容门

两层独立检查使用同一保守规则集：

1. `CaptureViewModel.consume` 在 `StationRepository.upsert` 前检查；
2. `StationSyncClient.encodedPayload` 在构造 JSON 前再次检查。

拒绝：

- 带标签的手机号、身份证、银行卡、账号/账户、订单/交易、验证码/短信码、支付号/支付密码、密码/口令；
- 独立的中国大陆手机号；
- 独立的 18 位身份证；
- 独立的 16–19 位银行卡号（允许空格或短横线分组）；
- Bearer/JWT 等明显凭证。

不拒绝：

- 常规道路门牌，如“科技路18号”“云水一路88号”；
- 普通建筑名，如“支付宝大厦”；
- 不带凭证值的普通业务词。

被拒绝记录不写入本地结果、deferred 或 outbox，也不上传原始 OCR 文本。

## 4. fixture

新增稳定 fixture：

- 充电 schema v3；
- 普通 fuel schema v3（无 feature）；
- 扩展 fuel schema v3（有 `fuel-quote-v1`）。

生成工具必须直接调用 `StationSyncClient.encodedPayload`，固定时间、设备/会话/幂等键和 sorted-key JSON。`run_smoke.sh` 在临时目录重新生成并与仓库 fixture 比对，防止 fixture 与生产编码路径漂移。

## 5. 验证与回滚

离线验证：

1. `swiftc -parse` 全部 Swift 文件；
2. `plutil -lint`；
3. `Tools/verify_static.py`；
4. `Tools/run_smoke.sh`，覆盖基础/扩展 fuel、health 解析、失败分类、ACK 崩溃恢复、敏感内容双门及 fixture 一致性；
5. 重读改动文件和 diff，执行三轮自检：产品形态、契约/安全、恢复/兼容。

当前机器没有完整 Xcode 27、匹配签名和 iOS 27+ iPhone，因此上述验证不能替代 Xcode 类型检查、安装、ScreenCaptureKit 后台采集或真机端到端验收。

回滚时可恢复修改前 Swift/Tools 文件；新增 JSON 字段均采用可选兼容解码。旧 outbox 没有 ACK/terminal/feature 字段时按普通可重试批次读取。

## 6. 编码前自检

### 自检一：产品形态

- 地址、平台、令牌仍不暴露为普通用户配置；
- endpoint 只接受 MDM 下发的 HTTPS 服务根地址，源码和 UI 不保存固定地址；
- 能力关闭只影响扩展 fuel，不阻断普通充电和基础 fuel；
- 永久失败可见、可保留，但不会制造无休止网络请求。
- 队列容量不足时不会先生成“等待回传”本地记录。

结论：符合独立“信息自动识别”应用形态。

### 自检二：用户原始目标

- OCR 名称、地址、枪闲忙和价格的本地展示不缩减；
- 每次可接收的采集仍进入可靠回传；
- 扩展数据在服务端明确允许前不伪装成可接收请求；
- 来源保持 `ios-ocr-agent`。

结论：修复的是可靠性和安全门，不改变用户要求的数据范围。

### 自检三：实际可恢复性

- ACK 是先持久化、后提交本地状态、最后清 outbox；
- collection journal 保证“队列任务 + 本地展示”跨崩溃一致；
- deferred → outbox 的移动以相同幂等键实现，崩溃重复不会重复入库；
- 旧 JSON 可选字段兼容；
- 没有把本地离线测试描述成 47、172 或真机已经通过。

结论：方案可实施，进入编码。

## 7. 完成证据

2026-07-24 已完成：

- 普通 fuel 无 feature、扩展 fuel health/平台门控与持久 deferred；
- 持久 ACK 两阶段提交、启动恢复及旧 outbox 可选字段兼容；
- 临时/永久失败分类，永久失败从自动 ready 队列排除；
- 批次容量预检、collection journal 及崩溃重放；
- repairable/quarantined typed terminal 与受控显式重试；
- stationName/address 采集与序列化双重敏感内容拒绝；
- 由 `StationSyncClient.encodedPayload` 生成的 3 个稳定 JSON fixture。

离线结果：

- 全量 Swift `swiftc -parse` 通过；
- Info.plist 与 pbxproj `plutil -lint` 通过；
- `Tools/verify_static.py` 通过；
- `Tools/run_smoke.sh` 通过，覆盖 parser、repository/outbox、旧 JSON 解码、
  deferred 幂等移动、ACK 恢复、严格 ACK、health、失败分类、敏感内容和 fixture
  逐字节重生比对。
- P1 定向 smoke 通过：容量不足前 station 零写入、满队列同 key 替换、journal
  部分队列写入后的恢复、同一非空凭证的用户显式恢复、HTTP 400 feature 服务码
  恢复、结构/敏感隔离不重发、旧布尔 terminal 保守迁移。
- 受管 endpoint smoke 通过：未下发时返回空并保留 outbox；下发
  `MobileIngestURL` 后只接受合法 HTTPS 根地址。
- 名称、地址、价格、闲/忙/总枪数解析、持久化与列表展示链路复核通过；每屏采集
  事务提交后立即触发 `flushOutbox()`。显式 `0/0/0` 保持为观测值，未识别到枪数时
  保持 `nil/待补全`。
- App Swift 源码扫描未发现固定后端地址、端口、地址输入或 token 输入；来源保持
  `ios-ocr-agent`。

未执行外联、签名或真机操作；当前结果不得表述为 iOS 安装包或真机链路已通过。

## 8. Xcode 27 App 工程入口

### 8.1 当前审计结论

`Package.swift` 只提供可复用的 `StationOCRCore` library 与 core tests，不是可安装 App。
真正的 App 入口由 `project.yml` 定义：

- `DataForDidiOCR`：iOS application target；
- `DataForDidiOCRTests`：依赖 App target 的 unit-test bundle；
- `DataForDidiOCRApp/DataForDidiOCRApp.swift`：SwiftUI `@main`；
- `DataForDidiOCRApp/Info.plist`：APPL bundle、屏幕采集说明和
  `UIBackgroundModes=screen-capture`；
- 本地 Swift Package `StationOCRCore`：App target 的解析核心依赖。

现有工程已具备上述 target，但审计发现以下构建入口缺口：

1. 未提交 shared scheme，README 中 `xcodebuild -scheme DataForDidiOCR` 不能由当前文件证明可用；
2. pbxproj 声明 `ASSETCATALOG_COMPILER_APPICON_NAME=AppIcon`，但没有
   `Assets.xcassets/AppIcon.appiconset`；
3. 没有显式 `CODE_SIGN_STYLE=Automatic`；
4. 没有 entitlements 文件，无法固定证明本应用没有声明额外受限能力；
5. 没有“重新运行 XcodeGen 后提交工程零漂移”的固定校验。

因此修复前只能证明存在 App target，不能证明仓库中的生成工程入口完整一致。

### 8.2 目标工程形态

以 `project.yml` 为唯一工程源，生成并提交 `DataForDidiOCR.xcodeproj`：

- 明确 shared `DataForDidiOCR` scheme，包含 build/run/test/archive；
- deployment target 固定 iOS 27；
- bundle id 固定 `com.datafordidi.mobileocr`，测试 target 使用 `.tests`；
- `CODE_SIGN_STYLE=Automatic`，不在仓库写死个人 `DEVELOPMENT_TEAM`；
- 使用空的 `DataForDidiOCR.entitlements`，明确没有 App Group、VPN、Network
  Extension、Keychain Sharing 或其他额外能力；
- `NSScreenCaptureUsageDescription` 和 `screen-capture` 只保留在 Info.plist；
- ScreenCaptureKit 不新增 ReplayKit extension，也不需要音频、相机、定位或照片权限；
- 加入可编译的 `Assets.xcassets/AppIcon.appiconset`，图形复用 Android
  “信息自动识别”现有蓝白扫描框视觉；
- Info.plist、entitlements 和 Assets 分别按配置文件/签名文件/资源处理，不能误入
  Sources build phase。

签名边界：

- 仓库只能准备自动签名入口；
- 开发者仍须在完整 Xcode 27 中选择自己的 Team，并确保 bundle id 可注册；
- 只有实际 archive/build、codesign 验证、iPhone 安装和启动完成后，才能宣称可签名安装；
- 当前 Command Line Tools 环境没有 `xcodebuild`，不能生成这部分外部证据。

### 8.3 固定生成校验

新增离线工程校验：

1. 验证 XcodeGen 版本与 `project.yml` 可解析；
2. 在临时副本中重新生成 `.xcodeproj`；
3. 逐字节比较提交的 pbxproj 与 shared scheme；
4. 校验 application/test target、SwiftUI `@main`、本地 package、bundle id、
   iOS 27、自动签名、entitlements、Info.plist、AppIcon resource phase；
5. 校验 entitlements 是空字典，Info.plist 只有必要的 screen-capture 后台模式，
   没有 ATS 放宽或无关隐私权限。

该校验只能证明工程配置自洽和可由 XcodeGen重建，不替代 Xcode 27 编译、签名与真机安装。

### 8.4 编码前自检

1. 产品形态：仍是单一 SwiftUI App，不增加 Broadcast Extension 或设置型工程页面。
2. 权限最小化：只声明屏幕采集用途和后台模式，entitlements 不申请额外能力。
3. 可维护性：只编辑 `project.yml`，pbxproj 和 scheme 由固定 XcodeGen 版本生成并校验。

结论：按以上入口补齐，不把缺少 Team/Xcode/iPhone 的外部证据伪装成本地完成。

### 8.5 完成证据

2026-07-24 已完成：

- `project.yml` 明确 application/test target、iOS 27、Automatic signing、空
  entitlements、AppIcon resource 和 shared scheme；
- 使用 XcodeGen 2.46.0 重新生成并提交 pbxproj、workspace 和 shared scheme；
- 增加 1024×1024、RGB、无 alpha 的 AppIcon，视觉复用 Android 端蓝白扫描框；
- `Tools/verify_xcode_project.sh` 在临时同名 `ios/` 目录重生工程并逐字节比较
  pbxproj、scheme 和 Info.plist；
- 工程检查确认 App/test target、本地 `StationOCRCore` package、资源阶段、bundle
  id、iOS 27、自动签名、空 entitlements、必要 screen-capture plist 和无 ATS 放宽；
- 全量 Swift parse、plist/pbxproj lint、static、XcodeGen project verification 和
  smoke 通过。

仍缺少且不能由当前机器生成的证据：

- Xcode 27 对 ScreenCaptureKit iOS API 的真实类型检查和编译；
- 开发者 Team、provisioning profile 和 bundle id 注册；
- codesign 验证、archive/export；
- iOS 27+ iPhone 安装、启动、系统 picker、后台 screen-capture 和 Vision OCR。

因此当前结论是“仓库已具备可由完整 Xcode 27 打开的可维护 App 工程入口”，不是
“已经完成签名安装或真机验收”。

## 9. 本地卡片展示 Presenter 收口（2026-07-24）

### 9.1 范围与产品形态

- 仅调整 `mobile/ios` 的本地展示映射和离线测试，不修改 ScreenCaptureKit、Vision OCR、采集生命周期、回传协议或受管配置。
- `ContentView` 不再自行拼接业务文案，只渲染纯 Swift presenter 输出。
- 卡片继续展示场站名称、地址、闲/忙/总枪数、价格、采集时间、固定来源 `ios-ocr-agent`、同步状态和待补全字段。
- UI 不展示 endpoint、token、平台选择或平台配置；平台仍由 OCR 内部自动识别。
- 不外联、不签名、不执行 `xcodebuild` 或真机操作。

### 9.2 展示语义

- 名称为空或仅空白时显示“名称待补全”；地址为 `nil`、空字符串或仅空白时显示“地址待补全”。
- `availablePorts/busyPorts/totalPorts` 分别映射闲/忙/总；显式 `0` 显示为 `0`，只有 `nil` 显示“待补全”。
- 充电价格按快/慢/超/服务费展示；燃油按油号展示外显价、油站价、国标价和页面可见枪号。价格显式 `0` 不作为未知值。
- `capturedAt` 由 presenter 统一格式化，测试通过注入固定 formatter 消除时区和 Locale 波动。
- `sourceAgent` 固定展示 `ios-ocr-agent`，不从外部配置读取。
- 同步状态映射为“等待回传 / 回传中 / 47已落库 / 回传失败 / 需人工处理”；原始失败说明不进入卡片，避免把网络地址或内部错误细节带入 UI。
- 缺失字段仅通过业务白名单映射为中文标签；未知内部字段不原样进入 UI，避免把 endpoint、token 或工程字段带入卡片。

### 9.3 三轮自检与验证

1. 产品检查：卡片只显示用户需要的场站数据和同步结果，不增加配置项或工程控制台。
2. 语义检查：显式 `0` 与未知 `nil` 严格区分；charging / fuel 使用各自价格模型；失败状态与缺失字段含义可见。
3. 安全边界：presenter 不读取网络、凭据或 ScreenCaptureKit；未知字段不透传；本地测试不宣称 Xcode 27 编译、签名或真机通过。

验证覆盖 charging、fuel、显式 `0`、未知 `nil`、失败 / 需人工处理状态、`capturedAt`、`ios-ocr-agent` 和缺失字段白名单；随后执行全量 Swift parse、现有 static 检查与 `Tools/run_smoke.sh`。

### 9.4 本地实现与验证结果

- 已在非 SwiftUI 层增加 `StationCardPresenter/StationCardPresentation`，`ContentView` 只负责渲染 presenter 输出。
- 名称、地址、闲/忙/总枪数、charging / fuel 价格、采集时间、固定来源、同步状态和缺失字段均由 presenter 统一表达。
- 显式 `0` 保留为 `0`，未知 `nil` 显示“待补全”；缺失字段只显示业务白名单，内部未知字段、平台值和原始失败消息不进入卡片。
- 增加 4 个 Xcode unit-test 用例，并把纯 Swift `presenter_smoke` 接入现有 `run_smoke.sh`。
- 全量 Swift `swiftc -parse` 通过；`Tools/run_smoke.sh` 通过，其中 presenter、parser、repository、严格 ACK、payload fixture、static contract 和 XcodeGen 工程一致性检查均成功。

本轮没有外联，没有修改 ScreenCaptureKit 或回传配置，没有执行 Xcode 27 编译、签名、安装或 iPhone 真机验证。
