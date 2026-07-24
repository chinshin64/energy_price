# 充电/加油分表存储设计 v1.0

> 状态：实施完成（待 47 全清重建部署）
> 关联：`docs/WORKFLOW-fuel-ports-leakage-fix-v1.0.md`（打补丁方案，本方案取代其方向）、`docs/WORKFLOW-amap-tuanyou-fuel-quote-v1.0.md`、`docs/WORKFLOW-47-clean-rebuild-v5-split.md`
> 日期：2026-07-24
>
> **迁移方式决策**：采用 **v5 增量迁移**，保留 v4 迁移器（`mobile-source-mysql-migrator.js`）完全不动。新增独立的 v5 迁移器（`mobile-source-split-migrator.js`，component=`mobile-ocr-source-split`）创建新表 + 切换 FK。47 数据全清重建（不做数据迁移）。
>
> **实施进度**（2026-07-24）：
> - [x] v5 迁移器：`mobile-source-split-migrator.js`（建充电/燃油/游标三表 + 子表 FK 重建 + 校验）
> - [x] store 重写：`mysql-mobile-source-store.js`（ingest 分流写新表 + cursor，listAfter 走全局游标）
> - [x] node-service 燃油语义：`mobile-source-node-service.js`（燃油跳过 ports 校验、portSemantics=null、common 带 ports 被拒）
> - [x] 燃油公开校验：`fuel-ocr-confidence.js` + `fuel-payload-policy.js`（移除 fuel-gun，燃油带 ports 被拒）
> - [x] v5 CLI：`scripts/migrate-mobile-source-split.js` + runner 串联 v4→v5
> - [x] 子表 FK 切换：v5 迁移器重建 fuel_offers/quotes FK 指向 fuel_snapshots
> - [x] Android 采集端：`StationObservationV3.fuel()` 不传 ports、`FuelStationRecord` 移除 ports 字段、`FuelStationParser` 不解析加油枪数
> - [x] 前端：`station-presentation-control.js` 燃油记录跳过枪口渲染
> - [x] 47 全清重建流程：`docs/WORKFLOW-47-clean-rebuild-v5-split.md`
> - [ ] 47 实际部署全清重建（待执行）

## 1. 目标

将当前混合表 `mobile_ocr_station_snapshots` 拆分为充电、加油两张独立表，从 schema 层面消除"燃油记录携带充电 ports 字段"的语义错误。

**领域规则**（用户确认）：
- 充电字段：场站名称、枪数、枪种类、闲忙枪数、分时价格、采集时间
- 加油字段：油站名称、油类型[92/95/98]、加 200 元时的服务费（`FuelQuote.selectedAmount=200` 场景的 `serviceFee`）、外显价格、cp 名[可能有]、优惠价格
- **加油侧无枪数据**

## 2. 现状

### 2.1 当前表结构（混合）

`mobile_ocr_station_snapshots`（`mobile-source-mysql-migrator.js:122-168`）混存：
- 充电字段：`price_fast/slow/super/service`、8 个 `*_ports`、`port_semantics`
- 燃油记录：仅基础信息 + 一堆 ports=0 空字段 + `station_type='fuel'`
- 燃油主数据在子表 `mobile_ocr_fuel_offers`/`mobile_ocr_fuel_quotes`（FK `source_record_id`）

### 2.2 现有数据（47 服务器，真实生产数据）

- 19 个批次、45 条场站快照、2 条燃油报价
- 数据库：`energy_price`，physical v4
- **拆表必须迁移这些数据**

### 2.3 关键依赖点

| 依赖 | 位置 | 拆表影响 |
|------|------|----------|
| INSERT（混写） | `mysql-mobile-source-store.js:104-135` | 分流到两表 |
| `findByIdempotencyKey` | `mysql-mobile-source-store.js:235-253` | JOIN 两表 |
| `listAfter`（增量拉取） | `mysql-mobile-source-store.js:255-315` | UNION 两表 |
| `toSourceRecord` | `mysql-mobile-source-store.js:317+` | 分两路组装 |
| 外键 | `mobile-source-mysql-migrator.js:196,227` | fuel_offers/quotes FK 改指向 fuel 表 |
| 游标 | `remote-mobile-source-sync.js:110-142`，用 `source_record_id` | 两表自增 ID 不连续，需统一游标方案 |
| 主产品 SQLite `stations` 表 | `database/init.js:70-100`，也是混存 | 是否同步拆？见 §6 |
| 测试 | 8 个测试文件 | 需更新 |

