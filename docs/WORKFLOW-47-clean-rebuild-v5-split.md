# 47 服务器全清重建流程（充电/加油拆表 v5）

> 关联：`docs/WORKFLOW-charging-fuel-table-split-v1.0.md`
> 日期：2026-07-24
> 前提：47 现有 `mobile_ocr_*` 数据可全部丢弃（19 批次/45 快照/2 燃油报价）

## 1. 背景

充电/加油拆表后，47 的 `mobile_ocr_*` 表结构发生变化（新增充电/燃油拆分表 + 全局游标表，子表 FK 改指向）。由于 47 现有数据可丢弃，采用**全清重建**而非数据迁移：DROP 所有 `mobile_ocr_*` 表，依次跑 v4 + v5 迁移从零建表。

## 2. 迁移顺序

```
v4 物理迁移 (migrate-mobile-source-mysql.js)
  → 建 batches / station_snapshots(旧) / fuel_offers / fuel_quotes
v5 拆表迁移 (migrate-mobile-source-split.js)
  → 建 charging_snapshots / fuel_snapshots / source_record_cursor
  → 重建 fuel_offers/fuel_quotes 的 FK 指向 fuel_snapshots
```

`scripts/run-47-mobile-source-migration.sh` 已配置为自动依次跑 v4 → v5。

## 3. 全清重建步骤

### 3.1 SSH 到 47

```bash
ssh root@47.111.139.230
cd /opt/data-for-didi-mobile-source
```

### 3.2 停止写入服务

```bash
systemctl stop data-for-didi-mobile-source.service
```

### 3.3 全清 mobile_ocr_* 表

```bash
mysql -u <migration_user> -p energy_price <<'SQL'
SET FOREIGN_KEY_CHECKS = 0;
DROP TABLE IF EXISTS mobile_ocr_fuel_quotes;
DROP TABLE IF EXISTS mobile_ocr_fuel_offers;
DROP TABLE IF EXISTS mobile_ocr_station_snapshots;
DROP TABLE IF EXISTS mobile_ocr_ingest_batches;
DROP TABLE IF EXISTS mobile_ocr_schema_migrations;
-- v5 新表（若残留）
DROP TABLE IF EXISTS mobile_ocr_source_record_cursor;
DROP TABLE IF EXISTS mobile_ocr_charging_snapshots;
DROP TABLE IF EXISTS mobile_ocr_fuel_snapshots;
SET FOREIGN_KEY_CHECKS = 1;
SQL
```

### 3.4 部署最新代码到 47

将含 v5 拆表改动的代码部署到 `/opt/data-for-didi-mobile-source`（含 `backend/services/mobile-source-split-migrator.js`、`backend/scripts/migrate-mobile-source-split.js`、更新后的 store 等）。

### 3.5 跑迁移（v4 → v5）

```bash
# plan 预览
bash scripts/run-47-mobile-source-migration.sh --plan

# apply 执行
bash scripts/run-47-mobile-source-migration.sh --apply
```

预期输出：
```
mobile-source MySQL schema v4 migration passed
mobile-source split schema v5 migration passed
```

### 3.6 校验

```bash
bash scripts/run-47-mobile-source-migration.sh --validate-only
```

### 3.7 启动服务 + health 检查

```bash
systemctl start data-for-didi-mobile-source.service
curl -k https://47.111.139.230:50080/health
```

`/health` 应返回 200，`schemaVersion` 反映 v5。

## 4. 验收

- `mobile_ocr_charging_snapshots` 存在，含 ports 列（NULLable）
- `mobile_ocr_fuel_snapshots` 存在，**无 ports 列**
- `mobile_ocr_source_record_cursor` 存在
- `mobile_ocr_fuel_offers.fk_mobile_ocr_fuel_offer_snapshot` 指向 `mobile_ocr_fuel_snapshots`
- `mobile_ocr_fuel_quotes.fk_mobile_ocr_fuel_quote_snapshot` 指向 `mobile_ocr_fuel_snapshots`
- 旧表 `mobile_ocr_station_snapshots` 保留（v4 仍建），但 store 不再读写

## 5. 回滚

若 v5 迁移失败：
1. 停服务
2. DROP v5 新表（charging_snapshots/fuel_snapshots/source_record_cursor）
3. 恢复 fuel_offers/fuel_quotes FK 指向 station_snapshots
4. 部署回退到 v4 代码
5. 跑 `migrate-mobile-source-mysql.js --validate-only` 确认 v4 完整

## 6. 注意

- v5 迁移器用独立 component `mobile-ocr-source-split`，与 v4 的 `mobile-ocr-source` 版本记录隔离，互不干扰。
- v5 要求 v4 先跑（`mobile_source_split_requires_v4`）。
- 全清重建后客户端游标需重置为 0（数据量小，全量重拉）。
