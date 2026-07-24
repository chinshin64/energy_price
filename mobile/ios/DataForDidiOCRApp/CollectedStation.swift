import Foundation
import StationOCRCore

struct CollectedStation: Codable, Identifiable, Equatable {
    enum SyncState: String, Codable {
        case pending
        case uploading
        case synced
        case failed
        case needsAttention
    }

    var id: String {
        "\(city ?? "")|\(station.id)|\(capturedAt.timeIntervalSince1970)"
    }
    var station: StationRecord
    var city: String?
    var syncState: SyncState
    var syncMessage: String
    var capturedAt: Date
    var ingestId: String?
    var sourceRecordId: Int?
}

enum StationCardSyncTone: Equatable {
    case pending
    case success
    case failure
}

struct StationCardPresentation: Equatable {
    let nameText: String
    let isNameMissing: Bool
    let addressText: String
    let isAddressMissing: Bool
    let stationTypeText: String
    let portText: String
    let priceLines: [String]
    let missingFieldsText: String?
    let sourceAgentText: String
    let capturedAtText: String
    let syncText: String
    let syncTone: StationCardSyncTone
}

struct StationCardPresenter {
    private static let missingFieldLabels = [
        "stationName": "场站名称",
        "address": "地址",
        "availablePorts": "闲枪数",
        "busyPorts": "忙枪数",
        "totalPorts": "总枪数",
        "priceFast": "快充价格",
        "priceSlow": "慢充价格",
        "priceSuper": "超充价格",
        "priceService": "服务费",
        "fuelOffers": "油价",
        "fuelQuotes": "报价",
        "providerName": "服务商",
    ]

    private let capturedAtFormatter: (Date) -> String

    init(
        capturedAtFormatter: @escaping (Date) -> String = {
            DateFormatter.localizedString(
                from: $0,
                dateStyle: .short,
                timeStyle: .medium
            )
        }
    ) {
        self.capturedAtFormatter = capturedAtFormatter
    }

    func present(_ item: CollectedStation) -> StationCardPresentation {
        let station = item.station
        let name = normalized(station.stationName)
        let address = normalized(station.address)
        let sync = syncPresentation(item.syncState)
        return StationCardPresentation(
            nameText: name ?? "名称待补全",
            isNameMissing: name == nil,
            addressText: address ?? "地址待补全",
            isAddressMissing: address == nil,
            stationTypeText: station.stationType == .fuel ? "加油" : "充电",
            portText: portText(station),
            priceLines: priceLines(station),
            missingFieldsText: missingFieldsText(station.missingFields),
            sourceAgentText: StationRecord.sourceAgent,
            capturedAtText: capturedAtFormatter(item.capturedAt),
            syncText: sync.text,
            syncTone: sync.tone
        )
    }

    private func portText(_ station: StationRecord) -> String {
        "枪：闲 \(numberText(station.availablePorts))"
            + " / 忙 \(numberText(station.busyPorts))"
            + " / 总 \(numberText(station.totalPorts))"
    }

    private func priceLines(_ station: StationRecord) -> [String] {
        if station.stationType == .fuel {
            guard !station.fuelOffers.isEmpty else { return ["价格：待补全"] }
            return station.fuelOffers.map { offer in
                let grade = normalized(offer.gradeLabel)
                    ?? normalized(offer.gradeCode)
                    ?? "油号待补全"
                var fields = [String]()
                if let value = offer.displayPrice {
                    fields.append("外显 ¥\(priceText(value))")
                }
                if let value = offer.stationPrice {
                    fields.append("油站 ¥\(priceText(value))")
                }
                if let value = offer.nationalPrice {
                    fields.append("国标 ¥\(priceText(value))")
                }
                if fields.isEmpty {
                    fields.append("价格待补全")
                }
                if let gun = normalized(offer.gunLabel) ?? normalized(offer.gunCode) {
                    fields.append(gun)
                }
                return "\(grade)：\(fields.joined(separator: " / "))"
            }
        }

        var fields = [String]()
        if let value = station.priceFast { fields.append("快 ¥\(priceText(value))") }
        if let value = station.priceSlow { fields.append("慢 ¥\(priceText(value))") }
        if let value = station.priceSuper { fields.append("超 ¥\(priceText(value))") }
        if let value = station.priceService { fields.append("服务费 ¥\(priceText(value))") }
        return ["价格：" + (fields.isEmpty ? "待补全" : fields.joined(separator: " / "))]
    }

