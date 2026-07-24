import Foundation
import SwiftUI
import StationOCRCore

@MainActor
final class CaptureViewModel: ObservableObject {
    static let cityOptions = ["自动识别", "西安", "武汉", "北京", "上海", "广州", "深圳", "杭州", "成都"]

    @Published var selectedCity = UserDefaults.standard.string(forKey: "collector.city") ?? "自动识别"
    @Published var results: [CollectedStation] = []
    @Published var status = "等待用户主动选择共享屏幕"
    @Published var isCapturing = false
    @Published var pendingCount = 0
    @Published var attentionCount = 0

    private let repository = StationRepository()
    private let outbox = OutboxRepository()
    private let deferred = DeferredFeatureRepository()
    private let capabilityRepository = FeatureCapabilityRepository()
    private lazy var transactionCoordinator = CollectionTransactionCoordinator(
        stationRepository: repository,
        outboxRepository: outbox,
        deferredRepository: deferred
    )
    private let syncClient = StationSyncClient()
    private let sessionId = "ios-capture-\(UUID().uuidString.lowercased())"
    private let deviceId = AppConfiguration.installId()
    private let deviceSessionId = AppConfiguration.deviceSessionId()
    private var pageIndex = 0
    private var lastPageSignature = ""
    private var frameSource: AnyObject?
    private var isFlushing = false

    init() {
        CredentialStore.provisionIfAvailable()
        results = repository.resetInterruptedUploads()
        recoverCollectionTransaction()
        recoverPersistedAcknowledgements()
        updateQueueCounts()
        Task { await flushOutbox() }
    }

    func selectCity(_ city: String) {
        selectedCity = city
        if city == "自动识别" {
            AppConfiguration.saveSelectedCity("")
        } else {
            AppConfiguration.saveSelectedCity(city)
        }
    }

