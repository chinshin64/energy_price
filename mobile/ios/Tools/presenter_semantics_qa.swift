import Foundation
import StationOCRCore

func qaRequire(_ condition: @autoclosure () -> Bool, _ message: String) {
    guard condition() else {
        fatalError(message)
    }
}

func qaStation(
    availablePorts: Int?,
    busyPorts: Int?,
    totalPorts: Int?
) -> StationRecord {
    StationRecord(
        platform: "platform-must-not-replace-source-agent",
        stationName: "西安展示语义测试站",
        address: "陕西省西安市雁塔区测试路1号",
        availablePorts: availablePorts,
        busyPorts: busyPorts,
        totalPorts: totalPorts,
        capturedAt: Date(timeIntervalSince1970: 1_700_000_000)
    )
}

func qaCard(
    station: StationRecord,
    state: CollectedStation.SyncState
) -> StationCardPresentation {
    StationCardPresenter(capturedAtFormatter: { _ in "固定时间" }).present(CollectedStation(
        station: station,
        city: "西安",
        syncState: state,
        syncMessage: "该内部信息不得代替稳定展示语义",
        capturedAt: Date(timeIntervalSince1970: 1_700_000_000),
        ingestId: nil,
        sourceRecordId: nil
    ))
}

@main
enum PresenterSemanticsQa {
    static func main() {
        let qaUnknown = qaCard(
            station: qaStation(availablePorts: nil, busyPorts: nil, totalPorts: nil),
            state: .pending
        )
        qaRequire(
            qaUnknown.portText == "枪：闲 待补全 / 忙 待补全 / 总 待补全",
            "nil ports must remain unknown"
        )
        qaRequire(!qaUnknown.portText.contains("闲 0"), "unknown available ports became zero")
        qaRequire(!qaUnknown.portText.contains("忙 0"), "unknown busy ports became zero")
        qaRequire(!qaUnknown.portText.contains("总 0"), "unknown total ports became zero")

        let qaExplicitZero = qaCard(
            station: qaStation(availablePorts: 0, busyPorts: 0, totalPorts: 0),
            state: .pending
        )
        qaRequire(
            qaExplicitZero.portText == "枪：闲 0 / 忙 0 / 总 0",
            "explicit zero ports must be preserved"
        )
        qaRequire(!qaExplicitZero.portText.contains("待补全"), "explicit zero became unknown")

        let qaMixed = qaCard(
            station: qaStation(availablePorts: nil, busyPorts: 0, totalPorts: 3),
            state: .pending
        )
        qaRequire(
            qaMixed.portText == "枪：闲 待补全 / 忙 0 / 总 3",
            "mixed known and unknown port values lost field-level meaning"
        )

        let qaSyncCases: [
            (CollectedStation.SyncState, String, StationCardSyncTone)
        ] = [
            (.pending, "等待回传", .pending),
            (.uploading, "回传中", .pending),
            (.synced, "47已落库", .success),
            (.failed, "回传失败", .failure),
            (.needsAttention, "需人工处理", .failure),
        ]

        let qaStateStation = qaStation(availablePorts: nil, busyPorts: 0, totalPorts: 3)
        for (state, expectedText, expectedTone) in qaSyncCases {
            let card = qaCard(station: qaStateStation, state: state)
            qaRequire(card.syncText == expectedText, "sync state text mismatch: \(state)")
            qaRequire(card.syncTone == expectedTone, "sync state tone mismatch: \(state)")
            qaRequire(card.sourceAgentText == "ios-ocr-agent", "source agent lost: \(state)")
            qaRequire(
                card.portText == "枪：闲 待补全 / 忙 0 / 总 3",
                "sync state changed port semantics: \(state)"
            )
            qaRequire(
                !String(describing: card).contains("platform-must-not-replace-source-agent"),
                "platform leaked into presentation: \(state)"
            )
            qaRequire(
                !String(describing: card).contains("该内部信息不得代替稳定展示语义"),
                "raw sync message leaked into presentation: \(state)"
            )
        }

        print("Station card semantic QA matrix passed")
    }
}