    private func missingFieldsText(_ fields: [String]) -> String? {
        var labels = [String]()
        for field in fields {
            guard let label = Self.missingFieldLabels[field], !labels.contains(label) else {
                continue
            }
            labels.append(label)
        }
        return labels.isEmpty ? nil : "待补全：" + labels.joined(separator: "、")
    }

    private func syncPresentation(
        _ state: CollectedStation.SyncState
    ) -> (text: String, tone: StationCardSyncTone) {
        switch state {
        case .pending:
            ("等待回传", .pending)
        case .uploading:
            ("回传中", .pending)
        case .synced:
            ("47已落库", .success)
        case .failed:
            ("回传失败", .failure)
        case .needsAttention:
            ("需人工处理", .failure)
        }
    }

    private func normalized(_ value: String?) -> String? {
        guard let text = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              !text.isEmpty else {
            return nil
        }
        return text
    }

    private func numberText(_ value: Int?) -> String {
        value.map(String.init) ?? "待补全"
    }

    private func priceText(_ value: Double) -> String {
        var text = String(
            format: "%.4f",
            locale: Locale(identifier: "en_US_POSIX"),
            value
        )
        while text.contains("."), text.last == "0" {
            text.removeLast()
        }
        if text.last == "." {
            text.removeLast()
        }
        return text
    }
}

struct OutboxBatch: Codable, Identifiable, Equatable {
    var id: String { idempotencyKey }
    let idempotencyKey: String
    let deviceId: String
    let deviceSessionId: String
    let sessionId: String
    let pageIndex: Int
    let city: String
    let platform: String
    let capturedAt: Date
    let stations: [StationRecord]
    var attemptCount: Int
    var nextAttemptAt: Date
    var lastError: String?
    var feature: String? = nil
    var acknowledgement: StationUploadAcknowledgement? = nil
    var terminalFailure: Bool? = nil
    var terminalReason: UploadTerminalReason? = nil
}

struct UploadTerminalReason: Codable, Equatable {
    enum Kind: String, Codable {
        case repairable
        case quarantined
    }

    enum Code: String, Codable {
        case credentialRejected
        case featureCapabilityConflict
        case legacyTerminal
        case mixedBatch
        case sensitiveContent
        case invalidFuelOffer
        case endpointInvalid
        case acknowledgementInvalid
        case idempotencyConflict
        case clientContractInvalid
        case serverContractRejected
    }

    let kind: Kind
    let code: Code
    let httpStatus: Int?
    let serverCode: String?
    let credentialFingerprint: String?
}

enum CollectionQueueTarget: String, Codable {
    case outbox
    case deferredFeature
}

struct CollectionQueueEntry: Codable, Equatable {
    let target: CollectionQueueTarget
    let batch: OutboxBatch
}

struct CollectionLocalObservation: Codable, Equatable {
    let station: StationRecord
    let city: String
    let syncState: CollectedStation.SyncState
    let syncMessage: String
}

struct CollectionTransaction: Codable, Equatable, Identifiable {
    let id: String
    let createdAt: Date
    let localObservations: [CollectionLocalObservation]
    let queueEntries: [CollectionQueueEntry]
    var screenSignature: String? = nil
    var pageIndexAfterCommit: Int? = nil
}

struct FuelQuoteCapabilitySnapshot: Codable, Equatable {
    enum Status: String, Codable {
        case enabled
        case disabled
        case unavailable
    }

    let status: Status
    let platforms: [String]
    let checkedAt: Date

    func allows(platform: String) -> Bool {
        status == .enabled && platforms.contains(platform.lowercased())
    }

