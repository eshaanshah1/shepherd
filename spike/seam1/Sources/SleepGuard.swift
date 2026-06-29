import SwiftUI
import AppKit
import IOKit.pwr_mgt
import UserNotifications

/// Owns the Mac's "stay awake" policy and the actual power mechanism. The pure
/// decision is in SleepPolicy; this is the effectful shell. One mechanism is held at
/// a time — Tier 2 (pmset disablesleep, survives lid close) preferred, Tier 1 (IOKit
/// idle assertion, no root) as fallback. We only shell out on a hold/release
/// transition, never per state-change event.
@MainActor
final class SleepGuard: ObservableObject {
    static let shared = SleepGuard()

    enum Mechanism { case none, assertion, pmset }

    @Published var mode: CaffeinateMode {
        didSet { UserDefaults.standard.set(mode.rawValue, forKey: Self.modeKey); refresh() }
    }
    @Published var thermalAutoSleep: Bool {
        didSet {
            UserDefaults.standard.set(thermalAutoSleep, forKey: Self.thermalKey)
            updateThermalMonitor(); refresh()
        }
    }
    /// True if Tier 2 (clamshell survival) was reachable at the last probe/hold.
    @Published private(set) var tier2Available = false

    private var held: Mechanism = .none
    private var assertionID: IOPMAssertionID = 0
    private var lastBusy = false
    var thermalSuppressed = false           // set by the thermal path (Task 8)
    private var releaseTimer: DispatchWorkItem?
    private let clamshell = ClamshellMonitor()
    private let thermal = ThermalMonitor()
    private(set) var isLidClosed = false

    private static let modeKey = "shepherd.caffeinate.mode"
    private static let thermalKey = "shepherd.caffeinate.thermalAutoSleep"
    private static let graceSeconds: TimeInterval = 120

    private init() {
        mode = CaffeinateMode(rawValue: UserDefaults.standard.string(forKey: Self.modeKey) ?? "") ?? .off
        thermalAutoSleep = UserDefaults.standard.object(forKey: Self.thermalKey) as? Bool ?? true
    }

    // MARK: external drivers

    func update(hasBusyAgent: Bool) { lastBusy = hasBusyAgent; refresh() }

