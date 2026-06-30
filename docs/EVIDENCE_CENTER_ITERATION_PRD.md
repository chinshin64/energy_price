# 证据中心迭代产品方案

日期：2026-06-08

## 第一步：需求分析

### 业务背景

风控蓝军测试系统已完成工程可运行性（阶段 A/B），但证据中心仅落地 1 条蓝军报告，且证据断裂：evidenceRefs 只写引用名无实际文件、无前端页面、无复测入口、API 不完整。当前系统处于"能采集但无法归档、能记录但无法复核"的状态。

### 目标用户

| 角色 | 核心诉求 |
|------|----------|
| 安全蓝军测试人员 | 采集后一键生成报告、证据完整可追溯、失败可复测 |
| 风控审核人员 | 查看报告列表、按条件筛选、下载归档材料 |
| 系统管理员 | 监控报告状态、管理权限、审计操作日志 |

### 现状痛点

1. **报告 API 半成品**：只有 seed/列表/详情/下载 4 个接口，缺少 start/events/evidence/finalize 增量写入能力，无法在测试过程中实时记录
2. **证据与报告断裂**：报告里 evidenceRefs 只写引用名（如 capture-recorder-status），没有指向实际文件，无法复核
3. **前端零页面**：无报告列表、无详情页、无证据查看、无下载入口
4. **复测无闭环**：报告 retestStatus=pending 但没有复测入口和流程
5. **安全风险未修复**：API 零认证、签名语料明文落盘、出站证据脱敏不完整

### 需求价值

- **证据闭环**：从"采集即丢弃"到"采集即归档"，每条报告有完整证据链
- **可复核性**：审核人员可独立查看证据、验证结论、不依赖测试人员口头说明
- **可复测性**：失败报告可一键创建复测，保留原报告引用和复测标准
- **安全基线**：补齐认证、脱敏、审计，满足内部安全合规要求

---

## 第二步：方案设计

### 功能模块设计

#### 模块 1：报告生命周期 API（P0）

| API | 说明 | 优先级 |
|-----|------|--------|
| POST /api/blue-team/reports/start | 创建报告（draft 状态） | P0 |
| POST /api/blue-team/reports/:id/events | 追加事件（step/info/warning/error/city-start/city-end） | P0 |
| POST /api/blue-team/reports/:id/evidence | 追加证据（screenshot/ocr-lines/har-summary/api-request/outbound-evidence/db-check/supervisor-event） | P0 |
| POST /api/blue-team/reports/:id/finalize | 完成报告（聚合结论 + 生成 report.md） | P0 |
| GET /api/blue-team/reports | 列表查询（支持 method/platform/city/status/risk 筛选 + 分页） | P0 |
| GET /api/blue-team/reports/:id | 详情查询（含 findings/evidenceMatrix/events/targets） | P0 |
| GET /api/blue-team/reports/:id/download | 下载报告（json/markdown） | P0（已有） |
| GET /api/blue-team/reports/:id/evidence/:type/:filename | 获取证据文件 | P0 |

#### 模块 2：证据目录规范（P0）

每个报告目录下新建 evidence/ 子目录，按类型组织证据文件：

```
data/blue-team-reports/<reportId>/
  report.json
  report.md
  evidence/
    screenshots/
    ocr-lines.jsonl
    har-summary.json
    api-requests.jsonl
    outbound-evidence.jsonl
    db-check-result.json
    supervisor-events.jsonl
```

#### 模块 3：报告列表页（P1）

- 筛选栏：测试方式、平台、城市、结论状态、风险等级
- 列表项：报告ID、标题、平台、城市数、结论、风险等级、创建时间
- 分页：默认 50 条/页
- 操作：查看详情、下载（JSON/Markdown）、创建复测

#### 模块 4：报告详情页（P1）

- 摘要卡：报告名、编号、测试时间、平台、结论、风险等级、证据完整性
- 城市子结论：每城市独立结论、指标、风险等级（表格）
- 风险发现：编号、等级、标题、影响面、修复建议、复测状态
- 证据矩阵：按类型展示证据状态和引用路径，可点击查看
- 操作区：下载 Markdown/JSON、创建复测、查看原始 report.json

#### 模块 5：复测流程（P1）

| 步骤 | 说明 |
|------|------|
| 创建复测 | 基于原报告一键创建，新报告 retest.parentReportId 指向原报告 |
| 原报告更新 | retest.childReportId 指向新报告，retest.status = in-progress |
| 执行复测 | 新报告走正常 start → events → evidence → finalize 流程 |
| 复测完成 | 新报告 finalize 时，更新原报告 retest.status 为对应子结论 |

#### 模块 6：脱敏选项（P0，核心功能）

| 功能项 | 说明 | 优先级 |
|--------|------|--------|
| 脱敏模式切换 | 前端详情页提供全局脱敏开关，支持脱敏/完整两种模式实时切换 | P0 |
| 查看脱敏 | API 支持 sanitize 查询参数，默认脱敏返回，sanitize=false 返回完整数据 | P0 |
| 下载脱敏 | 下载弹窗支持选择审核版（脱敏）/完整版，完整版记录审计日志 | P0 |
| 脱敏规则 | URL/接口名/参数键名/坐标/IP 等字段的遮蔽规则映射表 | P0 |

> 安全加固（API认证、权限收紧等）暂不纳入本迭代，待测试阶段结束后统一处理。

### 流程设计

#### 报告生成流程

```
测试开始 → POST /reports/start（draft + evidence/）
  → 循环：
      → POST /reports/:id/events（step/city-start/city-end）
      → POST /reports/:id/evidence（按类型写入 + 更新 evidenceMatrix）
  → POST /reports/:id/finalize（结论 + report.md）
```