    func isFresh(at date: Date = Date()) -> Bool {
        let lifetime: TimeInterval = status == .unavailable ? 60 : 300
        return checkedAt <= date && date.timeIntervalSince(checkedAt) <= lifetime
    }
}

enum StationContentPolicy {
    private static let patterns = [
        #"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b"#,
        #"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b"#,
        #"(?:手机号|手机号码|联系电话)\s*[:：=]?\s*1[3-9]\d{9}"#,
        #"(?:身份证(?:号|号码)?)\s*[:：=]?\s*\d{17}[\dXx]"#,
        #"(?:银行卡(?:号|号码)?|卡号)\s*[:：=]?\s*(?:\d[ -]?){12,19}"#,
        #"(?:账号|账户|用户名)\s*[:：=]?\s*[A-Za-z0-9*._-]{4,}"#,
        #"(?:订单|交易)(?:号|编号|流水号|单号)\s*[:：=]?\s*[A-Za-z0-9_-]{4,}"#,
        #"(?:验证码|校验码|短信码)\s*[:：=]?\s*[A-Za-z0-9_-]{4,}"#,
        #"(?:支付(?:号|编号|流水号|账号|账户|密码)|付款码)\s*[:：=]?\s*[A-Za-z0-9*._-]{4,}"#,
        #"(?:密码|口令)\s*[:：=]?\s*[A-Za-z0-9*._-]{4,}"#,
        #"(?<!\d)1[3-9]\d{9}(?!\d)"#,
        #"(?<!\d)\d{17}[\dXx](?!\d)"#,
        #"(?<!\d)(?:\d[ -]?){16,19}(?!\d)"#,
    ].compactMap { try? NSRegularExpression(pattern: $0) }

    static func isSafe(_ station: StationRecord) -> Bool {
        isSafe(station.stationName) && isSafe(station.address)
    }

    static func isSafe(_ value: String?) -> Bool {
        guard let value else { return true }
        let range = NSRange(value.startIndex..<value.endIndex, in: value)
        return patterns.allSatisfy { $0.firstMatch(in: value, range: range) == nil }
    }
}

private struct AtomicJSONFile<Value: Codable> {
    let url: URL
    let emptyValue: Value

    func load() -> Value {
        guard let data = try? Data(contentsOf: url),
              let value = try? Self.decoder.decode(Value.self, from: data) else {
            return emptyValue
        }
        return value
    }

    func save(_ value: Value) throws {
        let directory = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
        )
        let data = try Self.encoder.encode(value)
        try data.write(to: url, options: [.atomic, .completeFileProtection])
    }

    func remove() {
        try? FileManager.default.removeItem(at: url)
    }

    func removeOrThrow() throws {
        guard FileManager.default.fileExists(atPath: url.path) else { return }
        try FileManager.default.removeItem(at: url)
    }

    private static var encoder: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }

    private static var decoder: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }
}

@MainActor
final class StationRepository {
    static let maximumCount = 1000
    private let file: AtomicJSONFile<[CollectedStation]>

    init(baseDirectory: URL? = nil, fileManager: FileManager = .default) {
        let base = baseDirectory
            ?? fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? fileManager.temporaryDirectory
        file = AtomicJSONFile(
            url: base.appendingPathComponent("InformationAutoRecognition/stations-v2.json"),
            emptyValue: []
        )
    }

    func load() -> [CollectedStation] {
        file.load()
    }

    @discardableResult
    func upsert(_ stations: [StationRecord], city: String) -> [CollectedStation] {
        let observations = stations.map {
            CollectionLocalObservation(
                station: $0,
                city: city,
                syncState: .pending,
                syncMessage: "等待回传"
            )
        }
        return (try? apply(observations)) ?? load()
    }

