import Foundation
import StationOCRCore

@main
struct PayloadFixtureGenerator {
    static func main() throws {
        guard CommandLine.arguments.count == 2 else {
            throw GeneratorError.outputDirectoryRequired
        }
        let outputDirectory = URL(
            fileURLWithPath: CommandLine.arguments[1],
            isDirectory: true
        )
        try FileManager.default.createDirectory(
            at: outputDirectory,
            withIntermediateDirectories: true
        )

        for (name, batch) in fixtureBatches() {
            let payload = try StationSyncClient.encodedPayload(batch: batch)
            try payload.write(
                to: outputDirectory.appendingPathComponent(name),
                options: .atomic
            )
        }
    }

    private static func fixtureBatches() -> [(String, OutboxBatch)] {
        let capturedAt = Date(timeIntervalSince1970: 1_753_323_600)
        let charging = StationRecord(
            platform: "didi-charging",
            platformConfidence: 0.96,
            stationType: .charging,
            stationName: "小桔充电西安软件新城充电站",
            address: "陕西省西安市雁塔区云水一路88号停车场",
            priceFast: 0.85,
            priceSlow: 0.62,
            priceSuper: 1.20,
            priceService: 0.18,
            availablePorts: 6,
            busyPorts: 8,
            totalPorts: 14,
            fastIdlePorts: 3,
            fastTotalPorts: 8,
            slowIdlePorts: 1,
            slowTotalPorts: 2,
            superIdlePorts: 2,
            superTotalPorts: 4,
            capturedAt: capturedAt
        )
        let ordinaryFuel = StationRecord(
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
        let extendedFuel = StationRecord(
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

        return [
            (
                "ios-v3-charging.json",
                batch(
                    keyCharacter: "1",
                    pageIndex: 1,
                    station: charging,
                    capturedAt: capturedAt
                )
            ),
            (
                "ios-v3-fuel-basic.json",
                batch(
                    keyCharacter: "2",
                    pageIndex: 2,
                    station: ordinaryFuel,
                    capturedAt: capturedAt
                )
            ),
            (
                "ios-v3-fuel-extended.json",
                batch(
                    keyCharacter: "3",
                    pageIndex: 3,
                    station: extendedFuel,
                    capturedAt: capturedAt,
                    feature: StationSyncClient.fuelQuoteFeature
                )
            ),
        ]
    }

    private static func batch(
        keyCharacter: String,
        pageIndex: Int,
        station: StationRecord,
        capturedAt: Date,
        feature: String? = nil
    ) -> OutboxBatch {
        OutboxBatch(
            idempotencyKey: String(repeating: keyCharacter, count: 64),
            deviceId: "ios-fixture-device",
            deviceSessionId: "ios-fixture-device-session",
            sessionId: "ios-fixture-session",
            pageIndex: pageIndex,
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

    private enum GeneratorError: LocalizedError {
        case outputDirectoryRequired

        var errorDescription: String? {
            "usage: generate-payload-fixtures OUTPUT_DIRECTORY"
        }
    }
}
