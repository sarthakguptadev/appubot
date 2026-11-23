// appubot-notify: AppuBot's notification permission, as macOS sees it.
//
// Electron can show notifications but can't tell whether macOS lets them through. This tool can, because it ships in
// AppuBot.app/Contents/MacOS signed with the app's own identifier: macOS takes it for AppuBot (Bundle.main is the app).
//
//   appubot-notify status    → {"access":"on"|"off"|"not-asked"}
//   appubot-notify request   → asks (macOS shows its prompt only while not asked yet), then the status as above
import Foundation
import UserNotifications

func access(_ s: UNNotificationSettings) -> String {
    switch s.authorizationStatus {
    case .notDetermined: return "not-asked"
    case .denied: return "off"
    default:
        // allowed, but with no banners or alerts nothing shows on screen
        return s.alertSetting == .enabled && s.alertStyle != .none ? "on" : "off"
    }
}

func status() -> String {
    let sem = DispatchSemaphore(value: 0)
    var result = "unknown"
    UNUserNotificationCenter.current().getNotificationSettings { s in
        result = access(s)
        sem.signal()
    }
    _ = sem.wait(timeout: .now() + 5)
    return result
}

let center = UNUserNotificationCenter.current()
if CommandLine.arguments.dropFirst().first == "request" {
    let sem = DispatchSemaphore(value: 0)
    center.requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in sem.signal() }
    // the user may take a while to answer macOS's prompt
    _ = sem.wait(timeout: .now() + 120)
}
print("{\"access\":\"\(status())\"}")
