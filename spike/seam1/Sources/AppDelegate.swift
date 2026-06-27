import AppKit
import UserNotifications

/// Requests notification permission at launch and routes a notification click
/// back to the tab that fired it (activate Shepherd + select that tab).
final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let paneID = response.notification.request.content.userInfo["paneID"] as? String
        Task { @MainActor in
            if let paneID { AgentStore.shared.revealPane(paneID) }
            NSApp.activate(ignoringOtherApps: true)
        }
        completionHandler()
    }
}
