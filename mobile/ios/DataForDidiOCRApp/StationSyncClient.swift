import CryptoKit
import Foundation
import StationOCRCore

struct StationUploadAcknowledgement: Codable, Equatable {
    let ingestId: String
    let firstSourceRecordId: Int
    let lastSourceRecordId: Int
    let acceptedCount: Int
    let duplicate: Bool
}

struct StationSyncClient {
    static let sourceAgent = AppConfiguration.sourceAgent
    static let fuelQuoteFeature = "fuel-quote-v1"

    enum FailureDisposition: Equatable {
        case transient
        case permanent
    }

    private struct Payload: Encodable {
        let schemaVersion = 3
        let feature: String?
        let stationType: String
        let clientVersion: String
        let sourceAgent: String
        let platform: String
        let city: String
        let deviceId: String
        let deviceSessionId: String
        let sessionId: String
        let pageIndex: Int
        let sourceStage: String
        let capturedAt: Date
        let observations: [Observation]
    }

    private struct Observation: Encodable {
        let schemaVersion = 3
        let stationType: String
        let stationObservation: CommonObservation
        let chargingObservation: ChargingObservation?
        let fuelObservation: FuelObservation?
    }

    private struct CommonObservation: Encodable {
        let sourceStationKey: String
        let stationName: String
        let address: String?
        let availablePorts: Int?
        let busyPorts: Int?
        let totalPorts: Int?
        let portSemantics: String?
        let capturedAt: Date
        let quality: Quality
    }

    private struct Quality: Encodable {
        let needsReview: Bool
        let missingFields: [String]
        let status: String
    }

    private struct ChargingObservation: Encodable {
        let priceFast: String?
        let priceSlow: String?
        let priceSuper: String?
        let priceService: String?
        let fastIdlePorts: Int?
        let fastTotalPorts: Int?
        let slowIdlePorts: Int?
        let slowTotalPorts: Int?
        let superIdlePorts: Int?
        let superTotalPorts: Int?
    }

    private struct FuelObservation: Encodable {
        let fuelOffers: [FuelOfferPayload]
        let fuelQuotes: [FuelQuotePayload]
    }

    private struct FuelOfferPayload: Encodable {
        let fuelType: String
        let gradeCode: String?
        let gradeLabel: String?
        let displayPrice: String?
        let stationPrice: String?
        let nationalPrice: String?
        let listPrice: String?
        let discountPrice: String?
        let unclassifiedPrice: String?
        let discountKind: String?
        let currency: String
        let unit: String
        let fieldSource: [String: String]
        let evidence: [FuelEvidence]
        let capturedAt: Date
    }

    private struct FuelEvidence: Encodable {
        let kind: String
        let type: String
    }

    private struct FuelQuotePayload: Encodable {
        let quoteObservationId: String
        let quoteDedupKey: String
        let gradeCode: String
        let gradeLabel: String
        let gunCode: String?
        let gunLabel: String?
        let selectedAmount: String
        let grossDiscount: String?
        let serviceFee: String?
        let netDiscount: String?
        let payableAmount: String?
        let quoteEntry: String
        let needsReview: Bool
        let capturedAt: Date
        let raw: [String: String]
    }

    private struct ResponseEnvelope: Decodable {
        struct DataValue: Decodable {
            let persisted: Bool
            let sourceNode: String
            let sourceAgent: String
            let ingestId: String
            let acceptedCount: Int
            let firstSourceRecordId: Int?
            let lastSourceRecordId: Int?
            let duplicate: Bool?
        }
        let success: Bool
        let data: DataValue?
    }

    private struct HealthEnvelope: Decodable {
        struct DataValue: Decodable {
            struct Capabilities: Decodable {
                struct Feature: Decodable {
                    let enabled: Bool
                    let platforms: [String]
                    let captureMode: String
                }

                let latestSchemaVersion: Int
                let supportedSchemaVersions: [Int]
                let stationObservation: Bool
                let features: [String: Feature]
            }

            let ok: Bool
            let sourceNode: String
            let capabilities: Capabilities
        }

        let success: Bool
        let data: DataValue?
    }

    private struct ErrorEnvelope: Decodable {
        let code: String?
    }

