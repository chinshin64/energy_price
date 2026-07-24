import Testing
@testable import StationOCRCore

@Test func parsesVisibleStationFieldsAndComputesBusyPorts() {
    let rows = [
        row("小桔充电西安软件新城充电站", 0.30),
        row("陕西省西安市雁塔区云水一路88号停车场", 0.35),
        row("快充 闲3/8 ¥0.85/度", 0.40),
        row("慢充 闲1/2 ¥0.62/度", 0.45),
        row("超充 闲2/4 ¥1.20/度", 0.50)
    ]
    let stations = StationParser.extract(rows: rows, platform: "didi-charging")
    #expect(stations.count == 1)
    #expect(stations[0].stationName == "小桔充电西安软件新城充电站")
    #expect(stations[0].address == "陕西省西安市雁塔区云水一路88号停车场")
    #expect(stations[0].availablePorts == 6)
    #expect(stations[0].totalPorts == 14)
    #expect(stations[0].busyPorts == 8)
    #expect(stations[0].priceFast == 0.85)
    #expect(stations[0].priceSlow == 0.62)
    #expect(stations[0].priceSuper == 1.20)
    #expect(stations[0].sourceAgent == "ios-ocr-agent")
    #expect(stations[0].missingFields.isEmpty)
}

@Test func rejectsCardsWithoutStationAndBusinessSignals() {
    let rows = [row("西安北站宠物市场", 0.30), row("¥103/人", 0.35)]
    #expect(StationParser.extract(rows: rows, platform: "didi-charging").isEmpty)
}

@Test func explicitZeroPortsRemainObservedWhileMissingPortsStayNil() {
    let observed = StationParser.extract(rows: [
        row("城市公共充电站", 0.30),
        row("高新区科技一路1号", 0.35),
        row("快充 闲0/0 ¥0.88/度", 0.40),
    ], platform: "generic-station")
    #expect(observed.count == 1)
    #expect(observed[0].availablePorts == 0)
    #expect(observed[0].busyPorts == 0)
    #expect(observed[0].totalPorts == 0)
    #expect(!observed[0].missingFields.contains("totalPorts"))

    let missing = StationParser.extract(rows: [
        row("城市公共充电站", 0.30),
        row("高新区科技一路1号", 0.35),
        row("¥0.88/度", 0.40),
    ], platform: "generic-station")
    #expect(missing.count == 1)
    #expect(missing[0].availablePorts == nil)
    #expect(missing[0].busyPorts == nil)
    #expect(missing[0].totalPorts == nil)
}

@Test func isolatesAmapTwoColumnCardsFromAdjacentCommerceContent() {
    let rows = [
        OCRRow(text: "比亚迪闪充汽车充电站(西安城市运动公园)", x: 0.04, y: 0.40, width: 0.43, height: 0.035),
        OCRRow(text: "快充桩", x: 0.04, y: 0.45, width: 0.18, height: 0.035),
        OCRRow(text: "¥0.85/度", x: 0.04, y: 0.50, width: 0.22, height: 0.035),
        OCRRow(text: "西安城市运动公园东门", x: 0.04, y: 0.55, width: 0.42, height: 0.035),
        OCRRow(text: "庭院江南菜北京烤鸭", x: 0.54, y: 0.43, width: 0.40, height: 0.035),
        OCRRow(text: "¥1.05/度", x: 0.54, y: 0.50, width: 0.20, height: 0.035),
    ]

    let stations = StationParser.extract(rows: rows, platform: "amap-charging")
    #expect(stations.count == 1)
    #expect(stations[0].priceFast == 0.85)
    #expect(stations[0].address == "西安城市运动公园东门")
}

@Test func detectsTuanyouFuelAddressThreePricesGradeGunAndPorts() {
    let rows = [
        row("能链团油", 0.20),
        row("中石化西安科技路加油站", 0.30),
        row("陕西省西安市雁塔区科技路18号", 0.35),
        row("92# 团油价7.28 油站价7.58 国标价8.12", 0.40),
        row("12号油枪 空闲2 忙3 总5", 0.45)
    ]
    let stations = StationParser.extract(rows: rows)
    #expect(stations.count == 1)
    #expect(stations[0].platform == "tuanyou")
    #expect(stations[0].stationType == .fuel)
    #expect(stations[0].address == "陕西省西安市雁塔区科技路18号")
    #expect(stations[0].availablePorts == 2)
    #expect(stations[0].busyPorts == 3)
    #expect(stations[0].totalPorts == 5)
    #expect(stations[0].fuelOffers.count == 1)
    #expect(stations[0].fuelOffers[0].gradeCode == "92")
    #expect(stations[0].fuelOffers[0].displayPrice == 7.28)
    #expect(stations[0].fuelOffers[0].stationPrice == 7.58)
    #expect(stations[0].fuelOffers[0].nationalPrice == 8.12)
    #expect(stations[0].fuelOffers[0].gunCode == "12")
}

@Test func automaticUnknownPlatformFailsClosedToGeneric() {
    let rows = [
        row("城市公共充电站", 0.30),
        row("高新区科技一路1号", 0.35),
        row("空闲2/4 ¥0.88/度", 0.40)
    ]
    let stations = StationParser.extract(rows: rows)
    #expect(stations.count == 1)
    #expect(stations[0].platform == "generic-station")
    #expect(stations[0].needsReview)
}

private func row(_ text: String, _ y: Double) -> OCRRow {
    OCRRow(text: text, x: 0.05, y: y, width: 0.8, height: 0.035)
}
