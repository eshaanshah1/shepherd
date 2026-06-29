# Sleep Guard (Caffeination) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Shepherd hold the Mac awake (incl. lid-closed) while agents are busy, with a graceful no-root fallback, a clamshell display-blank thermal lever, and a clamshell-gated thermal auto-sleep safety valve.

**Architecture:** A pure `SleepPolicy` decision (mode + busy + thermal-suppressed → Bool) sits under an effectful `@MainActor SleepGuard` that holds either `pmset disablesleep` (Tier 2, clamshell-surviving) or an IOKit idle assertion (Tier 1, fallback). `ClamshellMonitor` (IOKit) and `ThermalMonitor` (Foundation) feed lid + thermal events in. `AgentStore` feeds "is any agent busy" on every state change.

**Tech Stack:** Swift 5 / SwiftUI / AppKit, IOKit (`IOKit.pwr_mgt`), `Process` (`sudo -n pmset`), XCTest, xcodegen, xcodebuild.

## Global Constraints

- Deployment target **macOS 13.0**; `SWIFT_VERSION 5.0`. Copy from `project.yml`.
- **`xcodegen generate`** after adding/removing ANY source file, before building. New files in `Sources/` are auto-globbed; new files in the test target must be listed explicitly in `project.yml`.
- libghostty / IOKit C-API calls happen on the **main thread**.
- SwiftUI sidebar/menu controls stay **`.focusable(false)`** so focus stays on the terminal (existing convention).
- **Default mode = `.off`**; **default `thermalAutoSleep = true`**; **release grace = 120s**; **"busy" = `working ∪ blocked ∪ needsCheck ∪ error`**.
- Tier 2 uses **`/usr/bin/sudo -n /usr/bin/pmset …`**; matches the user's sudoers line `NOPASSWD: /usr/bin/pmset`. `displaysleepnow` is run **without** sudo (no root needed).
- Bundle id for `defaults`/verification: **`com.shepherd.Shepherd`**.
- Keep comments to the non-obvious "why" (repo convention). Commit messages end with:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- All paths below are relative to repo root `/Users/eshaannileshshah/Home/dev/tools/shepherd`. Build/test run from `spike/seam1`.

### Standard commands (referenced by tasks)

**Run model tests (single suite):**
```bash
cd spike/seam1 && xcodebuild test -project Shepherd.xcodeproj -scheme ShepherdModelTests \
  -destination 'platform=macOS,arch=arm64' -derivedDataPath ./build \
  CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache \
  -only-testing:ShepherdModelTests/<SuiteName> 2>&1 | tail -6
```

**Build + run the app:**
```bash
cd spike/seam1 && xcodegen generate && \
xcodebuild -project Shepherd.xcodeproj -scheme Shepherd -configuration Debug \
  -derivedDataPath ./build CODE_SIGNING_ALLOWED=NO CLANG_MODULE_CACHE_PATH=./build/ModuleCache build 2>&1 | tail -5
APP=./build/Build/Products/Debug/Shepherd.app
codesign --force --deep --sign - "$APP"
killall Shepherd 2>/dev/null; until ! pgrep -x Shepherd; do sleep 0.2; done; open "$APP"
```

**Quit gracefully (fires `applicationWillTerminate`):** `osascript -e 'tell application "Shepherd" to quit'`

---

## File Structure

**New — pure (in `ShepherdModelTests` target):**
- `spike/seam1/Sources/SleepPolicy.swift` — `CaffeinateMode` enum + `shouldStayAwake(...)`.
- `spike/seam1/Tests/SleepPolicyTests.swift` — truth-table tests.

**New — app side (auto-globbed into `Shepherd` target):**
- `spike/seam1/Sources/SleepGuard.swift` — `@MainActor` controller (mode, mechanism, grace, reconcile/teardown).
- `spike/seam1/Sources/ClamshellMonitor.swift` — IOKit lid-state watcher.
- `spike/seam1/Sources/ThermalMonitor.swift` — `ProcessInfo` thermal watcher.

