# 数据库迁移与回滚

## 运行模式

- 非生产环境默认 `DATABASE_MIGRATION_MODE=apply`，启动时自动应用尚未执行的前滚迁移。
- 生产环境默认 `DATABASE_MIGRATION_MODE=validate`，只接受已达到当前版本且迁移签名一致的数据库。
- 生产存在待迁移版本时服务拒绝启动，不能通过普通业务请求隐式修改表结构。

## 发布步骤

1. 停止旧版本写入流量，确认没有运行中的采集、同步或报告写任务。
2. 查看迁移计划：

   ```bash
   cd backend
   npm run migrate:database
   ```

3. 应用迁移：

   ```bash
   npm run migrate:database -- --apply
   ```

4. 命令会在原数据库旁创建 `*.pre-schema-v<版本>-<时间>.bak`，权限设置为 `0600`。
5. 使用生产配置启动服务，并检查 `/api/readiness` 的 `schemaVersion` 和 `migrationMode=validate`。
6. 验证关键查询、报告读取、设备状态和审计写入后再恢复业务流量。

## 迁移约束

- 已发布迁移不可修改名称、签名或执行内容；任何变更必须追加更高版本。
- 每个版本在 SQLite 事务中执行，失败时不会登记版本，也不会保留该事务内的部分 DDL。
- Model、Service 和 Route 禁止执行 `ALTER TABLE`；DDL 只能位于 `backend/database/migrations.js`。
- `schema_migrations` 与 `PRAGMA user_version` 共同记录应用版本。

## 当前版本

- v1：统一报告、场站快照和请求模板字段。
- v2：补齐持久化调度运行字段。
- v3：暂停缺少明确 method3 目标或受限请求预算的历史启用任务，并标记为 `configuration_required`。迁移不会替历史任务猜测城市、坐标或请求参数。

## 回滚

本项目不执行逆向 `down` 迁移。回滚步骤：

1. 停止新版本服务和所有写任务。
2. 保留失败数据库用于审计，不在原文件上继续尝试修复。
3. 将迁移前 `.bak` 恢复为 `DATABASE_PATH` 指向的数据库文件。
4. 部署与该备份 Schema 匹配的旧制品。
5. 启动后执行完整性、行数、关键 API 和页面检查。

迁移完成后产生的新数据不能通过恢复旧备份自动保留，发布窗口必须控制写流量并明确恢复点目标。
