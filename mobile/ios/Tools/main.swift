import Foundation
import StationOCRCore

let rows = [
    OCRRow(text: "小桔充电西安软件新城充电站", x: 0.05, y: 0.30, width: 0.8, height: 0.035),
    OCRRow(text: "陕西省西安市雁塔区云水一路88号停车场", x: 0.05, y: 0.35, width: 0.8, height: 0.035),
    OCRRow(text: "快充 闲3/8 ¥0.85/度", x: 0.05, y: 0.40, width: 0.8, height: 0.035),
    OCRRow(text: "慢充 闲1/2 ¥0.62/度", x: 0.05, y: 0.45, width: 0.8, height: 0.035),
    OCRRow(text: "超充 闲2/4 ¥1.20/度", x: 0.05, y: 0.50, width: 0.8, height: 0.035)
]
let stations = StationParser.extract(rows: rows, platform: "didi-charging")
precondition(stations.count == 1)
precondition(stations[0].stationName == "小桔充电西安软件新城充电站")
precondition(stations[0].address == "陕西省西安市雁塔区云水一路88号停车场")
precondition(stations[0].availablePorts == 6)
precondition(stations[0].busyPorts == 8)
precondition(stations[0].totalPorts == 14)
precondition(stations[0].priceFast == 0.85)
precondition(stations[0].priceSlow == 0.62)
precondition(stations[0].priceSuper == 1.20)
precondition(stations[0].sourceAgent == "ios-ocr-agent")
print("StationOCRCore parser smoke test passed")

let observedZeroStations = StationParser.extract(rows: [
    OCRRow(text: "城市公共充电站", x: 0.05, y: 0.30, width: 0.8, height: 0.035),
    OCRRow(text: "高新区科技一路1号", x: 0.05, y: 0.35, width: 0.8, height: 0.035),
    OCRRow(text: "快充 闲0/0 ¥0.88/度", x: 0.05, y: 0.40, width: 0.8, height: 0.035),
], platform: "generic-station")
precondition(observedZeroStations.count == 1)
precondition(observedZeroStations[0].availablePorts == 0)
precondition(observedZeroStations[0].busyPorts == 0)
precondition(observedZeroStations[0].totalPorts == 0)

let missingPortStations = StationParser.extract(rows: [
    OCRRow(text: "城市公共充电站", x: 0.05, y: 0.30, width: 0.8, height: 0.035),
    OCRRow(text: "高新区科技一路1号", x: 0.05, y: 0.35, width: 0.8, height: 0.035),
    OCRRow(text: "¥0.88/度", x: 0.05, y: 0.40, width: 0.8, height: 0.035),
], platform: "generic-station")
precondition(missingPortStations.count == 1)
precondition(missingPortStations[0].availablePorts == nil)
precondition(missingPortStations[0].busyPorts == nil)
precondition(missingPortStations[0].totalPorts == nil)
print("StationOCRCore zero-port observation evidence smoke test passed")

let amapRows = [
    OCRRow(text: "比亚迪闪充汽车充电站(西安城市运动公园)", x: 0.04, y: 0.40, width: 0.43, height: 0.035),
    OCRRow(text: "快充桩", x: 0.04, y: 0.45, width: 0.18, height: 0.035),
    OCRRow(text: "¥0.85/度", x: 0.04, y: 0.50, width: 0.22, height: 0.035),
    OCRRow(text: "西安城市运动公园东门", x: 0.04, y: 0.55, width: 0.42, height: 0.035),
    OCRRow(text: "庭院江南菜北京烤鸭", x: 0.54, y: 0.43, width: 0.40, height: 0.035),
    OCRRow(text: "¥1.05/度", x: 0.54, y: 0.50, width: 0.20, height: 0.035),
]
let amapStations = StationParser.extract(rows: amapRows, platform: "amap-charging")
precondition(amapStations.count == 1)
precondition(amapStations[0].priceFast == 0.85)
precondition(amapStations[0].address == "西安城市运动公园东门")
print("StationOCRCore Amap two-column isolation smoke test passed")

let fuelRows = [
    OCRRow(text: "能链团油", x: 0.05, y: 0.20, width: 0.8, height: 0.035),
    OCRRow(text: "中石化西安科技路加油站", x: 0.05, y: 0.30, width: 0.8, height: 0.035),
    OCRRow(text: "陕西省西安市雁塔区科技路18号", x: 0.05, y: 0.35, width: 0.8, height: 0.035),
    OCRRow(text: "92# 团油价7.28 油站价7.58 国标价8.12", x: 0.05, y: 0.40, width: 0.8, height: 0.035),
    OCRRow(text: "12号油枪 空闲2 忙3 总5", x: 0.05, y: 0.45, width: 0.8, height: 0.035)
]
let fuelStations = StationParser.extract(rows: fuelRows)
precondition(fuelStations.count == 1)
precondition(fuelStations[0].platform == "tuanyou")
precondition(fuelStations[0].fuelOffers.first?.displayPrice == 7.28)
precondition(fuelStations[0].fuelOffers.first?.stationPrice == 7.58)
precondition(fuelStations[0].fuelOffers.first?.nationalPrice == 8.12)
precondition(fuelStations[0].fuelOffers.first?.gunCode == "12")
print("StationOCRCore fuel parser smoke test passed")
