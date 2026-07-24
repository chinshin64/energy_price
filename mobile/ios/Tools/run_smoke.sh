#!/bin/sh
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
SDK="${SDKROOT:-/Library/Developer/CommandLineTools/SDKs/MacOSX15.5.sdk}"
BUILD_DIR="${TMPDIR:-/tmp}/data-for-didi-ios-smoke"

mkdir -p "$BUILD_DIR"
cd "$ROOT"

swiftc -sdk "$SDK" -target arm64-apple-macosx15.0 \
  -emit-library -emit-module -module-name StationOCRCore \
  Sources/StationOCRCore/*.swift \
  -emit-module-path "$BUILD_DIR/StationOCRCore.swiftmodule" \
  -o "$BUILD_DIR/libStationOCRCore.dylib"

swiftc -sdk "$SDK" -target arm64-apple-macosx15.0 \
  -I "$BUILD_DIR" -L "$BUILD_DIR" -lStationOCRCore \
  Tools/main.swift \
  -o "$BUILD_DIR/parser-smoke"

APP_SUPPORT="DataForDidiOCRApp/AppConfiguration.swift
DataForDidiOCRApp/CredentialStore.swift
DataForDidiOCRApp/CollectedStation.swift
DataForDidiOCRApp/StationSyncClient.swift"

swiftc -sdk "$SDK" -target arm64-apple-macosx15.0 \
  -I "$BUILD_DIR" -L "$BUILD_DIR" -lStationOCRCore \
  $APP_SUPPORT Tools/repository_smoke.swift \
  -o "$BUILD_DIR/repository-smoke"

swiftc -sdk "$SDK" -target arm64-apple-macosx15.0 \
  -I "$BUILD_DIR" -L "$BUILD_DIR" -lStationOCRCore \
  $APP_SUPPORT Tools/ack_smoke.swift \
  -o "$BUILD_DIR/ack-smoke"

swiftc -sdk "$SDK" -target arm64-apple-macosx15.0 \
  -I "$BUILD_DIR" -L "$BUILD_DIR" -lStationOCRCore \
  $APP_SUPPORT Tools/payload_smoke.swift \
  -o "$BUILD_DIR/payload-smoke"

swiftc -sdk "$SDK" -target arm64-apple-macosx15.0 \
  -I "$BUILD_DIR" -L "$BUILD_DIR" -lStationOCRCore \
  $APP_SUPPORT Tools/presenter_smoke.swift \
  -o "$BUILD_DIR/presenter-smoke"

swiftc -sdk "$SDK" -target arm64-apple-macosx15.0 \
  -I "$BUILD_DIR" -L "$BUILD_DIR" -lStationOCRCore \
  $APP_SUPPORT Tools/presenter_semantics_qa.swift \
  -o "$BUILD_DIR/presenter-semantics-qa"

swiftc -sdk "$SDK" -target arm64-apple-macosx15.0 \
  -I "$BUILD_DIR" -L "$BUILD_DIR" -lStationOCRCore \
  $APP_SUPPORT Tools/generate_payload_fixtures.swift \
  -o "$BUILD_DIR/generate-payload-fixtures"

DYLD_LIBRARY_PATH="$BUILD_DIR" "$BUILD_DIR/parser-smoke"
DYLD_LIBRARY_PATH="$BUILD_DIR" "$BUILD_DIR/repository-smoke"
DYLD_LIBRARY_PATH="$BUILD_DIR" "$BUILD_DIR/ack-smoke"
DYLD_LIBRARY_PATH="$BUILD_DIR" "$BUILD_DIR/payload-smoke"
DYLD_LIBRARY_PATH="$BUILD_DIR" "$BUILD_DIR/presenter-smoke"
DYLD_LIBRARY_PATH="$BUILD_DIR" "$BUILD_DIR/presenter-semantics-qa"
GENERATED_FIXTURES="$BUILD_DIR/generated-fixtures"
mkdir -p "$GENERATED_FIXTURES"
DYLD_LIBRARY_PATH="$BUILD_DIR" \
  "$BUILD_DIR/generate-payload-fixtures" "$GENERATED_FIXTURES"
for fixture in ios-v3-charging.json ios-v3-fuel-basic.json ios-v3-fuel-extended.json; do
  cmp "Fixtures/$fixture" "$GENERATED_FIXTURES/$fixture"
done
echo "StationSyncClient production-path JSON fixtures match"
python3 Tools/verify_static.py
sh Tools/verify_xcode_project.sh
