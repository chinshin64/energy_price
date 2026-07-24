---
source: Codex Desktop rollout session
session_id: 019f4ab7-46f3-7290-aa7a-5b62ef172298
source_file: ~/.codex/sessions/2026/07/10/rollout-2026-07-10T14-29-13-019f4ab7-46f3-7290-aa7a-5b62ef172298.jsonl
model: gpt-5.6-sol (Codex, reasoning_effort: ultra)
cwd: /Users/didi/.openclaw/workspace/data_test
generated: 2026-07-24
method: 15 切片并行抽取 + 汇总（Claude Code workflow）
---

> 本文档由 Codex 会话 rollout 自动抽取整理，含【会话概览】【关键决策】【代码改动】【关键发现】【待办】。
> 工具调用约 3000 次，仅保留摘要；原文见 source_file。

# 滴滴充电小程序数据抓取/风控测试项目 — 结构化笔记

## 一、会话概览

**时间跨度**：2026-07-10 06:29 至 2026-07-24 02:28（约 14 天）

**项目性质**：滴滴充电小程序数据抓取与风控对抗测试，后扩展为跨平台（Android/iOS）OCR 场站数据采集全链路系统。

**主要工作内容**：

1. **SDK 批测与风控分析**（7/10-7/13）：对西安/广州/武汉三地充电场站进行在线 SDK 批量测试，发现单中心点深翻页触发业务码 100003 风控；定位滴滴充电签名能力分布两套小程序包中，采用跨包组合方案。
2. **172 服务器受控验证**（7/13-7/14）：在 172 节点执行 45 次变 UA 请求测试，首个请求即被风控拦截；后续完成 bootstrap 初始化链路验证，确认 DCLG 初始化请求与认证值续传是业务请求成功的关键。
3. **Android OCR 采集 App 开发**（7/21-7/24）：从 v1.1.0 迭代至 v2.0.0（versionCode 17），包名 `com.datafordidi.ocruploader`，应用名称从"场站OCR回传"改为"信息自动识别"。解决自页面递归污染、价格缺失、地址字段移除、HTTPS 明文拦截等核心问题。
4. **47 服务器部署与数据落库**（7/21-7/24）：47 从透明转发升级为一等数据源节点，部署 MySQL 接入服务（50080 端口），实现 HTTPS 私有 CA 方案，完成 v1→v4 数据库迁移，接入团油燃油报价能力。
5. **iOS OCR 原型开发**（7/23-7/24）：完成 StationOCRCore 解析器、高德双列卡片解析器、ContentView 框架，确认 ScreenCaptureKit 路线（ReplayKit 已弃用），但缺 Xcode 27 和签名身份无法生成真机 IPA。
6. **主产品增量同步**（7/23-7/24）：实现本地主产品（data_for_didi）增量游标拉取适配器，安全 token-file 同步，SQLite v8 合并，开关保持关闭。

**最终状态**：完整闭环为"阻断"状态 —— 三项外部条件（手机录屏授权、172 SSH 可达、iOS 构建环境）均未满足。

---

## 二、关键决策清单

### 2.1 测试边界与安全规则

| 决策 | 原因 |
|------|------|
| 所有外链测试请求必须从 172.23.25.54 发起，本机仅允许静态分析、离线 OCR、Mock、Fixture 和 HAR 解析 | 用户明确要求，作为硬性安全边界 |
| 47 节点仅作为受控网络出口，不能代替 172 发起测试 | 47 代理有白名单限制，且用户要求测试必须从 172 发起 |
| 测试脚本遇到风控码 100003 或 challenge 立即停止，不做绕过 | 安全测试规则，保留证据 |
| 本地 AVD 模拟器不得联网运行高德进行目标测试 | 外链测试只能在 172 上进行 |
| 高德测试分三条线（界面采集、接口行为、签名风控），不应直接套用滴滴结论 | 滴滴的跨包签名能力不能直接推广到高德 |

### 2.2 架构与部署策略

