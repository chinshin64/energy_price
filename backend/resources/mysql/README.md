# 47 MySQL 移动 OCR 数据源

47 是正式数据源节点。手机调用 `POST /api/mobile-sync/stations` 后，服务先把批次和场站快照提交到 MySQL，再返回 `persisted=true`。本地主产品通过 `GET /api/source-sync/stations?afterId=<cursor>&limit=<n>` 增量读取，不直接持有 47 的 MySQL 密码。

## 1. MySQL 账号

使用两个账号执行职责分离：

- 迁移账号：只在发布时执行 JavaScript migration runner，具备目标库建表、加列、索引和外键所需权限；
- 运行账号：只授予目标库连接权限，以及 `mobile_ocr_ingest_batches`、`mobile_ocr_station_snapshots`、`mobile_ocr_fuel_offers`、`mobile_ocr_fuel_quotes` 的 `SELECT`、`INSERT` 权限。

不要授予运行账号 `DROP`、`ALTER`、`GRANT` 或其他库权限。真实账号和密码只放在 47 的受限环境文件中。

## 2. 初始化

```bash
cd backend/mobile-source-runtime
npm ci --omit=dev
cd ../..
chmod 600 .env.mobile-source-migration
scripts/run-47-mobile-source-migration.sh --dry-run
scripts/run-47-mobile-source-migration.sh --apply
scripts/run-47-mobile-source-migration.sh --validate-only
```

`backend/mobile-source-runtime` 只安装 47 接入节点需要的 `express`、`mysql2` 和 `dotenv`，不会在 47 安装主产品的 SQLite、浏览器签名或采集依赖。迁移凭据使用单独的 `.env.mobile-source-migration`，迁移完成后应删除；运行服务使用权限更低的 `.env.mobile-source`。

迁移后换成最小权限运行账号，并配置两个不同的高熵令牌：

- `MOBILE_SOURCE_INGEST_TOKEN`：Android/iOS 写入；
- `MOBILE_SOURCE_SYNC_TOKEN`：本地主产品增量读取。

该迁移只创建独立的 migration metadata、批次、场站快照、燃油价格明细和报价快照，不修改 47 现有业务表。runner 支持 fresh DB、v1→v4、远端现有 v2→v4、v3→v4 和部分失败后的重复执行；v2 首次发布会在同一次受控 migration run 中依次补齐 v3、v4 追加对象，所有物理对象验证通过后才写入物理 schema version 4。API 同时兼容 `schemaVersion=1/2/3`；`/health` 为旧客户端保留 `capabilities.schemaVersion=2`，并通过 `latestSchemaVersion=3`、`supportedSchemaVersions=[1,2,3]` 声明最新契约。服务健康检查会校验数据库连接、v4 公共场站列、燃油明细和报价表；任一对象未正确迁移时返回 503。

单个场站的 `raw` 扩展字段默认限制为 65536 字节，可用 `MOBILE_SOURCE_STATION_RAW_MAX_BYTES` 在 1024～262144 字节范围内调整；四类正式业务字段不受该扩展字段限制影响。

燃油报价能力是后端设置，默认关闭：

```bash
MOBILE_SOURCE_FUEL_QUOTE_V1_ENABLED=false
MOBILE_SOURCE_FUEL_QUOTE_V1_PLATFORMS=tuanyou,amap-fuel
MOBILE_SOURCE_QUOTE_RAW_MAX_BYTES=16384
```

只有受控测试阶段才开启。回滚只关闭 feature 并停止新报价写入，不删除 v3/v4 列、报价表、已提交快照或 migration metadata。

## 3. 启动与确认语义

```bash
npm run start:mobile-source
```

正式发布使用版本化候选目录和一个不同路径的 physical-v4-compatible 回退目录。候选和回退必须包含完全相同的 v4 release manifest；首次从现网 v2 发布时，应把候选同一份不可变 bits 复制到独立回退目录，不能把旧 v2/v3 bits 当作 metadata v4 上的健康回退。安装脚本不会生成、修改或输出现有环境文件；它只把 root-only 副本写入发布备份目录。47 的运行环境必须继续显式配置 `MOBILE_SOURCE_HOST=127.0.0.1`、`MOBILE_SOURCE_PORT=50081` 和 `MOBILE_SOURCE_FUEL_QUOTE_V1_ENABLED=false`，公网 50080 仍由既有 XP nginx TLS listener 反向代理。

