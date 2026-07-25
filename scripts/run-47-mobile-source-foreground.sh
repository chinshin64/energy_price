#!/usr/bin/env bash
set -euo pipefail

ROOT="${ROOT:-/opt/data-for-didi-mobile-source}"
ENV_FILE="${ENV_FILE:-$ROOT/.env.mobile-source}"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
RUNTIME_NODE_MODULES="$ROOT/backend/mobile-source-runtime/node_modules"

if [ "$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')" != "22" ]; then
  echo "47 mobile source runtime requires Node.js 22 LTS" >&2
  exit 1
fi

if [ ! -f "$ENV_FILE" ]; then
  echo "Missing protected environment file: $ENV_FILE" >&2
  exit 1
fi
if [ ! -d "$RUNTIME_NODE_MODULES" ]; then
  echo "Missing minimal runtime dependencies: $RUNTIME_NODE_MODULES" >&2
  exit 1
fi

ENV_MODE="$(stat -c '%a' "$ENV_FILE")"
if [ "$ENV_MODE" != "600" ]; then
  echo "Environment file must have mode 600: $ENV_FILE" >&2
  exit 1
fi
for required in \
  MOBILE_SOURCE_INGEST_TOKEN \
  MOBILE_SOURCE_SYNC_TOKEN \
  MOBILE_SOURCE_MYSQL_USER \
  MOBILE_SOURCE_MYSQL_PASSWORD \
  MOBILE_SOURCE_MYSQL_DATABASE; do
  if [ -z "${!required:-}" ]; then
    echo "Required runtime setting is missing: $required" >&2
    exit 1
  fi
done

cd "$ROOT/backend"
export NODE_PATH="$RUNTIME_NODE_MODULES"
exec "$NODE_BIN" scripts/start-mobile-source-node.js