| 决策 | 原因 |
|------|------|
| 47 服务器不再做透明转发，而是直接作为一等数据源节点负责 MySQL 落库 | 用户明确指示 47 已有 MySQL，本地主产品以 47 为数据源之一 |
| 47 接入服务使用独立的两套 Token 鉴权：X-Mobile-Token（写入）+ X-Source-Sync-Token（增量读取） | 分离写入和读取权限，防止客户端越权访问其他接口 |
| 移除 172 服务器在部署和验收链路中的依赖，改为 APK/Agent 直连 47 服务器 | 172 与 APK 回传链路无关，之前错误地将从 172 验证 47 的脚本当成了部署前置 |
| 47 固定使用 50080 单端口接收所有 Agent 数据，通过 sourceAgent + deviceSessionId + Idempotency-Key 区分来源 | 用户要求端口在 50080-50200 范围内，单端口简化管理 |
| 放弃 Let's Encrypt 公网证书方案，改用私有 CA + 自签名证书 | Let's Encrypt 验证节点无法从公网访问 47 的 80/443 端口（云安全组/CSP 入口策略拦截） |
| Nginx 在 50080 提供 HTTPS 反代，Node 收口到 127.0.0.1:50081 | Node 服务不直接暴露公网，减少攻击面 |
| 私有 CA 叶子证书 397 天自动轮换，APK 不需随叶子证书续期 | APK 仅内置 CA 根证书，叶子证书变更对客户端透明 |
| Android Release 版本仅对 47.111.139.230 开放定向 HTTP 明文例外，Debug 版本允许本地 HTTP 调试 | 受控过渡期允许 HTTP，正式部署后切换 HTTPS 并删除该例外 |
| MySQL 迁移账号和运行账号强制分离，迁移账号执行 DDL，运行账号仅 SELECT/INSERT 最小权限 | 安全隔离要求，避免权限滥用 |
| 运行账号与数据库迁移账号强制分离 | 安全最佳实践，避免权限滥用 |
| 迁移器对 MySQL 8 的 information_schema 大写列名增加显式小写别名兼容 | MySQL 8 返回大写字段标签，迁移器按小写键读取导致误判所有列缺失 |
| 迁移器将外键 NO ACTION 规范化为 RESTRICT | MySQL/InnoDB 两者语义等价 |
| 迁移器增加 shared-db-owner 模式：只有同库、同账号并在 migration 配置显式开启时才允许 | 适配用户只提供一个非 root 库账号 whay 的场景 |
| installer 必须同时更新进新的 candidate 和 same-manifest rollback，不能只改 /etc/systemd/system | 确保回滚路径一致，避免回滚后 unit 配置与代码不匹配 |
| metadata v4 后禁止回退到旧的 v2/v3 bits | 防止数据兼容性问题 |

### 2.3 Android OCR App 产品决策

| 决策 | 原因 |
|------|------|
| 应用名称从"场站OCR回传"改为"信息自动识别" | 用户要求不暴露采集目的 |
| 不增加悬浮窗权限，使用系统前台通知反馈状态 | 避免新增权限申请，降低用户负担 |
| 不将 VPN/证书代理塞入 APK，流量读取方案作为独立模块 | VPN 会改变系统配置和安全边界 |
| 未开启无障碍时支持纯手动下滑模式，自动下滑失败回退到手动监听 | 无障碍是 Android 强制权限流程，不能自动绕过 |
| 录屏组件全部就绪后才自动最小化，15 秒未就绪保持前台并提示失败 | 避免应用缩到后台但实际没有录屏 |
| 小范围像素变化使用容差判断，不再丢弃整屏 OCR | 原全屏哈希一致要求过于严格，时钟动画即卡住 |
| 首帧跳过本应用自身页面和系统授权页面 | 避免识别器递归扫描自己的结果列表 |
| OCR 状态与回传状态在通知中分开显示 | 避免回传失败被误解为 OCR 没有工作 |
| 自页面隔离修复优先级高于价格解析扩展 | 自反馈污染是价格缺失的主因，需先停止污染再补规则 |
| 上传任务从 OCR 采集服务解耦，改用独立后台 WorkManager 任务续传 | 旧实现遇到第一批失败就停止整轮上传形成队头阻塞，且停止识别后上传线程也停止 |
| 回填数据必须服务端严格确认落库后才从手机删除，47 不可达时绝不删除 | 避免 47 不可达时丢数据 |
| 默认只上传结构化场站数据，原始 OCR/截图诊断上传改为显式开关且默认关闭 | 拆分诊断数据与业务数据，减少误上传风险 |
| Android 安全分区采用统一安全列表，同时控制本地写入和 outbox，敏感项零写入 | 解决单条敏感记录连带同屏安全记录只落本地不生成任务的问题 |
| 展示页不改变本地快照或回传数据，只合并同一场站多次快照为最新一张卡片 | 用户只关心最新结果，后端保留完整采集历史 |
| 验收优先级：先确保不自识别、不串价，再补充新格式，不放宽到误识别停车费 | 保证现有价格不回归，最后验证新增格式和双列不串价 |

