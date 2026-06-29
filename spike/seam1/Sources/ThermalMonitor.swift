import Foundation

/// Watches system thermal pressure via ProcessInfo. Notification-based, no polling.
/// SleepGuard starts/stops it only while it can act (clamshell + Tier 2 held).
final class ThermalMonitor {
    private(set) var state: ProcessInfo.ThermalState = .nominal
    var onChange: ((ProcessInfo.ThermalState) -> Void)?
    private var observer: NSObjectProtocol?

    func start() {
        guard observer == nil else { return }
        state = ProcessInfo.processInfo.thermalState
        observer = NotificationCenter.default.addObserver(
            forName: ProcessInfo.thermalStateDidChangeNotification, object: nil, queue: .main
        ) { [weak self] _ in self?.handle(ProcessInfo.processInfo.thermalState) }
    }

    func stop() {
        if let observer { NotificationCenter.default.removeObserver(observer); self.observer = nil }
    }

    /// Apply a new thermal state. Public so the DEBUG menu can simulate a spike.
    func handle(_ newState: ProcessInfo.ThermalState) {
        guard newState != state else { return }
        state = newState
        onChange?(newState)
    }

    /// `.serious`/`.critical` is the threshold that triggers clamshell auto-sleep.
    static func isHot(_ s: ProcessInfo.ThermalState) -> Bool { s == .serious || s == .critical }
}
