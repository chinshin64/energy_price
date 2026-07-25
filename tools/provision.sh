#!/usr/bin/env bash
set -euo pipefail

PKG="com.chinshin.energyprice"
URL="${MOBILE_SOURCE_URL:-https://mobile.314057.xyz}"
REMOTE_TMP="/data/local/tmp/energy-price-ocr-provisioning.json"

command -v adb >/dev/null || { echo '未找到 adb。' >&2; exit 1; }
command -v python3 >/dev/null || { echo '未找到 python3。' >&2; exit 1; }

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
trap 'rm -f "$TMP"; adb shell rm -f "$REMOTE_TMP" >/dev/null 2>&1 || true' EXIT
printf '%s' "$PAYLOAD" > "$TMP"
chmod 600 "$TMP"

# Debug APK is debuggable, so run-as can provision the private files directory without root.
adb push "$TMP" "$REMOTE_TMP" >/dev/null
adb shell "run-as $PKG sh -c 'mkdir -p files && cat $REMOTE_TMP > files/ocr-provisioning.json && chmod 600 files/ocr-provisioning.json'"
adb shell rm -f "$REMOTE_TMP"
adb shell am force-stop "$PKG" >/dev/null
adb shell monkey -p "$PKG" 1 >/dev/null

echo 'provisioning 已推送。应用启动后会导入、使用 Android Keystore 加密保存并删除原文件。'