    func apply(
        _ observations: [CollectionLocalObservation]
    ) throws -> [CollectedStation] {
        guard observations.allSatisfy({
            StationContentPolicy.isSafe($0.station)
        }) else {
            throw RepositoryError.sensitiveContent
        }
        var rows = load()
        for observation in observations {
            let station = observation.station
            let city = observation.city
            rows.removeAll { $0.station.id == station.id && ($0.city ?? city) == city }
            rows.insert(CollectedStation(
                station: station,
                city: city,
                syncState: observation.syncState,
                syncMessage: String(observation.syncMessage.prefix(160)),
                capturedAt: station.capturedAt,
                ingestId: nil,
                sourceRecordId: nil
            ), at: 0)
        }
        rows = Array(rows.prefix(Self.maximumCount))
        try file.save(rows)
        return rows
    }

    func commitAcknowledgement(
        batch: OutboxBatch,
        acknowledgement: StationUploadAcknowledgement
    ) throws -> [CollectedStation] {
        var rows = load()
        let singleRecordAcknowledged = batch.stations.count == 1
            && acknowledgement.acceptedCount == 1
            && acknowledgement.firstSourceRecordId == acknowledgement.lastSourceRecordId
        let sourceRecordId = singleRecordAcknowledged
            ? acknowledgement.firstSourceRecordId
            : nil
        for station in batch.stations {
            let index = rows.firstIndex {
                $0.station.id == station.id
                    && ($0.city ?? batch.city) == batch.city
                    && abs($0.capturedAt.timeIntervalSince(station.capturedAt)) < 0.001
            }
            if let index {
                rows[index].syncState = .synced
                rows[index].syncMessage = "47已落库"
                rows[index].ingestId = acknowledgement.ingestId
                rows[index].sourceRecordId = sourceRecordId
            } else {
                rows.insert(CollectedStation(
                    station: station,
                    city: batch.city,
                    syncState: .synced,
                    syncMessage: "47已落库",
                    capturedAt: station.capturedAt,
                    ingestId: acknowledgement.ingestId,
                    sourceRecordId: sourceRecordId
                ), at: 0)
            }
        }
        rows = Array(rows.prefix(Self.maximumCount))
        try file.save(rows)
        return rows
    }

    @discardableResult
    func resetInterruptedUploads() -> [CollectedStation] {
        var rows = load()
        var changed = false
        for index in rows.indices where rows[index].syncState == .uploading {
            rows[index].syncState = .pending
            rows[index].syncMessage = "等待回传"
            changed = true
        }
        if changed { try? file.save(rows) }
        return rows
    }

    @discardableResult
    func mark(
        stationIDs: Set<String>,
        city: String,
        state: CollectedStation.SyncState,
        message: String,
        acknowledgement: StationUploadAcknowledgement? = nil
    ) -> [CollectedStation] {
        var rows = load()
        let singleRecordAcknowledged = stationIDs.count == 1
            && acknowledgement?.acceptedCount == 1
            && acknowledgement?.firstSourceRecordId == acknowledgement?.lastSourceRecordId
        let sourceRecordId = singleRecordAcknowledged
            ? acknowledgement?.firstSourceRecordId
            : nil
        for index in rows.indices
        where stationIDs.contains(rows[index].station.id) && (rows[index].city ?? city) == city {
            rows[index].syncState = state
            rows[index].syncMessage = String(message.prefix(160))
            rows[index].ingestId = acknowledgement?.ingestId
            rows[index].sourceRecordId = sourceRecordId
        }
        try? file.save(rows)
        return rows
    }

    func clear() {
        file.remove()
    }

    enum RepositoryError: LocalizedError {
        case sensitiveContent

        var errorDescription: String? {
            "场站名称或地址包含敏感内容"
        }
    }
}

@MainActor
final class OutboxRepository {
    static let maximumBatchCount = 500
    private let file: AtomicJSONFile<[OutboxBatch]>
    private let capacity: Int

    init(
        baseDirectory: URL? = nil,
        fileManager: FileManager = .default,
        maximumBatchCount: Int = 500
    ) {
        let base = baseDirectory
            ?? fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? fileManager.temporaryDirectory
        file = AtomicJSONFile(
            url: base.appendingPathComponent("InformationAutoRecognition/outbox-v1.json"),
            emptyValue: []
        )
        capacity = max(1, maximumBatchCount)
    }

