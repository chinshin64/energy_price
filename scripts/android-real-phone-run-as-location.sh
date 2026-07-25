#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT_DIR="$ROOT_DIR/tools/android-run-as-mock-location"
BUILD_DIR="$ROOT_DIR/.codex_tmp/android-run-as-mock-location"
SDK_DIR="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
BUILD_TOOLS_DIR="$SDK_DIR/build-tools/36.1.0"
ANDROID_JAR="$SDK_DIR/platforms/android-36/android.jar"
PACKAGE_NAME="com.datafordidi.mobilecollector"
REMOTE_JAR="/data/local/tmp/data-test-mock-runner.jar"
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

build_runner() {
  rm -rf "$BUILD_DIR"
  mkdir -p "$BUILD_DIR/classes" "$BUILD_DIR/dex"

  javac \
    -source 11 \
    -target 11 \
    -classpath "$ANDROID_JAR" \
    -d "$BUILD_DIR/classes" \
    $(find "$PROJECT_DIR/src" -name '*.java' | sort)

  "$BUILD_TOOLS_DIR/d8" \
    --min-api 23 \
    --lib "$ANDROID_JAR" \
    --output "$BUILD_DIR/dex" \
    $(find "$BUILD_DIR/classes" -name '*.class' | sort)

  (cd "$BUILD_DIR/dex" && zip -q -r "$BUILD_DIR/mock-runner.jar" classes.dex)
  echo "$BUILD_DIR/mock-runner.jar"
}

install_runner() {
  local jar_path="${1:-$BUILD_DIR/mock-runner.jar}"
  if [[ ! -f "$jar_path" ]]; then
    jar_path="$(build_runner)"
  fi
  adb_cmd push "$jar_path" "$REMOTE_JAR" >/dev/null
  adb_cmd shell chmod 644 "$REMOTE_JAR"
  adb_cmd shell run-as "$PACKAGE_NAME" id >/dev/null
}

set_location() {
  local city="$1"
  local repeat="${2:-12}"
  local interval_ms="${3:-500}"
  local coordinates lat lng
  coordinates="$(city_coordinates "$city")"
  read -r lat lng <<<"$coordinates"

  adb_cmd shell cmd location set-location-enabled true
  adb_cmd shell appops set "$PACKAGE_NAME" android:mock_location allow || true
  adb_cmd shell settings put secure mock_location "$PACKAGE_NAME" || true
  adb_cmd shell run-as "$PACKAGE_NAME" sh -c \
    "CLASSPATH=$REMOTE_JAR app_process /system/bin com.datafordidi.mockrunner.MockLocationCli $lat $lng 15 $repeat $interval_ms"
}

verify_location() {
  local city="$1"
  local coordinates lat lng
  coordinates="$(city_coordinates "$city")"
  read -r lat lng <<<"$coordinates"
  adb_cmd shell settings get secure mock_location
  adb_cmd shell dumpsys location | grep -E "$lat|$lng|mock|$PACKAGE_NAME" || true
}

usage() {
  cat <<'USAGE'
Usage:
  scripts/android-real-phone-run-as-location.sh build
  scripts/android-real-phone-run-as-location.sh install-runner
  scripts/android-real-phone-run-as-location.sh set-location 城市名 [repeat] [intervalMs]
  scripts/android-real-phone-run-as-location.sh verify 城市名

Set MOBILE_ADB_SERIAL or ANDROID_SERIAL to target a specific real phone.
USAGE
}

command="${1:-}"
case "$command" in
  build)
    build_runner
    ;;
  install-runner)
    install_runner "${2:-}"
    ;;
  set-location)
    install_runner
    set_location "${2:?city required}" "${3:-12}" "${4:-500}"
    ;;
  verify)
    verify_location "${2:?city required}"
    ;;
  *)
    usage
    exit 2
    ;;
esac