    func start() {
        guard #available(iOS 27.0, *) else {
            status = "当前版本需要 iOS 27 或更高版本"
            return
        }
        let source = ScreenCaptureKitFrameSource(
            onRows: { [weak self] rows in
                Task { @MainActor in self?.consume(rows: rows) }
            },
            onError: { [weak self] message in
                Task { @MainActor in
                    self?.status = message
                    self?.isCapturing = false
                }
            }
        )
        frameSource = source
        isCapturing = true
        status = "请在系统选择器中选择整块屏幕，然后切换到目标应用并手动滚动"
        source.presentPicker()
    }

    func stop() {
        guard #available(iOS 27.0, *),
              let source = frameSource as? ScreenCaptureKitFrameSource else { return }
        Task { await source.stop() }
        frameSource = nil
        isCapturing = false
        status = "采集已停止"
    }

    func clearCompleted() {
        repository.clear()
        results = []
    }

    func retryPending() {
        let token = CredentialStore.readToken()
        if !token.isEmpty {
            outbox.reactivateCredentialFailures(
                currentFingerprint: StationSyncClient.credentialFingerprint(token: token)
            )
        }
        for batch in outbox.repairableFeatureBatches() {
            do {
                var deferredBatch = batch
                deferredBatch.feature = nil
                deferredBatch.terminalFailure = nil
                deferredBatch.terminalReason = nil
                deferredBatch.lastError = nil
                deferredBatch.nextAttemptAt = Date()
                try deferred.enqueue(deferredBatch)
                try outbox.remove(batch.idempotencyKey)
            } catch {
                status = "待修复批次保存失败"
            }
        }
        outbox.makeAllReady()
        capabilityRepository.invalidate()
        Task { await flushOutbox() }
    }

    private func consume(rows: [OCRRow]) {
        if transactionCoordinator.hasPendingTransaction() {
            recoverCollectionTransaction()
            guard !transactionCoordinator.hasPendingTransaction() else {
                status = "上次采集事务等待本地恢复"
                return
            }
        }
        let parsedStations = StationParser.extract(rows: rows, platform: "auto")
        let stations = parsedStations.filter(StationContentPolicy.isSafe)
        let rejectedCount = parsedStations.count - stations.count
        guard !stations.isEmpty else {
            if rejectedCount > 0 {
                status = "已拒绝包含敏感内容的识别结果"
                return
            }
            status = "当前屏幕未解析出可信场站卡片"
            return
        }
        let signature = stations.map {
            "\($0.id)|\($0.address ?? "")|\($0.availablePorts.map(String.init) ?? "")|\($0.totalPorts.map(String.init) ?? "")"
        }.sorted().joined(separator: "|")
        guard signature != lastPageSignature else { return }

        let city = resolvedCity(rows: rows)
        let grouped = Dictionary(grouping: stations) { "\($0.platform)|\($0.stationType.rawValue)" }
        var localObservations: [CollectionLocalObservation] = []
        var queueEntries: [CollectionQueueEntry] = []
        var committedPageIndex = pageIndex
        for group in grouped.values {
            committedPageIndex += 1
            guard let first = group.first else { continue }
            let uploadable = group.filter { $0.stationType == .charging || !$0.fuelOffers.isEmpty }
            let uploadableIDs = Set(uploadable.map(\.id))
            localObservations.append(contentsOf: group.map { station in
                let hasTask = uploadableIDs.contains(station.id)
                return CollectionLocalObservation(
                    station: station,
                    city: city,
                    syncState: hasTask ? .pending : .needsAttention,
                    syncMessage: hasTask ? "等待回传" : "燃油价格待补全，暂未回传"
                )
            })
            if uploadable.isEmpty {
                continue
            }
            let key = StationSyncClient.idempotencyKey(
                deviceId: deviceId,
                deviceSessionId: deviceSessionId,
                sessionId: sessionId,
                pageIndex: committedPageIndex,
                platform: first.platform,
                stationType: first.stationType,
                stations: uploadable
            )
            let batch = OutboxBatch(
                idempotencyKey: key,
                deviceId: deviceId,
                deviceSessionId: deviceSessionId,
                sessionId: sessionId,
                pageIndex: committedPageIndex,
                city: city,
                platform: first.platform,
                capturedAt: uploadable.map(\.capturedAt).min() ?? Date(),
                stations: uploadable,
                attemptCount: 0,
                nextAttemptAt: Date(),
                lastError: nil
            )
            let target: CollectionQueueTarget = StationSyncClient
                .requiresFuelQuoteFeature(stations: uploadable)
                ? .deferredFeature
                : .outbox
            queueEntries.append(CollectionQueueEntry(target: target, batch: batch))
        }
        let transaction = CollectionTransaction(
            id: "ios-collection-\(UUID().uuidString.lowercased())",
            createdAt: Date(),
            localObservations: localObservations,
            queueEntries: queueEntries,
            screenSignature: signature,
            pageIndexAfterCommit: committedPageIndex
        )
        do {
            results = try transactionCoordinator.commit(transaction)
            pageIndex = committedPageIndex
            lastPageSignature = signature
        } catch {
            results = repository.load()
            updateQueueCounts()
            status = error.localizedDescription
            return
        }
        updateQueueCounts()
        status = rejectedCount == 0
            ? "本屏识别 \(stations.count) 条，已安全保存，正在回传"
            : "本屏识别 \(stations.count) 条，另拒绝 \(rejectedCount) 条敏感结果"
        Task { await flushOutbox() }
    }

    private func flushOutbox() async {
        guard !isFlushing else { return }
        recoverPersistedAcknowledgements()
        let token = CredentialStore.readToken()
        guard !token.isEmpty else {
            updateQueueCounts()
            if pendingCount > 0 { status = "数据已本地保存，设备尚未完成安全配置" }
            return
        }
        isFlushing = true
        defer {
            isFlushing = false
            updateQueueCounts()
        }

        await promoteDeferredBatches()
        for batch in outbox.ready() {
            var capability: FuelQuoteCapabilitySnapshot?
            if batch.feature == StationSyncClient.fuelQuoteFeature {
                capability = await resolveCapability()
                guard capability?.allows(platform: batch.platform) == true else {
                    do {
                        var deferredBatch = batch
                        deferredBatch.feature = nil
                        deferredBatch.acknowledgement = nil
                        deferredBatch.terminalFailure = nil
                        deferredBatch.terminalReason = nil
                        try deferred.enqueue(deferredBatch)
                        try outbox.remove(batch.idempotencyKey)
                    } catch {
                        outbox.markTransientFailure(
                            batch.idempotencyKey,
                            error: "扩展油价队列保存失败"
                        )
                    }
                    results = repository.mark(
                        stationIDs: Set(batch.stations.map(\.id)),
                        city: batch.city,
                        state: .needsAttention,
                        message: "等待47扩展油价能力开放"
                    )
                    continue
                }
            }
            let ids = Set(batch.stations.map(\.id))
            results = repository.mark(
                stationIDs: ids,
                city: batch.city,
                state: .uploading,
                message: "正在写入47"
            )
            do {
                let acknowledgement = try await syncClient.upload(
                    batch: batch,
                    token: token,
                    capability: capability
                )
                do {
                    try outbox.recordAcknowledgement(
                        batch.idempotencyKey,
                        acknowledgement: acknowledgement
                    )
                    results = try repository.commitAcknowledgement(
                        batch: batch,
                        acknowledgement: acknowledgement
                    )
                    status = "已写入47，等待主产品增量合并"
                } catch {
                    outbox.markTransientFailure(
                        batch.idempotencyKey,
                        error: "本地确认保存失败"
                    )
                    results = repository.mark(
                        stationIDs: ids,
                        city: batch.city,
                        state: .failed,
                        message: "47已确认，本地状态将在重启后恢复"
                    )
                    status = "47已确认，本地状态等待恢复"
                    continue
                }
                do {
                    try outbox.finalizeAcknowledgement(batch.idempotencyKey)
                } catch {
                    status = "47已落库，本地确认将在下次启动时自动清理"
                }
            } catch {
                switch StationSyncClient.failureDisposition(for: error) {
                case .transient:
                    outbox.markTransientFailure(
                        batch.idempotencyKey,
                        error: error.localizedDescription
                    )
                    results = repository.mark(
                        stationIDs: ids,
                        city: batch.city,
                        state: .failed,
                        message: error.localizedDescription
                    )
                    status = "回传暂时失败，已保留并等待重试"
                case .permanent:
                    let reason = StationSyncClient.terminalReason(
                        for: error,
                        credentialFingerprint: StationSyncClient.credentialFingerprint(
                            token: token
                        )
                    )
                    outbox.markTerminalFailure(
                        batch.idempotencyKey,
                        error: error.localizedDescription,
                        reason: reason
                    )
                    results = repository.mark(
                        stationIDs: ids,
                        city: batch.city,
                        state: .needsAttention,
                        message: error.localizedDescription
                    )
                    status = "回传被拒绝，数据已保留并停止自动重试"
                }
            }
        }
    }

    private func promoteDeferredBatches() async {
        guard deferred.count() > 0 else { return }
        let capability = await resolveCapability()
        let batches = deferred.all()
        for batch in batches {
            let ids = Set(batch.stations.map(\.id))
            guard let capability else {
                results = repository.mark(
                    stationIDs: ids,
                    city: batch.city,
                    state: .pending,
                    message: "等待47扩展油价能力确认"
                )
                continue
            }
            guard capability.allows(platform: batch.platform) else {
                results = repository.mark(
                    stationIDs: ids,
                    city: batch.city,
                    state: .needsAttention,
                    message: "47尚未开放当前平台的扩展油价能力"
                )
                continue
            }
            do {
                var promoted = batch
                promoted.feature = StationSyncClient.fuelQuoteFeature
                promoted.nextAttemptAt = Date()
                promoted.lastError = nil
                promoted.terminalFailure = nil
                promoted.terminalReason = nil
                promoted.acknowledgement = nil
                try outbox.enqueue(promoted)
                try deferred.remove(batch.idempotencyKey)
                results = repository.mark(
                    stationIDs: ids,
                    city: batch.city,
                    state: .pending,
                    message: "等待回传"
                )
            } catch {
                results = repository.mark(
                    stationIDs: ids,
                    city: batch.city,
                    state: .failed,
                    message: "扩展油价队列保存失败"
                )
            }
        }
    }

    private func resolveCapability() async -> FuelQuoteCapabilitySnapshot? {
        if let cached = capabilityRepository.fresh() { return cached }
        do {
            let snapshot = try await syncClient.fetchFuelQuoteCapability()
            capabilityRepository.save(snapshot)
            return snapshot
        } catch {
            capabilityRepository.save(FuelQuoteCapabilitySnapshot(
                status: .unavailable,
                platforms: [],
                checkedAt: Date()
            ))
            return nil
        }
    }

    private func recoverPersistedAcknowledgements() {
        for batch in outbox.acknowledged() {
            guard let acknowledgement = batch.acknowledgement else { continue }
            do {
                results = try repository.commitAcknowledgement(
                    batch: batch,
                    acknowledgement: acknowledgement
                )
                try outbox.finalizeAcknowledgement(batch.idempotencyKey)
            } catch {
                status = "47确认状态等待本地恢复"
            }
        }
    }

    private func recoverCollectionTransaction() {
        let pending = transactionCoordinator.pendingTransaction()
        do {
            if let recovered = try transactionCoordinator.recover() {
                results = recovered
                if let screenSignature = pending?.screenSignature {
                    lastPageSignature = screenSignature
                }
                if let recoveredPageIndex = pending?.pageIndexAfterCommit {
                    pageIndex = max(pageIndex, recoveredPageIndex)
                }
                status = "已恢复上次未完成的本地采集"
            }
        } catch {
            results = repository.load()
            status = "上次采集事务等待本地恢复"
        }
    }

    private func updateQueueCounts() {
        pendingCount = outbox.retryableCount() + deferred.count()
        attentionCount = outbox.terminalCount()
    }

    private func resolvedCity(rows: [OCRRow]) -> String {
        if selectedCity != "自动识别" { return selectedCity }
        let joined = rows.map(\.text).joined(separator: "|")
        let candidates = Self.cityOptions.dropFirst()
        return candidates.first(where: joined.contains) ?? "未知城市"
    }
}
