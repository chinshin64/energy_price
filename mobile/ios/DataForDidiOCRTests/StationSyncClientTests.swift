import Foundation
import XCTest
import StationOCRCore
@testable import DataForDidiOCR

final class StationSyncClientTests: XCTestCase {
    func testEndpointComesOnlyFromManagedConfiguration() throws {
        let suiteName = "ios-endpoint-\(UUID().uuidString)"
        let suite = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { suite.removePersistentDomain(forName: suiteName) }

        XCTAssertNil(AppConfiguration.endpoint(defaults: suite))
        suite.set(
            ["MobileIngestURL": "https://managed-ingest.example:5443"],
            forKey: "com.apple.configuration.managed"
        )
        XCTAssertEqual(
            AppConfiguration.endpoint(defaults: suite)?.absoluteString,
            "https://managed-ingest.example:5443"
        )
    }

    func testStrictAckMatches47Fixture() throws {
        let data = Data("""
        {
          "success": true,
          "message": "47 MySQL 已提交采集批次",
          "data": {
            "ingestId": "ingest-ios-v3",
            "idempotencyKey": "abc",
            "sourceNode": "47-mysql",
            "sourceAgent": "ios-ocr-agent",
            "persisted": true,
            "duplicate": false,
            "acceptedCount": 2,
            "acceptedStationCount": 2,
            "acceptedQuoteCount": 0,
            "firstSourceRecordId": 101,
            "lastSourceRecordId": 103
          }
        }
        """.utf8)

        let acknowledgement = try StationSyncClient.parseAcknowledgement(data: data, expectedCount: 2)
        XCTAssertEqual(acknowledgement.ingestId, "ingest-ios-v3")
        XCTAssertEqual(acknowledgement.firstSourceRecordId, 101)
        XCTAssertEqual(acknowledgement.lastSourceRecordId, 103)
        XCTAssertEqual(acknowledgement.acceptedCount, 2)
    }

    func testStrictAckRejectsAgentMismatch() {
        let data = Data("""
        {"success":true,"data":{"persisted":true,"sourceNode":"47-mysql",
        "sourceAgent":"android-ocr-agent","ingestId":"wrong","acceptedCount":1,
        "firstSourceRecordId":1,"lastSourceRecordId":1,"duplicate":false}}
        """.utf8)
        XCTAssertThrowsError(
            try StationSyncClient.parseAcknowledgement(data: data, expectedCount: 1)
        )
    }

    func testIdempotencyIsStableAndChangesWithPage() {
        let station = StationRecord(
            platform: "didi-charging",
            stationName: "测试充电站",
            capturedAt: Date(timeIntervalSince1970: 1_700_000_000)
        )
        let first = StationSyncClient.idempotencyKey(
            deviceId: "device",
            deviceSessionId: "device-session",
            sessionId: "session",
            pageIndex: 1,
            platform: station.platform,
            stationType: station.stationType,
            stations: [station]
        )
        let repeated = StationSyncClient.idempotencyKey(
            deviceId: "device",
            deviceSessionId: "device-session",
            sessionId: "session",
            pageIndex: 1,
            platform: station.platform,
            stationType: station.stationType,
            stations: [station]
        )
        let changed = StationSyncClient.idempotencyKey(
            deviceId: "device",
            deviceSessionId: "device-session",
            sessionId: "session",
            pageIndex: 2,
            platform: station.platform,
            stationType: station.stationType,
            stations: [station]
        )
        XCTAssertEqual(first, repeated)
        XCTAssertEqual(first.count, 64)
        XCTAssertNotEqual(first, changed)
    }