### 2.4 燃油报价（团油）决策

| 决策 | 原因 |
|------|------|
| 加油类型使用独立 fuelOffers 模型，不混充电电价和枪数字段 | 团油数据直接塞进充电模型会被丢弃或误处理 |
| 47 capability 门禁：客户端通过 /health 检查 schema v2 和 fuel 类型支持后才上送燃油数据 | 47 没有升级到燃油 v2 能力前，燃油数据留在本机，不给旧接口假回执 |
| 旧充电记录保持原身份键，新燃油记录使用类型化身份（含 stationType） | 否则同名充电站和加油站会被合并，但已有 15 条充电数据不能直接重算 |
| 本轮迭代采用零自动点击方案，用户手动切换油号/金额，APK 只读 OCR | 产品文档明确边界为不自动点击 |
| fuel-quote-v1 feature 在 47 部署后仍保持关闭，待短时开启测试后决定是否保留 | 避免影响现网链路，先完成部署和验证后再决定 feature 开关 |
| 燃油扩展数据在 feature 关闭时也需生成持久 deferred 队列任务 | 避免能力开启后历史数据无法自动回传 |

### 2.5 iOS 开发决策

| 决策 | 原因 |
|------|------|
| iOS 不再使用弃用的 ReplayKit Broadcast Extension，改为 ScreenCaptureKit SCContentSharingPicker | Apple 官方文档确认 RPBroadcastSampleHandler 已弃用，ScreenCaptureKit 取代它 |
| iOS 高德场景使用双列隔离解析器，不依赖 ScreenCaptureKit | ScreenCaptureKit 在 iOS 26 上需要 Broadcast Extension 且权限受限 |
| iOS 端不猜测 UIBackgroundModes 中 ScreenCaptureKit 的专用键值，需由完整 Xcode 26 生成 | Apple 公开文档尚未列出对应值，禁止写入 audio/processing 等猜测值 |

### 2.6 开发流程决策

| 决策 | 原因 |
|------|------|
| 多 Agent 协作模式（主 Agent + 实现代理 + QA 代理 + 产品审查代理）分工迭代 | 开发和只读审查分离，实现代理专注代码，QA 代理独立复核，主 Agent 做最终决策 |
| 新建临时验证脚本而非修改现有批量脚本 | 现有脚本包含直连和伪造 sec dd 逻辑，不适合受控验证 |
| Candidate 与 Rollback 强制使用相同 SHA-256 release manifest | 确保回滚安全 |
| 部署迁移顺序：172 链路验收 → 开启主产品同步 → 客户端使用 | 47 energy_price 已迁移到 physical v4，50080→50081 切换已完成 |

---

## 三、代码改动清单（按文件归类，去重）

### 3.1 Android OCR 采集 App

