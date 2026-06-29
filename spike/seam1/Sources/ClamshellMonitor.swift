import Foundation
import IOKit
import IOKit.pwr_mgt

/// Watches the laptop lid (clamshell) via IOKit. Observe-only — it does NOT
/// participate in sleep arbitration (no kIOMessageCanSystemSleep ack), so it can't
/// stall a real sleep. No-op on machines without a lid (AppleClamshellState absent).
final class ClamshellMonitor {
    private(set) var isLidClosed = false
    var onChange: ((Bool) -> Void)?

    private var notifyPort: IONotificationPortRef?
    private var notifier: io_object_t = 0
    private var rootDomain: io_service_t = 0

    func start() {
        guard rootDomain == 0 else { return }
        rootDomain = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOPMrootDomain"))
        guard rootDomain != 0 else { return }
        isLidClosed = Self.readClamshell(rootDomain)

        notifyPort = IONotificationPortCreate(kIOMainPortDefault)
        guard let notifyPort else { return }
        IONotificationPortSetDispatchQueue(notifyPort, .main)

        let ctx = Unmanaged.passUnretained(self).toOpaque()
        IOServiceAddInterestNotification(
            notifyPort, rootDomain, kIOGeneralInterest,
            { refcon, _, messageType, _ in
                guard messageType == kShepherdIOPMMessageClamshellStateChange, let refcon else { return }
                Unmanaged<ClamshellMonitor>.fromOpaque(refcon).takeUnretainedValue().refresh()
            },
            ctx, &notifier)
    }

    func stop() {
        if notifier != 0 { IOObjectRelease(notifier); notifier = 0 }
        if let notifyPort { IONotificationPortDestroy(notifyPort); self.notifyPort = nil }
        if rootDomain != 0 { IOObjectRelease(rootDomain); rootDomain = 0 }
    }

    private func refresh() {
        let closed = Self.readClamshell(rootDomain)
        guard closed != isLidClosed else { return }
        isLidClosed = closed
        onChange?(closed)
    }

    private static func readClamshell(_ service: io_service_t) -> Bool {
        guard let prop = IORegistryEntryCreateCFProperty(
                service, "AppleClamshellState" as CFString, kCFAllocatorDefault, 0)?
                .takeRetainedValue() else { return false }
        return (prop as? Bool) ?? false
    }
}
