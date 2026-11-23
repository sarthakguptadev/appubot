// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "appubot-helper",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "appubot-helper", targets: ["appubot-helper"]),
        // ships in AppuBot.app/Contents/MacOS so macOS takes it for the app (notification permission)
        .executable(name: "appubot-notify", targets: ["appubot-notify"]),
    ],
    targets: [
        .executableTarget(
            name: "appubot-helper",
            path: "Sources/appubot-helper",
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("ApplicationServices"),
                .linkedFramework("CoreGraphics"),
                .linkedFramework("ScreenCaptureKit"),
                .linkedFramework("VideoToolbox"),
                .linkedFramework("CoreMedia"),
            ]
        ),
        .executableTarget(
            name: "appubot-notify",
            path: "Sources/appubot-notify",
            exclude: ["Info.plist"],
            linkerSettings: [
                .linkedFramework("UserNotifications"),
                // its Info.plist, embedded, makes codesign sign it as ai.appubot.desktop
                .unsafeFlags(["-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", "Sources/appubot-notify/Info.plist"]),
            ]
        ),
    ],
    swiftLanguageVersions: [.v5]
)