| 文件 | 改动内容 |
|------|----------|
| `mobile/android-ocr-uploader/`（整体） | 包名 `com.datafordidi.ocruploader`，应用名称改为"信息自动识别"；v1.1.0 → v2.0.0(17) 多次迭代 |
| `mobile/android-ocr-uploader/`（v1.3.3） | 隔离本应用页面防止递归识别；精准清理污染记录；支持币符/元起/千瓦时/kWh/分行价格；排除停车费/按小时错误价格；同卡片同列绑定避免双列串价 |
| `mobile/android-ocr-uploader/`（v1.3.4） | 增强真实 OCR 误差解析，修复小数点/币符丢失；支持 1.0849/度、快闲22/25、慢闲6/15 等格式；黑钻价 0.9329 不覆盖主价 |
| `mobile/android-ocr-uploader/`（v1.3.5） | 从 UI/StationRecord/LocalStore/outbox/HTTP payload 中移除 address 字段；历史数据不清空但回传时过滤；同名场站改用内部卡片身份区分 |
| `mobile/android-ocr-uploader/`（v1.3.6） | 展示页重构——顶部采集状态+五项统计、三类筛选、独立场站卡片、底部固定操作按钮、清理确认；修复 15000/度 到 1.5000 几何绑定 |
| `mobile/android-ocr-uploader/`（v1.3.7） | 待补充场站编辑回填：主价格、快/慢/超充闲置数和总数可编辑；新增不可编辑截取时间字段；独立后台 WorkManager 续传任务；严格确认后自动删除 |
| `mobile/android-ocr-uploader/`（v1.3.8） | 新增独立燃油模型 fuelOffers，团油/通用燃油页面识别，本地展示和人工回填 |
| `mobile/android-ocr-uploader/`（v1.3.9） | P0/P1 测试收口（Android 111/111、后端 236/236） |
| `mobile/android-ocr-uploader/`（v1.4.0） | 修复 token 不一致问题，19 个旧批次全部回传入库，隐藏配置通过 Keystore 保护 |
| `mobile/android-ocr-uploader/`（v1.5.0） | 支持团油、高德燃油三类价格、CP、优惠、服务费和预计实付 |
| `mobile/android-ocr-uploader/`（v2.0.0） | 地址恢复、nullable 枪数、全链路 v3 payload；安全分区统一安全列表；新增敏感检测（赋值型 token、API key、secret、password）；收敛证据字段 |
| `mobile/android-ocr-uploader/app/src/main/java/com/datafordidi/mobilecollector/CaptureOcrService.java` | 使用 47 端点和端内展示 |
| `mobile/android-ocr-uploader/app/src/main/java/com/datafordidi/mobilecollector/LocalStationStore.java` | 支持端内结果展示 |
| `mobile/android-ocr-uploader/app/src/main/java/com/datafordidi/mobilecollector/SyncClient.java` | 指向 47 端点；实现原始 OCR 诊断上传开关 |
| `mobile/android-ocr-uploader/app/src/main/res/xml/network_security_config.xml` | 新增，仅对 47.111.139.230 开放明文 HTTP 例外 |
| `mobile/android-ocr-uploader/app/src/test/java/com/datafordidi/mobilecollector/DidiLocalStationParserTest.java` | 修复 `localIdentityIgnoresAddressEnrichmentButSeparatesCities` 测试 |
| `mobile/android-ocr-uploader/app/build/outputs/apk/debug/` | 各版本 APK 构建产物 |

### 3.2 iOS 端

| 文件 | 改动内容 |
|------|----------|
| `mobile/ios/Sources/StationOCRCore/StationParser.swift` | 修复 OCRRow 结构体属性名（xCenter→x, yCenter→y） |
| `mobile/ios/Sources/StationOCRCore/AmapTwoColumnParser.swift` | 新增高德双列卡片隔离解析器 |
| `mobile/ios/DataForDidiOCRApp/CollectedStation.swift` | 新增 CollectedStation 模型、CredentialStore 密钥存储、StationSyncClient 同步客户端 |
| `mobile/ios/DataForDidiOCRApp/ContentView.swift` | 集成 StationOCRCore 模块 |
| `mobile/ios/Tools/main.swift` | 新增 parser-smoke 工具，后改为 main.swift 并添加 import StationOCRCore |
| `mobile/ios/project.yml` | 添加 Info.plist 中 CFBundleURLTypes/NSAppTransportSecurity 等配置 |
| `mobile/ios/` | 补全构建基础设施：App Target、测试 Target、共享 Scheme、Entitlements、XcodeGen 漂移校验 |
| `mobile/ios/Tools/run_smoke.sh` | 补回执行位 |

### 3.3 后端服务

