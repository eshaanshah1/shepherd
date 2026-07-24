import Foundation
import AppKit
import Combine

enum UpdatePhase: Equatable {
    case idle
    case checking
    case available(UpdateAvailable)
    case downloading(Double)
    case readyToRestart(UpdateAvailable)
    case restarting
    case upToDate
    case error(String)
}

/// Owns the update lifecycle the UI binds to: daily cadence, the skip-this-
/// version filter, the auto-check toggle, background download, and the
/// restart-now / restart-when-idle countdown. Dormant unless the running build
/// is an eligible release in a writable /Applications location.
@MainActor
final class UpdateController: ObservableObject {
    static let shared = UpdateController()

    @Published private(set) var phase: UpdatePhase = .idle
    @Published private(set) var restartWhenIdle = false
    @Published private(set) var countdown: Int? = nil

    private let lastCheckKey = "shepherd.update.lastCheck"
    private let skippedKey = "shepherd.update.skippedVersion"
    private let autoKey = "shepherd.update.autoCheckEnabled"

    private var readyBundlePath: String?
    private var dailyTimer: Timer?
    private var countdownTimer: Timer?
    private var cancellables = Set<AnyCancellable>()

    private init() {}

    // MARK: eligibility

    /// Live only for a real release build running from a writable /Applications
    /// bundle. Dev builds (`-dev` sentinel / `.dev` bundle id) and non-/Applications
    /// copies stay dormant.
    var isEligible: Bool {
        guard !AppMode.isDev, !AppVersion.current.isPrerelease else { return false }
        let path = Bundle.main.bundlePath
        return path.hasPrefix("/Applications/") && FileManager.default.isWritableFile(atPath: path)
    }

    var autoCheckEnabled: Bool {
        get { (UserDefaults.standard.object(forKey: autoKey) as? Bool) ?? true }
        set {
            UserDefaults.standard.set(newValue, forKey: autoKey)
            objectWillChange.send()
            if newValue { startDailyTimerIfNeeded(); Task { await maybeAutoCheck() } }
            else { dailyTimer?.invalidate(); dailyTimer = nil; if isAutomaticPhase { phase = .idle } }
        }
    }

    private var isAutomaticPhase: Bool {
        switch phase { case .available, .downloading, .readyToRestart: return true; default: return false }
    }

    /// Whether the sidebar-footer pill should be shown for the current phase
    /// (checking / up-to-date are Settings-only, transient states).
    var hasSidebarPill: Bool {
        switch phase {
        case .available, .downloading, .readyToRestart, .restarting: return true
        default: return false
        }
    }

    private var skippedVersion: Version? {
        (UserDefaults.standard.string(forKey: skippedKey)).flatMap(Version.init)
    }

    // MARK: launch

    func startIfEligible() {
        guard isEligible else { return }
        observeActivity()
        startDailyTimerIfNeeded()
        Task { await maybeAutoCheck() }
    }

    private func startDailyTimerIfNeeded() {
        guard isEligible, autoCheckEnabled, dailyTimer == nil else { return }
        dailyTimer = Timer.scheduledTimer(withTimeInterval: 6 * 3600, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.maybeAutoCheck() }
        }
    }

    private func maybeAutoCheck() async {
        guard isEligible, autoCheckEnabled else { return }
        let last = UserDefaults.standard.double(forKey: lastCheckKey)
        let elapsed = Date().timeIntervalSince1970 - last
        guard last == 0 || elapsed > 24 * 3600 else { return }
        await check(manual: false)
    }

    // MARK: checking

    func checkNow() async { await check(manual: true) }

    private func check(manual: Bool) async {
        guard isEligible else { return }
        if !manual && !autoCheckEnabled { return }
        phase = .checking
        UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: lastCheckKey)
        guard let update = await UpdateService.checkForUpdate(current: AppVersion.current) else {
            phase = manual ? .upToDate : .idle
            return
        }
        if !manual && !shouldSurface(available: update.version, skipped: skippedVersion) {
            phase = .idle
            return
        }
        phase = .available(update)
    }

    // MARK: download

    func beginDownload() {
        guard case .available(let update) = phase else { return }
        phase = .downloading(0)
        Task {
            do {
                let path = try await UpdateService.download(update) { [weak self] p in
                    Task { @MainActor in self?.updateProgress(p) }
                }
                self.readyBundlePath = path
                self.phase = .readyToRestart(update)
            } catch {
                self.phase = .error("Download failed")
                // fall back so the user can retry from the pill/panel
                Task { @MainActor in
                    try? await Task.sleep(nanoseconds: 2_500_000_000)
                    if case .error = self.phase { self.phase = .available(update) }
                }
            }
        }
    }

    private func updateProgress(_ p: Double) {
        if case .downloading = phase { phase = .downloading(p) }
    }

    // MARK: skip / dismiss

    func skipCurrent() {
        if case .available(let u) = phase { UserDefaults.standard.set(u.version.description, forKey: skippedKey) }
        if case .readyToRestart(let u) = phase { UserDefaults.standard.set(u.version.description, forKey: skippedKey) }
        cancelRestart()
        phase = .idle
    }

    func dismissTransient() { if phase == .upToDate { phase = .idle } }

    // MARK: restart

    func restartNow() { beginCountdown() }

    func armRestartWhenIdle() {
        restartWhenIdle = true
        if AgentStore.shared.allPanesIdle() { beginCountdown() }
    }

    private func observeActivity() {
        AgentStore.shared.objectWillChange
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in
                DispatchQueue.main.async { self?.onActivityChanged() }
            }
            .store(in: &cancellables)
    }

    private func onActivityChanged() {
        guard restartWhenIdle, countdown == nil,
              case .readyToRestart = phase,
              AgentStore.shared.allPanesIdle() else { return }
        beginCountdown()
    }

    private func beginCountdown() {
        guard case .readyToRestart = phase, countdown == nil else { return }
        countdown = 10
        countdownTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tickCountdown() }
        }
    }

    private func tickCountdown() {
        guard let c = countdown else { return }
        if c <= 1 { install() } else { countdown = c - 1 }
    }

    func cancelRestart() {
        countdownTimer?.invalidate(); countdownTimer = nil
        countdown = nil
        restartWhenIdle = false
    }

    private func install() {
        countdownTimer?.invalidate(); countdownTimer = nil
        countdown = nil
        guard case .readyToRestart = phase, let path = readyBundlePath else { return }
        phase = .restarting
        UpdateInstaller.install(newBundle: path, installedPath: Bundle.main.bundlePath)
        NSApp.terminate(nil)
    }
}
