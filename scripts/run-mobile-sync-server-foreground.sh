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

CAPTURE_RECORDER_BIN="${CAPTURE_RECORDER_BIN:-}"
if [ -z "$CAPTURE_RECORDER_BIN" ] && [ -x "$HOME/Library/Python/3.9/bin/mitmdump" ]; then
  CAPTURE_RECORDER_BIN="$HOME/Library/Python/3.9/bin/mitmdump"
fi

cd "$ROOT"
exec env \
  PORT="$PORT" \
  HOST="$HOST" \
  CAPTURE_RECORDER_BIN="$CAPTURE_RECORDER_BIN" \
  "$NODE_BIN" backend/index.js
