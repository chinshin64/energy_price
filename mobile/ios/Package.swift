// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "DataForDidiOCR",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "StationOCRCore", targets: ["StationOCRCore"])
    ],
    targets: [
        .target(name: "StationOCRCore"),
        .testTarget(name: "StationOCRCoreTests", dependencies: ["StationOCRCore"])
    ]
)
