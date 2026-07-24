#!/usr/bin/env bash
set -euo pipefail

PACKAGE="${OCR_UPLOAD_PACKAGE:-com.datafordidi.ocruploader}"
: "${OCR_UPLOAD_URL:?OCR_UPLOAD_URL is required}"
: "${OCR_UPLOAD_TOKEN:?OCR_UPLOAD_TOKEN is required}"

case "$OCR_UPLOAD_URL" in
  https://*) ;;
  *)
    echo "OCR_UPLOAD_URL must use https://" >&2
    exit 2
    ;;
esac

export OCR_UPLOAD_URL
PAYLOAD=$(python3 -c 'import json, os; print(json.dumps({"url": os.environ["OCR_UPLOAD_URL"], "token": os.environ["OCR_UPLOAD_TOKEN"]}, separators=(",", ":")))')
adb shell run-as "$PACKAGE" mkdir -p files
printf '%s' "$PAYLOAD" | adb shell run-as "$PACKAGE" dd of=files/ocr-provisioning.json status=none
adb shell run-as "$PACKAGE" chmod 600 files/ocr-provisioning.json
unset PAYLOAD
adb shell am force-stop "$PACKAGE"
adb shell monkey -p "$PACKAGE" -c android.intent.category.LAUNCHER 1 >/dev/null
echo "Provisioning imported for $PACKAGE"
