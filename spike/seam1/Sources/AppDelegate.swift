import AppKit
import UserNotifications

/// Requests notification permission, reconciles the sleep guard at launch, tears it
/// down at quit, and routes a notification click back to the tab that fired it.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.requestAuthorization(options: [.alert, .sound]) { _, _ in }
        SleepGuard.shared.reconcileAtLaunch()
    }

    func applicationWillTerminate(_ notification: Notification) {
        SleepGuard.shared.teardownAtQuit()
        AgentStore.shared.teardownAllPanes()   // close every PTY so helpers/shells don't orphan
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let paneID = response.notification.request.content.userInfo["paneID"] as? String
        if let paneID { AgentStore.shared.revealPane(paneID) }
        NSApp.activate(ignoringOtherApps: true)
        completionHandler()
    }
}