    func enqueue(_ batch: OutboxBatch) throws {
        var rows = file.load()
        rows.removeAll { $0.idempotencyKey == batch.idempotencyKey }
        rows.insert(batch, at: 0)
        guard rows.count <= capacity else {
            throw OutboxError.capacityExceeded
        }
        try file.save(rows)
    }

    func ensureCapacity(for batches: [OutboxBatch]) throws {
        let rows = file.load()
        let existing = Set(rows.map(\.idempotencyKey))
        let requested = Set(batches.map(\.idempotencyKey))
        let newCount = requested.subtracting(existing).count
        guard rows.count + newCount <= capacity else {
            throw OutboxError.capacityExceeded
        }
    }

    func ready(at date: Date = Date()) -> [OutboxBatch] {
        file.load()
            .filter {
                $0.acknowledgement == nil
                    && $0.terminalFailure != true
                    && $0.terminalReason == nil
                    && $0.nextAttemptAt <= date
            }
            .sorted { $0.capturedAt < $1.capturedAt }
    }

    func acknowledged() -> [OutboxBatch] {
        file.load()
            .filter { $0.acknowledgement != nil }
            .sorted { $0.capturedAt < $1.capturedAt }
    }

    func recordAcknowledgement(
        _ idempotencyKey: String,
        acknowledgement: StationUploadAcknowledgement
    ) throws {
        var rows = file.load()
        guard let index = rows.firstIndex(where: { $0.idempotencyKey == idempotencyKey }) else {
            throw OutboxError.batchMissing
        }
        rows[index].acknowledgement = acknowledgement
        rows[index].lastError = nil
        rows[index].terminalFailure = false
        rows[index].terminalReason = nil
        try file.save(rows)
    }

    func finalizeAcknowledgement(_ idempotencyKey: String) throws {
        var rows = file.load()
        guard let batch = rows.first(where: { $0.idempotencyKey == idempotencyKey }) else { return }
        guard batch.acknowledgement != nil else {
            throw OutboxError.acknowledgementMissing
        }
        rows.removeAll { $0.idempotencyKey == idempotencyKey }
        try file.save(rows)
    }

    func remove(_ idempotencyKey: String) throws {
        var rows = file.load()
        rows.removeAll { $0.idempotencyKey == idempotencyKey }
        try file.save(rows)
    }

    func markTransientFailure(_ idempotencyKey: String, error: String, now: Date = Date()) {
        var rows = file.load()
        guard let index = rows.firstIndex(where: { $0.idempotencyKey == idempotencyKey }) else { return }
        rows[index].attemptCount += 1
        rows[index].lastError = String(error.prefix(160))
        rows[index].terminalFailure = false
        rows[index].terminalReason = nil
        let delay = min(pow(2, Double(rows[index].attemptCount)) * 5, 300)
        rows[index].nextAttemptAt = now.addingTimeInterval(delay)
        try? file.save(rows)
    }

    func markTerminalFailure(
        _ idempotencyKey: String,
        error: String,
        reason: UploadTerminalReason
    ) {
        var rows = file.load()
        guard let index = rows.firstIndex(where: { $0.idempotencyKey == idempotencyKey }) else { return }
        rows[index].attemptCount += 1
        rows[index].lastError = String(error.prefix(160))
        rows[index].terminalFailure = true
        rows[index].terminalReason = reason
        rows[index].nextAttemptAt = .distantFuture
        try? file.save(rows)
    }

    func makeAllReady(now: Date = Date()) {
        var rows = file.load()
        for index in rows.indices where rows[index].terminalFailure != true
            && rows[index].terminalReason == nil
            && rows[index].acknowledgement == nil {
            rows[index].nextAttemptAt = now
        }
        try? file.save(rows)
    }