**Modified:**
- `spike/seam1/Sources/AgentState.swift` — add `isBusy`.
- `spike/seam1/Sources/Workspace.swift` — add `anyAgentBusy(in:)` free helper.
- `spike/seam1/Tests/WorkspaceTests.swift` — tests for the above.
- `spike/seam1/Sources/AgentStore.swift` — `hasBusyAgent` + drive `SleepGuard`.
- `spike/seam1/Sources/ShepherdApp.swift` — instantiate `SleepGuard`, add menu.
- `spike/seam1/Sources/AppDelegate.swift` — `@MainActor`, launch reconcile, quit teardown.
- `spike/seam1/project.yml` — link `IOKit`, add `SleepPolicy.swift` to the test target.
- `README.md` / `CLAUDE.md` — sudoers setup + feature docs.

---

## Task 1: `AgentState.isBusy` + `anyAgentBusy(in:)` (pure)

**Files:**
- Modify: `spike/seam1/Sources/AgentState.swift`
- Modify: `spike/seam1/Sources/Workspace.swift`
- Test: `spike/seam1/Tests/WorkspaceTests.swift`

**Interfaces:**
- Produces: `AgentState.isBusy: Bool`; free function `anyAgentBusy(in workspaces: [Workspace]) -> Bool`.

- [ ] **Step 1: Write the failing tests** — append to `WorkspaceTests.swift` (inside the class, the `ws(_:)` helper already exists):

```swift
    func testIsBusy() {
        XCTAssertFalse(AgentState.shell.isBusy)
        XCTAssertFalse(AgentState.idle.isBusy)
        XCTAssertTrue(AgentState.working.isBusy)
        XCTAssertTrue(AgentState.blocked.isBusy)
        XCTAssertTrue(AgentState.needsCheck.isBusy)
        XCTAssertTrue(AgentState.error.isBusy)
    }

    func testAnyAgentBusyAcrossWorkspaces() {
        XCTAssertFalse(anyAgentBusy(in: [ws([.shell]), ws([.idle, .idle])]))
        XCTAssertTrue(anyAgentBusy(in: [ws([.idle]), ws([.shell, .working])]))   // busy in a hidden ws
        XCTAssertTrue(anyAgentBusy(in: [ws([.needsCheck])]))
    }
```

- [ ] **Step 2: Run tests, verify they fail**

Run the **Standard model-test command** with `-only-testing:ShepherdModelTests/WorkspaceTests`.
Expected: FAIL — `value of type 'AgentState' has no member 'isBusy'` / `cannot find 'anyAgentBusy' in scope`.

- [ ] **Step 3: Implement `isBusy`** — in `AgentState.swift`, add inside the `AgentState` enum body, right after `wantsAttention`:

```swift
    /// Holds the Mac awake under `.whileAgents`: actively working OR waiting on you.
    /// Idle (acknowledged) and plain shells do not.
    var isBusy: Bool { self == .working || wantsAttention }
```

- [ ] **Step 4: Implement `anyAgentBusy`** — in `Workspace.swift`, add after `totalAttentionCount(in:)`:

```swift
/// True if any pane in any workspace is busy (working/blocked/needsCheck/error) —
/// the "keep the Mac awake" trigger for `.whileAgents`.
func anyAgentBusy(in workspaces: [Workspace]) -> Bool {
    workspaces.flatMap { $0.tabs }.flatMap { $0.root.panes }.contains { $0.state.isBusy }
}
```

- [ ] **Step 5: Run tests, verify they pass**

Run the same command. Expected: PASS (suite count grows by 2).

- [ ] **Step 6: Commit**

```bash
git add spike/seam1/Sources/AgentState.swift spike/seam1/Sources/Workspace.swift spike/seam1/Tests/WorkspaceTests.swift
git commit -m "feat(sleep): AgentState.isBusy + anyAgentBusy busy-detection helpers

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `SleepPolicy.swift` — `CaffeinateMode` + `shouldStayAwake` (pure)

**Files:**
- Create: `spike/seam1/Sources/SleepPolicy.swift`
- Create: `spike/seam1/Tests/SleepPolicyTests.swift`
- Modify: `spike/seam1/project.yml` (add the source to the test target)

**Interfaces:**
- Produces: `enum CaffeinateMode: String, CaseIterable { case off, whileAgents, always }`; free function `shouldStayAwake(mode: CaffeinateMode, hasBusyAgent: Bool, thermalSuppressed: Bool) -> Bool`.

- [ ] **Step 1: Create the implementation** — `spike/seam1/Sources/SleepPolicy.swift`:

```swift
import Foundation