#### 复测流程

```
原报告详情页 → 点击"创建复测" → POST /reports/:id/retest
  → 新报告（保留 target/methods/scope，清空 findings/events）
  → 原报告 retest.childReportId 指向新报告
  → 新报告走 start → events → evidence → finalize
  → finalize 时更新原报告 retest.status
```

#### 证据引用闭环流程

```
采集链路产生数据 → OutboundClient/OCR/录包服务 写入原始证据
  → POST /reports/:id/evidence 引用原始证据
  → 证据写入 evidence/ 目录 → evidenceMatrix 自动更新
  → finalize 校验证据完整性 → report.md 证据引用指向实际文件
```

### 权限设计

| 操作 | 当前策略 | 后续扩展 |
|------|----------|----------|
| 查看报告 | 本机可访问 | 按角色/部门控制 |
| 创建报告 | API token | 审批后才能创建 |
| 终结报告 | API token | 高风险需二次确认 |
| 创建复测 | API token | 保留原报告审批链 |
| 删除报告 | 暂不开放 | 管理员审批后软删除 |
| 下载证据 | API token | 敏感证据需审批 |

---

## 第三步：安全评估

### 越权风险

- 当前：API 零认证，局域网任意主机可操纵
- 修复：P0 新增 token 校验中间件
- 残留：token 截获风险，后续 HTTPS + 轮换

### 数据泄露风险

- 当前：didi-signature-corpus.json 明文 5.8MB，权限 644
- 修复：P0 收紧为 600，后续加密存储
- 残留：本地 root 仍可读

### 敏感数据访问风险

- 当前：出站证据部分 query key 保留完整值，截图可能含 Token
- 修复：P1 扩展敏感 key 黑名单
- 残留：新证据类型需持续维护脱敏规则

### 审批绕过风险

- 当前：finalize 直接设结论，无确认
- 修复：P1 高风险报告需确认参数
- 残留：无用户体系，仅参数校验

### 接口滥用风险

- 当前：无速率限制
- 修复：P2 基础速率限制（60次/分钟）
- 残留：单机场景风险低

---

## 第四步：研发拆解

| 模块 | 功能 | 前端 | 后端 | 风险等级 |
|------|------|------|------|----------|
| 报告 API | start/events/evidence/finalize | — | 新增 4 路由 + Service 方法 | 中 |
| 报告 API | 列表筛选 + 分页 | — | 新增 SQLite 索引表 + 查询 | 低 |
| 报告 API | 证据文件读取 | — | 路径安全校验 + 文件返回 | 中 |
| 证据目录 | evidence/ 子目录 + 7 类文件 | — | Service appendEvidence 方法 | 中 |
| 报告列表页 | 筛选 + 分页 + 操作 | 新增 reports.html | 复用列表 API | 低 |
| 报告详情页 | 摘要 + 城市子结论 + 证据 + 下载 | 新增 report-detail.html | 复用详情 API | 中 |
| 复测流程 | 创建复测 + 双向引用 | 详情页按钮 | Service createRetest 方法 | 中 |
| 脱敏选项 | 详情页脱敏开关 | 脱敏Toggle组件 + 确认弹窗 | — | 低 |
| 脱敏选项 | 查看场景API脱敏 | — | sanitize查询参数 + sanitizeReport函数 | 中 |
| 脱敏选项 | 下载场景脱敏选择 | 下载弹窗（格式+版本选择） | sanitize参数 + 审计日志 | 中 |
| 脱敏选项 | 脱敏规则映射 | — | INTERFACE_DISPLAY_MAP + SENSITIVE_PARAM_NAMES | 低 |

---

## 第五步：验收标准

| 场景 | 预期结果 | 优先级 |
|------|----------|--------|
| 调用 start 创建报告 | 返回 draft 报告，目录含 report.json + evidence/ | P0 |
| 调用 events 追加事件 | events 数组增长，支持 6 种事件类型 | P0 |
| 调用 evidence 追加证据 | evidence/ 下按类型写入文件，evidenceMatrix 更新 | P0 |
| 调用 finalize 完成报告 | 结论 + report.md + SQLite 索引更新 | P0 |
| 列表按 method 筛选 | 只返回匹配测试方式的报告 | P0 |
| 列表按 city 筛选 | SQLite cities JSON 匹配目标城市 | P0 |
| 详情页脱敏开关 | 默认脱敏模式，切换到完整模式需确认 | P0 |
| 查看 API 脱敏 | sanitize=true 返回脱敏数据，sanitize=false 返回完整数据 | P0 |
| 下载脱敏选择 | 审核版脱敏下载，完整版需确认 + 记录审计日志 | P0 |
| 脱敏规则生效 | URL/接口名/参数键名/坐标/IP 按规则遮蔽 | P0 |
| 报告列表页加载 | 显示报告，支持筛选和分页 | P1 |
| 报告详情页加载 | 摘要 + 城市子结论 + 风险 + 证据矩阵 | P1 |
| 下载 Markdown | 浏览器下载 report.md | P1 |
| 创建复测 | 双向 retest 引用正确 | P1 |
| 复测 finalize | 原报告 retest.status 更新 | P1 |
| v1 报告兼容 | BTR-RISK-20260531-0001 可正常查看 | P1 |
| 出站脱敏切换 | 完整模式下可看到原始参数键名，脱敏模式下只展示计数 | P1 |
| 下载审计日志 | 完整版下载记录操作人、时间、报告ID | P1 |
| 速率限制 | 同 IP 60次/分钟 | P2 |
| 报告删除 | 暂不实现 | P2 |
