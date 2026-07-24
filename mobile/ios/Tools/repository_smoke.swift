import Foundation
import StationOCRCore

@main
struct RepositorySmoke {
    @MainActor
    static func main() throws {
        let managedSuiteName = "station-ocr-managed-\(UUID().uuidString)"
        let managedDefaults = UserDefaults(suiteName: managedSuiteName)!
        defer { managedDefaults.removePersistentDomain(forName: managedSuiteName) }
        precondition(AppConfiguration.endpoint(defaults: managedDefaults) == nil)
        managedDefaults.set(
            ["MobileIngestURL": "https://managed-ingest.example:5443"],
            forKey: "com.apple.configuration.managed"
        )
        precondition(
            AppConfiguration.endpoint(defaults: managedDefaults)?.absoluteString
                == "https://managed-ingest.example:5443"
        )

        let base = FileManager.default.temporaryDirectory
            .appendingPathComponent("station-ocr-repository-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: base) }

        let repository = StationRepository(baseDirectory: base)
        var partial = StationRecord(platform: "didi-charging", stationName: "软件新城站")
        var rows = repository.upsert([partial], city: "西安")
        precondition(rows.count == 1)

        partial.address = "陕西省西安市雁塔区云水一路88号"
        rows = repository.upsert([partial], city: "西安")
        precondition(rows.count == 1)
        precondition(rows[0].station.address == "陕西省西安市雁塔区云水一路88号")

        rows = repository.upsert([partial], city: "武汉")
        precondition(rows.count == 2)
        precondition(Set(rows.map(\.id)).count == 2)

        rows = repository.mark(
            stationIDs: [partial.id],
            city: "武汉",
            state: .synced,
            message: "47 MySQL 已落库"
        )
        precondition(rows.first(where: { $0.city == "武汉" })?.syncState == .synced)
        precondition(rows.first(where: { $0.city == "西安" })?.syncState == .pending)

        let acknowledgement = StationUploadAcknowledgement(
            ingestId: "ingest-batch",
            firstSourceRecordId: 101,
            lastSourceRecordId: 102,
            acceptedCount: 2,
            duplicate: false
        )
        let second = StationRecord(
            platform: "didi-charging",
            stationName: "软件新城二站"
        )
        rows = repository.upsert([second], city: "西安")
        rows = repository.mark(
            stationIDs: [partial.id, second.id],
            city: "西安",
            state: .synced,
            message: "47 MySQL 已落库",
            acknowledgement: acknowledgement
        )
        let batchRows = rows.filter {
            $0.city == "西安" && [partial.id, second.id].contains($0.station.id)
        }
        precondition(batchRows.count == 2)
        precondition(batchRows.allSatisfy { $0.ingestId == "ingest-batch" })
        precondition(batchRows.allSatisfy { $0.sourceRecordId == nil })

        let singleAcknowledgement = StationUploadAcknowledgement(
            ingestId: "ingest-single",
            firstSourceRecordId: 103,
            lastSourceRecordId: 103,
            acceptedCount: 1,
            duplicate: false
        )
        rows = repository.mark(
            stationIDs: [second.id],
            city: "西安",
            state: .synced,
            message: "47 MySQL 已落库",
            acknowledgement: singleAcknowledgement
        )
        precondition(rows.first {
            $0.city == "西安" && $0.station.id == second.id
        }?.sourceRecordId == 103)

        let outbox = OutboxRepository(baseDirectory: base)
        let batch = OutboxBatch(
            idempotencyKey: String(repeating: "a", count: 64),
            deviceId: "device",
            deviceSessionId: "device-session",
            sessionId: "session",
            pageIndex: 1,
            city: "西安",
            platform: partial.platform,
            capturedAt: partial.capturedAt,
            stations: [partial],
            attemptCount: 0,
            nextAttemptAt: .distantPast,
            lastError: nil
        )
        try outbox.enqueue(batch)
        precondition(outbox.count() == 1)
        precondition(OutboxRepository(baseDirectory: base).ready().first?.idempotencyKey == batch.idempotencyKey)
        outbox.markTransientFailure(batch.idempotencyKey, error: "network")
        precondition(outbox.count() == 1)
        outbox.makeAllReady()
        precondition(outbox.ready().count == 1)
        let persistedAcknowledgement = StationUploadAcknowledgement(
            ingestId: "ingest-recovery",
            firstSourceRecordId: 104,
            lastSourceRecordId: 104,
            acceptedCount: 1,
            duplicate: false
        )
        try outbox.recordAcknowledgement(
            batch.idempotencyKey,
            acknowledgement: persistedAcknowledgement
        )
        precondition(outbox.ready().isEmpty)
        precondition(OutboxRepository(baseDirectory: base).acknowledged().count == 1)

        let recoveredOutbox = OutboxRepository(baseDirectory: base)
        let recoveredBatch = try XCTUnwrap(recoveredOutbox.acknowledged().first)
        let recoveredAcknowledgement = try XCTUnwrap(recoveredBatch.acknowledgement)
        _ = try repository.commitAcknowledgement(
            batch: recoveredBatch,
            acknowledgement: recoveredAcknowledgement
        )
        try recoveredOutbox.finalizeAcknowledgement(recoveredBatch.idempotencyKey)
        precondition(outbox.count() == 0)

        var permanent = batch
        permanent = OutboxBatch(
            idempotencyKey: String(repeating: "c", count: 64),
            deviceId: permanent.deviceId,
            deviceSessionId: permanent.deviceSessionId,
            sessionId: permanent.sessionId,
            pageIndex: permanent.pageIndex,
            city: permanent.city,
            platform: permanent.platform,
            capturedAt: permanent.capturedAt,
            stations: permanent.stations,
            attemptCount: 0,
            nextAttemptAt: .distantPast,
            lastError: nil
        )
        try outbox.enqueue(permanent)
        outbox.markTerminalFailure(
            permanent.idempotencyKey,
            error: "HTTP 400",
            reason: UploadTerminalReason(
                kind: .quarantined,
                code: .serverContractRejected,
                httpStatus: 400,
                serverCode: "fixture_invalid",
                credentialFingerprint: nil
            )
        )
        outbox.makeAllReady()
        precondition(outbox.ready().isEmpty)
        precondition(outbox.terminalCount() == 1)

        let legacyBase = base.appendingPathComponent("legacy", isDirectory: true)
        let legacyDirectory = legacyBase.appendingPathComponent(
            "InformationAutoRecognition",
            isDirectory: true
        )
        try FileManager.default.createDirectory(
            at: legacyDirectory,
            withIntermediateDirectories: true
        )
        let legacy = LegacyOutboxBatch(
            idempotencyKey: String(repeating: "9", count: 64),
            deviceId: batch.deviceId,
            deviceSessionId: batch.deviceSessionId,
            sessionId: batch.sessionId,
            pageIndex: batch.pageIndex,
            city: batch.city,
            platform: batch.platform,
            capturedAt: batch.capturedAt,
            stations: batch.stations,
            attemptCount: 0,
            nextAttemptAt: .distantPast,
            lastError: nil,
            terminalFailure: nil
        )
        let legacyTerminal = LegacyOutboxBatch(
            idempotencyKey: String(repeating: "6", count: 64),
            deviceId: batch.deviceId,
            deviceSessionId: batch.deviceSessionId,
            sessionId: batch.sessionId,
            pageIndex: batch.pageIndex,
            city: batch.city,
            platform: batch.platform,
            capturedAt: batch.capturedAt,
            stations: batch.stations,
            attemptCount: 1,
            nextAttemptAt: .distantFuture,
            lastError: "legacy terminal",
            terminalFailure: true
        )
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        try encoder.encode([legacy, legacyTerminal]).write(
            to: legacyDirectory.appendingPathComponent("outbox-v1.json"),
            options: .atomic
        )
        let migratedLegacy = OutboxRepository(baseDirectory: legacyBase)
        precondition(migratedLegacy.ready().count == 1)
        precondition(migratedLegacy.ready()[0].feature == nil)
        precondition(migratedLegacy.ready()[0].acknowledgement == nil)
        precondition(migratedLegacy.ready()[0].terminalFailure == nil)
        precondition(migratedLegacy.ready()[0].terminalReason == nil)
        precondition(migratedLegacy.terminalCount() == 1)
        precondition(migratedLegacy.quarantinedCount() == 1)
        migratedLegacy.makeAllReady()
        precondition(migratedLegacy.ready().count == 1)

        let deferred = DeferredFeatureRepository(baseDirectory: base)
        var deferredBatch = batch
        deferredBatch.feature = nil
        try deferred.enqueue(deferredBatch)
        try outbox.enqueue(deferredBatch)
        try outbox.enqueue(deferredBatch)
        precondition(outbox.ready().filter {
            $0.idempotencyKey == deferredBatch.idempotencyKey
        }.count == 1)
        try deferred.remove(deferredBatch.idempotencyKey)
        precondition(deferred.count() == 0)

        let capabilityRepository = FeatureCapabilityRepository(baseDirectory: base)
        let capability = FuelQuoteCapabilitySnapshot(
            status: .enabled,
            platforms: ["amap-fuel", "tuanyou"],
            checkedAt: Date()
        )
        capabilityRepository.save(capability)
        precondition(
            FeatureCapabilityRepository(baseDirectory: base).fresh()?.allows(
                platform: "tuanyou"
            ) == true
        )

        let capacityBase = base.appendingPathComponent("capacity", isDirectory: true)
        let capacityStations = StationRepository(baseDirectory: capacityBase)
        let capacityOutbox = OutboxRepository(
            baseDirectory: capacityBase,
            maximumBatchCount: 1
        )
        let capacityDeferred = DeferredFeatureRepository(
            baseDirectory: capacityBase,
            maximumBatchCount: 1
        )
        let capacityJournal = CollectionJournalRepository(baseDirectory: capacityBase)
        let capacityCoordinator = CollectionTransactionCoordinator(
            stationRepository: capacityStations,
            outboxRepository: capacityOutbox,
            deferredRepository: capacityDeferred,
            journalRepository: capacityJournal
        )
        let occupiedBatch = makeBatch(
            key: String(repeating: "7", count: 64),
            station: partial
        )
        try capacityOutbox.enqueue(occupiedBatch)
        let rejectedStation = StationRecord(
            platform: "didi-charging",
            stationName: "容量拒绝测试充电站"
        )
        let rejectedBatch = makeBatch(
            key: String(repeating: "8", count: 64),
            station: rejectedStation
        )
        let rejectedTransaction = makeTransaction(
            id: "capacity-rejected",
            station: rejectedStation,
            batch: rejectedBatch,
            target: .outbox
        )
        do {
            _ = try capacityCoordinator.commit(rejectedTransaction)
            preconditionFailure("full queue must reject the whole transaction")
        } catch OutboxRepository.OutboxError.capacityExceeded {
            // Expected: preflight happens before journal or station writes.
        }
        precondition(capacityStations.load().isEmpty)
        precondition(capacityJournal.pending() == nil)

        let replacementTransaction = makeTransaction(
            id: "capacity-idempotent-replacement",
            station: partial,
            batch: occupiedBatch,
            target: .outbox
        )
        let replacementRows = try capacityCoordinator.commit(replacementTransaction)
        precondition(replacementRows.count == 1)
        precondition(capacityOutbox.count() == 1)

        let recoveryBase = base.appendingPathComponent("journal-recovery", isDirectory: true)
        let recoveryStations = StationRepository(baseDirectory: recoveryBase)
        let recoveryOutbox = OutboxRepository(baseDirectory: recoveryBase)
        let recoveryDeferred = DeferredFeatureRepository(baseDirectory: recoveryBase)
        let recoveryJournal = CollectionJournalRepository(baseDirectory: recoveryBase)
        let recoveryCoordinator = CollectionTransactionCoordinator(
            stationRepository: recoveryStations,
            outboxRepository: recoveryOutbox,
            deferredRepository: recoveryDeferred,
            journalRepository: recoveryJournal
        )
        let recoveryCharging = StationRecord(
            platform: "didi-charging",
            stationName: "事务恢复充电站"
        )
        let recoveryFuel = StationRecord(
            platform: "tuanyou",
            stationType: .fuel,
            stationName: "事务恢复加油站",
            fuelOffers: [FuelOffer(
                gradeCode: "92",
                gradeLabel: "92#",
                displayPrice: 7.20,
                stationPrice: 7.50
            )]
        )
        let recoveryChargingBatch = makeBatch(
            key: String(repeating: "4", count: 64),
            station: recoveryCharging
        )
        let recoveryFuelBatch = makeBatch(
            key: String(repeating: "5", count: 64),
            station: recoveryFuel
        )
        let recoveryTransaction = CollectionTransaction(
            id: "partial-queue-crash",
            createdAt: Date(),
            localObservations: [
                CollectionLocalObservation(
                    station: recoveryCharging,
                    city: "西安",
                    syncState: .pending,
                    syncMessage: "等待回传"
                ),
                CollectionLocalObservation(
                    station: recoveryFuel,
                    city: "西安",
                    syncState: .pending,
                    syncMessage: "等待47扩展油价能力确认"
                ),
            ],
            queueEntries: [
                CollectionQueueEntry(target: .outbox, batch: recoveryChargingBatch),
                CollectionQueueEntry(target: .deferredFeature, batch: recoveryFuelBatch),
            ]
        )
        try recoveryJournal.prepare(recoveryTransaction)
        try recoveryOutbox.enqueue(recoveryChargingBatch)
        precondition(recoveryStations.load().isEmpty)
        let recoveredRows = try XCTUnwrap(try recoveryCoordinator.recover())
        precondition(recoveredRows.count == 2)
        precondition(recoveryOutbox.count() == 1)
        precondition(recoveryDeferred.count() == 1)
        precondition(recoveryJournal.pending() == nil)

        let retryBase = base.appendingPathComponent("typed-terminal", isDirectory: true)
        let retryOutbox = OutboxRepository(baseDirectory: retryBase)
        let credentialBatch = makeBatch(
            key: String(repeating: "a", count: 64),
            station: partial
        )
        try retryOutbox.enqueue(credentialBatch)
        let oldFingerprint = StationSyncClient.credentialFingerprint(token: "old-token")
        let newFingerprint = StationSyncClient.credentialFingerprint(token: "new-token")
        retryOutbox.markTerminalFailure(
            credentialBatch.idempotencyKey,
            error: "HTTP 401",
            reason: StationSyncClient.terminalReason(
                for: StationSyncClient.SyncError.serverRejected(
                    status: 401,
                    code: "machine_auth_failed"
                ),
                credentialFingerprint: oldFingerprint
            )
        )
        retryOutbox.makeAllReady()
        precondition(retryOutbox.ready().isEmpty)
        retryOutbox.reactivateCredentialFailures(
            currentFingerprint: oldFingerprint
        )
        precondition(retryOutbox.ready().map(\.idempotencyKey).contains(
            credentialBatch.idempotencyKey
        ))
        retryOutbox.markTerminalFailure(
            credentialBatch.idempotencyKey,
            error: "HTTP 401",
            reason: StationSyncClient.terminalReason(
                for: StationSyncClient.SyncError.serverRejected(
                    status: 401,
                    code: "machine_auth_failed"
                ),
                credentialFingerprint: oldFingerprint
            )
        )
        retryOutbox.reactivateCredentialFailures(
            currentFingerprint: newFingerprint
        )
        precondition(retryOutbox.ready().map(\.idempotencyKey).contains(
            credentialBatch.idempotencyKey
        ))

        let sensitiveBatch = makeBatch(
            key: String(repeating: "b", count: 64),
            station: partial
        )
        let structuralBatch = makeBatch(
            key: String(repeating: "c", count: 64),
            station: partial
        )
        try retryOutbox.enqueue(sensitiveBatch)
        try retryOutbox.enqueue(structuralBatch)
        retryOutbox.markTerminalFailure(
            sensitiveBatch.idempotencyKey,
            error: "sensitive",
            reason: StationSyncClient.terminalReason(
                for: StationSyncClient.SyncError.sensitiveStationContent
            )
        )
        retryOutbox.markTerminalFailure(
            structuralBatch.idempotencyKey,
            error: "mixed",
            reason: StationSyncClient.terminalReason(
                for: StationSyncClient.SyncError.mixedBatch
            )
        )
        retryOutbox.makeAllReady()
        retryOutbox.reactivateCredentialFailures(
            currentFingerprint: newFingerprint
        )
        let readyKeys = Set(retryOutbox.ready().map(\.idempotencyKey))
        precondition(!readyKeys.contains(sensitiveBatch.idempotencyKey))
        precondition(!readyKeys.contains(structuralBatch.idempotencyKey))
        precondition(retryOutbox.quarantinedCount() == 2)

        let featureBatch = makeBatch(
            key: String(repeating: "d", count: 64),
            station: partial
        )
        try retryOutbox.enqueue(featureBatch)
        retryOutbox.markTerminalFailure(
            featureBatch.idempotencyKey,
            error: "HTTP 409",
            reason: StationSyncClient.terminalReason(
                for: StationSyncClient.SyncError.serverRejected(
                    status: 409,
                    code: "mobile_source_feature_disabled"
                )
            )
        )
        precondition(
            retryOutbox.repairableFeatureBatches().map(\.idempotencyKey)
                .contains(featureBatch.idempotencyKey)
        )
        let featureAt400 = StationSyncClient.terminalReason(
            for: StationSyncClient.SyncError.serverRejected(
                status: 400,
                code: "mobile_source_feature_disabled"
            )
        )
        precondition(featureAt400.kind == .repairable)
        precondition(featureAt400.code == .featureCapabilityConflict)
        precondition(featureAt400.httpStatus == 400)
        print("StationRepository and persistent outbox smoke test passed")
    }

    private static func XCTUnwrap<T>(_ value: T?) throws -> T {
        guard let value else {
            throw NSError(domain: "RepositorySmoke", code: 1)
        }
        return value
    }

    private struct LegacyOutboxBatch: Encodable {
        let idempotencyKey: String
        let deviceId: String
        let deviceSessionId: String
        let sessionId: String
        let pageIndex: Int
        let city: String
        let platform: String
        let capturedAt: Date
        let stations: [StationRecord]
        let attemptCount: Int
        let nextAttemptAt: Date
        let lastError: String?
        let terminalFailure: Bool?
    }

    private static func makeBatch(
        key: String,
        station: StationRecord
    ) -> OutboxBatch {
        OutboxBatch(
            idempotencyKey: key,
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
    }

    private static func makeTransaction(
        id: String,
        station: StationRecord,
        batch: OutboxBatch,
        target: CollectionQueueTarget
    ) -> CollectionTransaction {
        CollectionTransaction(
            id: id,
            createdAt: Date(),
            localObservations: [CollectionLocalObservation(
                station: station,
                city: "西安",
                syncState: .pending,
                syncMessage: "等待回传"
            )],
            queueEntries: [CollectionQueueEntry(target: target, batch: batch)]
        )
    }
}