    @MainActor
    func testOutboxPersistsAcrossRepositoryInstances() throws {
        let base = FileManager.default.temporaryDirectory
            .appendingPathComponent("ios-outbox-test-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: base) }
        let station = StationRecord(platform: "didi-charging", stationName: "测试充电站")
        let batch = OutboxBatch(
            idempotencyKey: String(repeating: "a", count: 64),
            deviceId: "device",
            deviceSessionId: "device-session",
            sessionId: "session",
            pageIndex: 1,
            city: "西安",
            platform: station.platform,
            capturedAt: station.capturedAt,
            stations: [station],
            attemptCount: 0,
            nextAttemptAt: .distantPast,
            lastError: nil
        )
        let first = OutboxRepository(baseDirectory: base)
        try first.enqueue(batch)
        XCTAssertEqual(first.count(), 1)
        let reloaded = OutboxRepository(baseDirectory: base)
        XCTAssertEqual(reloaded.ready().first?.idempotencyKey, batch.idempotencyKey)
        let acknowledgement = StationUploadAcknowledgement(
            ingestId: "ingest-recovery",
            firstSourceRecordId: 101,
            lastSourceRecordId: 101,
            acceptedCount: 1,
            duplicate: false
        )
        try reloaded.recordAcknowledgement(
            batch.idempotencyKey,
            acknowledgement: acknowledgement
        )
        XCTAssertTrue(reloaded.ready().isEmpty)
        XCTAssertEqual(
            OutboxRepository(baseDirectory: base).acknowledged().first?.acknowledgement,
            acknowledgement
        )
        let repository = StationRepository(baseDirectory: base)
        _ = repository.upsert([station], city: "西安")
        _ = try repository.commitAcknowledgement(
            batch: batch,
            acknowledgement: acknowledgement
        )
        try reloaded.finalizeAcknowledgement(batch.idempotencyKey)
        XCTAssertEqual(reloaded.count(), 0)
    }

    func testOrdinaryFuelDoesNotUseFeatureAndExtendedFuelRequiresIt() throws {
        let capturedAt = Date(timeIntervalSince1970: 1_753_323_600)
        let ordinary = StationRecord(
            platform: "tuanyou",
            stationType: .fuel,
            stationName: "普通加油站",
            fuelOffers: [FuelOffer(
                gradeCode: "95",
                gradeLabel: "95#",
                displayPrice: 7.18
            )],
            capturedAt: capturedAt
        )
        let ordinaryBatch = batch(station: ordinary, capturedAt: capturedAt)
        let root = try XCTUnwrap(
            JSONSerialization.jsonObject(
                with: StationSyncClient.encodedPayload(batch: ordinaryBatch)
            ) as? [String: Any]
        )
        XCTAssertNil(root["feature"])
        let observations = try XCTUnwrap(root["observations"] as? [[String: Any]])
        let fuel = try XCTUnwrap(observations[0]["fuelObservation"] as? [String: Any])
        let offers = try XCTUnwrap(fuel["fuelOffers"] as? [[String: Any]])
        XCTAssertNil(offers[0]["displayPrice"])
        XCTAssertEqual(offers[0]["discountPrice"] as? String, "7.18")

        let extended = StationRecord(
            platform: "tuanyou",
            stationType: .fuel,
            stationName: "扩展加油站",
            fuelOffers: [FuelOffer(
                gradeCode: "92",
                gradeLabel: "92#",
                displayPrice: 7.28,
                stationPrice: 7.58
            )],
            capturedAt: capturedAt
        )
        XCTAssertTrue(StationSyncClient.requiresFuelQuoteFeature(stations: [extended]))
        XCTAssertThrowsError(
            try StationSyncClient.encodedPayload(
                batch: batch(station: extended, capturedAt: capturedAt)
            )
        )
    }

    func testHealthCapabilityIsStrictAndPlatformScoped() throws {
        let data = Data("""
        {"success":true,"data":{"ok":true,"sourceNode":"47-mysql","capabilities":{
        "latestSchemaVersion":3,"supportedSchemaVersions":[1,2,3],
        "stationObservation":true,"features":{"fuel-quote-v1":{
        "enabled":true,"platforms":["tuanyou","amap-fuel"],
        "captureMode":"user-driven-ocr"}}}}}
        """.utf8)
        let capability = try StationSyncClient.parseFuelQuoteCapability(
            data: data,
            checkedAt: Date()
        )
        XCTAssertTrue(capability.allows(platform: "tuanyou"))
        XCTAssertFalse(capability.allows(platform: "generic-station"))
    }

    func testFailureClassificationSeparatesRetryableAndTerminal() {
        XCTAssertEqual(
            StationSyncClient.failureDisposition(
                for: StationSyncClient.SyncError.serverRejected(status: 408, code: nil)
            ),
            .transient
        )
        XCTAssertEqual(
            StationSyncClient.failureDisposition(
                for: StationSyncClient.SyncError.serverRejected(status: 429, code: nil)
            ),
            .transient
        )
        XCTAssertEqual(
            StationSyncClient.failureDisposition(
                for: StationSyncClient.SyncError.serverRejected(status: 503, code: nil)
            ),
            .transient
        )
        XCTAssertEqual(
            StationSyncClient.failureDisposition(
                for: StationSyncClient.SyncError.serverRejected(status: 400, code: nil)
            ),
            .permanent
        )
        XCTAssertEqual(
            StationSyncClient.failureDisposition(for: URLError(.notConnectedToInternet)),
            .transient
        )
    }

    func testSensitiveContentPolicyRejectsCredentialsWithoutRejectingAddresses() {
        let mobile = "138" + "0013" + "8000"
        let identity = "610101" + "19900101" + "1234"
        let bankCard = "62220202" + "02020202"
        XCTAssertTrue(StationContentPolicy.isSafe("陕西省西安市雁塔区科技路18号"))
        XCTAssertTrue(StationContentPolicy.isSafe("支付宝大厦地下停车场"))
        XCTAssertFalse(StationContentPolicy.isSafe("联系电话：\(mobile)"))
        XCTAssertFalse(StationContentPolicy.isSafe("身份证号：\(identity)"))
        XCTAssertFalse(StationContentPolicy.isSafe("银行卡号：\(bankCard)"))
        XCTAssertFalse(StationContentPolicy.isSafe("账号：user_12345"))
        XCTAssertFalse(StationContentPolicy.isSafe("订单号：ORDER12345"))
        XCTAssertFalse(StationContentPolicy.isSafe("验证码：123456"))
        XCTAssertFalse(StationContentPolicy.isSafe("支付密码：123456"))
    }

    func testCardPresenterShowsChargingZeroAndFailureWithoutConfiguration() {
        let station = StationRecord(
            platform: "internal-platform-value",
            stationName: "  ",
            address: nil,
            priceFast: 0,
            availablePorts: 0,
            busyPorts: 0,
            totalPorts: 0,
            capturedAt: Date(timeIntervalSince1970: 1_700_000_000),
            missingFields: ["stationName", "address", "endpoint", "token"]
        )
        let card = StationCardPresenter(capturedAtFormatter: { _ in "固定采集时间" })
            .present(CollectedStation(
                station: station,
                city: "西安",
                syncState: .failed,
                syncMessage: "包含内部地址的错误不应透传",
                capturedAt: station.capturedAt,
                ingestId: nil,
                sourceRecordId: nil
            ))

        XCTAssertEqual(card.nameText, "名称待补全")
        XCTAssertEqual(card.addressText, "地址待补全")
        XCTAssertEqual(card.portText, "枪：闲 0 / 忙 0 / 总 0")
        XCTAssertEqual(card.priceLines, ["价格：快 ¥0"])
        XCTAssertEqual(card.missingFieldsText, "待补全：场站名称、地址")
        XCTAssertEqual(card.sourceAgentText, "ios-ocr-agent")
        XCTAssertEqual(card.capturedAtText, "固定采集时间")
        XCTAssertEqual(card.syncText, "回传失败")
        XCTAssertEqual(card.syncTone, .failure)
        XCTAssertFalse(String(describing: card).contains("internal-platform-value"))
        XCTAssertFalse(String(describing: card).contains("endpoint"))
        XCTAssertFalse(String(describing: card).contains("token"))
    }

    func testCardPresenterKeepsUnknownValuesDistinctFromExplicitZero() {
        let station = StationRecord(
            platform: "generic-station",
            stationName: "测试充电站",
            address: "",
            capturedAt: Date(timeIntervalSince1970: 1_700_000_001),
            missingFields: ["address", "availablePorts", "busyPorts", "totalPorts"]
        )
        let card = StationCardPresenter(capturedAtFormatter: { _ in "固定采集时间" })
            .present(CollectedStation(
                station: station,
                city: nil,
                syncState: .pending,
                syncMessage: "等待回传",
                capturedAt: station.capturedAt,
                ingestId: nil,
                sourceRecordId: nil
            ))

        XCTAssertEqual(card.portText, "枪：闲 待补全 / 忙 待补全 / 总 待补全")
        XCTAssertEqual(card.priceLines, ["价格：待补全"])
        XCTAssertEqual(card.syncText, "等待回传")
        XCTAssertEqual(card.syncTone, .pending)
    }

    func testCardPresenterShowsFuelPricesGunAndSyncedState() {
        let station = StationRecord(
            platform: "tuanyou",
            stationType: .fuel,
            stationName: "测试加油站",
            address: "科技路18号",
            fuelOffers: [FuelOffer(
                gradeCode: "92",
                gradeLabel: "92#",
                displayPrice: 0,
                stationPrice: 7.5,
                gunCode: "12",
                gunLabel: "12号枪"
            )],
            availablePorts: 2,
            busyPorts: 3,
            totalPorts: 5,
            capturedAt: Date(timeIntervalSince1970: 1_700_000_002)
        )
        let card = StationCardPresenter(capturedAtFormatter: { _ in "固定采集时间" })
            .present(CollectedStation(
                station: station,
                city: "西安",
                syncState: .synced,
                syncMessage: "47已落库",
                capturedAt: station.capturedAt,
                ingestId: "ingest-test",
                sourceRecordId: 1
            ))

        XCTAssertEqual(card.stationTypeText, "加油")
        XCTAssertEqual(card.portText, "枪：闲 2 / 忙 3 / 总 5")
        XCTAssertEqual(card.priceLines, ["92#：外显 ¥0 / 油站 ¥7.5 / 12号枪"])
        XCTAssertEqual(card.syncText, "47已落库")
        XCTAssertEqual(card.syncTone, .success)
    }

    func testCardPresenterMapsNeedsAttentionToFailureTone() {
        let station = StationRecord(
            platform: "generic-station",
            stationName: "待处理场站"
        )
        let card = StationCardPresenter(capturedAtFormatter: { _ in "固定采集时间" })
            .present(CollectedStation(
                station: station,
                city: nil,
                syncState: .needsAttention,
                syncMessage: "需人工处理",
                capturedAt: station.capturedAt,
                ingestId: nil,
                sourceRecordId: nil
            ))

        XCTAssertEqual(card.syncText, "需人工处理")
        XCTAssertEqual(card.syncTone, .failure)
    }

    private func batch(
        station: StationRecord,
        capturedAt: Date,
        feature: String? = nil
    ) -> OutboxBatch {
        OutboxBatch(
            idempotencyKey: String(repeating: "f", count: 64),
            deviceId: "device",
            deviceSessionId: "device-session",
            sessionId: "session",
            pageIndex: 1,
            city: "西安",
            platform: station.platform,
            capturedAt: capturedAt,
            stations: [station],
            attemptCount: 0,
            nextAttemptAt: .distantPast,
            lastError: nil,
            feature: feature
        )
    }

}
