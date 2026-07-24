#!/usr/bin/env python3
from pathlib import Path
import plistlib
import re

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "DataForDidiOCRApp"


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(message)


with (APP / "Info.plist").open("rb") as handle:
    info = plistlib.load(handle)
with (APP / "DataForDidiOCR.entitlements").open("rb") as handle:
    entitlements = plistlib.load(handle)

require(info.get("CFBundleDisplayName") == "信息自动识别", "display name mismatch")
require(info.get("UIBackgroundModes") == ["screen-capture"], "background mode must be screen-capture only")
require("NSAppTransportSecurity" not in info, "ATS HTTP exception must not exist")
require(entitlements == {}, "unexpected App entitlement found")

project = (ROOT / "DataForDidiOCR.xcodeproj/project.pbxproj").read_text()
require("IPHONEOS_DEPLOYMENT_TARGET = 27.0;" in project, "deployment target must be iOS 27")
require("DataForDidiOCRTests" in project, "unit-test target missing")
require(
    'productType = "com.apple.product-type.application";' in project,
    "signable iOS application target missing",
)
require("CODE_SIGN_STYLE = Automatic;" in project, "automatic signing entry missing")
require(
    "CODE_SIGN_ENTITLEMENTS = DataForDidiOCRApp/DataForDidiOCR.entitlements;"
    in project,
    "controlled entitlements file missing",
)
require("Assets.xcassets in Resources" in project, "App assets resource phase missing")
require("DEVELOPMENT_TEAM" not in project, "personal signing team must not be committed")

scheme = (
    ROOT
    / "DataForDidiOCR.xcodeproj"
    / "xcshareddata"
    / "xcschemes"
    / "DataForDidiOCR.xcscheme"
)
require(scheme.is_file(), "shared DataForDidiOCR scheme missing")

all_sources = "\n".join(path.read_text() for path in APP.glob("*.swift"))
require("RPBroadcastSampleHandler" not in all_sources, "deprecated ReplayKit handler found")
require("RPSystemBroadcastPickerView" not in all_sources, "deprecated ReplayKit picker found")
require("MobileIngestURL" in all_sources, "managed endpoint setting missing")
require(
    re.search(r"\b47\.111\.\d+\.\d+\b", all_sources) is None,
    "backend address must not be embedded in app sources",
)
require(
    "static let endpoint = URL(" not in all_sources,
    "backend endpoint must not be compiled as a fixed app constant",
)
require('static let sourceAgent = "ios-ocr-agent"' in all_sources, "ios-ocr-agent identity missing")
require("let schemaVersion = 3" in all_sources, "API v3 payload missing")
require("let deviceSessionId: String" in all_sources, "deviceSessionId missing")
require("stationObservation" in all_sources, "v3 stationObservation missing")

content = (APP / "ContentView.swift").read_text()
for forbidden in [
    "serverURL",
    "SecureField",
    'TextField("同步地址"',
    'Picker("平台"',
    "item.station.platform",
    "item.syncMessage",
]:
    require(forbidden not in content, f"forbidden UI configuration found: {forbidden}")
require(
    "cardPresenter.present(item)" in content,
    "station card must render the pure Swift presenter",
)

sync = (APP / "StationSyncClient.swift").read_text()
for field in ["persisted", "sourceNode", "sourceAgent", "acceptedCount", "firstSourceRecordId", "lastSourceRecordId"]:
    require(re.search(rf"\blet {field}\b", sync) is not None, f"strict ACK field missing: {field}")
require(
    'feature: first.stationType == .fuel ? "fuel-quote-v1" : nil' not in sync,
    "fuel feature must not be unconditional",
)
require("parseFuelQuoteCapability" in sync, "strict health capability parser missing")
require("requiresFuelQuoteFeature" in sync, "fuel feature decision missing")
require("failureDisposition" in sync, "upload failure classification missing")
require("sensitiveStationContent" in sync, "serializer sensitive-content gate missing")

view_model = (APP / "CaptureViewModel.swift").read_text()
require("DeferredFeatureRepository" in view_model, "extended fuel deferred queue missing")
ack_start = view_model.index("let acknowledgement = try await")
ack_record = view_model.index("recordAcknowledgement", ack_start)
ack_commit = view_model.index("commitAcknowledgement", ack_record)
ack_finalize = view_model.index("finalizeAcknowledgement", ack_commit)
require(
    ack_record < ack_commit < ack_finalize,
    "ACK persistence order is unsafe",
)
require(
    "parsedStations.filter(StationContentPolicy.isSafe)" in view_model,
    "capture-boundary sensitive-content gate missing",
)
require(
    "repository.upsert(group" not in view_model,
    "station rows must not be written before batch transaction commit",
)
transaction_commit = view_model.index("transactionCoordinator.commit(transaction)")
signature_commit = view_model.index("lastPageSignature = signature", transaction_commit)
require(
    transaction_commit < signature_commit,
    "screen signature must only advance after transaction commit",
)
require(
    "reactivateCredentialFailures" in view_model
    and "repairableFeatureBatches" in view_model,
    "controlled explicit repair retry missing",
)

storage = (APP / "CollectedStation.swift").read_text()
for required in [
    "collection-journal-v1.json",
    "CollectionTransactionCoordinator",
    "ensureCapacity(for batches:",
    "terminalReason: UploadTerminalReason?",
    "reactivateCredentialFailures",
    "quarantinedCount",
    "struct StationCardPresenter",
    "sourceAgentText: StationRecord.sourceAgent",
    '"availablePorts": "闲枪数"',
]:
    require(required in storage, f"transaction/terminal contract missing: {required}")
require(
    storage.index("ensureCapacity(for: transaction)")
    < storage.index("journalRepository.prepare(transaction)")
    < storage.index("return try replay(transaction)"),
    "collection capacity/journal ordering is unsafe",
)

fixture_names = [
    "ios-v3-charging.json",
    "ios-v3-fuel-basic.json",
    "ios-v3-fuel-extended.json",
]
for fixture_name in fixture_names:
    require((ROOT / "Fixtures" / fixture_name).is_file(), f"fixture missing: {fixture_name}")
generator = (ROOT / "Tools" / "generate_payload_fixtures.swift").read_text()
require(
    "StationSyncClient.encodedPayload" in generator,
    "fixture generator must use the production payload encoder",
)
require(
    (APP / "Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png").is_file(),
    "AppIcon bitmap missing",
)

print("iOS static contract verification passed")
