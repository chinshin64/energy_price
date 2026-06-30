#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [[ -z "${DCC_BIN:-}" ]]; then
  if [[ -x "$HOME/.local/bin/dcc" ]]; then
    DCC_BIN="$HOME/.local/bin/dcc"
  elif command -v dcc >/dev/null 2>&1; then
    DCC_BIN="$(command -v dcc)"
  else
    DCC_BIN="/usr/local/bin/dcc"
  fi
fi
DCC_HOME="${DCC_HOME:-$ROOT/data/dcc-home}"
DCC_SETTINGS="${DCC_SETTINGS:-$HOME/.dcc/claude-settings.json}"
PLUGIN_DIR="$ROOT/dcc/data-for-didi-mobile-intent-plugin"
SKILL_FILE="$PLUGIN_DIR/skills/data-for-didi-mobile-intent/SKILL.md"

mkdir -p "$DCC_HOME/.dcc/logs"

exec env \
  HOME="$DCC_HOME" \
  HTTP_PROXY= \
  HTTPS_PROXY= \
  ALL_PROXY= \
  http_proxy= \
  https_proxy= \
  all_proxy= \
  PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}" \
  "$DCC_BIN" claude \
    -p \
    --output-format json \
    --tools "" \
    --settings "$DCC_SETTINGS" \
    --plugin-dir "$PLUGIN_DIR" \
    --append-system-prompt "$(cat "$SKILL_FILE")"
