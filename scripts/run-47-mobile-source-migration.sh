#!/usr/bin/env bash
set -euo pipefail

ROOT="${ROOT:-/opt/data-for-didi-mobile-source}"
ENV_FILE="${ENV_FILE:-$ROOT/.env.mobile-source-migration}"
RUNTIME_ENV_FILE="${RUNTIME_ENV_FILE:-$ROOT/.env.mobile-source}"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
RUNTIME_NODE_MODULES="$ROOT/backend/mobile-source-runtime/node_modules"

if [ "$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')" != "22" ]; then
  echo "47 mobile source migration requires Node.js 22 LTS" >&2
  exit 1
fi

if [ ! -f "$ENV_FILE" ]; then
  echo "Missing protected migration environment file: $ENV_FILE" >&2
  exit 1
fi
if [ ! -f "$RUNTIME_ENV_FILE" ]; then
  echo "Missing protected runtime environment file: $RUNTIME_ENV_FILE" >&2
  exit 1
fi
if [ ! -d "$RUNTIME_NODE_MODULES" ]; then
  echo "Missing minimal runtime dependencies: $RUNTIME_NODE_MODULES" >&2
  exit 1
fi

ENV_MODE="$(stat -c '%a' "$ENV_FILE")"
if [ "$ENV_MODE" != "600" ]; then
  echo "Migration environment file must have mode 600: $ENV_FILE" >&2
  exit 1
fi
RUNTIME_ENV_MODE="$(stat -c '%a' "$RUNTIME_ENV_FILE")"
if [ "$RUNTIME_ENV_MODE" != "600" ] && [ "$RUNTIME_ENV_MODE" != "640" ]; then
  echo "Runtime environment file must have mode 600 or 640: $RUNTIME_ENV_FILE" >&2
  exit 1
fi

cd "$ROOT/backend"
export NODE_PATH="$RUNTIME_NODE_MODULES"
export DOTENV_CONFIG_PATH="$ENV_FILE"
MOBILE_SOURCE_RUNTIME_MYSQL_USER="$(
  "$NODE_BIN" -e '
    const fs = require("node:fs");
    const dotenv = require("dotenv");
    const values = dotenv.parse(fs.readFileSync(process.argv[1]));
    process.stdout.write(String(values.MOBILE_SOURCE_MYSQL_USER || "").trim());
  ' "$RUNTIME_ENV_FILE"
)"
MOBILE_SOURCE_RUNTIME_MYSQL_DATABASE="$(
  "$NODE_BIN" -e '
    const fs = require("node:fs");
    const dotenv = require("dotenv");
    const values = dotenv.parse(fs.readFileSync(process.argv[1]));
    process.stdout.write(String(values.MOBILE_SOURCE_MYSQL_DATABASE || "").trim());
  ' "$RUNTIME_ENV_FILE"
)"
if [ -z "$MOBILE_SOURCE_RUNTIME_MYSQL_USER" ] \
  || [ -z "$MOBILE_SOURCE_RUNTIME_MYSQL_DATABASE" ]; then
  echo "Runtime MySQL identity is missing from the protected runtime environment" >&2
  exit 1
fi
export MOBILE_SOURCE_RUNTIME_MYSQL_USER
export MOBILE_SOURCE_RUNTIME_MYSQL_DATABASE
# 受保护 migration env 必须是迁移配置的唯一来源，不能被调用方
# shell 中残留的同名变量覆盖。
unset \
  MOBILE_SOURCE_MIGRATION_MYSQL_HOST \
  MOBILE_SOURCE_MIGRATION_MYSQL_PORT \
  MOBILE_SOURCE_MIGRATION_MYSQL_USER \
  MOBILE_SOURCE_MIGRATION_MYSQL_PASSWORD \
  MOBILE_SOURCE_MIGRATION_MYSQL_DATABASE \
  MOBILE_SOURCE_ALLOW_SHARED_DB_OWNER_MIGRATION

# 先跑 v4 物理迁移，再跑 v5 拆表迁移（建充电/燃油拆分表 + 游标表 + 子表 FK 切换）。
"$NODE_BIN" --require dotenv/config scripts/migrate-mobile-source-mysql.js "$@"
v4_status=$?
if [ "$v4_status" -ne 0 ]; then
  echo "v4 physical migration failed, skipping v5 split migration" >&2
  exit "$v4_status"
fi
# --plan / --validate-only 模式下也同步跑 v5 以保持一致。
exec "$NODE_BIN" --require dotenv/config scripts/migrate-mobile-source-split.js "$@"

