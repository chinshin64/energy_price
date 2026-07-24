import Foundation

public enum PlatformDetector {
    public static func detect(rows: [OCRRow]) -> PlatformDetection {
        let texts = rows.map { compact($0.text) }
        let joined = texts.joined(separator: "|")
        let fuel = containsAny(joined, ["加油", "汽油", "柴油", "国标价", "油站价", "油号", "号油", "团油"])

        var scores: [String: (Int, [String])] = [:]
        score("didi-charging", keywords: ["小桔充电", "滴滴充电", "桔电"], texts: texts, into: &scores)
        score(fuel ? "amap-fuel" : "amap-charging", keywords: ["高德", "高德地图"], texts: texts, into: &scores)
        score("tuanyou", keywords: ["团油", "能链团油"], texts: texts, into: &scores)

        guard let best = scores.max(by: { $0.value.0 < $1.value.0 }), best.value.0 > 0 else {
            return PlatformDetection(platform: "generic-station", confidence: 0.25, evidence: [])
        }
        let confidence = min(0.98, 0.55 + Double(best.value.0) * 0.12)
        return PlatformDetection(platform: best.key, confidence: confidence, evidence: best.value.1)
    }

    private static func score(
        _ platform: String,
        keywords: [String],
        texts: [String],
        into scores: inout [String: (Int, [String])]
    ) {
        let matched = keywords.filter { keyword in texts.contains(where: { $0.contains(keyword) }) }
        guard !matched.isEmpty else { return }
        scores[platform] = (matched.count, matched)
    }

    private static func containsAny(_ value: String, _ keywords: [String]) -> Bool {
        keywords.contains(where: value.contains)
    }

    private static func compact(_ value: String) -> String {
        value.replacingOccurrences(of: #"\s+"#, with: "", options: .regularExpression)
    }
}

public enum StationParser {
    private static let chargingTitleKeywords = [
        "充电站", "超充站", "快充站", "极充站", "充电中心", "充电广场", "充电桩"
    ]
    private static let fuelTitleKeywords = ["加油站", "能源站", "石油", "石化"]
    private static let addressKeywords = [
        "省", "市", "区", "县", "镇", "乡", "路", "街", "道", "巷", "号",
        "栋", "楼", "大厦", "广场", "园区", "停车场", "地下", "入口", "出口"
    ]
    private static let noiseKeywords = [
        "搜索", "附近", "筛选", "登录", "首页", "我的", "停车减免", "优惠券",
        "扫码充电", "目的地", "功能", "查看列表", "电站名", "充电站▼"
    ]
    private static let fuelKeywords = [
        "加油", "汽油", "柴油", "国标价", "油站价", "团油价", "油号", "号油"
    ]

