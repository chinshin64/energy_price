# 燃油枪数据泄漏修复设计 v1.0

> 状态：设计中，待确认
> 关联：`docs/WORKFLOW-amap-tuanyou-fuel-quote-v1.0.md`、`docs/CODEX_SESSION_NOTES_019f4ab7.md`
> 日期：2026-07-24

## 1. 背景

用户明确领域规则：**加油侧没有"枪数据"（充电桩的 ports/枪数），只有充电侧才有**。

但当前代码中，燃油记录复用了充电的 `common()` 信封，导致燃油记录在采集、存储、展示全链路都携带了 ports/枪口字段。虽然值通常是 0 或缺失，但字段存在、语义错误，前端还会对油站渲染"油枪 / 枪口数据缺失"等无意义 UI。

### 1.1 燃油字段规范（用户确认）

| 字段 | 含义 | 当前归属 |
|------|------|----------|
| 油站名称 | stationName | `FuelStationRecord.stationName` ✓ |
| 油类型 [92/95/98] | 油号 | `FuelOffer.gradeLabel` ✓ |
| 加 200 元时的服务费 | `selectedAmount=200` 场景下的服务费 | `FuelQuote.serviceFee` ✓（已正确，无需改） |
| 外显价格 | displayPrice | `FuelOffer.displayPrice` ✓ |
| cp 名 [可能有] | 服务商 | `FuelStationRecord.providerName` / `FuelOffer.fieldSource` ✓ |
| 优惠价格 | discountPrice | `FuelOffer.discountPrice` ✓ |

> **关于"200元"**：指用户在报价页选择"加 200 元的油"（`FuelQuote.selectedAmount="200.00"`）这个场景，**不是**"200 元的服务费"。该场景下的服务费 = `FuelQuote.serviceFee`（如 `1.34`）。字段已存在且归属正确，本次不改动 `serviceFee`。

### 1.2 充电字段规范（对照）

场站名称、枪数、枪种类、闲忙枪数、分时价格、采集时间。充电侧字段当前正确，本次不改动。

## 2. 现状：三套并存的燃油数据模型

| 模型 | 字段形态 | 链路 | 是否本次改动 |
|------|---------|------|--------------|
| **A. Android 采集** | `FuelOffer`(gradeLabel/displayPrice/discountPrice) + `FuelQuote`(serviceFee/selectedAmount) + `FuelStationRecord` | APK → 47 | 是 |
| **B. 后端 MySQL (新)** | `mobile_ocr_fuel_offers` + `mobile_ocr_fuel_quotes` + `mobile_ocr_station_snapshots` | 47 落库 | 是 |
| **C. 前端主产品 (旧)** | `fuel_92_price`/`fuel_95_price`/`fuel_*_count` 扁平列 | SQLite `stations` 表，由 har-parser/ocr-parser/tuanyou-collector 写入 | 否（独立链路，不在本次范围） |

**模型 C 是独立链路**：`fuel_92_price` 等扁平字段来自主产品 SQLite `stations` 表，与 mobile-ocr-source 的 `fuelOffers` 数组不互通。本次只处理 A/B 链路的枪数据泄漏，不动模型 C。

## 3. 问题清单：燃油"枪数据"泄漏点（10 处）

### 3.1 采集端 (Android)

| # | 文件:行 | 问题 |
|---|---------|------|
| 1 | `StationObservationV3.java:49-60` | `fuel()` 把 `availablePorts/busyPorts/totalPorts` 传进 `common()` |
| 2 | `StationObservationV3.java:124` | `portSemantics` 对燃油写 `"fuel-gun"` |
| 3 | `StationObservationV3.java:187-195` | `validatePorts` 对燃油也做 ports 一致性校验 |
| 4 | `FuelStationRecord.java:13-15` | 燃油模型自身带 `availablePorts/busyPorts/totalPorts` 字段 |

### 3.2 后端

| # | 文件:行 | 问题 |
|---|---------|------|
| 5 | `mobile-source-node-service.js:614` | 燃油默认 `portSemantics='fuel-gun'` |
| 6 | `fuel-ocr-confidence.js:22` | `fuel-gun` 被当合法枪口语义 |
| 7 | `mysql-mobile-source-store.js:104-105` | 燃油 ports 写 `?? 0`（null 强转 0） |
| 8 | `mobile-source-mysql-migrator.js:143-144` | `available_ports/total_ports` 是 `NOT NULL DEFAULT 0` |
| 9 | `mobile-source-mysql-migrator.js:531-535` | schema 校验要求 ports 字段存在 |

### 3.3 前端

| # | 文件:行 | 问题 |
|---|---------|------|
| 10 | `station-presentation-control.js:342-351` | 燃油记录走 `buildGunItems` 渲染"油枪" |

