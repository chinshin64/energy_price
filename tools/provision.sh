#!/usr/bin/env bash
set -euo pipefail

PKG="com.chinshin.energyprice"
URL="${MOBILE_SOURCE_URL:-https://mobile.314057.xyz}"

printf 'MOBILE_SOURCE_INGEST_TOKEN: '
IFS= read -r -s TOKEN
printf '\n'

if [[ ${#TOKEN} -lt 32 ]]; then
  echo 'token 长度异常，未写入。' >&2
  exit 1
fi

PAYLOAD=$(python3 - "$URL" "$TOKEN" <<'PY'
import json,sys
print(json.dumps({"url":sys.argv[1],"token":sys.argv[2]}, ensure_ascii=False, separators=(",",":")))
PY
)
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT
printf '%s' "$PAYLOAD" > "$TMP"

adb shell "mkdir -p /sdcard/Android/data/$PKG/files"
adb push "$TMP" "/sdcard/Android/data/$PKG/files/ocr-provisioning.json" >/dev/null
adb shell monkey -p "$PKG" 1 >/dev/null

echo 'provisioning 已推送。应用启动后会导入、加密保存并删除原文件。'