| 文件 | 改动内容 |
|------|----------|
| `backend/services/mysql-mobile-source-store.js` | 新增 MySQL 连接池、事务写入、幂等判断、增量列表；增强健康检查与 schema 校验 |
| `backend/services/mobile-source-node-service.js` | 新增请求校验、字段规范化、幂等种子构建 |
| `backend/services/mobile-source-auth.js` | 新增 timing-safe 机器身份认证中间件 |
| `backend/mobile-source-node.js` | 新增 Express 应用（/health、/api/mobile-sync/stations、/api/source-sync/stations） |
| `backend/scripts/start-mobile-source-node.js` | 新增入口脚本和 migrate-mobile-source-mysql.js 迁移入口 |
| `backend/services/remote-mobile-source-sync.js` | 新增本地产品增量游标拉取适配器 |
| `backend/services/mobile-source-mysql-migrator.js` | 新增 MySQL 迁移逻辑（v2→v4），支持可重入升级、advisory lock、逐项检查、information_schema 大写列名兼容、shared-db-owner 模式 |
| `backend/routes/mobile-source-sync.js` | 新增同步 Router |
| `backend/services/remote-executor.js` | 新增 172 远程节点执行服务 |
| `backend/services/fuel-ocr-confidence.js` | 新增 OCR 置信度计算服务 |
| `backend/services/fuel-payload-policy.js` | 新增燃油载荷策略服务 |
| `backend/database/init.js` | 新增 v4/v5 迁移，添加 sourceAgent/sourceNode/sourceType 字段 |
| `backend/database/migrations.js` | 版本化迁移补齐旧库 |
| `backend/models/station.js` | 适配新版报价字段和 v3 契约 |
| `backend/services/station-export-service.js` | 导出新增 sourceAgent 等字段 |
| `backend/index.js` | 集成 RemoteMobileSourceSync 和 mobile-source-sync 路由 |
| `backend/package.json` | 添加 mysql2 依赖，overrides body-parser 版本，新增迁移/启动脚本 |

### 3.4 测试文件

| 文件 | 改动内容 |
|------|----------|
| `backend/test/mobile-source-node.test.js` | 新增节点测试 |
| `backend/test/mysql-mobile-source-store.test.js` | 新增 MySQL 存储测试 |
| `backend/test/remote-mobile-source-sync.test.js` | 新增远程同步测试 |
| `backend/test/mobile-source-store.test.js` | 新增跨层写入/增量读取/重复拉取测试 |
| `backend/test/station-storage.test.js` | 修复 sourceAgent 字段预期 |
| `backend/test/database-migration-cli.test.js` | 修复 schema 版本预期字符串（v3→v4） |
| `backend/test/fixtures/cross-platform-ocr-evidence-matrix.json` | 新增机器可读证据矩阵 |
| `backend/test/cross-platform-ocr-completion-audit.test.js` | 新增独立审计门禁测试 |

### 3.5 前端

| 文件 | 改动内容 |
|------|----------|
| `frontend/public/station-presentation-control.js` | 展示 sourceAgent 来源 |

### 3.6 数据库与资源文件

| 文件 | 改动内容 |
|------|----------|
| `backend/resources/mysql/mobile-ocr-source-v1.sql` | 新增 MySQL schema 定义（采集批次表+场站快照表+幂等键） |
| `backend/resources/mysql-mobile-source-store.sql` | 更新增加移动端数据源批次表和场站快照表 |
| `backend/resources/mysql/README.md` | 新增部署文档 |

### 3.7 部署脚本

| 文件 | 改动内容 |
|------|----------|
| `scripts/install-47-mobile-source-systemd.sh` | 新增 systemd 部署；修复 ENV_FILE 变量复用问题；P0 热修 ExecStart 显式传入 ROOT；ENV_FILE 续修三类 unit 绑定 |
| `scripts/run-47-mobile-source-foreground.sh` | 新增 foreground 部署脚本 |
| `scripts/verify-47-mobile-source.js` | 新增 47 接入 API 端到端验证脚本 |
| `scripts/run-47-mobile-source-migration.sh` | 补回迁移 runner 执行位 |
| `backend/mobile-source-runtime/package.json` | 新增部署运行时目录及独立 package.json |

### 3.8 文档