**根因**：`StationObservationV3.fuel()` 复用了充电的 `common()` 信封，该信封强制要求 ports 字段，导致燃油记录被迫携带枪口数据。

## 4. 约束

- `available_ports`/`total_ports`/`fast*/slow*/super*_ports` 是 `INT UNSIGNED NOT NULL DEFAULT 0`（`mobile-source-mysql-migrator.js:143-150`），燃油记录无法写 NULL，当前只能写 0。
- `busy_ports`/`port_semantics` 可空。
- 改列定义为 NULLable 属于 schema 变更（v5 迁移），影响面大，**本次不做**，作为后续可选项。

## 5. 修复方案（本次范围：只改语义，不动 schema）

原则：燃油记录不再产生/消费 ports 语义；DB 列约束所迫仍写 0，但通过 `port_semantics=NULL` 和前端跳过渲染来消除"枪口"语义。

### 5.1 采集端

- **#1 #2 #3**：`StationObservationV3.fuel()` 不再复用带 ports 的 `common()`。新建 `fuelCommon()`：对燃油，`availablePorts/busyPorts/totalPorts` 写 null（payload 层面），`portSemantics` 写 null，`validatePorts` 跳过燃油。
  - 注意：payload 是 JSON，可写 null；约束在 DB 落库层（见 5.2）。
- **#4**：`FuelStationRecord` 移除 `availablePorts/busyPorts/totalPorts` 字段（燃油本就没有枪口）。若有引用，改为不传。

### 5.2 后端

- **#5**：`mobile-source-node-service.js:614` 燃油 `portSemantics` 默认改为 null（不再 `'fuel-gun'`）。
- **#6**：`fuel-ocr-confidence.js:22` 从 `PORT_SEMANTICS` 集合移除 `'fuel-gun'`；燃油记录不参与枪口置信度计算。
- **#7**：`mysql-mobile-source-store.js:104-105` 燃油记录的 `available_ports`/`total_ports` 仍写 0（NOT NULL 约束），但在 `missing_fields` 中标注 `availablePorts`/`totalPorts` 对燃油"不适用"，区别于"缺失"。或：燃油记录不写这两个字段的意义由 `port_semantics=NULL` 表达。
- **#8 #9**：schema 不改（NOT NULL 保留）。迁移器校验逻辑确认燃油记录 ports=0 不报错。

### 5.3 前端

- **#10**：`station-presentation-control.js` 的 `buildGunItems`/`formatGunTypeSummary`：当 `station_type === 'fuel'`（或 `port_semantics` 为 null 且 station_type 为 fuel）时，**整条跳过枪口渲染**，不显示"油枪/枪位/枪口数据缺失"。燃油记录的展示走 `fuel_92_price` 等价格路径（模型 C，已有）。

### 5.4 不改动项

- DB schema（NOT NULL 列保留，避免 v5 迁移风险）
- 模型 C（主产品 `stations` 表的 `fuel_92_price` 扁平字段）
- `FuelQuote.serviceFee` / `selectedAmount`（"200元服务费"已正确归属）
- 充电侧全部字段（已正确）

## 6. 影响面与风险

| 风险 | 说明 | 缓解 |
|------|------|------|
| payload 兼容性 | 燃油 payload 不再带 ports，旧解析端若依赖会断 | 后端 store 对 ports 缺失已有 `?? 0` 兜底 |
| `FuelStationRecord` 字段移除 | 需排查所有引用 | 改动前先 grep 引用点 |
| 前端燃油展示 | 跳过枪口后，燃油记录展示是否完整 | 走 `fuel_92_price` 路径，已有 |
| 测试 | 现有测试可能断言燃油 ports=0 或 `fuel-gun` | 需同步更新测试预期 |

## 7. 验收标准

1. 燃油采集 payload 不含 `availablePorts/busyPorts/totalPorts/portSemantics`（或 ports 为 null、semantics 为 null）。
2. 后端 `mobile_ocr_station_snapshots` 燃油记录 `port_semantics` 为 null，`available_ports/total_ports` 为 0（约束所迫）但 `missing_fields` 标注"不适用"。
3. 前端燃油记录不渲染任何"枪/枪位/枪口"UI。
4. 充电侧字段与展示不受影响。
5. 全量测试通过（后端 + Android + 前端 browser check）。

## 8. 后续可选（不在本次）

- v5 迁移：`available_ports`/`total_ports` 等改为 NULLable，让燃油真正写 NULL。
- 模型 C 与模型 A/B 的统一（主产品 `stations.fuel_92_price` 与 mobile-ocr-source `fuelOffers` 的对接）。

## 9. 待确认

- [ ] 5.2 #7：燃油 ports 在 `missing_fields` 标注"不适用" vs 直接靠 `port_semantics=NULL` 表达，二选一。
- [ ] `FuelStationRecord` 移除 ports 字段是否会破坏本地存储/回传链路（需 grep 排查）。
