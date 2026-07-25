#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SDK_ROOT="${ANDROID_SDK_ROOT:-/opt/homebrew/share/android-commandlinetools}"
EMULATOR_BIN="${EMULATOR_BIN:-$SDK_ROOT/emulator/emulator}"
SDKMANAGER_BIN="${SDKMANAGER_BIN:-/opt/homebrew/bin/sdkmanager}"
AVDMANAGER_BIN="${AVDMANAGER_BIN:-/opt/homebrew/bin/avdmanager}"
ADB_BIN="${ADB_BIN:-adb}"
AVD_NAME="${AVD_NAME:-data_test_didi_api36}"
SYSTEM_IMAGE="${SYSTEM_IMAGE:-system-images;android-36;default;arm64-v8a}"
DEVICE_PROFILE="${DEVICE_PROFILE:-pixel}"
SERIAL="${SERIAL:-emulator-5554}"
CITY="${CITY:-西安}"

usage() {
  cat <<USAGE
Usage: $0 <command>

Commands:
  ensure-image      Install the ARM64 Android system image if missing
  create-avd        Create the project AVD if missing
  start             Start the AVD and wait for boot
  install-agent     Install the mobile collector APK into the AVD
  install-wechat    Install WECHAT_APK into the AVD
  set-location      Set mock location in the AVD, default CITY=西安
  prepare           create-avd, start, install-agent, set-location

Environment:
  AVD_NAME=$AVD_NAME
  SYSTEM_IMAGE=$SYSTEM_IMAGE
  DEVICE_PROFILE=$DEVICE_PROFILE
  SERIAL=$SERIAL
  CITY=$CITY
  SDK_ROOT=$SDK_ROOT
  WECHAT_APK=/absolute/path/to/wechat.apk
USAGE
}

installed_package() {
  "$SDKMANAGER_BIN" --list_installed | awk 'NR > 1 {print $1}' | grep -Fxq "$1"
}

ensure_image() {
  if installed_package "$SYSTEM_IMAGE"; then
    echo "system image already installed: $SYSTEM_IMAGE"
    return
  fi
  yes | "$SDKMANAGER_BIN" "$SYSTEM_IMAGE"
}

create_avd() {
  ensure_image
  if "$AVDMANAGER_BIN" list avd | grep -Fq "Name: $AVD_NAME"; then
    echo "AVD already exists: $AVD_NAME"
    return
  fi
  printf 'no\n' | "$AVDMANAGER_BIN" create avd \
    -n "$AVD_NAME" \
    -k "$SYSTEM_IMAGE" \
    --device "$DEVICE_PROFILE" \
    --force
}

start_avd() {
  if "$ADB_BIN" devices | grep -Fq "$SERIAL"; then
    echo "AVD already visible on ADB: $SERIAL"
  else
    ANDROID_HOME="$SDK_ROOT" ANDROID_SDK_ROOT="$SDK_ROOT" \
      "$EMULATOR_BIN" -avd "$AVD_NAME" -no-snapshot-save -no-boot-anim >/tmp/data-test-didi-emulator.log 2>&1 &
  fi
  "$ADB_BIN" -s "$SERIAL" wait-for-device
  until [[ "$("$ADB_BIN" -s "$SERIAL" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == "1" ]]; do
    sleep 2
  done
  echo "AVD booted: $SERIAL"
}

install_agent() {
  "$ADB_BIN" -s "$SERIAL" install -r "$ROOT/mobile/android/app/build/outputs/apk/debug/app-debug.apk"
  "$ADB_BIN" -s "$SERIAL" shell settings put secure enabled_accessibility_services \
    'com.datafordidi.mobilecollector/com.datafordidi.mobilecollector.AutoScrollAccessibilityService'
  "$ADB_BIN" -s "$SERIAL" shell settings put secure accessibility_enabled 1
  "$ADB_BIN" -s "$SERIAL" shell ime enable com.datafordidi.mobilecollector/.AdbTextInputService || true
  "$ADB_BIN" -s "$SERIAL" shell ime set com.datafordidi.mobilecollector/.AdbTextInputService || true
}

install_wechat() {
  if [[ -z "${WECHAT_APK:-}" ]]; then
    echo "WECHAT_APK is required" >&2
    exit 2
  fi
  "$ADB_BIN" -s "$SERIAL" install -r "$WECHAT_APK"
}

set_location() {
  python3 "$ROOT/automation/android_mock_location.py" --serial "$SERIAL" --city "$CITY"
}

case "${1:-}" in
  ensure-image) ensure_image ;;
  create-avd) create_avd ;;
  start) start_avd ;;
  install-agent) install_agent ;;
  install-wechat) install_wechat ;;
  set-location) set_location ;;
  prepare)
    create_avd
    start_avd
    install_agent
    set_location
    ;;
  -h|--help|help|"") usage ;;
  *)
    usage >&2
    exit 2
    ;;
esac
