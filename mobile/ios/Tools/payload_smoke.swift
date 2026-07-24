import Foundation
import StationOCRCore

@main
struct PayloadSmoke {
    static func main() throws {
        let capturedAt = Date(timeIntervalSince1970: 1_753_323_600)
        let station = StationRecord(
            platform: "tuanyou",
            platformConfidence: 0.95,
            stationType: .fuel,
            stationName: "中石化西安科技路加油站",
            address: "陕西省西安市雁塔区科技路18号",
            fuelOffers: [FuelOffer(
                gradeCode: "92",
                gradeLabel: "92#",
                displayPrice: 7.28,
                stationPrice: 7.58,
                nationalPrice: 8.12,
                gunCode: "12",
                gunLabel: "12号枪"
            )],
            availablePorts: 2,
            busyPorts: 3,
            totalPorts: 5,
            capturedAt: capturedAt
        )
        let batch = OutboxBatch(
            idempotencyKey: String(repeating: "b", count: 64),
            deviceId: "device",
            deviceSessionId: "ios-device-session-v3",
            sessionId: "ios-session-v3",
            pageIndex: 1,
            city: "西安",
            platform: station.platform,
            capturedAt: capturedAt,
            stations: [station],
            attemptCount: 0,
            nextAttemptAt: .distantPast,
            lastError: nil,
            feature: StationSyncClient.fuelQuoteFeature
        )
        let data = try StationSyncClient.encodedPayload(batch: batch)
        let root = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        precondition(root["schemaVersion"] as? Int == 3)
        precondition(root["sourceAgent"] as? String == "ios-ocr-agent")
        precondition(root["deviceSessionId"] as? String == "ios-device-session-v3")
        precondition(root["feature"] as? String == "fuel-quote-v1")
        let observations = root["observations"] as! [[String: Any]]
        let common = observations[0]["stationObservation"] as! [String: Any]
        precondition(common["address"] as? String == station.address)
        precondition(common["portSemantics"] as? String == "fuel-gun")
        precondition(common["sourceStage"] == nil)
        let quality = common["quality"] as! [String: Any]
        precondition(quality["platformConfidence"] == nil)
        let fuel = observations[0]["fuelObservation"] as! [String: Any]
        let offers = fuel["fuelOffers"] as! [[String: Any]]
        let quotes = fuel["fuelQuotes"] as! [[String: Any]]
        precondition(quotes.isEmpty)
        let offer = offers[0]
        for required in ["fuelType", "currency", "unit", "fieldSource", "evidence", "capturedAt"] {
            precondition(offer[required] != nil)
        }
        precondition(offer["displayPrice"] as? String == "7.28")
        precondition(offer["stationPrice"] as? String == "7.58")
        precondition(offer["nationalPrice"] as? String == "8.12")
        precondition(offer["gunCode"] == nil)
        precondition(offer["gunLabel"] == nil)
        print("StationSyncClient API v3 extended fuel offer payload fixture smoke test passed")

        let ordinaryStation = StationRecord(
            platform: "tuanyou",
            platformConfidence: 0.95,
            stationType: .fuel,
            stationName: "中石化西安普通报价加油站",
            address: "陕西省西安市雁塔区科技路20号",
            fuelOffers: [FuelOffer(
                gradeCode: "95",
                gradeLabel: "95#",
                displayPrice: 7.18
            )],
            capturedAt: capturedAt
        )
        let ordinaryBatch = OutboxBatch(
            idempotencyKey: String(repeating: "d", count: 64),
            deviceId: "device",
            deviceSessionId: "ios-device-session-v3",
            sessionId: "ios-session-v3",
            pageIndex: 2,
            city: "西安",
            platform: ordinaryStation.platform,
            capturedAt: capturedAt,
            stations: [ordinaryStation],
            attemptCount: 0,
            nextAttemptAt: .distantPast,
            lastError: nil
        )
        let ordinaryData = try StationSyncClient.encodedPayload(batch: ordinaryBatch)
        let ordinaryRoot = try JSONSerialization.jsonObject(with: ordinaryData) as! [String: Any]
        precondition(ordinaryRoot["feature"] == nil)
        let ordinaryObservations = ordinaryRoot["observations"] as! [[String: Any]]
        let ordinaryFuel = ordinaryObservations[0]["fuelObservation"] as! [String: Any]
        let ordinaryOffers = ordinaryFuel["fuelOffers"] as! [[String: Any]]
        precondition(ordinaryOffers[0]["displayPrice"] == nil)
        precondition(ordinaryOffers[0]["discountPrice"] as? String == "7.18")
        precondition(!StationSyncClient.requiresFuelQuoteFeature(stations: [ordinaryStation]))
        precondition(StationSyncClient.requiresFuelQuoteFeature(stations: [station]))
        print("StationSyncClient ordinary fuel payload omits feature")

        let enabledHealth = Data("""
        {"success":true,"data":{"ok":true,"sourceNode":"47-mysql","capabilities":{
        "latestSchemaVersion":3,"supportedSchemaVersions":[1,2,3],
        "stationObservation":true,"features":{"fuel-quote-v1":{
        "enabled":true,"platforms":["tuanyou","amap-fuel"],
        "captureMode":"user-driven-ocr"}}}}}
        """.utf8)
        let capability = try StationSyncClient.parseFuelQuoteCapability(
            data: enabledHealth,
            checkedAt: capturedAt
        )
        precondition(capability.allows(platform: "tuanyou"))
        precondition(!capability.allows(platform: "generic-station"))

        precondition(
            StationSyncClient.failureDisposition(
                for: StationSyncClient.SyncError.serverRejected(status: 408, code: nil)
            ) == .transient
        )
        precondition(
            StationSyncClient.failureDisposition(
                for: StationSyncClient.SyncError.serverRejected(status: 429, code: nil)
            ) == .transient
        )
        precondition(
            StationSyncClient.failureDisposition(
                for: StationSyncClient.SyncError.serverRejected(status: 503, code: nil)
            ) == .transient
        )
        precondition(
            StationSyncClient.failureDisposition(
                for: StationSyncClient.SyncError.serverRejected(status: 400, code: nil)
            ) == .permanent
        )
        precondition(
            StationSyncClient.failureDisposition(
                for: URLError(.notConnectedToInternet)
            ) == .transient
        )
        print("StationSyncClient health capability and failure classification smoke test passed")

        let mobile = "138" + "0013" + "8000"
        let identity = "610101" + "19900101" + "1234"
        let bankCard = "62220202" + "02020202"
        precondition(StationContentPolicy.isSafe("陕西省西安市雁塔区科技路18号"))
        precondition(StationContentPolicy.isSafe("支付宝大厦地下停车场"))
        precondition(!StationContentPolicy.isSafe("联系电话：\(mobile)"))
        precondition(!StationContentPolicy.isSafe("身份证号 \(identity)"))
        precondition(!StationContentPolicy.isSafe("银行卡号 \(bankCard)"))
        precondition(!StationContentPolicy.isSafe("订单号：ORDER12345"))
        precondition(!StationContentPolicy.isSafe("验证码：123456"))
        precondition(!StationContentPolicy.isSafe("支付密码：123456"))

        let unsafeStation = StationRecord(
            platform: "didi-charging",
            stationName: "测试充电站 \(mobile)"
        )
        let unsafeBatch = OutboxBatch(
            idempotencyKey: String(repeating: "e", count: 64),
            deviceId: "device",
            deviceSessionId: "ios-device-session-v3",
            sessionId: "ios-session-v3",
            pageIndex: 3,
            city: "西安",
            platform: unsafeStation.platform,
            capturedAt: capturedAt,
            stations: [unsafeStation],
            attemptCount: 0,
            nextAttemptAt: .distantPast,
            lastError: nil
        )
        do {
            _ = try StationSyncClient.encodedPayload(batch: unsafeBatch)
            preconditionFailure("sensitive station content must fail closed")
        } catch StationSyncClient.SyncError.sensitiveStationContent {
            // Expected second gate at the serializer boundary.
        }
        print("StationSyncClient sensitive station double-gate smoke test passed")
    }
}