    func reactivateCredentialFailures(
        currentFingerprint: String,
        now: Date = Date()
    ) {
        var rows = file.load()
        var changed = false
        for index in rows.indices {
            guard rows[index].terminalReason?.kind == .repairable,
                  rows[index].terminalReason?.code == .credentialRejected,
                  !currentFingerprint.isEmpty else {
                continue
            }
            rows[index].terminalFailure = false
            rows[index].terminalReason = nil
            rows[index].lastError = nil
            rows[index].nextAttemptAt = now
            changed = true
        }
        if changed { try? file.save(rows) }
    }

    func repairableFeatureBatches() -> [OutboxBatch] {
        file.load().filter {
            $0.terminalReason?.kind == .repairable
                && $0.terminalReason?.code == .featureCapabilityConflict
        }
    }

    func count() -> Int {
        file.load().count
    }

    func retryableCount() -> Int {
        file.load().filter {
            $0.terminalFailure != true
                && $0.terminalReason == nil
                && $0.acknowledgement == nil
        }.count
    }

    func terminalCount() -> Int {
        file.load().filter {
            $0.terminalFailure == true || $0.terminalReason != nil
        }.count
    }

    func quarantinedCount() -> Int {
        file.load().filter {
            if let reason = $0.terminalReason {
                return reason.kind == .quarantined
            }
            return $0.terminalFailure == true
        }.count
    }

    func clear() {
        file.remove()
    }

    enum OutboxError: LocalizedError {
        case capacityExceeded
        case batchMissing
        case acknowledgementMissing

        var errorDescription: String? {
            switch self {
            case .capacityExceeded: "待回传数据已达上限，请联网完成同步"
            case .batchMissing: "待回传批次不存在"
            case .acknowledgementMissing: "待回传批次尚未获得47确认"
            }
        }
    }
}

@MainActor
final class DeferredFeatureRepository {
    static let maximumBatchCount = 500
    private let file: AtomicJSONFile<[OutboxBatch]>
    private let capacity: Int

    init(
        baseDirectory: URL? = nil,
        fileManager: FileManager = .default,
        maximumBatchCount: Int = 500
    ) {
        let base = baseDirectory
            ?? fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? fileManager.temporaryDirectory
        file = AtomicJSONFile(
            url: base.appendingPathComponent("InformationAutoRecognition/deferred-feature-v1.json"),
            emptyValue: []
        )
        capacity = max(1, maximumBatchCount)
    }

    func enqueue(_ batch: OutboxBatch) throws {
        var rows = file.load()
        rows.removeAll { $0.idempotencyKey == batch.idempotencyKey }
        rows.insert(batch, at: 0)
        guard rows.count <= capacity else {
            throw OutboxRepository.OutboxError.capacityExceeded
        }
        try file.save(rows)
    }

    func ensureCapacity(for batches: [OutboxBatch]) throws {
        let rows = file.load()
        let existing = Set(rows.map(\.idempotencyKey))
        let requested = Set(batches.map(\.idempotencyKey))
        let newCount = requested.subtracting(existing).count
        guard rows.count + newCount <= capacity else {
            throw OutboxRepository.OutboxError.capacityExceeded
        }
    }

    func all() -> [OutboxBatch] {
        file.load().sorted { $0.capturedAt < $1.capturedAt }
    }

    func remove(_ idempotencyKey: String) throws {
        var rows = file.load()
        rows.removeAll { $0.idempotencyKey == idempotencyKey }
        try file.save(rows)
    }

    func count() -> Int {
        file.load().count
    }
}

@MainActor
final class CollectionJournalRepository {
    private let file: AtomicJSONFile<CollectionTransaction?>

    init(baseDirectory: URL? = nil, fileManager: FileManager = .default) {
        let base = baseDirectory
            ?? fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? fileManager.temporaryDirectory
        file = AtomicJSONFile(
            url: base.appendingPathComponent("InformationAutoRecognition/collection-journal-v1.json"),
            emptyValue: nil
        )
    }

    func pending() -> CollectionTransaction? {
        file.load()
    }