    public static func extract(
        rows: [OCRRow],
        platform requestedPlatform: String = "auto",
        sourceStage: String = "screen-ocr-user-driven",
        capturedAt: Date = Date()
    ) -> [StationRecord] {
        let sorted = rows
            .filter { !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
            .sorted { lhs, rhs in lhs.y == rhs.y ? lhs.x < rhs.x : lhs.y < rhs.y }
        let detection = requestedPlatform == "auto"
            ? PlatformDetector.detect(rows: sorted)
            : PlatformDetection(platform: requestedPlatform, confidence: 1, evidence: [])
        let titleIndexes = sorted.indices.filter { isStationTitle(compact(sorted[$0].text)) }
        var result: [StationRecord] = []
        var seen = Set<String>()

        for (position, titleIndex) in titleIndexes.enumerated() {
            let title = sorted[titleIndex]
            let nextY = position + 1 < titleIndexes.count
                ? sorted[titleIndexes[position + 1]].y - 0.006
                : title.y + 0.30
            let maxY = min(nextY, title.y + max(0.24, title.height * 10))
            let band = sorted.filter {
                $0 == title || ($0.y > title.y
                    && $0.y < maxY
                    && belongsToCardColumn($0, title: title, platform: detection.platform))
            }
            guard let station = parseBand(
                title: title,
                rows: band,
                detection: detection,
                sourceStage: sourceStage,
                capturedAt: capturedAt
            ) else { continue }
            if seen.insert(station.id).inserted { result.append(station) }
        }
        return result
    }

    private static func parseBand(
        title: OCRRow,
        rows: [OCRRow],
        detection: PlatformDetection,
        sourceStage: String,
        capturedAt: Date
    ) -> StationRecord? {
        let name = compact(title.text)
        guard isStationTitle(name) else { return nil }
        let texts = rows.map { compact($0.text) }
        let stationType: StationType = containsAny(texts.joined(separator: "|"), fuelKeywords)
            || fuelTitleKeywords.contains(where: name.contains)
            || ["tuanyou", "amap-fuel"].contains(detection.platform)
            ? .fuel
            : .charging
        let address = texts.first(where: { $0 != name && isAddress($0) })
        let ports = parsePortSummary(texts)

        if stationType == .fuel {
            let offers = parseFuelOffers(texts)
            var missing = [String]()
            if address == nil { missing.append("address") }
            if ports.available == nil { missing.append("availablePorts") }
            if ports.busy == nil { missing.append("busyPorts") }
            if ports.total == nil { missing.append("totalPorts") }
            if offers.isEmpty { missing.append("fuelOffers") }
            return StationRecord(
                platform: detection.platform,
                platformConfidence: detection.confidence,
                stationType: .fuel,
                stationName: name,
                address: address,
                fuelOffers: offers,
                availablePorts: ports.available,
                busyPorts: ports.busy,
                totalPorts: ports.total,
                sourceStage: sourceStage,
                capturedAt: capturedAt,
                needsReview: detection.confidence < 0.6 || missing.count >= 2,
                missingFields: missing
            )
        }

        var fast: (idle: Int?, total: Int?) = (nil, nil)
        var slow: (idle: Int?, total: Int?) = (nil, nil)
        var superPorts: (idle: Int?, total: Int?) = (nil, nil)
        var priceFast: Double?
        var priceSlow: Double?
        var priceSuper: Double?
        var priceService: Double?

        for text in texts {
            if let typed = parseTypedPorts(text) {
                switch typed.type {
                case "慢": slow = mergePorts(slow, (typed.idle, typed.total))
                case "超": superPorts = mergePorts(superPorts, (typed.idle, typed.total))
                default: fast = mergePorts(fast, (typed.idle, typed.total))
                }
            }
            guard let price = parseChargingPrice(text) else { continue }
            if text.contains("服务费") { priceService = price }
            else if text.contains("慢") { priceSlow = price }
            else if text.contains("超") { priceSuper = price }
            else { priceFast = price }
        }

        let typedAvailable = sumPresent([fast.idle, slow.idle, superPorts.idle])
        let typedTotal = sumPresent([fast.total, slow.total, superPorts.total])
        let available = ports.available ?? typedAvailable
        let total = ports.total ?? typedTotal
        let busy = ports.busy ?? derivedBusy(available: available, total: total)
        var missing = [String]()
        if address == nil { missing.append("address") }
        if available == nil { missing.append("availablePorts") }
        if busy == nil { missing.append("busyPorts") }
        if total == nil { missing.append("totalPorts") }
        if priceFast == nil { missing.append("priceFast") }
        if priceSlow == nil { missing.append("priceSlow") }
        if priceSuper == nil { missing.append("priceSuper") }
        if priceService == nil { missing.append("priceService") }

        return StationRecord(
            platform: detection.platform,
            platformConfidence: detection.confidence,
            stationType: .charging,
            stationName: name,
            address: address,
            priceFast: priceFast,
            priceSlow: priceSlow,
            priceSuper: priceSuper,
            priceService: priceService,
            availablePorts: available,
            busyPorts: busy,
            totalPorts: total,
            fastIdlePorts: fast.idle,
            fastTotalPorts: fast.total,
            slowIdlePorts: slow.idle,
            slowTotalPorts: slow.total,
            superIdlePorts: superPorts.idle,
            superTotalPorts: superPorts.total,
            sourceStage: sourceStage,
            capturedAt: capturedAt,
            needsReview: detection.confidence < 0.6 || missing.count >= 2,
            missingFields: missing
        )
    }

    private static func parseFuelOffers(_ texts: [String]) -> [FuelOffer] {
        var offers: [String: FuelOffer] = [:]
        var currentGrade: String?
        for text in texts {
            if let grade = firstGroup(#"(?<!\d)(0|89|90|92|93|95|97|98|101)\s*#?"#, text) {
                currentGrade = grade
            }
            guard let grade = currentGrade else { continue }
            var offer = offers[grade] ?? FuelOffer(gradeCode: grade, gradeLabel: "\(grade)#")
            offer.displayPrice = labeledPrice(
                text,
                labels: ["团油价", "优惠价", "会员价", "到手价", "外显价", "直降价"]
            ) ?? offer.displayPrice
            offer.stationPrice = labeledPrice(text, labels: ["油站价", "门市价"]) ?? offer.stationPrice
            offer.nationalPrice = labeledPrice(text, labels: ["国标价", "挂牌价"]) ?? offer.nationalPrice
            if let gun = firstGroup(#"(?<!\d)(\d{1,3})\s*号?(?:油)?枪"#, text) {
                offer.gunCode = gun
                offer.gunLabel = "\(gun)号枪"
            }
            offers[grade] = offer
        }
        return offers.values
            .filter { $0.displayPrice != nil || $0.stationPrice != nil || $0.nationalPrice != nil }
            .sorted { (Int($0.gradeCode ?? "") ?? 0) < (Int($1.gradeCode ?? "") ?? 0) }
    }

    private static func labeledPrice(_ text: String, labels: [String]) -> Double? {
        for label in labels {
            let escaped = NSRegularExpression.escapedPattern(for: label)
            if let raw = firstGroup("\(escaped)\\s*[¥￥]?\\s*(\\d+(?:\\.\\d{1,4})?)", text),
               let value = Double(raw), value >= 1, value <= 20 {
                return value
            }
        }
        return nil
    }

    private static func parsePortSummary(_ texts: [String]) -> (available: Int?, busy: Int?, total: Int?) {
        var available: Int?
        var busy: Int?
        var total: Int?
        for text in texts {
            if containsAny(text, ["快充", "慢充", "超充"]) { continue }
            if let values = groups(#"(?:空闲|闲|可用)\s*(\d+)\s*/\s*(\d+)"#, text, count: 2) {
                available = Int(values[0])
                total = Int(values[1])
            }
            if let values = groups(#"(?:空闲|闲|可用)\s*(\d+).*?(?:忙|占用)\s*(\d+)"#, text, count: 2) {
                available = Int(values[0])
                busy = Int(values[1])
                if let available, let busy { total = available + busy }
            }
            if let value = firstGroup(#"(?:总枪数|共|总)\s*(\d+)"#, text) { total = Int(value) }
            if let value = firstGroup(#"(?:空闲|闲|可用)\s*(\d+)"#, text) { available = Int(value) }
            if let value = firstGroup(#"(?:忙|占用)\s*(\d+)"#, text) { busy = Int(value) }
        }
        if let available, let total, available > total { return (nil, nil, nil) }
        if let busy, let total, busy > total { return (nil, nil, nil) }
        return (available, busy, total)
    }

    private static func parseTypedPorts(_ text: String) -> (type: String, idle: Int, total: Int)? {
        guard let values = groups(
            #"(超|快|慢)?\s*(?:充|充桩|充电桩)?\s*(?:闲|空|空闲|可用)\s*(\d+)\s*/\s*(\d+)"#,
            text,
            count: 3,
            allowEmpty: true
        ), let idle = Int(values[1]), let total = Int(values[2]), idle <= total else { return nil }
        return (values[0].isEmpty ? "快" : values[0], idle, total)
    }

    private static func parseChargingPrice(_ text: String) -> Double? {
        let pattern = #"[¥￥]\s*(\d+(?:\.\d{1,4})?)|(?<![\d.])(\d+(?:\.\d{1,4})?)\s*(?:元)?\s*/\s*(?:度|千瓦时|kWh)"#
        guard let match = firstMatch(pattern, text) else { return nil }
        let raw = stringGroup(match, 1, text) ?? stringGroup(match, 2, text)
        guard let raw, let value = Double(raw), value >= 0.2, value <= 3.5 else { return nil }
        return value
    }

    private static func isStationTitle(_ value: String) -> Bool {
        value.count >= 4 && value.count <= 60
            && (chargingTitleKeywords + fuelTitleKeywords).contains(where: value.contains)
            && !noiseKeywords.contains(where: value.contains)
            && !value.contains("▼")
    }

    private static func isAddress(_ value: String) -> Bool {
        value.count >= 5 && value.count <= 100
            && addressKeywords.contains(where: value.contains)
            && parseChargingPrice(value) == nil
            && firstMatch(#"\b1[3-9]\d{9}\b"#, value) == nil
            && !containsAny(value, ["优惠券", "订单", "验证码", "手机号"])
    }

    private static func belongsToCardColumn(_ row: OCRRow, title: OCRRow, platform: String) -> Bool {
        guard platform.contains("amap") else { return true }
        let titleCenter = title.x + title.width / 2
        let rowCenter = row.x + row.width / 2
        return (titleCenter < 0.5) == (rowCenter < 0.5)
    }

    private static func mergePorts(
        _ lhs: (idle: Int?, total: Int?),
        _ rhs: (idle: Int?, total: Int?)
    ) -> (idle: Int?, total: Int?) {
        (maxOptional(lhs.idle, rhs.idle), maxOptional(lhs.total, rhs.total))
    }

    private static func maxOptional(_ lhs: Int?, _ rhs: Int?) -> Int? {
        switch (lhs, rhs) {
        case let (.some(left), .some(right)): max(left, right)
        case let (.some(left), .none): left
        case let (.none, .some(right)): right
        case (.none, .none): nil
        }
    }

    private static func sumPresent(_ values: [Int?]) -> Int? {
        let present = values.compactMap { $0 }
        return present.isEmpty ? nil : present.reduce(0, +)
    }

    private static func derivedBusy(available: Int?, total: Int?) -> Int? {
        guard let available, let total, available <= total else { return nil }
        return total - available
    }

    private static func containsAny(_ value: String, _ keywords: [String]) -> Bool {
        keywords.contains(where: value.contains)
    }

    private static func compact(_ value: String) -> String {
        value.replacingOccurrences(of: #"\s+"#, with: "", options: .regularExpression)
    }

    private static func firstMatch(_ pattern: String, _ text: String) -> NSTextCheckingResult? {
        try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive])
            .firstMatch(in: text, range: NSRange(text.startIndex..., in: text))
    }

    private static func firstGroup(_ pattern: String, _ text: String) -> String? {
        guard let match = firstMatch(pattern, text) else { return nil }
        return stringGroup(match, 1, text)
    }

    private static func groups(
        _ pattern: String,
        _ text: String,
        count: Int,
        allowEmpty: Bool = false
    ) -> [String]? {
        guard let match = firstMatch(pattern, text), match.numberOfRanges == count + 1 else { return nil }
        var values = [String]()
        for index in 1...count {
            if let value = stringGroup(match, index, text) {
                values.append(value)
            } else if allowEmpty {
                values.append("")
            } else {
                return nil
            }
        }
        return values
    }

    private static func stringGroup(_ match: NSTextCheckingResult, _ index: Int, _ text: String) -> String? {
        let range = match.range(at: index)
        guard range.location != NSNotFound, let swiftRange = Range(range, in: text) else { return nil }
        return String(text[swiftRange])
    }
}
