// swift-tools-version: 5.9

import PackageDescription

let package = Package(
  name: "ravi-os-swift-sdk",
  platforms: [
    .iOS(.v16),
    .macOS(.v13)
  ],
  products: [
    .library(name: "RaviSDK", targets: ["RaviSDK"])
  ],
  targets: [
    .target(name: "RaviSDK", path: "Sources/RaviSDK"),
    .testTarget(name: "RaviSDKTests", dependencies: ["RaviSDK"], path: "Tests/RaviSDKTests")
  ]
)
