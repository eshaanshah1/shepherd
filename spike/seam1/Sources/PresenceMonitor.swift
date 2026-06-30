import Foundation
import AppKit
import CoreGraphics

/// "Are you away from this Mac?" — `isAway = lidClosed && !externalDisplayAttached`. Composes
/// the existing ClamshellMonitor (lid) with a screen-parameters observer (external display).
/// Observe-only, like ClamshellMonitor/ThermalMonitor. `onChange` fires with the new isAway on
/// any lid OR display change; the away→present edge (onChange(false)) drives the catch-up sweep.
@MainActor
final class PresenceMonitor {
    private(set) var isAway = false
    var onChange: ((Bool) -> Void)?

    private let clamshell = ClamshellMonitor()
    private var screenObserver: NSObjectProtocol?

    func start() {
        clamshell.onChange = { [weak self] _ in self?.recompute() }
        clamshell.start()
        screenObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main
        ) { [weak self] _ in
            // Posted on the main queue; @MainActor hop keeps the recompute on main.
            Task { @MainActor in self?.recompute() }
        }
        isAway = Self.compute(lidClosed: clamshell.isLidClosed)
    }

    func stop() {
        clamshell.stop()
        if let o = screenObserver { NotificationCenter.default.removeObserver(o); screenObserver = nil }
    }

    private func recompute() {
        let now = Self.compute(lidClosed: clamshell.isLidClosed)
        guard now != isAway else { return }
        isAway = now
        onChange?(now)
    }

    private static func compute(lidClosed: Bool) -> Bool { lidClosed && !externalDisplayAttached() }

    /// True if any ACTIVE display is not the built-in panel (i.e. an external monitor is attached).
    static func externalDisplayAttached() -> Bool {
        var count: UInt32 = 0
        guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0 else { return false }
        var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
        guard CGGetActiveDisplayList(count, &ids, &count) == .success else { return false }
        return ids.prefix(Int(count)).contains { CGDisplayIsBuiltin($0) == 0 }
    }
}
