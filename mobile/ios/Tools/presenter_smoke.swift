import Foundation
import StationOCRCore

func require(_ condition: @autoclosure () -> Bool, _ message: String) {
    guard condition() else {
        fatalError(message)
    }
}

@main
enum StationCardPresenterSmoke {
    static func main() {
        let presenter = StationCardPresenter(capturedAtFormatter: { _ in "固定采集时间" })
        let capturedAt = Date(timeIntervalSince1970: 1_700_000_000)

        let zeroCharging = StationRecord(
    platform: "internal-platform-value",
    stationName: " ",
    address: nil,
    priceFast: 0,
    availablePorts: 0,
    busyPorts: 0,
    totalPorts: 0,
    capturedAt: capturedAt,
    missingFields: ["stationName", "address", "endpoint", "token"]
)
        let failedCard = presenter.present(CollectedStation(
    station: zeroCharging,
    city: "西安",
    syncState: .failed,
    syncMessage: "包含内部地址的错误不应透传",
    capturedAt: capturedAt,
    ingestId: nil,
    sourceRecordId: nil
))
        require(failedCard.nameText == "名称待补全", "missing station name presentation mismatch")
        require(failedCard.addressText == "地址待补全", "missing address presentation mismatch")
        require(failedCard.portText == "枪：闲 0 / 忙 0 / 总 0", "explicit zero ports were lost")
        require(failedCard.priceLines == ["价格：快 ¥0"], "explicit zero price was lost")
        require(failedCard.missingFieldsText == "待补全：场站名称、地址", "missing field labels mismatch")
        require(failedCard.sourceAgentText == "ios-ocr-agent", "source agent presentation mismatch")
        require(failedCard.capturedAtText == "固定采集时间", "capturedAt presentation mismatch")
        require(failedCard.syncText == "回传失败", "failure state presentation mismatch")
        require(failedCard.syncTone == .failure, "failure tone mismatch")
        require(!String(describing: failedCard).contains("internal-platform-value"), "platform leaked into card")
        require(!String(describing: failedCard).contains("endpoint"), "endpoint field leaked into card")
        require(!String(describing: failedCard).contains("token"), "token field leaked into card")
        require(!String(describing: failedCard).contains("内部地址"), "raw sync message leaked into card")

        let unknownCharging = StationRecord(
    platform: "generic-station",
    stationName: "测试充电站",
    address: "",
    capturedAt: capturedAt,
    missingFields: ["address", "availablePorts", "busyPorts", "totalPorts"]
)
        let pendingCard = presenter.present(CollectedStation(
    station: unknownCharging,
    city: nil,
    syncState: .pending,
    syncMessage: "等待回传",
    capturedAt: capturedAt,
    ingestId: nil,
    sourceRecordId: nil
))
        require(
            pendingCard.portText == "枪：闲 待补全 / 忙 待补全 / 总 待补全",
            "unknown ports must stay pending"
        )
        require(pendingCard.priceLines == ["价格：待补全"], "unknown prices must stay pending")
        require(pendingCard.syncText == "等待回传", "pending state mismatch")
        require(pendingCard.syncTone == .pending, "pending tone mismatch")

        let fuel = StationRecord(
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
    capturedAt: capturedAt
)
        let syncedCard = presenter.present(CollectedStation(
    station: fuel,
    city: "西安",
    syncState: .synced,
    syncMessage: "47已落库",
    capturedAt: capturedAt,
    ingestId: "ingest-test",
    sourceRecordId: 1
))
        require(syncedCard.stationTypeText == "加油", "fuel type mismatch")
        require(syncedCard.portText == "枪：闲 2 / 忙 3 / 总 5", "fuel gun status mismatch")
        require(
            syncedCard.priceLines == ["92#：外显 ¥0 / 油站 ¥7.5 / 12号枪"],
            "fuel price presentation mismatch"
        )
        require(syncedCard.syncText == "47已落库", "synced state mismatch")
        require(syncedCard.syncTone == .success, "synced tone mismatch")

        let attentionCard = presenter.present(CollectedStation(
    station: unknownCharging,
    city: nil,
    syncState: .needsAttention,
    syncMessage: "需人工处理",
    capturedAt: capturedAt,
    ingestId: nil,
    sourceRecordId: nil
))
        require(attentionCard.syncText == "需人工处理", "attention state mismatch")
        require(attentionCard.syncTone == .failure, "attention tone mismatch")

        print("Station card presenter smoke passed")
    }
}
