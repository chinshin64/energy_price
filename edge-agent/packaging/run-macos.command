#!/bin/sh
set -eu

BASE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
CONFIG_FILE="$BASE_DIR/edge-agent.env"
if [ ! -f "$CONFIG_FILE" ]; then
    printf '%s\n' "Missing $CONFIG_FILE. Create it from edge-agent.env.example." >&2
    exit 1
fi
chmod 600 "$CONFIG_FILE"
set -a
. "$CONFIG_FILE"
set +a
exec "$BASE_DIR/blue-team-edge-agent-macos-arm64"