| 文件 | 改动内容 |
|------|----------|
| `docs/WORKFLOW-didi-secdd-bootstrap-authentication-172-v1.0.md` | 新增第 9 节记录 2026-07-14 实际执行结果 |
| `docs/WORKFLOW-didi-xian-45-mobile-ua-172-v1.0.md` | 新增 9.6 节记录 2026-07-14 后续定位结论 |
| `docs/WORKFLOW-mobile-cross-platform-ocr-agent-v1.0.md` | 更新说明 47 不再做 relay 而是一等数据源 |
| `docs/WORKFLOW-cross-platform-screen-ocr-agent-v2.0.md` | 跨平台 OCR 工作流文档 v2.0 设计完成 |
| `docs/WORKFLOW-cross-platform-ocr-completion-audit-v1.0.md` | 新增完成度审计工作流文档 |
| `docs/WORKFLOW-amap-tuanyou-fuel-quote-v1.0.md` | 更新工作流文档 |
| `docs/WORKFLOW-staging.md` | 新增交付记录 |
| `.env.example` | 添加 MOBILE_SOURCE_* 系列配置项 |

### 3.9 新增验证脚本（临时）

| 文件 | 改动内容 |
|------|----------|
| `scripts/didi-secdd-bootstrap-validation.js` | 新增验证脚本（git 未跟踪） |
| `data/validation-results/didi-secdd-bootstrap-20260714T023838Z.json` | 新增脱敏证据文件 |

### 3.10 远端文件

| 文件 | 改动内容 |
|------|----------|
| server-47: `/etc/tinyproxy/tinyproxy-noauth.conf` | 备份并临时修改白名单，验证后恢复 |
| server-172: `/private/tmp/didi-secdd-bootstrap-validation.js` | 远端执行脚本，验证后清理 |
| 47 服务器: `/opt/data-for-didi-mobile-tls/` | 私有 CA bootstrap 和证书自动续期脚本 |
| 47 服务器: XP Nginx 配置 | 50080 改为 HTTPS 反代到 127.0.0.1:50081 |
| 47 服务器: `/opt/data-for-didi-mobile-source-releases/` | v4 候选发布包（952 项 manifest） |
| 主产品: `/Users/didi/fyl/data_for_didi/` | 增加安全 token-file 支持 |

---

## 四、关键发现与结论

### 4.1 风控机制发现

| 发现 | 详情 |
|------|------|
| 滴滴充电风控返回特征 | 单中心点深翻页触发业务码 `100003`（"命中风控，请重新登录"），不是 HTTP 403/501，而是 **HTTP 200 + 业务码** |
| 首个请求即被风控 | 172 服务器 45 次变 UA 测试中，首个西安请求即返回 HTTP 200 + 业务码 100003，脚本按停止条件终止 |
| 172 出口 IP 已被风控标记 | 即使更换 UA（23 Android + 22 iOS），首个请求即命中风控，说明出口 IP 已被标记 |
| 代理白名单导致 403 | 首次 172 测试返回 HTTP 403 非滴滴返回，是 47 Tinyproxy 直接拒绝；恢复白名单后请求正常到达滴滴 |

### 4.2 签名能力发现

| 发现 | 详情 |
|------|------|
| 签名能力分布 | 分布在两套滴滴生态小程序包中：滴滴充电业务包(`wx22fd4ba1870645ba`) + 滴滴出行共享签名模块(`wx8a0e2a2c22cdaa0e`) |
| 实际采用跨包组合 | 测试采用跨包组合方案，签名能力不能独立存在 |
| 120 字符 secdd-authentication | bootstrap 初始化成功时，响应头下发 120 字符 secdd-authentication，是非 UA 的设备/会话风险认证材料 |
| 认证值续传是关键 | 此前直接请求 stationList 返回 100003 的关键差异：脚本虽调用了 initSign 但未执行 DCLG 初始化请求，未将响应下发的 120 字符认证值续传到业务请求 |
| 认证值不可视为硬件指纹 | 该 120 字符值更准确描述是设备及运行环境信号被 SDK/服务端封装在 opaque 认证值中，不可视为可独立导出的原始硬件指纹 |

### 4.3 抓取结果数据

