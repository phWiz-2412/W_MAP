// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "WMap",
    platforms: [
        .iOS(.v16),
        .macOS(.v13)
    ],
    products: [
        .library(name: "WMapCore", targets: ["WMapCore"])
    ],
    targets: [
        .target(
            name: "WMapCore",
            path: "Sources/WMapCore"
        ),
        .testTarget(
            name: "WMapCoreTests",
            dependencies: ["WMapCore"],
            path: "Tests/WMapCoreTests"
        )
    ]
)
