import Foundation
import StationOCRCore

@main
struct ProductionPayloadFixture {
    static func main() throws {
        guard CommandLine.arguments.count == 2 else {
            throw FixtureError.outputPathMissing
        }
        let capturedAt = Date(timeIntervalSinceNow: -60)
        let station = StationRecord(
            platform: "tuanyou",
            platformConfidence: 0.96,
            stationType: .fuel,
            stationName: "iOS生产序列化契约加油站",
            address: "湖北省武汉市江岸区测试大道5号",
            fuelOffers: [FuelOffer(
                gradeCode: "92",
                gradeLabel: "92#汽油",
                displayPrice: 6.85,
                stationPrice: 7.15,
                nationalPrice: 7.35
            )],
            availablePorts: 3,
            busyPorts: 2,
            totalPorts: 5,
            capturedAt: capturedAt
        )
        let deviceId = "ios-production-contract-device"
        let deviceSessionId = "ios-production-contract-device-session"
        let sessionId = "ios-production-contract-session"
        let idempotencyKey = StationSyncClient.idempotencyKey(
            deviceId: deviceId,
            deviceSessionId: deviceSessionId,
            sessionId: sessionId,
            pageIndex: 9,
            platform: station.platform,
            stationType: station.stationType,
            stations: [station]
        )
        var batch = OutboxBatch(
            idempotencyKey: idempotencyKey,
            deviceId: deviceId,
            deviceSessionId: deviceSessionId,
            sessionId: sessionId,
            pageIndex: 9,
            city: "武汉",
            platform: station.platform,
            capturedAt: capturedAt,
            stations: [station],
            attemptCount: 0,
            nextAttemptAt: .distantPast,
            lastError: nil
        )
        batch.feature = StationSyncClient.fuelQuoteFeature
        let payloadData = try StationSyncClient.encodedPayload(batch: batch)
        let payload = try JSONSerialization.jsonObject(with: payloadData)
        let fixture: [String: Any] = [
            "serializer": "ios-product-swift",
            "sourceAgent": StationSyncClient.sourceAgent,
            "idempotencyKey": idempotencyKey,
            "payload": payload,
        ]
        let output = try JSONSerialization.data(
            withJSONObject: fixture,
            options: [.sortedKeys]
        )
        try output.write(to: URL(fileURLWithPath: CommandLine.arguments[1]), options: .atomic)
    }

    private enum FixtureError: Error {
        case outputPathMissing
    }
}