| 数据集 | 数量 | 时间 |
|--------|------|------|
| 西安去重场站 | 319 条 | 2026-07-09 在线 SDK 批测 |
| 广州去重场站 | 311 条 | 2026-07-09 在线 SDK 批测 |
| 武汉去重场站 | 305 条 | 2026-07-09 在线 SDK 批测 |
| 主产品 SQLite 总记录 | 6249 条场站，11 份报告 | 截至 07/24 |
| 主产品 source_agent | 全部为空（47 数据尚未合并） | 同步开关关闭 |

### 4.4 47 服务器状态

| 项目 | 结论 |
|------|------|
| 服务器基线 | Ubuntu 24.04，MySQL 8.0.35 |
| 最终数据 | 19 个批次、45 条场站快照、2 条燃油报价 |
| 数据库 | energy_price 库，physical v4，字段和 quote 表正确 |
| 接入服务 | 50080 HTTPS → 127.0.0.1:50081 Node，/health 报告 schemaVersion 3（最终修复后） |
| 私有 CA | SHA-256: `ae740a888bfef54c3f94f6f76d76484655cd6932bb49e73c6928c2aefe6c4708`，OpenSSL 验证通过 |
| whay 账号 | energy_price 库 ALL PRIVILEGES（库级 owner，非全局权限） |
| 安装脚本最终 SHA-256 | `49a67ecb9497e9be09bbba005a0507fc703f2909dd745d571a98ab63a91921e1` |

### 4.5 Android OCR App 关键发现

| 发现 | 详情 |
|------|------|
| 自页面递归污染 | 297 条记录中 295 条价格为空，原因是应用把自己的结果页当作目标页面继续 OCR，产生大量无价格的递归污染数据 |
| 价格缺失根因 | 297 条记录中仅 2 条有价格，主因是识别器递归扫描自己的结果列表；小米实际运行的是旧版 v1.3.2 而非仓库新版 |
| OCR 损伤 | OCR 将 1.0529/度 识别为 10529 度，小数点/币符/快慢标签被破坏 |
| 录屏授权失效 | 小米真机录屏授权无法通过 ADB 静默完成，MIUI 立即返回取消，必须由用户手动点击"立即开始" |
| MediaProjection 空指针 | MediaProjection=null 但前台服务仍显示运行约 26 分钟，通知误导用户以为 OCR 在正常工作 |
| 明文 HTTP 拦截 | Android targetSdk=35 默认拒绝明文 HTTP，APK 配置的 47 HTTP 地址被系统拦截，所有回传失败 |
| 最终验证 | v1.3.6 真实样本回归测试通过：1.0849(快枪22/25,慢枪6/15)、1.1029(慢枪12/12)、1.0529(快枪9/10)、黑钻价0.9329不覆盖主价 |
| 测试结果 | Debug/Release 各 173 项测试通过，lint 0 问题，双 APK 构建通过 |

### 4.6 团油/燃油关键发现

| 发现 | 详情 |
|------|------|
| 团油签名同构 | 团油 sign() 与快电同构：MD5(appSecret+sorted(kv)+appSecret).toLowerCase() |
| 团油公共参数 | buildSignedParams() 注入 app_key/timestamp/token/shumeiID/fromScanCode/mp_version |
| 云快充映射 | mapStation() 将 terminalCount 映射为各类型枪口(type1=super/type2=fast/type3=slow) |
| 团油页面字段 | 可获取 90/92/95/98/101/甲醇/柴油负号及 CNG/LNG/LPG 等多油号 |
| 服务费缺失根因 | 文档复审发现团油 parser 主动排除了服务费/实付/支付关键词，是之前识别不到服务费的根本原因 |

### 4.7 测试结果汇总

| 测试套件 | 结果 | 备注 |
|----------|------|------|
| 后端全量测试 | 236/236 → 273/273 → 293/293 | 随时间增长 |
| 47 节点测试 | 51/51 通过 | 含 v2 燃油 |
| API v3 契约测试 | 24/24 通过 | 后端 API |
| Android 单元测试 | 76/76 → 142/142 → 173/173 | 随时间增长 |
| iOS smoke test | 通过 | StationOCRCore parser, 高德双列 |
| 前端 browser check | 3 个 viewport + 5 个主路由 | 全部通过 |
| npm audit | 0 漏洞 | JS 语法检查 270 个文件全部通过 |
| 本地链路回归 | 91/91 通过 | Android/iOS → 47 v3 → MySQL → SQLite v8 |
| MySQL 迁移测试 | 13/13 通过 | 含 14 个 alias 锁定测试 |
| CA/token 定向测试 | 40/40 通过 | Node 22 定向 25/25，Node 24 全量 293/293 |

