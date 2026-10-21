// swift-tools-version:5.9
import PackageDescription

// LiveKit for the TriOS calling seam (.trinity/specs/internet-calls.md,
// gHashTag/trios#2053). The version and its transitive pins (Package.resolved)
// are the ones the TRI-NET Xcode projects resolve, so TriOS and the TRI-NET
// apps speak the same LiveKit client.
let package = Package(
    name: "TriOSLiveKit",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "TriOSLiveKit", type: .dynamic, targets: ["TriOSLiveKit"]),
    ],
    dependencies: [
        .package(url: "https://github.com/livekit/client-sdk-swift.git", exact: "2.15.2"),
    ],
    targets: [
        .target(
            name: "TriOSLiveKit",
            dependencies: [.product(name: "LiveKit", package: "client-sdk-swift")]
        ),
    ]
)
