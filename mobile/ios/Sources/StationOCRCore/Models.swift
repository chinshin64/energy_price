import Foundation

public enum StationType: String, Codable, Sendable {
    case charging
    case fuel
}

public struct OCRRow: Codable, Equatable, Sendable {
    public let text: String
    public let confidence: Double
    public let x: Double
    public let y: Double
    public let width: Double
    public let height: Double

    public init(text: String, confidence: Double = 1, x: Double, y: Double, width: Double, height: Double) {
        self.text = text
        self.confidence = confidence
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }
}

public struct PlatformDetection: Codable, Equatable, Sendable {
    public let platform: String
    public let confidence: Double
    public let evidence: [String]

    public init(platform: String, confidence: Double, evidence: [String]) {
        self.platform = platform
        self.confidence = confidence
        self.evidence = evidence
    }
}

public struct FuelOffer: Codable, Equatable, Sendable {
    public var gradeCode: String?
    public var gradeLabel: String?
    public var displayPrice: Double?
    public var stationPrice: Double?
    public var nationalPrice: Double?
    public var gunCode: String?
    public var gunLabel: String?

    public init(
        gradeCode: String? = nil,
        gradeLabel: String? = nil,
        displayPrice: Double? = nil,
        stationPrice: Double? = nil,
        nationalPrice: Double? = nil,
        gunCode: String? = nil,
        gunLabel: String? = nil
    ) {
        self.gradeCode = gradeCode
        self.gradeLabel = gradeLabel
        self.displayPrice = displayPrice
        self.stationPrice = stationPrice
        self.nationalPrice = nationalPrice
        self.gunCode = gunCode
        self.gunLabel = gunLabel
    }
}

public struct StationRecord: Codable, Equatable, Identifiable, Sendable {
    public static let sourceAgent = "ios-ocr-agent"

    public var id: String {
        "\(platform)|\(stationType.rawValue)|\(normalized(stationName))"
    }

    public var platform: String
    public var platformConfidence: Double
    public var stationType: StationType
    public var stationName: String
    public var address: String?
    public var priceFast: Double?
    public var priceSlow: Double?
    public var priceSuper: Double?
    public var priceService: Double?
    public var fuelOffers: [FuelOffer]
    public var availablePorts: Int?
    public var explicitBusyPorts: Int?
    public var totalPorts: Int?
    public var fastIdlePorts: Int?
    public var fastTotalPorts: Int?
    public var slowIdlePorts: Int?
    public var slowTotalPorts: Int?
    public var superIdlePorts: Int?
    public var superTotalPorts: Int?
    public var sourceType: String
    public var sourceStage: String
    public var sourceAgent: String
    public var capturedAt: Date
    public var needsReview: Bool
    public var missingFields: [String]

    public init(
        platform: String,
        platformConfidence: Double = 1,
        stationType: StationType = .charging,
        stationName: String,
        address: String? = nil,
        priceFast: Double? = nil,
        priceSlow: Double? = nil,
        priceSuper: Double? = nil,
        priceService: Double? = nil,
        fuelOffers: [FuelOffer] = [],
        availablePorts: Int? = nil,
        busyPorts: Int? = nil,
        totalPorts: Int? = nil,
        fastIdlePorts: Int? = nil,
        fastTotalPorts: Int? = nil,
        slowIdlePorts: Int? = nil,
        slowTotalPorts: Int? = nil,
        superIdlePorts: Int? = nil,
        superTotalPorts: Int? = nil,
        sourceStage: String = "screen-ocr-user-driven",
        capturedAt: Date = Date(),
        needsReview: Bool = false,
        missingFields: [String] = []
    ) {
        self.platform = platform
        self.platformConfidence = platformConfidence
        self.stationType = stationType
        self.stationName = stationName
        self.address = address
        self.priceFast = priceFast
        self.priceSlow = priceSlow
        self.priceSuper = priceSuper
        self.priceService = priceService
        self.fuelOffers = fuelOffers
        self.availablePorts = availablePorts
        self.explicitBusyPorts = busyPorts
        self.totalPorts = totalPorts
        self.fastIdlePorts = fastIdlePorts
        self.fastTotalPorts = fastTotalPorts
        self.slowIdlePorts = slowIdlePorts
        self.slowTotalPorts = slowTotalPorts
        self.superIdlePorts = superIdlePorts
        self.superTotalPorts = superTotalPorts
        self.sourceType = "mobile-ocr"
        self.sourceStage = sourceStage
        self.sourceAgent = Self.sourceAgent
        self.capturedAt = capturedAt
        self.needsReview = needsReview
        self.missingFields = missingFields
    }