### 4.8 iOS 环境状态

| 项目 | 状态 |
|------|------|
| Xcode | 缺失，仅安装 Command Line Tools |
| iPhone SDK | 缺失 |
| 签名身份 | 无 |
| Swift 工具链 | Swift 6.1 与已安装 6.2 SDK/llbuild 不兼容，无法完成类型检查 |
| 真机 | 无已连接 iPhone |
| 关键缺口 | URLSession 不信任 47 私有 CA（P0）、token 仅支持 MDM Managed App Configuration（P0）、ScreenCaptureKit observer 清理缺口（P1） |

### 4.9 172 服务器状态

| 项目 | 状态 |
|------|------|
| SSH 172.28.170.239:22 | 持续在握手前超时（连续多轮） |
| SSH 端口 2222 | 隧道在线，但本机两把密钥均未获远端 root 授权 |
| 50103 端口 | 目标无法确认，两端口主机指纹不同，不做盲试 |

---

## 五、待办事项（去重后按优先级排序）

### P0 — 阻塞项

1. **用户需在小米手机上手动点击"开始识别"并确认整屏共享**，建立系统录屏会话，完成真实页面 OCR 验收（滴滴/高德/团油真实页面验证名称/价格/枪闲忙数等字段）
2. **恢复 172 服务器 SSH 非交互登录**（端口 2222 对应账户补一次公钥授权），用于端到端链路验收
3. **iOS 安装 Xcode 27、创建签名身份、安装描述文件、连接 iPhone 或使用 MDM 分发**，完成真机构建
4. **修复 iOS URLSession 不信任 47 私有 CA 的问题**（P0）
5. **支持 iOS MDM Managed App Configuration 获取 token**（P0）

### P1 — 高优

6. **链路验收通过后，开启主产品 mobile-source-sync 开关**（enabled: true），完成 47→主产品真实数据合并验证（source_agent 当前全为空）
7. **修复 iOS ScreenCaptureKit picker 取消时 observer 清理缺口**（P1）
8. **修复 LocalStore+Outbox 写入原子性缺口**，引入 journal 事务机制，在真实断网/进程恢复场景下验证抗崩溃能力
9. **将 whay@% 权限收口为 whay@127.0.0.1 且仅保留 SELECT, INSERT**，轮换 whay 密码

### P2 — 中优

10. **完成 172→47 v3 verifier 和真实 MySQL ACK/游标验收**
11. **考虑为 phpMyAdmin 查询另建 viewer@localhost 只读账号**
12. **data_test 工作区启用 .env 同步配置**，使本地开发环境接入 47 数据源
13. **47 正式接入需在生产环境切换 HTTPS**，并执行设备令牌轮换和 MySQL 最小权限账号确认
14. **短时开启 fuel-quote-v1 feature 测试**，执行燃油报价合成链路后关闭
15. **更新工作流远端证据与回滚状态**

### 已完成/已处理

- 172 服务器 45 次不同 UA 的西安滴滴充电请求测试（被风控中断，仅完成 1 次即返回 100003）— 已执行
- 47 代理原白名单配置恢复 — 已恢复（SHA-256 一致）
- Bootstrap 初始化链路验证 — 已完成（7/14 成功验证）
- 47 MySQL 接入服务部署 — 已完成（v4 迁移，50080 HTTPS）
- Android APK 覆盖安装 — 已完成（v2.0.0 至小米手机，45 条历史保留）
- 数据从独立库迁移至 energy_price — 已完成（三张表哈希一致，3/3）
- 迁移器重写为可重入升级 — 已完成（advisory lock、逐项检查）
- 47 私有 CA 证书签发与配置 — 已完成（50080 HTTPS）
- 旧 mobile-relay.py 降级为迁移期兼容组件 — 已完成