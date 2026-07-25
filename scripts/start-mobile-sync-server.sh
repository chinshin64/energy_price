#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-3000}"
HOST="${HOST:-0.0.0.0}"
LOG_FILE="${LOG_FILE:-$ROOT/logs/mobile-sync-server-$PORT.log}"
PID_FILE="${PID_FILE:-$ROOT/data/mobile-sync-server-$PORT.pid}"

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

mkdir -p "$ROOT/logs" "$ROOT/data"

if lsof -tiTCP:"$PORT" -sTCP:LISTEN >/tmp/data_for_didi_mobile_sync_pids 2>/dev/null \
  && [ -s /tmp/data_for_didi_mobile_sync_pids ]; then
  echo "mobile-sync server already listening on $PORT: $(tr '\n' ' ' </tmp/data_for_didi_mobile_sync_pids)"
  exit 0
fi

cd "$ROOT"
nohup env \
  PORT="$PORT" \
  HOST="$HOST" \
  "$NODE_BIN" backend/index.js >"$LOG_FILE" 2>&1 &
echo $! >"$PID_FILE"

sleep 2
if ! lsof -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "mobile-sync server failed to listen on $PORT. Last log:" >&2
  tail -80 "$LOG_FILE" >&2 || true
  exit 1
fi

echo "mobile-sync server started on $PORT, pid=$(cat "$PID_FILE"), log=$LOG_FILE"