/// The user's keep-awake policy. Persisted by SleepGuard as the raw string.
enum CaffeinateMode: String, CaseIterable {
    case off          // never hold the Mac awake
    case whileAgents  // hold awake while any agent is busy
    case always       // hold awake the whole time Shepherd runs
}

/// Pure decision: should the Mac be held awake right now?
/// `thermalSuppressed` is the clamshell thermal override — it beats every mode.
func shouldStayAwake(mode: CaffeinateMode, hasBusyAgent: Bool, thermalSuppressed: Bool) -> Bool {
    if thermalSuppressed { return false }
    switch mode {
    case .off:         return false
    case .whileAgents: return hasBusyAgent
    case .always:      return true
    }
}
```

- [ ] **Step 2: Add the source to the test target** — in `project.yml`, under `ShepherdModelTests:` → `sources:`, add a line (alongside the other `Sources/*.swift` entries):

```yaml
      - path: Sources/SleepPolicy.swift
```

- [ ] **Step 3: Write the failing tests** — `spike/seam1/Tests/SleepPolicyTests.swift`:

```swift
import XCTest

final class SleepPolicyTests: XCTestCase {
    func testOffNeverStaysAwake() {
        XCTAssertFalse(shouldStayAwake(mode: .off, hasBusyAgent: true,  thermalSuppressed: false))
        XCTAssertFalse(shouldStayAwake(mode: .off, hasBusyAgent: false, thermalSuppressed: false))
    }
    func testAlwaysStaysAwakeIgnoringBusy() {
        XCTAssertTrue(shouldStayAwake(mode: .always, hasBusyAgent: false, thermalSuppressed: false))
        XCTAssertTrue(shouldStayAwake(mode: .always, hasBusyAgent: true,  thermalSuppressed: false))
    }
    func testWhileAgentsFollowsBusy() {
        XCTAssertTrue (shouldStayAwake(mode: .whileAgents, hasBusyAgent: true,  thermalSuppressed: false))
        XCTAssertFalse(shouldStayAwake(mode: .whileAgents, hasBusyAgent: false, thermalSuppressed: false))
    }
    func testThermalSuppressionBeatsEveryMode() {
        XCTAssertFalse(shouldStayAwake(mode: .always,      hasBusyAgent: true, thermalSuppressed: true))
        XCTAssertFalse(shouldStayAwake(mode: .whileAgents, hasBusyAgent: true, thermalSuppressed: true))
    }
}
```

- [ ] **Step 4: Regenerate + run tests, verify they pass**

```bash
cd spike/seam1 && xcodegen generate
```
Then run the **Standard model-test command** with `-only-testing:ShepherdModelTests/SleepPolicyTests`.
Expected: PASS — `Executed 4 tests, with 0 failures`. (Regeneration is what makes the new file compile; without it the suite won't be found.)

- [ ] **Step 5: Commit**

```bash
git add spike/seam1/Sources/SleepPolicy.swift spike/seam1/Tests/SleepPolicyTests.swift spike/seam1/project.yml
git commit -m "feat(sleep): pure SleepPolicy decision (mode x busy x thermal)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `ClamshellMonitor.swift` (IOKit lid watcher) + link IOKit

**Files:**
- Create: `spike/seam1/Sources/ClamshellMonitor.swift`
- Modify: `spike/seam1/project.yml` (link `IOKit.framework`)

**Interfaces:**
- Produces: `final class ClamshellMonitor` with `var isLidClosed: Bool` (get), `var onChange: ((Bool) -> Void)?`, `func start()`, `func stop()`. Callbacks delivered on the main queue. On a Mac with no lid, `isLidClosed` stays `false` and no events fire.

- [ ] **Step 1: Link IOKit** — in `project.yml`, under the `Shepherd:` target `dependencies:`, add:

```yaml
      - sdk: IOKit.framework
```

- [ ] **Step 2: Create the monitor** — `spike/seam1/Sources/ClamshellMonitor.swift`:

```swift
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
                guard messageType == UInt32(kIOPMMessageClamshellStateChange), let refcon else { return }
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
```

- [ ] **Step 3: Regenerate + build, verify it compiles**

Run the **Build** command. Expected: `** BUILD SUCCEEDED **`. (Lid-event behavior is verified once wired into SleepGuard in Task 7 — this task's deliverable is a compiling monitor that links IOKit and reads the initial state.)

- [ ] **Step 4: Commit**

```bash
git add spike/seam1/Sources/ClamshellMonitor.swift spike/seam1/project.yml
git commit -m "feat(sleep): ClamshellMonitor — IOKit lid-state watcher; link IOKit

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `ThermalMonitor.swift` (ProcessInfo thermal watcher)

**Files:**
- Create: `spike/seam1/Sources/ThermalMonitor.swift`

**Interfaces:**
- Produces: `final class ThermalMonitor` with `var state: ProcessInfo.ThermalState` (get), `var onChange: ((ProcessInfo.ThermalState) -> Void)?`, `func start()`, `func stop()`, `func handle(_:)` (also the DEBUG simulation seam), and `static func isHot(_:) -> Bool`.

- [ ] **Step 1: Create the monitor** — `spike/seam1/Sources/ThermalMonitor.swift`:

```swift
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
```

- [ ] **Step 2: Regenerate + build, verify it compiles**

Run the **Build** command. Expected: `** BUILD SUCCEEDED **`. (Behavior verified in Task 8 via the DEBUG simulation seam.)

- [ ] **Step 3: Commit**

```bash
git add spike/seam1/Sources/ThermalMonitor.swift
git commit -m "feat(sleep): ThermalMonitor — ProcessInfo thermal-state watcher

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: `SleepGuard.swift` core + app lifecycle wiring

Mechanism (Tier 2 pmset / Tier 1 assertion), persisted mode + thermal toggle, grace timer, launch-reconcile + quit-teardown. Clamshell/thermal monitors are wired in Tasks 7–8. Lifecycle wiring (`ShepherdApp`/`AppDelegate`) is folded in here because it's what makes the deliverable testable.

**Files:**
- Create: `spike/seam1/Sources/SleepGuard.swift`
- Modify: `spike/seam1/Sources/ShepherdApp.swift:8-12` (the `init`)
- Modify: `spike/seam1/Sources/AppDelegate.swift`

**Interfaces:**
- Consumes: `shouldStayAwake(...)`, `CaffeinateMode` (Task 2).
- Produces: `SleepGuard.shared` (`@MainActor`, `ObservableObject`) with published `var mode: CaffeinateMode`, `var thermalAutoSleep: Bool`, `private(set) var tier2Available: Bool`; methods `func update(hasBusyAgent: Bool)`, `func reconcileAtLaunch()`, `func teardownAtQuit()`. (Tasks 7–8 add `clamshellDidChange(_:)` / thermal handling.)

- [ ] **Step 1: Create SleepGuard** — `spike/seam1/Sources/SleepGuard.swift`:

```swift
import SwiftUI
import AppKit
import IOKit.pwr_mgt

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
        didSet { UserDefaults.standard.set(thermalAutoSleep, forKey: Self.thermalKey); refresh() }
    }
    /// True if Tier 2 (clamshell survival) was reachable at the last probe/hold.
    @Published private(set) var tier2Available = false

    private var held: Mechanism = .none
    private var assertionID: IOPMAssertionID = 0
    private var lastBusy = false
    var thermalSuppressed = false           // set by the thermal path (Task 8)
    private var releaseTimer: DispatchWorkItem?

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
        } else {
            tier2Available = false
            acquireAssertion(); held = .assertion
        }
    }

    private func releaseMechanism() {
        switch held {
        case .pmset:     _ = Self.setDisableSleep(false)
        case .assertion: releaseAssertion()
        case .none:      break
        }
        held = .none
    }

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
```

- [ ] **Step 2: Instantiate at app start** — in `ShepherdApp.swift`, in `init()` add after `_ = AgentStore.shared`:

```swift
        _ = SleepGuard.shared       // load persisted caffeinate mode
```

- [ ] **Step 3: Wire launch + quit** — replace `AppDelegate.swift` entirely so the class is `@MainActor` (lets the lifecycle hooks call the MainActor SleepGuard synchronously — required so `applicationWillTerminate` clears the flag before the process exits):

```swift
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
```

- [ ] **Step 4: Build, verify it compiles**

Run the **Build** command. Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 5: Verify Tier 2 hold + teardown manually**

```bash
defaults write com.shepherd.Shepherd shepherd.caffeinate.mode -string always
# build+run (Build command), then:
pmset -g | grep SleepDisabled        # expect: SleepDisabled    1
osascript -e 'tell application "Shepherd" to quit'
sleep 1; pmset -g | grep SleepDisabled   # expect: SleepDisabled    0
```
Expected: `1` while running, `0` after quit.

- [ ] **Step 6: Verify crash-leftover reconcile**

```bash
defaults write com.shepherd.Shepherd shepherd.caffeinate.mode -string always
# build+run; confirm SleepDisabled = 1, then hard-kill (no teardown):
killall -9 Shepherd; sleep 1; pmset -g | grep SleepDisabled    # expect: 1 (stranded)
defaults write com.shepherd.Shepherd shepherd.caffeinate.mode -string off
open ./build/Build/Products/Debug/Shepherd.app
sleep 1; pmset -g | grep SleepDisabled    # expect: 0 (launch reconcile cleared it)
osascript -e 'tell application "Shepherd" to quit'
defaults delete com.shepherd.Shepherd shepherd.caffeinate.mode 2>/dev/null
```
Expected: stranded `1` after the hard kill; `0` after relaunch with mode off.

- [ ] **Step 7: Commit**

```bash
git add spike/seam1/Sources/SleepGuard.swift spike/seam1/Sources/ShepherdApp.swift spike/seam1/Sources/AppDelegate.swift
git commit -m "feat(sleep): SleepGuard core (pmset/assertion tiers, grace, reconcile) + lifecycle

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Drive SleepGuard from AgentStore

**Files:**
- Modify: `spike/seam1/Sources/AgentStore.swift` (add `hasBusyAgent`; call `update` in `updateDockBadge`)

**Interfaces:**
- Consumes: `anyAgentBusy(in:)` (Task 1), `SleepGuard.shared.update(hasBusyAgent:)` (Task 5).
- Produces: `AgentStore.hasBusyAgent: Bool`.

- [ ] **Step 1: Add `hasBusyAgent`** — in `AgentStore.swift`, add next to `attentionCount` (~line 439):

```swift
    var hasBusyAgent: Bool { anyAgentBusy(in: workspaces) }
```

- [ ] **Step 2: Feed SleepGuard from the existing chokepoint** — in `AgentStore.swift`, change `updateDockBadge()` (~line 443) to also push busy-state:

```swift
    private func updateDockBadge() {
        let n = attentionCount
        NSApp.dockTile.badgeLabel = n > 0 ? "\(n)" : nil
        SleepGuard.shared.update(hasBusyAgent: hasBusyAgent)
    }
```

- [ ] **Step 3: Build, verify it compiles**

Run the **Build** command. Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 4: Verify the busy→awake path with a real agent**

```bash
defaults write com.shepherd.Shepherd shepherd.caffeinate.mode -string whileAgents
# build+run. In a Shepherd pane: start `claude`, send a prompt so it's WORKING, then:
pmset -g | grep SleepDisabled        # expect: 1 while the turn runs
# let it finish; focus the pane so need-to-check clears to idle, then wait >120s:
pmset -g | grep SleepDisabled        # expect: 0 after the grace window
osascript -e 'tell application "Shepherd" to quit'
defaults delete com.shepherd.Shepherd shepherd.caffeinate.mode 2>/dev/null
```
Expected: `1` while busy; `0` ~120s after going idle. Cross-check transitions in `/tmp/shepherd-events.log`.

- [ ] **Step 5: Commit**

```bash
git add spike/seam1/Sources/AgentStore.swift
git commit -m "feat(sleep): drive SleepGuard from AgentStore busy-state

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Wire ClamshellMonitor into SleepGuard (display-blank on lid close)

**Files:**
- Modify: `spike/seam1/Sources/SleepGuard.swift`

**Interfaces:**
- Consumes: `ClamshellMonitor` (Task 3), `SleepGuard.blankDisplayNow()` (Task 5).
- Produces: `SleepGuard.isLidClosed: Bool`; behavior: on lid-close while Tier 2 is held, blank the panel.

- [ ] **Step 1: Add the monitor + lid state** — in `SleepGuard.swift`, add stored properties next to `releaseTimer`:

```swift
    private let clamshell = ClamshellMonitor()
    private(set) var isLidClosed = false
```

- [ ] **Step 2: Start the monitor + handle lid changes** — in `SleepGuard.swift`, at the end of `reconcileAtLaunch()` add:

```swift
        isLidClosed = clamshell.isLidClosed
        clamshell.onChange = { [weak self] closed in self?.clamshellDidChange(closed) }
        clamshell.start()
        isLidClosed = clamshell.isLidClosed
```

Then add the handler method:

```swift
    private func clamshellDidChange(_ closed: Bool) {
        isLidClosed = closed
        if closed, held == .pmset { Self.blankDisplayNow() }
    }
```

- [ ] **Step 3: Blank on hold if the lid is already shut** — in `establishHold()`, in the `.pmset` branch, after `held = .pmset; tier2Available = true` add:

```swift
            if isLidClosed { Self.blankDisplayNow() }
```

- [ ] **Step 4: Build, verify it compiles**

Run the **Build** command. Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 5: Verify lid-close blanks the panel**

```bash
defaults write com.shepherd.Shepherd shepherd.caffeinate.mode -string always
# build+run on a laptop. Confirm: pmset -g | grep SleepDisabled  -> 1
# Close the lid (use an external display / clamshell setup so the Mac stays awake).
# Expected: the internal panel goes dark immediately (displaysleepnow fired),
# while the machine keeps running (SSH in: `pmset -g | grep SleepDisabled` -> 1).
# Reopen lid -> panel returns.
osascript -e 'tell application "Shepherd" to quit'
defaults delete com.shepherd.Shepherd shepherd.caffeinate.mode 2>/dev/null
```
Expected: internal panel blanks on close while the system stays awake.

- [ ] **Step 6: Commit**

```bash
git add spike/seam1/Sources/SleepGuard.swift
git commit -m "feat(sleep): blank internal panel on lid-close while Tier 2 held

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Wire ThermalMonitor into SleepGuard (clamshell-gated auto-sleep)

**Files:**
- Modify: `spike/seam1/Sources/SleepGuard.swift`
- Modify: `spike/seam1/Sources/ShepherdApp.swift` (DEBUG-only simulate menu item)

**Interfaces:**
- Consumes: `ThermalMonitor` (Task 4), `NSWorkspace.didWakeNotification`, `UNUserNotificationCenter`.
- Produces: thermal override behavior; `SleepGuard.simulateThermal(_:)` (DEBUG verification seam).

- [ ] **Step 1: Add the thermal monitor + imports** — in `SleepGuard.swift`, change the imports to include notifications:

```swift
import UserNotifications
```

Add stored property next to `clamshell`:

```swift
    private let thermal = ThermalMonitor()
```

- [ ] **Step 2: Manage the monitor's lifecycle** — it runs only when it can act (clamshell + Tier 2 held + setting on). In `SleepGuard.swift`, add:

```swift
    /// Start the thermal monitor only while it can act; stop it otherwise.
    private func updateThermalMonitor() {
        let shouldWatch = thermalAutoSleep && isLidClosed && held == .pmset
        if shouldWatch {
            thermal.onChange = { [weak self] s in self?.thermalDidChange(s) }
            thermal.start()
        } else {
            thermal.stop()
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
```

- [ ] **Step 3: Call `updateThermalMonitor()` on the state transitions that affect it** — in `SleepGuard.swift`:

In `clamshellDidChange(_:)`, add `updateThermalMonitor()` as the last line.
In `establishHold()`, add `updateThermalMonitor()` as the last line.
In `releaseMechanism()`, add `updateThermalMonitor()` as the last line.
In the `thermalAutoSleep` `didSet`, change it to also refresh the monitor:

```swift
    @Published var thermalAutoSleep: Bool {
        didSet {
            UserDefaults.standard.set(thermalAutoSleep, forKey: Self.thermalKey)
            updateThermalMonitor(); refresh()
        }
    }
```

- [ ] **Step 4: Recover on wake** — the override clears when the silicon cools, but the monitor is stopped while asleep, so recompute on wake. In `reconcileAtLaunch()`, after `clamshell.start()`, add:

```swift
        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification, object: nil, queue: .main
        ) { [weak self] _ in
            guard let self else { return }
            self.thermalSuppressed = ThermalMonitor.isHot(ProcessInfo.processInfo.thermalState)
            self.refresh(immediate: true)
            self.updateThermalMonitor()
        }
```

- [ ] **Step 5: Add the DEBUG simulation seam** — in `SleepGuard.swift`:

```swift
    #if DEBUG
    /// Inject a thermal state to verify the clamshell auto-sleep path without load.
    func simulateThermal(_ s: ProcessInfo.ThermalState) { thermal.handle(s) }
    #endif
```

In `ShepherdApp.swift`, inside the `CommandGroup(after: .newItem)` block, add at the end (before the closing brace):

```swift
                #if DEBUG
                Divider()
                Button("DEBUG: Simulate Thermal Serious") { SleepGuard.shared.simulateThermal(.serious) }
                Button("DEBUG: Simulate Thermal Nominal") { SleepGuard.shared.simulateThermal(.nominal) }
                #endif
```

- [ ] **Step 6: Build, verify it compiles**

Run the **Build** command. Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 7: Verify thermal auto-sleep (DEBUG sim, clamshell-gated)**

```bash
defaults write com.shepherd.Shepherd shepherd.caffeinate.mode -string always
defaults write com.shepherd.Shepherd shepherd.caffeinate.thermalAutoSleep -bool true
# build+run with an external display, close the lid (clamshell). SSH in:
pmset -g | grep SleepDisabled        # expect: 1
# Trigger the DEBUG menu item "Simulate Thermal Serious" (needs the menu; do this
# BEFORE closing the lid, or reopen briefly). Then with lid closed + Tier 2 held:
#   -> expect a notification "Letting your Mac sleep to cool down"
#   -> SleepDisabled flips to 0 and the closed lid lets the Mac sleep.
# Lid-OPEN check: with the lid open, "Simulate Thermal Serious" must NOT release
#   (updateThermalMonitor only runs the monitor when isLidClosed) -> SleepDisabled stays 1.
osascript -e 'tell application "Shepherd" to quit'
defaults delete com.shepherd.Shepherd shepherd.caffeinate.mode 2>/dev/null
defaults delete com.shepherd.Shepherd shepherd.caffeinate.thermalAutoSleep 2>/dev/null
```
Expected: lid-closed `.serious` → notification + `SleepDisabled 0`; lid-open `.serious` → no release.

- [ ] **Step 8: Commit**

```bash
git add spike/seam1/Sources/SleepGuard.swift spike/seam1/Sources/ShepherdApp.swift
git commit -m "feat(sleep): clamshell-gated thermal auto-sleep + wake recovery

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Menu UI (mode radios + thermal toggle + tier readout)

**Files:**
- Modify: `spike/seam1/Sources/ShepherdApp.swift`

**Interfaces:**
- Consumes: `SleepGuard.shared` (`mode`, `thermalAutoSleep`, `tier2Available`).

- [ ] **Step 1: Add a `Stay Awake` command menu** — in `ShepherdApp.swift`, add a `@StateObject` for the guard and a new `CommandMenu` after the existing `.commands { ... }` groups. First add the observed object to the struct (top of `ShepherdApp`, after `appDelegate`):

```swift
    @StateObject private var sleep = SleepGuard.shared
```

Then add this `CommandMenu` inside `.commands { }`, after the `CommandGroup(after: .windowList)` block:

```swift
            CommandMenu("Stay Awake") {
                Picker("Mode", selection: Binding(
                    get: { sleep.mode },
                    set: { sleep.mode = $0 })) {
                    Text("Off").tag(CaffeinateMode.off)
                    Text("While Agents Working").tag(CaffeinateMode.whileAgents)
                    Text("Always (App Open)").tag(CaffeinateMode.always)
                }
                .pickerStyle(.inline)
                Divider()
                Toggle("Sleep If Running Hot Under Closed Lid", isOn: Binding(
                    get: { sleep.thermalAutoSleep },
                    set: { sleep.thermalAutoSleep = $0 }))
                Divider()
                Text(sleep.tier2Available
                     ? "Clamshell survival: on"
                     : "Clamshell survival: unavailable (idle-sleep guard)")
            }
```

- [ ] **Step 2: Build, verify it compiles**

Run the **Build** command. Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 3: Verify the menu drives the guard**

```bash
defaults delete com.shepherd.Shepherd shepherd.caffeinate.mode 2>/dev/null   # start clean (defaults to Off)
# build+run. Open the "Stay Awake" menu:
#   - "Off" is checked initially; switch to "Always".
pmset -g | grep SleepDisabled        # expect: 1
#   - read the status line: "Clamshell survival: on" (Tier 2 available on this machine).
#   - switch back to "Off":
pmset -g | grep SleepDisabled        # expect: 0
#   - confirm persistence:
defaults read com.shepherd.Shepherd shepherd.caffeinate.mode    # reflects last choice
osascript -e 'tell application "Shepherd" to quit'
```
Expected: menu reflects + changes mode, flag follows, choice persists.

- [ ] **Step 4: Commit**

```bash
git add spike/seam1/Sources/ShepherdApp.swift
git commit -m "feat(sleep): Stay Awake menu — mode radios, thermal toggle, tier readout

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Docs — sudoers setup + architecture note

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`

**Interfaces:** none (documentation).

- [ ] **Step 1: Add a setup section to `README.md`** — under the install/run section, add:

```markdown
### Optional: clamshell-survival (Tier 2)

Shepherd's "Stay Awake" feature keeps the Mac awake while agents run. Out of the box it
uses an IOKit idle assertion (no setup) which holds while the lid is open. To also survive
**closing the lid**, grant Shepherd passwordless `pmset` once:

```sh
echo "$(whoami) ALL=(root) NOPASSWD: /usr/bin/pmset" | sudo tee /etc/sudoers.d/shepherd-pmset >/dev/null
sudo visudo -cf /etc/sudoers.d/shepherd-pmset      # validate
sudo -n pmset -g >/dev/null 2>&1 && echo "PASSWORDLESS OK" || echo "blocked"
```

If absent (or reverted by MDM), Shepherd auto-degrades to the idle assertion. The "Stay
Awake" menu shows which tier is active. A hard crash while holding can leave the kernel
`SleepDisabled` flag set until Shepherd's next launch (which clears it) or a reboot.
```

- [ ] **Step 2: Add an architecture bullet to `CLAUDE.md`** — under "App source files", add entries; under "Done vs deferred" → "Done", append a "sleep guard" item:

```markdown
- `SleepGuard.swift` — `@MainActor` keep-awake controller: holds `pmset disablesleep`
  (Tier 2, clamshell-surviving) or an IOKit idle assertion (Tier 1 fallback) per the
  3-mode policy; 120s release grace; launch-reconcile + quit-teardown; clamshell
  display-blank + clamshell-gated thermal auto-sleep. Pure decision in `SleepPolicy.swift`.
- `SleepPolicy.swift` — **pure model**: `CaffeinateMode` + `shouldStayAwake(mode,busy,thermalSuppressed)`. In `ShepherdModelTests`.
- `ClamshellMonitor.swift` — IOKit lid-state watcher (observe-only). `ThermalMonitor.swift` — `ProcessInfo` thermal watcher.
```

- [ ] **Step 3: Verify docs render**

```bash
# Confirm the fenced blocks are balanced and the sudoers one-liner is copy-pasteable.
grep -n "disablesleep\|SleepGuard\|Stay Awake" README.md CLAUDE.md
```
Expected: the new sections present in both files.

- [ ] **Step 4: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs(sleep): clamshell-survival sudoers setup + SleepGuard architecture

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review (completed)

**Spec coverage:** modes → T2/T9; busy semantics → T1; Tier 2/1 + reconcile/teardown → T5; release grace → T5; clamshell display-blank → T7; thermal auto-sleep (clamshell-gated, lifecycle-scoped monitor, wake recovery, notification) → T8; pure-policy isolation + tests → T1/T2; menu → T9; sudoers doc → T10. No gaps.

**Placeholder scan:** every code/step is concrete; no TBD/TODO; the one "fill-in-later" risk (thermal hardware testing) is resolved with the DEBUG `simulateThermal` seam.

**Type consistency:** `shouldStayAwake(mode:hasBusyAgent:thermalSuppressed:)`, `CaffeinateMode` cases (`off/whileAgents/always`), `AgentState.isBusy`, `anyAgentBusy(in:)`, `SleepGuard` members (`mode/thermalAutoSleep/tier2Available/update/reconcileAtLaunch/teardownAtQuit/refresh/blankDisplayNow`), `ClamshellMonitor`/`ThermalMonitor` interfaces are used identically across tasks. `thermalSuppressed` is `var` (not private) because Task 8 sets it from `thermalDidChange`/wake — consistent with Task 5's declaration.
