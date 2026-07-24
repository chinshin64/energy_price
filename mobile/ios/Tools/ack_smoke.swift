import Foundation
import StationOCRCore

@main
struct AcknowledgementSmoke {
    static func main() throws {
        let accepted = Data("""
        {"success":true,"data":{"persisted":true,"sourceNode":"47-mysql",
        "sourceAgent":"ios-ocr-agent","ingestId":"ingest-ios-v3","acceptedCount":2,
        "firstSourceRecordId":101,"lastSourceRecordId":103,"duplicate":false}}
        """.utf8)
        let acknowledgement = try StationSyncClient.parseAcknowledgement(
            data: accepted,
            expectedCount: 2
        )
        precondition(acknowledgement.ingestId == "ingest-ios-v3")
        precondition(acknowledgement.firstSourceRecordId == 101)
        precondition(acknowledgement.lastSourceRecordId == 103)

        let mismatchedAgent = Data("""
        {"success":true,"data":{"persisted":true,"sourceNode":"47-mysql",
        "sourceAgent":"android-ocr-agent","ingestId":"wrong","acceptedCount":1,
        "firstSourceRecordId":1,"lastSourceRecordId":1,"duplicate":false}}
        """.utf8)
        do {
            _ = try StationSyncClient.parseAcknowledgement(data: mismatchedAgent, expectedCount: 1)
            preconditionFailure("agent mismatch must fail closed")
        } catch {
            // Expected.
        }
        print("StationSyncClient strict ACK fixture smoke test passed")
    }
}
