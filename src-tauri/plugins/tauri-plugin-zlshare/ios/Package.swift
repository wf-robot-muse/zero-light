// swift-tools-version:5.3
// Item #62: Zero Light's own share plugin (iOS side).

import PackageDescription

let package = Package(
    name: "tauri-plugin-zlshare",
    platforms: [
        .macOS(.v10_13),
        .iOS(.v13),
    ],
    products: [
        .library(
            name: "tauri-plugin-zlshare",
            type: .static,
            targets: ["tauri-plugin-zlshare"]),
    ],
    dependencies: [
        .package(name: "Tauri", path: "../.tauri/tauri-api")
    ],
    targets: [
        .target(
            name: "tauri-plugin-zlshare",
            dependencies: [
                .byName(name: "Tauri")
            ],
            path: "Sources")
    ]
)
