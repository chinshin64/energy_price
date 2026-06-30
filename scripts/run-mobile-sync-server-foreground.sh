#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-3000}"
HOST="${HOST:-0.0.0.0}"

if [ -f "$ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$ROOT/.env"
  set +a
fi

MOBILE_SYNC_TOKEN=""  # 访问鉴权已关闭，不再需要 token

NODE_BIN="${NODE_BIN:-}"
if [ -z "$NODE_BIN" ] && [ -x /usr/local/bin/node ]; then
  NODE_BIN=/usr/local/bin/node
fi
if [ -z "$NODE_BIN" ] && [ -x /opt/homebrew/bin/node ]; then
  NODE_BIN=/opt/homebrew/bin/node
fi
if [ -z "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node)"
fi

cd "$ROOT"
exec env \
  PORT="$PORT" \
  HOST="$HOST" \
  "$NODE_BIN" backend/index.js