    func prepare(_ transaction: CollectionTransaction) throws {
        if let existing = file.load(), existing.id != transaction.id {
            throw JournalError.pendingTransactionExists
        }
        try file.save(transaction)
    }

    func clear(transactionID: String) throws {
        if let existing = file.load(), existing.id != transactionID {
            throw JournalError.transactionMismatch
        }
        try file.removeOrThrow()
    }

    enum JournalError: LocalizedError {
        case pendingTransactionExists
        case transactionMismatch

        var errorDescription: String? {
            switch self {
            case .pendingTransactionExists: "存在尚未恢复的采集事务"
            case .transactionMismatch: "采集事务标识不一致"
            }
        }
    }
}

@MainActor
final class CollectionTransactionCoordinator {
    private let stationRepository: StationRepository
    private let outboxRepository: OutboxRepository
    private let deferredRepository: DeferredFeatureRepository
    private let journalRepository: CollectionJournalRepository

    init(
        stationRepository: StationRepository,
        outboxRepository: OutboxRepository,
        deferredRepository: DeferredFeatureRepository
    ) {
        self.stationRepository = stationRepository
        self.outboxRepository = outboxRepository
        self.deferredRepository = deferredRepository
        self.journalRepository = CollectionJournalRepository()
    }

    init(
        stationRepository: StationRepository,
        outboxRepository: OutboxRepository,
        deferredRepository: DeferredFeatureRepository,
        journalRepository: CollectionJournalRepository
    ) {
        self.stationRepository = stationRepository
        self.outboxRepository = outboxRepository
        self.deferredRepository = deferredRepository
        self.journalRepository = journalRepository
    }

    func commit(_ transaction: CollectionTransaction) throws -> [CollectedStation] {
        guard journalRepository.pending() == nil else {
            throw CollectionJournalRepository.JournalError.pendingTransactionExists
        }
        try ensureCapacity(for: transaction)
        try journalRepository.prepare(transaction)
        return try replay(transaction)
    }

    func recover() throws -> [CollectedStation]? {
        guard let transaction = journalRepository.pending() else { return nil }
        try ensureCapacity(for: transaction)
        return try replay(transaction)
    }

    func hasPendingTransaction() -> Bool {
        journalRepository.pending() != nil
    }

    func pendingTransaction() -> CollectionTransaction? {
        journalRepository.pending()
    }

    private func ensureCapacity(for transaction: CollectionTransaction) throws {
        try outboxRepository.ensureCapacity(
            for: transaction.queueEntries
                .filter { $0.target == .outbox }
                .map(\.batch)
        )
        try deferredRepository.ensureCapacity(
            for: transaction.queueEntries
                .filter { $0.target == .deferredFeature }
                .map(\.batch)
        )
    }

    private func replay(
        _ transaction: CollectionTransaction
    ) throws -> [CollectedStation] {
        for entry in transaction.queueEntries {
            switch entry.target {
            case .outbox:
                try outboxRepository.enqueue(entry.batch)
            case .deferredFeature:
                try deferredRepository.enqueue(entry.batch)
            }
        }
        let rows = try stationRepository.apply(transaction.localObservations)
        try journalRepository.clear(transactionID: transaction.id)
        return rows
    }
}

@MainActor
final class FeatureCapabilityRepository {
    private let file: AtomicJSONFile<FuelQuoteCapabilitySnapshot?>

    init(baseDirectory: URL? = nil, fileManager: FileManager = .default) {
        let base = baseDirectory
            ?? fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? fileManager.temporaryDirectory
        file = AtomicJSONFile(
            url: base.appendingPathComponent("InformationAutoRecognition/feature-capability-v1.json"),
            emptyValue: nil
        )
    }

    func fresh(at date: Date = Date()) -> FuelQuoteCapabilitySnapshot? {
        guard let snapshot = file.load(), snapshot.isFresh(at: date) else { return nil }
        return snapshot
    }

    func save(_ snapshot: FuelQuoteCapabilitySnapshot) {
        try? file.save(snapshot)
    }

    func invalidate() {
        file.remove()
    }
}