## 3. 新表设计

### 3.1 `mobile_ocr_charging_snapshots`（充电专用）

```sql
CREATE TABLE IF NOT EXISTS mobile_ocr_charging_snapshots (
    source_record_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    ingest_batch_id BIGINT UNSIGNED NOT NULL,
    record_index INT UNSIGNED NOT NULL,
    source_node VARCHAR(64) NOT NULL DEFAULT '47-mysql',
    source_agent VARCHAR(64) NOT NULL,
    source_type VARCHAR(32) NOT NULL DEFAULT 'mobile-ocr',
    source_stage VARCHAR(64) NULL,
    platform VARCHAR(64) NOT NULL,
    city VARCHAR(128) NOT NULL,
    station_id VARCHAR(191) NULL,
    station_name VARCHAR(512) NOT NULL,
    address VARCHAR(1024) NULL,
    latitude DECIMAL(10,7) NULL,
    longitude DECIMAL(10,7) NULL,
    price_fast DECIMAL(10,4) NULL,
    price_slow DECIMAL(10,4) NULL,
    price_super DECIMAL(10,4) NULL,
    price_service DECIMAL(10,4) NULL,
    available_ports INT UNSIGNED NULL,        -- 改为 NULLable
    total_ports INT UNSIGNED NULL,
    fast_idle_ports INT UNSIGNED NULL,
    fast_total_ports INT UNSIGNED NULL,
    slow_idle_ports INT UNSIGNED NULL,
    slow_total_ports INT UNSIGNED NULL,
    super_idle_ports INT UNSIGNED NULL,
    super_total_ports INT UNSIGNED NULL,
    busy_ports INT UNSIGNED NULL,
    port_semantics VARCHAR(32) NULL,          -- 充电专用，值如 'charging-gun'
    captured_at DATETIME(3) NOT NULL,
    raw_data JSON NULL,
    provider_name VARCHAR(128) NULL,
    missing_fields JSON NULL,
    quality_status VARCHAR(32) NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (source_record_id),
    UNIQUE KEY uk_charging_batch_record (ingest_batch_id, record_index),
    KEY idx_charging_city_cursor (city, source_record_id),
    KEY idx_charging_platform_cursor (platform, source_record_id),
    KEY idx_charging_agent_cursor (source_agent, source_record_id),
    CONSTRAINT fk_charging_snapshot_batch
        FOREIGN KEY (ingest_batch_id) REFERENCES mobile_ocr_ingest_batches(id)
        ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
```

> 充电表的所有 ports 列改为 **NULLable**（原 NOT NULL DEFAULT 0），从根上消除"0 vs 缺失"的歧义。

### 3.2 `mobile_ocr_fuel_snapshots`（加油专用，无 ports）

```sql
CREATE TABLE IF NOT EXISTS mobile_ocr_fuel_snapshots (
    source_record_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    ingest_batch_id BIGINT UNSIGNED NOT NULL,
    record_index INT UNSIGNED NOT NULL,
    source_node VARCHAR(64) NOT NULL DEFAULT '47-mysql',
    source_agent VARCHAR(64) NOT NULL,
    source_type VARCHAR(32) NOT NULL DEFAULT 'mobile-ocr',
    source_stage VARCHAR(64) NULL,
    platform VARCHAR(64) NOT NULL,
    city VARCHAR(128) NOT NULL,
    station_id VARCHAR(191) NULL,
    station_name VARCHAR(512) NOT NULL,
    address VARCHAR(1024) NULL,
    latitude DECIMAL(10,7) NULL,
    longitude DECIMAL(10,7) NULL,
    provider_name VARCHAR(128) NULL,          -- cp 名
    captured_at DATETIME(3) NOT NULL,
    raw_data JSON NULL,
    missing_fields JSON NULL,
    quality_status VARCHAR(32) NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (source_record_id),
    UNIQUE KEY uk_fuel_batch_record (ingest_batch_id, record_index),
    KEY idx_fuel_city_cursor (city, source_record_id),
    KEY idx_fuel_platform_cursor (platform, source_record_id),
    KEY idx_fuel_agent_cursor (source_agent, source_record_id),
    CONSTRAINT fk_fuel_snapshot_batch
        FOREIGN KEY (ingest_batch_id) REFERENCES mobile_ocr_ingest_batches(id)
        ON DELETE RESTRICT ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
```