    /// On launch: reconcile the flag to desired. If not desired, force-clear it —
    /// this wipes a stale `disablesleep 1` stranded by a previous crash.
    func reconcileAtLaunch() {
        tier2Available = Self.probeTier2()
        if shouldStayAwake(mode: mode, hasBusyAgent: lastBusy, thermalSuppressed: thermalSuppressed) {
            establishHold()
        } else {
            _ = Self.setDisableSleep(false); releaseAssertion(); held = .none
        }
        isLidClosed = clamshell.isLidClosed
        clamshell.onChange = { [weak self] closed in self?.clamshellDidChange(closed) }
        clamshell.start()
        isLidClosed = clamshell.isLidClosed
        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification, object: nil, queue: .main
        ) { [weak self] _ in
            guard let self else { return }
            self.thermalSuppressed = self.isLidClosed && self.held == .pmset && ThermalMonitor.isHot(ProcessInfo.processInfo.thermalState)
            self.refresh(immediate: true)
            self.updateThermalMonitor()
        }
    }

    private func clamshellDidChange(_ closed: Bool) {
        isLidClosed = closed
        if closed, held == .pmset { Self.blankDisplayNow() }
        updateThermalMonitor()
    }

    /// On quit: unconditionally clear the flag + release the assertion (critical cleanup).
    func teardownAtQuit() {
        cancelPendingRelease()
        _ = Self.setDisableSleep(false)
        releaseAssertion()
        held = .none
    }

    // MARK: core reconcile

    func refresh(immediate: Bool = false) {
        let desired = shouldStayAwake(mode: mode, hasBusyAgent: lastBusy, thermalSuppressed: thermalSuppressed)
        if desired {
            cancelPendingRelease()
            if held == .none { establishHold() }
        } else if held != .none {
            // `.whileAgents` lingers for the grace window so a quick idle gap doesn't flap.
            if immediate || mode != .whileAgents || thermalSuppressed { releaseMechanism() }
            else { scheduleGracefulRelease() }
        }
    }

    private func establishHold() {
        if Self.setDisableSleep(true) {
            held = .pmset; tier2Available = true
            if isLidClosed { Self.blankDisplayNow() }
        } else {
            tier2Available = false
            acquireAssertion(); held = .assertion
        }
        updateThermalMonitor()
    }

    private func releaseMechanism() {
        switch held {
        case .pmset:     _ = Self.setDisableSleep(false)
        case .assertion: releaseAssertion()
        case .none:      break
        }
        held = .none
        updateThermalMonitor()
    }

    // MARK: thermal — clamshell-gated auto-sleep

    /// Start the thermal monitor only while it can act; stop it otherwise.
    private func updateThermalMonitor() {
        let shouldWatch = thermalAutoSleep && isLidClosed && held == .pmset
        if shouldWatch {
            thermal.onChange = { [weak self] s in self?.thermalDidChange(s) }
            thermal.start()
        } else {
            thermal.stop()
            thermal.onChange = nil
        }
    }

    private func thermalDidChange(_ s: ProcessInfo.ThermalState) {
        let hot = ThermalMonitor.isHot(s)
        guard hot != thermalSuppressed else { return }
        thermalSuppressed = hot
        if hot { notifyThermalSleep(s) }
        refresh(immediate: true)   // release now → the closed lid sleeps the Mac to cool
    }

    private func notifyThermalSleep(_ s: ProcessInfo.ThermalState) {
        let content = UNMutableNotificationContent()
        content.title = "Letting your Mac sleep to cool down"
        content.body = "Thermal state reached \(s == .critical ? "critical" : "serious") under a closed lid."
        UNUserNotificationCenter.current().add(
            UNNotificationRequest(identifier: "shepherd-thermal-sleep", content: content, trigger: nil))
    }

    #if DEBUG
    /// Inject a thermal state to verify the clamshell auto-sleep path without load.
    func simulateThermal(_ s: ProcessInfo.ThermalState) { thermal.handle(s) }
    #endif

    private func scheduleGracefulRelease() {
        cancelPendingRelease()
        let work = DispatchWorkItem { [weak self] in self?.releaseTimer = nil; self?.releaseMechanism() }
        releaseTimer = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.graceSeconds, execute: work)
    }

    private func cancelPendingRelease() { releaseTimer?.cancel(); releaseTimer = nil }

    // MARK: Tier 1 — IOKit idle assertion

    private func acquireAssertion() {
        guard assertionID == 0 else { return }
        var id: IOPMAssertionID = 0
        let r = IOPMAssertionCreateWithName(
            kIOPMAssertionTypePreventUserIdleSystemSleep as CFString,
            IOPMAssertionLevel(kIOPMAssertionLevelOn), "Shepherd: agent running" as CFString, &id)
        if r == kIOReturnSuccess { assertionID = id }
    }

    private func releaseAssertion() {
        guard assertionID != 0 else { return }
        IOPMAssertionRelease(assertionID); assertionID = 0
    }

    // MARK: Tier 2 — pmset disablesleep (passwordless sudo)

    @discardableResult private static func setDisableSleep(_ on: Bool) -> Bool {
        runPmset(["-a", "disablesleep", on ? "1" : "0"], sudo: true)
    }
    static func probeTier2() -> Bool { runPmset(["-g"], sudo: true) }

    /// `displaysleepnow` needs no root, so it runs pmset directly (Task 7 uses this).
    static func blankDisplayNow() { _ = runPmset(["displaysleepnow"], sudo: false) }

    @discardableResult
    private static func runPmset(_ args: [String], sudo: Bool) -> Bool {
        let p = Process()
        if sudo {
            p.executableURL = URL(fileURLWithPath: "/usr/bin/sudo")
            p.arguments = ["-n", "/usr/bin/pmset"] + args
        } else {
            p.executableURL = URL(fileURLWithPath: "/usr/bin/pmset")
            p.arguments = args
        }
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        do { try p.run() } catch { return false }
        p.waitUntilExit()
        return p.terminationStatus == 0
    }
}
