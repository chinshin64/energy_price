#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG_FILE="${LOG_FILE:-$ROOT/logs/safe-guardian-agent.log}"
PID_FILE="${PID_FILE:-$ROOT/data/safe-guardian-agent.pid}"

if [ -f "$ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$ROOT/.env"
  set +a
fi

if [ -z "${SAFE_GUARDIAN_URL:-}" ]; then
  echo "SAFE_GUARDIAN_URL is required" >&2
  exit 1
fi
if [ -z "${GUARDIAN_BLUE_TEAM_AGENT_TOKEN:-}" ] && [ -z "${MOBILE_SYNC_TOKEN:-}" ]; then
  echo "GUARDIAN_BLUE_TEAM_AGENT_TOKEN or MOBILE_SYNC_TOKEN is required" >&2
  exit 1
fi

mkdir -p "$(dirname "$LOG_FILE")" "$(dirname "$PID_FILE")"

if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" >/dev/null 2>&1; then
  echo "safe guardian agent already running, pid=$(cat "$PID_FILE")"
  exit 0
fi

nohup node "$ROOT/scripts/safe-guardian-agent.js" > "$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"
echo "safe guardian agent started, pid=$(cat "$PID_FILE"), log=$LOG_FILE"