> 燃油表**没有任何 ports 列**，彻底干净。燃油价格/报价仍在 `mobile_ocr_fuel_offers`/`mobile_ocr_fuel_quotes`，FK 改指向本表。

### 3.3 子表 FK 调整

- `mobile_ocr_fuel_offers.fk_mobile_ocr_fuel_offer_snapshot` → REFERENCES `mobile_ocr_fuel_snapshots(source_record_id)`
- `mobile_ocr_fuel_quotes.fk_mobile_ocr_fuel_quote_snapshot` → REFERENCES `mobile_ocr_fuel_snapshots(source_record_id)`

### 3.4 旧表处理

`mobile_ocr_station_snapshots` 迁移数据后**保留为只读**（重命名 `mobile_ocr_station_snapshots_deprecated`），不立即 DROP，作为回滚兜底。确认新链路稳定后再清理。

## 4. 游标方案（核心难点）

当前增量同步游标是单表自增 `source_record_id`（`remote-mobile-source-sync.js:110-142`）。拆两表后，两表各自自增，ID 序列不连续，无法直接用单一 `source_record_id` 做全局游标。

### 方案 A：全局游标表（推荐）

新增 `mobile_ocr_source_record_cursor` 维护统一顺序：

```sql
CREATE TABLE IF NOT EXISTS mobile_ocr_source_record_cursor (
    global_seq BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    source_record_id BIGINT UNSIGNED NOT NULL,
    station_type VARCHAR(16) NOT NULL,        -- 'charging' | 'fuel'
    ingest_batch_id BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (global_seq),
    KEY idx_cursor_type_seq (station_type, global_seq)
) ENGINE=InnoDB
```

- 每次 INSERT 充电/燃油 snapshot 时，同步向 cursor 表插一行，`global_seq` 作为全局递增游标。
- `listAfter(afterSeq, limit)` 改为查 cursor 表，按 `global_seq > ?` 取一批，再按 `station_type` 分发到对应表 JOIN 取详情。
- 客户端游标存 `global_seq`（而非 `source_record_id`）。

**优点**：全局有序，增量拉取语义不变；两表写入独立。
**缺点**：多一张表 + 写入多一次 INSERT（可在同事务内）。

### 方案 B：双游标

客户端分别维护 `chargingCursor` 和 `fuelCursor`，`listAfter` 分别查两表后按 `captured_at` 归并。

**缺点**：归并排序复杂、空批次处理麻烦、客户端状态变两份。不推荐。

### 方案 C：保留单表 ID 池

用一张序列表分配 ID，两表共享 ID 池。实现复杂，不推荐。

**采用方案 A。**

## 5. store 重写要点

### 5.1 INSERT 分流

`mysql-mobile-source-store.js` 的 `ingest()` 内，按 `station.stationType`：
- `charging` → INSERT 进 `mobile_ocr_charging_snapshots`，ports 字段允许 NULL
- `fuel` → INSERT 进 `mobile_ocr_fuel_snapshots`（无 ports 列），随后 INSERT offers/quotes
- 两者都在同事务内向 `mobile_ocr_source_record_cursor` 插入游标行

### 5.2 `listAfter` 重写

```
1. SELECT global_seq, source_record_id, station_type
   FROM mobile_ocr_source_record_cursor
   WHERE global_seq > ?
   ORDER BY global_seq ASC LIMIT ?
2. 按 station_type 分组：
   - charging IDs → JOIN mobile_ocr_charging_snapshots + batches
   - fuel IDs → JOIN mobile_ocr_fuel_snapshots + batches + offers + quotes
3. 合并、按 global_seq 排序返回
4. nextCursor = 最后一条的 global_seq
```

### 5.3 `toSourceRecord` 分两路

- `toChargingRecord(row)`：填 ports/price_fast..，无 fuelOffers
- `toFuelRecord(row, offers, quotes)`：无 ports，填 offers/quotes

### 5.4 `findByIdempotencyKey`

UNION 两表统计 first/last source_record_id（或改用 cursor 表）。

## 6. 主产品 SQLite 是否同步拆？

主产品 `stations` 表（`database/init.js:70-100`）也是混存：充电 ports + `fuel_92_price` 扁平列 + `station_type`。