    public var busyPorts: Int? {
        if let explicitBusyPorts { return explicitBusyPorts }
        guard let availablePorts, let totalPorts, availablePorts <= totalPorts else { return nil }
        return totalPorts - availablePorts
    }

    private func normalized(_ value: String) -> String {
        value.replacingOccurrences(of: #"\s+"#, with: "", options: .regularExpression).lowercased()
    }

    private enum CodingKeys: String, CodingKey {
        case platform, platformConfidence, stationType, stationName, address
        case priceFast, priceSlow, priceSuper, priceService, fuelOffers
        case availablePorts, explicitBusyPorts, totalPorts
        case fastIdlePorts, fastTotalPorts, slowIdlePorts, slowTotalPorts
        case superIdlePorts, superTotalPorts, sourceType, sourceStage, sourceAgent
        case capturedAt, needsReview, missingFields
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        platform = try values.decodeIfPresent(String.self, forKey: .platform) ?? "generic-station"
        platformConfidence = try values.decodeIfPresent(Double.self, forKey: .platformConfidence) ?? 0
        stationType = try values.decodeIfPresent(StationType.self, forKey: .stationType) ?? .charging
        stationName = try values.decode(String.self, forKey: .stationName)
        address = try values.decodeIfPresent(String.self, forKey: .address)
        priceFast = try values.decodeIfPresent(Double.self, forKey: .priceFast)
        priceSlow = try values.decodeIfPresent(Double.self, forKey: .priceSlow)
        priceSuper = try values.decodeIfPresent(Double.self, forKey: .priceSuper)
        priceService = try values.decodeIfPresent(Double.self, forKey: .priceService)
        fuelOffers = try values.decodeIfPresent([FuelOffer].self, forKey: .fuelOffers) ?? []
        availablePorts = try values.decodeIfPresent(Int.self, forKey: .availablePorts)
        explicitBusyPorts = try values.decodeIfPresent(Int.self, forKey: .explicitBusyPorts)
        totalPorts = try values.decodeIfPresent(Int.self, forKey: .totalPorts)
        fastIdlePorts = try values.decodeIfPresent(Int.self, forKey: .fastIdlePorts)
        fastTotalPorts = try values.decodeIfPresent(Int.self, forKey: .fastTotalPorts)
        slowIdlePorts = try values.decodeIfPresent(Int.self, forKey: .slowIdlePorts)
        slowTotalPorts = try values.decodeIfPresent(Int.self, forKey: .slowTotalPorts)
        superIdlePorts = try values.decodeIfPresent(Int.self, forKey: .superIdlePorts)
        superTotalPorts = try values.decodeIfPresent(Int.self, forKey: .superTotalPorts)
        sourceType = try values.decodeIfPresent(String.self, forKey: .sourceType) ?? "mobile-ocr"
        sourceStage = try values.decodeIfPresent(String.self, forKey: .sourceStage) ?? "screen-ocr-user-driven"
        sourceAgent = Self.sourceAgent
        capturedAt = try values.decodeIfPresent(Date.self, forKey: .capturedAt) ?? Date()
        needsReview = try values.decodeIfPresent(Bool.self, forKey: .needsReview) ?? false
        missingFields = try values.decodeIfPresent([String].self, forKey: .missingFields) ?? []
    }
}