```bash
ROOT=<candidate-release> \
ROLLBACK_ROOT=<same-manifest-v4-compatible-release> \
NODE_BIN=<controlled-node-22> \
RUNTIME_ENV_FILE=<protected-runtime-env> \
MIGRATION_ENV_FILE=<protected-migration-env> \
scripts/install-47-mobile-source-systemd.sh --preflight

# 只有可恢复数据库备份已经验证后才设置该门禁。
DATABASE_BACKUP_CONFIRMED=1 \
ROOT=<candidate-release> \
ROLLBACK_ROOT=<same-manifest-v4-compatible-release> \
NODE_BIN=<controlled-node-22> \
RUNTIME_ENV_FILE=<protected-runtime-env> \
MIGRATION_ENV_FILE=<protected-migration-env> \
scripts/install-47-mobile-source-systemd.sh --all
```

脚本先备份 unit/env，验证候选和回退均为 physical v4 且 release manifest 完全一致，再验证账号分离、loopback 拓扑和 feature=false，最后执行 migration apply/validate。active 服务存在时禁止单独使用 `--migrate`，必须使用不可分的 `--all`。现网 v2 会在这一次 `--all` 中直接迁到物理 v4；metadata v4 写入后，候选 bits 会先以临时 systemd 服务在 `127.0.0.1:50082` 完成 health，再切换正式 50081。cutover 失败只恢复预验证的同 manifest v4 release，并继续强制关闭燃油报价；旧 v2/v3 release 在 metadata v4 上会 health 503，禁止作为回退。实际 Node 进程仍以专用 `datafordidi-mobile` 系统账号运行。

成功写入返回 HTTP 201；同一 `Idempotency-Key` 重试返回 HTTP 200 和原 `ingestId`。两种情况都必须同时包含：

```json
{
  "success": true,
  "data": {
    "persisted": true,
    "sourceNode": "47-mysql",
    "firstSourceRecordId": 1201,
    "lastSourceRecordId": 1201
  }
}
```

客户端只有看到该确认才把本地记录标为“已同步”。

首末 `sourceRecordId` 用于精确追踪本批次在 47 MySQL 中的快照范围；重复提交会返回相同的 `ingestId` 和记录范围。

## 4. 本地主产品同步

本地主产品配置：

```bash
MOBILE_SOURCE_SYNC_ENABLED=true
MOBILE_SOURCE_BASE_URL=<private-backend-setting>
MOBILE_SOURCE_ALLOWED_HOSTS=<private-host-allowlist>
MOBILE_SOURCE_SYNC_TOKEN='<source-sync-token>'
MOBILE_SOURCE_SYNC_INCLUDE_VERIFICATION_AGENT=false
```

自动任务默认每 60 秒拉取 200 条。也可以通过本地主产品的 `POST /api/mobile-source-sync/pull` 手动触发，`GET /api/mobile-source-sync/status` 查看游标。

生产环境必须在 47 前置 HTTPS；只有受控过渡期才允许设置 `MOBILE_SOURCE_ALLOW_HTTP=true`。

## 5. 只从 172 执行真实链路验收

在授权的 172 验收节点单独创建受限的 `.env.mobile-source-verifier`，只包含 `MOBILE_SOURCE_BASE_URL`、`MOBILE_SOURCE_INGEST_TOKEN`、`MOBILE_SOURCE_SYNC_TOKEN` 和 `MOBILE_SOURCE_VERIFIER_EXECUTION_IP_ALLOWLIST`；严禁把 47 的 MySQL 账号密码复制到 172。执行节点 allowlist 必须显式配置为实际节点的私网 IPv4，缺省时验证器直接拒绝运行。节点地址只保存在受控后端设置中，不写入文档或脚本示例。

```bash
cd /opt/data-for-didi-mobile-source/backend
DOTENV_CONFIG_PATH=../.env.mobile-source-verifier \
node --require dotenv/config ../scripts/verify-47-mobile-source-from-172.js
```

脚本会先确认本机网卡地址命中显式 allowlist，否则在任何外部请求前拒绝运行。它保留旧版充电写入兼容验收，同时按 API `schemaVersion=3` 模拟 Android 充电和 iOS 高德/团油燃油客户端结构，覆盖公共 `stationObservation` 的业务地址、可空枪数、枪语义、质量/缺失字段、充电价格、燃油三类价格和 `fuel-quote-v1`。每个批次都会验证精确 ACK、来源、条数、首末记录号、幂等重试、增量游标和 source-sync 回读，随后合并到临时主产品 SQLite v8 并核对地址、枪数、价格和来源，再删除临时库。真实验收写入始终固定标记为 `verification-agent`，不会伪装 Android/iOS Agent；正式主产品同步默认推进游标但不合并该来源，避免验收记录进入业务数据视图。`android-ocr-agent` 和 `ios-ocr-agent` 的来源持久化只在纯本地契约测试中验证。