**建议本次不动 SQLite**：
- SQLite 是主产品本地库，schema 改动影响面更大（v8 迁移刚做完）
- 燃油数据从 47 拉取后写入 SQLite 时，可继续用 `station_type='fuel'` + 跳过 ports 写入（保持兼容）
- SQLite 拆表作为后续独立项

**待确认**：是否接受本次只拆 MySQL（47 侧），SQLite 主产品侧暂不动？

## 7. 数据迁移（47 现有数据）

迁移脚本 `migrate-split-charging-fuel-tables.js`，可重入：

```
1. 创建三张新表（charging_snapshots, fuel_snapshots, source_record_cursor）
2. 迁移旧表数据：
   - SELECT * FROM mobile_ocr_station_snapshots WHERE station_type='charging'
     → INSERT INTO mobile_ocr_charging_snapshots（ports NULLable，0→NULL 若 missing_fields 标注）
   - SELECT * FROM mobile_ocr_station_snapshots WHERE station_type='fuel'
     → INSERT INTO mobile_ocr_fuel_snapshots（丢弃 ports 列）
   - 每行同步写 cursor 表
3. 重建 fuel_offers/fuel_quotes 的 FK 指向 fuel_snapshots
   - 因 FK 不能直接改指向，需：建临时无 FK 表 → 拷数据 → 建新 FK 表 → RENAME
4. 校验：行数一致、offers/quotes 的 source_record_id 仍能 JOIN 到 fuel_snapshots
5. RENAME 旧表为 mobile_ocr_station_snapshots_deprecated
```

**回滚**：恢复旧表名，新表保留或删除。

## 8. 测试改动

| 测试文件 | 改动 |
|----------|------|
| `mysql-mobile-source-store.test.js` | INSERT/listAfter/toSourceRecord 改为新表 |
| `mobile-source-mysql-migration.test.js` | 新表 DDL、FK、cursor 表 |
| `mobile-source-end-to-end.test.js` | 端到端分流 |
| `fuel-ocr-confidence.test.js` | 移除 fuel-gun 语义 |
| `verify-47-mobile-source-from-172.test.js` | 验收脚本适配 |
| `station-storage.test.js` | SQLite 侧（若不动则少改） |
| `mobile-source-node.test.js` | node 服务 |
| `database-migrations.test.js` | 迁移版本 |

## 9. 采集端 (Android) 配套改动

- `StationObservationV3.fuel()`：不再传 ports，`portSemantics` 不输出
- `FuelStationRecord`：移除 `availablePorts/busyPorts/totalPorts` 字段
- `FuelPayloadPolicy`：燃油 payload 校验保持禁止充电字段（已有）
- 充电侧 `charging()` 不变

## 10. 前端配套改动

- `station-presentation-control.js`：燃油记录（`station_type==='fuel'`）跳过 `buildGunItems` 枪口渲染
- 充电渲染不变

## 11. 风险与回滚

| 风险 | 缓解 |
|------|------|
| 47 真实数据迁移出错 | 迁移脚本可重入 + dry-run；旧表保留为 _deprecated 兜底 |
| 游标方案 A 引入新表，写入失败导致游标断裂 | cursor INSERT 与 snapshot INSERT 同事务 |
| `listAfter` UNION 查询性能 | cursor 表有索引；批次内 ID 分组后批量 JOIN |
| 子表 FK 重建期间数据不一致 | 维护窗口内执行，停写入 |
| 客户端旧游标（source_record_id）不兼容新游标（global_seq） | 迁移时重置游标为 0，全量重拉一次（数据量小） |

## 12. 实施顺序

1. 迁移器加三张新表 DDL（不删旧表）
2. store 双写（新表 + 旧表）+ cursor 表，查询仍走旧表
3. 数据迁移脚本搬历史数据
4. store 查询切到新表（listAfter/findByIdempotencyKey 重写）
5. 子表 FK 切到 fuel_snapshots
6. 采集端 + 前端配套改
7. 测试全量更新
8. 旧表 RENAME _deprecated，观察后清理

## 13. 已确认决策

- [x] §迁移方式：**v5 增量迁移**，保留 v4 不动，新增独立 v5 迁移器。
- [x] §4：游标采用方案 A（全局游标表）。
- [x] §3.4：旧表保留为 _deprecated 而非直接 DROP。
- [ ] §6：SQLite 主产品侧本次不拆（待实施时确认，当前倾向不动）。
- [ ] §7：迁移期间短暂停 47 写入（数据量小，可接受）。
