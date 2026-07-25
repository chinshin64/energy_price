#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
DESKTOP_DIR="$ROOT_DIR/edge-agent/desktop"
PACKAGING_DIR="$ROOT_DIR/edge-agent/packaging"
ANDROID_APK="$ROOT_DIR/mobile/android/app/build/outputs/apk/debug/app-debug.apk"
DIST_DIR="$ROOT_DIR/dist/edge-agents"
STAGE_DIR="$DIST_DIR/staging"

rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR/macos" "$STAGE_DIR/windows" "$STAGE_DIR/android"

[ -x "$DESKTOP_DIR/dist/blue-team-edge-agent-macos-arm64" ]
[ -f "$DESKTOP_DIR/dist/blue-team-edge-agent-windows-x64.exe" ]
[ -f "$ANDROID_APK" ]

cp "$DESKTOP_DIR/dist/blue-team-edge-agent-macos-arm64" "$STAGE_DIR/macos/"
cp "$PACKAGING_DIR/run-macos.command" "$STAGE_DIR/macos/"
chmod +x "$STAGE_DIR/macos/run-macos.command"
cp "$DESKTOP_DIR/dist/blue-team-edge-agent-windows-x64.exe" "$STAGE_DIR/windows/"
cp "$PACKAGING_DIR/run-windows.ps1" "$STAGE_DIR/windows/"
cp "$ANDROID_APK" "$STAGE_DIR/android/blue-team-edge-agent-android-0.3.0-debug.apk"

for platform in macos windows; do
    cp "$PACKAGING_DIR/edge-agent.env.example" "$STAGE_DIR/$platform/"
    cp "$PACKAGING_DIR/README.txt" "$STAGE_DIR/$platform/"
done
cp "$PACKAGING_DIR/README.txt" "$STAGE_DIR/android/"

rm -f "$DIST_DIR"/*.zip "$DIST_DIR"/*.sha256
for platform in macos windows android; do
    if find "$STAGE_DIR/$platform" -maxdepth 1 -type f | grep -q .; then
        (cd "$STAGE_DIR/$platform" && zip -q "$DIST_DIR/blue-team-edge-agent-$platform.zip" ./*)
    fi
done
(cd "$DIST_DIR" && shasum -a 256 ./*.zip > SHA256SUMS)
