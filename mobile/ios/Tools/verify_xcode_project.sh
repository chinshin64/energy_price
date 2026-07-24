#!/bin/sh
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
PROJECT="$ROOT/DataForDidiOCR.xcodeproj"
SCHEME="xcshareddata/xcschemes/DataForDidiOCR.xcscheme"

command -v xcodegen >/dev/null 2>&1 || {
  echo "xcodegen is required to verify the generated iOS project" >&2
  exit 1
}
XCODEGEN_VERSION="$(xcodegen --version)"
[ "$XCODEGEN_VERSION" = "Version: 2.46.0" ] || {
  echo "XcodeGen 2.46.0 is required for deterministic project verification" >&2
  exit 1
}

TMP_PARENT="$(mktemp -d "${TMPDIR:-/tmp}/data-for-didi-ios-project.XXXXXX")"
TMP_ROOT="$TMP_PARENT/ios"
mkdir -p "$TMP_ROOT"
trap 'rm -rf "$TMP_PARENT"' EXIT HUP INT TERM

cp "$ROOT/project.yml" "$ROOT/Package.swift" "$TMP_ROOT/"
cp -R \
  "$ROOT/DataForDidiOCRApp" \
  "$ROOT/DataForDidiOCRTests" \
  "$ROOT/Sources" \
  "$ROOT/Tests" \
  "$TMP_ROOT/"

(
  cd "$TMP_ROOT"
  xcodegen generate --spec project.yml --no-env --quiet
)

cmp "$PROJECT/project.pbxproj" \
  "$TMP_ROOT/DataForDidiOCR.xcodeproj/project.pbxproj"
cmp "$PROJECT/$SCHEME" \
  "$TMP_ROOT/DataForDidiOCR.xcodeproj/$SCHEME"
cmp "$ROOT/DataForDidiOCRApp/Info.plist" \
  "$TMP_ROOT/DataForDidiOCRApp/Info.plist"

plutil -lint "$PROJECT/project.pbxproj" >/dev/null
plutil -lint "$ROOT/DataForDidiOCRApp/Info.plist" >/dev/null
plutil -lint "$ROOT/DataForDidiOCRApp/DataForDidiOCR.entitlements" >/dev/null

python3 - "$ROOT" <<'PY'
from pathlib import Path
import json
import plistlib
import sys
import xml.etree.ElementTree as ET

root = Path(sys.argv[1])
pbx = (root / "DataForDidiOCR.xcodeproj/project.pbxproj").read_text()
scheme = (
    root
    / "DataForDidiOCR.xcodeproj/xcshareddata/xcschemes/DataForDidiOCR.xcscheme"
).read_text()
ET.fromstring(scheme)
spec = (root / "project.yml").read_text()
app = (root / "DataForDidiOCRApp/DataForDidiOCRApp.swift").read_text()
capture = (root / "DataForDidiOCRApp/ScreenCaptureOCRService.swift").read_text()

required_pbx = [
    'productType = "com.apple.product-type.application";',
    'productType = "com.apple.product-type.bundle.unit-test";',
    "Assets.xcassets in Resources",
    "CODE_SIGN_ENTITLEMENTS = DataForDidiOCRApp/DataForDidiOCR.entitlements;",
    "CODE_SIGN_STYLE = Automatic;",
    "IPHONEOS_DEPLOYMENT_TARGET = 27.0;",
    "PRODUCT_BUNDLE_IDENTIFIER = com.datafordidi.mobileocr;",
    'XCLocalSwiftPackageReference "."',
]
for value in required_pbx:
    if value not in pbx:
        raise SystemExit(f"generated project contract missing: {value}")

if "DEVELOPMENT_TEAM" in pbx or "DEVELOPMENT_TEAM" in spec:
    raise SystemExit("personal signing team must not be committed")
if "Info.plist in Sources" in pbx or "DataForDidiOCR.entitlements in Sources" in pbx:
    raise SystemExit("configuration files must not be compiled as Swift sources")
if 'BlueprintName = "DataForDidiOCR"' not in scheme:
    raise SystemExit("shared App scheme is invalid")
for action in ["BuildAction", "TestAction", "LaunchAction", "ArchiveAction"]:
    if f"<{action}" not in scheme:
        raise SystemExit(f"shared scheme action missing: {action}")
if "@main" not in app or "struct DataForDidiOCRApp: App" not in app:
    raise SystemExit("SwiftUI App entry point missing")
if "import ScreenCaptureKit" not in capture or "@available(iOS 27.0, *)" not in capture:
    raise SystemExit("iOS 27 ScreenCaptureKit entry missing")

with (root / "DataForDidiOCRApp/Info.plist").open("rb") as handle:
    info = plistlib.load(handle)
if info.get("CFBundlePackageType") != "APPL":
    raise SystemExit("Info.plist is not an App bundle")
if info.get("UIBackgroundModes") != ["screen-capture"]:
    raise SystemExit("screen-capture must be the only background mode")
if not info.get("NSScreenCaptureUsageDescription"):
    raise SystemExit("screen capture usage description missing")
for forbidden in [
    "NSAppTransportSecurity",
    "NSCameraUsageDescription",
    "NSMicrophoneUsageDescription",
    "NSLocationWhenInUseUsageDescription",
    "NSPhotoLibraryUsageDescription",
]:
    if forbidden in info:
        raise SystemExit(f"unnecessary permission/configuration found: {forbidden}")

with (root / "DataForDidiOCRApp/DataForDidiOCR.entitlements").open("rb") as handle:
    entitlements = plistlib.load(handle)
if entitlements != {}:
    raise SystemExit("App entitlements must stay empty unless separately reviewed")

contents = json.loads(
    (
        root
        / "DataForDidiOCRApp/Assets.xcassets/AppIcon.appiconset/Contents.json"
    ).read_text()
)
images = contents.get("images", [])
if images != [{
    "filename": "AppIcon-1024.png",
    "idiom": "universal",
    "platform": "ios",
    "size": "1024x1024",
}]:
    raise SystemExit("AppIcon asset metadata is not the controlled universal icon")
PY

ICON="$ROOT/DataForDidiOCRApp/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png"
ICON_INFO="$(sips -g pixelWidth -g pixelHeight -g hasAlpha -g format "$ICON" 2>/dev/null)"
echo "$ICON_INFO" | grep -q "pixelWidth: 1024"
echo "$ICON_INFO" | grep -q "pixelHeight: 1024"
echo "$ICON_INFO" | grep -q "hasAlpha: no"
echo "$ICON_INFO" | grep -q "format: png"

echo "iOS XcodeGen App project verification passed"
