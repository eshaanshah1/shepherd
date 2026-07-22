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
        AgentStore.shared.teardownSocket()     // unlink this launch's /tmp socket
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let paneID = response.notification.request.content.userInfo["paneID"] as? String
        if let paneID { AgentStore.shared.focusForNotification(paneID: paneID) }
        NSApp.activate(ignoringOtherApps: true)
        bringMainWindowFront()   // reuse the existing window instead of spawning a new one
        completionHandler()
    }

    /// Clicking the dock icon with no visible window reuses the existing one.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { bringMainWindowFront() }
        return true
    }

    /// Bring the app's existing content window forward (de-minimizing if needed) rather
    /// than letting SwiftUI's WindowGroup open a fresh one on activation. The Settings
    /// window (⌘,) is excluded via `canBecomeMain` + a content check.
    private func bringMainWindowFront() {
        guard let win = NSApp.windows.first(where: { $0.canBecomeMain && $0.contentView != nil }) else { return }
        if win.isMiniaturized { win.deminiaturize(nil) }
        win.makeKeyAndOrderFront(nil)
    }
}