    func fetchFuelQuoteCapability() async throws -> FuelQuoteCapabilitySnapshot {
        let target = try Self.baseEndpoint().appendingPathComponent("health")
        try Self.validate(target: target)
        var request = URLRequest(url: target)
        request.httpMethod = "GET"
        request.timeoutInterval = 10
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("InformationAutoRecognition/\(AppConfiguration.clientVersion)", forHTTPHeaderField: "User-Agent")

        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 10
        configuration.timeoutIntervalForResource = 15
        configuration.waitsForConnectivity = false
        let (data, response) = try await URLSession(configuration: configuration).data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw Self.rejection(response: response, data: data)
        }
        return try Self.parseFuelQuoteCapability(data: data)
    }

    func upload(
        batch: OutboxBatch,
        token: String,
        capability: FuelQuoteCapabilitySnapshot? = nil
    ) async throws -> StationUploadAcknowledgement {
        guard !token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw SyncError.tokenMissing
        }
        if batch.feature == Self.fuelQuoteFeature {
            guard let capability, capability.isFresh(),
                  capability.allows(platform: batch.platform) else {
                throw SyncError.featureAuthorizationMissing
            }
        }
        let body = try Self.encodedPayload(batch: batch)
        let target = try Self.baseEndpoint().appendingPathComponent("api/mobile-sync/stations")
        try Self.validate(target: target)
        var request = URLRequest(url: target)
        request.httpMethod = "POST"
        request.timeoutInterval = 30
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue(Self.sourceAgent, forHTTPHeaderField: "X-Mobile-Agent")
        request.setValue(batch.idempotencyKey, forHTTPHeaderField: "Idempotency-Key")
        request.setValue("InformationAutoRecognition/\(AppConfiguration.clientVersion)", forHTTPHeaderField: "User-Agent")
        request.httpBody = body

        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 30
        configuration.timeoutIntervalForResource = 35
        configuration.waitsForConnectivity = false
        let (data, response) = try await URLSession(configuration: configuration).data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw Self.rejection(response: response, data: data)
        }
        return try Self.parseAcknowledgement(data: data, expectedCount: batch.stations.count)
    }

    static func encodedPayload(batch: OutboxBatch) throws -> Data {
        guard let first = batch.stations.first,
              batch.stations.allSatisfy({
                  $0.stationType == first.stationType && $0.platform == first.platform
              }) else {
            throw SyncError.mixedBatch
        }
        guard batch.stations.allSatisfy(StationContentPolicy.isSafe) else {
            throw SyncError.sensitiveStationContent
        }
        let requiresFeature = requiresFuelQuoteFeature(stations: batch.stations)
        if requiresFeature && batch.feature != Self.fuelQuoteFeature {
            throw SyncError.featureAuthorizationMissing
        }
        if !requiresFeature && batch.feature != nil {
            throw SyncError.featureNotRequired
        }
        if first.stationType == .fuel {
            guard batch.stations.allSatisfy({ station in
                !station.fuelOffers.isEmpty && station.fuelOffers.allSatisfy { offer in
                    !(offer.gradeCode?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true)
                        && !(offer.gradeLabel?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true)
                        && Self.priceCount(offer) > 0
                }
            }) else {
                throw SyncError.invalidFuelOffer
            }
        }

        let payload = Payload(
            feature: batch.feature,
            stationType: first.stationType.rawValue,
            clientVersion: AppConfiguration.clientVersion,
            sourceAgent: Self.sourceAgent,
            platform: first.platform,
            city: batch.city,
            deviceId: batch.deviceId,
            deviceSessionId: batch.deviceSessionId,
            sessionId: batch.sessionId,
            pageIndex: batch.pageIndex,
            sourceStage: "screen-ocr-user-driven",
            capturedAt: batch.capturedAt,
            observations: batch.stations.map {
                Self.observation($0, usesFuelQuoteFeature: requiresFeature)
            }
        )
        return try Self.encoder.encode(payload)
    }

    static func parseFuelQuoteCapability(
        data: Data,
        checkedAt: Date = Date()
    ) throws -> FuelQuoteCapabilitySnapshot {
        let envelope = try Self.decoder.decode(HealthEnvelope.self, from: data)
        guard envelope.success, let health = envelope.data,
              health.ok,
              health.sourceNode == "47-mysql",
              health.capabilities.latestSchemaVersion >= 3,
              health.capabilities.supportedSchemaVersions.contains(3),
              health.capabilities.stationObservation,
              let feature = health.capabilities.features[Self.fuelQuoteFeature],
              feature.captureMode == "user-driven-ocr",
              feature.platforms.allSatisfy({
                  $0 == $0.lowercased()
                      && $0.range(
                          of: #"^[a-z0-9][a-z0-9._-]{0,63}$"#,
                          options: .regularExpression
                      ) != nil
              }) else {
            throw SyncError.capabilityInvalid
        }
        return FuelQuoteCapabilitySnapshot(
            status: feature.enabled ? .enabled : .disabled,
            platforms: Array(Set(feature.platforms)).sorted(),
            checkedAt: checkedAt
        )
    }

    static func failureDisposition(for error: Error) -> FailureDisposition {
        if let syncError = error as? SyncError {
            switch syncError {
            case .serverRejected(let status, _)
            where status == 408 || status == 429 || (500...599).contains(status):
                return .transient
            case .serverRejected:
                return .permanent
            case .endpointUnavailable:
                return .transient
            case .tokenMissing, .endpointInvalid, .mixedBatch,
                    .persistenceNotConfirmed, .featureAuthorizationMissing,
                    .featureNotRequired, .invalidFuelOffer,
                    .sensitiveStationContent, .capabilityInvalid:
                return .permanent
            }
        }
        if let urlError = error as? URLError {
            switch urlError.code {
            case .timedOut, .cannotFindHost, .cannotConnectToHost,
                    .dnsLookupFailed, .networkConnectionLost,
                    .notConnectedToInternet, .internationalRoamingOff,
                    .callIsActive, .dataNotAllowed, .resourceUnavailable,
                    .cannotLoadFromNetwork, .backgroundSessionWasDisconnected:
                return .transient
            default:
                return .permanent
            }
        }
        return .permanent
    }

    static func terminalReason(
        for error: Error,
        credentialFingerprint: String? = nil
    ) -> UploadTerminalReason {
        if let syncError = error as? SyncError {
            switch syncError {
            case .serverRejected(let status, _)
            where status == 401 || status == 403:
                return UploadTerminalReason(
                    kind: .repairable,
                    code: .credentialRejected,
                    httpStatus: status,
                    serverCode: syncError.serverCode,
                    credentialFingerprint: credentialFingerprint
                )
            case .serverRejected(let status, let code)
            where code == "mobile_source_feature_disabled":
                return UploadTerminalReason(
                    kind: .repairable,
                    code: .featureCapabilityConflict,
                    httpStatus: status,
                    serverCode: code,
                    credentialFingerprint: nil
                )
            case .mixedBatch:
                return quarantined(.mixedBatch)
            case .sensitiveStationContent:
                return quarantined(.sensitiveContent)
            case .invalidFuelOffer:
                return quarantined(.invalidFuelOffer)
            case .endpointInvalid:
                return quarantined(.endpointInvalid)
            case .endpointUnavailable:
                return UploadTerminalReason(
                    kind: .repairable,
                    code: .endpointInvalid,
                    httpStatus: nil,
                    serverCode: nil,
                    credentialFingerprint: nil
                )
            case .persistenceNotConfirmed:
                return quarantined(.acknowledgementInvalid)
            case .serverRejected(let status, let code):
                let reasonCode: UploadTerminalReason.Code = status == 409
                    || code?.localizedCaseInsensitiveContains("idempot") == true
                    ? .idempotencyConflict
                    : .serverContractRejected
                return UploadTerminalReason(
                    kind: .quarantined,
                    code: reasonCode,
                    httpStatus: status,
                    serverCode: code,
                    credentialFingerprint: nil
                )
            case .tokenMissing:
                return UploadTerminalReason(
                    kind: .repairable,
                    code: .credentialRejected,
                    httpStatus: nil,
                    serverCode: nil,
                    credentialFingerprint: credentialFingerprint
                )
            case .featureAuthorizationMissing:
                return UploadTerminalReason(
                    kind: .repairable,
                    code: .featureCapabilityConflict,
                    httpStatus: nil,
                    serverCode: nil,
                    credentialFingerprint: nil
                )
            case .featureNotRequired, .capabilityInvalid:
                return quarantined(.clientContractInvalid)
            }
        }
        if error is DecodingError {
            return quarantined(.acknowledgementInvalid)
        }
        return quarantined(.clientContractInvalid)
    }

    static func credentialFingerprint(token: String) -> String {
        SHA256.hash(data: Data(token.utf8))
            .map { String(format: "%02x", $0) }
            .joined()
    }

    static func requiresFuelQuoteFeature(stations: [StationRecord]) -> Bool {
        stations.contains { station in
            station.stationType == .fuel
                && station.fuelOffers.contains { priceCount($0) >= 2 }
        }
    }

    static func parseAcknowledgement(
        data: Data,
        expectedCount: Int
    ) throws -> StationUploadAcknowledgement {
        let envelope = try Self.decoder.decode(ResponseEnvelope.self, from: data)
        guard envelope.success, let acknowledgement = envelope.data,
              acknowledgement.persisted,
              acknowledgement.sourceNode == "47-mysql",
              acknowledgement.sourceAgent == Self.sourceAgent,
              acknowledgement.acceptedCount == expectedCount,
              let firstId = acknowledgement.firstSourceRecordId,
              let lastId = acknowledgement.lastSourceRecordId,
              firstId > 0, lastId >= firstId,
              acknowledgement.acceptedCount > 0 else {
            throw SyncError.persistenceNotConfirmed
        }
        return StationUploadAcknowledgement(
            ingestId: acknowledgement.ingestId,
            firstSourceRecordId: firstId,
            lastSourceRecordId: lastId,
            acceptedCount: acknowledgement.acceptedCount,
            duplicate: acknowledgement.duplicate ?? false
        )
    }

    static func idempotencyKey(
        deviceId: String,
        deviceSessionId: String,
        sessionId: String,
        pageIndex: Int,
        platform: String,
        stationType: StationType,
        stations: [StationRecord]
    ) -> String {
        let fingerprint = stations
            .map { "\($0.id)|\($0.capturedAt.timeIntervalSince1970)" }
            .sorted()
            .joined(separator: ";")
        let seed = [
            Self.sourceAgent, deviceId, deviceSessionId, sessionId,
            String(pageIndex), platform, stationType.rawValue, fingerprint
        ].joined(separator: "|")
        return SHA256.hash(data: Data(seed.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    private static func observation(
        _ station: StationRecord,
        usesFuelQuoteFeature: Bool
    ) -> Observation {
        // 燃油侧无枪数据：common 信封不携带 ports/portSemantics（与 Android
        // StationObservationV3.common() 燃油分支一致），避免 fuel-payload-policy
        // 的 findForbiddenFuelField 判 fuel_charging_field_forbidden。
        let isFuel = station.stationType == .fuel
        let common = CommonObservation(
            sourceStationKey: station.id,
            stationName: station.stationName,
            address: station.address,
            availablePorts: isFuel ? nil : station.availablePorts,
            busyPorts: isFuel ? nil : station.busyPorts,
            totalPorts: isFuel ? nil : station.totalPorts,
            portSemantics: isFuel ? nil : "charging-gun",
            capturedAt: station.capturedAt,
            quality: Quality(
                needsReview: station.needsReview,
                missingFields: station.missingFields,
                status: station.needsReview
                    ? "needs-review"
                    : (station.missingFields.isEmpty ? "valid" : "incomplete")
            )
        )
        if station.stationType == .charging {
            return Observation(
                stationType: station.stationType.rawValue,
                stationObservation: common,
                chargingObservation: ChargingObservation(
                    priceFast: decimalString(station.priceFast),
                    priceSlow: decimalString(station.priceSlow),
                    priceSuper: decimalString(station.priceSuper),
                    priceService: decimalString(station.priceService),
                    fastIdlePorts: station.fastIdlePorts,
                    fastTotalPorts: station.fastTotalPorts,
                    slowIdlePorts: station.slowIdlePorts,
                    slowTotalPorts: station.slowTotalPorts,
                    superIdlePorts: station.superIdlePorts,
                    superTotalPorts: station.superTotalPorts
                ),
                fuelObservation: nil
            )
        }
        return Observation(
            stationType: station.stationType.rawValue,
            stationObservation: common,
            chargingObservation: nil,
            fuelObservation: FuelObservation(
                fuelOffers: station.fuelOffers.map {
                    let ordinary = ordinaryFuelPrices($0)
                    let source = [
                        !usesFuelQuoteFeature || $0.displayPrice == nil ? nil : ("displayPrice", "ocr"),
                        !usesFuelQuoteFeature || $0.stationPrice == nil ? nil : ("stationPrice", "ocr"),
                        !usesFuelQuoteFeature || $0.nationalPrice == nil ? nil : ("nationalPrice", "ocr"),
                    ].compactMap { $0 }
                    return FuelOfferPayload(
                        fuelType: $0.gradeCode == "0" ? "diesel" : "gasoline",
                        gradeCode: $0.gradeCode,
                        gradeLabel: $0.gradeLabel,
                        displayPrice: usesFuelQuoteFeature ? decimalString($0.displayPrice) : nil,
                        stationPrice: usesFuelQuoteFeature ? decimalString($0.stationPrice) : nil,
                        nationalPrice: usesFuelQuoteFeature ? decimalString($0.nationalPrice) : nil,
                        listPrice: usesFuelQuoteFeature ? nil : decimalString(ordinary.list),
                        discountPrice: usesFuelQuoteFeature ? nil : decimalString(ordinary.discount),
                        unclassifiedPrice: usesFuelQuoteFeature ? nil : decimalString(ordinary.unclassified),
                        discountKind: usesFuelQuoteFeature || ordinary.discount == nil
                            ? nil
                            : "platform-discount",
                        currency: "CNY",
                        unit: "CNY_PER_LITER",
                        fieldSource: Dictionary(uniqueKeysWithValues: source),
                        evidence: [FuelEvidence(kind: "ocr-price", type: "fuel-offer")],
                        capturedAt: station.capturedAt
                    )
                },
                fuelQuotes: []
            )
        )
    }

    private static func priceCount(_ offer: FuelOffer) -> Int {
        [offer.displayPrice, offer.stationPrice, offer.nationalPrice]
            .compactMap { $0 }
            .filter(\.isFinite)
            .count
    }

    private static func ordinaryFuelPrices(
        _ offer: FuelOffer
    ) -> (list: Double?, discount: Double?, unclassified: Double?) {
        if let value = offer.displayPrice {
            return (nil, value, nil)
        }
        if let value = offer.stationPrice {
            return (value, nil, nil)
        }
        if let value = offer.nationalPrice {
            return (value, nil, nil)
        }
        return (nil, nil, nil)
    }

    private static func baseEndpoint() throws -> URL {
        guard let endpoint = AppConfiguration.endpoint() else {
            throw SyncError.endpointUnavailable
        }
        guard endpoint.scheme?.lowercased() == "https",
              endpoint.host?.isEmpty == false,
              endpoint.user == nil,
              endpoint.password == nil,
              endpoint.query == nil,
              endpoint.fragment == nil,
              endpoint.path.isEmpty || endpoint.path == "/" else {
            throw SyncError.endpointInvalid
        }
        return endpoint
    }

    private static func validate(target: URL) throws {
        guard target.scheme?.lowercased() == "https",
              target.host?.isEmpty == false,
              target.user == nil,
              target.password == nil,
              target.query == nil,
              target.fragment == nil else {
            throw SyncError.endpointInvalid
        }
    }

    private static func rejection(response: URLResponse, data: Data) -> SyncError {
        let status = (response as? HTTPURLResponse)?.statusCode ?? -1
        let code = (try? decoder.decode(ErrorEnvelope.self, from: data))?.code
        return .serverRejected(status: status, code: code)
    }

    private static func quarantined(
        _ code: UploadTerminalReason.Code
    ) -> UploadTerminalReason {
        UploadTerminalReason(
            kind: .quarantined,
            code: code,
            httpStatus: nil,
            serverCode: nil,
            credentialFingerprint: nil
        )
    }

    private static func decimalString(_ value: Double?) -> String? {
        guard let value, value.isFinite else { return nil }
        return String(format: "%.4f", value)
            .replacingOccurrences(of: #"0+$"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"\.$"#, with: "", options: .regularExpression)
    }

    private static var encoder: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }

    private static var decoder: JSONDecoder {
        JSONDecoder()
    }

    enum SyncError: LocalizedError {
        case tokenMissing
        case endpointUnavailable
        case endpointInvalid
        case mixedBatch
        case serverRejected(status: Int, code: String?)
        case persistenceNotConfirmed
        case featureAuthorizationMissing
        case featureNotRequired
        case invalidFuelOffer
        case sensitiveStationContent
        case capabilityInvalid

        var errorDescription: String? {
            switch self {
            case .tokenMissing: "设备尚未完成安全配置"
            case .endpointUnavailable: "设备尚未下发回传配置"
            case .endpointInvalid: "受控回传地址无效"
            case .mixedBatch: "单批次不能混合平台或场站类型"
            case .serverRejected(let status, _): "47 接入服务拒绝请求（HTTP \(status)）"
            case .persistenceNotConfirmed: "47 未返回严格持久化确认"
            case .featureAuthorizationMissing: "47 尚未明确开放当前平台的扩展油价能力"
            case .featureNotRequired: "普通场站批次不能携带扩展油价标识"
            case .invalidFuelOffer: "燃油价格缺少油号或有效价格"
            case .sensitiveStationContent: "场站名称或地址包含敏感内容"
            case .capabilityInvalid: "47 能力响应不符合受控契约"
            }
        }

        var serverCode: String? {
            if case .serverRejected(_, let code) = self { return code }
            return nil
        }
    }
}
