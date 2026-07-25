#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT_DIR="$ROOT_DIR/mobile/location-controller-android"
APK_PATH="$PROJECT_DIR/app/build/outputs/apk/debug/app-debug.apk"
SDK_DIR="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
PACKAGE_NAME="com.datafordidi.mocklocation"
SET_ACTION="com.datafordidi.mocklocation.SET_LOCATION"
STOP_ACTION="com.datafordidi.mocklocation.STOP_LOCATION"
SERIAL="${ANDROID_SERIAL:-${MOBILE_ADB_SERIAL:-}}"

city_coordinates() {
  case "$1" in
    上海) echo "31.2304 121.4737" ;;
    北京) echo "39.9042 116.4074" ;;
    广州) echo "23.1291 113.2644" ;;
    深圳) echo "22.5431 114.0579" ;;
    武汉) echo "30.5928 114.3055" ;;
    青岛) echo "36.0671 120.3826" ;;
    西安) echo "34.3416 108.9398" ;;
    杭州) echo "30.2741 120.1551" ;;
    *) return 1 ;;
  esac
}

adb_cmd() {
  if [[ -n "$SERIAL" ]]; then
    adb -s "$SERIAL" "$@"
  else
    adb "$@"
  fi
}

resolve_coordinates() {
  if [[ $# -ge 2 ]]; then
    printf '%s %s\n' "$1" "$2"
    return
  fi
  city_coordinates "${1:?city or latitude/longitude required}"
}

build_apk() {
  ANDROID_HOME="$SDK_DIR" ANDROID_SDK_ROOT="$SDK_DIR" \
    "$PROJECT_DIR/gradlew" -p "$PROJECT_DIR" --no-daemon \
    :app:testDebugUnitTest :app:assembleDebug >&2
  printf '%s\n' "$APK_PATH"
}

install_apk() {
  local apk_path="${1:-$APK_PATH}"
  if [[ ! -f "$apk_path" ]]; then
    apk_path="$(build_apk)"
  fi
  adb_cmd install -r "$apk_path"
  adb_cmd shell pm grant "$PACKAGE_NAME" android.permission.ACCESS_FINE_LOCATION || true
  adb_cmd shell pm grant "$PACKAGE_NAME" android.permission.ACCESS_COARSE_LOCATION || true
  adb_cmd shell appops set "$PACKAGE_NAME" android:mock_location allow
  adb_cmd shell appops set "$PACKAGE_NAME" RUN_ANY_IN_BACKGROUND allow
  adb_cmd shell settings put secure mock_location "$PACKAGE_NAME"
}

open_app() {
  adb_cmd shell am start -n "$PACKAGE_NAME/.MainActivity"
}

set_location() {
  local coordinates lat lng
  coordinates="$(resolve_coordinates "$@")"
  read -r lat lng <<<"$coordinates"
  adb_cmd shell cmd location set-location-enabled true
  adb_cmd shell appops set "$PACKAGE_NAME" android:mock_location allow
  adb_cmd shell appops set "$PACKAGE_NAME" RUN_ANY_IN_BACKGROUND allow
  adb_cmd shell settings put secure mock_location "$PACKAGE_NAME"
  adb_cmd shell am start -W -n "$PACKAGE_NAME/.MainActivity" >/dev/null
  local broadcast_output
  broadcast_output="$(adb_cmd shell am broadcast \
    -n "$PACKAGE_NAME/.ExternalLocationReceiver" \
    -a "$SET_ACTION" \
    --es lat "$lat" \
    --es lng "$lng")"
  if [[ "$broadcast_output" != *'data="accepted"'* ]]; then
    printf 'mock location start was rejected: %s\n' "$broadcast_output" >&2
    return 1
  fi
  sleep 2
  verify_location "$lat" "$lng"
}

stop_location() {
  adb_cmd shell am broadcast \
    -n "$PACKAGE_NAME/.ExternalLocationReceiver" \
    -a "$STOP_ACTION"
}

verify_location() {
  local coordinates lat lng lat_fixed lng_fixed dumpsys service_dump mock_op
  coordinates="$(resolve_coordinates "$@")"
  read -r lat lng <<<"$coordinates"
  printf -v lat_fixed '%.6f' "$lat"
  printf -v lng_fixed '%.6f' "$lng"
  dumpsys="$(adb_cmd shell dumpsys location)"
  service_dump="$(adb_cmd shell dumpsys activity services "$PACKAGE_NAME")"
  mock_op="$(adb_cmd shell appops get "$PACKAGE_NAME" android:mock_location)"

  if [[ "$mock_op" != *"MOCK_LOCATION: allow"* ]]; then
    printf 'mock location permission is not allowed\n' >&2
    return 1
  fi
  if [[ "$service_dump" != *"isForeground=true"* ]]; then
    printf 'mock location foreground service is not running\n' >&2
    return 1
  fi
  local provider
  for provider in gps network fused; do
    if [[ "$dumpsys" != *"last mock location=Location[$provider $lat_fixed,$lng_fixed"* ]]; then
      printf '%s provider does not contain fresh target location %s,%s\n' \
        "$provider" "$lat_fixed" "$lng_fixed" >&2
      return 1
    fi
  done
  printf 'mock location active: %s,%s (gps/network/fused)\n' "$lat_fixed" "$lng_fixed"
}

doctor() {
  printf '%s\n' '--- mock location app ---'
  adb_cmd shell appops get "$PACKAGE_NAME" android:mock_location
  adb_cmd shell appops get "$PACKAGE_NAME" RUN_ANY_IN_BACKGROUND
  adb_cmd shell dumpsys activity services "$PACKAGE_NAME" \
    | grep -E 'isForeground=|app=ProcessRecord|startRequested=' || true
  printf '%s\n' '--- WeChat location permission ---'
  adb_cmd shell appops get com.tencent.mm android:fine_location || true
  adb_cmd shell appops get com.tencent.mm android:coarse_location || true
}

usage() {
  cat <<'USAGE'
Usage:
  scripts/android-real-phone-mock-provider.sh build
  scripts/android-real-phone-mock-provider.sh install [apk]
  scripts/android-real-phone-mock-provider.sh open
  scripts/android-real-phone-mock-provider.sh set-location 城市名
  scripts/android-real-phone-mock-provider.sh set-location 纬度 经度
  scripts/android-real-phone-mock-provider.sh stop
  scripts/android-real-phone-mock-provider.sh verify 城市名
  scripts/android-real-phone-mock-provider.sh verify 纬度 经度
  scripts/android-real-phone-mock-provider.sh doctor

Set MOBILE_ADB_SERIAL or ANDROID_SERIAL when multiple Android devices are connected.
Normal users should select coordinates and apply them directly inside the app.
USAGE
}

command="${1:-}"
case "$command" in
  build)
    build_apk
    ;;
  install)
    install_apk "${2:-}"
    ;;
  open)
    open_app
    ;;
  set-location)
    shift
    set_location "$@"
    ;;
  stop)
    stop_location
    ;;
  verify)
    shift
    verify_location "$@"
    ;;
  doctor)
    doctor
    ;;
  *)
    usage
    exit 2
    ;;
esac
